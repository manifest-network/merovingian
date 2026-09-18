import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { OfflineDirectSigner } from '@cosmjs/proto-signing';
import type { WalletProvider } from '@manifest-network/manifest-sdk';
import { MsgCreateLease, MsgSetItemCustomDomain } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js';
import { MAINNET, publicInputs, type Quote } from '../scripts/mainnet-config.js';
import { DOMAIN_PLACEHOLDER_UUID, PREVIEW_MAX_GAS, fetchPublicAccountWallet, prepareDeployment, previewFee, publicAccountWallet, publicSimulationWallet, simulateDeployment } from '../scripts/mainnet-preview.js';

const now = Date.parse('2026-09-17T18:00:00.000Z');
const denom = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
const tenant = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const other = 'manifest1hkmrmsc6zjr7gm2wgtrtce7vgxeq9e402x5rf5';
const image = `ghcr.io/fmorency/merovingian@sha256:${'a'.repeat(64)}`;
const inputs = () => publicInputs({ tenant, image, monthlyBudgetPwr: '5', gasPrice: `0.5${denom}` });
function quote(): Quote {
  return {
    ...MAINNET, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + MAINNET.quoteTtlMs).toISOString(), chainHeight: '123',
    pwr: { denom, display: 'PWR', exponent: 6, sendsEnabled: true }, minimumLeaseSeconds: '3600', minimumGasPrices: `0.37${denom},1umfx`,
    candidates: [{ name: 'docker-nano', skuUuid: '019e6f08-a59a-7001-9f12-3a0963d3f193', providerUuid: '019e6a0d-e141-7000-9e79-e94ac1bd333e', providerUrl: 'https://barney.manifest.network/api/fred', active: true, providerActive: true, providerHealthy: true, providerIdentityMatches: true, unit: 1, denom, priceBasePerHour: '3600', resources: { source: 'https://barney.manifest.network/config.js', cpuCores: 0.5, ramMB: 2048, diskGB: 15, provenance: 'provider-public-advertisement', enforcementVerified: false } }],
    domainClaim: { status: 'unclaimed', leaseUuid: null, tenant: null, reserved: false }, dns: { cname: [], addresses: [], status: 'no_records' },
    tenant: { address: tenant, checkedAt: new Date(now).toISOString(), status: 'available', pwrWalletBase: '35000000', mfxWalletBase: '0', availableCreditBase: '15000000', activeLeaseCount: 0, pendingLeaseCount: 0, liveLeaseUuids: [] },
  };
}

test('SDK manifest and unsigned protobufs bind exact mainnet runtime, image, tenant, service and SHA256 bytes', async () => {
  const prepared = await prepareDeployment(quote(), inputs(), now);
  const encoded = MsgCreateLease.encode(prepared.createLease.value).finish();
  const decoded = MsgCreateLease.decode(encoded);
  assert.equal(decoded.tenant, tenant);
  assert.deepEqual(decoded.items, [{ skuUuid: quote().candidates[0].skuUuid, quantity: 1n, serviceName: 'refuge' }]);
  assert.equal(Buffer.from(decoded.metaHash).toString('hex'), createHash('sha256').update(prepared.manifestJson).digest('hex'));
  const manifest = JSON.parse(prepared.manifestJson);
  assert.equal(manifest.services.refuge.image, image);
  assert.deepEqual(manifest.services.refuge.ports, { '8080/tcp': { ingress: true } });
  assert.equal(manifest.services.refuge.env.REFUGE_TENANT, tenant);
  assert.equal(manifest.services.refuge.env.PUBLIC_ORIGIN, 'https://merovingian.manifest.network');
  assert.equal(manifest.services.refuge.env.CHAIN_ID, 'manifest-ledger-mainnet');
  const domain = MsgSetItemCustomDomain.decode(MsgSetItemCustomDomain.encode(prepared.domain.value).finish());
  assert.deepEqual(domain, { sender: tenant, leaseUuid: DOMAIN_PLACEHOLDER_UUID, serviceName: 'refuge', customDomain: MAINNET.domain });
});

