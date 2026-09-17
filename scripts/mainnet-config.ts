import { parseAddress } from '@manifest-network/manifest-sdk';
import { resolve } from 'node:path';
import { z } from 'zod';

export const MAINNET = Object.freeze({
  network: 'mainnet', chainId: 'manifest-ledger-mainnet',
  rpcUrl: 'https://nodes.manifest.network/manifest/rpc',
  restUrl: 'https://nodes.manifest.network/manifest/api',
  domain: 'merovingian.manifest.network', skuName: 'docker-nano',
  quoteTtlMs: 15 * 60_000,
});

export function mainnetPaths(workspace = process.cwd()) {
  const directory = resolve(workspace, '.local', 'mainnet');
  return { directory, config: resolve(directory, 'config.json'), quote: resolve(directory, 'preflight.json'), plan: resolve(directory, 'plan.json') };
}

const positiveInteger = z.string().regex(/^[1-9][0-9]{0,77}$/);
const nonnegativeInteger = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const pinnedImage = z.string().regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const inputSchema = z.object({
  tenant: z.string().nullish().transform(v => v ?? undefined), image: pinnedImage.nullish().transform(v => v ?? undefined), providerUuid: uuid.nullish().transform(v => v ?? undefined),
  monthlyBudgetPwr: z.string().regex(/^(0|[1-9][0-9]{0,60})(\.[0-9]{1,6})?$/).nullish().transform(v => v ?? undefined),
  gasPrice: z.string().regex(/^[0-9]+(?:\.[0-9]{1,18})?[a-zA-Z][a-zA-Z0-9/._:-]*$/).nullish().transform(v => v ?? undefined),
}).strict();
export type PublicInputs = z.infer<typeof inputSchema>;

export function publicInputs(file: unknown = {}, env: NodeJS.ProcessEnv = {}): PublicInputs {
  const inputs = inputSchema.parse(file);
  const variables = { tenant: 'MAINNET_TENANT', image: 'MAINNET_IMAGE', monthlyBudgetPwr: 'MAINNET_MONTHLY_BUDGET_PWR', providerUuid: 'MAINNET_PROVIDER_UUID', gasPrice: 'MAINNET_GAS_PRICE' } as const;
  for (const [key, variable] of Object.entries(variables)) {
    const value = env[variable];
    if (value !== undefined) (inputs as Record<string, string>)[key] = value;
  }
  const validated = inputSchema.parse(inputs);
  if (validated.tenant) validated.tenant = parseAddress(validated.tenant);
  return validated;
}

export function pwrBase(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,60})(\.[0-9]{1,6})?$/.test(value)) throw new Error('PWR amounts require at most six decimal places');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export function displayPwr(base: string): string {
  const value = BigInt(nonnegativeInteger.parse(base));
  return `${value / 1_000_000n}${value % 1_000_000n ? `.${String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '')}` : ''}`;
}

