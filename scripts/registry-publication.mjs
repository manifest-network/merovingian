import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Dependency-free by design: the approval-gated publish job can mint GitHub OIDC
// tokens, so it runs this file with Node built-ins only and never installs npm
// packages. Registry, origin, publisher, fetch, git, clock and process runners
// are function parameters for isolated tests; the CLI hardcodes production.

export const SERVER_NAME = 'io.github.manifest-network/merovingian';
export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
export const PRODUCTION_ORIGIN = 'https://merovingian.manifest.network';
export const REPOSITORY = 'manifest-network/merovingian';
export const WORKFLOW_FILE = '.github/workflows/publish-mcp-registry.yml';
export const ENVIRONMENT = 'mcp-registry-publish';
export const PUBLISHER = Object.freeze({
  version: '1.8.1',
  commit: 'f52dc8525a441a3abf5fedc9912152d95af5aab1',
  asset: 'mcp-publisher_linux_amd64.tar.gz',
  archiveSha256: 'a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc',
  binarySha256: '5e39fe8b6fc3c8b01bed6f1de364b88e9dd10ccbef6d3d3b1a0caa46115bf869',
});

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';
const VERSION_PATTERN = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SERVER_KEYS = ['$schema', 'description', 'name', 'remotes', 'repository', 'title', 'version', 'websiteUrl'];
const USER_AGENT = 'merovingian-registry-publication (+https://github.com/manifest-network/merovingian)';
const CHILD_ENVIRONMENT = ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const OIDC_ENVIRONMENT = ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'];

export const DEFAULT_TIMEOUTS = Object.freeze({
  requestMs: 15_000, loginMs: 60_000, publishMs: 120_000, logoutMs: 30_000, validateMs: 60_000,
  acceptanceMs: 360_000, verifyAttempts: 6, verifyIntervalMs: 5_000,
});

export class PublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PublicationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublicationError(code, message);
}

export function parseReleaseVersion(value) {
  const match = typeof value === 'string' ? VERSION_PATTERN.exec(value) : null;
  if (!match) fail('input', 'Release version must be MAJOR.MINOR.PATCH without a prefix, prerelease or build suffix');
  return match.slice(1).map(Number);
}