test('preview rejects stale network/price/budget/state inputs before simulation', async () => {
  await assert.rejects(() => prepareDeployment(quote(), inputs(), now + MAINNET.quoteTtlMs), /plan_not_ready/);
  await assert.rejects(() => prepareDeployment({ ...quote(), chainId: 'manifest-ledger-testnet' }, inputs(), now), /invalid_mainnet/);
  await assert.rejects(() => prepareDeployment(quote(), { ...inputs(), image: 'merovingian:latest' }, now), /invalid_mainnet/);
  await assert.rejects(() => prepareDeployment(quote(), { ...inputs(), gasPrice: `0.7${denom}` }, now), /half_base_unit/);
  await assert.rejects(() => prepareDeployment(quote(), { ...inputs(), monthlyBudgetPwr: '2' }, now), /plan_not_ready/);
  const credit = quote(); credit.tenant!.availableCreditBase = '0';
  await assert.rejects(() => prepareDeployment(credit, inputs(), now), /credit_below_minimum/);
  const lease = quote(); lease.tenant!.activeLeaseCount = 1;
  await assert.rejects(() => prepareDeployment(lease, inputs(), now), /plan_not_ready/);
});

test('unsigned preview binds explicit proxy trust into the provider manifest and lease hash', async () => {
  const ordinary = await prepareDeployment(quote(), inputs(), now);
  const trusted = await prepareDeployment(quote(), publicInputs({ ...inputs(), trustedProxyCidrs: '192.0.2.0/24,2001:db8::/64' }), now);
  assert.equal(JSON.parse(trusted.manifestJson).services.refuge.env.TRUSTED_PROXY_CIDRS, '192.0.2.0/24,2001:db8::/64');
  assert.notEqual(trusted.metaHash, ordinary.metaHash);
  assert.equal(Buffer.from(trusted.createLease.value.metaHash).toString('hex'), createHash('sha256').update(trusted.manifestJson).digest('hex'));
});

