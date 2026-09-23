import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  archiveIdentity, checkImageIdentity, decidePush, describeManifest, dockerRunner, ENVIRONMENT, IMAGE, IMAGE_NAME, lookupTag, parseArgs,
  readTarFiles, renderSummary, request, runCandidate, runChecks, runPreflight, runPublication, SOURCE_URL, verifyPublished, WORKFLOW_FILE,
  writeActionsFiles, type Docker, type ProcessResult,
} from '../scripts/image-release.mjs';
import { checkDispatch, REPOSITORY } from '../scripts/registry-publication.mjs';

const ROOT = new URL('../', import.meta.url);
const VERSION = '0.4.7';
const REGISTRY = 'https://ghcr.test';
const CDN = 'https://pkg-containers.test';
const TOKEN = 'workflow-registry-token-secret';
const FAST = { requestMs: 2_000, layerMs: 5_000, dockerMs: 5_000, saveMs: 5_000, loadMs: 5_000, pushMs: 5_000, verifyAttempts: 2, verifyIntervalMs: 1 };
const SLOW = { timeout: 120_000 };
const DOCKER_V2 = 'application/vnd.docker.distribution.manifest.v2+json';
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const digestOf = (bytes: string | Buffer) => `sha256:${sha256(bytes)}`;

function temporaryDirectory(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `merovingian-${prefix}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** One image as the Build job sees it: labelled config, two layers and the pushed manifest. */
function imageFixture(sourceRevision: string, changes: { architecture?: string; revision?: string; configFrom?: { config: Buffer }; paddedLayers?: boolean } = {}) {
  // Like a real image configuration, the config lists every layer's uncompressed diff ID, so its digest binds the content.
  // configFrom reuses another image's configuration with unrelated layers, as a crafted manifest could.
  const contents = [randomBytes(64), randomBytes(32)];
  // Padding after the gzip stream is ignored by Node's gunzip but rejected by Go's reader.
  const layers = contents.map(content => changes.paddedLayers ? Buffer.concat([gzipSync(content), Buffer.alloc(64)]) : gzipSync(content));
  const config = changes.configFrom?.config ?? Buffer.from(JSON.stringify({ architecture: changes.architecture ?? 'amd64', os: 'linux',
    config: { Labels: { 'org.opencontainers.image.revision': changes.revision ?? sourceRevision, 'org.opencontainers.image.version': VERSION,
      'org.opencontainers.image.source': SOURCE_URL } },
    rootfs: { type: 'layers', diff_ids: contents.map(content => digestOf(content)) } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: DOCKER_V2,
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: digestOf(config), size: config.length },
    layers: layers.map(layer => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: digestOf(layer), size: layer.length })) }));
  const blobs = new Map([[digestOf(config), config], ...layers.map(layer => [digestOf(layer), layer] as [string, Buffer])]);
  return { config, configDigest: digestOf(config), manifest, digest: digestOf(manifest), blobs, layerDigests: layers.map(layer => digestOf(layer)),
    inspect: { Id: digestOf(config), Os: 'linux', Architecture: JSON.parse(config.toString()).architecture as string,
      Config: { Labels: JSON.parse(config.toString()).config.Labels as Record<string, string> } } };
}
type Image = ReturnType<typeof imageFixture>;

/** The same configuration and layers under a manifest whose descriptors were changed, as a crafted push could. */
function manifestVariant(image: Image, change: (manifest: { config: Record<string, unknown>; mediaType: string }) => void): Image {
  const manifest = JSON.parse(image.manifest.toString());
  change(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { ...image, manifest: bytes, digest: digestOf(bytes) };
}
/** Byte-level variants that JSON.parse and Go's encoding/json read differently. */
function manifestText(image: Image, change: (text: string) => string): Image {
  const bytes = Buffer.from(change(image.manifest.toString()));
  return { ...image, manifest: bytes, digest: digestOf(bytes) };
}
const configText = (image: Image) => JSON.stringify(JSON.parse(image.manifest.toString()).config);
const appendField = (image: Image, field: string) => manifestText(image, text => `${text.slice(0, -1)},${field}}`);
const oversizedConfig = (image: Image) => manifestVariant(image, manifest => { manifest.config.size = (manifest.config.size as number) + 1; });
const unsupportedConfigType = (image: Image) => manifestVariant(image, manifest => { manifest.config.mediaType = 'application/vnd.example.config+json'; });

interface Call { url: string; method: string; authorization: string | null }

interface RegistryOptions {
  tags?: Record<string, Image>; token?: 'ok' | 'denied'; untyped404?: boolean; missingLayer?: boolean;
  tamperedConfig?: boolean; tamperedLayer?: boolean; reencodedLayer?: boolean; httpRedirect?: boolean; digestReference?: Image;
}

/** In-memory GHCR: anonymous tokens, typed 404s, digest headers and signed-URL blob redirects. Faults can change mid-test. */
function registryFixture(initial: RegistryOptions = {}) {
  const options: RegistryOptions = { ...initial };
  const tags = new Map(Object.entries(options.tags ?? {}));
  const manifests = new Map<string, Image>();
  const blobs = new Map<string, Buffer>();
  const configs = new Set<string>();
  const publish = (tag: string, image: Image) => {
    tags.set(tag, image); manifests.set(image.digest, image); configs.add(image.configDigest);
    for (const [digest, bytes] of image.blobs) if (!(options.missingLayer && bytes !== image.config)) blobs.set(digest, bytes);
  };
  for (const [tag, image] of tags) publish(tag, image);
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    calls.push({ url: url.href, method, authorization: headers.get('authorization') });
    assert.equal(init.redirect, 'manual', 'registry requests never follow redirects');
    if (url.origin === CDN || url.origin === 'http://pkg-containers.test') {
      const digest = url.pathname.slice('/blob/'.length);
      const bytes = blobs.get(digest);
      if (!bytes) return new Response('gone', { status: 404 });
      const tampered = configs.has(digest) ? options.tamperedConfig : options.tamperedLayer;
      if (options.reencodedLayer && !configs.has(digest)) {
        // Same length and same uncompressed content: only the gzip header's timestamp differs.
        const reencoded = Buffer.from(bytes);
        reencoded.writeUInt32LE(reencoded.readUInt32LE(4) + 1, 4);
        return new Response(new Uint8Array(reencoded), { status: 200 });
      }
      return new Response(new Uint8Array(tampered ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes), { status: 200 });
    }
    if (url.origin !== REGISTRY) throw new TypeError('fetch failed');
    if (url.pathname === '/token') {
      assert.equal(url.searchParams.get('scope'), `repository:${IMAGE_NAME}:pull`);
      return options.token === 'denied' ? Response.json({ errors: [{ code: 'DENIED' }] }, { status: 403 }) : Response.json({ token: 'anon-token' });
    }
    if (headers.get('authorization') !== 'Bearer anon-token') return Response.json({ errors: [{ code: 'UNAUTHORIZED' }] }, { status: 401 });
    const manifestPath = `/v2/${IMAGE_NAME}/manifests/`;
    if (url.pathname.startsWith(manifestPath)) {
      const reference = decodeURIComponent(url.pathname.slice(manifestPath.length));
      const image = reference.startsWith('sha256:') && options.digestReference ? options.digestReference : tags.get(reference) ?? manifests.get(reference);
      if (!image || options.untyped404) {
        return options.untyped404 ? new Response('not found', { status: 404 })
          : Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] }, { status: 404 });
      }
      const contentType = (/"mediaType":"([^"]+)","config"/.exec(image.manifest.toString())?.[1] ?? DOCKER_V2);
      return new Response(new Uint8Array(image.manifest), { status: 200, headers: { 'content-type': contentType, 'docker-content-digest': image.digest } });
    }
    const blobPath = `/v2/${IMAGE_NAME}/blobs/`;
    if (url.pathname.startsWith(blobPath)) {
      const digest = url.pathname.slice(blobPath.length);
      const bytes = blobs.get(digest);
      if (!bytes) return Response.json({ errors: [{ code: 'BLOB_UNKNOWN' }] }, { status: 404 });
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } });
      const origin = options.httpRedirect ? 'http://pkg-containers.test' : CDN;
      return new Response(null, { status: 307, headers: { location: `${origin}/blob/${digest}?signature=short-lived` } });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, publish, tags, options };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A checkout of a bare origin with a previous release, the release commit and a later docs commit on main. */
function repositoryFixture(t: TestContext) {
  const directory = temporaryDirectory(t, 'image-source');
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
  const packageJson = (version: string) => `${JSON.stringify({ name: 'merovingian', version })}\n`;
  commit({ 'server.json': '{"version":"0.4.6"}\n', 'package.json': packageJson('0.4.6') }, 'previous release');
  const release = commit({ 'server.json': '{"version":"0.4.7"}\n', 'package.json': packageJson(VERSION), 'Dockerfile': 'FROM scratch\n' }, 'release');
  const head = commit({ 'NOTES.md': 'docs\n' }, 'docs');
  git(cwd, 'push', '--quiet', 'origin', 'main');
  git(cwd, 'checkout', '--quiet', '-b', 'side', release);
  const side = commit({ 'SIDE.md': 'side\n' }, 'side');
  git(cwd, 'checkout', '--quiet', 'main');
  // The next release merges: main's server.json and package.json move on.
  const moveMain = () => {
    commit({ 'server.json': '{"version":"0.4.8"}\n', 'package.json': packageJson('0.4.8') }, 'next release');
    git(cwd, 'push', '--quiet', 'origin', 'main');
    git(cwd, 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/merovingian/main');
  };
  return { directory, cwd, release, head, side, moveMain };
}

const CONTEXT = (workflowRevision: string) => ({ workflowRevision, run: { id: '123', attempt: 1, url: `https://github.com/${REPOSITORY}/actions/runs/123/attempts/1` } });