/** Strict MAJOR.MINOR.PATCH precedence; any other registry version needs manual review. */
export function compareVersions(left, right) {
  const [a, b] = [parseReleaseVersion(left), parseReleaseVersion(right)];
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Keep one-line, public-safe diagnostics: no control bytes, bearer values or JWT-shaped strings. */
export function sanitizeMessage(value, limit = 400) {
  const text = String(value ?? '')
    .replace(/eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){1,2}/g, '[redacted-jwt]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/("(?:registry_token|oidc_token|token|value)"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    // Job-scoped Actions endpoints, including the OIDC request URL a failed login can echo.
    .replace(/https?:\/\/[^\s"'<>]*actions\.githubusercontent\.com[^\s"'<>]*/gi, '[redacted-actions-url]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function transportProblem(error) {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return 'request timed out';
    if (/redirect/i.test(current.message)) return 'redirect blocked';
    if ('code' in current && typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(current.code)) {
      return `transport failed (${current.code})`;
    }
  }
  return 'transport failed';
}

/** One bounded GET without redirects, credentials or caches. Never throws.
 * requestedAt precedes the request; observedAt follows the complete response. */
export async function getJson(url, { fetch: fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUTS.requestMs, headers = {}, maxBytes = 262_144, clock = () => new Date() } = {}) {
  const requestedAt = clock().toISOString();
  const result = fields => ({ url, requestedAt, observedAt: clock().toISOString(), ...fields });
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
      redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      return result({ status: response.status, problem: 'redirect blocked' });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > maxBytes) return result({ status: response.status, problem: 'response too large' });
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const contentType = response.headers.get('content-type') || '';
    let json;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { json = undefined; }
    return result({ status: response.status, contentType, json, bytes });
  } catch (error) {
    return result({ status: 0, problem: transportProblem(error) });
  }
}

export function registryUrls(registry, version) {
  const base = `${registry}/v0.1/servers/${encodeURIComponent(SERVER_NAME)}/versions`;
  return {
    exactVersion: `${base}/${encodeURIComponent(version)}`,
    latest: `${base}/latest`,
    versions: base,
    serverVersion: `${registry}/v0.1/version`,
  };
}

// The registry's typed 404 for an unknown name/version, as distinct from a routing
// 404 or any gateway error, which never counts as proof that a record is absent.
function isRecordNotFound(response) {
  return response.status === 404 && /^application\/problem\+json\b/.test(response.contentType)
    && response.json?.detail === 'Server not found';
}

/** Summarize one registry record against the approved metadata. */
export function describeRecord(response, server) {
  const base = { url: response.url.replace(/\?.*$/, ''), observedAt: response.observedAt, httpStatus: response.status };
  if (isRecordNotFound(response)) return { ...base, state: 'absent' };
  const meta = response.json?._meta?.[OFFICIAL_META];
  if (response.status !== 200 || !/^application\/json\b/.test(response.contentType || '') || !isObject(response.json?.server)
    || !isObject(meta) || typeof meta.status !== 'string' || typeof meta.isLatest !== 'boolean') {
    return { ...base, state: 'error', problem: response.problem || `unexpected HTTP ${response.status} response` };
  }
  return {
    ...base, state: 'present', version: String(response.json.server.version), status: meta.status,
    isLatest: meta.isLatest, publishedAt: typeof meta.publishedAt === 'string' ? meta.publishedAt : null,
    metadataMatch: isDeepStrictEqual(response.json.server, server),
  };
}

function describeVersions(response) {
  const base = { url: response.url.replace(/\?.*$/, ''), observedAt: response.observedAt, httpStatus: response.status };
  if (isRecordNotFound(response)) return { ...base, state: 'absent', versions: [] };
  const servers = response.json?.servers;
  if (response.status !== 200 || !Array.isArray(servers) || response.json?.metadata?.count !== servers.length
    || servers.some(entry => typeof entry?.server?.version !== 'string' || typeof entry?._meta?.[OFFICIAL_META]?.status !== 'string')) {
    return { ...base, state: 'error', problem: response.problem || `unexpected HTTP ${response.status} response` };
  }
  return {
    ...base, state: 'present',
    versions: servers.map(entry => ({ version: entry.server.version, status: entry._meta[OFFICIAL_META].status,
      isLatest: entry._meta[OFFICIAL_META].isLatest === true })),
  };
}

/** Read-only registry state. Deleted versions are included because they still block reuse. */
export async function lookupRegistry({ registry = REGISTRY_URL, version, server, fetch: fetchImpl, timeoutMs, clock, includeVersions = true }) {
  const urls = registryUrls(registry, version);
  const read = (url, maxBytes) => getJson(url, { fetch: fetchImpl, timeoutMs, clock, maxBytes });
  const exactResponse = await read(`${urls.exactVersion}?include_deleted=true`);
  const exact = describeRecord(exactResponse, server);
  const latest = describeRecord(await read(urls.latest), server);
  const versions = includeVersions ? describeVersions(await read(`${urls.versions}?include_deleted=true`, 1_048_576)) : undefined;
  return { exact, latest, versions, exactResponse };
}

function latestRelation(latest, version) {
  if (latest.state !== 'present') return 'unavailable';
  try { return ['older', 'same', 'newer'][compareVersions(latest.version, version) + 1]; }
  catch { return 'nonstandard'; }
}

/** Decide from read-only observations. Returns publish/already-published or throws. */
export function decidePublication({ exact, latest, versions }, version) {
  if (exact.state === 'error') {
    fail('registry-uncertain', `The exact-version lookup was inconclusive (${exact.problem}); reconcile with read-only lookups before publishing`);
  }
  if (exact.state === 'present') {
    if (!exact.metadataMatch) {
      fail('registry-conflict', `Version ${version} is already published with different metadata. Published versions are immutable; prepare a new version`);
    }
    if (exact.status !== 'active') {
      fail('registry-conflict', `Version ${version} already exists with status ${sanitizeMessage(exact.status, 40)}; it cannot be republished`);
    }
    const relation = latestRelation(latest, version);
    if (relation === 'same' && !(latest.status === 'active' && latest.isLatest && latest.metadataMatch)) {
      fail('registry-uncertain', 'The latest record names this version but is not active, latest and identical; review the registry state');
    }
    if (!['same', 'newer'].includes(relation)) {
      fail('registry-uncertain', `The existing version is identical, but the latest record is ${relation}; review the registry state`);
    }
    return { decision: 'already-published', latestRelation: relation };
  }
  if (!versions || versions.state === 'error' || latest.state === 'error') {
    fail('registry-uncertain', `Registry version history was inconclusive (${versions?.problem || latest.problem}); this run published nothing`);
  }
  for (const recorded of versions.versions) {
    try { parseReleaseVersion(recorded.version); } catch {
      fail('registry-conflict', 'The registry records a version that is not MAJOR.MINOR.PATCH; review latest-version ordering manually');
    }
    if (recorded.version === version) {
      fail('registry-uncertain', 'The exact-version lookup and version history disagree; this run published nothing');
    }
    // Deliberately stricter than the registry: a deleted higher version can be
    // restored and would then take latest back from this release.
    if (compareVersions(recorded.version, version) > 0) {
      fail('registry-not-latest', `The registry records ${recorded.version} (status ${sanitizeMessage(recorded.status, 20)}); `
        + `this workflow publishes only versions above every recorded version, including deleted ones`);
    }
  }
  // The unfiltered latest endpoint omits deleted rows, so it is absent only when every version is deleted.
  const live = versions.versions.filter(recorded => recorded.status !== 'deleted');
  if ((latest.state === 'present') !== (live.length > 0)
    || (latest.state === 'present' && !live.some(recorded => recorded.version === latest.version))) {
    fail('registry-uncertain', 'The latest record and version history disagree; this run published nothing');
  }
  return { decision: 'publish', latestRelation: latestRelation(latest, version) };
}

/** Problems preventing a verified active latest publication, or [] when verified. */
export function verificationProblems({ exact, latest }, version) {
  const problems = [];
  if (exact.state !== 'present') problems.push(`exact version ${exact.state}`);
  else {
    if (!exact.metadataMatch) problems.push('exact version metadata differs');
    if (exact.status !== 'active') problems.push(`exact version status ${exact.status}`);
    if (!exact.isLatest) problems.push('exact version is not latest');
  }
  if (latest.state !== 'present') problems.push(`latest record ${latest.state}`);
  else {
    if (latest.version !== version) problems.push('latest record names another version');
    if (!latest.metadataMatch) problems.push('latest record metadata differs');
    if (latest.status !== 'active' || !latest.isLatest) problems.push('latest record is not active latest');
  }
  return problems;
}

export function checkMetadata(bytes, version, packageVersion) {
  parseReleaseVersion(version);
  if (!/^[\x20-\x7e\n]*$/.test(bytes.toString('latin1'))) fail('metadata', 'server.json must contain printable ASCII only');
  let server;
  try { server = JSON.parse(bytes.toString('utf8')); } catch { fail('metadata', 'server.json is not valid JSON'); }
  // mcp-publisher drops unknown fields and empty values before sending, so only the
  // reviewed minimal shape can be compared exactly with registry records.
  if (!isObject(server) || !isDeepStrictEqual(Object.keys(server).sort(), SERVER_KEYS)) {
    fail('metadata', `server.json must contain exactly: ${SERVER_KEYS.join(', ')}`);
  }
  if (server.name !== SERVER_NAME) fail('metadata', `server.json name must be ${SERVER_NAME}`);
  if (server.version !== version) fail('metadata', 'server.json version differs from the requested release version');
  if (packageVersion !== version) fail('metadata', 'package.json version differs from the requested release version');
  if (typeof server.$schema !== 'string' || !server.$schema.startsWith('https://static.modelcontextprotocol.io/schemas/')
    || typeof server.title !== 'string' || !server.title || typeof server.description !== 'string'
    || !server.description || server.description.length > 100) {
    fail('metadata', 'server.json schema, title or description is invalid');
  }
  if (server.websiteUrl !== PRODUCTION_ORIGIN
    || !isDeepStrictEqual(server.remotes, [{ type: 'streamable-http', url: `${PRODUCTION_ORIGIN}/mcp` }])
    || !isDeepStrictEqual(server.repository, { url: `https://github.com/${REPOSITORY}`, source: 'github' })) {
    fail('metadata', 'server.json website, remote endpoint or repository differs from the production release');
  }
  return { server, sha256: sha256(bytes), bytes: bytes.length };
}

// Git never inherits tokens or OIDC request variables from the step environment.
export function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1_048_576, timeout: 60_000,
    env: { ...childEnvironment(process.env, process.env.HOME || cwd), GIT_TERMINAL_PROMPT: '0' },
  });
}

