import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Lease, LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { updateLease } from '@manifest-network/manifest-sdk/deploy';
import { MAINNET } from '../scripts/mainnet-config.js';
import type { LaunchBinding } from '../scripts/mainnet-launch-plan.js';
import { MAINNET_PROVIDER } from '../scripts/mainnet-provider.js';
import { MAINNET_UPDATE_LEASE, PROVIDER_STRIKE_LIMIT, advanceMainnetUpdate, assertMainnetUpdateIntent, assertUpdateHistoryCanProceed, decodeReleaseManifest, mainnetUpdateFetch, parseMainnetUpdateArguments, prepareMainnetUpdate, type MainnetUpdateState, type UpdateObservation } from '../scripts/mainnet-update.js';

const tenant = 'manifest1hkmrmsc6zjr7gm2wgtrtce7vgxeq9e402x5rf5';
const denom = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
const image = (letter: string) => `ghcr.io/fmorency/merovingian@sha256:${letter.repeat(64)}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const manifestJson = JSON.stringify({ services: { refuge: { image: image('a'), ports: { '8080/tcp': { ingress: true } }, env: {
    NETWORK: 'mainnet', CHAIN_ID: MAINNET.chainId, MANIFEST_RPC_URL: MAINNET.rpcUrl, MANIFEST_REST_URL: MAINNET.restUrl,
    MANIFEST_GAS_PRICE: `0.5${denom}`, PWR_DENOM: denom, REFUGE_TENANT: tenant, PUBLIC_ORIGIN: `https://${MAINNET.domain}`, PORT: '8080', NODE_ENV: 'production', TRUST_PROXY_HOPS: '0',
  } } } });
  const binding: LaunchBinding = { chainId: MAINNET.chainId, tenant, image: image('a'), providerUuid: MAINNET_PROVIDER.uuid, providerUrl: MAINNET_PROVIDER.url,
    skuUuid: '019e6f08-a59a-7001-9f12-3a0963d3f193', denom, priceBasePerHour: '3600', monthlyBudgetBase: '5000000', gasPrice: `0.5${denom}`, metaHashHex: hash(manifestJson), inputHash: 'b'.repeat(64) };
  const lease = Lease.fromPartial({ uuid: MAINNET_UPDATE_LEASE, tenant, providerUuid: binding.providerUuid, state: LeaseState.LEASE_STATE_ACTIVE,
    metaHash: Buffer.from(binding.metaHashHex, 'hex'), items: [{ skuUuid: binding.skuUuid, quantity: 1n, serviceName: 'refuge', customDomain: MAINNET.domain, lockedPrice: { amount: '1', denom } }] });
  const current: UpdateObservation = { lease, ready: true, failCount: 0, active: { image: image('a'), manifestJson, manifestHash: hash(manifestJson), version: 1 } };
  const state = prepareMainnetUpdate(binding, current, image('b'));
  return { binding, current, state };
}

test('update preserves original lease, provider, domain and runtime while adding persistent counter path', () => {
  const { current, binding, state } = fixture();
  assert.equal(state.leaseUuid, MAINNET_UPDATE_LEASE); assert.deepEqual(state.binding, binding);
  assert.equal(state.beforeManifestHash, current.active!.manifestHash);
  const service = JSON.parse(state.manifestJson).services.refuge;
  assert.equal(service.image, image('b')); assert.equal(service.user, '1000:1000');
  assert.equal(service.env.VISIT_COUNTS_PATH, '/data/visits.sqlite');
  assert.equal(service.env.PUBLIC_ORIGIN, `https://${MAINNET.domain}`);
  assert.equal(service.env.REFUGE_TENANT, tenant);
  assert.equal('volumes' in service, false); // Docker image VOLUME controls Fred persistence.
  assert.equal(state.manifestHash, hash(state.manifestJson));
  assert.equal(prepareMainnetUpdate(binding, current, image('b').replace('/fmorency/', '/manifest-network/')).image, image('b').replace('/fmorency/', '/manifest-network/'));
  assert.throws(() => prepareMainnetUpdate(binding, current, 'merovingian:latest'), /invalid_update_configuration/);
  assert.throws(() => prepareMainnetUpdate(binding, current, image('b').replace('/fmorency/', '/unapproved/')), /invalid_update_configuration/);
});