function environmentFetch(protectedEnvironment: boolean, registry: ReturnType<typeof registryFixture>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const base = `https://api.github.test/repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
    if (url === base) {
      return Response.json(protectedEnvironment
        ? { name: ENVIRONMENT, can_admins_bypass: false, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }
        : { name: ENVIRONMENT, can_admins_bypass: true, protection_rules: [], deployment_branch_policy: null });
    }
    if (url === `${base}/deployment-branch-policies`) return Response.json({ branch_policies: [{ name: 'main', type: 'branch' }] });
    return registry.fetch(input, init);
  }) as typeof fetch;
}

/** A `docker image save` archive: the classic store names the config as the image ID; containerd adds an OCI manifest blob. */
function writeDockerArchive(output: string, image: Image, layout: 'classic' | 'containerd' = 'classic', format = 'gnu') {
  const directory = mkdtempSync(join(tmpdir(), 'merovingian-archive-'));
  try {
    const blobs = join(directory, 'blobs', 'sha256');
    mkdirSync(blobs, { recursive: true });
    writeFileSync(join(blobs, image.configDigest.slice(7)), image.config);
    writeFileSync(join(blobs, image.layerDigests[0].slice(7)), 'layer bytes');
    if (layout === 'containerd') writeFileSync(join(blobs, image.digest.slice(7)), image.manifest);
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify([{ Config: `blobs/sha256/${image.configDigest.slice(7)}`, RepoTags: null, Layers: [] }]));
    execFileSync('tar', [`--format=${format}`, '-cf', output, '-C', directory, 'blobs', 'manifest.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type DockerBehavior = Partial<{ load: 'fail'; login: 'fail'; inspect: 'missing'; save: Image;
  push: 'fail' | 'fail-after-upload' | 'fail-foreign' | 'fail-unknown' | 'moved' | 'fail-crafted-size' | 'fail-crafted-type' | 'fail-crafted-shadow' }>;

/** Scripted docker: records every call; secrets may arrive only on stdin. */
function dockerFixture(image: Image, registry: ReturnType<typeof registryFixture>, behavior: DockerBehavior = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const ok = (stdout = ''): ProcessResult => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: '' });
  const failed = (stderr: string): ProcessResult => ({ exitCode: 1, signal: null, timedOut: false, stdout: '', stderr });
  const docker: Docker = async (args, options = {}) => {
    calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
    const [command, subcommand] = args;
    if (command === 'image' && subcommand === 'inspect') {
      return behavior.inspect === 'missing' ? failed('Error: No such image') : ok(JSON.stringify([image.inspect]));
    }
    if (command === 'image' && subcommand === 'save') {
      writeDockerArchive(args[args.indexOf('--output') + 1], behavior.save ?? image);
      return ok();
    }
    if (command === 'image' && subcommand === 'load') return behavior.load === 'fail' ? failed('Error: invalid tar header') : ok(`Loaded image ID: ${image.inspect.Id}\n`);
    if (command === 'image' && subcommand === 'tag') return ok();
    if (command === 'login') return behavior.login === 'fail' ? failed('Error response from daemon: denied') : ok('Login Succeeded\n');
    if (command === 'image' && subcommand === 'push') {
      const reported = ok(`The push refers to repository [${IMAGE}]\n${VERSION}: digest: ${image.digest} size: ${image.manifest.length}\n`);
      switch (behavior.push) {
        case 'fail': return failed('error parsing HTTP 502 response body');
        case 'fail-after-upload': registry.publish(VERSION, image); return failed('error parsing HTTP 502 response body');
        case 'fail-foreign': registry.publish(VERSION, imageFixture(image.inspect.Config.Labels['org.opencontainers.image.revision'])); return failed('unexpected EOF');
        case 'fail-unknown': registry.options.untyped404 = true; return failed('unexpected EOF');
        case 'moved': registry.publish(VERSION, imageFixture(image.inspect.Config.Labels['org.opencontainers.image.revision'])); return reported;
        // A concurrent writer leaves a crafted manifest that reuses the verified configuration.
        case 'fail-crafted-size': registry.publish(VERSION, oversizedConfig(image)); return failed('unexpected EOF');
        case 'fail-crafted-type': registry.publish(VERSION, unsupportedConfigType(image)); return failed('unexpected EOF');
        case 'fail-crafted-shadow': registry.publish(VERSION, appendField(image, `"Config":${configText(imageFixture('b'.repeat(40)))}`)); return failed('unexpected EOF');
        default: registry.publish(VERSION, image); return reported;
      }
    }
    if (command === 'logout') return ok('Removing login credentials for ghcr.io\n');
    return failed(`unexpected docker call ${args.join(' ')}`);
  };
  return { docker, calls };
}

test('dispatch context accepts only the image release workflow on main', () => {
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW_FILE}@refs/heads/main`, GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
  };
  assert.equal(checkDispatch(env, WORKFLOW_FILE).workflowRevision, 'a'.repeat(40));
  assert.throws(() => checkDispatch(env), /GITHUB_WORKFLOW_REF must be/, 'the registry workflow identity is not interchangeable');
  assert.throws(() => checkDispatch({ ...env, GITHUB_REF: 'refs/heads/feature' }, WORKFLOW_FILE), /must be/);
});