// actions/checkout force-moves refs/remotes/origin/main to the dispatched commit,
// so the live branch tip is fetched into a ref that checkout never rewrites.
export const LIVE_MAIN_REF = 'refs/merovingian/main';

/** Fetch the current main tip anonymously from origin (the repository is public). */
export function refreshMain({ cwd, git = runGit }) {
  try { git(cwd, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/main:${LIVE_MAIN_REF}`]); }
  catch { fail('source', 'Could not fetch the current main branch from origin'); }
}

/** The reviewed source revision must be on main and supply exactly main's metadata. */
export function checkSource({ cwd, sourceRevision, workflowRevision, mainRef = LIVE_MAIN_REF, version, git = runGit }) {
  if (typeof sourceRevision !== 'string' || !REVISION_PATTERN.test(sourceRevision)) {
    fail('input', 'Source revision must be a full 40-character lowercase commit SHA');
  }
  const commit = (revision, label) => {
    try { return git(cwd, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]).toString().trim(); }
    catch { return fail('source', `${label} is not a commit in this checkout`); }
  };
  const isAncestor = (ancestor, descendant) => {
    try { git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]); return true; }
    catch (error) { if (error?.status === 1) return false; throw error; }
  };
  const show = (revision, path) => {
    try { return git(cwd, ['show', `${revision}:${path}`]); }
    catch { return fail('source', `${path} is missing at a checked revision`); }
  };
  const source = commit(sourceRevision, 'Source revision');
  const workflow = commit(workflowRevision, 'Workflow revision');
  const main = commit(mainRef, 'Current main');
  if (!isAncestor(source, workflow)) fail('source', 'Source revision is not contained in the dispatched main revision');
  if (!isAncestor(workflow, main)) fail('source', 'The dispatched revision is no longer contained in the current main');
  const serverJson = show(source, 'server.json');
  if (!serverJson.equals(show(workflow, 'server.json')) || !serverJson.equals(show(main, 'server.json'))) {
    fail('source', 'server.json at the source revision differs from main; dispatch the current reviewed release');
  }
  const packageVersion = revision => {
    try { return JSON.parse(git(cwd, ['show', `${revision}:package.json`]).toString('utf8')).version; } catch { return undefined; }
  };
  if (packageVersion(source) !== version) fail('source', 'package.json at the source revision does not declare the requested version');
  // Provenance hint only: the operator asserts which commit is the release commit.
  const releaseCommit = packageVersion(`${source}^1`) !== version;
  return { revision: source, workflowRevision: workflow, mainRevision: main, releaseCommit, serverJson };
}

/** Actions context for a trusted dispatch; values are checked before they reach evidence. */
export function checkDispatch(env, workflowFile = WORKFLOW_FILE) {
  const expected = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${REPOSITORY}/${workflowFile}@refs/heads/main`,
    GITHUB_SERVER_URL: 'https://github.com',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) fail('source', `${key} must be ${value}; publication runs only from this repository's main workflow`);
  }
  if (!REVISION_PATTERN.test(env.GITHUB_SHA || '')) fail('source', 'GITHUB_SHA must be a full commit SHA');
  if (!/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9][0-9]{0,4}$/.test(env.GITHUB_RUN_ATTEMPT || '')) {
    fail('source', 'GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be positive integers');
  }
  return {
    workflowRevision: env.GITHUB_SHA,
    run: { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT),
      url: `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}` },
  };
}

