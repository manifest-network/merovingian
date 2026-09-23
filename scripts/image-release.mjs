import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import {
  PublicationError, REPOSITORY, checkDispatch, checkEnvironment, checkSource, childEnvironment,
  parseReleaseVersion, refreshMain, runGit, runProcess, sanitizeMessage,
} from './registry-publication.mjs';

// Dependency-free by design, like registry-publication.mjs: the approval-gated
// Publish job holds packages:write and id-token:write, so it runs Node built-ins,
// runner tools and SHA-pinned first-party actions only. Docker, git, fetch, clock
// and sleep are parameters for isolated tests; the CLI hardcodes production.

export const WORKFLOW_FILE = '.github/workflows/release-image.yml';
export const ENVIRONMENT = 'image-release';
export const REGISTRY_HOST = 'ghcr.io';
export const IMAGE_NAME = 'manifest-network/merovingian';
export const IMAGE = `${REGISTRY_HOST}/${IMAGE_NAME}`;
export const DOCKER_HOST = 'unix:///var/run/docker.sock';
export const SOURCE_URL = `https://github.com/${REPOSITORY}`;
export const PLATFORM = Object.freeze({ os: 'linux', architecture: 'amd64' });

export const DEFAULT_TIMEOUTS = Object.freeze({
  requestMs: 15_000, layerMs: 300_000, dockerMs: 60_000, saveMs: 600_000, loadMs: 600_000, pushMs: 900_000,
  verifyAttempts: 4, verifyIntervalMs: 5_000,
});

const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const USER_AGENT = 'merovingian-image-release (+https://github.com/manifest-network/merovingian)';
const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const GZIP_LAYERS = ['application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar.gzip'];
const TAR_LAYERS = ['application/vnd.oci.image.layer.v1.tar'];
const ARCHIVE_NAME = 'image.tar';

function fail(code, message) {
  throw new PublicationError(code, message);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** One bounded request that never follows redirects or throws. Credentials only
 * travel in an explicit header, and only to the registry host itself. */
export async function request(url, { fetch: fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUTS.requestMs, method = 'GET', headers = {}, maxBytes = 262_144 } = {}) {
  try {
    const response = await fetchImpl(url, {
      method, headers: { 'user-agent': USER_AGENT, ...headers },
      redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
    });
    const result = {
      status: response.status, contentType: response.headers.get('content-type') || '',
      digest: response.headers.get('docker-content-digest'), location: response.headers.get('location'),
      contentLength: response.headers.get('content-length'),
    };
    if (method === 'HEAD' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      return result;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > maxBytes) return { ...result, problem: 'response too large' };
      chunks.push(chunk);
    }
    return { ...result, bytes: Buffer.concat(chunks) };
  } catch (error) {
    return { status: 0, problem: error?.name === 'TimeoutError' ? 'request timed out' : 'transport failed' };
  }
}

const parseJson = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; } };
const httpProblem = response => response.problem || `HTTP ${response.status}`;

/** Anonymous pull token: the package must be public for the provider to pull it. */
export async function anonymousToken({ registry, fetch: fetchImpl, timeoutMs }) {
  const url = `${registry}/token?scope=${encodeURIComponent(`repository:${IMAGE_NAME}:pull`)}&service=${REGISTRY_HOST}`;
  const response = await request(url, { fetch: fetchImpl, timeoutMs, headers: { accept: 'application/json' }, maxBytes: 16_384 });
  const token = response.status === 200 && response.bytes ? parseJson(response.bytes)?.token : undefined;
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(token)) {
    return { problem: `anonymous pull token unavailable (${httpProblem(response)})` };
  }
  return { token };
}

/** Describe one manifest response. A tag must name a single linux/amd64 image manifest. */
export function describeManifest(response) {
  const digest = `sha256:${sha256(response.bytes)}`;
  if (response.digest && response.digest !== digest) return { problem: 'Docker-Content-Digest differs from the manifest bytes' };
  const manifest = parseJson(response.bytes);
  const mediaType = manifest?.mediaType ?? response.contentType.split(';')[0].trim();
  if (INDEX_TYPES.includes(mediaType) || Array.isArray(manifest?.manifests)) return { digest, mediaType, problem: 'tag names an index, not a single image manifest' };
  if (!MANIFEST_TYPES.includes(mediaType) || manifest?.schemaVersion !== 2) return { digest, mediaType, problem: 'unsupported manifest media type' };
  const config = manifest.config;
  const layers = manifest.layers;
  if (!isObject(config) || !DIGEST_PATTERN.test(config.digest) || !Number.isSafeInteger(config.size) || config.size <= 0
    || !Array.isArray(layers) || !layers.length
    || !layers.every(layer => isObject(layer) && DIGEST_PATTERN.test(layer.digest) && Number.isSafeInteger(layer.size) && layer.size >= 0
      && typeof layer.mediaType === 'string')) {
    return { digest, mediaType, problem: 'manifest config or layers are malformed' };
  }
  return { digest, mediaType, config: { digest: config.digest, size: config.size },
    layers: layers.map(({ digest: layerDigest, size, mediaType: layerType }) => ({ digest: layerDigest, size, mediaType: layerType })) };
}

