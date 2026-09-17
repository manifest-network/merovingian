import assert from 'node:assert/strict';
import test from 'node:test';
import type { WalletProvider } from '@manifest-network/manifest-sdk';
import { metaHashHex } from '@manifest-network/manifest-sdk/deploy';
import { createMainnetProvider, mainnetProviderFetch, MAINNET_PROVIDER, MainnetProviderError } from '../scripts/mainnet-provider.js';

const tenant = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const leaseUuid = '01a0b047-b052-7066-be12-9336dc10f8e4';
const manifest = JSON.stringify({ services: { refuge: { image: `ghcr.io/fmorency/merovingian@sha256:${'1'.repeat(64)}` } } });
const hash = await metaHashHex(manifest);
function fixture(overrides: { pending?: Record<string, unknown>; connection?: Record<string, unknown>; health?: Record<string, unknown>; uploadFails?: boolean; ready?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const signed: string[] = [];
  const wallet: WalletProvider = {
    getAddress: async () => tenant,
    getSigner: async () => { throw new Error('transaction signer must never be accessed'); },
    signArbitrary: async (address, data) => {
      assert.equal(address, tenant); signed.push(data);
      return { pub_key: { type: 'tendermint/PubKeySecp256k1', value: Buffer.alloc(33, 1).toString('base64') }, signature: Buffer.alloc(64, 2).toString('base64') };
    },
  };
  let received = false;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    if (url.endsWith('/health')) return Response.json({ status: 'healthy', provider_uuid: MAINNET_PROVIDER.uuid, ...overrides.health });
    if (url.endsWith('/status')) return Response.json({
      state: overrides.ready ? 'LEASE_STATE_ACTIVE' : 'LEASE_STATE_PENDING',
      provision_status: overrides.ready ? 'ready' : 'pending',
      lease_uuid: leaseUuid, tenant, provider_uuid: MAINNET_PROVIDER.uuid,
      meta_hash_hex: hash, payload_received: received, requires_payload: true, provisioning_started: false,
      ...overrides.pending,
    });
    if (url.endsWith('/connection')) return Response.json({ lease_uuid: leaseUuid, tenant, provider_uuid: MAINNET_PROVIDER.uuid,
      connection: { host: '192.168.1.20', fqdn: 'merovingian.manifest.network', metadata: { SECRET: 'should not escape' },
        services: { refuge: { instances: [{ instance_index: 0, container_id: 'private-container-id', image: 'private-image', status: 'running', fqdn: 'refuge-native.barney.manifest.network', ports: { '8080/tcp': { host_ip: '127.0.0.1', host_port: 32768 } } }] } } }, ...overrides.connection });
    if (url.endsWith('/data')) {
      received = true;
      if (overrides.uploadFails) throw new Error('untrusted diagnostic containing a credential');
      return new Response(null, { status: 202 });
    }
    throw new Error('unexpected endpoint');
  };
  return { calls, signed, wallet, client: createMainnetProvider({ wallet, tenant, providerUuid: MAINNET_PROVIDER.uuid, providerUrl: MAINNET_PROVIDER.url, fetch: fetcher }) };
}

test('provider transport refuses other origins, credentials, paths, methods and redirects', async () => {
  let calls = 0;
  const transport = mainnetProviderFetch(async () => { calls++; return new Response(null, { status: 200 }); });
  for (const url of ['http://barney.manifest.network/api/fred/health', 'https://127.0.0.1/api/fred/health',
    'https://user:password@barney.manifest.network/api/fred/health', `${MAINNET_PROVIDER.url}/health?token=secret`,
    `${MAINNET_PROVIDER.url}/v1/leases/${leaseUuid}/restore`, `${MAINNET_PROVIDER.url}/../private`]) {
    await assert.rejects(transport(url), /provider_transport_refused_or_unavailable/);
  }
  await assert.rejects(transport(`${MAINNET_PROVIDER.url}/health`, { method: 'POST' }), /provider_transport_refused_or_unavailable/);
  assert.equal(calls, 0);
  await assert.rejects(mainnetProviderFetch(async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } }))(`${MAINNET_PROVIDER.url}/health`), /provider_transport_refused_or_unavailable/);
});