test('update refuses other lease identities, domain changes, price changes and non-reviewed environment keys', () => {
  const { binding, current } = fixture();
  for (const mutate of [
    (value: UpdateObservation) => { value.lease.uuid = '019e6f08-a59a-7001-9f12-3a0963d3f193'; },
    (value: UpdateObservation) => { value.lease.items[0].customDomain = ''; },
    (value: UpdateObservation) => { value.lease.items[0].lockedPrice.amount = '2'; },
    (value: UpdateObservation) => { value.lease.state = LeaseState.LEASE_STATE_CLOSED; },
    (value: UpdateObservation) => { const raw = JSON.parse(value.active!.manifestJson); raw.services.refuge.env.SECRET = 'do-not-publish'; value.active!.manifestJson = JSON.stringify(raw); value.active!.manifestHash = hash(value.active!.manifestJson); },
  ]) {
    const changed = structuredClone(current); mutate(changed);
    assert.throws(() => prepareMainnetUpdate(binding, changed, image('b')));
  }
});

test('image update preserves, replaces or explicitly clears validated existing proxy trust', () => {
  const { binding, current } = fixture();
  const raw = JSON.parse(current.active!.manifestJson);
  raw.services.refuge.env.TRUSTED_PROXY_CIDRS = '192.0.2.0/24';
  current.active!.manifestJson = JSON.stringify(raw);
  current.active!.manifestHash = hash(current.active!.manifestJson);
  const preserve = prepareMainnetUpdate(binding, current, image('b'));
  assert.equal(JSON.parse(preserve.manifestJson).services.refuge.env.TRUSTED_PROXY_CIDRS, '192.0.2.0/24');
  const replace = prepareMainnetUpdate(binding, current, image('b'), { trustedProxyCidrs: ' 192.0.2.12,2001:db8::/64 ' });
  assert.equal(JSON.parse(replace.manifestJson).services.refuge.env.TRUSTED_PROXY_CIDRS, '192.0.2.12,2001:db8::/64');
  assert.equal(replace.manifestHash, hash(replace.manifestJson));
  assert.notEqual(replace.manifestHash, preserve.manifestHash);
  const clear = prepareMainnetUpdate(binding, current, image('b'), { trustedProxyCidrs: '' });
  assert.equal('TRUSTED_PROXY_CIDRS' in JSON.parse(clear.manifestJson).services.refuge.env, false);
  assert.equal(JSON.parse(clear.manifestJson).services.refuge.env.TRUST_PROXY_HOPS, '0');
  assert.throws(() => prepareMainnetUpdate(binding, current, current.active!.image, { trustedProxyCidrs: '' }), /requested_image_already_active/);
  for (const value of ['0.0.0.0/1', '192.0.2.0/23', '2001:db8::/63', '::ffff:192.0.2.0/120', 'proxy.example.com']) {
    assert.throws(() => prepareMainnetUpdate(binding, current, image('b'), { trustedProxyCidrs: value }), /invalid_update_configuration/);
    raw.services.refuge.env.TRUSTED_PROXY_CIDRS = value;
    const text = JSON.stringify(raw);
    assert.throws(() => prepareMainnetUpdate(binding, { ...current, active: { ...current.active!, manifestJson: text, manifestHash: hash(text) } }, image('b')), /update_manifest_not_in_reviewed_scope/);
  }
});

