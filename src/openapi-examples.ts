import type { Config } from './config.js';
import { getAmenities, visit } from './amenities.js';
import { APP_VERSION } from './identity.js';

/** Illustrative public data only. Addresses encode repeated bytes, with no keys. */
export function responseExamples(config: Config) {
  const environment = { network: config.network, chainId: config.chainId };
  const tenant = 'manifest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpn3rfe5';
  const sender = 'manifest1qgpqyqszqgpqyqszqgpqyqszqgpqyqszz49vjz';
  const transactionHash = 'A'.repeat(64);
  const checkedAt = '2026-09-21T00:00:00.000Z';
  const denom = 'upwr';
  const common = { ...environment, tenant, denom };
  const support = {
    ...common, status: 'available', optional: true, testTokensOnly: config.network === 'testnet',
    message: 'Optional PWR hosting support is available. All amenities remain free.',
    instructions: {
      typeUrl: '/liftedinit.billing.v1.MsgFundCredit',
      value: { sender: '<your authorized Manifest wallet address>', tenant,
        amount: { denom, amount: '<positive integer in base units>' } },
      notice: 'Only sign with explicit wallet authorization. Hosting-credit deposits cannot be withdrawn. Network gas is separate.',
    },
    hostingCredit: { available: [{ denom, amount: '2000000' }], reserved: [{ denom, amount: '500000' }], activeLeases: '1' },
    checkedAt,
  };
  const history = {
    ...common, status: 'available', checkedAt,
    entries: [{ transactionHash, height: '1542', timestamp: checkedAt, sender, amount: '1000000' }],
    totals: { amount: '1000000', tenantAmount: '0', otherAmount: '1000000' },
    indexedTransactions: 1, scannedTransactions: 1, complete: true,
    message: 'All indexed funding transactions were inspected. Totals include only successful PWR funding events for this tenant.',
  };
  const unavailableHistory = {
    ...common, status: 'unavailable', checkedAt: null, entries: [], totals: null,
    indexedTransactions: null, scannedTransactions: 0, complete: false,
    message: 'Contribution history could not be queried. Totals are unknown, not zero.',
  };
  return {
    menu: { menu: { name: 'merovingian', ...environment, amenities: getAmenities(),
      maxInputBytes: 8192, maxVisitOutputBytes: 8192, walletRequired: false } },
    // Pure authored fiction: generating documentation does not record a serving.
    visits: Object.fromEntries(getAmenities().map(amenity => [amenity.id,
      visit({ amenity: amenity.id, seed: 'openapi-example' }, environment)])),
    stats: {
      available: { ...environment, status: 'available', since: checkedAt,
        counts: { 'byte-chip-cookie': '2', 'rgb-sauna': '1', 'null-tea': '0' }, total: '3', storage: 'memory' },
      unavailable: { ...environment, status: 'unavailable', since: null, counts: null, total: null, storage: 'persistent' },
    },
    support: {
      available: support,
      availableWithoutCredit: { ...support, hostingCredit: null },
      unavailable: { ...support, status: 'unavailable', instructions: null, hostingCredit: null, checkedAt: null,
        message: 'Contribution queries are temporarily unavailable. All amenities remain free.' },
      unconfigured: { ...support, status: 'unconfigured', tenant: '', instructions: null, hostingCredit: null, checkedAt: null,
        message: 'The contribution jar is not configured. All amenities remain free.' },
    },
    history: {
      complete: history,
      partial: { ...history, indexedTransactions: 101, complete: false,
        message: 'Partial history: inspected 1 of 101 indexed funding transactions. Totals cover only the returned rows.' },
      empty: { ...history, entries: [], totals: { amount: '0', tenantAmount: '0', otherAmount: '0' },
        indexedTransactions: 0, scannedTransactions: 0 },
      unavailable: unavailableHistory,
      unconfigured: { ...unavailableHistory, status: 'unconfigured', tenant: '',
        message: 'Contribution history requires a configured refuge tenant and REST endpoint.' },
    },
    verification: {
      confirmed: { status: 'confirmed', receipt: {
        id: `merovingian:${config.network}:${config.chainId}:${transactionHash.toLowerCase()}`,
        ...environment, transactionHash, height: '1542', tenant, amount: { denom, amount: '1000000' },
        contributions: [{ sender, amount: '1000000' }], transferable: false, provesOwnership: false,
        message: 'Thank you for contributing hosting credit. This public receipt proves no ownership and grants no balance or entitlement.',
      } },
      pending: { status: 'pending', message: 'Transaction not found in the configured chain index. Check the original transaction; do not blindly pay again.' },
      failed: { status: 'failed', message: 'This transaction failed on chain. It did not make a contribution.' },
      not_a_contribution: { status: 'not_a_contribution', message: 'No matching PWR credit contribution to this refuge tenant was found.' },
      unavailable: { status: 'unavailable', message: 'The configured chain could not be queried. No contribution has been confirmed.' },
      unconfigured: { status: 'unconfigured', message: 'The contribution jar is not configured.' },
    },
    invalidVerification: {
      unexpectedFields: { status: 'invalid_request', error: 'Expected only transactionHash.' },
      invalidHash: { status: 'invalid_request', message: 'Provide exactly 64 hexadecimal transaction-hash characters and, optionally, a valid Manifest sender.' },
      malformedBody: { error: 'Malformed request body.' },
    },
    retired: { error: 'testnet_retired', network: 'testnet', chainId: 'manifest-ledger-testnet',
      mainnetOrigin: 'https://mainnet.example',
      message: 'This proof of concept has retired. Mainnet is a separate network; explicitly reconfigure your client and wallet before visiting or paying.' },
    health: {
      running: { status: 'ok', ...environment, retired: false, version: APP_VERSION },
      retired: { status: 'ok', network: 'testnet', chainId: 'manifest-ledger-testnet', retired: true, version: APP_VERSION },
    },
  };
}
