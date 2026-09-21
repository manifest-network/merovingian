import { z } from 'zod';
import { parseTrustedProxyCidrs } from '../src/config.js';

/** Public configuration only; importing this helper never opens operator state. */
export const trustedProxyCidrsSchema = z.string().max(2048).refine(value => {
  try { parseTrustedProxyCidrs(value); return true; } catch { return false; }
}, 'Expected explicit proxy IPs or bounded IPv4 /24+ or IPv6 /64+ CIDRs');

export function normalizeTrustedProxyCidrs(value: string): string {
  return parseTrustedProxyCidrs(trustedProxyCidrsSchema.parse(value)).join(',');
}

/** Omission preserves an existing reviewed setting; an explicit empty value clears it. */
export function withTrustedProxyCidrs(env: Record<string, string>, requested?: string): Record<string, string> {
  const next = { ...env };
  if (next.TRUST_PROXY_HOPS !== undefined && next.TRUST_PROXY_HOPS !== '0') {
    throw new Error('TRUST_PROXY_HOPS is no longer supported; configure explicit TRUSTED_PROXY_CIDRS');
  }
  if (requested === undefined) {
    if (next.TRUSTED_PROXY_CIDRS !== undefined) trustedProxyCidrsSchema.parse(next.TRUSTED_PROXY_CIDRS);
  } else {
    const value = normalizeTrustedProxyCidrs(requested);
    if (value) next.TRUSTED_PROXY_CIDRS = value;
    else delete next.TRUSTED_PROXY_CIDRS;
  }
  return next;
}