/** Read one tag anonymously. Only a typed MANIFEST_UNKNOWN 404 proves absence. Never throws. */
export async function lookupTag({ registry, reference, fetch: fetchImpl, timeoutMs, clock = () => new Date(), token }) {
  const result = { reference, observedAt: clock().toISOString(), state: 'error' };
  const auth = token ? { token } : await anonymousToken({ registry, fetch: fetchImpl, timeoutMs });
  if (auth.problem) return { ...result, problem: auth.problem };
  const response = await request(`${registry}/v2/${IMAGE_NAME}/manifests/${reference}`, {
    fetch: fetchImpl, timeoutMs, maxBytes: 65_536,
    headers: { accept: [...MANIFEST_TYPES, ...INDEX_TYPES].join(', '), authorization: `Bearer ${auth.token}` },
  });
  result.observedAt = clock().toISOString();
  result.httpStatus = response.status;
  if (response.status === 404) {
    const errors = response.bytes ? parseJson(response.bytes)?.errors : undefined;
    if (Array.isArray(errors) && errors.some(error => error?.code === 'MANIFEST_UNKNOWN')) return { ...result, state: 'absent' };
    return { ...result, problem: 'untyped 404 response' };
  }
  if (response.status !== 200 || !response.bytes) return { ...result, problem: `unexpected manifest response (${httpProblem(response)})` };
  const manifest = describeManifest(response);
  if (manifest.problem) return { ...result, ...manifest };
  return { ...result, state: 'present', ...manifest };
}

/** Before a push: absent publishes; the same verified config is an idempotent re-run; anything else refuses. */
export function decidePush(tag, configDigest) {
  if (tag.state === 'absent') return 'push';
  if (tag.state === 'present' && tag.config?.digest === configDigest) return 'already-published';
  if (tag.state === 'present') fail('tag-conflict', 'The release tag already names a different image; published tags are never replaced');
  return fail('registry', `The release tag state is unknown (${tag.problem ?? 'error'}); nothing was pushed`);
}

/** Fetch the config blob anonymously; follow at most one redirect, without credentials. */
async function readConfig({ registry, token, digest, fetch: fetchImpl, timeoutMs }) {
  let response = await request(`${registry}/v2/${IMAGE_NAME}/blobs/${digest}`, {
    fetch: fetchImpl, timeoutMs, maxBytes: 1_048_576, headers: { authorization: `Bearer ${token}` } });
  if (response.status >= 300 && response.status < 400 && /^https:\/\//.test(response.location ?? '')) {
    response = await request(response.location, { fetch: fetchImpl, timeoutMs, maxBytes: 1_048_576 });
  }
  if (response.status !== 200 || !response.bytes) return { problem: `config blob unavailable (${httpProblem(response)})` };
  if (`sha256:${sha256(response.bytes)}` !== digest) return { problem: 'config blob bytes differ from their digest' };
  return { config: parseJson(response.bytes) };
}

/**
 * Stream one layer anonymously, following at most one HTTPS redirect without
 * credentials. Its bytes must match the manifest digest and size, and its
 * uncompressed content the configuration's diff ID. Returns a problem or null.
 */
async function verifyLayer({ registry, token, layer, diffId, fetch: fetchImpl = fetch, timeoutMs }) {
  if (![...GZIP_LAYERS, ...TAR_LAYERS].includes(layer.mediaType)) return 'unsupported layer media type';
  const signal = AbortSignal.timeout(timeoutMs);
  const get = (url, headers = {}) => fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'manual', cache: 'no-store', credentials: 'omit', signal });
  let oversized = false;
  try {
    let response = await get(`${registry}/v2/${IMAGE_NAME}/blobs/${layer.digest}`, { authorization: `Bearer ${token}` });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!/^https:\/\//.test(location ?? '')) return 'layer redirect is not HTTPS';
      response = await get(location);
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return `layer unavailable (HTTP ${response.status})`;
    }
    const compressed = createHash('sha256');
    const content = createHash('sha256');
    let size = 0;
    const measure = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > layer.size) { oversized = true; return callback(new Error('oversized')); }
      compressed.update(chunk);
      return callback(null, chunk);
    } });
    const sink = new Writable({ write(chunk, _encoding, callback) { content.update(chunk); callback(); } });
    await pipeline(Readable.fromWeb(response.body), measure, ...(GZIP_LAYERS.includes(layer.mediaType) ? [createGunzip()] : []), sink);
    if (size !== layer.size) return 'layer size differs from the manifest';
    if (`sha256:${compressed.digest('hex')}` !== layer.digest) return 'layer bytes differ from their digest';
    if (`sha256:${content.digest('hex')}` !== diffId) return 'layer content differs from the configuration diff ID';
    return null;
  } catch (error) {
    if (oversized) return 'layer size differs from the manifest';
    return error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'layer download timed out' : 'layer could not be read or decompressed';
  }
}