test('command-line arguments are a closed, complete set per command', () => {
  const publish = ['publish', '--version', VERSION, '--source-revision', 'a'.repeat(40), '--image-id', 'i', '--config-digest', 'c',
    '--archive-sha256', 's', '--archive', 'a', '--docker-config', 'd', '--output-dir', 'o'];
  assert.equal(parseArgs(publish).values['--docker-config'], 'd');
  assert.equal(parseArgs(['candidate', '--version', VERSION, '--source-revision', 'a'.repeat(40), '--image-id-file', 'f', '--output-dir', 'o']).command, 'candidate');
  assert.equal(parseArgs(['checks', '--version', VERSION, '--source-revision', 'a'.repeat(40), '--image-id', 'i', '--config-digest', 'c',
    '--runtime-report', 'r', '--scan-dir', 's', '--output-dir', 'o']).command, 'checks');
  for (const args of [[], ['status'], publish.slice(0, -2), [...publish, '--registry', 'http://example.invalid'],
    ['candidate', '--version', VERSION, '--source-revision', 'a'.repeat(40), '--image-id-file', 'f', '--runtime-report', 'r', '--output-dir', 'o'],
    ['preflight', '--version', VERSION, '--version', VERSION, '--mode', 'verify', '--source-dir', 's', '--output-dir', 'o']]) {
    assert.throws(() => parseArgs(args), /Usage/);
  }
});

test('the CLI refuses every command outside GitHub Actions', SLOW, () => {
  const script = fileURLToPath(new URL('scripts/image-release.mjs', ROOT));
  const { GITHUB_ACTIONS: _, ...env } = process.env;
  const result = spawnSync(process.execPath, [script, 'preflight', '--version', VERSION, '--source-revision', 'a'.repeat(40),
    '--mode', 'verify', '--source-dir', '/tmp/source', '--output-dir', 'o'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /runs only in the approved GitHub Actions workflow/);
});

test('only a typed MANIFEST_UNKNOWN 404 proves that a release tag is absent', async () => {
  const image = imageFixture('a'.repeat(40));
  const present = await lookupTag({ registry: REGISTRY, reference: VERSION, fetch: registryFixture({ tags: { [VERSION]: image } }).fetch, timeoutMs: 1_000 });
  assert.deepEqual([present.state, present.digest, present.config?.digest, present.layers?.length], ['present', image.digest, image.configDigest, 2]);
  assert.equal((await lookupTag({ registry: REGISTRY, reference: VERSION, fetch: registryFixture().fetch, timeoutMs: 1_000 })).state, 'absent');
  for (const options of [{ untyped404: true }, { token: 'denied' as const }]) {
    const tag = await lookupTag({ registry: REGISTRY, reference: VERSION, fetch: registryFixture(options).fetch, timeoutMs: 1_000 });
    assert.equal(tag.state, 'error');
    assert.ok(tag.problem);
  }
  const unreachable = await lookupTag({ registry: 'https://unreachable.test', reference: VERSION, timeoutMs: 1_000,
    fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  assert.deepEqual([unreachable.state, unreachable.problem], ['error', 'anonymous pull token unavailable (transport failed)']);
});

test('manifests must be single, well-formed images whose bytes match their digest header', () => {
  const image = imageFixture('a'.repeat(40));
  const response = (bytes: Buffer, digest: string | null = digestOf(bytes), contentType = DOCKER_V2) => ({ status: 200, bytes, digest, contentType });
  assert.equal(describeManifest(response(image.manifest)).problem, undefined);
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }));
  const cases: [ReturnType<typeof response>, RegExp][] = [
    [response(image.manifest, `sha256:${'0'.repeat(64)}`), /Docker-Content-Digest differs/],
    [response(index), /index/],
    [response(Buffer.from(JSON.stringify({ schemaVersion: 1, mediaType: DOCKER_V2 }))), /unsupported/],
    [response(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: DOCKER_V2, config: { digest: 'sha256:x', size: 1 }, layers: [] }))), /malformed/],
    [response(unsupportedConfigType(image).manifest), /unsupported configuration media type/],
    // Each manifest type must name its own configuration type.
    [response(manifestVariant(image, manifest => { manifest.config.mediaType = 'application/vnd.oci.image.config.v1+json'; }).manifest), /unsupported configuration media type/],
    [response(manifestVariant(image, manifest => { manifest.mediaType = 'application/vnd.oci.image.manifest.v1+json'; }).manifest), /unsupported configuration media type/],
    [response(manifestVariant(image, manifest => { delete manifest.config.mediaType; }).manifest), /unsupported configuration media type/],
    [response(manifestVariant(image, manifest => { manifest.config.mediaType = 'application/vnd.docker.container.image.v1+json'.toUpperCase(); }).manifest), /unsupported configuration media type/],
    [response(manifestVariant(image, manifest => { manifest.config.mediaType += '.x'; }).manifest), /unsupported configuration media type/],
    [response(manifestVariant(image, manifest => { manifest.config.mediaType += '; charset=utf-8'; }).manifest), /unsupported configuration media type/],
    // Go matches keys case-insensitively (with Unicode folding) and merges duplicates; JSON.parse does neither.
    [response(appendField(image, `"Config":${configText(imageFixture('a'.repeat(40)))}`).manifest), /not canonical/],
    [response(appendField(image, `"Layers":[]`).manifest), /not canonical/],
    [response(manifestText(image, text => text.replace('"config":{', '"config":{"Size":1,')).manifest), /not canonical/],
    [response(manifestText(image, text => text.replace('"config":{', '"config":{"\u017fize":1,')).manifest), /not canonical/],
    [response(manifestText(image, text => text.replace('"config":{', `"config":${configText(image)},"\u0063onfig":{`)).manifest), /not canonical/],
    [response(manifestText(image, text => text.replace(/"size":([0-9]+)/, '"size":$1.0')).manifest), /not canonical/],
    [response(manifestText(image, text => `${text}\n{}`).manifest), /not canonical/],
    // containerd fetches descriptor URLs, or uses inline data, instead of the registry.
    [response(manifestVariant(image, manifest => { manifest.config.urls = ['https://elsewhere.test/config']; }).manifest), /not canonical/],
    [response(manifestText(image, text => text.replace('"layers":[{', '"layers":[{"data":"AA==",')).manifest), /not canonical/],
    [response(appendField(image, `"subject":${configText(image)}`).manifest), /not canonical/],
    [response(manifestVariant(image, manifest => { manifest.config.annotations = { size: 1 } as unknown as string; }).manifest), /not canonical/],
  ];
  assert.equal(describeManifest(response(manifestVariant(image, manifest => { manifest.config.annotations = { note: 'reviewed' } as unknown as string; }).manifest)).problem, undefined,
    'string annotations are allowed');
  const oci = manifestVariant(image, manifest => {
    manifest.mediaType = 'application/vnd.oci.image.manifest.v1+json';
    manifest.config.mediaType = 'application/vnd.oci.image.config.v1+json';
  });
  assert.equal(describeManifest(response(oci.manifest)).config?.mediaType, 'application/vnd.oci.image.config.v1+json');
  for (const [candidate, pattern] of cases) assert.match(describeManifest(candidate).problem ?? '', pattern);
});

