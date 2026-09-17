import { createHash } from 'node:crypto';
import { LeaseState, type Lease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { MAINNET, pwrBase, publicInputs, quoteSchema, type PublicInputs, type Quote } from './mainnet-config.js';
import { prepareDeployment, type PreparedDeployment } from './mainnet-preview.js';

export class LaunchError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LaunchError'; }
}

export interface LaunchBinding {
  chainId: typeof MAINNET.chainId;
  tenant: string;
  image: string;
  providerUuid: string;
  providerUrl: string;
  skuUuid: string;
  denom: string;
  priceBasePerHour: string;
  monthlyBudgetBase: string;
  gasPrice: string;
  metaHashHex: string;
  inputHash: string;
}

export function inputHash(rawInputs: PublicInputs): string {
  const inputs = publicInputs(rawInputs);
  return createHash('sha256').update(JSON.stringify([
    inputs.tenant, inputs.image, inputs.providerUuid, inputs.monthlyBudgetPwr, inputs.gasPrice,
  ])).digest('hex');
}

export function launchBinding(prepared: PreparedDeployment, inputs: PublicInputs): LaunchBinding {
  const { plan } = prepared;
  if (!plan.templateReady || !plan.tenant || !plan.image || !plan.selected || !plan.costs || !plan.monthlyHostingBudget) throw new LaunchError('launch_plan_not_ready');
  return {
    chainId: MAINNET.chainId, tenant: plan.tenant, image: plan.image,
    providerUuid: plan.selected.providerUuid, providerUrl: plan.selected.providerUrl,
    skuUuid: plan.selected.skuUuid, denom: plan.costs.denom,
    priceBasePerHour: plan.selected.priceBasePerHour,
    monthlyBudgetBase: plan.monthlyHostingBudget.base, gasPrice: plan.funding.gasPrice,
    metaHashHex: prepared.metaHash, inputHash: inputHash(inputs),
  };
}

/** Verify the actual chain lease before treating it as a resumable launch. */
export function verifyLaunchLease(lease: Lease | null, leaseUuid: string, binding: LaunchBinding): asserts lease is Lease {
  const item = lease?.items[0];
  if (!lease || lease.uuid !== leaseUuid || lease.tenant !== binding.tenant
    || lease.providerUuid !== binding.providerUuid || lease.items.length !== 1
    || !item || item.skuUuid !== binding.skuUuid || item.quantity !== 1n || item.serviceName !== 'refuge'
    || item.lockedPrice?.denom !== binding.denom || !/^[1-9][0-9]*$/.test(item.lockedPrice.amount)
    || BigInt(item.lockedPrice.amount) * 3600n !== BigInt(binding.priceBasePerHour)
    || BigInt(item.lockedPrice.amount) * 86400n * 31n > BigInt(binding.monthlyBudgetBase)
    || Buffer.from(lease.metaHash).toString('hex') !== binding.metaHashHex
    || (item.customDomain !== '' && item.customDomain !== MAINNET.domain)) throw new LaunchError('recorded_lease_does_not_match_launch');
  if (![LeaseState.LEASE_STATE_PENDING, LeaseState.LEASE_STATE_ACTIVE].includes(lease.state)) {
    throw new LaunchError('recorded_lease_terminal_manual_recovery_required');
  }
}

/** Reuse a known, verified lease without weakening the initial no-duplicate gate. */
export async function prepareLaunch(
  rawQuote: unknown, inputs: PublicInputs,
  existing?: { binding: LaunchBinding; leaseUuid: string; lease: Lease | null },
  now = Date.now(),
) {
  const quote = quoteSchema.parse(rawQuote);
  if (!existing) return prepareDeployment(quote, inputs, now);
  if (inputHash(inputs) !== existing.binding.inputHash) throw new LaunchError('launch_configuration_changed_use_explicit_update');
  verifyLaunchLease(existing.lease, existing.leaseUuid, existing.binding);
  if (quote.tenant?.address !== existing.binding.tenant || quote.tenant.status !== 'available'
    || quote.tenant.liveLeaseUuids.length !== 1 || quote.tenant.liveLeaseUuids[0] !== existing.leaseUuid
    || (quote.tenant.activeLeaseCount ?? -1) + (quote.tenant.pendingLeaseCount ?? -1) !== 1) throw new LaunchError('unexpected_tenant_leases');
  if (quote.domainClaim.status !== 'unclaimed'
    && !(quote.domainClaim.status === 'claimed' && quote.domainClaim.leaseUuid === existing.leaseUuid
      && quote.domainClaim.tenant === existing.binding.tenant && existing.lease.items[0].customDomain === MAINNET.domain)) {
    throw new LaunchError('domain_claim_conflicts_with_launch');
  }
  // Only after verifying ownership, exact immutable manifest/SKU/locked price,
  // and absence of other leases may the initial-create checks be normalized.
  const normalized: Quote = {
    ...quote,
    tenant: { ...quote.tenant, activeLeaseCount: 0, pendingLeaseCount: 0, liveLeaseUuids: [] },
    domainClaim: { ...quote.domainClaim, status: 'unclaimed', leaseUuid: null, tenant: null },
  };
  const prepared = await prepareDeployment(normalized, inputs, now);
  const next = launchBinding(prepared, inputs);
  for (const field of ['chainId', 'tenant', 'image', 'providerUuid', 'providerUrl', 'skuUuid', 'denom', 'monthlyBudgetBase', 'gasPrice', 'metaHashHex', 'inputHash'] as const) {
    if (next[field] !== existing.binding[field]) throw new LaunchError('launch_binding_changed');
  }
  return prepared;
}

export function approvedFeeBudget(value: string): string {
  const amount = pwrBase(value);
  // A narrow launch tool: raising this ceiling is a reviewed code change, not
  // an accidental argument accepting the entire funded wallet balance.
  if (amount <= 0n || amount > 1_000_000n) throw new LaunchError('launch_fee_budget_must_be_positive_and_at_most_one_pwr');
  return String(amount);
}

export function remainingFeeBudget(maximum: string, records: readonly { fee?: { amountBase: string } }[]): string {
  const spentOrReserved = records.reduce((sum, record) => sum + BigInt(record.fee?.amountBase ?? '0'), 0n);
  const remaining = BigInt(maximum) - spentOrReserved;
  if (remaining < 0n) throw new LaunchError('recorded_fees_exceed_approved_budget');
  return String(remaining);
}
