import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  MAINNET, advertisedResources, assertIdentity, buildPlan, chooseCandidate,
  mainnetPaths, publicInputs, type Candidate, type Quote,
} from '../scripts/mainnet-config.js';

const now = Date.parse('2026-09-17T18:00:00.000Z');
const denom = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
const tenant = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const image = `ghcr.io/fmorency/merovingian@sha256:${'a'.repeat(64)}`;
const candidate: Candidate = {
  name: 'docker-nano', skuUuid: '019e6f08-a59a-7001-9f12-3a0963d3f193', providerUuid: '019e6a0d-e141-7000-9e79-e94ac1bd333e',
  providerUrl: 'https://barney.manifest.network/api/fred', active: true, providerActive: true, providerHealthy: true, providerIdentityMatches: true,
  unit: 1, denom, priceBasePerHour: '3600', resources: { source: 'https://barney.manifest.network/config.js', cpuCores: 0.5, ramMB: 2048, diskGB: 15, provenance: 'provider-public-advertisement', enforcementVerified: false },
};
function quote(patch: Partial<Quote> = {}): Quote {
  return {
    ...MAINNET, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + MAINNET.quoteTtlMs).toISOString(), chainHeight: '123',
    pwr: { denom, display: 'PWR', exponent: 6, sendsEnabled: true }, minimumLeaseSeconds: '3600',
    minimumGasPrices: `0.370000000000000000${denom},1.000000000000000000umfx`, candidates: [{ ...candidate }],
    domainClaim: { status: 'unclaimed', leaseUuid: null, tenant: null, reserved: false }, dns: { cname: [], addresses: [], status: 'no_records' },
    tenant: { address: tenant, checkedAt: new Date(now).toISOString(), status: 'available', pwrWalletBase: '0', mfxWalletBase: '0', availableCreditBase: '0', activeLeaseCount: 0, pendingLeaseCount: 0, liveLeaseUuids: [] },
    ...patch,
  };
}
const inputs = () => publicInputs({ tenant, image, monthlyBudgetPwr: '5', gasPrice: `0.5${denom}` });

test('mainnet identities must agree, be synchronized and have a recent block before SDK reads', () => {
  const rpc = { jsonrpc: '2.0', id: 1, result: { node_info: { network: String(MAINNET.chainId) }, sync_info: { catching_up: false, latest_block_height: '123', latest_block_time: new Date(now).toISOString() } } };
  const rest = { default_node_info: { network: MAINNET.chainId } };
  assert.deepEqual(assertIdentity(rpc, rest, now), { height: '123' });
  assert.throws(() => assertIdentity(rpc, { default_node_info: { network: 'manifest-ledger-testnet' } }, now), /both identify/);
  assert.throws(() => assertIdentity({ ...rpc, error: null }, rest, now), /both identify/);
  const altered = structuredClone(rpc);
  altered.result.node_info.network = 'manifest-1';
  assert.throws(() => assertIdentity(altered, rest, now), /both identify/);
  altered.result.node_info.network = MAINNET.chainId;
  altered.result.sync_info.catching_up = true;
  assert.throws(() => assertIdentity(altered, rest, now), /synchronizing/);
  assert.throws(() => assertIdentity(rpc, rest, now + 360_000), /stale/);
});

test('requires exact nano name and explicit disambiguation, never healthier/cheaper fallback', () => {
  assert.deepEqual(chooseCandidate([{ ...candidate, name: 'docker-micro' }], denom).blockers, ['exact_sku_unavailable']);
  const other = { ...candidate, skuUuid: '019e6f08-a59a-7001-9f12-3a0963d3f194', providerUuid: '019e6a0d-e141-7000-9e79-e94ac1bd333f', providerHealthy: false };
  assert.deepEqual(chooseCandidate([candidate, other], denom).blockers, ['ambiguous_sku_choose_provider']);
  assert.equal(chooseCandidate([candidate, other], denom, candidate.providerUuid).selected?.skuUuid, candidate.skuUuid);
  assert.ok(chooseCandidate([other], denom).blockers.includes('provider_unhealthy_or_identity_mismatch'));
});

test('does not quote a wrong-denomination, wrong-unit, or fractional-per-second price', () => {
  for (const change of [{ denom: 'umfx' }, { unit: 2 }, { priceBasePerHour: '3601' }]) {
    const plan = buildPlan(quote({ candidates: [{ ...candidate, ...change }] }), inputs(), now);
    assert.equal(plan.costs, null);
    assert.equal(plan.templateReady, false);
  }
  for (const price of ['-1', '0', '01', '1.5', '1e6']) assert.throws(() => chooseCandidate([{ ...candidate, priceBasePerHour: price }], denom));
});

