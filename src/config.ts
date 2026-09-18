import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';

export type Network = 'testnet' | 'mainnet';

export interface Config {
  network: Network;
  chainId: string;
  publicOrigin: string;
  port: number;
  rpcUrl: string;
  restUrl?: string;
  gasPrice: string;
  pwrDenom: string;
  tenant: string;
  trustedProxyCidrs: string[];
  mainnetOrigin?: string;
  visitCountsPath?: string;
}

const TEST_PWR = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
const CHAIN_IDS: Record<Network, string> = {
  testnet: 'manifest-ledger-testnet',
  mainnet: 'manifest-ledger-mainnet',
};

function origin(value: string, name: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`${name} requires HTTPS (HTTP is allowed only on localhost)`);
  }
  return url.origin;
}

function endpoint(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`${name} must be a public HTTPS endpoint without credentials or query`);
  }
  return url.toString().replace(/\/$/, '');
}

function trustedProxies(env: NodeJS.ProcessEnv): string[] {
  // The old zero value is safe and remains accepted for existing manifests.
  if (env.TRUST_PROXY_HOPS && env.TRUST_PROXY_HOPS !== '0') {
    throw new Error('TRUST_PROXY_HOPS is no longer supported; configure explicit TRUSTED_PROXY_CIDRS');
  }
  const value = env.TRUSTED_PROXY_CIDRS?.trim();
  if (!value) return [];
  const entries = value.split(',').map(entry => entry.trim());
  if (entries.length > 32 || entries.some(entry => {
    const [address = '', prefix, ...extra] = entry.split('/');
    const family = isIP(address);
    return !family || address.includes('%') || extra.length > 0
      || (prefix !== undefined && (!/^[1-9][0-9]*$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)));
  })) throw new Error('TRUSTED_PROXY_CIDRS requires at most 32 explicit IP addresses or nonzero CIDR ranges');
  return [...new Set(entries)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = env.NETWORK || 'testnet';
  if (network !== 'testnet' && network !== 'mainnet') throw new Error('NETWORK must be testnet or mainnet');
  const chainId = env.CHAIN_ID || CHAIN_IDS[network];
  if (chainId !== CHAIN_IDS[network]) {
    throw new Error('CHAIN_ID does not match NETWORK');
  }
  if (network === 'mainnet' && (!env.PUBLIC_ORIGIN || !env.MANIFEST_RPC_URL || !env.MANIFEST_REST_URL || !env.PWR_DENOM || !env.REFUGE_TENANT)) {
    throw new Error('Mainnet requires explicit PUBLIC_ORIGIN, MANIFEST_RPC_URL, MANIFEST_REST_URL, PWR_DENOM, and REFUGE_TENANT');
  }
  const publicOrigin = origin(env.PUBLIC_ORIGIN || 'http://localhost:8080', 'PUBLIC_ORIGIN');
  const rpcUrl = endpoint(env.MANIFEST_RPC_URL || 'https://nodes.liftedinit.tech/manifest/testnet/rpc', 'MANIFEST_RPC_URL');
  const restValue = env.MANIFEST_REST_URL || (network === 'testnet' ? 'https://nodes.liftedinit.tech/manifest/testnet/api' : undefined);
  const restUrl = restValue ? endpoint(restValue, 'MANIFEST_REST_URL') : undefined;
  const pwrDenom = env.PWR_DENOM || TEST_PWR;
  if (!/^[a-zA-Z][a-zA-Z0-9/:._-]{2,255}$/.test(pwrDenom)) throw new Error('Invalid PWR_DENOM');
  // Both chains currently use the same PWR denomination; the chain identity and
  // independently configured endpoints distinguish real funds from test tokens.
  if (network === 'mainnet' && (!publicOrigin.startsWith('https:') || /testnet/i.test(pwrDenom + rpcUrl + (restUrl || '')))) {
    throw new Error('Mainnet must use an HTTPS origin and mainnet chain endpoints and token denomination');
  }
  const port = Number(env.PORT || 8080);
  const trustedProxyCidrs = trustedProxies(env);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const tenant = env.REFUGE_TENANT || '';
  if (tenant && !/^manifest1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/.test(tenant)) throw new Error('Invalid REFUGE_TENANT');
  const gasPrice = env.MANIFEST_GAS_PRICE || '1.1umfx';
  if (!/^\d+(\.\d+)?[a-zA-Z][a-zA-Z0-9/:._-]*$/.test(gasPrice)) throw new Error('Invalid MANIFEST_GAS_PRICE');
  const mainnetOrigin = env.MAINNET_ORIGIN ? origin(env.MAINNET_ORIGIN, 'MAINNET_ORIGIN') : undefined;
  if (mainnetOrigin && (network !== 'testnet' || mainnetOrigin === publicOrigin || !mainnetOrigin.startsWith('https:'))) {
    throw new Error('MAINNET_ORIGIN must be a different HTTPS origin used only to retire testnet');
  }
  const visitCountsPath = env.VISIT_COUNTS_PATH || undefined;
  if (visitCountsPath && (!isAbsolute(visitCountsPath) || visitCountsPath.includes('\0'))) {
    throw new Error('VISIT_COUNTS_PATH must be an absolute filesystem path');
  }
  return { network, chainId, publicOrigin, port, rpcUrl, restUrl, gasPrice, pwrDenom, tenant, trustedProxyCidrs, mainnetOrigin, visitCountsPath };
}