test('provider UUID, URL, wallet and health identity are checked before signing', async () => {
  const f = fixture();
  assert.throws(() => createMainnetProvider({ wallet: f.wallet, tenant, providerUuid: 'wrong', providerUrl: MAINNET_PROVIDER.url }), /unexpected_mainnet_provider/);
  assert.throws(() => createMainnetProvider({ wallet: f.wallet, tenant, providerUuid: MAINNET_PROVIDER.uuid, providerUrl: `${MAINNET_PROVIDER.url}/` }), /unexpected_mainnet_provider/);
  const unhealthy = fixture({ health: { provider_uuid: 'different-provider' } });
  await assert.rejects(unhealthy.client.status({ leaseUuid }), /provider_identity_or_health_failed/);
  assert.equal(unhealthy.signed.length, 0);
  const wrong = fixture();
  wrong.wallet.getAddress = async () => 'wrong';
  await assert.rejects(wrong.client.status({ leaseUuid }), /provider_wallet_mismatch/);
  assert.equal(wrong.signed.length, 0);
});

test('upload binds exact manifest bytes, lease and hash, and skips an already received payload', async () => {
  const f = fixture();
  await assert.rejects(f.client.upload({ leaseUuid, manifest: `${manifest} `, metaHash: hash }), /provider_manifest_hash_mismatch/);
  assert.equal(f.calls.length, 0);
  const first = await f.client.upload({ leaseUuid, manifest, metaHash: hash });
  assert.equal(first.alreadyPresent, false);
  const dataCalls = f.calls.filter(call => call.url.endsWith('/data'));
  assert.equal(dataCalls.length, 1);
  assert.equal(Buffer.from(dataCalls[0].init.body as Uint8Array).toString('utf8'), manifest);
  const auth = new Headers(dataCalls[0].init.headers).get('Authorization')!;
  const token = JSON.parse(Buffer.from(auth.slice('Bearer '.length), 'base64').toString('utf8'));
  assert.equal(token.lease_uuid, leaseUuid); assert.equal(token.tenant, tenant); assert.equal(token.meta_hash, hash);
  assert.ok(f.signed.some(data => data.startsWith(`manifest lease data ${leaseUuid} ${hash} `)));
  const second = await f.client.upload({ leaseUuid, manifest, metaHash: hash });
  assert.equal(second.alreadyPresent, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/data')).length, 1);
  assert.doesNotMatch(JSON.stringify([first, second]), /signature|pub_key|Authorization/);
});

test('uncertain upload is not retried and subsequent reconciliation discovers accepted data', async () => {
  const f = fixture({ uploadFails: true });
  await assert.rejects(f.client.upload({ leaseUuid, manifest, metaHash: hash }), (error: unknown) => error instanceof MainnetProviderError && error.code === 'provider_upload_indeterminate' && !error.message.includes('credential'));
  assert.equal(f.calls.filter(call => call.url.endsWith('/data')).length, 1);
  assert.equal((await f.client.status({ leaseUuid })).payloadReceived, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/data')).length, 1);
});

test('an attempted upload cannot POST again when reconciliation remains inconclusive', async () => {
  const f = fixture({ uploadFails: true, pending: { payload_received: false } });
  await assert.rejects(f.client.upload({ leaseUuid, manifest, metaHash: hash }), /provider_upload_indeterminate/);
  await assert.rejects(f.client.upload({ leaseUuid, manifest, metaHash: hash }), /provider_upload_requires_reconciliation/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/data')).length, 1);
});

test('upload refuses inconsistent hashes and insufficient reconciliation evidence', async () => {
  for (const pending of [{ meta_hash_hex: 'a'.repeat(64) }, { payload_received: undefined }, { requires_payload: false }, { provisioning_started: true }]) {
    const f = fixture({ pending });
    await assert.rejects(f.client.upload({ leaseUuid, manifest, metaHash: hash }), /provider_lease_manifest_hash_unconfirmed|provider_upload_requires_reconciliation/);
    assert.equal(f.calls.filter(call => call.url.endsWith('/data')).length, 0);
  }
  const closed = fixture({ pending: { state: 'LEASE_STATE_CLOSED', payload_received: true } });
  await assert.rejects(closed.client.upload({ leaseUuid, manifest, metaHash: hash }), /provider_upload_requires_live_lease/);
  assert.equal(closed.calls.filter(call => call.url.endsWith('/data')).length, 0);
});

test('ready projection excludes metadata, credentials, internal IPs and self-referential DNS', async () => {
  const f = fixture({ ready: true, pending: { last_error: 'secret', message: 'secret', unknown: 'secret' } });
  const status = await f.client.status({ leaseUuid });
  assert.equal(status.ready, true);
  assert.deepEqual(status.dnsTargets, [{ type: 'CNAME', value: 'refuge-native.barney.manifest.network' }]);
  assert.ok(status.endpoints.some(value => value.fqdn === 'refuge-native.barney.manifest.network' && value.ports[0]?.containerPort === 8080));
  assert.doesNotMatch(JSON.stringify(status), /secret|private-|192\.168|127\.0|metadata|Authorization|signature/i);
});

test('verified mainnet native routing suffix is allowed while testnet and lookalike suffixes are rejected', async () => {
  for (const native of ['refuge-928a176.barney0.manifest0.net', 'refuge-928a176.barney13.testnet.manifest0.net',
    'testnet.barney13.testnet.manifest0.net', 'refuge-928a176.barney0.manifest0.net.attacker.invalid',
    'refuge-928a176.evilbarney0.manifest0.net']) {
    const f = fixture({ ready: true, connection: { connection: { host: '172.16.0.10', services: { refuge: {
      instances: [{ instance_index: 0, container_id: 'private', image: 'private', status: 'running', fqdn: native }],
    } } } } });
    const status = await f.client.status({ leaseUuid });
    const allowed = native === 'refuge-928a176.barney0.manifest0.net';
    assert.deepEqual(status.dnsTargets, allowed ? [{ type: 'CNAME', value: native }] : []);
    assert.equal(status.endpoints.some(value => value.fqdn === native), allowed);
  }
});

test('mismatched response identities and unknown readiness cannot report success', async () => {
  const bad = fixture({ pending: { tenant: 'someone-else' } });
  await assert.rejects(bad.client.status({ leaseUuid }), /provider_response_identity_mismatch/);
  const connection = fixture({ ready: true, connection: { lease_uuid: 'another-lease' } });
  await assert.rejects(connection.client.status({ leaseUuid }), /provider_connection_identity_mismatch/);
  const unknown = fixture({ ready: true, pending: { provision_status: 'new-state-with-secret' } });
  const status = await unknown.client.status({ leaseUuid });
  assert.equal(status.ready, false); assert.equal(status.provisionStatus, 'unknown');
  assert.doesNotMatch(JSON.stringify(status), /secret/);
});

test('readiness polling caps duration and treats retained or pending states as unready', async () => {
  const f = fixture({ ready: true, pending: { provision_status: 'retained' } });
  await assert.rejects(f.client.waitUntilReady({ leaseUuid, timeoutMs: 55_001 }), /invalid_provider_poll_timeout/);
  const result = await f.client.waitUntilReady({ leaseUuid, timeoutMs: 20 });
  assert.equal(result.ready, false); assert.equal(result.timedOut, true);
  const complete = fixture({ ready: true });
  const ready = await complete.client.waitUntilReady({ leaseUuid, timeoutMs: 5000 });
  assert.equal(ready.ready, true); assert.equal(ready.timedOut, false);
});