/** Fail-closed read of the approval environment, so a missing environment is never auto-created unprotected. */
export async function checkEnvironment({ api = 'https://api.github.com', token, fetch: fetchImpl, timeoutMs, clock = () => new Date(), environment: name = ENVIRONMENT }) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const base = `${api}/repos/${REPOSITORY}/environments/${name}`;
  const result = { checkedAt: clock().toISOString(), name, passed: false, problems: [] };
  const environment = await getJson(base, { fetch: fetchImpl, timeoutMs, headers, clock });
  if (environment.status !== 200 || !isObject(environment.json)) {
    result.problems.push(environment.status === 404 ? 'environment does not exist'
      : `environment lookup failed (${environment.problem || `HTTP ${environment.status}`})`);
    return result;
  }
  const rules = Array.isArray(environment.json.protection_rules) ? environment.json.protection_rules : [];
  const reviewers = rules.find(rule => rule?.type === 'required_reviewers');
  const policy = environment.json.deployment_branch_policy;
  Object.assign(result, {
    reviewerCount: Array.isArray(reviewers?.reviewers) ? reviewers.reviewers.length : 0,
    preventSelfReview: reviewers?.prevent_self_review === true,
    canAdminsBypass: environment.json.can_admins_bypass,
    deploymentBranchPolicy: isObject(policy) ? { protectedBranches: policy.protected_branches, customBranchPolicies: policy.custom_branch_policies } : null,
  });
  if (!result.reviewerCount) result.problems.push('no required reviewers');
  if (result.canAdminsBypass !== false) result.problems.push('administrators can bypass protection rules');
  if (policy?.protected_branches !== false || policy?.custom_branch_policies !== true) {
    result.problems.push('deployments are not limited to selected branches');
  } else {
    const policies = await getJson(`${base}/deployment-branch-policies`, { fetch: fetchImpl, timeoutMs, headers, clock });
    const branchPolicies = Array.isArray(policies.json?.branch_policies)
      ? policies.json.branch_policies.map(({ name, type }) => ({ name, type })) : null;
    result.branchPolicies = branchPolicies;
    if (policies.status !== 200 || !isDeepStrictEqual(branchPolicies, [{ name: 'main', type: 'branch' }])) {
      result.problems.push('deployment branch policy must allow exactly branch main');
    }
  }
  result.passed = result.problems.length === 0;
  return result;
}

const publicValue = value => typeof value === 'string' ? sanitizeMessage(value, 120) : typeof value === 'boolean' ? value : null;

/** At most two bounded GETs; never a visit, form, tool call or serving. Never throws. */
export async function checkDeployment({ origin = PRODUCTION_ORIGIN, version, fetch: fetchImpl, timeoutMs, clock = () => new Date() }) {
  const result = { checkedAt: clock().toISOString(), origin, requestsAttempted: 0, servingRequestsAttempted: 0, passed: false };
  const read = async path => { result.requestsAttempted++; return getJson(origin + path, { fetch: fetchImpl, timeoutMs, clock, maxBytes: 65_536 }); };
  const health = await read('/healthz');
  const h = health.json;
  if (health.status !== 200 || !isObject(h)) return { ...result, problem: `health check failed (${health.problem || `HTTP ${health.status}`})` };
  result.health = Object.fromEntries(['status', 'network', 'chainId', 'retired', 'version'].map(key => [key, publicValue(h[key])]));
  if (h.status !== 'ok' || h.network !== 'mainnet' || h.chainId !== 'manifest-ledger-mainnet' || h.retired !== false) {
    return { ...result, problem: 'service is not healthy, active mainnet' };
  }
  if (h.version !== version) return { ...result, problem: 'service does not report the requested version' };
  const card = await read('/mcp/server-card');
  const c = card.json;
  if (card.status !== 200 || !isObject(c)) return { ...result, problem: `server card check failed (${card.problem || `HTTP ${card.status}`})` };
  result.serverCard = { name: publicValue(c.name), version: publicValue(c.version), websiteUrl: publicValue(c.websiteUrl),
    remote: publicValue(Array.isArray(c.remotes) ? c.remotes[0]?.url : undefined) };
  if (c.name !== SERVER_NAME || c.version !== version || c.websiteUrl !== origin || result.serverCard.remote !== `${origin}/mcp`) {
    return { ...result, problem: 'server card does not match the requested release identity' };
  }
  return { ...result, passed: true };
}

/** Spawn with a hard deadline and bounded output capture. Never throws. Optional
 * input is written to stdin (for example a password), never to the arguments. */
