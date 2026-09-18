import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import {
  createConfig, createManifestReadClient, MnemonicWalletProvider,
  parseAddress, parseLeaseUuid, sanitizeForLogging,
} from '@manifest-network/manifest-sdk';
import { createFredClientNode, createGuardedFetch } from '@manifest-network/manifest-sdk/node';
import { buildStackManifest, LeaseState } from '@manifest-network/manifest-sdk/deploy';
import { fetchFaucetStatus, requestFaucetCredit } from '@manifest-network/manifest-sdk/faucet';
import { MsgSend } from '@manifest-network/manifestjs/dist/codegen/cosmos/bank/v1beta1/tx.js';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withTrustedProxyCidrs } from './runtime-proxy.js';

// This operator tool deliberately has no mainnet switch. A production launch
// needs a separately reviewed wallet, budget, origin and migration procedure.
const chainId = 'manifest-ledger-testnet';
const rpcUrl = 'https://nodes.liftedinit.tech/manifest/testnet/rpc/';
const restUrl = 'https://nodes.liftedinit.tech/manifest/testnet/api';
const faucetUrl = 'https://faucet.testnet.manifest.network';
const pwrDenom = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
const gasPrice = '1.1umfx';
const config = createConfig({ chainId, rpcUrl, restUrl, gasPrice, addressPrefix: 'manifest' });
const local = resolve('.local');
type Role = 'deployer' | 'visitor';
type WalletRecord = { chainId: string; address: string; mnemonic: string; createdAt: string };
type Selection = {
  chainId: string; checkedAt: string; skuUuid: string; providerUuid: string;
  providerUrl: string; priceBasePerHour: string; pwrDenom: string;
};
type Deployment = {
  chainId: string; tenant: string; image: string; createdAt: string;
  phase: string; leaseUuid?: string; providerUrl?: string; origin?: string;
  env: Record<string, string>; selection: Selection; result?: unknown;
};
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v, 2);
const print = (value: unknown) => console.log(json(value));
const printTransaction = (value: { transactionHash?: string; code?: number; confirmed?: boolean }) => print({ transactionHash: value.transactionHash, code: value.code, confirmed: value.confirmed });
const filename = (name: string) => resolve(local, name);
const exists = async (name: string) => stat(filename(name)).then(() => true, () => false);
const read = async <T>(name: string): Promise<T> => JSON.parse(await readFile(filename(name), 'utf8')) as T;