test('preview gas arithmetic is exact, validates both limits, and refuses excessive or malformed RPC gas', () => {
  assert.deepEqual(previewFee(101, denom), { simulatedGas: '101', gasMultiplier: '1.5', gasLimit: '152', gasPrice: `0.5${denom}`, amountBase: '76', amountPwr: '0.000076', denom });
  assert.equal(previewFee(3, denom).amountBase, '3');
  assert.equal(previewFee(666_666, denom).gasLimit, '999999');
  for (const value of [NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => previewFee(value, denom), /invalid_simulated/);
  assert.throws(() => previewFee(666_667, denom), /ceiling_exceeded/);
  for (const cap of [-1, 0, 1.5, PREVIEW_MAX_GAS + 1]) assert.throws(() => previewFee(10, denom, cap), /invalid_preview_gas/);
});

test('SDK gets an isolated account snapshot and both real signing capabilities remain unreachable', async () => {
  let signingCalls = 0;
  const pubkey = Uint8Array.from([2, ...new Array<number>(32).fill(1)]);
  const source: WalletProvider = {
    getAddress: async () => tenant,
    getSigner: async () => ({ getAccounts: async () => [{ address: tenant, algo: 'secp256k1', pubkey }], signDirect: async () => { signingCalls++; throw new Error('real signer reached'); } }),
    signArbitrary: async () => { signingCalls++; throw new Error('real auth signer reached'); },
  };
  const wallet = await publicSimulationWallet(source, tenant);
  pubkey[1] = 90;
  const signer = await wallet.getSigner() as OfflineDirectSigner;
  const first = (await signer.getAccounts())[0];
  assert.equal(first.pubkey[1], 1);
  first.pubkey[1] = 99;
  assert.equal((await signer.getAccounts())[0].pubkey[1], 1);
  await assert.rejects(() => signer.signDirect(tenant, { bodyBytes: new Uint8Array(), authInfoBytes: new Uint8Array(), chainId: MAINNET.chainId, accountNumber: 0n }), /preview_cannot_sign/);
  await assert.rejects(() => wallet.signArbitrary!(tenant, 'challenge'), /preview_cannot_sign/);
  assert.equal(signingCalls, 0);
  assert.equal(Object.isFrozen(wallet), true);
  assert.equal(Object.isFrozen(signer), true);
  await assert.rejects(() => publicSimulationWallet(source, other), /public_wallet_account_unavailable/);
});

test('account mismatch/multiple accounts fail closed and original provider errors are discarded', async () => {
  const wallet = (address: string, accounts: number): WalletProvider => ({ getAddress: async () => tenant, getSigner: async () => ({ getAccounts: async () => new Array(accounts).fill({ address, algo: 'secp256k1', pubkey: Uint8Array.from([2, ...new Array(32).fill(1)]) }), signDirect: async () => { throw new Error(); } }) });
  await assert.rejects(() => publicSimulationWallet(wallet(other, 1), tenant), /public_wallet_account_mismatch/);
  await assert.rejects(() => publicSimulationWallet(wallet(tenant, 2), tenant), /public_wallet_account_mismatch/);
  await assert.rejects(() => publicSimulationWallet({ getAddress: async () => { throw new Error('sentinel private diagnostic'); }, getSigner: async () => { throw new Error(); } }, tenant), error => error instanceof Error && !error.message.includes('sentinel'));
});

test('domain requires actual UUID; rejected placeholder never invents a combined fee or exposes RPC diagnostics', async () => {
  const prepared = await prepareDeployment({ ...quote(), privateDiagnostic: 'sentinel secret' }, inputs(), now);
  const calls: string[] = [];
  const preview = await simulateDeployment(prepared, async (address, messages, memo) => {
    assert.equal(address, tenant); assert.equal(messages.length, 1); assert.equal(memo, '');
    calls.push(messages[0].typeUrl);
    if (calls.length === 2) throw new Error('sentinel secret from RPC');
    return 200_000;
  }, { now: () => now });
  assert.deepEqual(calls, ['/liftedinit.billing.v1.MsgCreateLease', '/liftedinit.billing.v1.MsgSetItemCustomDomain']);
  assert.equal(preview.createLease.estimatedFee.amountPwr, '0.15');
  assert.equal(preview.customDomain.placeholderSimulation.status, 'rejected_placeholder');
  assert.equal(preview.customDomain.estimatedFee, null);
  assert.equal(preview.totalTransactionFee, null);
  assert.equal(preview.customDomain.mustResimulateAfterLeaseCreated, true);
  assert.equal(preview.customDomain.cloudflareProxyAllowed, false);
  assert.equal(preview.signed, false); assert.equal(preview.broadcast, false); assert.equal(preview.executionAuthorized, false);
  assert.ok(!JSON.stringify(preview).includes('sentinel'));
});

test('even a successful placeholder simulation is not a fee quote for the future lease', async () => {
  const prepared = await prepareDeployment(quote(), inputs(), now);
  const preview = await simulateDeployment(prepared, async () => 200_000, { now: () => now });
  assert.equal(preview.customDomain.placeholderSimulation.estimatedFee?.amountPwr, '0.15');
  assert.equal(preview.customDomain.leaseUuidIsPlaceholder, true);
  assert.equal(preview.customDomain.estimatedFee, null);
  assert.equal(preview.totalTransactionFee, null);
});

test('insufficient fee balance, stale quotes between calls, and create errors stop further estimation', async () => {
  const low = quote(); low.tenant!.pwrWalletBase = '1';
  const prepared = await prepareDeployment(low, inputs(), now);
  let calls = 0;
  const simulate = async () => { calls++; return 200_000; };
  await assert.rejects(() => simulateDeployment(prepared, simulate, { now: () => now }), /wallet_balance_below/);
  assert.equal(calls, 1);
  const funded = await prepareDeployment(quote(), inputs(), now);
  let ticks = 0; calls = 0;
  await assert.rejects(() => simulateDeployment(funded, simulate, { now: () => ticks++ === 0 ? now : now + MAINNET.quoteTtlMs }), /preflight_expired/);
  assert.equal(calls, 1);
  await assert.rejects(() => simulateDeployment(funded, async () => { throw new Error('secret upstream exception'); }, { now: () => now }), error => error instanceof Error && error.message === 'create_lease_simulation_failed');
});

// Standard secp256k1 generator: public mathematical fixture, never a funded key.
const generatorPublicKey = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
const generatorAddress = 'manifest1w508d6qejxtdg4y5r3zarvary0c5xw7kml4dms';
const chainAccount = () => ({ account: {
  '@type': '/cosmos.auth.v1beta1.BaseAccount', address: generatorAddress,
  pub_key: { '@type': '/cosmos.crypto.secp256k1.PubKey', key: generatorPublicKey.toString('base64') },
  account_number: '7', sequence: '1',
} });

test('on-chain public account supplies an isolated public key and can never sign', async () => {
  const wallet = publicAccountWallet(chainAccount(), generatorAddress);
  assert.equal(await wallet.getAddress(), generatorAddress);
  const signer = await wallet.getSigner() as OfflineDirectSigner;
  const account = (await signer.getAccounts())[0];
  assert.deepEqual(Buffer.from(account.pubkey), generatorPublicKey);
  account.pubkey.fill(0);
  assert.deepEqual(Buffer.from((await signer.getAccounts())[0].pubkey), generatorPublicKey);
  await assert.rejects(() => signer.signDirect(generatorAddress, { bodyBytes: new Uint8Array(), authInfoBytes: new Uint8Array(), chainId: MAINNET.chainId, accountNumber: 0n }), /preview_cannot_sign/);
  await assert.rejects(() => wallet.signArbitrary!(generatorAddress, 'local challenge'), /preview_cannot_sign/);
  assert.equal(Object.isFrozen(wallet), true);
});

test('public account validation rejects unsupported wrappers, missing keys, off-curve points and mismatched derivations', () => {
  const invalid: unknown[] = [null, {}, { account: null }, { account: { ...chainAccount().account, '@type': '/cosmos.auth.v1beta1.ModuleAccount' } }];
  for (const patch of [
    { address: tenant }, { pub_key: null }, { account_number: '-1' }, { sequence: '01' },
    { pub_key: { ...chainAccount().account.pub_key, '@type': '/cosmos.crypto.ed25519.PubKey' } },
    { pub_key: { ...chainAccount().account.pub_key, key: `${generatorPublicKey.toString('base64')}=` } },
    { pub_key: { ...chainAccount().account.pub_key, key: ` ${generatorPublicKey.toString('base64')}` } },
    { pub_key: { ...chainAccount().account.pub_key, key: Buffer.from([2, ...new Array(32).fill(255)]).toString('base64') } },
    // Valid opposite-Y point, but it derives a different account address.
    { pub_key: { ...chainAccount().account.pub_key, key: Buffer.from([3, ...generatorPublicKey.subarray(1)]).toString('base64') } },
  ]) invalid.push({ account: { ...chainAccount().account, ...patch } });
  for (const response of invalid) assert.throws(() => publicAccountWallet(response, generatorAddress), error => error instanceof Error && error.message === 'invalid_public_chain_account');
});

function publicFetch(overrides: { network?: string; blockTime?: number; account?: unknown; failAccount?: Response } = {}) {
  const seen: string[] = [];
  const fetcher = (async (input, init) => {
    const url = String(input); seen.push(url);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal instanceof AbortSignal);
    if (url === MAINNET.rpcUrl) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), { jsonrpc: '2.0', id: 1, method: 'status', params: {} });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { node_info: { network: MAINNET.chainId }, sync_info: { catching_up: false, latest_block_height: '123', latest_block_time: new Date(overrides.blockTime ?? now).toISOString() } } });
    }
    assert.equal(init.method, undefined);
    if (url === `${MAINNET.restUrl}/cosmos/base/tendermint/v1beta1/node_info`) return Response.json({ default_node_info: { network: overrides.network ?? MAINNET.chainId } });
    assert.equal(url, `${MAINNET.restUrl}/cosmos/auth/v1beta1/accounts/${generatorAddress}`);
    return overrides.failAccount ?? Response.json(overrides.account ?? chainAccount());
  }) as typeof fetch;
  return { fetcher, seen };
}

