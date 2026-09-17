import { createManifestReadClient, isNotFoundError } from '@manifest-network/manifest-sdk';
import { getProviderHealth, LeaseState } from '@manifest-network/manifest-sdk/deploy';
import { createGuardedFetch } from '@manifest-network/manifest-sdk/node';
import { resolve4, resolve6, resolveCname } from 'node:dns/promises';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAINNET, advertisedResources, assertIdentity, buildPlan, mainnetPaths, publicInputs, quoteSchema,
  type Candidate, type PublicInputs, type Quote,
} from './mainnet-config.js';

async function fetchText(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error(`Public preflight endpoint returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 512 * 1024) throw new Error('Public preflight response exceeds 512 KiB');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

async function identity() {
  const [rpc, rest] = await Promise.all([
    fetchText(MAINNET.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: {} }) }),
    fetchText(`${MAINNET.restUrl}/cosmos/base/tendermint/v1beta1/node_info`),
  ]);
  return assertIdentity(JSON.parse(rpc), JSON.parse(rest));
}

async function dnsSnapshot(): Promise<Quote['dns']> {
  const results = await Promise.allSettled([resolveCname(MAINNET.domain), resolve4(MAINNET.domain), resolve6(MAINNET.domain)]);
  const failed = results.some(result => result.status === 'rejected' && !['ENODATA', 'ENOTFOUND'].includes((result.reason as { code?: string }).code ?? ''));
  const values = results.map(result => result.status === 'fulfilled' ? result.value : []);
  const addresses = [...values[1], ...values[2]];
  return { cname: values[0], addresses, status: failed ? 'unavailable' : values[0].length || addresses.length ? 'records_present' : 'no_records' };
}

// Paginate SDK read queries explicitly so a later duplicate SKU/provider or PWR
// metadata record cannot be silently missed. A bounded incomplete catalog fails.
async function pages<T>(query: (key: Uint8Array) => Promise<{ rows: T[]; next?: Uint8Array }>): Promise<T[]> {
  let key: Uint8Array = new Uint8Array();
  const rows: T[] = [];
  for (let page = 0; page < 5; page++) {
    const result = await query(key);
    rows.push(...result.rows);
    if (!result.next?.length) return rows;
    key = result.next;
  }
  throw new Error('Public catalog exceeds the bounded preflight scan; no SKU was selected');
}

export async function collectQuote(inputs: PublicInputs): Promise<Quote> {
  const observedAt = new Date().toISOString();
  const chain = await identity();
  // A read-only SDK client: no signer, mnemonic, wallet provider, faucet, or tx API.
  const client = await createManifestReadClient({ config: { chainId: MAINNET.chainId, rpcUrl: MAINNET.rpcUrl, restUrl: MAINNET.restUrl, gasPrice: inputs.gasPrice ?? '1.1umfx' } });
  const pagination = (key: Uint8Array) => ({ key, offset: 0n, limit: 100n, countTotal: true, reverse: false });
  try {
    const [skus, providers, metadata, bank, billing, claim, dns, nodeConfig] = await Promise.all([
      pages(async key => { const r = await client.query.liftedinit.sku.v1.sKUs({ activeOnly: true, pagination: pagination(key) }); return { rows: r.skus, next: r.pagination?.nextKey }; }),
      pages(async key => { const r = await client.query.liftedinit.sku.v1.providers({ activeOnly: true, pagination: pagination(key) }); return { rows: r.providers, next: r.pagination?.nextKey }; }),
      pages(async key => { const r = await client.query.cosmos.bank.v1beta1.denomsMetadata({ pagination: pagination(key) }); return { rows: r.metadatas, next: r.pagination?.nextKey }; }),
      client.query.cosmos.bank.v1beta1.params({}), client.getBillingParams(),
      client.getLeaseByCustomDomain(MAINNET.domain).then(result => ({ status: result ? 'claimed' as const : 'unclaimed' as const, leaseUuid: result?.lease.uuid ?? null, tenant: result?.lease.tenant ?? null })).catch(() => ({ status: 'unavailable' as const, leaseUuid: null, tenant: null })),
      dnsSnapshot(),
      fetchText(`${MAINNET.restUrl}/cosmos/base/node/v1beta1/config`).then(text => JSON.parse(text) as { minimum_gas_price?: string }).catch(() => null),
    ]);
    const pwrMatches = metadata.filter(item => item.display === 'PWR' && item.symbol === 'PWR');
    if (pwrMatches.length !== 1 || pwrMatches[0].denomUnits.find(unit => unit.denom === 'PWR')?.exponent !== 6) throw new Error('Mainnet must publish exactly one PWR denomination with six decimal places');
    const denom = pwrMatches[0].base;
    const overrides = await client.query.cosmos.bank.v1beta1.sendEnabled({ denoms: [denom] });
    const sendsEnabled = overrides.sendEnabled.find(item => item.denom === denom)?.enabled
      ?? bank.params.sendEnabled.find(item => item.denom === denom)?.enabled ?? bank.params.defaultSendEnabled;
    const guardedFetch = createGuardedFetch();
    const candidates: Candidate[] = [];
    for (const sku of skus.filter(item => item.name === MAINNET.skuName)) {
      const provider = providers.find(item => item.uuid === sku.providerUuid);
      if (!provider) continue;
      const source = `${new URL(provider.apiUrl).origin}/config.js`;
      const [health, resources] = await Promise.all([
        getProviderHealth(provider.apiUrl, 15_000, guardedFetch).catch(() => null),
        fetchText(source, {}, guardedFetch).then(text => advertisedResources(text, source)).catch(() => null),
      ]);
      candidates.push({ name: sku.name, skuUuid: sku.uuid, providerUuid: provider.uuid, providerUrl: provider.apiUrl,
        active: sku.active, providerActive: provider.active, providerHealthy: health?.status === 'healthy', providerIdentityMatches: health?.provider_uuid === provider.uuid,
        unit: sku.unit, denom: sku.basePrice.denom, priceBasePerHour: sku.basePrice.amount, resources });
    }
    let tenant: Quote['tenant'] = null;
    if (inputs.tenant) {
      try {
        const [pwr, mfx, credit, active, pending] = await Promise.all([
          client.query.cosmos.bank.v1beta1.balance({ address: inputs.tenant, denom }),
          client.query.cosmos.bank.v1beta1.balance({ address: inputs.tenant, denom: 'umfx' }),
          client.query.liftedinit.billing.v1.creditAccount({ tenant: inputs.tenant }).catch(error => { if (isNotFoundError(error)) return null; throw error; }),
          pages(async key => { const r = await client.query.liftedinit.billing.v1.leasesByTenant({ tenant: inputs.tenant!, stateFilter: LeaseState.LEASE_STATE_ACTIVE, pagination: pagination(key) }); return { rows: r.leases, next: r.pagination?.nextKey }; }),
          pages(async key => { const r = await client.query.liftedinit.billing.v1.leasesByTenant({ tenant: inputs.tenant!, stateFilter: LeaseState.LEASE_STATE_PENDING, pagination: pagination(key) }); return { rows: r.leases, next: r.pagination?.nextKey }; }),
        ]);
        tenant = { address: inputs.tenant, checkedAt: new Date().toISOString(), status: 'available', pwrWalletBase: pwr.balance?.amount ?? '0', mfxWalletBase: mfx.balance?.amount ?? '0', availableCreditBase: credit?.availableBalances.find(item => item.denom === denom)?.amount ?? '0', activeLeaseCount: active.length, pendingLeaseCount: pending.length, liveLeaseUuids: [...active, ...pending].map(lease => lease.uuid) };
      } catch { tenant = { address: inputs.tenant, checkedAt: new Date().toISOString(), status: 'unavailable', pwrWalletBase: null, mfxWalletBase: null, availableCreditBase: null, activeLeaseCount: null, pendingLeaseCount: null, liveLeaseUuids: [] }; }
    }
    const reserved = billing.reservedDomainSuffixes.some(suffix => {
      const normalized = suffix.replace(/^\.+/, '').toLowerCase();
      return MAINNET.domain === normalized || MAINNET.domain.endsWith(`.${normalized}`);
    });
    return quoteSchema.parse({ ...MAINNET, observedAt, expiresAt: new Date(Date.parse(observedAt) + MAINNET.quoteTtlMs).toISOString(), chainHeight: chain.height,
      pwr: { denom, display: 'PWR', exponent: 6, sendsEnabled }, minimumLeaseSeconds: String(billing.minLeaseDuration),
      minimumGasPrices: typeof nodeConfig?.minimum_gas_price === 'string' ? nodeConfig.minimum_gas_price : null,
      candidates, domainClaim: { ...claim, reserved }, dns, tenant });
  } finally { client.dispose(); }
}

async function savePublic(path: string, value: unknown) {
  const paths = mainnetPaths();
  if (![paths.quote, paths.plan].includes(path)) throw new Error('Preparation state must remain under .local/mainnet');
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!['preflight', 'plan'].includes(command) || extra.length) throw new Error('Usage: npm run mainnet -- preflight|plan (read-only; no deployment commands)');
  const paths = mainnetPaths();
  const file = await readFile(paths.config, 'utf8').then(text => JSON.parse(text) as unknown).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; });
  const inputs = publicInputs(file, process.env);
  if (command === 'preflight') {
    const quote = await collectQuote(inputs);
    await savePublic(paths.quote, quote);
    console.log(JSON.stringify({ ...quote, savedTo: paths.quote }, null, 2));
  } else {
    const quote = JSON.parse(await readFile(paths.quote, 'utf8')) as unknown;
    const plan = buildPlan(quote, inputs);
    await savePublic(paths.plan, plan);
    console.log(JSON.stringify({ ...plan, savedTo: paths.plan }, null, 2));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Do not echo arbitrary SDK response bodies or public-config input values.
    console.error(JSON.stringify({ error: 'mainnet_preparation_failed', message: error instanceof Error && error.name !== 'ZodError' ? error.message : 'Invalid public configuration or preflight response' }));
    process.exitCode = 1;
  });
}
