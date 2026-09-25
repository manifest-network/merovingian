import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createManifestReadClient, createSignerAdapter, parseLeaseUuid, type WalletProvider } from '@manifest-network/manifest-sdk';
import { createGuardedFetch } from '@manifest-network/manifest-sdk/node';
import { buildManifest, createProviderAuth, fetchJsonChecked, getLeaseReleases, getProviderHealth, updateLease, validateManifest } from '@manifest-network/manifest-sdk/deploy';
import { LeaseState, type Lease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { z } from 'zod';
import { MAINNET, mainnetPaths, publicInputs } from './mainnet-config.js';
import { collectQuote } from './mainnet.js';
import { verifyLaunchLease, type LaunchBinding } from './mainnet-launch-plan.js';
import { createKeyringWalletProvider, type KeyringWalletProvider } from './keyring-wallet.js';
import { MAINNET_PROVIDER } from './mainnet-provider.js';
import { normalizeTrustedProxyCidrs, trustedProxyCidrsSchema, withTrustedProxyCidrs } from './runtime-proxy.js';

export const MAINNET_UPDATE_LEASE = '01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd';
/**
 * Fred v0.13 closes an ACTIVE lease on chain when a failure leaves its provision
 * failed with at least this many failures. Container exits (including after a
 * host reboot), failed (re-)provisions and failed updates or restarts, even rolled
 * back ones, each add one, and nothing resets the count while the lease lives
 * (ENG-799). At the limit, a rolled-back failure leaves the lease running, but its
 * next failure of any kind closes it.
 */
export const PROVIDER_STRIKE_LIMIT = 3;
const pinnedImage = z.string().regex(/^ghcr\.io\/(?:manifest-network|fmorency)\/merovingian@sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const manifestEnv = z.object({ NETWORK: z.literal('mainnet'), CHAIN_ID: z.literal(MAINNET.chainId), MANIFEST_RPC_URL: z.literal(MAINNET.rpcUrl), MANIFEST_REST_URL: z.literal(MAINNET.restUrl),
  MANIFEST_GAS_PRICE: z.string(), PWR_DENOM: z.string(), REFUGE_TENANT: z.string(), PUBLIC_ORIGIN: z.literal(`https://${MAINNET.domain}`), PORT: z.literal('8080'), NODE_ENV: z.literal('production'), TRUST_PROXY_HOPS: z.literal('0').optional(), TRUSTED_PROXY_CIDRS: trustedProxyCidrsSchema.optional(), VISIT_COUNTS_PATH: z.literal('/data/visits.sqlite').optional() }).strict();
const manifestSchema = z.object({ services: z.object({ refuge: z.object({ image: pinnedImage,
  ports: z.object({ '8080/tcp': z.object({ ingress: z.literal(true) }).strict() }).strict(),
  env: manifestEnv, user: z.literal('1000:1000').optional(),
}).strict() }).strict() }).strict();
const bindingSchema = z.object({ chainId: z.literal(MAINNET.chainId), tenant: z.string(), image: pinnedImage,
  providerUuid: z.literal(MAINNET_PROVIDER.uuid), providerUrl: z.literal(MAINNET_PROVIDER.url), skuUuid: z.string().uuid(),
  denom: z.string(), priceBasePerHour: z.string().regex(/^[1-9][0-9]*$/), monthlyBudgetBase: z.string().regex(/^[1-9][0-9]*$/),
  gasPrice: z.string(), metaHashHex: sha, inputHash: sha }).strict();
const stateSchema = z.object({ version: z.literal(1), operationId: z.string().uuid(), leaseUuid: z.literal(MAINNET_UPDATE_LEASE), binding: bindingSchema,
  image: pinnedImage, beforeImage: pinnedImage, beforeManifestHash: sha, manifestHash: sha, manifestJson: z.string().max(65536),
  phase: z.enum(['prepared', 'attempted', 'accepted', 'uncertain', 'ready']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  observed: z.object({ activeImage: pinnedImage.nullable(), activeManifestHash: sha.nullable(), activeReleaseVersion: z.number().int().positive().nullable(), ready: z.boolean(), failCount: z.number().int().nonnegative().optional() }).strict().optional(),
}).strict();
export type MainnetUpdateState = z.infer<typeof stateSchema>;
export interface UpdateObservation { lease: Lease; ready: boolean; failCount: number; active: { image: string; manifestJson: string; manifestHash: string; version: number } | null }
export class MainnetUpdateError extends Error { constructor(readonly code: string) { super(code); this.name = 'MainnetUpdateError'; } }
function fail(code: string): never { throw new MainnetUpdateError(code); }
/** A failed update could use the last strike and close the lease, so refuse it. */
function assertStrikeRemains(failCount: number) {
  if (failCount >= PROVIDER_STRIKE_LIMIT - 1) fail('update_blocked_last_provider_strike');
}

function publicManifest(text: string, binding: LaunchBinding) {
  try {
    if (Buffer.byteLength(text) > 65536) throw new Error();
    const manifest = manifestSchema.parse(JSON.parse(text));
    const env = manifest.services.refuge.env;
    if (env.REFUGE_TENANT !== binding.tenant || env.PWR_DENOM !== binding.denom || env.MANIFEST_GAS_PRICE !== binding.gasPrice) throw new Error();
    if (!validateManifest(manifest).valid) throw new Error();
    return manifest;
  } catch { return fail('update_manifest_not_in_reviewed_scope'); }
}

export function decodeReleaseManifest(encoded: string): string {
  try {
    if (encoded.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 65536 || bytes.toString('base64') !== encoded) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.startsWith('{')) throw new Error();
    return text;
  } catch { return fail('invalid_provider_release_manifest'); }
}

function verifyLease(lease: Lease, binding: LaunchBinding) {
  try { verifyLaunchLease(lease, MAINNET_UPDATE_LEASE, binding); }
  catch { return fail('update_lease_identity_or_price_changed'); }
  if (lease.state !== LeaseState.LEASE_STATE_ACTIVE || lease.items[0].customDomain !== MAINNET.domain) fail('update_requires_active_existing_domain_lease');
}

export function prepareMainnetUpdate(bindingInput: LaunchBinding, current: UpdateObservation, nextImage: string, options: { now?: number; trustedProxyCidrs?: string } = {}): MainnetUpdateState {
  const now = options.now ?? Date.now();
  let binding: LaunchBinding;
  try { binding = bindingSchema.parse(bindingInput); pinnedImage.parse(nextImage); if (options.trustedProxyCidrs !== undefined) trustedProxyCidrsSchema.parse(options.trustedProxyCidrs); }
  catch { return fail('invalid_update_configuration'); }
  verifyLease(current.lease, binding);
  if (!current.ready || !current.active) fail('update_requires_ready_active_release');
  if (digest(current.active.manifestJson) !== current.active.manifestHash) fail('provider_active_manifest_hash_mismatch');
  const old = publicManifest(current.active.manifestJson, binding);
  if (old.services.refuge.image !== current.active.image) fail('provider_active_image_mismatch');
  if (current.active.image === nextImage) fail('requested_image_already_active');
  assertStrikeRemains(current.failCount);
  const service = old.services.refuge;
  const env = withTrustedProxyCidrs({ ...service.env, VISIT_COUNTS_PATH: '/data/visits.sqlite' }, options.trustedProxyCidrs);
  const manifest = { services: { refuge: buildManifest({ ...service, image: nextImage, user: '1000:1000', env }) } };
  const manifestJson = JSON.stringify(manifest);
  publicManifest(manifestJson, binding);
  return stateSchema.parse({ version: 1, operationId: randomUUID(), leaseUuid: MAINNET_UPDATE_LEASE, binding, image: nextImage, beforeImage: current.active.image,
    beforeManifestHash: current.active.manifestHash, manifestHash: digest(manifestJson), manifestJson, phase: 'prepared', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
}

export interface UpdateDependencies {
  observe(signal?: AbortSignal): Promise<UpdateObservation>;
  save(state: MainnetUpdateState): Promise<void>;
  post(input: { leaseUuid: string; operationId: string; manifestJson: string }): Promise<void>;
  wait?(ms: number): Promise<void>; now?(): number;
}

async function untilDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(new MainnetUpdateError('provider_observation_unconfirmed'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

export function assertUpdateHistoryCanProceed(history: readonly MainnetUpdateState[], targetImage: string) {
  for (const raw of history) {
    const previous = stateSchema.parse(raw);
    if (previous.image !== targetImage && ['attempted', 'accepted', 'uncertain'].includes(previous.phase)) fail('another_unresolved_update_requires_reconciliation');
  }
}

/** Check reviewed bytes and explicit CLI intent before any wallet/provider work. */
export function assertMainnetUpdateIntent(rawState: MainnetUpdateState, trustedProxyCidrs?: string) {
  const state = stateSchema.parse(rawState);
  const manifest = publicManifest(state.manifestJson, state.binding);
  if (digest(state.manifestJson) !== state.manifestHash || manifest.services.refuge.image !== state.image) fail('update_intent_changed');
  if (trustedProxyCidrs !== undefined
    && normalizeTrustedProxyCidrs(trustedProxyCidrs) !== normalizeTrustedProxyCidrs(manifest.services.refuge.env.TRUSTED_PROXY_CIDRS ?? '')) {
    fail('update_trusted_proxy_cidrs_conflicts_with_journal');
  }
}

/** Existing attempted updates can only reconcile; no automatic POST retry. */
export async function advanceMainnetUpdate(rawState: MainnetUpdateState, deps: UpdateDependencies, allowPost: boolean, timeoutMs = 45_000): Promise<MainnetUpdateState> {
  const state = stateSchema.parse(rawState);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) fail('invalid_update_poll_timeout');
  assertMainnetUpdateIntent(state);
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? (ms => sleep(ms));
  const persist = async () => { state.updatedAt = new Date(now()).toISOString(); await deps.save(state); };
  const observe = async (timeout = 15_000) => {
    const signal = AbortSignal.timeout(timeout);
    const current = await untilDeadline(deps.observe(signal), signal); verifyLease(current.lease, state.binding);
    if (current.active) {
      const manifest = publicManifest(current.active.manifestJson, state.binding);
      if (current.active.manifestHash !== digest(current.active.manifestJson) || current.active.image !== manifest.services.refuge.image) fail('provider_active_manifest_mismatch');
    }
    state.observed = { activeImage: current.active?.image ?? null, activeManifestHash: current.active?.manifestHash ?? null, activeReleaseVersion: current.active?.version ?? null, ready: current.ready, failCount: current.failCount };
    if (current.ready && current.active?.manifestHash === state.manifestHash) { state.phase = 'ready'; await persist(); return true; }
    if (current.active && ![state.beforeManifestHash, state.manifestHash].includes(current.active.manifestHash)) fail('another_update_requires_manual_reconciliation');
    return false;
  };
  if (await observe()) return state;
  if (state.phase === 'ready') fail('previously_ready_update_is_no_longer_active');
  if (state.phase === 'prepared') {
    if (!allowPost) return state;
    if (!state.observed?.ready || state.observed.activeManifestHash !== state.beforeManifestHash) fail('update_base_release_changed');
    assertStrikeRemains(state.observed.failCount ?? PROVIDER_STRIKE_LIMIT);
    state.phase = 'attempted'; await persist();
    try { await deps.post({ leaseUuid: state.leaseUuid, operationId: state.operationId, manifestJson: state.manifestJson }); state.phase = 'accepted'; }
    catch { state.phase = 'uncertain'; }
    await persist();
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try { if (await observe(Math.max(1, Math.min(15_000, deadline - now())))) return state; }
    catch (error) { if (error instanceof MainnetUpdateError && error.code !== 'provider_observation_unconfirmed') throw error; }
    await wait(Math.min(2500, Math.max(0, deadline - now())));
  }
  state.phase = 'uncertain';
  await persist(); return state;
}

export function mainnetUpdateFetch(operationId: string, transport: typeof fetch = createGuardedFetch()): typeof fetch {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) fail('invalid_update_operation_id');
  const base = new URL(MAINNET_PROVIDER.url);
  const leasePath = `${base.pathname}/v1/leases/${MAINNET_UPDATE_LEASE}/`;
  return async (input, init = {}) => {
    try {
      if (typeof input !== 'string' && !(input instanceof URL)) throw new Error();
      const url = new URL(String(input)), method = (init.method ?? 'GET').toUpperCase();
      const update = url.pathname === `${leasePath}update`;
      if (url.origin !== base.origin || url.username || url.password || url.search || url.hash
        || ![`${base.pathname}/health`, `${leasePath}status`, `${leasePath}releases`, `${leasePath}update`].includes(url.pathname)
        || method !== (update ? 'POST' : 'GET')) throw new Error();
      const headers = new Headers(init.headers);
      if (update) headers.set('Idempotency-Key', operationId);
      const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])]);
      signal.throwIfAborted();
      const response = await transport(url.href, { ...init, headers, redirect: 'error', credentials: 'omit', cache: 'no-store', signal });
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== url.href) { await response.body?.cancel().catch(() => {}); throw new Error(); }
      return response;
    } catch { throw new MainnetUpdateError('update_provider_transport_refused_or_unavailable'); }
  };
}