test('registry reads never follow redirects, bound bodies and never throw', async () => {
  const redirect = await request('https://ghcr.test/x', { fetch: (async () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/' } })) as typeof fetch });
  assert.deepEqual([redirect.status, redirect.location, redirect.bytes], [307, 'https://elsewhere.test/', undefined]);
  const large = await request('https://ghcr.test/x', { maxBytes: 8, fetch: (async () => new Response('x'.repeat(64))) as typeof fetch });
  assert.equal(large.problem, 'response too large');
  const timeout = await request('https://ghcr.test/x', { fetch: (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch });
  assert.deepEqual(timeout, { status: 0, problem: 'request timed out' });
});

test('a push decision publishes only an absent tag or recognizes the same verified image', () => {
  const image = imageFixture('a'.repeat(40));
  const observed = { reference: VERSION, observedAt: 't' };
  assert.equal(decidePush({ ...observed, state: 'absent' }, image.configDigest), 'push');
  assert.equal(decidePush({ ...observed, state: 'present', config: { digest: image.configDigest, size: 1 } }, image.configDigest), 'already-published');
  assert.throws(() => decidePush({ ...observed, state: 'present', config: { digest: `sha256:${'1'.repeat(64)}`, size: 1 } }, image.configDigest), /never replaced/);
  assert.throws(() => decidePush({ ...observed, state: 'error', problem: 'HTTP 503' }, image.configDigest), /state is unknown/);
});

test('anonymous verification binds tag, digest, configuration, platform and every layer', async () => {
  const source = 'a'.repeat(40);
  const image = imageFixture(source);
  const registry = registryFixture({ tags: { [VERSION]: image } });
  const verified = await verifyPublished({ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registry.fetch, timeoutMs: 1_000 });
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.passed, true);
  assert.deepEqual(verified.layers.map((layer: { contentVerified: boolean }) => layer.contentVerified), [true, true]);
  // Signed blob URLs receive no credentials, not even the anonymous pull token.
  const cdn = registry.calls.filter(call => call.url.startsWith(CDN));
  assert.equal(cdn.length, 3, 'the configuration and both layers');
  assert.ok(cdn.every(call => call.authorization === null));
  assert.equal(cdn[0].authorization, null);

  const other = imageFixture(source);
  const padded = imageFixture(source, { paddedLayers: true });
  const cases: [Parameters<typeof verifyPublished>[0], RegExp][] = [
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: other.configDigest, fetch: registry.fetch }, /differs from the verified candidate/],
    [{ registry: REGISTRY, version: VERSION, digest: other.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image, other } }).fetch }, /pushed digest/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, missingLayer: true }).fetch }, /layer unavailable \(HTTP 404\)/],
    [{ registry: REGISTRY, version: VERSION, digest: null, configDigest: image.configDigest, fetch: registry.fetch }, /no pushed digest/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, tamperedConfig: true }).fetch }, /config blob size differs/],
    [{ registry: REGISTRY, version: VERSION, digest: oversizedConfig(image).digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: oversizedConfig(image) } }).fetch }, /config blob size differs from its descriptor/],
    [{ registry: REGISTRY, version: VERSION, digest: padded.digest, configDigest: padded.configDigest, fetch: registryFixture({ tags: { [VERSION]: padded } }).fetch }, /data after its gzip stream/],
    [{ registry: REGISTRY, version: VERSION, digest: unsupportedConfigType(image).digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: unsupportedConfigType(image) } }).fetch }, /unsupported configuration media type/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, httpRedirect: true }).fetch }, /config blob unavailable \(HTTP 307\)/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, tamperedLayer: true }).fetch }, /layer size differs/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, reencodedLayer: true }).fetch }, /layer bytes differ from their digest/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, digestReference: other }).fetch }, /digest reference differs/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, token: 'denied' }).fetch }, /anonymous pull token unavailable/],
  ];
  for (const [options, pattern] of cases) {
    const result = await verifyPublished({ timeoutMs: 1_000, ...options });
    assert.equal(result.passed, false);
    assert.match(result.problems.join('; '), pattern);
  }
  const arm = imageFixture(source, { architecture: 'arm64' });
  const wrongPlatform = await verifyPublished({ registry: REGISTRY, version: VERSION, digest: arm.digest, configDigest: arm.configDigest,
    fetch: registryFixture({ tags: { [VERSION]: arm } }).fetch, timeoutMs: 1_000 });
  assert.match(wrongPlatform.problems.join('; '), /not linux\/amd64/);
});

test('the local candidate must be the exact labelled linux/amd64 image for this source', () => {
  const source = 'a'.repeat(40);
  const image = imageFixture(source).inspect;
  const expected = { imageId: image.Id, version: VERSION, sourceRevision: source };
  assert.equal(checkImageIdentity(image, expected).labels.revision, source);
  for (const [changed, pattern] of [
    [{ ...image, Id: `sha256:${'2'.repeat(64)}` }, /image ID differs/],
    [{ ...image, Architecture: 'arm64' }, /linux\/amd64/],
    [{ ...image, Config: { Labels: { ...image.Config.Labels, 'org.opencontainers.image.revision': 'b'.repeat(40) } } }, /labels/],
    [{ ...image, Config: {} }, /labels/],
  ] as [Record<string, unknown>, RegExp][]) {
    assert.throws(() => checkImageIdentity(changed, expected), pattern);
  }
});