export function runProcess(file, args, { cwd, env, timeoutMs, maxOutput = 65_536, input }) {
  return new Promise(resolvePromise => {
    const output = { stdout: [], stderr: [], size: 0 };
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, timedOut, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') });
    };
    let child;
    try { child = spawn(file, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (error) { finish({ exitCode: null, signal: null, error: sanitizeMessage(error?.code || 'spawn failed', 40) }); return; }
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = name => chunk => {
      if (output.size >= maxOutput) return;
      const kept = chunk.subarray(0, maxOutput - output.size);
      output.size += kept.byteLength;
      output[name].push(kept);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', error => finish({ exitCode: null, signal: null, error: sanitizeMessage(error?.code || 'spawn failed', 40) }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** Pass only locale, CA and PATH settings, plus explicit extras. Never GODEBUG or tokens. */
export function childEnvironment(source, home, extra = []) {
  const env = { HOME: home };
  for (const key of [...CHILD_ENVIRONMENT, ...extra]) if (typeof source[key] === 'string') env[key] = source[key];
  return env;
}

function processOutcome(result, secrets = []) {
  let text = `${result.stderr}\n${result.stdout}`;
  // Exact values first: the OIDC request URL and token are never printed as-is.
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) text = text.replaceAll(secret, '[redacted]');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const message = lines.find(line => line.startsWith('Error:')) || lines.at(-1) || result.error || '';
  // mcp-publisher 1.8.1 reports most rejections as "server returned status N". After a
  // 422 it instead prints this marker, queries /v0/validate and reports the issues.
  const status = /server returned status ([0-9]{3})/.exec(message)?.[1]
    ?? (result.stdout.includes('Validation failed. Checking detailed validation errors') ? '422' : undefined);
  return {
    exitCode: result.exitCode, timedOut: result.timedOut, passed: result.exitCode === 0 && !result.timedOut,
    ...(status ? { httpStatus: Number(status) } : {}), message: sanitizeMessage(message),
  };
}

/** Official registry validation (unauthenticated, no write) through the pinned publisher. */
export async function validateWithPublisher({ publisher, serverJsonPath, home, env, timeoutMs = DEFAULT_TIMEOUTS.validateMs }) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    const result = await runProcess(publisher, ['validate', serverJsonPath], { env: childEnvironment(env, home), timeoutMs });
    const outcome = processOutcome(result);
    return { ...outcome, passed: outcome.passed && result.stdout.includes('server.json is valid') };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Arguments for `node`: the read-only smoke suite, never --serve. */
export const acceptanceArguments = origin => ['--import', 'tsx', 'scripts/smoke.ts', origin, '--mainnet'];

/** Run the repository's read-only acceptance suite and keep only its public summary. */
export async function runAcceptance({ cwd, env, origin = PRODUCTION_ORIGIN, timeoutMs = DEFAULT_TIMEOUTS.acceptanceMs,
  command = [process.execPath, ...acceptanceArguments(origin)], clock = () => new Date() }) {
  const startedAt = clock().toISOString();
  const result = await runProcess(command[0], command.slice(1), { cwd, env: childEnvironment(env, env.HOME || cwd), timeoutMs, maxOutput: 1_048_576 });
  const acceptance = { startedAt, completedAt: clock().toISOString(), command: ['node', ...acceptanceArguments(origin)].join(' '),
    origin, passed: false, exitCode: result.exitCode, timedOut: result.timedOut };
  let summary;
  try { summary = JSON.parse(result.exitCode === 0 ? result.stdout : result.stderr); } catch { summary = undefined; }
  if (isObject(summary)) {
    Object.assign(acceptance, {
      runId: typeof summary.runId === 'string' ? sanitizeMessage(summary.runId, 64) : null,
      mode: summary.mode, network: summary.network, requestsAttempted: summary.requestsAttempted,
      maxRequests: summary.budget?.maxRequests, servingRequestsAttempted: summary.servingRequestsAttempted,
      maxServingRequests: summary.budget?.maxServingRequests, servingChecks: summary.servingChecks,
      countsUnchanged: summary.countsUnchanged,
    });
  }
  if (result.exitCode !== 0 || result.timedOut || !isObject(summary)) {
    acceptance.error = sanitizeMessage(isObject(summary) ? summary.error : result.timedOut ? 'acceptance timed out' : 'acceptance did not report a summary');
    return acceptance;
  }
  acceptance.passed = summary.passed === true && summary.mode === 'read-only' && summary.network === 'mainnet'
    && summary.origin === origin && summary.servingChecks === 'not-run' && summary.servingRequestsAttempted === 0
    && summary.budget?.maxServingRequests === 0 && Number.isInteger(summary.requestsAttempted)
    && summary.requestsAttempted <= summary.budget?.maxRequests;
  if (!acceptance.passed) acceptance.error = 'acceptance summary is not a passing read-only mainnet run with zero servings';
  return acceptance;
}

function baseEvidence(stage, { version, sourceRevision, context, registry, origin }) {
  const urls = registryUrls(registry, typeof version === 'string' && VERSION_PATTERN.test(version) ? version : 'invalid');
  return {
    schemaVersion: 1, kind: 'mcp-registry-publication', stage, outcome: 'failed', passed: false, name: SERVER_NAME,
    version: typeof version === 'string' && VERSION_PATTERN.test(version) ? version : null,
    source: { revision: typeof sourceRevision === 'string' && REVISION_PATTERN.test(sourceRevision) ? sourceRevision : null,
      workflowRevision: context.workflowRevision ?? null },
    run: context.run ?? null,
    registry: { url: registry, exactVersionUrl: urls.exactVersion, latestUrl: urls.latest, versionsUrl: urls.versions },
    origin, publisher: { ...PUBLISHER },
  };
}

// Unexpected errors keep only an errno-style code: their messages can contain local paths.
function recordError(evidence, error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'unexpected failure';
  evidence.error = error instanceof PublicationError
    ? { code: error.code, message: sanitizeMessage(error.message) }
    : { code: 'internal', message: code };
}

async function saveSnapshot(outputDirectory, version, response) {
  if (!response?.json || response.status !== 200) return null;
  const artifact = `mcp-registry-${version}.json`;
  const bytes = `${JSON.stringify(response.json, null, 2)}\n`;
  await writeFile(join(outputDirectory, artifact), bytes, { mode: 0o644 });
  return { artifact, snapshotFileSha256: sha256(bytes), capturedAt: response.observedAt };
}

/** Source, checkout and metadata checks shared by both jobs; records public source evidence. */
function checkRelease(opts, evidence) {
  const { cwd, version, sourceRevision, context } = opts;
  (opts.refreshMain ?? refreshMain)({ cwd, git: opts.git });
  const source = checkSource({ cwd, sourceRevision, workflowRevision: context.workflowRevision, version, git: opts.git });
  const serverJsonPath = join(cwd, 'server.json');
  const bytes = readFileSync(serverJsonPath);
  if (!bytes.equals(source.serverJson)) fail('source', 'The checked-out server.json differs from the dispatched revision');
  const metadata = checkMetadata(bytes, version, JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version);
  evidence.source = { revision: source.revision, workflowRevision: source.workflowRevision, mainRevision: source.mainRevision,
    releaseCommit: source.releaseCommit, serverJsonSha256: metadata.sha256, serverJsonBytes: metadata.bytes };
  return { metadata, serverJsonPath };
}

async function readRegistry(options, server) {
  const { registry, version, fetch: fetchImpl, timeouts, clock } = options;
  const serverVersion = await getJson(registryUrls(registry, version).serverVersion, { fetch: fetchImpl, timeoutMs: timeouts.requestMs, clock });
  const lookup = await lookupRegistry({ registry, version, server, fetch: fetchImpl, timeoutMs: timeouts.requestMs, clock });
  return {
    serverVersion: typeof serverVersion.json?.version === 'string' ? sanitizeMessage(serverVersion.json.version, 40) : null,
    lookup,
  };
}

/** Everything that can be checked without publishing. Records evidence even on failure. */
export async function runPreflight(options) {
  const opts = { registry: REGISTRY_URL, origin: PRODUCTION_ORIGIN, clock: () => new Date(), ...options,
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts } };
  const { cwd, version, mode, outputDirectory, env } = opts;
  const evidence = baseEvidence('preflight', opts);
  evidence.mode = ['preflight', 'publish'].includes(mode) ? mode : null;
  evidence.startedAt = opts.clock().toISOString();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  try {
    if (!evidence.mode) fail('input', 'Mode must be preflight or publish');
    parseReleaseVersion(version);
    const { metadata, serverJsonPath } = checkRelease(opts, evidence);

    evidence.environment = await checkEnvironment({ api: opts.api, token: opts.githubToken, fetch: opts.fetch,
      timeoutMs: opts.timeouts.requestMs, clock: opts.clock });
    if (mode === 'publish' && !evidence.environment.passed) {
      fail('environment', `The ${ENVIRONMENT} approval environment is not protected: ${evidence.environment.problems.join('; ')}`);
    }

    const { serverVersion, lookup } = await readRegistry(opts, metadata.server);
    evidence.registry.serverVersion = serverVersion;
    evidence.registryState = { exactVersion: lookup.exact, latest: lookup.latest, versions: lookup.versions };
    const decision = decidePublication(lookup, version);
    evidence.decision = decision.decision;
    if (decision.decision === 'already-published') {
      evidence.snapshot = await saveSnapshot(outputDirectory, version, lookup.exactResponse);
      evidence.outcome = 'already-published';
      evidence.passed = true;
      return evidence;
    }

    evidence.validation = await validateWithPublisher({ publisher: opts.publisher, serverJsonPath,
      home: join(outputDirectory, '.publisher-home'), env, timeoutMs: opts.timeouts.validateMs });
    if (!evidence.validation.passed) fail('validation', 'Official registry validation did not accept server.json');
    evidence.acceptance = await runAcceptance({ cwd, env, origin: opts.origin, timeoutMs: opts.timeouts.acceptanceMs,
      command: opts.acceptanceCommand, clock: opts.clock });
    if (!evidence.acceptance.passed) fail('acceptance', 'Read-only production acceptance did not pass; nothing was published');
    evidence.outcome = mode === 'publish' ? 'awaiting-approval' : 'ready-to-publish';
    evidence.passed = true;
    return evidence;
  } catch (error) {
    recordError(evidence, error);
    return evidence;
  } finally {
    evidence.completedAt = opts.clock().toISOString();
    await writeFile(join(outputDirectory, 'preflight.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  }
}

async function pollVerification(opts, server) {
  const { registry, version, fetch: fetchImpl, timeouts, clock, sleep } = opts;
  let lookup;
  let problems = [];
  for (let attempt = 1; attempt <= timeouts.verifyAttempts; attempt++) {
    lookup = await lookupRegistry({ registry, version, server, fetch: fetchImpl, timeoutMs: timeouts.requestMs, clock, includeVersions: false });
    problems = verificationProblems(lookup, version);
    const conflict = lookup.exact.state === 'present' && !lookup.exact.metadataMatch;
    if (!problems.length || conflict) return { attempts: attempt, lookup, problems, conflict };
    if (attempt < timeouts.verifyAttempts) await sleep(timeouts.verifyIntervalMs);
  }
  return { attempts: timeouts.verifyAttempts, lookup, problems, conflict: false };
}

function tokenFileAbsent(home) {
  try { lstatSync(join(home, '.config', 'mcp-publisher', 'token.json')); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}

/**
 * Approval-gated publication. Rechecks registry and deployment state, logs in with
 * GitHub OIDC immediately before one publish attempt, always logs out, then
 * reconciles only through read-only lookups. There is no automatic retry.
 */
export async function runPublication(options) {
  const opts = { registry: REGISTRY_URL, origin: PRODUCTION_ORIGIN, clock: () => new Date(), sleep: delay, ...options,
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts } };
  const { version, outputDirectory, env, publisher, home } = opts;
  const evidence = baseEvidence('publish', opts);
  evidence.startedAt = opts.clock().toISOString();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  let publishAttempted = false;
  try {
    parseReleaseVersion(version);
    if (typeof opts.expectedSha256 !== 'string' || !SHA256_PATTERN.test(opts.expectedSha256)) {
      fail('input', 'The approved preflight metadata digest is missing or malformed');
    }
    // A private, disposable HOME holds the five-minute registry login; it is removed recursively.
    if (typeof home !== 'string' || resolve(home) !== home || !/^mcp-publisher-home[A-Za-z0-9._-]*$/.test(home.split('/').at(-1))) {
      fail('input', 'Publisher home must be an absolute mcp-publisher-home* directory');
    }
    const { metadata, serverJsonPath } = checkRelease(opts, evidence);
    if (metadata.sha256 !== opts.expectedSha256) fail('source', 'server.json differs from the metadata approved in preflight');

    // The approval wait can be long: re-read registry state and the live release.
    const { serverVersion, lookup } = await readRegistry(opts, metadata.server);
    evidence.registry.serverVersion = serverVersion;
    evidence.precheck = { exactVersion: lookup.exact, latest: lookup.latest, versions: lookup.versions };
    const decision = decidePublication(lookup, version);
    if (decision.decision === 'already-published') {
      evidence.snapshot = await saveSnapshot(outputDirectory, version, lookup.exactResponse);
      evidence.outcome = 'already-published';
      evidence.passed = true;
      return evidence;
    }
    evidence.deployment = await checkDeployment({ origin: opts.origin, version, fetch: opts.fetch,
      timeoutMs: opts.timeouts.requestMs, clock: opts.clock });
    if (!evidence.deployment.passed) fail('deployment', `Production deployment recheck failed: ${evidence.deployment.problem}`);

    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true, mode: 0o700 });
    try {
      const login = await runProcess(publisher, ['login', 'github-oidc', `--registry=${opts.registry}`],
        { env: childEnvironment(env, home, OIDC_ENVIRONMENT), timeoutMs: opts.timeouts.loginMs });
      evidence.login = processOutcome(login, OIDC_ENVIRONMENT.map(key => env[key]));
      if (!evidence.login.passed) fail('login', 'GitHub OIDC registry login failed; publication was not attempted');
      publishAttempted = true;
      evidence.publication = { attemptedAt: opts.clock().toISOString() };
      const published = await runProcess(publisher, ['publish', serverJsonPath],
        { env: childEnvironment(env, home), timeoutMs: opts.timeouts.publishMs });
      Object.assign(evidence.publication, processOutcome(published, OIDC_ENVIRONMENT.map(key => env[key])),
        { completedAt: opts.clock().toISOString() });
    } finally {
      // Cleanup problems are recorded, never thrown, so verification always follows a publish attempt.
      const logout = await runProcess(publisher, ['logout'], { env: childEnvironment(env, home), timeoutMs: opts.timeouts.logoutMs });
      await rm(home, { recursive: true, force: true }).catch(() => {});
      evidence.logout = { exitCode: logout.exitCode, timedOut: logout.timedOut, tokenRemoved: tokenFileAbsent(home) };
    }

    const verification = await pollVerification(opts, metadata.server);
    evidence.verification = { attempts: verification.attempts, exactVersion: verification.lookup.exact,
      latest: verification.lookup.latest, problems: verification.problems };
    evidence.snapshot = await saveSnapshot(outputDirectory, version, verification.lookup.exactResponse);
    if (verification.conflict) {
      evidence.outcome = 'conflict';
      fail('registry-conflict', 'The registry now holds different metadata for this version');
    }
    if (!verification.problems.length) {
      // A duplicate-version rejection means the identical record predates this request.
      const preExisting = evidence.publication.httpStatus === 400 && /cannot publish duplicate version/.test(evidence.publication.message);
      evidence.outcome = preExisting ? 'already-published' : 'published';
      evidence.reconciled = !evidence.publication.passed;
      if (!evidence.logout.tokenRemoved) fail('cleanup', 'Verified, but the temporary registry login could not be removed');
      evidence.passed = true;
      return evidence;
    }
    const status = evidence.publication.httpStatus;
    if (!evidence.publication.passed && verification.lookup.exact.state === 'absent' && !evidence.publication.timedOut
      && status >= 400 && status < 500) {
      evidence.outcome = 'not-published';
      fail('not-published', `The registry rejected the publication (HTTP ${status}) and has no record of it; fix the cause, then dispatch again`);
    }
    evidence.outcome = 'uncertain';
    fail('uncertain', `Publication could not be verified (${verification.problems.join('; ')}); do not retry until a read-only preflight reconciles it`);
  } catch (error) {
    // Any unexpected failure after a publish attempt must be reconciled like a lost response.
    if (evidence.outcome === 'failed') evidence.outcome = publishAttempted ? 'uncertain' : 'not-published';
    recordError(evidence, error);
    return evidence;
  } finally {
    evidence.completedAt = opts.clock().toISOString();
    await writeFile(join(outputDirectory, 'publication.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  }
}

const cell = value => sanitizeMessage(value ?? '—', 200).replaceAll('|', '\\|') || '—';

/** Public-safe Markdown for the Actions job summary. */
export function renderSummary(evidence) {
  const rows = [
    ['Outcome', `**${evidence.outcome}**`],
    ['Server', `${evidence.name} ${evidence.version ?? '(invalid version)'}`],
    ['Source revision', evidence.source?.revision],
    ['server.json SHA-256', evidence.source?.serverJsonSha256],
    ['Registry', `${evidence.registry.url} (server ${evidence.registry.serverVersion ?? 'unknown'})`],
  ];
  const state = evidence.registryState || evidence.precheck;
  if (state) {
    rows.push(['Exact version before', `${state.exactVersion?.state ?? '—'} (HTTP ${state.exactVersion?.httpStatus ?? '—'})`]);
    rows.push(['Latest before', state.latest?.state === 'present' ? `${state.latest.version} ${state.latest.status}` : state.latest?.state]);
  }
  if (evidence.environment) {
    rows.push(['Approval environment', evidence.environment.passed ? `${ENVIRONMENT}: protected, ${evidence.environment.reviewerCount} reviewer(s)`
      : `${ENVIRONMENT}: ${evidence.environment.problems.join('; ')}`]);
  }
  if (evidence.validation) rows.push(['Registry validation', evidence.validation.passed ? 'passed' : evidence.validation.message]);
  if (evidence.acceptance) {
    rows.push(['Read-only acceptance', evidence.acceptance.passed
      ? `passed: ${evidence.acceptance.requestsAttempted}/${evidence.acceptance.maxRequests} requests, ${evidence.acceptance.servingRequestsAttempted} servings`
      : evidence.acceptance.error]);
  }
  if (evidence.deployment) rows.push(['Deployment recheck', `${evidence.deployment.health?.version ?? '—'} (${evidence.deployment.requestsAttempted} read requests)`]);
  if (evidence.publication) rows.push(['Publish command', `exit ${evidence.publication.exitCode ?? '—'}${evidence.publication.timedOut ? ' (timed out)' : ''}`]);
  if (evidence.verification) {
    rows.push(['Verification', evidence.verification.problems.length ? evidence.verification.problems.join('; ')
      : `exact and latest active and identical (attempt ${evidence.verification.attempts})`]);
  }
  if (evidence.snapshot) rows.push(['Registry snapshot', `${evidence.snapshot.artifact} ${evidence.snapshot.snapshotFileSha256}`]);
  if (evidence.error) rows.push(['Error', `${evidence.error.code}: ${evidence.error.message}`]);
  const table = rows.map(([name, value]) => `| ${name} | ${name === 'Outcome' ? value : cell(value)} |`).join('\n');
  return `### MCP Registry ${evidence.stage}\n\n| Check | Result |\n| --- | --- |\n${table}\n`;
}

/** Append the job summary and, for a passing preflight, the outputs that gate the Publish job. */
export function writeActionsFiles(evidence, env) {
  const outputs = evidence.stage === 'preflight' && evidence.passed
    ? { decision: evidence.decision, server_json_sha256: evidence.source.serverJsonSha256 } : undefined;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(evidence));
  if (env.GITHUB_OUTPUT && outputs) {
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
}

const USAGE = `Usage:
  node scripts/registry-publication.mjs preflight --version X.Y.Z --source-revision SHA --mode preflight|publish --publisher PATH --output-dir DIR
  node scripts/registry-publication.mjs publish --version X.Y.Z --source-revision SHA --server-json-sha256 HEX --publisher PATH --publisher-home DIR --output-dir DIR`;

export function parseArgs(args) {
  const [command, ...rest] = args;
  const allowed = {
    preflight: ['--version', '--source-revision', '--mode', '--publisher', '--output-dir'],
    publish: ['--version', '--source-revision', '--server-json-sha256', '--publisher', '--publisher-home', '--output-dir'],
  }[command];
  if (!allowed || rest.length !== allowed.length * 2) throw new Error(USAGE);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (!allowed.includes(flag) || flag in values || typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(USAGE);
    values[flag] = value;
  }
  return { command, values };
}

async function main(args) {
  const { command, values } = parseArgs(args);
  const env = process.env;
  const cwd = process.cwd();
  let context;
  if (env.GITHUB_ACTIONS === 'true') context = checkDispatch(env);
  else if (command === 'preflight' && values['--mode'] === 'preflight') {
    // Local dry run: read-only, never publishes, and cannot claim an Actions run.
    context = { workflowRevision: runGit(cwd, ['rev-parse', 'HEAD']).toString().trim(), run: null };
  } else throw new Error('Publication runs only in the approved GitHub Actions workflow');
  const common = { cwd, version: values['--version'], sourceRevision: values['--source-revision'], context, env,
    publisher: resolve(values['--publisher']), outputDirectory: resolve(values['--output-dir']) };
  const evidence = command === 'preflight'
    ? await runPreflight({ ...common, mode: values['--mode'], githubToken: env.GITHUB_TOKEN })
    : await runPublication({ ...common, expectedSha256: values['--server-json-sha256'], home: resolve(values['--publisher-home']) });
  writeActionsFiles(evidence, env);
  console.log(JSON.stringify({ stage: evidence.stage, outcome: evidence.outcome, passed: evidence.passed,
    version: evidence.version, error: evidence.error }, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(sanitizeMessage(error instanceof Error ? error.message : 'Registry publication failed', 2000));
    process.exitCode = 1;
  }
}

export const repositoryRoot = () => fileURLToPath(new URL('../', import.meta.url));