/**
 * Anonymous proof that the published tag serves exactly the verified image: tag,
 * digest reference, configuration bytes and platform, and every layer's bytes and
 * uncompressed content against the configuration's diff IDs. Never throws.
 */
export async function verifyPublished({ registry, version, digest, configDigest, fetch: fetchImpl, timeoutMs,
  layerTimeoutMs = DEFAULT_TIMEOUTS.layerMs, clock = () => new Date() }) {
  const result = { checkedAt: clock().toISOString(), reference: `${IMAGE}:${version}`, passed: false, problems: [] };
  const auth = await anonymousToken({ registry, fetch: fetchImpl, timeoutMs });
  if (auth.problem) return { ...result, problems: [auth.problem] };
  if (!DIGEST_PATTERN.test(digest ?? '')) return { ...result, problems: ['no pushed digest to verify'] };
  const tag = await lookupTag({ registry, reference: version, fetch: fetchImpl, timeoutMs, clock, token: auth.token });
  const byDigest = await lookupTag({ registry, reference: digest, fetch: fetchImpl, timeoutMs, clock, token: auth.token });
  Object.assign(result, { tagDigest: tag.digest ?? null, manifestDigest: byDigest.digest ?? null, mediaType: tag.mediaType ?? null,
    configDigest: tag.config?.digest ?? null });
  if (tag.state !== 'present') result.problems.push(`tag is not a readable single image manifest (${tag.problem ?? tag.state})`);
  if (byDigest.state !== 'present') result.problems.push(`digest reference is not readable (${byDigest.problem ?? byDigest.state})`);
  if (result.problems.length) return result;
  if (tag.digest !== digest) result.problems.push('tag does not resolve to the pushed digest');
  if (byDigest.digest !== tag.digest) result.problems.push('digest reference differs from the tag');
  if (tag.config.digest !== configDigest) result.problems.push('published configuration differs from the verified candidate');
  const config = await readConfig({ registry, token: auth.token, digest: tag.config.digest, fetch: fetchImpl, timeoutMs });
  result.anonymousConfigurationAccess = !config.problem;
  if (config.problem) {
    result.problems.push(config.problem);
    return result;
  }
  if (config.config?.os !== PLATFORM.os || config.config?.architecture !== PLATFORM.architecture) result.problems.push('published image is not linux/amd64');
  const diffIds = config.config?.rootfs?.type === 'layers' ? config.config.rootfs.diff_ids : undefined;
  if (!Array.isArray(diffIds) || diffIds.length !== tag.layers.length || !diffIds.every(id => DIGEST_PATTERN.test(id))) {
    result.problems.push('published layers do not match the configuration diff IDs');
    return result;
  }
  result.layers = [];
  for (const [index, layer] of tag.layers.entries()) {
    const problem = await verifyLayer({ registry, token: auth.token, layer, diffId: diffIds[index], fetch: fetchImpl, timeoutMs: layerTimeoutMs });
    result.layers.push({ ...layer, contentVerified: !problem });
    if (problem) result.problems.push(`layer ${layer.digest}: ${problem}`);
  }
  result.passed = result.problems.length === 0;
  return result;
}

/** Docker runs against the runner daemon with a private config directory and no tokens in its environment. */
export function dockerRunner({ env, home, configDirectory }) {
  return (args, { timeoutMs, input } = {}) => runProcess('docker', ['--host', DOCKER_HOST, ...args], {
    env: { ...childEnvironment(env, home), DOCKER_CONFIG: configDirectory }, timeoutMs, input, maxOutput: 262_144 });
}

