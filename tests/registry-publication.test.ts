import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acceptanceArguments, checkDeployment, checkDispatch, checkEnvironment, checkMetadata, checkSource, childEnvironment,
  compareVersions, decidePublication, ENVIRONMENT, getJson, parseArgs, parseReleaseVersion, PRODUCTION_ORIGIN, PUBLISHER,
  refreshMain, renderSummary, REPOSITORY, runAcceptance, runPreflight, runProcess, runPublication, sanitizeMessage, SERVER_NAME,
  verificationProblems, WORKFLOW_FILE, writeActionsFiles,
} from '../scripts/registry-publication.mjs';

const ROOT = new URL('../', import.meta.url);
const COMMITTED_SERVER = JSON.parse(readFileSync(new URL('server.json', ROOT), 'utf8'));
const VERSION = '0.4.7';
const serverJson = (version = VERSION, changes: Record<string, unknown> = {}) =>
  `${JSON.stringify({ ...COMMITTED_SERVER, version, ...changes }, null, 2)}\n`;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const FAST = { requestMs: 2_000, loginMs: 5_000, publishMs: 1_500, logoutMs: 5_000, validateMs: 5_000,
  acceptanceMs: 10_000, verifyAttempts: 2, verifyIntervalMs: 1 };
const OIDC = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc-request.invalid/job-7f3a/idtoken?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token-secret' };
// Process and server fixtures must fail rather than hang if a kill timer regresses.
const SLOW = { timeout: 120_000 };

function temporaryDirectory(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `merovingian-${prefix}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: string) => unknown) {
  // A crashing fixture must fail the test, not masquerade as an HTTP 500 under test.
  const crashes: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    try { await handler(req, res, Buffer.concat(chunks).toString('utf8')); }
    catch (error) { crashes.push(error); if (!res.headersSent) res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
    assert.deepEqual(crashes, [], 'fixture handler crashed');
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sendJson = (res: ServerResponse, status: number, value: unknown, type = 'application/json') =>
  res.writeHead(status, { 'content-type': type }).end(JSON.stringify(value));
const notFound = (res: ServerResponse) =>
  sendJson(res, 404, { title: 'Not Found', status: 404, detail: 'Server not found' }, 'application/problem+json');

interface StoredVersion { server: Record<string, unknown>; status: string; isLatest: boolean; publishedAt: string }
type Fault = (req: IncomingMessage, res: ServerResponse, path: string) => boolean;

// Independent of the code under test: plain numeric MAJOR.MINOR.PATCH ordering.
const newer = (left: string, right: string) => {
  const [a, b] = [left, right].map(version => version.split('.').map(Number));
  const index = a.findIndex((part, position) => part !== b[position]);
  return index >= 0 && a[index] > b[index];
};

/** In-memory registry with the read, publish and status semantics of registry v1.8.1. */
async function registryFixture(t: TestContext, initial: string[] = ['0.4.5', '0.4.6'], fault?: Fault) {
  const records = new Map<string, StoredVersion>();
  const publishes: { authorization?: string; body: string }[] = [];
  const reads: string[] = [];
  let respondToPublish: ((res: ServerResponse) => void) | undefined;
  // Status changes move latest to the highest non-deleted version, or the highest deleted one if all are deleted.
  const recalculateLatest = () => {
    const all = [...records.values()];
    const candidates = all.some(record => record.status !== 'deleted') ? all.filter(record => record.status !== 'deleted') : all;
    const best = candidates.reduce<StoredVersion | undefined>((top, record) =>
      !top || newer(String(record.server.version), String(top.server.version)) ? record : top, undefined);
    for (const record of all) record.isLatest = record === best;
  };
  // Publishing compares only with the row currently flagged latest, whatever its status.
  const publish = (server: Record<string, unknown>) => {
    const version = String(server.version);
    const latest = [...records.values()].find(record => record.isLatest);
    const isLatest = !latest || newer(version, String(latest.server.version));
    if (isLatest && latest) latest.isLatest = false;
    records.set(version, { server, status: 'active', isLatest, publishedAt: `2026-09-22T00:00:${String(records.size).padStart(2, '0')}Z` });
  };
  const setStatus = (version: string, status: string) => { records.get(version)!.status = status; recalculateLatest(); };
  const add = (server: Record<string, unknown>, status = 'active') => {
    publish(server);
    if (status !== 'active') setStatus(String(server.version), status);
  };
  for (const version of initial) add(JSON.parse(serverJson(version)));
  const response = (record: StoredVersion) => ({ server: record.server, _meta: { 'io.modelcontextprotocol.registry/official': {
    status: record.status, statusChangedAt: record.publishedAt, publishedAt: record.publishedAt, updatedAt: record.publishedAt, isLatest: record.isLatest,
  } } });
  const prefix = `/v0.1/servers/${encodeURIComponent(SERVER_NAME)}/versions`;
  const url = await listen(t, (req, res, body) => {
    const { pathname, searchParams } = new URL(req.url!, 'http://fixture');
    if (req.method === 'GET') reads.push(req.url!);
    if (fault?.(req, res, pathname)) return;
    const includeDeleted = searchParams.get('include_deleted') === 'true';
    if (req.method === 'GET' && pathname === '/v0.1/version') return sendJson(res, 200, { version: '1.8.1' });
    if (req.method === 'GET' && pathname === prefix) {
      const servers = [...records.values()].filter(record => includeDeleted || record.status !== 'deleted').map(response);
      return servers.length ? sendJson(res, 200, { servers, metadata: { count: servers.length } }) : notFound(res);
    }
    if (req.method === 'GET' && pathname === `${prefix}/latest`) {
      const latest = [...records.values()].find(record => record.isLatest && (includeDeleted || record.status !== 'deleted'));
      return latest ? sendJson(res, 200, response(latest)) : notFound(res);
    }
    if (req.method === 'GET' && pathname.startsWith(`${prefix}/`)) {
      const record = records.get(decodeURIComponent(pathname.slice(prefix.length + 1)));
      return record && (includeDeleted || record.status !== 'deleted') ? sendJson(res, 200, response(record)) : notFound(res);
    }
    if (req.method === 'POST' && pathname === '/v0/publish') {
      publishes.push({ authorization: req.headers.authorization, body });
      if (!/^Bearer \S+$/.test(req.headers.authorization || '')) return sendJson(res, 401, { detail: 'Invalid or expired Registry JWT token' });
      const server = JSON.parse(body);
      if (records.has(server.version)) {
        return sendJson(res, 400, { title: 'Bad Request', status: 400, detail: 'Failed to publish server',
          errors: [{ message: 'invalid version: cannot publish duplicate version' }] }, 'application/problem+json');
      }
      if (respondToPublish) return respondToPublish(res);
      publish(server);
      return sendJson(res, 200, response(records.get(server.version)!));
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"Endpoint not found. See /docs for the API documentation."}');
  });
  const commitLastPublish = () => publish(JSON.parse(publishes.at(-1)!.body));
  return {
    url, records, publishes, reads, add, setStatus, publish,
    /** Replace the publish response; the handler decides whether to commit. */
    onPublish(handler: (res: ServerResponse, commit: () => void) => void) { respondToPublish = res => handler(res, commitLastPublish); },
  };
}

async function deploymentFixture(t: TestContext, health: Record<string, unknown> = {}, card: Record<string, unknown> = {}) {
  const requests: string[] = [];
  let origin = '';
  origin = await listen(t, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/healthz') {
      return sendJson(res, 200, { status: 'ok', network: 'mainnet', chainId: 'manifest-ledger-mainnet', retired: false, version: VERSION, ...health });
    }
    if (req.method === 'GET' && req.url === '/mcp/server-card') {
      return sendJson(res, 200, { name: SERVER_NAME, version: VERSION, websiteUrl: origin,
        remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }], ...card }, 'application/mcp-server-card+json');
    }
    res.writeHead(404).end();
  });
  return { origin, requests };
}

async function environmentFixture(t: TestContext, environment: Record<string, unknown> | null = {}, policies: unknown[] = [{ name: 'main', type: 'branch' }]) {
  const requests: { url: string; authorization?: string }[] = [];
  const api = await listen(t, (req, res) => {
    requests.push({ url: req.url!, authorization: req.headers.authorization });
    const base = `/repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
    if (environment === null) return sendJson(res, 404, { message: 'Not Found' });
    if (req.url === base) {
      return sendJson(res, 200, { name: ENVIRONMENT, can_admins_bypass: false,
        protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: 'reviewer' } }] },
          { type: 'branch_policy' }],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, ...environment });
    }
    if (req.url === `${base}/deployment-branch-policies`) {
      return sendJson(res, 200, { total_count: policies.length, branch_policies: policies.map((policy, id) => ({ id, ...(policy as object) })) });
    }
    res.writeHead(404).end();
  });
  return { api, requests };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/**
 * A checkout of a bare "origin": a release commit, a later docs commit on main and an
 * unrelated branch commit. advanceMain() pushes a new main tip and then, like
 * actions/checkout, force-moves refs/remotes/origin/main back to the dispatched commit.
 */