test('modern manifests without legacy hop counts remain within the reviewed update scope', () => {
  const { binding, current } = fixture();
  const raw = JSON.parse(current.active!.manifestJson);
  delete raw.services.refuge.env.TRUST_PROXY_HOPS;
  raw.services.refuge.env.TRUSTED_PROXY_CIDRS = '192.0.2.10';
  current.active!.manifestJson = JSON.stringify(raw);
  current.active!.manifestHash = hash(current.active!.manifestJson);
  const state = prepareMainnetUpdate(binding, current, image('b'));
  assert.equal(JSON.parse(state.manifestJson).services.refuge.env.TRUSTED_PROXY_CIDRS, '192.0.2.10');
  assert.equal('TRUST_PROXY_HOPS' in JSON.parse(state.manifestJson).services.refuge.env, false);
});

test('update CLI accepts explicit clear and rejects malformed or ambiguous proxy arguments', () => {
  const args = ['prepare', '--image', image('b'), '--helper', 'fixture-helper', '--home', 'fixture-home', '--key-name', 'fixture-key'];
  assert.equal(parseMainnetUpdateArguments(args).trustedProxyCidrs, undefined);
  assert.equal(parseMainnetUpdateArguments([...args, '--trusted-proxy-cidrs', ' 192.0.2.10 ']).trustedProxyCidrs, '192.0.2.10');
  assert.equal(parseMainnetUpdateArguments([...args, '--trusted-proxy-cidrs', '']).trustedProxyCidrs, '');
  for (const extra of [ ['--trusted-proxy-cidrs'], ['--trusted-proxy-cidrs', '0.0.0.0/1'], ['--trusted-proxy-cidrs', '192.0.2.10', '--trusted-proxy-cidrs', ''], ['--unknown', '192.0.2.10'] ]) {
    assert.throws(() => parseMainnetUpdateArguments([...args, ...extra]));
  }
  assert.throws(() => parseMainnetUpdateArguments(['prepare', '--image', image('b'), '--helper', '', '--home', 'fixture-home', '--key-name', 'fixture-key']));
});

test('resumed update intent rejects a conflicting explicit proxy flag without changing reviewed bytes', () => {
  const { binding, current, state: legacy } = fixture();
  assert.doesNotThrow(() => assertMainnetUpdateIntent(legacy));
  assert.doesNotThrow(() => assertMainnetUpdateIntent(legacy, ''));
  assert.throws(() => assertMainnetUpdateIntent(legacy, '192.0.2.10'), /conflicts_with_journal/);
  const state = prepareMainnetUpdate(binding, current, image('b'), { trustedProxyCidrs: '192.0.2.10' });
  const original = structuredClone(state);
  assert.doesNotThrow(() => assertMainnetUpdateIntent(state));
  assert.doesNotThrow(() => assertMainnetUpdateIntent(state, ' 192.0.2.10,192.0.2.10 '));
  for (const phase of ['prepared', 'attempted', 'accepted', 'uncertain', 'ready'] as const) {
    assert.throws(() => assertMainnetUpdateIntent({ ...state, phase }, '192.0.2.11'), /conflicts_with_journal/);
    assert.throws(() => assertMainnetUpdateIntent({ ...state, phase }, ''), /conflicts_with_journal/);
  }
  assert.deepEqual(state, original);
  assert.throws(() => assertMainnetUpdateIntent({ ...state, manifestJson: state.manifestJson + ' ' }, '192.0.2.10'), /update_intent_changed/);
});

test('update attempt is persisted before the one POST and readiness requires matching authoritative release', async () => {
  const { current, state } = fixture();
  let posted = false, posts = 0;
  const saved: MainnetUpdateState[] = [];
  const result = await advanceMainnetUpdate(state, {
    observe: async () => posted ? { ...current, active: { image: state.image, manifestJson: state.manifestJson, manifestHash: state.manifestHash, version: 2 } } : current,
    save: async value => { saved.push(structuredClone(value)); },
    post: async input => { assert.equal(saved.at(-1)?.phase, 'attempted'); assert.equal(input.leaseUuid, MAINNET_UPDATE_LEASE); assert.equal(input.manifestJson, state.manifestJson); posted = true; posts++; },
  }, true, 10);
  assert.equal(result.phase, 'ready'); assert.equal(posts, 1);
  assert.deepEqual(saved.map(item => item.phase), ['attempted', 'accepted', 'ready']);
  assert.equal(result.observed?.activeReleaseVersion, 2);
});