const dockerMessage = result => sanitizeMessage(`${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).filter(Boolean).at(-1) || result.error || '', 300);

async function inspectImage(docker, imageId, timeoutMs) {
  const result = await docker(['image', 'inspect', imageId], { timeoutMs });
  const parsed = result.exitCode === 0 ? parseJson(Buffer.from(result.stdout)) : undefined;
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isObject(parsed[0])) fail('image', `The candidate image is not available locally (${dockerMessage(result)})`);
  return parsed[0];
}

/** The loaded or built image must be the verified linux/amd64 candidate for this exact source. */
export function checkImageIdentity(image, { imageId, version, sourceRevision }) {
  if (image.Id !== imageId) fail('image', 'The local image ID differs from the verified candidate');
  if (image.Os !== PLATFORM.os || image.Architecture !== PLATFORM.architecture) fail('image', 'The candidate is not linux/amd64');
  const labels = image.Config?.Labels ?? {};
  if (labels['org.opencontainers.image.revision'] !== sourceRevision || labels['org.opencontainers.image.version'] !== version
    || labels['org.opencontainers.image.source'] !== SOURCE_URL) {
    fail('image', 'The candidate labels do not name this source revision, version and repository');
  }
  return { imageId: image.Id, os: image.Os, architecture: image.Architecture,
    labels: { revision: sourceRevision, version, source: SOURCE_URL } };
}

function baseEvidence(stage, { version, sourceRevision, context }) {
  return {
    schemaVersion: 1, kind: 'image-release', stage, outcome: 'failed', passed: false, repository: IMAGE,
    version: typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ? version : null,
    source: { revision: typeof sourceRevision === 'string' && REVISION_PATTERN.test(sourceRevision) ? sourceRevision : null,
      workflowRevision: context?.workflowRevision ?? null },
    run: context?.run ?? null,
  };
}

// Unexpected errors keep only an errno-style code: their messages can contain local paths.
function recordError(evidence, error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'unexpected failure';
  evidence.error = error instanceof PublicationError
    ? { code: error.code, message: sanitizeMessage(error.message) }
    : { code: 'internal', message: code };
}

function checkSourceRevision(opts, evidence, requireCurrent = true) {
  const { cwd, version, sourceRevision, context } = opts;
  (opts.refreshMain ?? refreshMain)({ cwd, git: opts.git });
  const source = checkSource({ cwd, sourceRevision, workflowRevision: context.workflowRevision, version, git: opts.git, requireCurrent });
  evidence.source = { revision: source.revision, workflowRevision: source.workflowRevision, mainRevision: source.mainRevision,
    releaseCommit: source.releaseCommit };
  return source;
}

async function writeEvidence(outputDirectory, name, evidence) {
  await writeFile(join(outputDirectory, name), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
}

/**
 * Build job, before any source-revision code runs: trusted dispatch, a source
 * revision on the live main that declares this version, an absent release tag and,
 * for publish mode, a protected approval environment. Then check out the source.
 */
export async function runPreflight(options) {
  const opts = { registry: `https://${REGISTRY_HOST}`, clock: () => new Date(), git: runGit, ...options,
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts } };
  const { cwd, version, mode, outputDirectory, sourceDirectory } = opts;
  const evidence = baseEvidence('preflight', opts);
  evidence.mode = ['verify', 'publish'].includes(mode) ? mode : null;
  evidence.startedAt = opts.clock().toISOString();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  try {
    if (!evidence.mode) fail('input', 'Mode must be verify or publish');
    parseReleaseVersion(version);
    const source = checkSourceRevision(opts, evidence);
    evidence.environment = await checkEnvironment({ api: opts.api, token: opts.githubToken, fetch: opts.fetch,
      timeoutMs: opts.timeouts.requestMs, clock: opts.clock, environment: ENVIRONMENT });
    if (mode === 'publish' && !evidence.environment.passed) {
      fail('environment', `The ${ENVIRONMENT} approval environment is not protected: ${evidence.environment.problems.join('; ')}`);
    }
    evidence.tag = await lookupTag({ registry: opts.registry, reference: version, fetch: opts.fetch, timeoutMs: opts.timeouts.requestMs, clock: opts.clock });
    if (evidence.tag.state === 'present') fail('tag-exists', `${IMAGE}:${version} is already published; published tags are never replaced`);
    if (evidence.tag.state !== 'absent') fail('registry', `The release tag state is unknown (${evidence.tag.problem}); refusing to build a release`);
    if (typeof sourceDirectory !== 'string' || resolve(sourceDirectory) !== sourceDirectory || existsSync(sourceDirectory)) {
      fail('input', 'The source directory must be a new absolute path');
    }
    try { opts.git(cwd, ['worktree', 'add', '--detach', '--quiet', sourceDirectory, source.revision]); }
    catch { fail('source', 'Could not check out the source revision'); }
    evidence.decision = mode === 'publish' ? 'publish' : 'verify-only';
    evidence.outcome = 'source-ready';
    evidence.passed = true;
    return evidence;
  } catch (error) {
    recordError(evidence, error);
    return evidence;
  } finally {
    evidence.completedAt = opts.clock().toISOString();
    await writeEvidence(outputDirectory, 'preflight.json', evidence);
  }
}

async function readSlice(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) fail('archive', 'The candidate archive is truncated');
  return buffer;
}

