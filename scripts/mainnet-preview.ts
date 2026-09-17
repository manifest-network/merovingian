import type { AccountData, EncodeObject, OfflineDirectSigner } from '@cosmjs/proto-signing';
import { CosmosClientManager, createValidatedConfig, parseAddress, type WalletProvider } from '@manifest-network/manifest-sdk';
import { buildManifest, metaHashHex, validateManifest } from '@manifest-network/manifest-sdk/deploy';
import { MsgCreateLease, MsgSetItemCustomDomain } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js';
import { pubkeyToAddress } from 'cosmjs-amino-modern';
import { ECDH } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { MAINNET, assertIdentity, buildPlan, displayPwr, mainnetPaths, publicInputs, type PublicInputs } from './mainnet-config.js';

// This ceiling bounds a *preview*, not permission to spend. Each eventual
// transaction must use a fresh simulation and an independently approved fee.
export const PREVIEW_MAX_GAS = 1_000_000;
export const DOMAIN_PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';
const createLeaseType = '/liftedinit.billing.v1.MsgCreateLease';
const domainType = '/liftedinit.billing.v1.MsgSetItemCustomDomain';

export class PreviewError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PreviewError'; }
}

function assertFresh(expiresAt: string, now: number) {
  if (!Number.isFinite(Date.parse(expiresAt)) || now >= Date.parse(expiresAt)) throw new PreviewError('preflight_expired_refresh_required');
}

/** Rebuild from strict public inputs rather than trusting stored runtimeEnv. */
export async function prepareDeployment(rawQuote: unknown, inputs: PublicInputs, now = Date.now()) {
  let plan: ReturnType<typeof buildPlan>;
  try { plan = buildPlan(rawQuote, inputs, now); }
  catch { throw new PreviewError('invalid_mainnet_public_inputs'); }
  if (!plan.templateReady || !plan.tenant || !plan.image || !plan.selected || !plan.costs) throw new PreviewError('mainnet_plan_not_ready_refresh_preflight');
  if (plan.funding.gasPrice !== `0.5${plan.costs.denom}`) throw new PreviewError('preview_requires_verified_half_base_unit_pwr_gas_price');
  if (BigInt(plan.funding.balances?.availableCreditBase ?? '0') < BigInt(plan.costs.minimumLease.base)) throw new PreviewError('hosting_credit_below_minimum_lease');
  const runtimeEnv = { ...plan.runtimeEnv, REFUGE_TENANT: plan.tenant };
  // Only the plan's allowlisted public runtime environment reaches the provider.
  // No process.env, local filesystem paths, or wallet configuration is copied.
  const manifest = { services: { refuge: buildManifest({ image: plan.image, ports: { '8080/tcp': { ingress: true } }, env: runtimeEnv }) } };
  if (!validateManifest(manifest).valid) throw new PreviewError('sdk_manifest_validation_failed');
  const manifestJson = JSON.stringify(manifest);
  const metaHash = await metaHashHex(manifestJson);
  const createLeaseValue = MsgCreateLease.fromPartial({ tenant: plan.tenant, items: [{ skuUuid: plan.selected.skuUuid, quantity: 1n, serviceName: 'refuge' }], metaHash: Uint8Array.from(Buffer.from(metaHash, 'hex')) });
  const domainValue = MsgSetItemCustomDomain.fromPartial({ sender: plan.tenant, leaseUuid: DOMAIN_PLACEHOLDER_UUID, serviceName: 'refuge', customDomain: MAINNET.domain });
  return {
    plan, manifest, manifestJson, metaHash,
    createLease: { typeUrl: createLeaseType, value: createLeaseValue },
    domain: { typeUrl: domainType, value: domainValue },
  };
}
export type PreparedDeployment = Awaited<ReturnType<typeof prepareDeployment>>;

function accountWallet(address: string, bytes: Uint8Array): WalletProvider {
  const publicKey = Uint8Array.from(bytes);
  const fail = async (): Promise<never> => { throw new PreviewError('preview_cannot_sign'); };
  const signer: OfflineDirectSigner = Object.freeze({
    getAccounts: async () => [{ address, algo: 'secp256k1' as const, pubkey: Uint8Array.from(publicKey) }],
    signDirect: fail,
  });
  return Object.freeze({ getAddress: async () => address, getSigner: async () => signer, signArbitrary: fail });
}

