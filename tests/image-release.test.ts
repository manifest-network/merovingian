import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkImageIdentity, decidePush, describeManifest, dockerRunner, ENVIRONMENT, IMAGE, IMAGE_NAME, lookupTag, parseArgs,
  renderSummary, request, runCandidate, runPreflight, runPublication, SOURCE_URL, verifyPublished, WORKFLOW_FILE,
  writeActionsFiles, type Docker, type ProcessResult,
} from '../scripts/image-release.mjs';
import { checkDispatch, REPOSITORY } from '../scripts/registry-publication.mjs';

const ROOT = new URL('../', import.meta.url);
const VERSION = '0.4.7';
const REGISTRY = 'https://ghcr.test';
const CDN = 'https://pkg-containers.test';
const TOKEN = 'workflow-registry-token-secret';
const FAST = { requestMs: 2_000, dockerMs: 5_000, saveMs: 5_000, loadMs: 5_000, pushMs: 5_000, verifyAttempts: 2, verifyIntervalMs: 1 };
const SLOW = { timeout: 120_000 };
const DOCKER_V2 = 'application/vnd.docker.distribution.manifest.v2+json';
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const digestOf = (bytes: string | Buffer) => `sha256:${sha256(bytes)}`;

function temporaryDirectory(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `merovingian-${prefix}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** One image as the Verify job sees it: labelled config, two layers and the pushed manifest. */
function imageFixture(sourceRevision: string, changes: { architecture?: string; revision?: string } = {}) {
  // Like a real image configuration, the config lists every layer's diff ID, so its digest binds the content.
  const layers = [randomBytes(64), randomBytes(32)];
  const config = Buffer.from(JSON.stringify({ architecture: changes.architecture ?? 'amd64', os: 'linux',
    config: { Labels: { 'org.opencontainers.image.revision': changes.revision ?? sourceRevision, 'org.opencontainers.image.version': VERSION,
      'org.opencontainers.image.source': SOURCE_URL } },
    rootfs: { type: 'layers', diff_ids: layers.map(layer => digestOf(layer)) } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: DOCKER_V2,
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: digestOf(config), size: config.length },
    layers: layers.map(layer => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: digestOf(layer), size: layer.length })) }));
  const blobs = new Map([[digestOf(config), config], ...layers.map(layer => [digestOf(layer), layer] as [string, Buffer])]);
  return { config, configDigest: digestOf(config), manifest, digest: digestOf(manifest), blobs,
    inspect: { Id: digestOf(config), Os: 'linux', Architecture: changes.architecture ?? 'amd64',
      Config: { Labels: JSON.parse(config.toString()).config.Labels } } };
}
type Image = ReturnType<typeof imageFixture>;

interface Call { url: string; method: string; authorization: string | null }

/** In-memory GHCR: anonymous tokens, typed 404s, digest headers and signed-URL blob redirects. */
function registryFixture(options: { tags?: Record<string, Image>; token?: 'ok' | 'denied'; untyped404?: boolean; missingLayer?: boolean } = {}) {
  const tags = new Map(Object.entries(options.tags ?? {}));
  const manifests = new Map<string, Image>();
  const blobs = new Map<string, Buffer>();
  const publish = (tag: string, image: Image) => {
    tags.set(tag, image); manifests.set(image.digest, image);
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
    if (url.origin === CDN) {
      const bytes = blobs.get(url.pathname.slice('/blob/'.length));
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response('gone', { status: 404 });
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
      const image = tags.get(reference) ?? manifests.get(reference);
      if (!image) {
        return options.untyped404 ? new Response('not found', { status: 404 })
          : Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] }, { status: 404 });
      }
      return new Response(new Uint8Array(image.manifest), { status: 200, headers: { 'content-type': DOCKER_V2, 'docker-content-digest': image.digest } });
    }
    const blobPath = `/v2/${IMAGE_NAME}/blobs/`;
    if (url.pathname.startsWith(blobPath)) {
      const digest = url.pathname.slice(blobPath.length);
      const bytes = blobs.get(digest);
      if (!bytes) return Response.json({ errors: [{ code: 'BLOB_UNKNOWN' }] }, { status: 404 });
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } });
      return new Response(null, { status: 307, headers: { location: `${CDN}/blob/${digest}?signature=short-lived` } });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, publish, tags };
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
  return { directory, cwd, release, head, side };
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

/** Scripted docker: records every call; secrets may arrive only on stdin. */
function dockerFixture(t: TestContext, image: Image, registry: ReturnType<typeof registryFixture>, behavior: Partial<Record<'load' | 'login' | 'push' | 'pushPublishes' | 'inspect', string>> = {}) {
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
      writeFileSync(args[args.indexOf('--output') + 1], 'saved image bytes');
      return ok();
    }
    if (command === 'image' && subcommand === 'load') return behavior.load === 'fail' ? failed('Error: invalid tar header') : ok(`Loaded image ID: ${image.inspect.Id}\n`);
    if (command === 'image' && subcommand === 'tag') return ok();
    if (command === 'login') return behavior.login === 'fail' ? failed('Error response from daemon: denied') : ok('Login Succeeded\n');
    if (command === 'image' && subcommand === 'push') {
      if (behavior.push === 'fail' || behavior.push === 'fail-after-upload') {
        if (behavior.push === 'fail-after-upload') registry.publish(VERSION, image);
        return failed('error parsing HTTP 502 response body');
      }
      registry.publish(VERSION, image);
      return ok(`The push refers to repository [${IMAGE}]\n${VERSION}: digest: ${image.digest} size: ${image.manifest.length}\n`);
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
  for (const args of [[], ['status'], publish.slice(0, -2), [...publish, '--registry', 'http://example.invalid'],
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
  ];
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
  assert.deepEqual(verified.layers.map((layer: { anonymousAccess: boolean }) => layer.anonymousAccess), [true, true]);
  // The signed blob URL receives no credentials, not even the anonymous pull token.
  const cdn = registry.calls.filter(call => call.url.startsWith(CDN));
  assert.equal(cdn.length, 1);
  assert.equal(cdn[0].authorization, null);

  const other = imageFixture(source);
  const cases: [Parameters<typeof verifyPublished>[0], RegExp][] = [
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: other.configDigest, fetch: registry.fetch }, /differs from the verified candidate/],
    [{ registry: REGISTRY, version: VERSION, digest: other.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image, other } }).fetch }, /pushed digest/],
    [{ registry: REGISTRY, version: VERSION, digest: image.digest, configDigest: image.configDigest, fetch: registryFixture({ tags: { [VERSION]: image }, missingLayer: true }).fetch }, /not anonymously readable/],
    [{ registry: REGISTRY, version: VERSION, digest: null, configDigest: image.configDigest, fetch: registry.fetch }, /no pushed digest/],
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

async function candidateFixture(t: TestContext, changes: { runtime?: Record<string, unknown>; policy?: Record<string, unknown>; provenance?: Record<string, unknown>;
  preflight?: Record<string, unknown>; image?: Image } = {}) {
  const directory = temporaryDirectory(t, 'image-candidate');
  const source = 'a'.repeat(40);
  const image = changes.image ?? imageFixture(source);
  const scan = join(directory, 'scan');
  mkdirSync(scan);
  writeFileSync(join(directory, 'preflight.json'), JSON.stringify({ passed: true, version: VERSION, mode: 'publish', decision: 'publish',
    source: { revision: source, releaseCommit: true }, ...changes.preflight }));
  writeFileSync(join(directory, 'image-id'), `${image.inspect.Id}\n`);
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ passed: true, imageId: image.inspect.Id, checkedAt: 't',
    completedChecks: ['image-metadata'], applicationFilesChecked: 9, appArmor: { status: 'unavailable' }, ...changes.runtime }));
  writeFileSync(join(scan, 'policy.json'), JSON.stringify({ passed: true, imageId: image.configDigest, blocked: [], accepted: [],
    reported: [{ advisory: 'CVE-2025-14505', severity: 'LOW' }], scannerVersion: '0.74.0', ...changes.policy }));
  writeFileSync(join(scan, 'scan-provenance.json'), JSON.stringify({ localImageId: image.inspect.Id, configurationDigest: image.configDigest, ...changes.provenance }));
  const evidence = await runCandidate({ version: VERSION, sourceRevision: source, context: CONTEXT('b'.repeat(40)), outputDirectory: directory,
    docker: dockerFixture(t, image, registryFixture()).docker, imageIdFile: join(directory, 'image-id'),
    runtimeReport: join(directory, 'runtime.json'), scanDirectory: scan, timeouts: FAST });
  return { evidence, directory, image };
}

test('the candidate binds runtime and advisory reports to one labelled image and saves its exact bytes', SLOW, async (t) => {
  const { evidence, directory, image } = await candidateFixture(t);
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.deepEqual([evidence.image.imageId, evidence.image.configDigest, evidence.decision], [image.inspect.Id, image.configDigest, 'publish']);
  assert.deepEqual(evidence.archive, { name: 'image.tar', sha256: sha256('saved image bytes'), bytes: 17 });
  assertPublicEvidence(join(directory, 'candidate.json'));
  const env = { GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') };
  writeActionsFiles(evidence, env);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    `decision=publish\nimage_id=${image.inspect.Id}\nconfig_digest=${image.configDigest}\narchive_sha256=${sha256('saved image bytes')}\n`);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\*\*awaiting-approval\*\*/);

  const other = `sha256:${'3'.repeat(64)}`;
  for (const [changes, code] of [
    [{ runtime: { imageId: other } }, 'runtime'], [{ runtime: { passed: false } }, 'runtime'],
    [{ policy: { passed: false } }, 'scan'], [{ policy: { blocked: [{ advisory: 'CVE-1' }] } }, 'scan'],
    [{ provenance: { localImageId: other } }, 'scan'], [{ policy: { imageId: other } }, 'scan'],
    [{ preflight: { passed: false } }, 'input'], [{ preflight: { decision: 'refuse' } }, 'input'],
    [{ image: imageFixture('a'.repeat(40), { revision: 'c'.repeat(40) }) }, 'image'],
  ] as [Parameters<typeof candidateFixture>[1], string][]) {
    const failed = await candidateFixture(t, changes);
    assert.equal(failed.evidence.passed, false);
    assert.equal(failed.evidence.error.code, code, JSON.stringify([changes, failed.evidence.error]));
    writeActionsFiles(failed.evidence, env);
  }
  assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8').split('\n').length, 5, 'failed candidates set no outputs');
});

async function publicationFixture(t: TestContext, options: { tags?: Record<string, 'same' | 'other'>; docker?: Parameters<typeof dockerFixture>[3];
  archive?: string; registry?: Parameters<typeof registryFixture>[0] } = {}) {
  const repo = repositoryFixture(t);
  git(repo.cwd, 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/merovingian/main');
  const image = imageFixture(repo.release);
  const tags = Object.fromEntries(Object.entries(options.tags ?? {}).map(([tag, kind]) => [tag, kind === 'same' ? image : imageFixture(repo.release)]));
  const registry = registryFixture({ ...options.registry, tags });
  const docker = dockerFixture(t, image, registry, options.docker);
  const archive = join(repo.directory, 'image.tar');
  writeFileSync(archive, options.archive ?? 'verified image bytes');
  const configDirectory = join(repo.directory, 'image-release-docker-config');
  mkdirSync(configDirectory);
  const output = join(repo.directory, 'publication');
  const evidence = await runPublication({ cwd: repo.cwd, version: VERSION, sourceRevision: repo.release, context: CONTEXT(repo.head),
    outputDirectory: output, docker: docker.docker, imageId: image.inspect.Id, configDigest: image.configDigest,
    archiveSha256: sha256('verified image bytes'), archive, dockerConfigDirectory: configDirectory, token: TOKEN, username: 'release-operator',
    registry: REGISTRY, fetch: registry.fetch, refreshMain: () => {}, timeouts: FAST, sleep: async () => {} });
  const commands = docker.calls.map(call => call.args.slice(0, 2).join(' '));
  return { evidence, image, commands, calls: docker.calls, configDirectory, output };
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

test('publication refuses changed bytes or a conflicting tag before any login', SLOW, async (t) => {
  const changed = await publicationFixture(t, { archive: 'different bytes' });
  assert.deepEqual([changed.evidence.error.code, changed.commands], ['archive', []]);
  const conflict = await publicationFixture(t, { tags: { [VERSION]: 'other' } });
  assert.deepEqual([conflict.evidence.error.code, conflict.commands], ['tag-conflict', []]);
  const unknown = await publicationFixture(t, { registry: { untyped404: true } });
  assert.deepEqual([unknown.evidence.error.code, unknown.commands], ['registry', []]);
  const failedLoad = await publicationFixture(t, { docker: { load: 'fail' } });
  assert.deepEqual([failedLoad.evidence.error.code, failedLoad.commands], ['image', ['image load']]);
});

test('a re-run after a completed push verifies the same image without logging in again', SLOW, async (t) => {
  const { evidence, image, commands } = await publicationFixture(t, { tags: { [VERSION]: 'same' } });
  assert.equal(evidence.passed, true, JSON.stringify(evidence.error));
  assert.deepEqual([evidence.outcome, evidence.digest, commands], ['already-published', image.digest, []]);
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
  assert.deepEqual(Object.keys(jobs), ['verify', 'publish']);
  assert.match(text, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(text, /^\s+(push|pull_request|pull_request_target|schedule|release|workflow_run|repository_dispatch):/m);
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /^concurrency:\n {2}group: image-release\n {2}cancel-in-progress: false$/m);
  assert.match(jobs.verify, /permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}actions: read\n {4}outputs:/);
  assert.match(jobs.publish, /permissions:\n {6}contents: read\n {6}packages: write\n {6}id-token: write\n {6}attestations: write\n {4}steps:/);
  for (const permission of ['packages: write', 'id-token: write', 'attestations: write']) assert.equal(text.split(permission).length - 1, 1, permission);
  assert.doesNotMatch(jobs.verify, /environment:/);
  assert.match(jobs.publish, /\n {4}environment: image-release\n/);
  assert.match(jobs.publish, /needs: verify/);
  assert.match(jobs.publish, /inputs\.mode == 'publish' && needs\.verify\.outputs\.decision == 'publish'/);
  for (const job of Object.values(jobs)) assert.match(job, /github\.repository == 'manifest-network\/merovingian' && github\.ref == 'refs\/heads\/main'/);
  // The job that can push and mint OIDC tokens runs no packages, caches or source-revision code.
  const publishCode = jobs.publish.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(publishCode, /\bnpm\b|\bnpx\b|^\s+cache:|include-hidden-files|working-directory/m);
  assert.deepEqual([...publishCode.matchAll(/uses: ([^@\s]+)@/g)].map(match => match[1]),
    ['actions/checkout', 'actions/setup-node', 'actions/download-artifact', 'actions/attest', 'actions/upload-artifact']);
  assert.match(jobs.publish, /Remove any registry login\n {8}if: always\(\)/);
  assert.doesNotMatch(jobs.publish, /push-to-registry/);
  for (const [, reference] of text.matchAll(/uses: (\S+)/g)) assert.match(reference, /^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
  assert.equal(text.match(/package-manager-cache: false/g)?.length, 2);
  assert.equal(text.match(/persist-credentials: false/g)?.length, 2);
  // Only the preflight's verified checkout runs source-revision code, and only in the read-only job.
  assert.ok(jobs.verify.indexOf('image-release.mjs preflight') < jobs.verify.indexOf('working-directory'));
  assert.match(jobs.verify, /--provenance=false --sbom=false/);
  assert.match(jobs.verify, /if: steps\.candidate\.outputs\.decision == 'publish'\n\s+uses: actions\/upload-artifact@/);
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