/** Read selected small regular files from a tar archive without extracting it. */
export async function readTarFiles(path, wanted, { maxBytes = 1_048_576 } = {}) {
  const handle = await open(path, 'r');
  const found = new Map();
  try {
    const header = Buffer.alloc(512);
    let offset = 0;
    let longName = null;
    for (;;) {
      const { bytesRead } = await handle.read(header, 0, 512, offset);
      if (bytesRead < 512 || header.every(byte => byte === 0)) break;
      const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
      const sizeField = field(124, 12).trim();
      if (!/^[0-7]{1,11}$/.test(sizeField)) fail('archive', 'The candidate archive has a malformed tar header');
      const size = parseInt(sizeField, 8);
      const type = field(156, 1) || '0';
      // Only POSIX ustar headers carry a name prefix; GNU headers reuse those bytes.
      const ustar = header.subarray(257, 263).equals(Buffer.from('ustar\0', 'latin1'));
      const name = longName ?? (ustar && field(345, 155) ? `${field(345, 155)}/${field(0, 100)}` : field(0, 100));
      longName = null;
      const dataOffset = offset + 512;
      if (type === 'L') {
        if (size > 4_096) fail('archive', 'The candidate archive has an oversized long name');
        longName = (await readSlice(handle, dataOffset, size)).toString('utf8').replace(/\0[\s\S]*$/, '');
      } else if (type === '0' && wanted(name)) {
        if (size > maxBytes || found.has(name)) fail('archive', 'The candidate archive has an unexpected metadata entry');
        found.set(name, await readSlice(handle, dataOffset, size));
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }
  } finally {
    await handle.close();
  }
  return found;
}

/**
 * Derive the configuration digest from the saved bytes themselves. With Docker's
 * classic store the image ID is the configuration digest; with the containerd
 * store it is the digest of an OCI manifest that names that configuration.
 */
export async function archiveIdentity(path, { imageId, version, sourceRevision }) {
  const index = parseJson((await readTarFiles(path, name => name === 'manifest.json')).get('manifest.json') ?? Buffer.alloc(0));
  if (!Array.isArray(index) || index.length !== 1 || typeof index[0]?.Config !== 'string') {
    fail('archive', 'The candidate archive must contain exactly one image');
  }
  const configPath = index[0].Config;
  const manifestPath = `blobs/sha256/${imageId.slice('sha256:'.length)}`;
  const blobs = await readTarFiles(path, name => name === configPath || name === manifestPath);
  const configBytes = blobs.get(configPath);
  if (!configBytes) fail('archive', 'The candidate archive has no image configuration');
  const configDigest = `sha256:${sha256(configBytes)}`;
  if (configDigest !== imageId) {
    const manifest = blobs.get(manifestPath);
    if (!manifest || `sha256:${sha256(manifest)}` !== imageId || parseJson(manifest)?.config?.digest !== configDigest) {
      fail('archive', 'The saved archive does not contain the candidate image');
    }
  }
  const config = parseJson(configBytes);
  const labels = config?.config?.Labels ?? {};
  if (config?.os !== PLATFORM.os || config?.architecture !== PLATFORM.architecture
    || labels['org.opencontainers.image.revision'] !== sourceRevision || labels['org.opencontainers.image.version'] !== version
    || labels['org.opencontainers.image.source'] !== SOURCE_URL) {
    fail('archive', 'The saved configuration is not the labelled linux/amd64 image for this source');
  }
  return { configDigest };
}

/**
 * Build job, directly after the build and before any other code runs: bind the
 * built image to its saved bytes. Nothing from npm runs in this job, so the image
 * ID, configuration digest and archive SHA-256 recorded here are what Publish trusts.
 */
export async function runCandidate(options) {
  const opts = { clock: () => new Date(), ...options, timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts } };
  const { version, sourceRevision, outputDirectory, docker } = opts;
  const evidence = baseEvidence('candidate', opts);
  evidence.startedAt = opts.clock().toISOString();
  try {
    const preflight = parseJson(await readFile(join(outputDirectory, 'preflight.json')));
    if (preflight?.passed !== true || preflight.version !== version || preflight.source?.revision !== sourceRevision
      || !['publish', 'verify-only'].includes(preflight.decision)) {
      fail('input', 'The preflight for this version and source revision did not pass');
    }
    evidence.source = preflight.source;
    evidence.mode = preflight.mode;
    evidence.environment = preflight.environment;
    evidence.tag = preflight.tag;
    const imageId = (await readFile(opts.imageIdFile, 'utf8')).trim();
    if (!DIGEST_PATTERN.test(imageId)) fail('image', 'The build did not record an image ID');
    evidence.image = checkImageIdentity(await inspectImage(docker, imageId, opts.timeouts.dockerMs), { imageId, version, sourceRevision });
    const archive = join(outputDirectory, 'candidate', ARCHIVE_NAME);
    await mkdir(join(outputDirectory, 'candidate'), { recursive: true, mode: 0o700 });
    const saved = await docker(['image', 'save', '--output', archive, imageId], { timeoutMs: opts.timeouts.saveMs });
    if (saved.exitCode !== 0 || saved.timedOut) fail('image', `Could not save the candidate (${dockerMessage(saved)})`);
    evidence.image.configDigest = (await archiveIdentity(archive, { imageId, version, sourceRevision })).configDigest;
    evidence.archive = { name: ARCHIVE_NAME, sha256: await fileSha256(archive), bytes: (await stat(archive)).size };
    evidence.decision = preflight.decision;
    evidence.outcome = 'built';
    evidence.passed = true;
    return evidence;
  } catch (error) {
    recordError(evidence, error);
    return evidence;
  } finally {
    evidence.completedAt = opts.clock().toISOString();
    await writeEvidence(outputDirectory, 'candidate.json', evidence);
  }
}

/**
 * Check job: the runtime and advisory reports must describe the image that Build
 * recorded. This job runs the source revision's own npm code, so its result only
 * gates Publish; none of its values reach the published image or its digests.
 */
