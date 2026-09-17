import assert from 'node:assert/strict';
import test from 'node:test';
import { Lease, LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { MAINNET, type Quote } from '../scripts/mainnet-config.js';
import { prepareDeployment } from '../scripts/mainnet-preview.js';
import { approvedFeeBudget, launchBinding, prepareLaunch, remainingFeeBudget, verifyLaunchLease } from '../scripts/mainnet-launch-plan.js';
import { advanceLaunch, type LaunchDependencies, type LaunchState } from '../scripts/mainnet-launch.js';
import type { TransactionRecord } from '../scripts/mainnet-transactions.js';
import type { PublicProviderStatus } from '../scripts/mainnet-provider.js';

const tenant = 'manifest1hkmrmsc6zjr7gm2wgtrtce7vgxeq9e402x5rf5';
const denom = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
const skuUuid = '019e6f08-a59a-7001-9f12-3a0963d3f193';
const providerUuid = '019e6a0d-e141-7000-9e79-e94ac1bd333e';
const leaseUuid = '019e6a0d-e141-7000-9e79-e94ac1bd1111';
const inputs = { tenant, providerUuid, image: `ghcr.io/fmorency/merovingian@sha256:${'a'.repeat(64)}`, monthlyBudgetPwr: '5', gasPrice: `0.5${denom}` };
function quote(): Quote {
  const now = Date.now();
  return { ...MAINNET, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + MAINNET.quoteTtlMs).toISOString(), chainHeight: '100',
    pwr: { denom, display: 'PWR', exponent: 6, sendsEnabled: true }, minimumLeaseSeconds: '3600', minimumGasPrices: `0.37${denom}`,
    candidates: [{ name: 'docker-nano', skuUuid, providerUuid, providerUrl: 'https://barney.manifest.network/api/fred', active: true, providerActive: true, providerHealthy: true, providerIdentityMatches: true, unit: 1, denom, priceBasePerHour: '3600', resources: { source: 'https://barney.manifest.network/config.js', cpuCores: 0.5, ramMB: 2048, diskGB: 15, provenance: 'provider-public-advertisement', enforcementVerified: false } }],
    domainClaim: { status: 'unclaimed', leaseUuid: null, tenant: null, reserved: false }, dns: { cname: [], addresses: [], status: 'no_records' },
    tenant: { address: tenant, checkedAt: new Date(now).toISOString(), status: 'available', pwrWalletBase: '34000000', mfxWalletBase: '0', availableCreditBase: '15000000', activeLeaseCount: 0, pendingLeaseCount: 0, liveLeaseUuids: [] },
  };
}