async function durableJson(path: string, value: unknown, exclusive = false) {
  const directoryPath = resolve(path, '..'); await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(temporary, path);
  const directory = await open(directoryPath, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

function updateProvider(binding: LaunchBinding, wallet: WalletProvider, operationId: string, lease: () => Promise<Lease>) {
  const transport = mainnetUpdateFetch(operationId);
  const auth = createProviderAuth(createSignerAdapter(wallet), { chainId: MAINNET.chainId });
  // Fred v0.13 omits fail_count when it is zero.
  const statusSchema = z.object({ state: z.string(), provision_status: z.string().optional(), fail_count: z.number().int().nonnegative().optional() });
  const fetchUntil = (signal?: AbortSignal): typeof fetch => (input, init = {}) => transport(input, { ...init, ...(signal ? { signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) } : {}) });
  const verified = async (fetcher: typeof fetch) => {
    if (await wallet.getAddress() !== binding.tenant) fail('update_wallet_mismatch');
    const health = await getProviderHealth(MAINNET_PROVIDER.url, 10_000, fetcher);
    if (health.status !== 'healthy' || health.provider_uuid !== MAINNET_PROVIDER.uuid) fail('update_provider_identity_failed');
  };
  return {
    async observe(signal = AbortSignal.timeout(15_000)): Promise<UpdateObservation> {
      try {
        const fetcher = fetchUntil(signal);
        const currentLease = await untilDeadline(lease(), signal); verifyLease(currentLease, binding); await verified(fetcher); signal.throwIfAborted();
        const token = await auth.providerToken({ address: binding.tenant, leaseUuid: MAINNET_UPDATE_LEASE });
        const status = await fetchJsonChecked(`${MAINNET_PROVIDER.url}/v1/leases/${MAINNET_UPDATE_LEASE}/status`, { headers: { Authorization: `Bearer ${token}` } }, { schema: statusSchema, fetchFn: fetcher, maxBytes: 65536 });
        signal.throwIfAborted();
        const releaseToken = await auth.providerToken({ address: binding.tenant, leaseUuid: MAINNET_UPDATE_LEASE });
        const response = await getLeaseReleases(MAINNET_PROVIDER.url, MAINNET_UPDATE_LEASE, releaseToken, fetcher);
        if (response.lease_uuid !== MAINNET_UPDATE_LEASE || response.tenant !== binding.tenant || response.provider_uuid !== MAINNET_PROVIDER.uuid || response.releases.length > 100) fail('update_release_identity_mismatch');
        const active = response.releases.filter(item => item.status === 'active');
        if (active.length > 1) fail('multiple_active_releases_require_reconciliation');
        let release: UpdateObservation['active'] = null;
        if (active[0]) {
          if (!active[0].manifest || !Number.isSafeInteger(active[0].version) || active[0].version < 1) fail('provider_active_manifest_missing');
          const manifestJson = decodeReleaseManifest(active[0].manifest);
          const manifest = publicManifest(manifestJson, binding);
          release = { image: manifest.services.refuge.image, manifestJson, manifestHash: digest(manifestJson), version: active[0].version };
        }
        return { lease: currentLease, ready: status.state === 'LEASE_STATE_ACTIVE' && status.provision_status === 'ready', failCount: status.fail_count ?? 0, active: release };
      } catch (error) { if (error instanceof MainnetUpdateError) throw error; throw new MainnetUpdateError('provider_observation_unconfirmed'); }
    },
    async post(input: { leaseUuid: string; operationId: string; manifestJson: string }) {
      if (input.leaseUuid !== MAINNET_UPDATE_LEASE || input.operationId !== operationId) fail('update_request_identity_mismatch');
      const signal = AbortSignal.timeout(30_000), fetcher = fetchUntil(signal);
      publicManifest(input.manifestJson, binding); verifyLease(await untilDeadline(lease(), signal), binding); await verified(fetcher); signal.throwIfAborted();
      const token = await untilDeadline(auth.providerToken({ address: binding.tenant, leaseUuid: MAINNET_UPDATE_LEASE }), signal);
      signal.throwIfAborted();
      try {
        const response = await updateLease(MAINNET_PROVIDER.url, MAINNET_UPDATE_LEASE, new TextEncoder().encode(input.manifestJson), token, fetcher);
        if (response.status !== 'updating') fail('update_provider_acceptance_unconfirmed');
      } catch { throw new MainnetUpdateError('update_outcome_indeterminate'); }
    },
  };
}

export function parseMainnetUpdateArguments(argv: readonly string[]) {
  const [command, ...args] = argv;
  if (!['prepare', 'run', 'status'].includes(command)) fail('usage_mainnet_update_prepare_run_or_status');
  const required = ['--image', '--helper', '--home', '--key-name'];
  const flags = new Map<string, string>(), allowed = new Set([...required, '--trusted-proxy-cidrs']);
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!allowed.has(args[i]) || value === undefined || value === '' && args[i] !== '--trusted-proxy-cidrs'
      || value.startsWith('--') || flags.has(args[i])) fail('invalid_update_arguments');
    flags.set(args[i], args[i + 1]);
  }
  if (required.some(flag => !flags.has(flag))) fail('update_requires_image_helper_home_key_name');
  const image = pinnedImage.parse(flags.get('--image'));
  const requested = flags.get('--trusted-proxy-cidrs');
  return { command, image, helper: flags.get('--helper')!, home: flags.get('--home')!, keyName: flags.get('--key-name')!,
    trustedProxyCidrs: requested === undefined ? undefined : normalizeTrustedProxyCidrs(requested) };
}