function assertPublicEvidence(file: string) {
  const text = readFileSync(file, 'utf8');
  for (const secret of [TOKEN, 'anon-token', tmpdir()]) assert.equal(text.includes(secret), false, `evidence leaked ${secret}`);
}

test('preflight checks source, tag and approval gate before checking out the source revision', SLOW, async (t) => {
  const repo = repositoryFixture(t);
  const run = (changes: Record<string, unknown> = {}, registry = registryFixture(), protectedEnvironment = true) => {
    const output = join(repo.directory, `out-${randomBytes(4).toString('hex')}`);
    const sourceDirectory = join(repo.directory, `source-${randomBytes(4).toString('hex')}`);
    return runPreflight({ cwd: repo.cwd, version: VERSION, sourceRevision: repo.release, context: CONTEXT(repo.head), mode: 'publish',
      outputDirectory: output, sourceDirectory, registry: REGISTRY, api: 'https://api.github.test', githubToken: 'actions-read-token',
      fetch: environmentFetch(protectedEnvironment, registry), timeouts: FAST, ...changes })
      .then(evidence => ({ evidence, output, sourceDirectory }));
  };
  const passing = await run();
  assert.equal(passing.evidence.passed, true, JSON.stringify(passing.evidence.error));
  assert.deepEqual([passing.evidence.decision, passing.evidence.tag.state, passing.evidence.source.releaseCommit], ['publish', 'absent', true]);
  assert.equal(git(passing.sourceDirectory, 'rev-parse', 'HEAD'), repo.release, 'the source revision, not main, is checked out');
  assertPublicEvidence(join(passing.output, 'preflight.json'));

  const verifyOnly = await run({ mode: 'verify' }, registryFixture(), false);
  assert.deepEqual([verifyOnly.evidence.passed, verifyOnly.evidence.decision, verifyOnly.evidence.environment.passed], [true, 'verify-only', false]);

  const image = imageFixture(repo.release);
  const refusals: [Awaited<ReturnType<typeof run>>, string][] = [
    [await run({}, registryFixture(), false), 'environment'],
    [await run({}, registryFixture({ tags: { [VERSION]: image } })), 'tag-exists'],
    [await run({}, registryFixture({ untyped404: true })), 'registry'],
    [await run({ sourceRevision: repo.side }), 'source'],
    [await run({ version: '0.4.8' }), 'source'],
    [await run({ mode: 'preflight' }), 'input'],
    [await run({ sourceDirectory: repo.cwd }), 'input'],
  ];
  for (const [{ evidence, sourceDirectory }, code] of refusals) {
    assert.equal(evidence.passed, false);
    assert.equal(evidence.error.code, code, JSON.stringify(evidence.error));
    if (sourceDirectory !== repo.cwd) assert.equal(existsSync(sourceDirectory), false, 'nothing is checked out after a refusal');
  }
});

test('saved archives are read without extraction and must contain exactly the labelled candidate', SLOW, async (t) => {
  const directory = temporaryDirectory(t, 'image-archive');
  const source = 'a'.repeat(40);
  const image = imageFixture(source);
  const expected = { imageId: image.inspect.Id, version: VERSION, sourceRevision: source };
  for (const format of ['gnu', 'ustar', 'posix']) {
    const archive = join(directory, `classic-${format}.tar`);
    writeDockerArchive(archive, image, 'classic', format);
    assert.deepEqual(await archiveIdentity(archive, expected), { configDigest: image.configDigest }, format);
  }
  const containerd = join(directory, 'containerd.tar');
  writeDockerArchive(containerd, image, 'containerd');
  assert.deepEqual(await archiveIdentity(containerd, { ...expected, imageId: image.digest }), { configDigest: image.configDigest });
  const files = await readTarFiles(containerd, name => name === 'manifest.json');
  assert.deepEqual([...files.keys()], ['manifest.json']);

  const other = join(directory, 'other.tar');
  writeDockerArchive(other, imageFixture(source));
  const relabelled = join(directory, 'relabelled.tar');
  const relabelledImage = imageFixture(source, { revision: 'b'.repeat(40) });
  writeDockerArchive(relabelled, relabelledImage);
  const truncated = join(directory, 'truncated.tar');
  writeFileSync(truncated, readFileSync(containerd).subarray(0, 700));
  for (const [archive, changes, pattern] of [
    [other, {}, /does not contain the candidate image/],
    [containerd, { imageId: imageFixture(source).digest }, /does not contain the candidate image/],
    [relabelled, { imageId: relabelledImage.inspect.Id }, /labelled linux\/amd64 image/],
    [truncated, {}, /truncated|exactly one image/],
  ] as [string, Record<string, string>, RegExp][]) {
    await assert.rejects(() => archiveIdentity(archive, { ...expected, ...changes }), pattern);
  }
});

async function candidateFixture(t: TestContext, changes: { preflight?: Record<string, unknown>; imageId?: string; docker?: DockerBehavior; image?: Image } = {}) {
  const directory = temporaryDirectory(t, 'image-candidate');
  const source = 'a'.repeat(40);
  const image = changes.image ?? imageFixture(source);
  writeFileSync(join(directory, 'preflight.json'), JSON.stringify({ passed: true, version: VERSION, mode: 'publish', decision: 'publish',
    source: { revision: source, releaseCommit: true }, tag: { state: 'absent' }, environment: { passed: true, reviewerCount: 1 }, ...changes.preflight }));
  writeFileSync(join(directory, 'image-id'), `${changes.imageId ?? image.inspect.Id}\n`);
  const docker = dockerFixture(image, registryFixture(), changes.docker);
  const evidence = await runCandidate({ version: VERSION, sourceRevision: source, context: CONTEXT('b'.repeat(40)), outputDirectory: directory,
    docker: docker.docker, imageIdFile: join(directory, 'image-id'), timeouts: FAST });
  return { evidence, directory, image, commands: docker.calls.map(call => call.args.slice(0, 2).join(' ')) };
}