const accountResponseSchema = z.object({ account: z.object({
  '@type': z.literal('/cosmos.auth.v1beta1.BaseAccount'),
  address: z.string(),
  pub_key: z.object({ '@type': z.literal('/cosmos.crypto.secp256k1.PubKey'), key: z.string() }).strict(),
  account_number: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  sequence: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
}).strict() }).strict();

/** Accept only an ordinary account whose on-curve public key derives its address. */
export function publicAccountWallet(rawResponse: unknown, expectedAddress: string): WalletProvider {
  try {
    const expected = parseAddress(expectedAddress);
    const { account } = accountResponseSchema.parse(rawResponse);
    if (account.address !== expected || !/^[A-Za-z0-9+/]{44}$/.test(account.pub_key.key)) throw new Error();
    const publicKey = Buffer.from(account.pub_key.key, 'base64');
    if (publicKey.length !== 33 || publicKey.toString('base64') !== account.pub_key.key || ![2, 3].includes(publicKey[0])) throw new Error();
    // Hashing an arbitrary 33-byte string also produces an address. Check that
    // the compressed point really belongs to secp256k1 before deriving it.
    const checkedPoint = ECDH.convertKey(publicKey, 'secp256k1', undefined, undefined, 'compressed');
    if (!Buffer.isBuffer(checkedPoint) || !checkedPoint.equals(publicKey)
      || pubkeyToAddress({ type: 'tendermint/PubKeySecp256k1', value: account.pub_key.key }, 'manifest') !== expected) throw new Error();
    return accountWallet(expected, publicKey);
  } catch { throw new PreviewError('invalid_public_chain_account'); }
}

async function boundedPublicJson(url: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 64 * 1024) throw new Error();
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch { throw new PreviewError('public_chain_account_query_failed'); }
}

/** Official endpoints only. This path never imports or opens any local wallet. */
export async function fetchPublicAccountWallet(expectedAddress: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<WalletProvider> {
  let address: string;
  try { address = parseAddress(expectedAddress); }
  catch { throw new PreviewError('invalid_public_chain_account'); }
  const [rpc, rest, account] = await Promise.all([
    boundedPublicJson(MAINNET.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: {} }) }, fetcher),
    boundedPublicJson(`${MAINNET.restUrl}/cosmos/base/tendermint/v1beta1/node_info`, {}, fetcher),
    boundedPublicJson(`${MAINNET.restUrl}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`, {}, fetcher),
  ]);
  try { assertIdentity(rpc, rest, now); }
  catch { throw new PreviewError('public_account_network_identity_failed'); }
  return publicAccountWallet(account, address);
}

/**
 * Snapshot only public account data. The SDK never receives the real signer.
 * Even an accidental call to a signing API through this wallet fails closed.
 */
export async function publicSimulationWallet(source: WalletProvider, expectedAddress: string): Promise<WalletProvider> {
  const expected = parseAddress(expectedAddress);
  let accounts: readonly AccountData[];
  try {
    if (await source.getAddress() !== expected) throw new Error();
    accounts = await (await source.getSigner()).getAccounts();
  } catch { throw new PreviewError('public_wallet_account_unavailable'); }
  if (accounts.length !== 1 || accounts[0].address !== expected || accounts[0].algo !== 'secp256k1'
    || accounts[0].pubkey.length !== 33 || ![2, 3].includes(accounts[0].pubkey[0])) throw new PreviewError('public_wallet_account_mismatch');
  return accountWallet(expected, accounts[0].pubkey);
}

/** Exact ceil(gas × 1.5), then ceil(gasLimit × 0.5 PWR base units). */
export function previewFee(simulatedGas: number, denom: string, maxGas = PREVIEW_MAX_GAS) {
  if (!Number.isSafeInteger(maxGas) || maxGas <= 0 || maxGas > PREVIEW_MAX_GAS) throw new PreviewError('invalid_preview_gas_ceiling');
  if (!Number.isSafeInteger(simulatedGas) || simulatedGas <= 0) throw new PreviewError('invalid_simulated_gas');
  const gasLimit = (BigInt(simulatedGas) * 3n + 1n) / 2n;
  if (gasLimit > BigInt(maxGas)) throw new PreviewError('preview_gas_ceiling_exceeded');
  const amount = (gasLimit + 1n) / 2n;
  return { simulatedGas: String(simulatedGas), gasMultiplier: '1.5', gasLimit: String(gasLimit), gasPrice: `0.5${denom}`, amountBase: String(amount), amountPwr: displayPwr(String(amount)), denom };
}