test('calculates exact nano costs and keeps planning separate from execution and funding', () => {
  const plan = buildPlan(quote(), inputs(), now);
  assert.equal(plan.templateReady, true);
  assert.equal(plan.executionReady, false);
  assert.equal(plan.executionAuthorized, false);
  assert.deepEqual(plan.costs?.hourly, { base: '3600', pwr: '0.0036' });
  assert.deepEqual(plan.costs?.hours24, { base: '86400', pwr: '0.0864' });
  assert.deepEqual(plan.costs?.days30, { base: '2592000', pwr: '2.592' });
  assert.deepEqual(plan.costs?.days31, { base: '2678400', pwr: '2.6784' });
  assert.equal(plan.monthlyHostingBudget?.base, '5000000');
  assert.ok(plan.funding.gaps.includes('hosting_credit_below_minimum_lease'));
  assert.ok(plan.funding.gaps.includes('selected_gas_token_balance_missing'));
  assert.equal(plan.funding.gasFeesIncludedInHostingBudget, false);
  assert.equal(plan.domain.tlsVerified, false);
  assert.equal(plan.domain.cloudflareProxyAllowed, false);
  assert.equal(plan.domain.proxyPolicy, 'DNS only permanently');
  assert.equal(plan.runtimeEnv.CHAIN_ID, 'manifest-ledger-mainnet');
  // Mainnet and testnet legitimately share this factory denomination.
  assert.equal(plan.runtimeEnv.PWR_DENOM, denom);
});

test('cost arithmetic remains exact beyond Number.MAX_SAFE_INTEGER', () => {
  const rate = '9007199254742400'; // exactly divisible by 3600
  const plan = buildPlan(quote({ candidates: [{ ...candidate, priceBasePerHour: rate }] }), publicInputs({ tenant, image, monthlyBudgetPwr: '9007199254740993' }), now);
  assert.equal(plan.costs?.days30.base, String(BigInt(rate) * 720n));
  assert.equal(plan.monthlyHostingBudget?.base, '9007199254740993000000');
});

test('null/missing inputs and an insufficient monthly ceiling are explicit blockers', () => {
  const missing = buildPlan(quote({ tenant: null }), publicInputs({ tenant: null, image: null, monthlyBudgetPwr: null }), now);
  assert.equal(missing.tenant, null);
  assert.equal(missing.image, null);
  assert.equal(missing.monthlyHostingBudget, null);
  assert.ok(missing.blockers.includes('production_tenant_missing'));
  assert.ok(missing.blockers.includes('digest_pinned_image_missing'));
  assert.ok(missing.blockers.includes('monthly_hosting_budget_missing'));
  const insufficient = buildPlan(quote(), publicInputs({ tenant, image, monthlyBudgetPwr: '2.591999' }), now);
  assert.ok(insufficient.blockers.includes('monthly_hosting_budget_below_31_day_quote'));
  assert.equal(buildPlan(quote(), publicInputs({ tenant, image, monthlyBudgetPwr: '2.6' }), now).templateReady, false);
  assert.equal(buildPlan(quote(), publicInputs({ tenant, image, monthlyBudgetPwr: '2.6784' }), now).templateReady, true);
});

test('stale, future, extended-lifetime, and wrong-network quotes cannot become ready', () => {
  assert.ok(buildPlan(quote(), inputs(), now + MAINNET.quoteTtlMs).blockers.includes('quote_stale_or_invalid_rerun_preflight'));
  assert.ok(buildPlan(quote(), inputs(), now - 120_000).blockers.includes('quote_stale_or_invalid_rerun_preflight'));
  assert.ok(buildPlan(quote({ expiresAt: new Date(now + 86_400_000).toISOString() }), inputs(), now).blockers.includes('quote_stale_or_invalid_rerun_preflight'));
  for (const patch of [{ chainId: 'manifest-ledger-testnet' }, { network: 'testnet' }, { restUrl: 'https://nodes.example/testnet' }, { domain: 'other.example' }]) {
    assert.throws(() => buildPlan(quote(patch), inputs(), now), /not for the configured mainnet/);
  }
});