test('Build records the image ID, the configuration digest from the saved bytes and the archive SHA-256', SLOW, async (t) => {
  const { evidence, directory, image, commands } = await candidateFixture(t);
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.deepEqual(commands, ['image inspect', 'image save']);
  const archive = readFileSync(join(directory, 'candidate', 'image.tar'));
  assert.deepEqual([evidence.image.imageId, evidence.image.configDigest, evidence.decision, evidence.outcome], [image.inspect.Id, image.configDigest, 'publish', 'built']);
  assert.deepEqual(evidence.archive, { name: 'image.tar', sha256: sha256(archive), bytes: archive.length });
  assertPublicEvidence(join(directory, 'candidate.json'));
  const env = { GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') };
  writeActionsFiles(evidence, env);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    `decision=publish\nimage_id=${image.inspect.Id}\nconfig_digest=${image.configDigest}\narchive_sha256=${sha256(archive)}\n`);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Configuration digest/);

  for (const [changes, code] of [
    [{ preflight: { passed: false } }, 'input'], [{ preflight: { decision: 'refuse' } }, 'input'],
    [{ preflight: { version: '0.4.8' } }, 'input'], [{ preflight: { source: { revision: 'c'.repeat(40) } } }, 'input'],
    [{ imageId: 'latest' }, 'image'], [{ docker: { inspect: 'missing' } }, 'image'],
    [{ image: imageFixture('a'.repeat(40), { revision: 'c'.repeat(40) }) }, 'image'],
    [{ docker: { save: imageFixture('a'.repeat(40)) } }, 'archive'],
  ] as [Parameters<typeof candidateFixture>[1], string][]) {
    const failed = await candidateFixture(t, changes);
    assert.equal(failed.evidence.passed, false);
    assert.equal(failed.evidence.error.code, code, JSON.stringify([changes, failed.evidence.error]));
    writeActionsFiles(failed.evidence, env);
  }
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8').split('\n').length, 5, 'failed candidates set no outputs');
});

async function checksFixture(t: TestContext, changes: { runtime?: Record<string, unknown>; policy?: Record<string, unknown>; provenance?: Record<string, unknown>; configDigest?: string } = {}) {
  const directory = temporaryDirectory(t, 'image-checks');
  const image = imageFixture('a'.repeat(40));
  const scan = join(directory, 'scan');
  mkdirSync(scan);
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ passed: true, imageId: image.inspect.Id, checkedAt: 't',
    completedChecks: ['image-metadata'], applicationFilesChecked: 9, appArmor: { status: 'unavailable' }, ...changes.runtime }));
  writeFileSync(join(scan, 'policy.json'), JSON.stringify({ passed: true, imageId: image.configDigest, blocked: [], accepted: [],
    reported: [{ advisory: 'CVE-2025-14505', severity: 'LOW' }], scannerVersion: '0.74.0', ...changes.policy }));
  writeFileSync(join(scan, 'scan-provenance.json'), JSON.stringify({ localImageId: image.inspect.Id, configurationDigest: image.configDigest, ...changes.provenance }));
  const evidence = await runChecks({ version: VERSION, sourceRevision: 'a'.repeat(40), context: CONTEXT('b'.repeat(40)), outputDirectory: join(directory, 'out'),
    imageId: image.inspect.Id, configDigest: changes.configDigest ?? image.configDigest, runtimeReport: join(directory, 'runtime.json'), scanDirectory: scan });
  return { evidence, directory };
}

test('Check binds the runtime and advisory reports to the image Build recorded and sets no outputs', SLOW, async (t) => {
  const { evidence, directory } = await checksFixture(t);
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.deepEqual([evidence.outcome, evidence.scan.blockedCount, evidence.scan.reported.length], ['checked', 0, 1]);
  const env = { GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') };
  writeActionsFiles(evidence, env);
  assert.equal(existsSync(env.GITHUB_OUTPUT), false, 'Publish never consumes values from the Check job');
  const other = `sha256:${'3'.repeat(64)}`;
  for (const [changes, code] of [
    [{ runtime: { imageId: other } }, 'runtime'], [{ runtime: { passed: false } }, 'runtime'],
    [{ policy: { passed: false } }, 'scan'], [{ policy: { blocked: [{ advisory: 'CVE-1' }] } }, 'scan'],
    [{ provenance: { localImageId: other } }, 'scan'], [{ provenance: { configurationDigest: other } }, 'scan'],
    [{ policy: { imageId: other } }, 'scan'], [{ configDigest: 'latest' }, 'input'],
  ] as [Parameters<typeof checksFixture>[1], string][]) {
    const failed = await checksFixture(t, changes);
    assert.equal(failed.evidence.passed, false);
    assert.equal(failed.evidence.error.code, code, JSON.stringify([changes, failed.evidence.error]));
  }
});

async function publicationFixture(t: TestContext, options: { tags?: Record<string, 'same' | 'other' | 'foreign' | 'config-size' | 'config-type' | 'shadow'>; docker?: DockerBehavior;
  moveMain?: boolean;
  archive?: string | null; registry?: RegistryOptions; changes?: Record<string, unknown> } = {}) {
  const repo = repositoryFixture(t);
  git(repo.cwd, 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/merovingian/main');
  const image = imageFixture(repo.release);
  const tags = Object.fromEntries(Object.entries(options.tags ?? {}).map(([tag, kind]) => [tag,
    kind === 'same' ? image : kind === 'foreign' ? imageFixture(repo.release, { configFrom: image })
      : kind === 'config-size' ? oversizedConfig(image) : kind === 'config-type' ? unsupportedConfigType(image)
      : kind === 'shadow' ? appendField(image, `"Config":${configText(imageFixture('b'.repeat(40)))}`) : imageFixture(repo.release)]));
  if (options.moveMain) repo.moveMain();
  const registry = registryFixture({ ...options.registry, tags });
  const docker = dockerFixture(image, registry, options.docker);
  const archive = join(repo.directory, 'image.tar');
  if (options.archive !== null) writeFileSync(archive, options.archive ?? 'verified image bytes');
  const configDirectory = join(repo.directory, 'image-release-docker-config');
  mkdirSync(configDirectory);
  const output = join(repo.directory, 'publication');
  const evidence = await runPublication({ cwd: repo.cwd, version: VERSION, sourceRevision: repo.release, context: CONTEXT(repo.head),
    outputDirectory: output, docker: docker.docker, imageId: image.inspect.Id, configDigest: image.configDigest,
    archiveSha256: sha256('verified image bytes'), archive, dockerConfigDirectory: configDirectory, token: TOKEN, username: 'release-operator',
    registry: REGISTRY, fetch: registry.fetch, refreshMain: () => {}, timeouts: FAST, sleep: async () => {}, ...options.changes });
  const commands = docker.calls.map(call => call.args.slice(0, 2).join(' '));
  return { evidence, image, commands, calls: docker.calls, configDirectory, output, registry, repo };
}

test('publication loads the verified archive, logs in on stdin, pushes once, logs out and verifies anonymously', SLOW, async (t) => {
  const { evidence, image, commands, calls, configDirectory, output } = await publicationFixture(t);
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.deepEqual([evidence.outcome, evidence.digest, evidence.reference], ['published', image.digest, `${IMAGE}@${image.digest}`]);
  assert.deepEqual(commands, ['image load', 'image inspect', 'image tag', 'login ghcr.io', 'image push', 'logout ghcr.io']);
  const login = calls.find(call => call.args[0] === 'login')!;
  assert.equal(login.input, TOKEN, 'the token reaches docker only on stdin');
  for (const call of calls) assert.equal(call.args.join(' ').includes(TOKEN), false);
  assert.equal(existsSync(configDirectory), false, 'the private Docker login directory is removed');
  assert.equal(evidence.verification.passed, true);
  assertPublicEvidence(join(output, 'publication.json'));
  const env = { GITHUB_OUTPUT: join(output, 'output') };
  writeActionsFiles(evidence, env);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), `digest=${image.digest}\n`);
  assert.match(renderSummary(evidence), /\*\*published\*\*/);
});