test('ambiguous update never repeats its POST on resume and can reconcile a later successful release', async () => {
  const { current, state } = fixture();
  let now = Date.now(), posts = 0;
  const deps = { observe: async () => current, save: async (_: MainnetUpdateState) => {}, post: async () => { posts++; throw new Error('secret provider diagnostic'); }, now: () => now, wait: async (ms: number) => { now += ms; } };
  const unknown = await advanceMainnetUpdate(state, deps, true, 10);
  assert.equal(unknown.phase, 'uncertain'); assert.equal(posts, 1);
  const again = await advanceMainnetUpdate(unknown, deps, true, 10);
  assert.equal(again.phase, 'uncertain'); assert.equal(posts, 1);
  const done = await advanceMainnetUpdate(again, { ...deps, observe: async () => ({ ...current, active: { image: state.image, manifestJson: state.manifestJson, manifestHash: state.manifestHash, version: 2 } }) }, false, 10);
  assert.equal(done.phase, 'ready'); assert.equal(posts, 1);
  assert.ok(!JSON.stringify(done).includes('secret'));
  assert.throws(() => assertUpdateHistoryCanProceed([unknown], image('c')), /another_unresolved_update/);
  assert.doesNotThrow(() => assertUpdateHistoryCanProceed([unknown], unknown.image));
  assert.doesNotThrow(() => assertUpdateHistoryCanProceed([done], image('c')));
});

test('updates stop while a failed update could use the last provider strike', async () => {
  const { binding, current, state } = fixture();
  assert.equal(PROVIDER_STRIKE_LIMIT, 3);
  assert.doesNotThrow(() => prepareMainnetUpdate(binding, { ...current, failCount: 1 }, image('b')));
  for (const failCount of [2, 3]) {
    assert.throws(() => prepareMainnetUpdate(binding, { ...current, failCount }, image('b')), /update_blocked_last_provider_strike/);
  }
  // A journal prepared earlier re-checks the fresh count before its only POST.
  let posts = 0;
  const deps = { observe: async () => ({ ...current, failCount: 2 }), save: async (_: MainnetUpdateState) => {}, post: async () => { posts++; } };
  await assert.rejects(() => advanceMainnetUpdate(state, deps, true, 10), /update_blocked_last_provider_strike/);
  assert.equal(posts, 0);
  // Status still observes and records the count without posting.
  const observed = await advanceMainnetUpdate(state, deps, false, 10);
  assert.equal(observed.phase, 'prepared'); assert.equal(observed.observed?.failCount, 2); assert.equal(posts, 0);
});

test('journals written before the fail count was recorded still reconcile', async () => {
  const { current, state } = fixture();
  const legacy = { ...state, phase: 'uncertain' as const, observed: { activeImage: current.active!.image, activeManifestHash: current.active!.manifestHash, activeReleaseVersion: 1, ready: true } };
  const done = await advanceMainnetUpdate(legacy, {
    observe: async () => ({ ...current, active: { image: state.image, manifestJson: state.manifestJson, manifestHash: state.manifestHash, version: 2 } }),
    save: async () => {}, post: async () => { assert.fail('reconciliation must not post'); },
  }, false, 10);
  assert.equal(done.phase, 'ready'); assert.equal(done.observed?.failCount, 0);
});