export async function runChecks(options) {
  const opts = { clock: () => new Date(), ...options };
  const { imageId, configDigest, outputDirectory } = opts;
  const evidence = baseEvidence('checks', opts);
  evidence.startedAt = opts.clock().toISOString();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  try {
    parseReleaseVersion(opts.version);
    if (!DIGEST_PATTERN.test(imageId ?? '') || !DIGEST_PATTERN.test(configDigest ?? '')) fail('input', 'The built image ID or configuration digest is malformed');
    evidence.image = { imageId, configDigest };
    const runtime = parseJson(await readFile(opts.runtimeReport));
    if (runtime?.passed !== true || runtime.imageId !== imageId) fail('runtime', 'Isolated runtime checks did not pass for this image');
    const policy = parseJson(await readFile(join(opts.scanDirectory, 'policy.json')));
    const provenance = parseJson(await readFile(join(opts.scanDirectory, 'scan-provenance.json')));
    if (policy?.passed !== true || !Array.isArray(policy.blocked) || policy.blocked.length
      || provenance?.localImageId !== imageId || provenance?.configurationDigest !== configDigest || policy.imageId !== configDigest) {
      fail('scan', 'The advisory policy did not pass for this image');
    }
    evidence.runtime = { checkedAt: runtime.checkedAt, passed: true, completedChecks: runtime.completedChecks,
      applicationFilesChecked: runtime.applicationFilesChecked, appArmor: runtime.appArmor?.status ?? null };
    evidence.scan = { checkedAt: policy.checkedAt, passed: true, scannerVersion: policy.scannerVersion, databaseUpdatedAt: policy.databaseUpdatedAt,
      blockedCount: 0, exceptionCount: Array.isArray(policy.accepted) ? policy.accepted.length : null,
      reported: Array.isArray(policy.reported) ? policy.reported : [] };
    evidence.outcome = 'checked';
    evidence.passed = true;
    return evidence;
  } catch (error) {
    recordError(evidence, error);
    return evidence;
  } finally {
    evidence.completedAt = opts.clock().toISOString();
    await writeEvidence(outputDirectory, 'checks.json', evidence);
  }
}

async function pollVerification(opts, digest) {
  let verification;
  for (let attempt = 1; attempt <= opts.timeouts.verifyAttempts; attempt++) {
    verification = await verifyPublished({ registry: opts.registry, version: opts.version, digest, configDigest: opts.configDigest,
      fetch: opts.fetch, timeoutMs: opts.timeouts.requestMs, layerTimeoutMs: opts.timeouts.layerMs, clock: opts.clock });
    verification.attempts = attempt;
    if (verification.passed) return verification;
    if (attempt < opts.timeouts.verifyAttempts) await opts.sleep(opts.timeouts.verifyIntervalMs);
  }
  return verification;
}

/**
 * Approval-gated publication of the verified bytes. Rechecks source and tag,
 * loads the archive whose SHA-256 the Build job recorded, pushes once with a
 * short-lived private login, always logs out, then verifies anonymously.
 */