export type PreviewSimulator = (address: string, messages: readonly EncodeObject[], memo: string) => Promise<number>;

/** Simulator injection permits tests without network, key access, or broadcasts. */
export async function simulateDeployment(prepared: PreparedDeployment, simulate: PreviewSimulator, options: { maxGas?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const maxGas = options.maxGas ?? PREVIEW_MAX_GAS;
  const { plan } = prepared;
  assertFresh(plan.quote.expiresAt, now());
  // Validate the cap before contacting any endpoint, even if estimation fails.
  previewFee(1, plan.costs!.denom, maxGas);
  let createGas: number;
  try { createGas = await simulate(plan.tenant!, [prepared.createLease], ''); }
  catch { throw new PreviewError('create_lease_simulation_failed'); }
  const createFee = previewFee(createGas, plan.costs!.denom, maxGas);
  if (BigInt(plan.funding.balances?.pwrWalletBase ?? '0') < BigInt(createFee.amountBase)) throw new PreviewError('wallet_balance_below_create_lease_fee');
  assertFresh(plan.quote.expiresAt, now());
  // A real lease UUID is assigned only after creation. Simulating this explicit
  // placeholder can confirm that limitation but is never a fee for a real lease.
  let placeholderFee: ReturnType<typeof previewFee> | null = null;
  let placeholderStatus: 'rejected_placeholder' | 'placeholder_only_not_executable' = 'rejected_placeholder';
  try {
    const domainGas = await simulate(plan.tenant!, [prepared.domain], '');
    placeholderFee = previewFee(domainGas, plan.costs!.denom, maxGas);
    placeholderStatus = 'placeholder_only_not_executable';
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    // Never include raw SDK / RPC messages or bodies in an operator artifact.
  }
  assertFresh(plan.quote.expiresAt, now());
  return {
    mode: 'unsigned-read-only-deployment-preview', network: MAINNET.network, chainId: MAINNET.chainId,
    generatedAt: new Date(now()).toISOString(), expiresAt: plan.quote.expiresAt,
    signed: false, broadcast: false, executionAuthorized: false, executionReady: false,
    tenant: plan.tenant, image: plan.image, providerUuid: plan.selected!.providerUuid, providerUrl: plan.selected!.providerUrl,
    skuUuid: plan.selected!.skuUuid, skuName: MAINNET.skuName, quantity: '1', serviceName: 'refuge',
    manifest: prepared.manifest, manifestJson: prepared.manifestJson, metaHashHex: prepared.metaHash,
    hosting: { costs: plan.costs, monthlyBudget: plan.monthlyHostingBudget, availableCreditBase: plan.funding.balances!.availableCreditBase },
    transactionPolicy: { maxGasPerTransaction: String(maxGas), gasMultiplier: '1.5', gasPrice: plan.funding.gasPrice, approvalRequiredBeforeSigning: true },
    createLease: { unsignedMessage: { typeUrl: createLeaseType, value: MsgCreateLease.toJSON(prepared.createLease.value) }, memo: '', estimatedFee: createFee },
    customDomain: {
      domain: MAINNET.domain, serviceName: 'refuge', cloudflareProxyAllowed: false,
      unsignedMessageTemplate: { typeUrl: domainType, value: MsgSetItemCustomDomain.toJSON(prepared.domain.value) },
      leaseUuidIsPlaceholder: true, placeholderSimulation: { status: placeholderStatus, estimatedFee: placeholderFee },
      estimatedFee: null, mustResimulateAfterLeaseCreated: true,
    },
    totalTransactionFee: null,
    remainingRequirements: [
      'Approve a fresh create-lease fee before signing; a simulation is not spending approval.',
      'After the lease UUID exists, re-simulate and approve the exact custom-domain transaction; its fee and the combined total remain unknown.',
      'Authenticate and upload the exact hashed manifest through the provider after the lease is confirmed.',
      'Configure provider-specified Cloudflare DNS with proxy disabled, then verify public HTTPS and MCP.',
    ],
  };
}

/** Uses the published SDK transport, but its wallet contains no signing power. */
export async function sdkDeploymentPreview(prepared: PreparedDeployment, source: WalletProvider, maxGas = PREVIEW_MAX_GAS) {
  assertFresh(prepared.plan.quote.expiresAt, Date.now());
  const wallet = await publicSimulationWallet(source, prepared.plan.tenant!);
  const config = createValidatedConfig({
    chainId: MAINNET.chainId, rpcUrl: MAINNET.rpcUrl, restUrl: MAINNET.restUrl,
    gasPrice: prepared.plan.funding.gasPrice, gasMultiplier: 1.5, maxGas, addressPrefix: 'manifest',
    retry: { maxRetries: 0 },
  });
  const chain = CosmosClientManager.getInstance(config, wallet);
  try {
    const client = await chain.getSigningClient();
    if (await client.getChainId() !== MAINNET.chainId) throw new PreviewError('simulation_rpc_chain_mismatch');
    // Calling simulate never signs: CosmJS only reads the public key and sequence
    // and sends an unsigned tx to the chain's simulation query.
    return await simulateDeployment(prepared, (address, messages, memo) => client.simulate(address, messages, memo), { maxGas });
  } finally { chain.disconnect(); }
}

export async function runMainnetPreview(wallet: WalletProvider, workspace = process.cwd()) {
  const paths = mainnetPaths(workspace);
  let inputs: PublicInputs, quote: unknown;
  try {
    inputs = publicInputs(JSON.parse(await readFile(paths.config, 'utf8')));
    quote = JSON.parse(await readFile(paths.quote, 'utf8')) as unknown;
  } catch { throw new PreviewError('public_preflight_or_configuration_unavailable'); }
  const prepared = await prepareDeployment(quote, inputs);
  const preview = await sdkDeploymentPreview(prepared, wallet);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const destination = resolve(paths.directory, 'deployment-preview.json');
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(preview, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
  return { preview, savedTo: destination };
}

async function main() {
  // The keyring adapter loads only when this operator command runs, not when
  // pure manifest/fee helpers are imported for tests or other public planning.
  const args = process.argv.slice(2);
  const publicOnly = args.length === 1 && args[0] === '--public-account';
  const allowed = new Set(['--helper', '--home', '--keyring-backend', '--key-name']);
  const flags = new Map<string, string>();
  for (let i = 0; !publicOnly && i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i])) throw new PreviewError('invalid_preview_arguments');
    flags.set(args[i], args[i + 1]);
  }
  if (!publicOnly && flags.size !== allowed.size) throw new PreviewError('preview_requires_public_account_or_explicit_os_keyring');
  const inputs = publicInputs(JSON.parse(await readFile(mainnetPaths().config, 'utf8')));
  if (!inputs.tenant) throw new PreviewError('production_tenant_missing');
  let wallet: WalletProvider;
  if (publicOnly) wallet = await fetchPublicAccountWallet(inputs.tenant);
  else {
    const backend = flags.get('--keyring-backend')!;
    if (backend !== 'os') throw new PreviewError('production_preview_requires_os_keyring');
    const { createKeyringWalletProvider } = await import('./keyring-wallet.js');
    wallet = await createKeyringWalletProvider({ helperPath: flags.get('--helper')!, home: flags.get('--home')!, keyringBackend: backend, keyName: flags.get('--key-name')!, expectedAddress: inputs.tenant, chainId: MAINNET.chainId });
  }
  try {
    const { preview, savedTo } = await runMainnetPreview(wallet);
    console.log(JSON.stringify({ mode: preview.mode, signed: false, broadcast: false, createLeaseFeePwr: preview.createLease.estimatedFee.amountPwr, totalTransactionFee: null, domainFeeRequiresCreatedLease: true, savedTo }, null, 2));
  } finally { await wallet.disconnect?.(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({ error: error instanceof PreviewError ? error.code : 'mainnet_preview_failed' }));
    process.exitCode = 1;
  });
}