function repositoryFixture(t: TestContext, version = VERSION) {
  const directory = temporaryDirectory(t, 'registry-source');
  const remote = join(directory, 'origin.git');
  const cwd = join(directory, 'checkout');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', cwd]);
  git(cwd, 'remote', 'add', 'origin', remote);
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
    git(cwd, 'add', '--all');
    git(cwd, 'commit', '--quiet', '--message', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const packageJson = (value: string) => `${JSON.stringify({ name: 'merovingian', version: value }, null, 2)}\n`;
  commit({ 'server.json': serverJson('0.4.6'), 'package.json': packageJson('0.4.6') }, 'previous release');
  const release = commit({ 'server.json': serverJson(version), 'package.json': packageJson(version) }, 'release');
  const head = commit({ 'NOTES.md': 'docs\n' }, 'docs');
  git(cwd, 'push', '--quiet', 'origin', 'main');
  git(cwd, 'checkout', '--quiet', '-b', 'side', release);
  const side = commit({ 'SIDE.md': 'side\n' }, 'side');
  git(cwd, 'checkout', '--quiet', 'main');
  const advanceMain = (files: Record<string, string>) => {
    const tip = commit(files, 'main moved');
    git(cwd, 'push', '--quiet', 'origin', 'main');
    git(cwd, 'reset', '--quiet', '--hard', head);
    git(cwd, 'update-ref', 'refs/remotes/origin/main', head);
    return tip;
  };
  return { cwd, release, head, side, advanceMain };
}

/** Executable stand-in for mcp-publisher 1.8.1. Behavior comes from a file because children get a minimal environment. */
function publisherFixture(t: TestContext, behavior: Record<string, string> = {}) {
  const directory = temporaryDirectory(t, 'fake-publisher');
  const path = join(directory, 'mcp-publisher');
  writeFileSync(join(directory, 'behavior.json'), JSON.stringify({ login: 'ok', publish: 'ok', validate: 'ok', ...behavior }));
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const directory = ${JSON.stringify(directory)};
const behavior = JSON.parse(fs.readFileSync(path.join(directory, 'behavior.json'), 'utf8'));
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify({ command, args, env: process.env }) + '\\n');
const tokenFile = path.join(process.env.HOME, '.config', 'mcp-publisher', 'token.json');
const done = (code, stream, text) => { process[stream].write(text + '\\n'); process.exit(code); };
(async () => {
  if (command === 'validate') return behavior.validate === 'ok' ? done(0, 'stdout', '✅ server.json is valid') : done(1, 'stdout', '❌ Validation failed with 1 issue(s):');
  if (command === 'login') {
    if (behavior.login === 'unreachable') return done(1, 'stderr', 'Error: failed to get token: failed to get OIDC token from GitHub: failed to send request: Get "'
      + process.env.ACTIONS_ID_TOKEN_REQUEST_URL + '&audience=https%3A%2F%2Fregistry.modelcontextprotocol.io": dial tcp: lookup failed');
    if (behavior.login !== 'ok') return done(1, 'stderr', 'Error: failed to get token: token exchange failed with status 401: {"detail":"bad eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln"}');
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile, JSON.stringify({ token: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln', method: 'github-oidc', registry: args[1].replace('--registry=', '') }), { mode: 0o600 });
    return done(0, 'stdout', '✓ Successfully logged in');
  }
  if (command === 'logout') {
    if (behavior.logout === 'stuck') { fs.chmodSync(path.dirname(tokenFile), 0o500); return done(0, 'stdout', '✓ Successfully logged out'); }
    fs.rmSync(tokenFile, { force: true });
    return done(0, 'stdout', '✓ Successfully logged out');
  }
  if (command === 'publish') {
    if (behavior.publish === 'hang') return setInterval(() => {}, 1000);
    const { token, registry } = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    process.stdout.write('Publishing to ' + registry + '...\\n');
    let response;
    try {
      response = await fetch(registry + '/v0/publish', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: fs.readFileSync(args[0]) });
    } catch { return done(1, 'stderr', 'Error: publish failed: error sending request: connection reset'); }
    const body = await response.text().catch(() => '');
    if (behavior.publish === 'lost-response') return done(1, 'stderr', 'Error: publish failed: error reading response: unexpected EOF');
    // Upstream: a 422 triggers /v0/validate and reports its issues without the HTTP status.
    if (response.status === 422) {
      process.stdout.write('Validation failed. Checking detailed validation errors...\\n\\n');
      return done(1, 'stderr', 'Error: validation failed');
    }
    if (response.status !== 200 && response.status !== 201) return done(1, 'stderr', 'Error: publish failed: server returned status ' + response.status + ': ' + body);
    return done(0, 'stdout', '✓ Successfully published');
  }
  done(1, 'stderr', 'Error: unknown command');
})();
`);
  chmodSync(path, 0o755);
  const calls = () => existsSync(join(directory, 'calls.jsonl'))
    ? readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string; args: string[]; env: Record<string, string> })
    : [];
  return { path, calls };
}

const ACCEPTANCE_SUMMARY = { runId: '00000000-0000-4000-8000-000000000000', origin: PRODUCTION_ORIGIN, network: 'mainnet', mode: 'read-only', passed: true,
  budget: { maxRequests: 21, maxServingRequests: 0, servings: {} }, requestsAttempted: 20, servingRequestsAttempted: 0,
  servingChecks: 'not-run', countsUnchanged: true, contributionVerified: false, report: '.local/mainnet/smoke.json', reportWritten: true };

/** Source of a stand-in for the read-only smoke CLI that prints a configured summary. */
const smokeScript = (log: string, summary: Record<string, unknown>, exitCode: number) => `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');
process[${exitCode === 0 ? '"stdout"' : '"stderr"'}].write(${JSON.stringify(JSON.stringify(summary, null, 2))} + '\\n');
process.exitCode = ${exitCode};
`;

function acceptanceFixture(t: TestContext, summary: Record<string, unknown> = {}, exitCode = 0) {
  const directory = temporaryDirectory(t, 'fake-smoke');
  const log = join(directory, 'calls.jsonl');
  writeFileSync(join(directory, 'smoke.mjs'), smokeScript(log, { ...ACCEPTANCE_SUMMARY, ...summary }, exitCode));
  const calls = () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; env: Record<string, string> })
    : [];
  return { command: [process.execPath, join(directory, 'smoke.mjs'), PRODUCTION_ORIGIN, '--mainnet'], calls };
}

const CONTEXT = (workflowRevision: string) => ({ workflowRevision, run: { id: '123', attempt: 1, url: `https://github.com/${REPOSITORY}/actions/runs/123/attempts/1` } });
const typed404 = (res: ServerResponse) => notFound(res);

test('release versions are strict MAJOR.MINOR.PATCH and compare numerically', () => {
  assert.deepEqual(parseReleaseVersion('0.4.7'), [0, 4, 7]);
  for (const invalid of ['v0.4.7', '0.4.7-rc.1', '0.4.7+build', '0.4', '01.2.3', ' 0.4.7', '0.4.7\n', 7, null]) {
    assert.throws(() => parseReleaseVersion(invalid), /MAJOR.MINOR.PATCH/);
  }
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.4.6', '0.4.7'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('diagnostics redact tokens and control characters and stay bounded', () => {
  const message = sanitizeMessage('Error:\u001b[31m token exchange failed: eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.sig Bearer abc.def-ghi {"registry_token":"secret-value"}\n');
  assert.doesNotMatch(message, /eyJhbGci|abc\.def|secret-value|\u001b|\n/);
  assert.match(message, /\[redacted-jwt\].*Bearer \[redacted\].*"registry_token":"\[redacted\]"/);
  assert.ok(sanitizeMessage('x'.repeat(1000)).length <= 401);
  assert.equal(sanitizeMessage('Get "https://run-actions-3.actions.githubusercontent.com/42/idtoken/abc?api-version=2.0&audience=x": dial tcp'),
    'Get "[redacted-actions-url]": dial tcp');
});

test('metadata must be the reviewed minimal production shape for the requested version', () => {
  const bytes = Buffer.from(serverJson());
  const checked = checkMetadata(bytes, VERSION, VERSION);
  assert.equal(checked.sha256, sha256(serverJson()));
  assert.equal(checked.bytes, bytes.length);
  const committed = readFileSync(new URL('server.json', ROOT));
  assert.equal(checkMetadata(committed, COMMITTED_SERVER.version, COMMITTED_SERVER.version).server.name, SERVER_NAME);
  const rejects: [Buffer, RegExp, string?][] = [
    [Buffer.from(serverJson(VERSION, { icons: [] })), /exactly/],
    [Buffer.from(serverJson(VERSION, { name: 'io.github.manifest-network/other' })), /name/],
    [Buffer.from(serverJson('0.4.8')), /server.json version/],
    [bytes, /package.json version/, '0.4.6'],
    [Buffer.from(serverJson(VERSION, { remotes: [{ type: 'streamable-http', url: 'https://example.invalid/mcp' }] })), /remote endpoint/],
    [Buffer.from(serverJson(VERSION, { websiteUrl: 'https://merovingian.manifest.network/' })), /website/],
    [Buffer.from(serverJson(VERSION, { repository: { url: 'https://github.com/other/merovingian', source: 'github' } })), /repository/],
    [Buffer.from(serverJson(VERSION, { description: 'x'.repeat(101) })), /description/],
    [Buffer.from(serverJson(VERSION, { title: 'Mérovingian' })), /ASCII/],
    [Buffer.from('{"name":'), /valid JSON/],
  ];
  for (const [candidate, pattern, packageVersion = VERSION] of rejects) {
    assert.throws(() => checkMetadata(candidate, VERSION, packageVersion), pattern);
  }
});

test('dispatch context accepts only the main workflow of this repository', () => {
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW_FILE}@refs/heads/main`, GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
  };
  assert.deepEqual(checkDispatch(env), { workflowRevision: 'a'.repeat(40),
    run: { id: '42', attempt: 2, url: `https://github.com/${REPOSITORY}/actions/runs/42/attempts/2` } });
  for (const changed of [
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REPOSITORY: 'fork/merovingian' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main` }, { GITHUB_ACTIONS: undefined },
    { GITHUB_SERVER_URL: 'https://ghes.example.invalid' }, { GITHUB_SHA: 'abc' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: 'x' },
  ]) {
    assert.throws(() => checkDispatch({ ...env, ...changed }), /must/);
  }
});

test('command-line arguments are a closed, complete set per command', () => {
  const preflight = ['preflight', '--version', VERSION, '--source-revision', 'a'.repeat(40), '--mode', 'preflight', '--publisher', 'p', '--output-dir', 'o'];
  assert.equal(parseArgs(preflight).values['--mode'], 'preflight');
  for (const args of [
    [], ['status'], preflight.slice(0, -2), [...preflight, '--registry', 'http://example.invalid'],
    ['preflight', '--version', VERSION, '--version', VERSION, '--mode', 'preflight', '--publisher', 'p', '--output-dir', 'o'],
    ['preflight', '--version', '--mode', '--source-revision', 'x', '--mode', 'preflight', '--publisher', 'p', '--output-dir', 'o'],
  ]) {
    assert.throws(() => parseArgs(args), /Usage/);
  }
});

test('the CLI refuses to publish, or preflight in publish mode, outside GitHub Actions', SLOW, () => {
  const script = fileURLToPath(new URL('scripts/registry-publication.mjs', ROOT));
  const { GITHUB_ACTIONS: _, ...env } = process.env;
  for (const args of [
    ['publish', '--version', VERSION, '--source-revision', 'a'.repeat(40), '--server-json-sha256', 'b'.repeat(64),
      '--publisher', 'p', '--publisher-home', '/tmp/mcp-publisher-home', '--output-dir', 'o'],
    ['preflight', '--version', VERSION, '--source-revision', 'a'.repeat(40), '--mode', 'publish', '--publisher', 'p', '--output-dir', 'o'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runs only in the approved GitHub Actions workflow/);
  }
});

test('Actions outputs gate the Publish job only after a passing preflight', (t) => {
  const directory = temporaryDirectory(t, 'actions-files');
  const env = { GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') };
  const base = { stage: 'preflight', outcome: 'awaiting-approval', passed: true, name: SERVER_NAME, version: VERSION, decision: 'publish',
    source: { revision: 'a'.repeat(40), serverJsonSha256: 'b'.repeat(64) }, registry: { url: 'https://registry.example.invalid' } };
  writeActionsFiles(base, env);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), `decision=publish\nserver_json_sha256=${'b'.repeat(64)}\n`);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\*\*awaiting-approval\*\*/);
  writeActionsFiles({ ...base, outcome: 'failed', passed: false }, env);
  writeActionsFiles({ ...base, stage: 'publish', outcome: 'published' }, env);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8').split('\n').length, 3, 'failed or publish-stage evidence must not set outputs');
});

const present = (version: string, extra: Record<string, unknown> = {}) => ({ url: 'u', observedAt: 't', httpStatus: 200, state: 'present' as const,
  version, status: 'active', isLatest: true, publishedAt: 't', metadataMatch: true, ...extra });
const absent = { url: 'u', observedAt: 't', httpStatus: 404, state: 'absent' as const };
const error = { url: 'u', observedAt: 't', httpStatus: 503, state: 'error' as const, problem: 'unexpected HTTP 503 response' };
const history = (...versions: (string | [string, string])[]) => ({ url: 'u', observedAt: 't', httpStatus: 200, state: 'present' as const,
  versions: versions.map((entry, index) => {
    const [version, status] = Array.isArray(entry) ? entry : [entry, 'active'];
    return { version, status, isLatest: index === 0 };
  }) });

test('publication decisions treat identical records as no-ops and refuse conflicts or ambiguity', () => {
  assert.equal(decidePublication({ exact: absent, latest: present('0.4.6', { metadataMatch: false }), versions: history('0.4.6', '0.4.5') }, VERSION).decision, 'publish');
  assert.equal(decidePublication({ exact: absent, latest: absent, versions: { ...absent, versions: [] } }, VERSION).decision, 'publish');
  assert.equal(decidePublication({ exact: absent, latest: absent, versions: history(['0.4.6', 'deleted']) }, VERSION).decision, 'publish',
    'latest is absent when every version is deleted');
  assert.equal(decidePublication({ exact: present(VERSION), latest: present(VERSION), versions: history(VERSION) }, VERSION).decision, 'already-published');
  assert.equal(decidePublication({ exact: present(VERSION, { isLatest: false }), latest: present('0.5.0', { metadataMatch: false }) }, VERSION).decision,
    'already-published');
  const refusals: [Parameters<typeof decidePublication>[0], string, RegExp][] = [
    [{ exact: present(VERSION, { metadataMatch: false }), latest: present(VERSION) }, 'registry-conflict', /different metadata/],
    [{ exact: present(VERSION, { status: 'deleted', isLatest: false }), latest: present('0.4.6', { metadataMatch: false }) }, 'registry-conflict', /status deleted/],
    [{ exact: present(VERSION, { status: 'deprecated' }), latest: present(VERSION) }, 'registry-conflict', /status deprecated/],
    [{ exact: present(VERSION), latest: present(VERSION, { isLatest: false }) }, 'registry-uncertain', /latest record names this version/],
    [{ exact: present(VERSION, { isLatest: false }), latest: present('0.4.6', { metadataMatch: false }) }, 'registry-uncertain', /latest record is older/],
    [{ exact: error, latest: present('0.4.6'), versions: history('0.4.6') }, 'registry-uncertain', /inconclusive/],
    [{ exact: absent, latest: present('0.4.8', { metadataMatch: false }), versions: history('0.4.8', '0.4.6') }, 'registry-not-latest', /records 0.4.8 \(status active\)/],
    [{ exact: absent, latest: present('0.4.6'), versions: history(['1.0.0', 'deleted'], '0.4.6') }, 'registry-not-latest', /records 1.0.0 \(status deleted\).*including deleted/],
    [{ exact: absent, latest: present('0.4.6'), versions: history('0.4.7', '0.4.6') }, 'registry-uncertain', /exact-version lookup and version history disagree/],
    [{ exact: absent, latest: present('0.4.6'), versions: { ...history('0.4.6'), versions: [{ version: '0.4.7-rc.1', status: 'active', isLatest: false }] } },
      'registry-conflict', /not MAJOR.MINOR.PATCH/],
    [{ exact: absent, latest: present('0.4.6'), versions: error }, 'registry-uncertain', /history was inconclusive/],
    [{ exact: absent, latest: error, versions: history('0.4.6') }, 'registry-uncertain', /history was inconclusive/],
    [{ exact: absent, latest: absent, versions: history('0.4.6') }, 'registry-uncertain', /disagree/],
    [{ exact: absent, latest: present('0.4.5'), versions: history('0.4.6') }, 'registry-uncertain', /disagree/],
    [{ exact: absent, latest: present('0.4.5'), versions: history('0.4.6', ['0.4.5', 'deleted']) }, 'registry-uncertain', /disagree/],
  ];
  for (const [lookup, code, pattern] of refusals) {
    assert.throws(() => decidePublication(lookup, VERSION), (error: { code: string; message: string }) => error.code === code && pattern.test(error.message),
      `${code} ${pattern}`);
  }
});

test('verification requires active identical exact and latest records for the version', () => {
  assert.deepEqual(verificationProblems({ exact: present(VERSION), latest: present(VERSION) }, VERSION), []);
  assert.deepEqual(verificationProblems({ exact: present(VERSION, { isLatest: false }), latest: present('0.4.6', { metadataMatch: false }) }, VERSION),
    ['exact version is not latest', 'latest record names another version', 'latest record metadata differs']);
  assert.deepEqual(verificationProblems({ exact: absent, latest: error }, VERSION), ['exact version absent', 'latest record error']);
});

test('HTTP reads block redirects, oversized bodies and slow responses without throwing', SLOW, async (t) => {
  const url = await listen(t, (req, res) => {
    if (req.url === '/redirect') return res.writeHead(302, { location: '/ok' }).end();
    if (req.url === '/large') return sendJson(res, 200, { value: 'x'.repeat(300_000) });
    if (req.url === '/slow') return void setTimeout(() => sendJson(res, 200, {}), 1_000);
    sendJson(res, 200, { ok: true });
  });
  let tick = 0;
  const ok = await getJson(`${url}/ok`, { clock: () => new Date(Date.UTC(2026, 8, 22, 0, 0, tick++)) });
  assert.deepEqual(ok.json, { ok: true });
  assert.deepEqual([ok.requestedAt, ok.observedAt], ['2026-09-22T00:00:00.000Z', '2026-09-22T00:00:01.000Z']);
  assert.equal((await getJson(`${url}/redirect`)).problem, 'redirect blocked');
  assert.equal((await getJson(`${url}/large`)).problem, 'response too large');
  assert.equal((await getJson(`${url}/slow`, { timeoutMs: 50 })).problem, 'request timed out');
  assert.match((await getJson('http://127.0.0.1:1/unreachable')).problem!, /transport failed/);
});

test('source revisions must be on the live main and supply its exact metadata', SLOW, (t) => {
  const repo = repositoryFixture(t);
  refreshMain({ cwd: repo.cwd });
  const checked = checkSource({ cwd: repo.cwd, sourceRevision: repo.release, workflowRevision: repo.head, version: VERSION });
  assert.deepEqual({ ...checked, serverJson: checked.serverJson.toString() },
    { revision: repo.release, workflowRevision: repo.head, mainRevision: repo.head, releaseCommit: true, serverJson: serverJson() });
  assert.equal(checkSource({ cwd: repo.cwd, sourceRevision: repo.head, workflowRevision: repo.head, version: VERSION }).releaseCommit, false,
    'a later docs commit is accepted but not labelled as the release commit');
  const rejects: [Record<string, unknown>, RegExp][] = [
    [{ sourceRevision: repo.release.slice(0, 12) }, /full 40-character/],
    [{ sourceRevision: repo.release.toUpperCase() }, /full 40-character/],
    [{ sourceRevision: 'f'.repeat(40) }, /not a commit/],
    [{ sourceRevision: repo.side }, /not contained in the dispatched main/],
    [{ workflowRevision: repo.side, sourceRevision: repo.release }, /no longer contained in the current main/],
    [{ version: '0.4.8' }, /package.json at the source revision/],
  ];
  for (const [changed, pattern] of rejects) {
    assert.throws(() => checkSource({ cwd: repo.cwd, sourceRevision: repo.release, workflowRevision: repo.head, version: VERSION, ...changed }), pattern);
  }
  // actions/checkout leaves refs/remotes/origin/main at the dispatched commit; only the live ref sees the move.
  repo.advanceMain({ 'server.json': serverJson(VERSION, { description: 'Changed after review.' }) });
  assert.equal(git(repo.cwd, 'rev-parse', 'refs/remotes/origin/main'), repo.head);
  refreshMain({ cwd: repo.cwd });
  assert.throws(() => checkSource({ cwd: repo.cwd, sourceRevision: repo.release, workflowRevision: repo.head, version: VERSION }), /differs from main/);
  assert.throws(() => refreshMain({ cwd: temporaryDirectory(t, 'not-a-repository') }), /Could not fetch the current main/);
});

test('the approval environment must exist with reviewers, no admin bypass and only main', SLOW, async (t) => {
  const passing = await environmentFixture(t);
  const result = await checkEnvironment({ api: passing.api, token: 'workflow-token' });
  assert.equal(result.passed, true, result.problems.join('; '));
  assert.equal(result.reviewerCount, 1);
  assert.deepEqual(result.branchPolicies, [{ name: 'main', type: 'branch' }]);
  assert.ok(passing.requests.every(request => request.authorization === 'Bearer workflow-token'));
  assert.equal(JSON.stringify(result).includes('workflow-token'), false);
  const cases: [Record<string, unknown> | null, unknown[], RegExp][] = [
    [null, [], /does not exist/],
    [{ protection_rules: [] }, [{ name: 'main', type: 'branch' }], /no required reviewers/],
    [{ can_admins_bypass: true }, [{ name: 'main', type: 'branch' }], /administrators can bypass/],
    [{ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, [], /selected branches/],
    [{ deployment_branch_policy: null }, [], /selected branches/],
    [{}, [{ name: 'main', type: 'branch' }, { name: 'v*', type: 'tag' }], /exactly branch main/],
    [{}, [{ name: '*', type: 'branch' }], /exactly branch main/],
  ];
  for (const [environment, policies, pattern] of cases) {
    const fixture = await environmentFixture(t, environment, policies);
    const failed = await checkEnvironment({ api: fixture.api });
    assert.equal(failed.passed, false);
    assert.match(failed.problems.join('; '), pattern);
  }
});

test('deployment recheck uses at most two reads and requires the exact live identity', SLOW, async (t) => {
  const live = await deploymentFixture(t);
  const result = await checkDeployment({ origin: live.origin, version: VERSION });
  assert.equal(result.passed, true, result.problem);
  assert.deepEqual(live.requests, ['GET /healthz', 'GET /mcp/server-card']);
  assert.equal(result.servingRequestsAttempted, 0);
  for (const [health, card, pattern] of [
    [{ version: '0.4.6' }, {}, /requested version/], [{ retired: true }, {}, /healthy, active mainnet/],
    [{ network: 'testnet' }, {}, /healthy, active mainnet/], [{ chainId: 'manifest-ledger-testnet' }, {}, /healthy, active mainnet/],
    [{ status: 'degraded' }, {}, /healthy, active mainnet/], [{}, { version: '0.4.6' }, /release identity/],
    [{}, { name: 'network.manifest.merovingian/merovingian' }, /release identity/], [{}, { remotes: [] }, /release identity/],
    [{}, { websiteUrl: 'https://example.invalid' }, /release identity/],
  ] as const) {
    const fixture = await deploymentFixture(t, health, card);
    const failed = await checkDeployment({ origin: fixture.origin, version: VERSION });
    assert.equal(failed.passed, false);
    assert.match(failed.problem!, pattern);
    assert.ok(failed.requestsAttempted <= 2);
  }
  const down = await checkDeployment({ origin: 'http://127.0.0.1:1', version: VERSION, timeoutMs: 500 });
  assert.match(down.problem!, /health check failed \(transport failed/);
});

test('child processes receive no tokens, GODEBUG or unrelated environment', () => {
  const source = { PATH: '/bin', LANG: 'C.UTF-8', GITHUB_TOKEN: 'x', GODEBUG: 'http2debug=2', NODE_OPTIONS: '--require x', LD_PRELOAD: 'x', ...OIDC };
  assert.deepEqual(childEnvironment(source, '/tmp/home'), { HOME: '/tmp/home', PATH: '/bin', LANG: 'C.UTF-8' });
  assert.deepEqual(Object.keys(childEnvironment(source, '/tmp/home', Object.keys(OIDC))).sort(),
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'HOME', 'LANG', 'PATH']);
});

test('process spawning never throws, even when spawn rejects its arguments synchronously', SLOW, async () => {
  const result = await runProcess(process.execPath, ['a\u0000b'], { env: { PATH: process.env.PATH! }, timeoutMs: 5_000 });
  assert.deepEqual([result.exitCode, result.timedOut, result.error], [null, false, 'ERR_INVALID_ARG_VALUE']);
  const missing = await runProcess('/nonexistent/mcp-publisher', [], { env: {}, timeoutMs: 5_000 });
  assert.deepEqual([missing.exitCode, missing.error], [null, 'ENOENT']);
});

test('git runs without OIDC request variables or tokens from the step environment', SLOW, (t) => {
  const repo = repositoryFixture(t);
  const shim = temporaryDirectory(t, 'git-shim');
  const log = join(shim, 'env.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  writeFileSync(join(shim, 'git'), `#!/bin/sh\nenv >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(shim, 'git'), 0o755);
  const saved = { PATH: process.env.PATH, GITHUB_TOKEN: process.env.GITHUB_TOKEN, ...Object.fromEntries(Object.keys(OIDC).map(key => [key, process.env[key]])) };
  Object.assign(process.env, { PATH: `${shim}${delimiter}${process.env.PATH}`, GITHUB_TOKEN: 'workflow-token', ...OIDC });
  try {
    refreshMain({ cwd: repo.cwd });
    checkSource({ cwd: repo.cwd, sourceRevision: repo.release, workflowRevision: repo.head, version: VERSION });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const environment = readFileSync(log, 'utf8');
  assert.match(environment, /^GIT_TERMINAL_PROMPT=0$/m);
  for (const forbidden of ['workflow-token', ...Object.keys(OIDC), ...Object.values(OIDC)]) assert.equal(environment.includes(forbidden), false, forbidden);
});

test('the default acceptance command is the read-only mainnet smoke suite', SLOW, async (t) => {
  assert.deepEqual(acceptanceArguments(PRODUCTION_ORIGIN), ['--import', 'tsx', 'scripts/smoke.ts', PRODUCTION_ORIGIN, '--mainnet']);
  // Run the real default command against a stand-in scripts/smoke.ts with this repository's tsx.
  const cwd = temporaryDirectory(t, 'default-smoke');
  mkdirSync(join(cwd, 'scripts'));
  symlinkSync(fileURLToPath(new URL('node_modules', ROOT)), join(cwd, 'node_modules'));
  const log = join(cwd, 'calls.jsonl');
  writeFileSync(join(cwd, 'scripts', 'smoke.ts'), smokeScript(log, ACCEPTANCE_SUMMARY, 0));
  const acceptance = await runAcceptance({ cwd, env: { PATH: process.env.PATH, HOME: cwd, GITHUB_TOKEN: 'x', ...OIDC } });
  assert.equal(acceptance.passed, true, acceptance.error);
  assert.equal(acceptance.command, `node --import tsx scripts/smoke.ts ${PRODUCTION_ORIGIN} --mainnet`);
  const [call] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(call.argv, [PRODUCTION_ORIGIN, '--mainnet']);
  for (const key of ['GITHUB_TOKEN', ...Object.keys(OIDC)]) assert.equal(key in call.env, false);
});

async function preflightFixture(t: TestContext, options: { initial?: string[]; environment?: Record<string, unknown> | null;
  acceptance?: Record<string, unknown>; acceptanceExit?: number; validate?: string; fault?: Fault } = {}) {
  const repo = repositoryFixture(t);
  const registry = await registryFixture(t, options.initial, options.fault);
  const environment = await environmentFixture(t, options.environment === undefined ? {} : options.environment);
  const publisher = publisherFixture(t, { validate: options.validate ?? 'ok' });
  const acceptance = acceptanceFixture(t, options.acceptance, options.acceptanceExit);
  const outputDirectory = join(temporaryDirectory(t, 'preflight-evidence'), 'out');
  const run = (mode = 'preflight', changes: Record<string, unknown> = {}) => runPreflight({
    cwd: repo.cwd, version: VERSION, sourceRevision: repo.release, mode, context: CONTEXT(repo.head), outputDirectory,
    env: { PATH: process.env.PATH, HOME: repo.cwd, GITHUB_TOKEN: 'workflow-token', GODEBUG: 'http2debug=2', ...OIDC },
    publisher: publisher.path, registry: registry.url, api: environment.api, githubToken: 'workflow-token',
    acceptanceCommand: acceptance.command, timeouts: FAST, ...changes,
  });
  return { repo, registry, environment, publisher, acceptance, outputDirectory, run };
}

function assertPublicEvidence(file: string) {
  const text = readFileSync(file, 'utf8');
  for (const forbidden of ['workflow-token', 'request-token-secret', OIDC.ACTIONS_ID_TOKEN_REQUEST_URL, 'job-7f3a', 'eyJhbGci', 'http2debug', tmpdir()]) {
    assert.equal(text.includes(forbidden), false, `${file} must not contain ${forbidden}`);
  }
  return JSON.parse(text);
}

test('preflight validates, runs read-only acceptance and reports a publishable release', SLOW, async (t) => {
  const fixture = await preflightFixture(t);
  const evidence = await fixture.run('publish');
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.equal(evidence.outcome, 'awaiting-approval');
  assert.equal(evidence.decision, 'publish');
  assert.equal(evidence.source.serverJsonSha256, sha256(serverJson()));
  assert.deepEqual([evidence.source.mainRevision, evidence.source.releaseCommit], [fixture.repo.head, true]);
  assert.equal(evidence.registryState.exactVersion.state, 'absent');
  assert.equal(evidence.environment.passed, true);
  assert.deepEqual({ passed: evidence.acceptance.passed, requests: evidence.acceptance.requestsAttempted, servings: evidence.acceptance.servingRequestsAttempted },
    { passed: true, requests: 20, servings: 0 });
  assert.deepEqual(fixture.publisher.calls().map(call => call.command), ['validate']);
  for (const call of [...fixture.publisher.calls().map(call => call.env), ...fixture.acceptance.calls().map(call => call.env)]) {
    for (const key of ['GITHUB_TOKEN', 'GODEBUG', ...Object.keys(OIDC)]) assert.equal(key in call, false, `${key} leaked to a child`);
  }
  assert.equal(fixture.registry.publishes.length, 0);
  assert.equal(existsSync(join(fixture.outputDirectory, '.publisher-home')), false);
  assert.equal(assertPublicEvidence(join(fixture.outputDirectory, 'preflight.json')).outcome, 'awaiting-approval');
  const summary = renderSummary(evidence);
  assert.match(summary, /awaiting-approval/);
  assert.match(summary, /20\/21 requests, 0 servings/);
  const dryRun = await fixture.run('preflight');
  assert.equal(dryRun.outcome, 'ready-to-publish');
});

test('preflight treats an identical published version as a verified no-op without live checks', SLOW, async (t) => {
  const fixture = await preflightFixture(t, { initial: ['0.4.6', VERSION] });
  const evidence = await fixture.run('publish');
  assert.equal(evidence.outcome, 'already-published');
  assert.equal(evidence.passed, true);
  assert.equal(fixture.publisher.calls().length, 0);
  assert.equal(fixture.acceptance.calls().length, 0);
  assert.equal(evidence.snapshot.artifact, `mcp-registry-${VERSION}.json`);
  const snapshot = readFileSync(join(fixture.outputDirectory, evidence.snapshot.artifact));
  assert.equal(sha256(snapshot), evidence.snapshot.snapshotFileSha256);
  assert.ok(fixture.registry.reads.some(read => read.endsWith(`/versions/${VERSION}?include_deleted=true`)));
});

test('preflight fails closed on unprotected approval, conflicts, ambiguity, failed validation or acceptance', SLOW, async (t) => {
  const unprotected = await preflightFixture(t, { environment: null });
  const missing = await unprotected.run('publish');
  assert.equal(missing.error.code, 'environment');
  assert.equal(unprotected.registry.reads.length, 0);
  assert.equal((await unprotected.run('preflight')).outcome, 'ready-to-publish', 'dry runs report the missing gate without failing');

  const conflicting = await preflightFixture(t);
  conflicting.registry.add(JSON.parse(serverJson(VERSION, { description: 'Different metadata.' })));
  assert.equal((await conflicting.run()).error.code, 'registry-conflict');

  // A deleted version is hidden without include_deleted but still blocks reuse.
  const deleted = await preflightFixture(t);
  deleted.registry.add(JSON.parse(serverJson(VERSION)), 'deleted');
  assert.match((await deleted.run()).error.message, /status deleted/);

  const newer = await preflightFixture(t, { initial: ['0.4.6', '0.5.0'] });
  assert.equal((await newer.run()).error.code, 'registry-not-latest');

  // A deleted higher version is visible only with include_deleted, and could be restored as latest.
  const restorable = await preflightFixture(t, { initial: ['0.4.6', '1.0.0'] });
  restorable.registry.setStatus('1.0.0', 'deleted');
  const hiddenHigher = await restorable.run();
  assert.equal(hiddenHigher.error.code, 'registry-not-latest');
  assert.match(hiddenHigher.error.message, /1.0.0 \(status deleted\)/);

  const moved = await preflightFixture(t);
  moved.repo.advanceMain({ 'server.json': serverJson(VERSION, { description: 'Changed after review.' }) });
  const stale = await moved.run();
  assert.deepEqual([stale.error.code, moved.registry.reads.length], ['source', 0]);

  const edited = await preflightFixture(t);
  writeFileSync(join(edited.repo.cwd, 'server.json'), serverJson(VERSION, { description: 'Edited in the checkout.' }));
  const worktree = await edited.run();
  assert.deepEqual([worktree.error.code, edited.registry.reads.length, edited.publisher.calls().length], ['source', 0, 0]);

  // Only the registry's typed 404 proves absence; routing, gateway and changed 404s are inconclusive.
  const prefix = `/v0.1/servers/${encodeURIComponent(SERVER_NAME)}/versions`;
  for (const [path, respond] of [
    [`${prefix}/${VERSION}`, (res: ServerResponse) => res.writeHead(503).end()],
    [`${prefix}/${VERSION}`, (res: ServerResponse) => sendJson(res, 404, { detail: 'Endpoint not found. See /docs for the API documentation.' })],
    [`${prefix}/${VERSION}`, (res: ServerResponse) => sendJson(res, 404, { title: 'Not Found', status: 404, detail: 'Gone' }, 'application/problem+json')],
    [`${prefix}/${VERSION}`, (res: ServerResponse) => res.writeHead(404, { 'content-type': 'text/html' }).end('<html>not found</html>')],
    [`${prefix}/${VERSION}`, (res: ServerResponse) => sendJson(res, 404, { detail: 'Server not found' })],
    [`${prefix}/latest`, (res: ServerResponse) => sendJson(res, 404, { detail: 'Server not found' })],
    [prefix, (res: ServerResponse) => res.writeHead(404, { 'content-type': 'text/html' }).end('<html>not found</html>')],
  ] as const) {
    const inconclusive = await preflightFixture(t, { fault: (_req, res, requested) => {
      if (requested !== path) return false;
      respond(res);
      return true;
    } });
    const evidence = await inconclusive.run();
    assert.equal(evidence.error.code, 'registry-uncertain', `${path} ${evidence.error.message}`);
    assert.equal(inconclusive.publisher.calls().length, 0);
  }

  const invalid = await preflightFixture(t, { validate: 'fail' });
  assert.equal((await invalid.run()).error.code, 'validation');
  assert.equal(invalid.acceptance.calls().length, 0);

  for (const [acceptance, exitCode] of [
    [{ servingRequestsAttempted: 1 }, 0], [{ mode: 'serving' }, 0], [{ origin: 'https://example.invalid' }, 0],
    [{ budget: { maxRequests: 28, maxServingRequests: 7 } }, 0], [{ requestsAttempted: 22 }, 0], [{ requestsAttempted: 20.5 }, 0],
    [{ servingChecks: 'passed' }, 0], [{ network: 'testnet' }, 0], [{ passed: false }, 0],
    [{ passed: false, error: 'GET /healthz: expected HTTP 200, received 503' }, 1],
  ] as const) {
    const failed = await preflightFixture(t, { acceptance, acceptanceExit: exitCode });
    const evidence = await failed.run();
    assert.equal(evidence.error.code, 'acceptance', JSON.stringify(acceptance));
    assert.equal(evidence.acceptance.passed, false);
  }
});

async function publicationFixture(t: TestContext, options: { behavior?: Record<string, string>; initial?: string[]; health?: Record<string, unknown>;
  fault?: Fault } = {}) {
  const repo = repositoryFixture(t);
  const registry = await registryFixture(t, options.initial, options.fault);
  const live = await deploymentFixture(t, options.health);
  const publisher = publisherFixture(t, options.behavior);
  const workspace = temporaryDirectory(t, 'publication');
  const home = join(workspace, 'mcp-publisher-home');
  const outputDirectory = join(workspace, 'evidence');
  const run = (changes: Record<string, unknown> = {}) => runPublication({
    cwd: repo.cwd, version: VERSION, sourceRevision: repo.release, expectedSha256: sha256(serverJson()), context: CONTEXT(repo.head),
    outputDirectory, env: { PATH: process.env.PATH, GODEBUG: 'http2debug=2', GITHUB_TOKEN: 'workflow-token', ...OIDC },
    publisher: publisher.path, home, registry: registry.url, origin: live.origin, timeouts: FAST, sleep: async () => {}, ...changes,
  });
  return { repo, registry, live, publisher, workspace, home, outputDirectory, run };
}

test('publication logs in with OIDC once, publishes once, logs out and verifies exact and latest', SLOW, async (t) => {
  const fixture = await publicationFixture(t);
  const evidence = await fixture.run();
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.equal(evidence.outcome, 'published');
  assert.equal(evidence.reconciled, false);
  assert.deepEqual(fixture.publisher.calls().map(call => call.command), ['login', 'publish', 'logout']);
  const [login, publish, logout] = fixture.publisher.calls();
  assert.deepEqual(login.args, ['github-oidc', `--registry=${fixture.registry.url}`]);
  assert.equal(login.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, OIDC.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  for (const call of [login, publish, logout]) {
    assert.equal(call.env.HOME, fixture.home);
    for (const key of ['GODEBUG', 'GITHUB_TOKEN']) assert.equal(key in call.env, false);
  }
  for (const call of [publish, logout]) for (const key of Object.keys(OIDC)) assert.equal(key in call.env, false);
  assert.deepEqual(publish.args, [join(fixture.repo.cwd, 'server.json')]);
  assert.equal(fixture.registry.publishes.length, 1);
  assert.deepEqual(JSON.parse(fixture.registry.publishes[0].body), JSON.parse(serverJson()));
  assert.equal(existsSync(fixture.home), false);
  assert.equal(evidence.logout.tokenRemoved, true);
  assert.deepEqual(fixture.live.requests, ['GET /healthz', 'GET /mcp/server-card']);
  assert.equal(evidence.verification.exactVersion.isLatest, true);
  assert.equal(evidence.verification.latest.version, VERSION);
  assert.equal(evidence.precheck.exactVersion.state, 'absent');
  const saved = assertPublicEvidence(join(fixture.outputDirectory, 'publication.json'));
  assert.equal(saved.source.serverJsonSha256, sha256(serverJson()));
  const snapshot = readFileSync(join(fixture.outputDirectory, `mcp-registry-${VERSION}.json`));
  assert.equal(sha256(snapshot), evidence.snapshot.snapshotFileSha256);
  assert.match(renderSummary(evidence), /exact and latest active and identical/);
});

test('publication stops before login when rechecks fail or the release is already published', SLOW, async (t) => {
  const raced = await publicationFixture(t);
  raced.registry.add(JSON.parse(serverJson()));
  const noOp = await raced.run();
  assert.deepEqual([noOp.outcome, noOp.passed], ['already-published', true]);
  assert.equal(raced.publisher.calls().length, 0);

  const changed = await publicationFixture(t);
  const digest = await changed.run({ expectedSha256: 'f'.repeat(64) });
  assert.deepEqual([digest.outcome, digest.error.code], ['not-published', 'source']);
  assert.equal(changed.registry.reads.length, 0);

  const moved = await publicationFixture(t);
  moved.repo.advanceMain({ 'server.json': serverJson(VERSION, { description: 'Changed during approval.' }) });
  const stale = await moved.run();
  assert.deepEqual([stale.outcome, stale.error.code, moved.registry.reads.length], ['not-published', 'source', 0]);

  const edited = await publicationFixture(t);
  writeFileSync(join(edited.repo.cwd, 'server.json'), serverJson(VERSION, { description: 'Edited in the checkout.' }));
  const worktree = await edited.run({ expectedSha256: sha256(serverJson(VERSION, { description: 'Edited in the checkout.' })) });
  assert.deepEqual([worktree.error.code, edited.registry.reads.length, edited.publisher.calls().length], ['source', 0, 0]);

  const rolledBack = await publicationFixture(t, { health: { version: '0.4.6' } });
  const deployment = await rolledBack.run();
  assert.deepEqual([deployment.outcome, deployment.error.code], ['not-published', 'deployment']);
  assert.equal(rolledBack.publisher.calls().length, 0);

  // The recursive removal guard is exercised with harmless paths only.
  const unsafeHome = await publicationFixture(t);
  const canary = join(unsafeHome.workspace, 'not-a-home', 'canary');
  mkdirSync(join(unsafeHome.workspace, 'not-a-home'));
  writeFileSync(canary, 'keep');
  for (const home of [join(unsafeHome.workspace, 'not-a-home'), 'mcp-publisher-home', `${unsafeHome.workspace}/x/../mcp-publisher-home`]) {
    const refused = await unsafeHome.run({ home });
    assert.deepEqual([refused.outcome, refused.error.code], ['not-published', 'input']);
  }
  assert.equal(readFileSync(canary, 'utf8'), 'keep');
  assert.deepEqual([unsafeHome.publisher.calls().length, unsafeHome.registry.reads.length], [0, 0]);
});

test('failed login never publishes and still logs out', SLOW, async (t) => {
  const fixture = await publicationFixture(t, { behavior: { login: 'fail' } });
  const evidence = await fixture.run();
  assert.deepEqual([evidence.outcome, evidence.error.code, evidence.passed], ['not-published', 'login', false]);
  assert.deepEqual(fixture.publisher.calls().map(call => call.command), ['login', 'logout']);
  assert.equal(fixture.registry.publishes.length, 0);
  assert.match(evidence.login.message, /\[redacted-jwt\]/);
  assert.doesNotMatch(JSON.stringify(evidence), /eyJhbGci/);
});

test('an unreachable OIDC endpoint never leaks the job-scoped request URL into evidence', SLOW, async (t) => {
  const fixture = await publicationFixture(t, { behavior: { login: 'unreachable' } });
  const evidence = await fixture.run();
  assert.deepEqual([evidence.outcome, evidence.error.code], ['not-published', 'login']);
  assert.match(evidence.login.message, /failed to send request: Get "\[redacted\]&audience=/);
  assertPublicEvidence(join(fixture.outputDirectory, 'publication.json'));
});

test('a login that cannot be removed fails a verified publication without skipping verification',
  { ...SLOW, skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, async (t) => {
    const fixture = await publicationFixture(t, { behavior: { logout: 'stuck' } });
    const configuration = join(fixture.home, '.config', 'mcp-publisher');
    try {
      const evidence = await fixture.run();
      assert.deepEqual([evidence.outcome, evidence.passed, evidence.error.code, evidence.logout.tokenRemoved], ['published', false, 'cleanup', false]);
      assert.deepEqual(evidence.verification.problems, []);
    } finally {
      if (existsSync(configuration)) chmodSync(configuration, 0o700);
    }
  });

test('an unacknowledged publish is reconciled from read-only lookups, never retried', SLOW, async (t) => {
  const lost = await publicationFixture(t, { behavior: { publish: 'lost-response' } });
  const evidence = await lost.run();
  assert.deepEqual([evidence.outcome, evidence.passed, evidence.reconciled], ['published', true, true]);
  assert.equal(evidence.publication.passed, false);
  assert.equal(lost.registry.publishes.length, 1);

  const gateway = await publicationFixture(t);
  gateway.registry.onPublish((res, commit) => { commit(); res.writeHead(504, { 'content-type': 'text/html' }).end('<html>gateway timeout</html>'); });
  const committed = await gateway.run();
  assert.deepEqual([committed.outcome, committed.reconciled, committed.publication.httpStatus], ['published', true, 504]);
  assert.equal(gateway.registry.publishes.length, 1);

  // A record that becomes visible only on a later read is still verified by re-reading.
  let hidden = 0;
  const delayed = await publicationFixture(t, { fault: (req, res, path) => {
    if (req.method !== 'GET' || !path.endsWith(`/versions/${VERSION}`) || !delayed.registry.records.has(VERSION) || hidden++ > 0) return false;
    typed404(res);
    return true;
  } });
  const eventually = await delayed.run();
  assert.deepEqual([eventually.outcome, eventually.reconciled, eventually.verification.attempts], ['published', false, 2]);

  // An identical record that already existed makes this run a no-op, not a publication.
  const duplicate = await publicationFixture(t);
  duplicate.registry.onPublish((res, commit) => {
    commit();
    sendJson(res, 400, { title: 'Bad Request', status: 400, detail: 'Failed to publish server',
      errors: [{ message: 'invalid version: cannot publish duplicate version' }] }, 'application/problem+json');
  });
  const preExisting = await duplicate.run();
  assert.deepEqual([preExisting.outcome, preExisting.passed, preExisting.publication.httpStatus], ['already-published', true, 400]);
});

test('publish failures without a verified record are classified for safe recovery', SLOW, async (t) => {
  for (const [status, respond] of [
    [403, (res: ServerResponse) => sendJson(res, 403, { detail: 'You do not have permission to publish this server' }, 'application/problem+json')],
    [422, (res: ServerResponse) => sendJson(res, 422, { detail: 'Failed to publish server, invalid schema' }, 'application/problem+json')],
  ] as const) {
    const rejected = await publicationFixture(t);
    rejected.registry.onPublish(res => respond(res));
    const deterministic = await rejected.run();
    assert.deepEqual([deterministic.outcome, deterministic.error.code, deterministic.publication.httpStatus], ['not-published', 'not-published', status]);
    assert.equal(deterministic.verification.attempts, FAST.verifyAttempts);
  }

  const unavailable = await publicationFixture(t);
  unavailable.registry.onPublish(res => res.writeHead(503).end());
  const ambiguous = await unavailable.run();
  assert.deepEqual([ambiguous.outcome, ambiguous.error.code, ambiguous.publication.httpStatus], ['uncertain', 'uncertain', 503]);
  assert.equal(unavailable.registry.publishes.length, 1);

  // A 4xx with a record that exists but is not the verified latest must not be called not-published.
  const partial = await publicationFixture(t);
  partial.registry.onPublish((res, commit) => {
    commit();
    partial.registry.publish(JSON.parse(serverJson('0.5.0')));
    sendJson(res, 400, { detail: 'Failed to publish server', errors: [{ message: 'failed to commit transaction' }] }, 'application/problem+json');
  });
  assert.deepEqual([(await partial.run()).outcome], ['uncertain']);

  const hanging = await publicationFixture(t, { behavior: { publish: 'hang' } });
  const timedOut = await hanging.run();
  assert.deepEqual([timedOut.outcome, timedOut.publication.timedOut], ['uncertain', true]);
  assert.deepEqual(hanging.publisher.calls().map(call => call.command), ['login', 'publish', 'logout']);
  assert.equal(existsSync(hanging.home), false);

  // An unexpected failure after the publish attempt is uncertain, and keeps no local paths.
  const crashing = await publicationFixture(t, { fault: (req, res, path) => {
    if (req.method !== 'GET' || !path.endsWith(`/versions/${VERSION}`) || !crashing.registry.records.has(VERSION)) return false;
    typed404(res);
    return true;
  } });
  const interrupted = await crashing.run({ sleep: async () => { throw Object.assign(new Error(`EIO at ${crashing.workspace}`), { code: 'EIO' }); } });
  assert.deepEqual([interrupted.outcome, interrupted.error], ['uncertain', { code: 'internal', message: 'EIO' }]);
  assertPublicEvidence(join(crashing.outputDirectory, 'publication.json'));
});

test('different metadata appearing after publication is reported as a conflict', SLOW, async (t) => {
  const fixture = await publicationFixture(t);
  fixture.registry.onPublish((res, commit) => {
    commit();
    fixture.registry.records.get(VERSION)!.server = JSON.parse(serverJson(VERSION, { description: 'Someone else published this.' }));
    res.writeHead(502).end();
  });
  const evidence = await fixture.run();
  assert.deepEqual([evidence.outcome, evidence.error.code, evidence.passed], ['conflict', 'registry-conflict', false]);
});

const INSTALLER = fileURLToPath(new URL('scripts/install-mcp-publisher.sh', ROOT));

test('the installer and evidence share one publisher pin', () => {
  const text = readFileSync(INSTALLER, 'utf8');
  const pinned = (name: string) => new RegExp(`^${name}=([A-Za-z0-9_.-]+)$`, 'm').exec(text)?.[1];
  assert.deepEqual({ version: pinned('version'), commit: pinned('commit'), asset: pinned('asset'),
    archiveSha256: pinned('archive_sha256'), binarySha256: pinned('binary_sha256') }, { ...PUBLISHER });
});

test('the installer downloads only the pinned HTTPS release and refuses a mismatched archive',
  { ...SLOW, skip: process.platform !== 'linux' || process.arch !== 'x64' }, (t) => {
    const directory = temporaryDirectory(t, 'installer');
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > ${JSON.stringify(join(directory, 'curl-args'))}
while [ $# -gt 0 ]; do if [ "$1" = --output ]; then printf tampered > "$2"; fi; shift; done
`);
    chmodSync(join(bin, 'curl'), 0o755);
    const result = spawnSync('bash', [INSTALLER, join(directory, 'tool')], { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the pinned SHA-256; nothing was extracted/);
    assert.equal(existsSync(join(directory, 'tool', 'mcp-publisher')), false);
    assert.equal(existsSync(join(directory, 'tool', PUBLISHER.asset)), false);
    const args = readFileSync(join(directory, 'curl-args'), 'utf8').trim().split('\n');
    assert.equal(args.at(-1), `https://github.com/modelcontextprotocol/registry/releases/download/v${PUBLISHER.version}/${PUBLISHER.asset}`);
    for (const [flag, value] of [['--proto', '=https'], ['--proto-redir', '=https']]) assert.equal(args[args.indexOf(flag) + 1], value);
    assert.ok(args.includes('--fail'));
  });

test('the installer probes the publisher version without inherited tokens or OIDC variables',
  { ...SLOW, skip: process.platform !== 'linux' || process.arch !== 'x64' }, (t) => {
    // Digest checks are shimmed here; the mismatch test above covers them against real sha256sum.
    const directory = temporaryDirectory(t, 'installer-probe');
    const [bin, payload] = [join(directory, 'bin'), join(directory, 'payload')];
    mkdirSync(bin);
    mkdirSync(payload);
    const log = join(directory, 'probe-env');
    writeFileSync(join(payload, 'mcp-publisher'), `#!/bin/sh\nenv > ${JSON.stringify(log)}\n`
      + `echo "2026/09/22 00:00:00 mcp-publisher ${PUBLISHER.version} (commit: ${PUBLISHER.commit}, built: fixture)" >&2\n`);
    chmodSync(join(payload, 'mcp-publisher'), 0o755);
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = --output ]; then tar -czf "$2" -C ${JSON.stringify(payload)} mcp-publisher; fi; shift; done\n`);
    writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\ncat > /dev/null\n');
    for (const name of ['curl', 'sha256sum']) chmodSync(join(bin, name), 0o755);
    const result = spawnSync('bash', [INSTALLER, join(directory, 'tool')], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory, GITHUB_TOKEN: 'workflow-token', GODEBUG: 'http2debug=2', ...OIDC }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const environment = readFileSync(log, 'utf8');
    for (const forbidden of ['workflow-token', 'http2debug', ...Object.keys(OIDC)]) assert.equal(environment.includes(forbidden), false, forbidden);
    assert.match(environment, new RegExp(`^HOME=${join(directory, 'tool')}$`, 'm'));
  });

/** Minimal structural reads of the workflow text; the project has no YAML parser dependency. */
function workflowJobs() {
  const text = readFileSync(new URL(WORKFLOW_FILE, ROOT), 'utf8');
  const jobs = Object.fromEntries(text.split(/^ {2}(?=[a-z][a-z-]*:\n)/m).slice(1).map(block => [block.slice(0, block.indexOf(':')), block]));
  return { text, jobs };
}

/** Lines of every step's `run:` value, including `- run:` steps and blank lines inside block scalars. */
function runBlocks(text: string) {
  const lines = text.split('\n');
  const blocks: { line: number; text: string }[][] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(- )?run:/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length + (match[2] ? 2 : 0);
    const block = [{ line: index + 1, text: lines[index] }];
    for (let next = index + 1; next < lines.length && (!lines[next].trim() || lines[next].search(/\S/) > indent); next++) {
      block.push({ line: next + 1, text: lines[next] });
    }
    blocks.push(block);
  }
  return blocks;
}

test('the run-block scan covers list-item steps and blank lines', () => {
  const blocks = runBlocks('steps:\n  - run: echo ${{ inputs.a }}\n  - name: x\n    run: |\n      one\n\n      ${{ inputs.b }}\n    env:\n      A: b\n');
  assert.deepEqual(blocks.map(block => block.filter(line => line.text.includes('${{')).map(line => line.line)), [[2], [7]]);
});

test('the publication workflow is manual, pinned, least-privilege and approval gated', () => {
  const { text, jobs } = workflowJobs();
  assert.deepEqual(Object.keys(jobs), ['preflight', 'publish']);
  assert.match(text, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(text, /^\s+(push|pull_request|pull_request_target|schedule|release|workflow_run|repository_dispatch):/m);
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /^concurrency:\n {2}group: mcp-registry-publication\n {2}cancel-in-progress: false$/m);
  assert.match(jobs.preflight, /permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}actions: read\n {4}outputs:/);
  assert.match(jobs.publish, /permissions:\n {6}contents: read\n {6}id-token: write\n {4}steps:/);
  assert.equal(text.match(/id-token: write/g)?.length, 1);
  assert.doesNotMatch(jobs.preflight, /environment:/);
  assert.match(jobs.publish, /\n {4}environment: mcp-registry-publish\n/);
  assert.match(jobs.publish, /needs: preflight/);
  assert.match(jobs.publish, /inputs\.mode == 'publish' && needs\.preflight\.outputs\.decision == 'publish'/);
  for (const job of Object.values(jobs)) assert.match(job, /github\.repository == 'manifest-network\/merovingian' && github\.ref == 'refs\/heads\/main'/);
  // Every step of the OIDC-capable job can mint tokens: only these pinned first-party actions, no packages or caches.
  const publishCode = jobs.publish.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(publishCode, /\bnpm\b|\bnpx\b|^\s+cache:|include-hidden-files/m);
  assert.match(jobs.publish, /package-manager-cache: false/);
  assert.deepEqual([...publishCode.matchAll(/uses: ([^@\s]+)@/g)].map(match => match[1]),
    ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']);
  assert.match(jobs.publish, /Remove any registry login\n {8}if: always\(\)/);
  for (const [, reference] of text.matchAll(/uses: (\S+)/g)) assert.match(reference, /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
  assert.equal(text.match(/persist-credentials: false/g)?.length, 2);
  assert.equal(text.match(/uses: actions\/checkout@/g)?.length, 2);
  // Expressions never reach a shell script; inputs travel through env.
  const blocks = runBlocks(text);
  assert.ok(blocks.length >= 6);
  for (const line of blocks.flat()) assert.doesNotMatch(line.text, /\$\{\{/, `expression inside run block at line ${line.line}`);
  assert.match(text, /options:\n {10}- preflight\n {10}- publish/);
  assert.match(text, /default: preflight/);
  assert.match(text, /^run-name: MCP Registry \$\{\{ inputs\.mode \}\} \$\{\{ inputs\.version \}\}$/m);
});