const resourceSchema = z.object({
  source: z.string().url(), cpuCores: z.number().positive().finite(), ramMB: z.number().int().positive(), diskGB: z.number().positive().finite(),
  provenance: z.literal('provider-public-advertisement'), enforcementVerified: z.literal(false),
});
export const candidateSchema = z.object({
  name: z.string(), skuUuid: uuid, providerUuid: uuid, providerUrl: z.string().url(),
  active: z.boolean(), providerActive: z.boolean(), providerHealthy: z.boolean(), providerIdentityMatches: z.boolean(),
  unit: z.number().int(), denom: z.string(), priceBasePerHour: positiveInteger,
  resources: resourceSchema.nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const quoteSchema = z.object({
  network: z.string(), chainId: z.string(), rpcUrl: z.string(), restUrl: z.string(), domain: z.string(), skuName: z.string(),
  observedAt: z.string().datetime(), expiresAt: z.string().datetime(), chainHeight: positiveInteger,
  pwr: z.object({ denom: z.string(), display: z.literal('PWR'), exponent: z.literal(6), sendsEnabled: z.boolean() }),
  minimumLeaseSeconds: positiveInteger, minimumGasPrices: z.string().nullable(),
  candidates: z.array(candidateSchema),
  domainClaim: z.object({ status: z.enum(['unclaimed', 'claimed', 'unavailable']), leaseUuid: z.string().nullable(), tenant: z.string().nullable(), reserved: z.boolean() }),
  dns: z.object({ cname: z.array(z.string()), addresses: z.array(z.string()), status: z.enum(['records_present', 'no_records', 'unavailable']) }),
  tenant: z.object({ address: z.string(), checkedAt: z.string().datetime(), status: z.enum(['available', 'unavailable']),
    pwrWalletBase: nonnegativeInteger.nullable(), mfxWalletBase: nonnegativeInteger.nullable(), availableCreditBase: nonnegativeInteger.nullable(),
    activeLeaseCount: z.number().int().nonnegative().nullable(), pendingLeaseCount: z.number().int().nonnegative().nullable(), liveLeaseUuids: z.array(uuid),
  }).nullable(),
});
export type Quote = z.infer<typeof quoteSchema>;

export function assertIdentity(rpc: unknown, rest: unknown, now = Date.now()): { height: string } {
  const status = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.object({
    node_info: z.object({ network: z.string() }), sync_info: z.object({ catching_up: z.boolean(), latest_block_height: positiveInteger, latest_block_time: z.string() }),
  }) }).parse(rpc);
  const info = z.object({ default_node_info: z.object({ network: z.string() }) }).parse(rest);
  if ('error' in (rpc as object) || status.result.node_info.network !== MAINNET.chainId || info.default_node_info.network !== MAINNET.chainId) throw new Error('RPC and REST must both identify manifest-ledger-mainnet');
  const time = Date.parse(status.result.sync_info.latest_block_time);
  if (status.result.sync_info.catching_up || !Number.isFinite(time) || now - time > 5 * 60_000 || time - now > 60_000) throw new Error('Mainnet RPC is synchronizing or its latest block is stale');
  return { height: status.result.sync_info.latest_block_height };
}

export function advertisedResources(script: string, source: string) {
  // Parse the static JSON literal only. Never execute provider JavaScript.
  const literal = /^\s*window\.__RUNTIME_CONFIG__\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\);?\s*$/.exec(script)?.[1];
  if (!literal) throw new Error('Provider resource advertisement has an unsupported format');
  const config = JSON.parse(JSON.parse(literal)) as Record<string, unknown>;
  if (config.PUBLIC_CHAIN_ID !== MAINNET.chainId || typeof config.PUBLIC_SKU_SPECS !== 'string') throw new Error('Provider resource advertisement is for a different network');
  const specs = JSON.parse(config.PUBLIC_SKU_SPECS) as Record<string, unknown>;
  const nano = z.object({ cores: z.number(), ramMB: z.number(), diskGB: z.number() }).parse(specs[MAINNET.skuName]);
  return resourceSchema.parse({ source, cpuCores: nano.cores, ramMB: nano.ramMB, diskGB: nano.diskGB, provenance: 'provider-public-advertisement', enforcementVerified: false });
}

export function chooseCandidate(candidates: Candidate[], denom: string, providerUuid?: string) {
  const matches = candidates.map(c => candidateSchema.parse(c)).filter(c => c.name === MAINNET.skuName && c.active && c.providerActive && (!providerUuid || c.providerUuid === providerUuid));
  // Do not choose a different provider merely because another candidate is unhealthy.
  if (matches.length !== 1) return { selected: null, blockers: [matches.length === 0 ? 'exact_sku_unavailable' : 'ambiguous_sku_choose_provider'] };
  const selected = matches[0];
  const blockers: string[] = [];
  if (!selected.providerHealthy || !selected.providerIdentityMatches) blockers.push('provider_unhealthy_or_identity_mismatch');
  if (selected.unit !== 1 || selected.denom !== denom) blockers.push('sku_price_unit_or_denom_mismatch');
  // Billing leases normalize hourly prices to integral base units per second.
  // Refuse a price that would require assuming an unverified rounding rule.
  if (BigInt(selected.priceBasePerHour) % 3600n !== 0n) blockers.push('sku_price_not_integral_per_second');
  if (!selected.resources) blockers.push('provider_resource_advertisement_unavailable');
  return { selected, blockers };
}