test('public source reads only official identity/account endpoints and binds both network identities', async () => {
  const { fetcher, seen } = publicFetch();
  const wallet = await fetchPublicAccountWallet(generatorAddress, fetcher, now);
  assert.equal(await wallet.getAddress(), generatorAddress);
  assert.equal(seen.length, 3);
  await assert.rejects(() => fetchPublicAccountWallet(generatorAddress, publicFetch({ network: 'manifest-ledger-testnet' }).fetcher, now), /network_identity_failed/);
  await assert.rejects(() => fetchPublicAccountWallet(generatorAddress, publicFetch({ blockTime: now - 600_000 }).fetcher, now), /network_identity_failed/);
});

test('public source rejects failed, redirected, malformed and oversized responses with bounded generic diagnostics', async () => {
  for (const response of [new Response('private upstream diagnostic', { status: 500 }), new Response('redirect', { status: 302 }), new Response('not JSON'), new Response('x'.repeat(64 * 1024 + 1))]) {
    await assert.rejects(() => fetchPublicAccountWallet(generatorAddress, publicFetch({ failAccount: response }).fetcher, now), error => error instanceof Error && error.message === 'public_chain_account_query_failed');
  }
  await assert.rejects(() => fetchPublicAccountWallet(generatorAddress, (async () => { throw new Error('secret upstream diagnostic'); }) as typeof fetch, now), error => error instanceof Error && error.message === 'public_chain_account_query_failed');
});
