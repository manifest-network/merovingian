import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { createSignerAdapter, parseAddress, parseLeaseUuid, type WalletProvider } from '@manifest-network/manifest-sdk';
import { createGuardedFetch, isBlocked } from '@manifest-network/manifest-sdk/node';
import { createProviderAuth, fetchJsonChecked, getLeaseConnectionInfo, getProviderHealth, metaHashHex, uploadLeaseData } from '@manifest-network/manifest-sdk/deploy';
import { MAINNET } from './mainnet-config.js';

export const MAINNET_PROVIDER = Object.freeze({
  uuid: '019e6a0d-e141-7000-9e79-e94ac1bd333e',
  url: 'https://barney.manifest.network/api/fred',
});
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_POLL_MS = 55_000;
const HASH = /^[a-f0-9]{64}$/;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const route = new RegExp(`^/api/fred/v1/leases/${UUID}/(status|connection|data)$`);

export class MainnetProviderError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MainnetProviderError'; }
}

/** Exact origin/path/method allowlist plus the SDK's connect-time DNS/IP guard.
 * A supplied transport is solely a seam for isolated tests, never CLI input. */
export function mainnetProviderFetch(transport: typeof fetch = createGuardedFetch()): typeof fetch {
  return async (input, init = {}) => {
    try {
      if (typeof input !== 'string' && !(input instanceof URL)) throw new Error();
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      const match = route.exec(url.pathname);
      if (url.origin !== new URL(MAINNET_PROVIDER.url).origin || url.username || url.password || url.search || url.hash
        || (url.pathname !== '/api/fred/health' && !match)
        || method !== (match?.[1] === 'data' ? 'POST' : 'GET')) throw new Error();
      const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])]);
      const response = await transport(url.href, { ...init, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      // Defense in depth for injected transports or an unexpected redirect policy.
      if (response.redirected || (response.status >= 300 && response.status < 400)
        || (response.url && response.url !== url.href)) {
        await response.body?.cancel().catch(() => {});
        throw new Error();
      }
      return response;
    } catch { throw new MainnetProviderError('provider_transport_refused_or_unavailable'); }
  };
}

const portsSchema = z.record(z.string(), z.object({ host_port: z.number().int().min(1).max(65535) })).optional();
const endpointSchema = z.object({ fqdn: z.string().optional(), ports: portsSchema });
const statusSchema = z.object({
  state: z.enum(['LEASE_STATE_PENDING', 'LEASE_STATE_ACTIVE', 'LEASE_STATE_CLOSED', 'LEASE_STATE_EXPIRED', 'LEASE_STATE_REJECTED']),
  provision_status: z.string().optional(),
  lease_uuid: z.string().optional(), tenant: z.string().optional(), provider_uuid: z.string().optional(),
  meta_hash_hex: z.string().regex(HASH).optional(),
  payload_received: z.boolean().optional(), requires_payload: z.boolean().optional(), provisioning_started: z.boolean().optional(),
  instances: z.array(endpointSchema).max(20).optional(),
  services: z.object({ refuge: z.object({ instances: z.array(endpointSchema).max(20) }).optional() }).optional(),
});

export interface PublicProviderEndpoint {
  fqdn: string | null;
  ports: { containerPort: number; protocol: 'tcp' | 'udp'; hostPort: number }[];
}
export interface PublicProviderStatus {
  leaseUuid: string; tenant: string; providerUuid: string;
  state: 'pending' | 'active' | 'closed' | 'expired' | 'rejected';
  provisionStatus: string | null; ready: boolean;
  metaHash: string | null; payloadReceived: boolean | null;
  requiresPayload: boolean | null; provisioningStarted: boolean | null;
  endpoints: PublicProviderEndpoint[];
  dnsTargets: { type: 'CNAME' | 'A' | 'AAAA'; value: string }[];
}

function fqdn(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()
    || !['.manifest.network', '.barney0.manifest0.net'].some(suffix => value.endsWith(suffix))
    || !value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return value;
}

function endpoint(value: { fqdn?: string; ports?: Record<string, { host_port: number }> }): PublicProviderEndpoint {
  const ports: PublicProviderEndpoint['ports'] = [];
  for (const [key, mapping] of Object.entries(value.ports ?? {}).slice(0, 32)) {
    const match = /^([1-9][0-9]{0,4})\/(tcp|udp)$/.exec(key);
    if (match && Number(match[1]) <= 65535 && Number.isInteger(mapping.host_port) && mapping.host_port > 0 && mapping.host_port <= 65535) {
      ports.push({ containerPort: Number(match[1]), protocol: match[2] as 'tcp' | 'udp', hostPort: mapping.host_port });
    }
  }
  return { fqdn: fqdn(value.fqdn), ports };
}