async function fixture() {
  const prepared = await prepareDeployment(quote(), inputs);
  const binding = launchBinding(prepared, inputs);
  const initial: LaunchState = { version: 1, binding, manifestJson: prepared.manifestJson, maxTotalFeeBase: '500000', phase: 'prepared', upload: 'not-started', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let lease: Lease | null = null;
  let uploads = 0, signs = 0;
  const records = new Map<string, TransactionRecord>();
  const events: string[] = [];
  const status = (): PublicProviderStatus => ({ leaseUuid, tenant, providerUuid, state: 'active', provisionStatus: 'success', ready: true, metaHash: prepared.metaHash, payloadReceived: true, requiresPayload: false, provisioningStarted: true, endpoints: [{ fqdn: 'refuge-example.barney.manifest.network', ports: [] }], dnsTargets: [{ type: 'CNAME', value: 'refuge-example.barney.manifest.network' }] });
  const deps: LaunchDependencies = {
    async quote() {
      const q = quote();
      if (lease) {
        q.tenant = { ...q.tenant!, pendingLeaseCount: 1, liveLeaseUuids: [leaseUuid] };
        if (lease.items[0].customDomain) q.domainClaim = { status: 'claimed', leaseUuid, tenant, reserved: false };
      }
      return q;
    },
    lease: async () => lease,
    record: async id => records.get(id) ?? null,
    async execute(id, message, maxFeeBase) {
      if (records.has(id)) return { status: 'committed', record: records.get(id)!, reconciled: true };
      signs++;
      events.push(id);
      const fee = id === 'create-lease' ? '78940' : '80000';
      assert.ok(BigInt(fee) <= BigInt(maxFeeBase));
      const record: TransactionRecord = { version: 1, id, chainId: MAINNET.chainId, tenant, fingerprint: 'A'.repeat(64), messageTypes: [message.typeUrl as TransactionRecord['messageTypes'][number]], status: 'committed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), fee: { amountBase: fee, denom, gasLimit: '160000' }, signer: { accountNumber: '1', sequence: String(signs) }, transactionHash: (id === 'create-lease' ? 'B' : 'C').repeat(64), receipt: { code: 0, height: '101', gasUsed: '100000', gasWanted: '160000', ...(id === 'create-lease' ? { leaseUuid } : {}) } };
      records.set(id, record);
      if (id === 'create-lease') lease = Lease.fromPartial({ uuid: leaseUuid, tenant, providerUuid, state: LeaseState.LEASE_STATE_PENDING, metaHash: Buffer.from(prepared.metaHash, 'hex'), items: [{ skuUuid, quantity: 1n, serviceName: 'refuge', lockedPrice: { denom, amount: '1' } }] });
      else lease!.items[0].customDomain = MAINNET.domain;
      return { status: 'committed', record, reconciled: false };
    },
    save: async () => {},
    async upload() { uploads++; events.push('upload'); return {}; },
    providerStatus: async () => status(), ready: async () => status(),
  };
  return { initial, deps, records, events, lease: () => lease, uploads: () => uploads, signs: () => signs, status };
}

test('launch commits one lease then domain then provider payload; rerun reuses both transactions and upload', async () => {
  const f = await fixture();
  const state = await advanceLaunch(f.initial, inputs, f.deps);
  assert.deepEqual(f.events, ['create-lease', 'claim-domain', 'upload']);
  assert.equal(state.phase, 'awaiting-dns');
  assert.equal(state.leaseUuid, leaseUuid);
  await advanceLaunch(state, inputs, f.deps);
  assert.equal(f.signs(), 2); assert.equal(f.uploads(), 1);
  assert.equal(remainingFeeBudget(state.maxTotalFeeBase, [...f.records.values()]), '341060');
});

test('commit-before-state-save crash reconciles existing create hash without a replacement lease', async () => {
  const f = await fixture();
  const before = structuredClone(f.initial);
  const failing: LaunchDependencies = { ...f.deps, save: async () => { throw new Error('simulated process loss'); } };
  await assert.rejects(advanceLaunch(f.initial, inputs, failing), /process loss/);
  assert.equal(f.signs(), 1);
  const resumed = await advanceLaunch(before, inputs, f.deps);
  assert.equal(resumed.leaseUuid, leaseUuid); assert.equal(f.signs(), 2); assert.equal(f.uploads(), 1);
});

test('uncertain creation stops before domain or upload and never creates a second lease', async () => {
  const f = await fixture();
  const execute = f.deps.execute;
  f.deps.execute = async (...args) => ({ ...(await execute(...args)), status: 'uncertain' });
  await assert.rejects(advanceLaunch(f.initial, inputs, f.deps), /transaction_create-lease_uncertain/);
  await assert.rejects(advanceLaunch(f.initial, inputs, f.deps), /transaction_create-lease_uncertain/);
  assert.equal(f.signs(), 1); assert.equal(f.uploads(), 0);
});

test('an ambiguous payload POST is reconciled read-only and never automatically repeated', async () => {
  const f = await fixture();
  let posts = 0;
  f.deps.upload = async () => { posts++; throw new Error('private provider diagnostic'); };
  await assert.rejects(advanceLaunch(f.initial, inputs, f.deps), /provider_upload_uncertain/);
  f.deps.providerStatus = async () => ({ ...f.status(), payloadReceived: false });
  await assert.rejects(advanceLaunch(f.initial, inputs, f.deps), /read_only_reconciliation/);
  assert.equal(posts, 1);
  f.deps.providerStatus = async () => f.status();
  assert.equal((await advanceLaunch(f.initial, inputs, f.deps)).phase, 'awaiting-dns');
  assert.equal(posts, 1);
});

test('resume refuses changed configuration, foreign leases, wrong locked price, and terminal leases', async () => {
  const f = await fixture();
  await advanceLaunch(f.initial, inputs, f.deps);
  await assert.rejects(advanceLaunch(f.initial, { ...inputs, image: `ghcr.io/fmorency/merovingian@sha256:${'b'.repeat(64)}` }, f.deps), /changed_launch_state/);
  for (const modify of [
    (l: Lease) => { l.providerUuid = leaseUuid; },
    (l: Lease) => { l.items[0].lockedPrice.amount = '2'; },
    (l: Lease) => { l.items[0].quantity = 2n; },
    (l: Lease) => { l.metaHash[0] ^= 1; },
    (l: Lease) => { l.state = LeaseState.LEASE_STATE_CLOSED; },
  ]) {
    const lease = structuredClone(f.lease()!); modify(lease);
    assert.throws(() => verifyLaunchLease(lease, leaseUuid, f.initial.binding), /recorded_lease/);
  }
  const q = await f.deps.quote(); q.tenant!.liveLeaseUuids.push(providerUuid); q.tenant!.activeLeaseCount = 1;
  await assert.rejects(prepareLaunch(q, inputs, { binding: f.initial.binding, leaseUuid, lease: f.lease() }), /unexpected_tenant_leases/);
});

test('launch fee allowance is exact, bounded, and includes failed or uncertain reserved fees', () => {
  assert.equal(approvedFeeBudget('0.5'), '500000');
  for (const amount of ['0', '1.000001', '-1', '2', 'NaN', '0.0000001']) assert.throws(() => approvedFeeBudget(amount));
  assert.equal(remainingFeeBudget('500000', [{ fee: { amountBase: '200000' } }, { fee: { amountBase: '100000' } }]), '200000');
  assert.throws(() => remainingFeeBudget('100', [{ fee: { amountBase: '101' } }]), /exceed_approved_budget/);
});