async function save(name: string, data: unknown) {
  await mkdir(local, { recursive: true, mode: 0o700 });
  const target = filename(name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${json(data)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function wallet(role: Role, create = false): Promise<WalletRecord> {
  const path = `${role}-wallet.json`;
  if (!await exists(path)) {
    if (!create) throw new Error(`Run the wallet command first; missing .local/${path}`);
    await mkdir(local, { recursive: true, mode: 0o700 });
    const generated = await DirectSecp256k1HdWallet.generate(24, { prefix: 'manifest' });
    const [account] = await generated.getAccounts();
    const record: WalletRecord = { chainId, address: account.address, mnemonic: generated.mnemonic, createdAt: new Date().toISOString() };
    await writeFile(filename(path), `${json(record)}\n`, { flag: 'wx', mode: 0o600 });
  }
  const record = await read<WalletRecord>(path);
  if (record.chainId !== chainId) throw new Error('Refusing a wallet for a different chain');
  const provider = new MnemonicWalletProvider(config, record.mnemonic);
  if (await provider.getAddress() !== record.address) throw new Error('Wallet address does not match key material');
  return record;
}

async function fred(role: Role = 'deployer') {
  // Published SDK 0.22.0 predates its source checkout's identity guards.
  // Verify both transports ourselves before constructing any signing client.
  await assertChainIdentity();
  const record = await wallet(role);
  return createFredClientNode({ config, walletProvider: new MnemonicWalletProvider(config, record.mnemonic) });
}

async function assertChainIdentity() {
  const [rpc, rest] = await Promise.all([
    fetch(rpcUrl, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: {} }), signal: AbortSignal.timeout(10_000) }),
    fetch(`${restUrl}/cosmos/base/tendermint/v1beta1/node_info`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!rpc.ok || !rest.ok) throw new Error('Cannot verify both testnet chain endpoints');
  const rpcData = await rpc.json() as { result?: { node_info?: { network?: string }; sync_info?: { catching_up?: boolean } } };
  const restData = await rest.json() as { default_node_info?: { network?: string } };
  if (rpcData.result?.node_info?.network !== chainId || restData.default_node_info?.network !== chainId || rpcData.result.sync_info?.catching_up !== false) {
    throw new Error('Endpoint network differs from testnet or the RPC node is not synchronized');
  }
}

function safeError(error: unknown) {
  const e = error as { message?: string; code?: string; details?: Record<string, unknown> };
  // Keep reconciliation evidence but never serialize arbitrary provider errors,
  // SDK clients, wallet objects, causes, request bodies or authentication tokens.
  const keys = ['sent', 'transactionHash', 'transaction_hash', 'lease_uuid', 'failedStep', 'readiness_unconfirmed', 'transactionCode', 'transactionConfirmed'];
  return {
    message: sanitizeForLogging(typeof e?.message === 'string' ? e.message : 'Operation failed'),
    ...(typeof e?.code === 'string' ? { code: e.code } : {}),
    details: Object.fromEntries(keys.flatMap(key => {
      const value = e?.details?.[key];
      return ['string', 'number', 'boolean'].includes(typeof value) ? [[key, value]] : [];
    })),
  };
}

async function mutation<T>(name: string, input: unknown, action: () => Promise<T>): Promise<T> {
  const path = `${name}.json`;
  await mkdir(local, { recursive: true, mode: 0o700 });
  // Exclusive creation is an intentional replay guard. An uncertain broadcast
  // must be reconciled before a human/operator archives this journal entry.
  const handle = await open(filename(path), 'wx', 0o600).catch(() => {
    throw new Error(`Refusing to replay ${name}; inspect .local/${path} and chain status first`);
  });
  const startedAt = new Date().toISOString();
  await handle.writeFile(`${json({ chainId, startedAt, phase: 'intent', input })}\n`);
  await handle.close();
  try {
    const result = await action();
    await save(path, { chainId, startedAt, phase: 'complete', input, result });
    return result;
  } catch (error) {
    await save(path, { chainId, startedAt, phase: 'needs-reconciliation', input, error: safeError(error) });
    throw error;
  }
}

async function preflight() {
  await assertChainIdentity();
  const client = await createManifestReadClient({ config });
  try {
    const [faucet, skus, providers, billing, bank, metadata] = await Promise.all([
      fetchFaucetStatus(faucetUrl), client.getSKUs({}), client.getProviders({}),
      client.getBillingParams(), client.query.cosmos.bank.v1beta1.params({}),
      client.query.cosmos.bank.v1beta1.denomsMetadata({ pagination: { key: new Uint8Array(), offset: 0n, limit: 100n, countTotal: false, reverse: false } }),
    ]);
    if (faucet.chainId !== chainId || !faucet.availableTokens.includes(pwrDenom) || !faucet.availableTokens.includes('umfx')) {
      throw new Error('Faucet network/tokens do not match the approved testnet deployment');
    }
    const enabled = bank.params.sendEnabled.find(entry => entry.denom === pwrDenom)?.enabled ?? bank.params.defaultSendEnabled;
    if (!enabled) throw new Error('Testnet PWR sends are disabled; contribution flow unavailable');
    const pwrMetadata = metadata.metadatas.find(item => item.base === pwrDenom);
    if (!pwrMetadata || pwrMetadata.display !== 'PWR' || pwrMetadata.denomUnits.find(unit => unit.denom === 'PWR')?.exponent !== 6) throw new Error('PWR display metadata no longer matches the expected six decimal places');
    const guardedFetch = createGuardedFetch();
    const health = await Promise.all(providers.map(async provider => {
      try {
        const res = await guardedFetch(`${provider.apiUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(15_000) });
        const body = await res.json() as { status?: string; provider_uuid?: string };
        return { provider, healthy: res.ok && body.status === 'healthy' && body.provider_uuid === provider.uuid };
      } catch { return { provider, healthy: false }; }
    }));
    const candidates = skus.filter(sku => sku.name === 'docker-micro' && sku.basePrice?.denom === pwrDenom && health.some(h => h.healthy && h.provider.uuid === sku.providerUuid));
    if (candidates.length !== 1) throw new Error(`Expected one healthy docker-micro SKU; found ${candidates.length}`);
    const sku = candidates[0];
    // Manifest UNIT_PER_HOUR = 1. Check instead of guessing price semantics.
    if (sku.unit !== 1) throw new Error('Selected SKU is not priced per hour');
    const provider = providers.find(p => p.uuid === sku.providerUuid)!;
    const selection: Selection = { chainId, checkedAt: new Date().toISOString(), skuUuid: sku.uuid, providerUuid: provider.uuid, providerUrl: provider.apiUrl, priceBasePerHour: sku.basePrice.amount, pwrDenom };
    await save('preflight.json', selection);
    print({ selection, estimatedPwrPerHour: Number(selection.priceBasePerHour) / 1e6, minimumLeaseSeconds: String(billing.minLeaseDuration), providers: health.map(h => ({ uuid: h.provider.uuid, healthy: h.healthy })) });
  } finally { client.dispose(); }
}

async function faucet() {
  const record = await wallet('deployer');
  const client = await createManifestReadClient({ config });
  try {
    const status = await fetchFaucetStatus(faucetUrl);
    if (status.chainId !== chainId) throw new Error('Wrong faucet chain');
    for (const [name, denom] of [['mfx', 'umfx'], ['pwr', pwrDenom]] as const) {
      const current = await client.query.cosmos.bank.v1beta1.balance({ address: record.address, denom });
      if (BigInt(current.balance?.amount ?? '0') > 0n) { print({ token: name, result: 'already-funded', balance: current.balance }); continue; }
      const result = await mutation(`faucet-${name}`, { address: record.address, denom }, async () => {
        const drip = await requestFaucetCredit(faucetUrl, record.address, denom);
        if (!drip.success) throw new Error(`Faucet request uncertain or rejected: ${drip.error}. Check balance and respect the faucet cooldown before another attempt.`);
        return drip;
      });
      print(result);
    }
    print({ address: record.address, balance: await client.getBalance(record.address) });
  } finally { client.dispose(); }
}

async function visitorFund() {
  const visitor = await wallet('visitor');
  const deployer = await wallet('deployer');
  const client = await fred();
  try {
    const amount = [{ denom: pwrDenom, amount: '100000' }, { denom: 'umfx', amount: '1000000' }];
    const result = await mutation('visitor-funding', { sender: deployer.address, recipient: visitor.address, amount }, () => client.executeTx([{
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: MsgSend.fromPartial({ fromAddress: deployer.address, toAddress: visitor.address, amount }),
    }]));
    printTransaction(result);
  } finally { client.dispose(); }
}

async function fund(amount = '9900000') {
  if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > 10_000_000n) throw new Error('Funding must be 1–10000000 base units (maximum 10 faucet PWR)');
  const client = await fred();
  try { printTransaction(await mutation('hosting-funding', { amount, denom: pwrDenom }, () => client.fundCredits({ amount: `${amount}${pwrDenom}` }))); }
  finally { client.dispose(); }
}

const pinnedImage = (image?: string) => {
  if (!image || !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Pass a public container image pinned as registry/namespace/image@sha256:<digest>');
  return image;
};

function runtimeEnv(tenant: string, origin = 'https://merovingian.invalid') {
  return withTrustedProxyCidrs({ NETWORK: 'testnet', CHAIN_ID: chainId, MANIFEST_RPC_URL: rpcUrl, MANIFEST_REST_URL: restUrl, MANIFEST_GAS_PRICE: gasPrice, PWR_DENOM: pwrDenom, REFUGE_TENANT: tenant, PUBLIC_ORIGIN: origin, PORT: '8080', NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }, process.env.TRUSTED_PROXY_CIDRS);
}

function services(image: string, env: Record<string, string>) {
  return { refuge: { image, ports: { '8080/tcp': { ingress: true } }, env } };
}

async function deploy(image?: string) {
  image = pinnedImage(image);
  // Validate public proxy configuration before opening a wallet or client.
  withTrustedProxyCidrs({}, process.env.TRUSTED_PROXY_CIDRS);
  if (await exists('deployment.json')) throw new Error('A deployment record already exists. Reconcile with status; use update for the existing lease.');
  const selection = await read<Selection>('preflight.json');
  if (selection.chainId !== chainId || Date.now() - Date.parse(selection.checkedAt) > 3_600_000) throw new Error('Run preflight again; catalog selection is stale or wrong-network');
  const record = await wallet('deployer');
  const client = await fred();
  try {
    const leases = await client.getLeasesByTenant({ tenant: record.address, stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED });
    if (leases.leases.some(lease => [LeaseState.LEASE_STATE_PENDING, LeaseState.LEASE_STATE_ACTIVE].includes(lease.state))) throw new Error('This dedicated wallet already has a live lease; reconcile it instead of deploying again');
    const deployment: Deployment = { chainId, tenant: record.address, image, selection, env: runtimeEnv(record.address), phase: 'intent', createdAt: new Date().toISOString() };
    await save('deployment.json', deployment);
    const result = await mutation('deploy', { image, selection }, () => client.deployApp({ size: 'docker-micro', skuUuid: selection.skuUuid, providerUuid: selection.providerUuid, services: services(image, deployment.env) }, {
      onLeaseCreated: async (leaseUuid, providerUrl) => {
        Object.assign(deployment, { leaseUuid, providerUrl, phase: 'lease-created' });
        await save('deployment.json', deployment);
        print({ phase: deployment.phase, leaseUuid, providerUrl });
      },
    }));
    deployment.result = result;
    deployment.phase = 'provider-ready';
    await save('deployment.json', deployment);
    const fqdn = result.connection?.services?.refuge?.fqdn
      ?? result.connection?.services?.refuge?.instances?.[0]?.fqdn
      ?? result.connection?.fqdn
      ?? result.connection?.instances?.[0]?.fqdn;
    // SDK 0.22.0's fallback `url` can be a bare host:port rather than HTTPS.
    // Only a provider-issued FQDN or an explicit HTTPS URL is suitable here.
    const candidate = fqdn ? `https://${fqdn}` : result.url?.startsWith('https://') ? result.url : undefined;
    if (!candidate) throw new Error('Lease ready but no public origin returned; inspect status and set it with origin command');
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Provider did not return a usable HTTPS origin');
    deployment.origin = url.origin;
    deployment.env.PUBLIC_ORIGIN = url.origin;
    await save('deployment.json', deployment);
    const updated = await mutation('origin-update', { origin: url.origin, leaseUuid: deployment.leaseUuid }, () => client.updateApp({ address: record.address, leaseUuid: deployment.leaseUuid!, manifest: json(buildStackManifest({ services: services(image, deployment.env) })) }));
    deployment.phase = 'ready';
    await save('deployment.json', deployment);
    print({ ...deployment, originUpdate: updated });
  } finally { client.dispose(); }
}

async function status() {
  const record = await wallet('deployer');
  const client = await fred();
  try {
    const [balances, leases] = await Promise.all([
      client.getBalance(record.address),
      client.getLeasesByTenant({ tenant: record.address, stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED }),
    ]);
    const credit = await client.query.liftedinit.billing.v1.creditAccount({ tenant: record.address }).catch(() => null);
    const deployment = await exists('deployment.json') ? await read<Deployment>('deployment.json') : null;
    const app = deployment?.leaseUuid ? await client.appStatus({ address: record.address, leaseUuid: deployment.leaseUuid }) : null;
    const creditAmount = credit?.balances.find(c => c.denom === pwrDenom)?.amount;
    const hours = creditAmount && deployment ? Number(creditAmount) / Number(deployment.selection.priceBasePerHour) : null;
    const report = { checkedAt: new Date().toISOString(), chainId, tenant: record.address, balances, credit, leases, app, origin: deployment?.origin, approximateRemainingHoursAtRecordedRate: hours, note: 'Runway is an estimate from current credit and recorded rate; settlement timing and other leases can change it.' };
    await save('status.json', report);
    print(report);
  } finally { client.dispose(); }
}

async function update(image?: string, origin?: string, retireTo?: string) {
  const deployment = await read<Deployment>('deployment.json');
  if (!deployment.leaseUuid || deployment.chainId !== chainId) throw new Error('No matching testnet lease recorded');
  deployment.image = pinnedImage(image ?? deployment.image);
  deployment.env = withTrustedProxyCidrs(deployment.env, process.env.TRUSTED_PROXY_CIDRS);
  if (origin) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected a plain HTTPS origin');
    deployment.origin = url.origin;
    deployment.env.PUBLIC_ORIGIN = url.origin;
  }
  if (retireTo) {
    const url = new URL(retireTo);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin === deployment.origin) throw new Error('Expected a different mainnet HTTPS origin');
    deployment.env.MAINNET_ORIGIN = url.origin;
  }
  const client = await fred();
  try {
    const result = await mutation(`update-${Date.now()}`, { leaseUuid: deployment.leaseUuid, image: deployment.image, origin: deployment.origin }, () => client.updateApp({ address: deployment.tenant, leaseUuid: deployment.leaseUuid!, manifest: json(buildStackManifest({ services: services(deployment.image, deployment.env) })) }));
    deployment.phase = 'ready';
    await save('deployment.json', deployment);
    print(result);
  } finally { client.dispose(); }
}

async function close() {
  const deployment = await read<Deployment>('deployment.json');
  if (!deployment.leaseUuid || deployment.chainId !== chainId) throw new Error('No matching testnet lease recorded');
  const client = await fred();
  try {
    print(await mutation('close', { leaseUuid: deployment.leaseUuid }, () => client.stopApp({ leaseUuid: parseLeaseUuid(deployment.leaseUuid!) })));
    deployment.phase = 'closed';
    await save('deployment.json', deployment);
  } finally { client.dispose(); }
}

async function contribute() {
  const tenant = await wallet('deployer');
  const visitor = await wallet('visitor');
  if (tenant.address === visitor.address) throw new Error('Contribution smoke test requires a different visitor wallet');
  const client = await fred('visitor');
  try { printTransaction(await mutation('contribution', { sender: visitor.address, tenant: tenant.address, amount: '100000', denom: pwrDenom }, () => client.fundCredits({ amount: `100000${pwrDenom}`, tenant: parseAddress(tenant.address) }))); }
  finally { client.dispose(); }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (process.env.NETWORK && process.env.NETWORK !== 'testnet') throw new Error('This tool only operates on testnet');
  switch (command) {
    case 'preflight': return preflight();
    case 'wallet':
      for (const role of ['deployer', 'visitor'] as const) {
        const record = await wallet(role, true);
        print({ role, chainId, address: record.address, secretFile: `.local/${role}-wallet.json` });
      }
      return;
    case 'faucet': return faucet();
    case 'visitor-fund': return visitorFund();
    case 'fund': return fund(arg);
    case 'deploy': return deploy(arg);
    case 'status': return status();
    case 'update': return update(arg);
    case 'origin': return update(undefined, arg);
    case 'retire':
      if (!arg) throw new Error('Pass the live mainnet HTTPS origin');
      return update(undefined, undefined, arg);
    case 'close': return close();
    case 'contribute': return contribute();
    default: throw new Error('Usage: npm run manifest -- preflight|wallet|faucet|visitor-fund|fund [base amount]|deploy IMAGE@sha256:DIGEST|status|update IMAGE@sha256:DIGEST|origin HTTPS_ORIGIN|retire MAINNET_HTTPS_ORIGIN|close|contribute');
  }
}

main().catch(error => { console.error(json(safeError(error))); process.exitCode = 1; });