export async function runPublication(options) {
  const opts = { registry: `https://${REGISTRY_HOST}`, clock: () => new Date(), sleep: delay, git: runGit, ...options,
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts } };
  const { version, outputDirectory, docker, imageId, configDigest, archiveSha256, sourceRevision } = opts;
  const evidence = baseEvidence('publish', opts);
  evidence.startedAt = opts.clock().toISOString();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  try {
    parseReleaseVersion(version);
    if (!DIGEST_PATTERN.test(imageId ?? '') || !DIGEST_PATTERN.test(configDigest ?? '') || !SHA256_PATTERN.test(archiveSha256 ?? '')) {
      fail('input', 'The verified image ID, configuration digest or archive SHA-256 is missing or malformed');
    }
    if (typeof opts.token !== 'string' || !opts.token || typeof opts.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/.test(opts.username)) {
      fail('input', 'The registry token or username is missing');
    }
    evidence.candidate = { imageId, configDigest, archiveSha256 };
    evidence.tagBefore = await lookupTag({ registry: opts.registry, reference: version, fetch: opts.fetch, timeoutMs: opts.timeouts.requestMs, clock: opts.clock });
    const decision = decidePush(evidence.tagBefore, configDigest);
    evidence.decision = decision;
    // A push must still be the current release on the live main. A re-run that only
    // verifies and attests an already published candidate needs the containment and
    // version checks, not main's current metadata, which the next release changes.
    checkSourceRevision(opts, evidence, decision === 'push');
    let digest = null;
    if (decision === 'push') {
      // The archive is only needed to push; an already-published re-run verifies and attests without it.
      if (typeof opts.archive !== 'string' || !existsSync(opts.archive)) {
        fail('archive', 'The verified candidate archive is unavailable (it expires 7 days after Build); dispatch again for a new candidate');
      }
      if (await fileSha256(opts.archive) !== archiveSha256) fail('archive', 'The downloaded candidate differs from the verified archive');
      const loaded = await docker(['image', 'load', '--quiet', '--input', opts.archive], { timeoutMs: opts.timeouts.loadMs });
      if (loaded.exitCode !== 0 || loaded.timedOut) fail('image', `Could not load the verified candidate (${dockerMessage(loaded)})`);
      evidence.image = checkImageIdentity(await inspectImage(docker, imageId, opts.timeouts.dockerMs), { imageId, version, sourceRevision });
      const reference = `${IMAGE}:${version}`;
      const tagged = await docker(['image', 'tag', imageId, reference], { timeoutMs: opts.timeouts.dockerMs });
      if (tagged.exitCode !== 0) fail('image', `Could not tag the candidate (${dockerMessage(tagged)})`);
      evidence.push = { attempted: false };
      try {
        const login = await docker(['login', REGISTRY_HOST, '--username', opts.username, '--password-stdin'],
          { timeoutMs: opts.timeouts.dockerMs, input: opts.token });
        if (login.exitCode !== 0 || login.timedOut) fail('login', `Registry login failed (${dockerMessage(login)}); nothing was pushed`);
        evidence.push.attempted = true;
        const pushed = await docker(['image', 'push', reference], { timeoutMs: opts.timeouts.pushMs });
        const reported = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.stdout)?.[1] ?? null;
        Object.assign(evidence.push, { exitCode: pushed.exitCode, timedOut: pushed.timedOut, reportedDigest: reported });
        if (pushed.exitCode === 0 && !pushed.timedOut && reported) digest = reported;
        else evidence.push.message = dockerMessage(pushed);
      } finally {
        const logout = await docker(['logout', REGISTRY_HOST], { timeoutMs: opts.timeouts.dockerMs });
        evidence.logout = { exitCode: logout.exitCode };
        await rm(opts.dockerConfigDirectory, { recursive: true, force: true });
      }
      // A failed or unacknowledged push is reconciled only from anonymous reads; it is never retried here.
      if (!digest) {
        const after = await lookupTag({ registry: opts.registry, reference: version, fetch: opts.fetch, timeoutMs: opts.timeouts.requestMs, clock: opts.clock });
        evidence.tagAfterFailedPush = after;
        if (after.state === 'present' && after.config?.digest === configDigest) digest = after.digest;
        else if (after.state === 'absent') fail('push', 'The push failed and the tag is absent; re-run this job to push the same verified candidate');
        else fail('push', 'The push outcome is unknown; reconcile the tag before any re-run');
      }
    } else {
      digest = evidence.tagBefore.digest;
    }
    evidence.verification = await pollVerification(opts, digest);
    if (!evidence.verification.passed) fail('verification', `The published image did not verify: ${evidence.verification.problems.join('; ')}`);
    evidence.digest = digest;
    evidence.reference = `${IMAGE}@${digest}`;
    evidence.outcome = decision === 'push' ? 'published' : 'already-published';
    evidence.passed = true;
    return evidence;
  } catch (error) {
    recordError(evidence, error);
    return evidence;
  } finally {
    evidence.completedAt = opts.clock().toISOString();
    await writeEvidence(outputDirectory, 'publication.json', evidence);
  }
}

const cell = value => sanitizeMessage(value ?? '—', 200).replaceAll('|', '\\|') || '—';

/** Public-safe Markdown for the Actions job summary; the approver reviews the candidate here. */
export function renderSummary(evidence) {
  const rows = [
    ['Outcome', `**${evidence.outcome}**`],
    ['Image', `${evidence.repository} ${evidence.version ?? '(invalid version)'}`],
    ['Source revision', evidence.source?.revision],
    ['Release commit', evidence.source?.releaseCommit === undefined ? undefined : String(evidence.source.releaseCommit)],
  ];
  if (evidence.environment) {
    rows.push(['Approval environment', evidence.environment.passed ? `${ENVIRONMENT}: protected, ${evidence.environment.reviewerCount} reviewer(s)`
      : `${ENVIRONMENT}: ${evidence.environment.problems.join('; ')}`]);
  }
  const tag = evidence.tag ?? evidence.tagBefore;
  if (tag) rows.push(['Tag before', `${tag.state}${tag.digest ? ` ${tag.digest}` : ''}`]);
  if (evidence.image?.imageId) rows.push(['Image ID', evidence.image.imageId]);
  if (evidence.image?.configDigest) rows.push(['Configuration digest', evidence.image.configDigest]);
  if (evidence.runtime) rows.push(['Runtime checks', `passed: ${evidence.runtime.completedChecks?.length ?? 0} checks`]);
  if (evidence.scan) rows.push(['Advisory policy', `passed: ${evidence.scan.blockedCount} blocked, ${evidence.scan.reported.length} reported`]);
  if (evidence.archive) rows.push(['Candidate archive SHA-256', evidence.archive.sha256]);
  if (evidence.candidate) rows.push(['Verified archive SHA-256', evidence.candidate.archiveSha256]);
  if (evidence.push) rows.push(['Push', evidence.push.attempted ? `exit ${evidence.push.exitCode ?? '—'}${evidence.push.timedOut ? ' (timed out)' : ''}` : 'not attempted']);
  if (evidence.verification) {
    rows.push(['Anonymous verification', evidence.verification.passed
      ? `tag, digest, configuration and the content of ${evidence.verification.layers.length} layers (attempt ${evidence.verification.attempts})`
      : evidence.verification.problems.join('; ')]);
  }
  if (evidence.reference) rows.push(['Published reference', evidence.reference]);
  if (evidence.error) rows.push(['Error', `${evidence.error.code}: ${evidence.error.message}`]);
  const table = rows.map(([name, value]) => `| ${name} | ${name === 'Outcome' ? value : cell(value)} |`).join('\n');
  return `### Image release ${evidence.stage}\n\n| Check | Result |\n| --- | --- |\n${table}\n`;
}

