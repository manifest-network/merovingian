import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CosmosClientManager, createValidatedConfig } from '@manifest-network/manifest-sdk';
import { MsgCreateLease, MsgSetItemCustomDomain } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js';
import type { Lease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { z } from 'zod';
import { MAINNET, mainnetPaths, publicInputs, type PublicInputs, type Quote } from './mainnet-config.js';
import { collectQuote } from './mainnet.js';
import { fetchPublicAccountWallet, prepareDeployment, sdkDeploymentPreview } from './mainnet-preview.js';
import { createKeyringWalletProvider } from './keyring-wallet.js';
import { LaunchError, approvedFeeBudget, inputHash, launchBinding, prepareLaunch, remainingFeeBudget, verifyLaunchLease, type LaunchBinding } from './mainnet-launch-plan.js';
import { createMainnetProvider, type PublicProviderStatus } from './mainnet-provider.js';
import { createTransactionJournal, executeJournaledTransaction, reconcileJournaledTransaction, type JournaledTransactionResult, type TransactionRecord } from './mainnet-transactions.js';

const digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({
  chainId: z.literal(MAINNET.chainId), tenant: z.string(), image: z.string(), providerUuid: z.string().uuid(),
  providerUrl: z.string().url(), skuUuid: z.string().uuid(),
  denom: z.string(), priceBasePerHour: digits, monthlyBudgetBase: digits, gasPrice: z.string(), metaHashHex: hash, inputHash: hash,
}).strict();
const stateSchema = z.object({
  version: z.literal(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  binding: bindingSchema, manifestJson: z.string().max(65536), maxTotalFeeBase: digits,
  phase: z.enum(['prepared', 'lease-created', 'domain-claimed', 'upload-started', 'provider-pending', 'awaiting-dns']),
  leaseUuid: z.string().uuid().optional(),
  upload: z.enum(['not-started', 'started', 'accepted', 'uncertain']),
  provider: z.unknown().optional(),
}).strict();
export type LaunchState = z.infer<typeof stateSchema>;
const txIds = ['create-lease', 'claim-domain'] as const;
type TxId = typeof txIds[number];

export function launchMessages(binding: LaunchBinding, leaseUuid?: string): { create: EncodeObject; domain?: EncodeObject } {
  return {
    create: { typeUrl: '/liftedinit.billing.v1.MsgCreateLease', value: MsgCreateLease.fromPartial({
      tenant: binding.tenant, items: [{ skuUuid: binding.skuUuid, quantity: 1n, serviceName: 'refuge' }],
      metaHash: Uint8Array.from(Buffer.from(binding.metaHashHex, 'hex')),
    }) },
    ...(leaseUuid ? { domain: { typeUrl: '/liftedinit.billing.v1.MsgSetItemCustomDomain', value: MsgSetItemCustomDomain.fromPartial({
      sender: binding.tenant, leaseUuid, serviceName: 'refuge', customDomain: MAINNET.domain,
    }) } } : {}),
  };
}

export interface LaunchDependencies {
  quote(): Promise<Quote>;
  lease(id: string): Promise<Lease | null>;
  record(id: TxId): Promise<TransactionRecord | null>;
  execute(id: TxId, message: EncodeObject, maxFeeBase: string): Promise<JournaledTransactionResult>;
  save(state: LaunchState): Promise<void>;
  upload(input: { leaseUuid: string; manifest: string; metaHash: string }): Promise<unknown>;
  providerStatus(leaseUuid: string): Promise<PublicProviderStatus>;
  ready(leaseUuid: string): Promise<PublicProviderStatus>;
}

function assertState(state: LaunchState, inputs: PublicInputs) {
  stateSchema.parse(state);
  if (state.binding.inputHash !== inputHash(inputs)
    || createHash('sha256').update(state.manifestJson).digest('hex') !== state.binding.metaHashHex
    || BigInt(state.maxTotalFeeBase) <= 0n || BigInt(state.maxTotalFeeBase) > 1_000_000n) throw new LaunchError('invalid_or_changed_launch_state');
}

/** One launch, two exact transactions, no implicit update/restore/replacement. */
export async function advanceLaunch(state: LaunchState, inputs: PublicInputs, deps: LaunchDependencies): Promise<LaunchState> {
  assertState(state, inputs);
  const persist = async () => { state.updatedAt = new Date().toISOString(); await deps.save(state); };
  const transact = async (id: TxId, message: EncodeObject) => {
    const records = await Promise.all(txIds.filter(other => other !== id).map(other => deps.record(other)));
    const remaining = remainingFeeBudget(state.maxTotalFeeBase, records.filter((r): r is TransactionRecord => r !== null));
    const result = await deps.execute(id, message, remaining);
    if (result.status !== 'committed') throw new LaunchError(`transaction_${id}_${result.status}`);
    return result.record;
  };
  // Reconcile the recorded hash before applying the initial no-existing-lease
  // check: a process can die after chain commit but before saving leaseUuid.
  const recordedCreation = await deps.record('create-lease');
  if (!state.leaseUuid && recordedCreation) {
    const recovered = await transact('create-lease', launchMessages(state.binding).create);
    if (!recovered.receipt?.leaseUuid) throw new LaunchError('committed_create_missing_lease_receipt');
    state.leaseUuid = recovered.receipt.leaseUuid;
    verifyLaunchLease(await deps.lease(state.leaseUuid), state.leaseUuid, state.binding);
    state.phase = 'lease-created'; await persist();
  }
  let lease = state.leaseUuid ? await deps.lease(state.leaseUuid) : null;
  const prepared = await prepareLaunch(await deps.quote(), inputs,
    state.leaseUuid ? { binding: state.binding, leaseUuid: state.leaseUuid, lease } : undefined);
  if (prepared.manifestJson !== state.manifestJson) throw new LaunchError('launch_manifest_changed');
  if (!state.leaseUuid) {
    const binding = launchBinding(prepared, inputs);
    if (JSON.stringify(binding) !== JSON.stringify(state.binding)) throw new LaunchError('launch_quote_changed_prepare_again');
    const created = await transact('create-lease', prepared.createLease);
    if (!created.receipt?.leaseUuid) throw new LaunchError('committed_create_missing_lease_receipt');
    state.leaseUuid = created.receipt.leaseUuid;
    lease = await deps.lease(state.leaseUuid);
    verifyLaunchLease(lease, state.leaseUuid, state.binding);
    state.phase = 'lease-created'; await persist();
  }
  verifyLaunchLease(lease, state.leaseUuid, state.binding);
  if (lease.items[0].customDomain !== MAINNET.domain) {
    // A real UUID is now available: estimate and sign only within the remaining
    // total allowance. Persisting each transaction precedes its broadcast.
    await transact('claim-domain', launchMessages(state.binding, state.leaseUuid).domain!);
    lease = await deps.lease(state.leaseUuid);
    verifyLaunchLease(lease, state.leaseUuid, state.binding);
    if (lease.items[0].customDomain !== MAINNET.domain) throw new LaunchError('domain_commit_not_reflected_on_chain');
  }
  state.phase = 'domain-claimed'; await persist();
  if (state.upload === 'started' || state.upload === 'uncertain') {
    const status = await deps.providerStatus(state.leaseUuid);
    if (!status.payloadReceived || status.metaHash !== state.binding.metaHashHex) throw new LaunchError('upload_requires_read_only_reconciliation');
    state.upload = 'accepted'; await persist();
  }
  if (state.upload === 'not-started') {
    state.phase = 'upload-started'; state.upload = 'started'; await persist();
    try {
      await deps.upload({ leaseUuid: state.leaseUuid, manifest: state.manifestJson, metaHash: state.binding.metaHashHex });
      state.upload = 'accepted'; await persist();
    } catch {
      state.upload = 'uncertain'; await persist();
      throw new LaunchError('provider_upload_uncertain_resume_checks_status_only');
    }
  }
  const status = await deps.ready(state.leaseUuid);
  state.provider = status;
  state.phase = status.ready ? 'awaiting-dns' : 'provider-pending';
  await persist();
  return state;
}

async function durableJson(path: string, value: unknown, exclusive = false) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(exclusive ? path : temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) await rename(temporary, path);
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readState(path: string): Promise<LaunchState | null> {
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > 131072) throw new LaunchError('launch_state_too_large');
    return stateSchema.parse(JSON.parse(raw));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flags = new Map<string, string>();
  const allowed = new Set(['--helper', '--home', '--key-name', '--max-total-fee-pwr']);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags.has(args[i])) throw new LaunchError('invalid_launch_arguments');
    flags.set(args[i], args[i + 1]);
  }
  if (!['prepare', 'run', 'status'].includes(command)) throw new LaunchError('usage_mainnet_launch_prepare_run_or_status');
  if (command !== 'run' && flags.size) throw new LaunchError('read_only_commands_take_no_signer_flags');
  const paths = mainnetPaths();
  const directory = resolve(paths.directory, 'launch');
  const statePath = resolve(directory, 'state.json');
  const inputs = publicInputs(JSON.parse(await readFile(paths.config, 'utf8')));
  if (!inputs.tenant) throw new LaunchError('production_tenant_missing');
  if (command === 'prepare') {
    if (await readState(statePath)) throw new LaunchError('launch_exists_use_status_or_resume');
    const quote = await collectQuote(inputs);
    const prepared = await prepareDeployment(quote, inputs);
    const preview = await sdkDeploymentPreview(prepared, await fetchPublicAccountWallet(inputs.tenant));
    const proposal = { version: 1, preparedAt: new Date().toISOString(), quote, binding: launchBinding(prepared, inputs), manifestJson: prepared.manifestJson, preview };
    await durableJson(resolve(directory, 'proposal.json'), proposal);
    console.log(JSON.stringify({ mode: 'unsigned-launch-proposal', createLeaseFeePwr: preview.createLease.estimatedFee.amountPwr, domainFee: null, suggestedTotalGasCapPwr: '0.5', hostingPwrPer30Days: prepared.plan.costs!.days30.pwr, signed: false, broadcast: false, savedTo: resolve(directory, 'proposal.json') }, null, 2));
    return;
  }
  if (command === 'status') {
    const state = await readState(statePath);
    const quote = await collectQuote(inputs);
    const transactions = [];
    if (state) {
      assertState(state, inputs);
      const wallet = await fetchPublicAccountWallet(inputs.tenant);
      const config = createValidatedConfig({ chainId: MAINNET.chainId, rpcUrl: MAINNET.rpcUrl, restUrl: MAINNET.restUrl, gasPrice: state.binding.gasPrice, retry: { maxRetries: 0 } });
      const chain = CosmosClientManager.getInstance(config, wallet);
      try {
        const client = await chain.getSigningClient();
        const journal = createTransactionJournal(resolve(directory, 'transactions'));
        for (const id of txIds) {
          const result = await reconcileJournaledTransaction({ id, client, journal, pollTimeoutMs: 1000 });
          if (result) transactions.push({ id, status: result.status, hash: result.record.transactionHash, feeBase: result.record.fee.amountBase, receipt: result.record.receipt });
        }
      } finally { chain.disconnect(); }
    }
    console.log(JSON.stringify({ phase: state?.phase ?? 'not-started', leaseUuid: state?.leaseUuid ?? null, transactions, chain: { observedAt: quote.observedAt, domain: quote.domainClaim, tenant: quote.tenant, dns: quote.dns }, signingAvailable: false }, null, 2));
    return;
  }
  if (flags.size !== allowed.size) throw new LaunchError('run_requires_helper_home_key_name_and_explicit_total_fee_cap');
  const maxTotalFeeBase = approvedFeeBudget(flags.get('--max-total-fee-pwr')!);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(directory, 'run.lock');
  const lockToken = randomUUID();
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new LaunchError('launch_locked_reconcile_before_removing_stale_lock'); });
  try { await lock.writeFile(JSON.stringify({ token: lockToken, pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync(); }
  finally { await lock.close(); }
  try {
    // All read-client factories finish before acquiring the signing manager:
    // SDK 0.22.0 shares a mutable singleton for identical network endpoints.
    const freshQuote = await collectQuote(inputs);
    let state = await readState(statePath);
    if (!state) {
      const prepared = await prepareDeployment(freshQuote, inputs);
      state = { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), binding: launchBinding(prepared, inputs), manifestJson: prepared.manifestJson, maxTotalFeeBase, phase: 'prepared', upload: 'not-started' };
      await durableJson(statePath, state, true);
    }
    assertState(state, inputs);
    if (state.maxTotalFeeBase !== maxTotalFeeBase) throw new LaunchError('launch_fee_cap_changed_requires_review');
    const helper = flags.get('--helper')!;
    const proof = JSON.parse(await readFile(resolve(paths.directory, 'keyring-check.json'), 'utf8'));
    if (proof.status !== 'passed' || proof.address !== state.binding.tenant || proof.helperSha256 !== createHash('sha256').update(await readFile(helper)).digest('hex')) throw new LaunchError('helper_requires_verified_local_compatibility_proof');
    const wallet = await createKeyringWalletProvider({ helperPath: helper, home: flags.get('--home')!, keyName: flags.get('--key-name')!, keyringBackend: 'os', expectedAddress: state.binding.tenant, chainId: MAINNET.chainId });
    const config = createValidatedConfig({ chainId: MAINNET.chainId, rpcUrl: MAINNET.rpcUrl, restUrl: MAINNET.restUrl, gasPrice: state.binding.gasPrice, gasMultiplier: 1.5, maxGas: 1_000_000, addressPrefix: 'manifest', retry: { maxRetries: 0 } });
    const chain = CosmosClientManager.getInstance(config, wallet);
    try {
      const client = await chain.getSigningClient();
      const query = await chain.getQueryClient();
      const [account] = await (await wallet.getSigner()).getAccounts();
      const journal = createTransactionJournal(resolve(directory, 'transactions'));
      const provider = createMainnetProvider({ wallet, tenant: state.binding.tenant, providerUuid: state.binding.providerUuid, providerUrl: state.binding.providerUrl });
      const result = await advanceLaunch(state, inputs, {
        quote: async () => freshQuote,
        lease: async id => (await query.liftedinit.billing.v1.lease({ leaseUuid: id })).lease ?? null,
        record: id => journal.load(id),
        execute: (id, message, maxFeeBase) => executeJournaledTransaction({ id, messages: [message], memo: '', maxFeeBase, denom: state!.binding.denom, tenant: state!.binding.tenant, publicKey: account!.pubkey, client, journal, pollTimeoutMs: 45_000 }),
        save: value => durableJson(statePath, value), upload: input => provider.upload(input),
        providerStatus: id => provider.status({ leaseUuid: id }),
        ready: async id => {
          const result = await provider.waitUntilReady({ leaseUuid: id, timeoutMs: 45_000 });
          if (!result.status) throw new LaunchError('provider_readiness_unconfirmed_resume_existing_lease');
          return result.status;
        },
      });
      console.log(JSON.stringify({ phase: result.phase, leaseUuid: result.leaseUuid, domain: MAINNET.domain, provider: result.provider, cloudflareProxyAllowed: false, maxTotalFeeBase: result.maxTotalFeeBase, savedTo: statePath }, null, 2));
    } finally { chain.disconnect(); await wallet.disconnect(); }
  } finally {
    try { if (JSON.parse(await readFile(lockPath, 'utf8')).token === lockToken) await unlink(lockPath); }
    catch { /* A surviving lock safely requires local reconciliation. */ }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({ error: error instanceof LaunchError ? error.code : 'mainnet_launch_failed_reconcile_recorded_state' }));
    process.exitCode = 1;
  });
}