async function main() {
  const { command, image, helper, home, keyName, trustedProxyCidrs } = parseMainnetUpdateArguments(process.argv.slice(2));
  const paths = mainnetPaths(), directoryPath = resolve(paths.directory, 'updates'), statePath = resolve(directoryPath, `${image.split('@sha256:')[1]}.json`);
  const launch = JSON.parse(await readFile(resolve(paths.directory, 'launch/state.json'), 'utf8')) as { binding: LaunchBinding; leaseUuid: string; manifestJson: string };
  const binding = bindingSchema.parse(launch.binding);
  if (launch.leaseUuid !== MAINNET_UPDATE_LEASE || digest(launch.manifestJson) !== binding.metaHashHex) fail('update_launch_record_invalid');
  const inputs = publicInputs(JSON.parse(await readFile(paths.config, 'utf8')));
  if (inputs.tenant !== binding.tenant || inputs.providerUuid !== binding.providerUuid) fail('update_public_configuration_changed');
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const lockPath = resolve(directoryPath, 'run.lock'), lockId = randomUUID();
  await durableJson(lockPath, { id: lockId, pid: process.pid }, true).catch(() => fail('update_locked_requires_local_reconciliation'));
  try {
    // A new image must not bypass an unresolved POST for an earlier image.
    // A delayed earlier update could still replace this lease's containers.
    for (const filename of await readdir(directoryPath)) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename) || resolve(directoryPath, filename) === statePath) continue;
      const previous = stateSchema.parse(JSON.parse(await readFile(resolve(directoryPath, filename), 'utf8')));
      assertUpdateHistoryCanProceed([previous], image);
    }
    let state: MainnetUpdateState | null;
    try { state = stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') state = null; else throw error; }
    if (state && (state.image !== image || JSON.stringify(state.binding) !== JSON.stringify(binding))) fail('update_journal_binding_changed');
    if (state) assertMainnetUpdateIntent(state, trustedProxyCidrs);
    else if (command === 'status') fail('update_record_not_found');
    const quote = await collectQuote(inputs);
    if (quote.tenant?.liveLeaseUuids.length !== 1 || quote.tenant.liveLeaseUuids[0] !== MAINNET_UPDATE_LEASE
      || quote.domainClaim.leaseUuid !== MAINNET_UPDATE_LEASE || quote.domainClaim.tenant !== binding.tenant) fail('update_live_lease_or_domain_mismatch');
    const proof = JSON.parse(await readFile(resolve(paths.directory, 'keyring-check.json'), 'utf8'));
    if (proof.status !== 'passed' || proof.address !== binding.tenant || proof.helperSha256 !== createHash('sha256').update(await readFile(helper)).digest('hex')) fail('update_helper_compatibility_proof_missing');
    // SDK 0.23 verifies REST chain identity while creating the read client, so
    // create it before the keyring wallet: a failed check then skips no cleanup.
    const client = await createManifestReadClient({ config: { chainId: MAINNET.chainId, rpcUrl: MAINNET.rpcUrl, restUrl: MAINNET.restUrl, gasPrice: binding.gasPrice, retry: { maxRetries: 0 } } });
    let wallet: KeyringWalletProvider | undefined;
    try {
      wallet = await createKeyringWalletProvider({ helperPath: helper, home, keyName, keyringBackend: 'os', expectedAddress: binding.tenant, chainId: MAINNET.chainId });
      const operationId = state?.operationId ?? randomUUID();
      const provider = updateProvider(binding, wallet, operationId, async () => {
        const value = await client.getLease(parseLeaseUuid(MAINNET_UPDATE_LEASE));
        if (!value) fail('existing_update_lease_not_found'); return value;
      });
      let preparedFrom: UpdateObservation | undefined;
      if (!state) {
        preparedFrom = await provider.observe();
        state = prepareMainnetUpdate(binding, preparedFrom, image, { trustedProxyCidrs }); state.operationId = operationId;
        await durableJson(statePath, state, true);
      }
      const result = command === 'prepare' ? state : await advanceMainnetUpdate(state, { ...provider, save: value => durableJson(statePath, value) }, command === 'run');
      // A repeated prepare only reprints its journal, so print a count only when this run observed it.
      const failCount = command === 'prepare' ? preparedFrom?.failCount ?? null : result.observed?.failCount ?? null;
      console.log(JSON.stringify({ phase: result.phase, leaseUuid: result.leaseUuid, image: result.image, manifestHash: result.manifestHash, observed: result.observed ?? null,
        providerFailCount: failCount, providerStrikesRemaining: failCount === null ? null : Math.max(0, PROVIDER_STRIKE_LIMIT - failCount),
        newLeaseCreated: false, chainTransactionSent: false, cloudflareProxyAllowed: false, savedTo: statePath }, null, 2));
    } finally { client.dispose(); await wallet?.disconnect(); }
  } finally {
    try { if (JSON.parse(await readFile(lockPath, 'utf8')).id === lockId) await unlink(lockPath); } catch { /* Stale locks require local review. */ }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(JSON.stringify({ error: error instanceof MainnetUpdateError ? error.code : 'mainnet_update_failed_reconcile_existing_lease' })); process.exitCode = 1; });
}