test('a competing active manifest or changed persisted intent requires manual reconciliation', async () => {
  const { current, state } = fixture(); let posts = 0;
  const changed = structuredClone(current);
  const raw = JSON.parse(changed.active!.manifestJson); raw.services.refuge.image = image('c');
  changed.active = { image: image('c'), manifestJson: JSON.stringify(raw), manifestHash: hash(JSON.stringify(raw)), version: 2 };
  const deps = { observe: async () => changed, save: async (_: MainnetUpdateState) => {}, post: async () => { posts++; } };
  await assert.rejects(() => advanceMainnetUpdate(state, deps, true, 10), /another_update/);
  await assert.rejects(() => advanceMainnetUpdate({ ...state, manifestJson: `${state.manifestJson} ` }, deps, true, 10), /update_intent_changed/);
  assert.equal(posts, 0);
});

test('provider update transport binds exact host/lease/method and stable idempotency key without redirects', async () => {
  const operation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const observed: { url: string; headers: Headers }[] = [];
  const transport = mainnetUpdateFetch(operation, (async (input, init) => { assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); observed.push({ url: String(input), headers: new Headers(init?.headers) }); return Response.json({ status: 'updating' }); }) as typeof fetch);
  const url = `${MAINNET_PROVIDER.url}/v1/leases/${MAINNET_UPDATE_LEASE}/update`;
  await transport(url, { method: 'POST', headers: { Authorization: 'Bearer local-test-only' } });
  assert.equal(observed[0].headers.get('Idempotency-Key'), operation);
  for (const bad of [url.replace('barney.manifest.network', 'example.com'), url.replace(MAINNET_UPDATE_LEASE, '019e6f08-a59a-7001-9f12-3a0963d3f193'), `${url}?token=no`, url.replace('/update', '/restore'), url.replace('https:', 'http:')]) await assert.rejects(() => transport(bad, { method: 'POST' }), /transport_refused/);
  await assert.rejects(() => transport(url), /transport_refused/);
  const redirected = mainnetUpdateFetch(operation, (async () => new Response('', { status: 302 })) as typeof fetch);
  await assert.rejects(() => redirected(url, { method: 'POST' }), /transport_refused/);
  assert.equal(observed.length, 1);
});

test('SDK updateLease sends one journal Idempotency-Key, no redirects and the exact manifest through the update transport', async () => {
  // Wire-level regression for SDK upgrades: the SDK builds the request and the
  // repository transport adds the journaled key. Fred v0.13 ignores the key;
  // later Fred requires exactly one canonical UUIDv4.
  const operation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const manifest = JSON.stringify({ services: { refuge: { image: 'fixture' } } });
  const observed: { url: string; init: RequestInit; headers: Headers }[] = [];
  const transport = mainnetUpdateFetch(operation, (async (input, init) => {
    observed.push({ url: String(input), init: init!, headers: new Headers(init?.headers) });
    return Response.json({ status: 'updating' });
  }) as typeof fetch);
  const response = await updateLease(MAINNET_PROVIDER.url, MAINNET_UPDATE_LEASE, new TextEncoder().encode(manifest), 'local-test-only', transport);
  assert.equal(response.status, 'updating');
  assert.equal(observed.length, 1);
  const [{ url, init, headers }] = observed;
  assert.equal(url, `${MAINNET_PROVIDER.url}/v1/leases/${MAINNET_UPDATE_LEASE}/update`);
  assert.deepEqual([init.method, init.redirect, init.credentials, init.cache], ['POST', 'error', 'omit', 'no-store']);
  assert.equal(headers.get('Idempotency-Key'), operation);
  assert.equal(headers.get('Authorization'), 'Bearer local-test-only');
  assert.deepEqual(JSON.parse(String(init.body)), { payload: Buffer.from(manifest).toString('base64') });
});

test('published release byte encoding is bounded and canonical; malformed manifests never enter a journal', () => {
  const { current } = fixture(); const encoded = Buffer.from(current.active!.manifestJson).toString('base64');
  assert.equal(decodeReleaseManifest(encoded), current.active!.manifestJson);
  for (const input of [` ${encoded}`, `${encoded}=`, 'private error', 'A'.repeat(100_000), Buffer.from([0xff, 0xfe]).toString('base64')]) assert.throws(() => decodeReleaseManifest(input), /invalid_provider_release_manifest/);
});