test('disabled PWR sends and unavailable/reserved domain claims block preparation', () => {
  assert.ok(buildPlan(quote({ pwr: { denom, display: 'PWR', exponent: 6, sendsEnabled: false } }), inputs(), now).blockers.includes('pwr_sends_disabled'));
  for (const status of ['claimed', 'unavailable'] as const) assert.ok(buildPlan(quote({ domainClaim: { status, reserved: false, leaseUuid: null, tenant: null } }), inputs(), now).blockers.includes('domain_claim_not_available'));
  assert.ok(buildPlan(quote({ domainClaim: { status: 'unclaimed', reserved: true, leaseUuid: null, tenant: null } }), inputs(), now).blockers.includes('domain_claim_not_available'));
});

test('PWR gas works without MFX; an unoffered or too-low gas price is never approved', () => {
  const funded = quote({ tenant: { ...quote().tenant!, pwrWalletBase: '1000000', availableCreditBase: '3600' } });
  const plan = buildPlan(funded, inputs(), now);
  assert.equal(plan.templateReady, true);
  assert.ok(!plan.funding.gaps.includes('selected_gas_token_balance_missing'));
  assert.equal(plan.funding.gasOptions.length, 2);
  for (const gasPrice of [`0.36${denom}`, '0.99umfx', '5other']) {
    const invalid = buildPlan(funded, publicInputs({ ...inputs(), gasPrice }), now);
    assert.ok(invalid.blockers.includes('gas_price_not_verified_or_below_node_minimum'));
  }
});

test('validates public inputs and never accepts secret config fields or image tags', () => {
  assert.throws(() => publicInputs({ tenant: 'manifest1invalid' }));
  assert.throws(() => publicInputs({ image: 'ghcr.io/fmorency/merovingian:latest' }));
  assert.throws(() => publicInputs({ mnemonic: 'must not be accepted' }));
  assert.throws(() => publicInputs({ monthlyBudgetPwr: '2.5920001' }));
  assert.equal(publicInputs({}, { MAINNET_TENANT: tenant, MAINNET_MONTHLY_BUDGET_PWR: '5', MANIFEST_MNEMONIC: 'ignored' }).tenant, tenant);
});

test('mainnet state is isolated from testnet journals and wallet paths', () => {
  const paths = mainnetPaths('/tmp/merovingian-test');
  assert.equal(paths.directory, '/tmp/merovingian-test/.local/mainnet');
  assert.equal(paths.config, resolve(paths.directory, 'config.json'));
  assert.equal(paths.quote, resolve(paths.directory, 'preflight.json'));
  assert.equal(paths.plan, resolve(paths.directory, 'plan.json'));
  assert.notEqual(paths.quote, '/tmp/merovingian-test/.local/preflight.json');
  assert.ok(!Object.values(paths).some(path => path.includes('wallet')));
});

test('existing active or pending leases require review and credit is never assumed dedicated', () => {
  for (const counts of [{ activeLeaseCount: 1, pendingLeaseCount: 0 }, { activeLeaseCount: 0, pendingLeaseCount: 1 }]) {
    const plan = buildPlan(quote({ tenant: { ...quote().tenant!, ...counts, liveLeaseUuids: ['019e6f08-a59a-7001-9f12-3a0963d3f193'] } }), inputs(), now);
    assert.ok(plan.blockers.includes('tenant_has_existing_live_leases_review_required'));
    assert.match(plan.funding.creditScope, /shared by all leases/);
  }
  const unknown = buildPlan(quote({ tenant: null }), inputs(), now);
  assert.ok(unknown.blockers.includes('production_tenant_state_not_verified_rerun_preflight'));
});

test('provider resource metadata is parsed without executing scripts or implying enforcement', () => {
  const config = { PUBLIC_CHAIN_ID: MAINNET.chainId, PUBLIC_SKU_SPECS: JSON.stringify({ 'docker-nano': { cores: 0.5, ramMB: 2048, diskGB: 15 } }) };
  const script = `window.__RUNTIME_CONFIG__ = JSON.parse(${JSON.stringify(JSON.stringify(config))});\n`;
  const resources = advertisedResources(script, 'https://barney.manifest.network/config.js');
  assert.equal(resources.ramMB, 2048);
  assert.equal(resources.enforcementVerified, false);
  assert.throws(() => advertisedResources(`${script}throw new Error('execute me')`, resources.source));
  assert.throws(() => advertisedResources(script.replace(MAINNET.chainId, 'manifest-ledger-testnet'), resources.source));
});