/** Job summary for every stage; step outputs only for a passing candidate or publication. */
export function writeActionsFiles(evidence, env) {
  let outputs;
  if (evidence.stage === 'candidate' && evidence.passed) {
    outputs = { decision: evidence.decision, image_id: evidence.image.imageId, config_digest: evidence.image.configDigest,
      archive_sha256: evidence.archive.sha256 };
  } else if (evidence.stage === 'publish' && evidence.passed) {
    outputs = { digest: evidence.digest };
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(evidence));
  if (env.GITHUB_OUTPUT && outputs) {
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
}

const USAGE = `Usage:
  node scripts/image-release.mjs preflight --version X.Y.Z --source-revision SHA --mode verify|publish --source-dir DIR --output-dir DIR
  node scripts/image-release.mjs candidate --version X.Y.Z --source-revision SHA --image-id-file FILE --output-dir DIR
  node scripts/image-release.mjs checks --version X.Y.Z --source-revision SHA --image-id ID --config-digest DIGEST --runtime-report FILE --scan-dir DIR --output-dir DIR
  node scripts/image-release.mjs publish --version X.Y.Z --source-revision SHA --image-id ID --config-digest DIGEST --archive-sha256 HEX --archive FILE --docker-config DIR --output-dir DIR`;

export function parseArgs(args) {
  const [command, ...rest] = args;
  const allowed = {
    preflight: ['--version', '--source-revision', '--mode', '--source-dir', '--output-dir'],
    candidate: ['--version', '--source-revision', '--image-id-file', '--output-dir'],
    checks: ['--version', '--source-revision', '--image-id', '--config-digest', '--runtime-report', '--scan-dir', '--output-dir'],
    publish: ['--version', '--source-revision', '--image-id', '--config-digest', '--archive-sha256', '--archive', '--docker-config', '--output-dir'],
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
  if (env.GITHUB_ACTIONS !== 'true') throw new Error('Image release runs only in the approved GitHub Actions workflow');
  const context = checkDispatch(env, WORKFLOW_FILE);
  const common = { cwd: process.cwd(), version: values['--version'], sourceRevision: values['--source-revision'], context,
    outputDirectory: resolve(values['--output-dir']) };
  const home = join(env.RUNNER_TEMP || process.cwd(), 'image-release-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  let evidence;
  if (command === 'preflight') {
    evidence = await runPreflight({ ...common, mode: values['--mode'], sourceDirectory: resolve(values['--source-dir']), githubToken: env.GITHUB_TOKEN });
  } else if (command === 'candidate') {
    const docker = dockerRunner({ env, home, configDirectory: join(home, 'docker-config') });
    evidence = await runCandidate({ ...common, docker, imageIdFile: resolve(values['--image-id-file']) });
  } else if (command === 'checks') {
    evidence = await runChecks({ ...common, imageId: values['--image-id'], configDigest: values['--config-digest'],
      runtimeReport: resolve(values['--runtime-report']), scanDirectory: resolve(values['--scan-dir']) });
  } else {
    const configDirectory = resolve(values['--docker-config']);
    if (basename(configDirectory) !== 'image-release-docker-config' || existsSync(configDirectory)) {
      throw new Error('The Docker config directory must be a new absolute image-release-docker-config directory');
    }
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const docker = dockerRunner({ env, home, configDirectory });
    evidence = await runPublication({ ...common, docker, imageId: values['--image-id'], configDigest: values['--config-digest'],
      archiveSha256: values['--archive-sha256'], archive: resolve(values['--archive']), dockerConfigDirectory: configDirectory,
      token: env.REGISTRY_TOKEN, username: env.GITHUB_ACTOR });
  }
  writeActionsFiles(evidence, env);
  console.log(JSON.stringify({ stage: evidence.stage, outcome: evidence.outcome, passed: evidence.passed,
    version: evidence.version, error: evidence.error }, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(sanitizeMessage(error instanceof Error ? error.message : 'Image release failed', 2000));
    process.exitCode = 1;
  }
}