test('publication refuses bad inputs, changed bytes, a moved source or a conflicting tag before any docker call', SLOW, async (t) => {
  const cases: [Parameters<typeof publicationFixture>[1], string, RegExp?][] = [
    [{ archive: 'different bytes' }, 'archive'],
    [{ archive: null }, 'archive', /unavailable \(it expires 7 days after Build\)/],
    [{ tags: { [VERSION]: 'other' } }, 'tag-conflict'],
    [{ registry: { untyped404: true } }, 'registry'],
    [{ changes: { configDigest: 'sha256:short' } }, 'input'],
    [{ changes: { token: undefined } }, 'input'],
    [{ changes: { username: 'bad user' } }, 'input'],
    [{ changes: { version: '0.4.8' } }, 'source'],
  ];
  for (const [options, code, pattern] of cases) {
    const { evidence, commands, output } = await publicationFixture(t, options);
    assert.equal(evidence.error?.code, code, JSON.stringify([options, evidence.error]));
    if (pattern) assert.match(evidence.error.message, pattern);
    assert.deepEqual(commands, [], JSON.stringify(options));
    assertPublicEvidence(join(output, 'publication.json'));
  }
  // The source revision is rechecked after approval, not only before the build.
  const moved = await publicationFixture(t, { changes: { sourceRevision: 'f'.repeat(40) } });
  assert.deepEqual([moved.evidence.error.code, moved.commands], ['source', []]);
  const failedLoad = await publicationFixture(t, { docker: { load: 'fail' } });
  assert.deepEqual([failedLoad.evidence.error.code, failedLoad.commands], ['image', ['image load']]);
});

test('unexpected failures keep only an error code, never a local path', SLOW, async (t) => {
  const directory = temporaryDirectory(t, 'directory-archive');
  const { evidence, output } = await publicationFixture(t, { changes: { archive: directory } });
  assert.deepEqual(evidence.error, { code: 'internal', message: 'EISDIR' });
  assertPublicEvidence(join(output, 'publication.json'));
});

test('a re-run after a completed push verifies the same image without the archive or a login', SLOW, async (t) => {
  const { evidence, image, commands, registry } = await publicationFixture(t, { tags: { [VERSION]: 'same' }, archive: null });
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.deepEqual([evidence.outcome, evidence.digest, commands], ['already-published', image.digest, []]);
  assert.equal(evidence.verification.passed, true);
  const reads = registry.calls.map(call => `${call.method} ${new URL(call.url).pathname.split('/').slice(-2, -1)[0]}`);
  for (const read of ['GET manifests', 'GET blobs', 'GET blob']) assert.ok(reads.includes(read), read);
  assert.equal(registry.calls.filter(call => call.url.startsWith(CDN)).length, 3, 'configuration and every layer are downloaded and checked');
});

test('after the next release lands on main, a re-run still attests the published candidate but never pushes', SLOW, async (t) => {
  const rerun = await publicationFixture(t, { tags: { [VERSION]: 'same' }, archive: null, moveMain: true });
  assert.equal(rerun.evidence.passed, true, JSON.stringify(rerun.evidence.error));
  assert.deepEqual([rerun.evidence.outcome, rerun.commands], ['already-published', []]);
  const push = await publicationFixture(t, { moveMain: true });
  assert.equal(push.evidence.error.code, 'source');
  assert.match(push.evidence.error.message, /differs from main/);
  assert.deepEqual(push.commands, []);
});

test('a tag that reuses the verified configuration under crafted descriptors is never adopted or attested', SLOW, async (t) => {
  // Same configuration digest and layer content; only the configuration descriptor differs, so Docker cannot pull it.
  const oversized = await publicationFixture(t, { tags: { [VERSION]: 'config-size' }, archive: null });
  assert.deepEqual([oversized.evidence.decision, oversized.evidence.error?.code, oversized.commands], ['already-published', 'verification', []]);
  assert.match(oversized.evidence.error.message, /config blob size differs from its descriptor/);
  assert.equal(oversized.evidence.digest, undefined);
  const unsupported = await publicationFixture(t, { tags: { [VERSION]: 'config-type' }, archive: null });
  assert.deepEqual([unsupported.evidence.error?.code, unsupported.commands], ['registry', []]);
  assert.match(unsupported.evidence.error.message, /unsupported configuration media type/);
  // Docker would pull the shadowing "Config" instead of the verified configuration.
  const shadow = await publicationFixture(t, { tags: { [VERSION]: 'shadow' }, archive: null });
  assert.deepEqual([shadow.evidence.error?.code, shadow.commands, shadow.evidence.digest], ['registry', [], undefined]);
  assert.match(shadow.evidence.error.message, /not canonical/);
  // The same crafted tags appearing during a failed push are never adopted either.
  const size = await publicationFixture(t, { docker: { push: 'fail-crafted-size' } });
  assert.deepEqual([size.evidence.decision, size.evidence.error?.code, size.evidence.digest], ['push', 'verification', undefined]);
  for (const push of ['fail-crafted-type', 'fail-crafted-shadow'] as const) {
    const crafted = await publicationFixture(t, { docker: { push } });
    assert.deepEqual([crafted.evidence.decision, crafted.evidence.error?.code, crafted.evidence.digest], ['push', 'push', undefined], push);
    assert.match(crafted.evidence.error.message, /outcome is unknown/);
  }
});

test('a push that does not verify anonymously never yields a digest to attest', SLOW, async (t) => {
  for (const options of [{ registry: { missingLayer: true } }, { docker: { push: 'moved' as const } }, { registry: { tamperedLayer: true } },
    { tags: { [VERSION]: 'foreign' as const } }, { docker: { push: 'fail-crafted-size' as const } }]) {
    const { evidence, output } = await publicationFixture(t, options);
    assert.equal(evidence.passed, false);
    assert.equal(evidence.error.code, 'verification', JSON.stringify([options, evidence.error]));
    assert.equal(evidence.digest, undefined);
    const env = { GITHUB_OUTPUT: join(output, 'output') };
    writeActionsFiles(evidence, env);
    assert.equal(existsSync(env.GITHUB_OUTPUT), false);
  }
});