function decimalUnits(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > 18) throw new Error('Gas price precision exceeds 18 places');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

export function buildPlan(rawQuote: unknown, rawInputs: PublicInputs, now = Date.now()) {
  const quote = quoteSchema.parse(rawQuote);
  const inputs = publicInputs(rawInputs);
  if (quote.network !== MAINNET.network || quote.chainId !== MAINNET.chainId || quote.rpcUrl !== MAINNET.rpcUrl || quote.restUrl !== MAINNET.restUrl || quote.domain !== MAINNET.domain || quote.skuName !== MAINNET.skuName) throw new Error('Quote is not for the configured mainnet deployment');
  const blockers: string[] = [];
  const observed = Date.parse(quote.observedAt), expires = Date.parse(quote.expiresAt);
  if (observed > now + 60_000 || expires !== observed + MAINNET.quoteTtlMs || now >= expires) blockers.push('quote_stale_or_invalid_rerun_preflight');
  if (!quote.pwr.sendsEnabled) blockers.push('pwr_sends_disabled');
  if (quote.domainClaim.status !== 'unclaimed' || quote.domainClaim.reserved) blockers.push('domain_claim_not_available');
  const choice = chooseCandidate(quote.candidates, quote.pwr.denom, inputs.providerUuid);
  blockers.push(...choice.blockers);
  const selected = choice.selected;
  const validPrice = selected && !choice.blockers.includes('sku_price_unit_or_denom_mismatch') && !choice.blockers.includes('sku_price_not_integral_per_second');
  const hourly = validPrice ? BigInt(selected.priceBasePerHour) : null;
  const costs = hourly === null ? null : {
    denom: quote.pwr.denom,
    hourly: { base: String(hourly), pwr: displayPwr(String(hourly)) },
    hours24: { base: String(hourly * 24n), pwr: displayPwr(String(hourly * 24n)) },
    days30: { base: String(hourly * 720n), pwr: displayPwr(String(hourly * 720n)) },
    days31: { base: String(hourly * 744n), pwr: displayPwr(String(hourly * 744n)) },
    minimumLease: { seconds: quote.minimumLeaseSeconds, base: String(hourly / 3600n * BigInt(quote.minimumLeaseSeconds)), pwr: displayPwr(String(hourly / 3600n * BigInt(quote.minimumLeaseSeconds))) },
  };
  if (!inputs.tenant) blockers.push('production_tenant_missing');
  if (!inputs.image) blockers.push('digest_pinned_image_missing');
  const budget = inputs.monthlyBudgetPwr === undefined ? null : pwrBase(inputs.monthlyBudgetPwr);
  if (budget === null) blockers.push('monthly_hosting_budget_missing');
  else if (costs && budget < BigInt(costs.days31.base)) blockers.push('monthly_hosting_budget_below_31_day_quote');
  const tenant = quote.tenant?.address === inputs.tenant ? quote.tenant : null;
  if (inputs.tenant && (!tenant || tenant.status !== 'available')) blockers.push('production_tenant_state_not_verified_rerun_preflight');
  if ((tenant?.activeLeaseCount ?? 0) + (tenant?.pendingLeaseCount ?? 0) > 0) blockers.push('tenant_has_existing_live_leases_review_required');
  const parseGas = (price: string) => /^([0-9]+(?:\.[0-9]{1,18})?)([a-zA-Z][a-zA-Z0-9/._:-]*)$/.exec(price.trim());
  const gasPrice = inputs.gasPrice ?? `0.5${quote.pwr.denom}`;
  const gas = parseGas(gasPrice)!;
  const gasOptions = (quote.minimumGasPrices?.split(',') ?? []).flatMap(price => {
    const parsed = parseGas(price);
    return parsed && [quote.pwr.denom, 'umfx'].includes(parsed[2]) ? [{ denom: parsed[2], nodeMinimumPrice: price.trim(), walletBalanceBase: parsed[2] === quote.pwr.denom ? tenant?.pwrWalletBase ?? null : tenant?.mfxWalletBase ?? null }] : [];
  });
  const minimum = gasOptions.find(option => option.denom === gas[2]);
  if (!minimum || decimalUnits(gas[1]) < decimalUnits(parseGas(minimum.nodeMinimumPrice)![1])) blockers.push('gas_price_not_verified_or_below_node_minimum');
  const gasBalance = minimum?.walletBalanceBase ?? null;
  const fundingGaps: string[] = [];
  if (!tenant || tenant.status !== 'available') fundingGaps.push('production_wallet_balances_not_verified');
  else {
    if (!gasBalance || BigInt(gasBalance) === 0n) fundingGaps.push('selected_gas_token_balance_missing');
    if (costs && BigInt(tenant.availableCreditBase ?? '0') < BigInt(costs.minimumLease.base)) fundingGaps.push('hosting_credit_below_minimum_lease');
  }
  fundingGaps.push('transaction_gas_spending_limit_requires_approval');
  return {
    mode: 'read-only-preparation', executionAuthorized: false, executionReady: false,
    templateReady: blockers.length === 0, blockers, generatedAt: new Date(now).toISOString(),
    quote: { observedAt: quote.observedAt, expiresAt: quote.expiresAt, chainHeight: quote.chainHeight },
    network: MAINNET.network, chainId: MAINNET.chainId, publicOrigin: `https://${MAINNET.domain}`,
    image: inputs.image ?? null, tenant: inputs.tenant ?? null, selected, costs,
    monthlyHostingBudget: budget === null ? null : { base: String(budget), pwr: displayPwr(String(budget)), excludes: ['transaction gas', 'domain costs', 'PWR acquisition fees'] },
    funding: { balances: tenant, gaps: fundingGaps, gasPrice, gasOptions, gasReserveBase: null, gasFeesIncludedInHostingBudget: false, observedNodeMinimumGasPrices: quote.minimumGasPrices, depositsWithdrawable: false, creditScope: 'shared by all leases owned by this tenant; not earmarked for Merovingian',
      note: 'The node accepts PWR or MFX for gas. PWR held in the wallet can pay gas; deposited hosting credit cannot. A fee reserve needs later simulation and separate approval.' },
    runtimeEnv: { NETWORK: 'mainnet', CHAIN_ID: MAINNET.chainId, MANIFEST_RPC_URL: MAINNET.rpcUrl, MANIFEST_REST_URL: MAINNET.restUrl, MANIFEST_GAS_PRICE: gasPrice, PWR_DENOM: quote.pwr.denom, REFUGE_TENANT: inputs.tenant ?? null, PUBLIC_ORIGIN: `https://${MAINNET.domain}`, PORT: '8080', NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' },
    domain: { ...quote.domainClaim, dns: quote.dns, dnsControlVerified: false, tlsVerified: false, dnsProvider: 'Cloudflare', cloudflareProxyAllowed: false, proxyPolicy: 'DNS only permanently' },
    nextSteps: [
      'Verify the dedicated production signer and existing hosting credit; do not repeat a completed deposit. Set the transaction gas spending limit and replenishment policy; no key material belongs in this configuration or runtime.',
      'Refresh this quote immediately before any separately authorized transaction; approve exact provider, SKU, price, and minimum lease reserve.',
      'Verify the chosen immutable image supports this mainnet configuration and is publicly pullable; exercise the advertised nano resource limits.',
      `Claim ${MAINNET.domain} using SDK customDomain with serviceName refuge on the production lease; the current origin-only command does not claim a domain.`,
      'Create the provider-specified Cloudflare DNS record with proxy disabled (DNS only permanently) after its exact routing target is known; DNS access and target are not inferred from a domain claim.',
      'Verify valid public HTTPS, certificate renewal, HTTP/MCP visits, and one separately authorized mainnet contribution before indexing or retiring testnet.',
      'Configure uptime and low-credit alerts, a budget owner, rollback, and the bounded testnet retirement window.',
    ],
  };
}