function dnsTarget(value: unknown): PublicProviderStatus['dnsTargets'][number] | null {
  if (typeof value !== 'string' || value === MAINNET.domain) return null;
  const family = isIP(value);
  if (family) return isBlocked(value) ? null : { type: family === 4 ? 'A' : 'AAAA', value };
  const name = fqdn(value);
  return name ? { type: 'CNAME', value: name } : null;
}

function checkedLease(value: string): string {
  try { return parseLeaseUuid(value); }
  catch { throw new MainnetProviderError('invalid_provider_lease_uuid'); }
}

export interface MainnetProviderOptions {
  wallet: WalletProvider;
  tenant: string;
  providerUuid: string;
  providerUrl: string;
  /** Test transport only. Production omits this and gets the SDK DNS/IP guard. */
  fetch?: typeof fetch;
}

/** Off-chain provider operations only. Caller verifies the on-chain lease owner,
 * provider, state and exact metaHash immediately before an upload. No transaction
 * signing, automatic lease creation, update, restore, close or token persistence. */
export function createMainnetProvider(options: MainnetProviderOptions) {
  if (options.providerUuid !== MAINNET_PROVIDER.uuid || options.providerUrl !== MAINNET_PROVIDER.url) {
    throw new MainnetProviderError('unexpected_mainnet_provider');
  }
  let tenant: string;
  try { tenant = parseAddress(options.tenant); }
  catch { throw new MainnetProviderError('invalid_provider_tenant'); }
  const transport = mainnetProviderFetch(options.fetch);
  const auth = createProviderAuth(createSignerAdapter(options.wallet), { chainId: MAINNET.chainId });
  // Public identifiers only. The orchestrator also journals attempts before
  // calling this module so the same rule survives process restarts.
  const attemptedUploads = new Set<string>();

  async function verified(signal?: AbortSignal) {
    const fetcher: typeof fetch = (input, init) => transport(input, { ...init, ...(signal ? { signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) } : {}) });
    try {
      if (await options.wallet.getAddress() !== tenant) throw new MainnetProviderError('provider_wallet_mismatch');
      const health = await getProviderHealth(MAINNET_PROVIDER.url, 10_000, fetcher);
      if (health.provider_uuid !== MAINNET_PROVIDER.uuid || health.status !== 'healthy') throw new MainnetProviderError('provider_identity_or_health_failed');
      return fetcher;
    } catch (error) {
      if (error instanceof MainnetProviderError) throw error;
      throw new MainnetProviderError('provider_identity_or_health_failed');
    }
  }

  async function readStatus(leaseUuid: string, signal?: AbortSignal): Promise<PublicProviderStatus> {
    checkedLease(leaseUuid);
    try {
      const fetcher = await verified(signal);
      const token = await auth.providerToken({ address: tenant, leaseUuid });
      // Use the published schema-aware transport directly: getLeaseStatus logs
      // arbitrary unknown provider state strings before returning its response.
      const raw = await fetchJsonChecked(`${MAINNET_PROVIDER.url}/v1/leases/${leaseUuid}/status`, { headers: { Authorization: `Bearer ${token}` } }, { schema: statusSchema, fetchFn: fetcher, maxBytes: 64 * 1024 });
      if ((raw.lease_uuid !== undefined && raw.lease_uuid !== leaseUuid) || (raw.tenant !== undefined && raw.tenant !== tenant)
        || (raw.provider_uuid !== undefined && raw.provider_uuid !== MAINNET_PROVIDER.uuid)) throw new MainnetProviderError('provider_response_identity_mismatch');
      const state = raw.state.slice('LEASE_STATE_'.length).toLowerCase() as PublicProviderStatus['state'];
      const provisionStatus = raw.provision_status === undefined ? null
        : ['ready', 'provisioning', 'restarting', 'updating', 'failing', 'unknown', 'failed', 'deprovisioning', 'retained', 'pending'].includes(raw.provision_status) ? raw.provision_status : 'unknown';
      const result: PublicProviderStatus = {
        leaseUuid, tenant, providerUuid: MAINNET_PROVIDER.uuid, state, provisionStatus,
        ready: state === 'active' && provisionStatus === 'ready',
        metaHash: raw.meta_hash_hex ?? null, payloadReceived: raw.payload_received ?? null,
        requiresPayload: raw.requires_payload ?? null, provisioningStarted: raw.provisioning_started ?? null,
        endpoints: [...(raw.services?.refuge?.instances ?? []), ...(raw.instances ?? [])].map(endpoint), dnsTargets: [],
      };
      if (result.ready) {
        const connectionToken = await auth.providerToken({ address: tenant, leaseUuid });
        const connection = await getLeaseConnectionInfo(MAINNET_PROVIDER.url, leaseUuid, connectionToken, fetcher);
        if (connection.lease_uuid !== leaseUuid || connection.tenant !== tenant || connection.provider_uuid !== MAINNET_PROVIDER.uuid) throw new MainnetProviderError('provider_connection_identity_mismatch');
        const service = connection.connection.services?.refuge;
        result.endpoints.push(endpoint(connection.connection), ...(connection.connection.instances ?? []).map(endpoint));
        if (service) result.endpoints.push(endpoint(service), ...(service.instances ?? []).map(endpoint));
        // Fred retains the native instance FQDN alongside its custom-domain
        // router. Prefer that documented routing target, then explicit hosts.
        // A custom FQDN is never used as its own CNAME target.
        result.dnsTargets = [...(service?.instances ?? []).map(instance => instance.fqdn),
          service?.fqdn, ...(connection.connection.instances ?? []).map(instance => instance.fqdn),
          connection.connection.fqdn, service?.host, connection.connection.host].map(dnsTarget).filter((target): target is NonNullable<typeof target> => target !== null);
      }
      result.endpoints = result.endpoints.filter((entry, index, list) => (entry.fqdn !== null || entry.ports.length > 0) && list.findIndex(other => JSON.stringify(other) === JSON.stringify(entry)) === index);
      result.dnsTargets = result.dnsTargets.filter((entry, index, list) => list.findIndex(other => other.value === entry.value && other.type === entry.type) === index);
      return result;
    } catch (error) {
      if (error instanceof MainnetProviderError) throw error;
      throw new MainnetProviderError('provider_status_unconfirmed');
    }
  }

  return {
    status: ({ leaseUuid }: { leaseUuid: string }) => readStatus(leaseUuid),
    async upload({ leaseUuid, manifest, metaHash }: { leaseUuid: string; manifest: string; metaHash: string }) {
      checkedLease(leaseUuid);
      if (!HASH.test(metaHash) || Buffer.byteLength(manifest, 'utf8') > MAX_MANIFEST_BYTES || !manifest
        || await metaHashHex(manifest) !== metaHash) throw new MainnetProviderError('provider_manifest_hash_mismatch');
      const status = await readStatus(leaseUuid);
      if (status.metaHash !== metaHash) throw new MainnetProviderError('provider_lease_manifest_hash_unconfirmed');
      if (status.state !== 'pending' && status.state !== 'active') throw new MainnetProviderError('provider_upload_requires_live_lease');
      if (status.payloadReceived === true) return { leaseUuid, metaHash, accepted: true, alreadyPresent: true };
      if (status.state !== 'pending' || status.requiresPayload !== true || status.payloadReceived !== false || status.provisioningStarted === true) {
        throw new MainnetProviderError('provider_upload_requires_reconciliation');
      }
      const fetcher = await verified();
      let token: string;
      try { token = await auth.leaseDataToken({ address: tenant, leaseUuid, metaHashHex: metaHash }); }
      catch { throw new MainnetProviderError('provider_upload_authentication_failed'); }
      // Recheck after the asynchronous token mint to serialize concurrent
      // callers and prohibit a second POST following an ambiguous first one.
      if (attemptedUploads.has(leaseUuid)) throw new MainnetProviderError('provider_upload_requires_reconciliation');
      attemptedUploads.add(leaseUuid);
      try {
        await uploadLeaseData(MAINNET_PROVIDER.url, leaseUuid, new TextEncoder().encode(manifest), token, fetcher);
        return { leaseUuid, metaHash, accepted: true, alreadyPresent: false };
      } catch { throw new MainnetProviderError('provider_upload_indeterminate'); }
    },
    async waitUntilReady({ leaseUuid, timeoutMs = MAX_POLL_MS }: { leaseUuid: string; timeoutMs?: number }) {
      checkedLease(leaseUuid);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_POLL_MS) throw new MainnetProviderError('invalid_provider_poll_timeout');
      const deadline = AbortSignal.timeout(timeoutMs);
      let status: PublicProviderStatus | null = null;
      let lastError: string | null = null;
      while (!deadline.aborted) {
        try {
          // A wallet may wait for local unlock; bound this read even though its
          // ADR-036 signer interface has no AbortSignal. A late result cannot
          // send HTTP because the transport receives the same aborted signal.
          status = await new Promise<PublicProviderStatus>((resolve, reject) => {
            const abort = () => reject(new MainnetProviderError('provider_poll_deadline'));
            deadline.addEventListener('abort', abort, { once: true });
            if (deadline.aborted) abort();
            readStatus(leaseUuid, deadline).then(resolve, reject).finally(() => deadline.removeEventListener('abort', abort));
          });
          lastError = null;
          if (status.ready || ['closed', 'expired', 'rejected'].includes(status.state) || status.provisionStatus === 'failed') return { ready: status.ready, timedOut: false, status, lastError };
        } catch (error) { lastError = error instanceof MainnetProviderError ? error.code : 'provider_status_unconfirmed'; }
        await sleep(2500, undefined, { signal: deadline }).catch(() => {});
      }
      return { ready: false, timedOut: true, status, lastError };
    },
  };
}
