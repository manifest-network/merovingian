import { createHash } from 'node:crypto';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { parseAddress } from '@manifest-network/manifest-sdk';
import { HISTORY_LIMIT } from './protocol.js';

/**
 * Manifest v2.3.1 x/billing/types/credit.go: address.Module("billing",
 * sha256("billing/credit/" || tenantBytes)). Cosmos SDK address.Hash prepends
 * sha256("module"); Module separates the module name and key with a zero byte.
 * This derives a destination, not proof that the billing account exists.
 */
export function deriveCreditAddress(tenant: string): string {
  parseAddress(tenant, 'manifest');
  const key = createHash('sha256').update('billing/credit/').update(fromBech32(tenant).data).digest();
  const moduleType = createHash('sha256').update('module').digest();
  const address = createHash('sha256').update(moduleType).update('billing\0').update(key).digest();
  return toBech32('manifest', address);
}

export function fundingHistoryUrl(restUrl: string, creditAddress: string): string {
  parseAddress(creditAddress, 'manifest');
  const query = new URLSearchParams({ query: `transfer.recipient='${creditAddress.toLowerCase()}'`,
    order_by: 'ORDER_BY_DESC', limit: String(HISTORY_LIMIT), page: '1' });
  return `${restUrl.replace(/\/$/, '')}/cosmos/tx/v1beta1/txs?${query}`;
}