test('failed logins and pushes always log out and are reconciled only from anonymous reads', SLOW, async (t) => {
  const login = await publicationFixture(t, { docker: { login: 'fail' } });
  assert.equal(login.evidence.error.code, 'login');
  assert.deepEqual(login.commands, ['image load', 'image inspect', 'image tag', 'login ghcr.io', 'logout ghcr.io']);
  assert.equal(existsSync(login.configDirectory), false);

  const absent = await publicationFixture(t, { docker: { push: 'fail' } });
  assert.equal(absent.evidence.error.code, 'push');
  assert.match(absent.evidence.error.message, /tag is absent; re-run/);
  assert.equal(absent.commands.filter(command => command === 'image push').length, 1, 'a failed push is never retried');
  assert.equal(absent.commands.at(-1), 'logout ghcr.io');

  for (const push of ['fail-foreign', 'fail-unknown'] as const) {
    const unknown = await publicationFixture(t, { docker: { push } });
    assert.equal(unknown.evidence.error.code, 'push', push);
    assert.match(unknown.evidence.error.message, /outcome is unknown/);
    assert.equal(unknown.evidence.verification, undefined, 'nothing unknown is verified or attested');
  }

  const uploaded = await publicationFixture(t, { docker: { push: 'fail-after-upload' } });
  assert.equal(uploaded.evidence.passed, true, JSON.stringify(uploaded.evidence.error));
  assert.deepEqual([uploaded.evidence.outcome, uploaded.evidence.digest], ['published', uploaded.image.digest]);
  assert.equal(uploaded.evidence.tagAfterFailedPush.state, 'present');
});

test('docker runs against the runner daemon with a private config and no tokens in its environment', SLOW, async (t) => {
  const directory = temporaryDirectory(t, 'docker-runner');
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const log = join(directory, 'log.json');
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}\nconst fs = require('node:fs');\nlet input = '';\nprocess.stdin.on('data', chunk => input += chunk);\n`
    + `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, input })); });\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const docker = dockerRunner({ env: { PATH: `${bin}:${process.env.PATH}`, REGISTRY_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc' },
    home: join(directory, 'home'), configDirectory: join(directory, 'config') });
  const result = await docker(['login', 'ghcr.io', '--password-stdin'], { timeoutMs: 10_000, input: TOKEN });
  assert.equal(result.exitCode, 0, result.stderr);
  const recorded = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(recorded.args, ['--host', 'unix:///var/run/docker.sock', 'login', 'ghcr.io', '--password-stdin']);
  assert.equal(recorded.input, TOKEN);
  assert.equal(recorded.env.DOCKER_CONFIG, join(directory, 'config'));
  for (const key of ['REGISTRY_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'DOCKER_HOST']) assert.equal(key in recorded.env, false, key);
});

/** Minimal structural reads of the workflow text; the project has no YAML parser dependency. */
function workflowJobs() {
  const text = readFileSync(new URL(WORKFLOW_FILE, ROOT), 'utf8');
  const jobs = Object.fromEntries(text.split(/^ {2}(?=[a-z][a-z-]*:\n)/m).slice(1).map(block => [block.slice(0, block.indexOf(':')), block]));
  return { text, jobs };
}

test('the image workflow is manual, pinned, least-privilege and approval gated', () => {
  const { text, jobs } = workflowJobs();
  assert.deepEqual(Object.keys(jobs), ['build', 'check', 'publish']);
  assert.match(text, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(text, /^\s+(push|pull_request|pull_request_target|schedule|release|workflow_run|repository_dispatch):/m);
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /^concurrency:\n {2}group: image-release\n {2}cancel-in-progress: false$/m);
  assert.match(jobs.build, /permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}actions: read\n {4}outputs:/);
  assert.match(jobs.check, /permissions:\n {6}contents: read\n {4}steps:/);
  assert.match(jobs.publish, /permissions:\n {6}contents: read\n {6}packages: write\n {6}id-token: write\n {6}attestations: write\n {4}steps:/);
  for (const permission of ['packages: write', 'id-token: write', 'attestations: write']) assert.equal(text.split(permission).length - 1, 1, permission);
  assert.doesNotMatch(jobs.build + jobs.check, /environment:/);
  assert.match(jobs.publish, /\n {4}environment: image-release\n/);
  assert.match(jobs.check, /needs: build\n/);
  assert.match(jobs.publish, /needs: \[build, check\]/);
  assert.match(jobs.publish, /inputs\.mode == 'publish' && needs\.build\.outputs\.decision == 'publish'/);
  for (const job of Object.values(jobs)) assert.match(job, /github\.repository == 'manifest-network\/merovingian' && github\.ref == 'refs\/heads\/main'/);
  const code = (job: string) => job.replace(/^\s*#.*$/gm, '');
  const actions = (job: string) => [...code(job).matchAll(/uses: ([^@\s]+)@/g)].map(match => match[1]);
  // Build fixes the published identity: no npm code, working directories or other actions run on its runner.
  assert.doesNotMatch(code(jobs.build), /\bnpm\b|\bnpx\b|\btsx\b|working-directory|^\s+cache:/m);
  assert.deepEqual(actions(jobs.build), ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/upload-artifact']);
  assert.match(jobs.build, /--provenance=false --sbom=false/);
  assert.match(jobs.build, /retention-days: 7\n\s+if-no-files-found: error/);
  // Publish takes identity only from Build; Check's result gates it but none of its values reach it.
  assert.doesNotMatch(jobs.publish, /needs\.check\.outputs/);
  assert.doesNotMatch(jobs.check, /^ {4}outputs:/m);
  assert.match(jobs.check, /sha256sum --check --strict/);
  // The job that can push and mint OIDC tokens runs no packages, caches or source-revision code.
  assert.doesNotMatch(code(jobs.publish), /\bnpm\b|\bnpx\b|^\s+cache:|include-hidden-files|working-directory|ref: \$\{\{ inputs/m);
  assert.deepEqual(actions(jobs.publish), ['actions/checkout', 'actions/setup-node', 'actions/download-artifact', 'actions/attest', 'actions/upload-artifact']);
  assert.match(jobs.publish, /continue-on-error: true\n\s+uses: actions\/download-artifact@/);
  assert.match(jobs.publish, /Remove any registry login\n {8}if: always\(\)/);
  assert.doesNotMatch(jobs.publish, /push-to-registry/);
  for (const [, reference] of text.matchAll(/uses: (\S+)/g)) assert.match(reference, /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
  assert.equal(text.match(/package-manager-cache: false/g)?.length, 3);
  assert.equal(text.match(/persist-credentials: false/g)?.length, 4);
  // Expressions never reach a shell script; inputs travel through env.
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(- )?run:/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length + (match[2] ? 2 : 0);
    for (let next = index; next < lines.length && (next === index || !lines[next].trim() || lines[next].search(/\S/) > indent); next++) {
      assert.doesNotMatch(lines[next], /\$\{\{/, `expression inside run block at line ${next + 1}`);
    }
  }
  assert.match(text, /options:\n {10}- verify\n {10}- publish/);
  assert.match(text, /default: verify/);
  assert.match(text, /^run-name: Image \$\{\{ inputs\.mode \}\} \$\{\{ inputs\.version \}\}$/m);
});
