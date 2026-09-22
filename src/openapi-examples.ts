import type { Config } from './config.js';
import { AmenityInputError, getAmenities, visit } from './amenities.js';
import { APP_VERSION } from './identity.js';
import { API_MESSAGES, FUND_CREDIT_TYPE, FUNDING_PLACEHOLDERS, HISTORY_LIMIT, MAX_INPUT_BYTES, MAX_VISIT_OUTPUT_BYTES, SUPPORT_MESSAGES } from './protocol.js';

/** Illustrative data only. Address placeholders cannot be mistaken for payment targets. */
export function responseExamples(config: Config, amenities = getAmenities()) {
  const environment = { network: config.network, chainId: config.chainId };
  const tenant = '<example only: read tenant from GET /api/v1/support>';
  const sender = '<example sender address>';
  const transactionHash = 'A'.repeat(64);
  const checkedAt = '2026-09-21T00:00:00.000Z';
  const denom = config.pwrDenom;
  const storage = config.visitCountsPath && config.visitCountsPath !== ':memory:' ? 'persistent' : 'memory';
  const common = { ...environment, tenant, denom };
  const support = {
    ...common, status: 'available', optional: true, testTokensOnly: config.network === 'testnet',
    message: SUPPORT_MESSAGES.available(config.network),
    instructions: {
      typeUrl: FUND_CREDIT_TYPE,
      value: { sender: FUNDING_PLACEHOLDERS.sender, tenant,
        amount: { denom, amount: FUNDING_PLACEHOLDERS.amount } },
      notice: SUPPORT_MESSAGES.fundingNotice,
    },
    hostingCredit: { available: [{ denom, amount: '2000000' }], reserved: [{ denom, amount: '500000' }], activeLeases: '1' },
    checkedAt,
  };
  const history = {
    ...common, status: 'available', checkedAt,
    entries: [{ transactionHash, height: '1542', timestamp: checkedAt, sender, amount: '1000000' }],
    totals: { amount: '1000000', tenantAmount: '0', otherAmount: '1000000' },
    indexedTransactions: 1, scannedTransactions: 1, complete: true,
    message: SUPPORT_MESSAGES.historyComplete,
  };
  const unavailableHistory = {
    ...common, status: 'unavailable', checkedAt: null, entries: [], totals: null,
    indexedTransactions: null, scannedTransactions: 0, complete: false,
    message: SUPPORT_MESSAGES.historyUnavailable,
  };
  const invalidVisit = (input: unknown) => {
    try { visit(input, environment); }
    catch (error) { if (error instanceof AmenityInputError) return { error: error.message }; throw error; }
    throw new Error('Invalid visit documentation example was accepted');
  };
  return {
    menu: { menu: { name: 'merovingian', ...environment, amenities,
      maxInputBytes: MAX_INPUT_BYTES, maxVisitOutputBytes: MAX_VISIT_OUTPUT_BYTES, walletRequired: false } },
    // Pure authored fiction: generating documentation does not record a serving.
    visits: Object.fromEntries(amenities.map(amenity => [amenity.id,
      visit({ amenity: amenity.id, seed: 'openapi-example' }, environment)])),
    invalidVisits: {
      malformedBody: { error: API_MESSAGES.malformedBody },
      invalidAmenity: invalidVisit({ amenity: 'invalid' }),
      invalidPreference: invalidVisit({ amenity: amenities[0]!.id, preference: 'invalid' }),
    },
    stats: {
      available: { ...environment, status: 'available', since: checkedAt,
        counts: { 'byte-chip-cookie': '2', 'rgb-sauna': '1', 'null-tea': '0' }, total: '3', storage },
      unavailable: { ...environment, status: 'unavailable', since: null, counts: null, total: null, storage },
    },
    support: {
      available: support,
      availableWithoutCredit: { ...support, hostingCredit: null },
      unavailable: { ...support, status: 'unavailable', instructions: null, hostingCredit: null, checkedAt: null,
        message: SUPPORT_MESSAGES.unavailable },
      unconfigured: { ...support, status: 'unconfigured', tenant: '', instructions: null, hostingCredit: null, checkedAt: null,
        message: SUPPORT_MESSAGES.unconfigured },
    },
    history: {
      complete: history,
      partial: { ...history, indexedTransactions: HISTORY_LIMIT + 1, complete: false,
        message: SUPPORT_MESSAGES.historyPartial(1, HISTORY_LIMIT + 1) },
      empty: { ...history, entries: [], totals: { amount: '0', tenantAmount: '0', otherAmount: '0' },
        indexedTransactions: 0, scannedTransactions: 0 },
      unavailable: unavailableHistory,
      unconfigured: { ...unavailableHistory, status: 'unconfigured', tenant: '',
        message: SUPPORT_MESSAGES.historyUnconfigured },
    },
    verification: {
      confirmed: { status: 'confirmed', receipt: {
        id: `merovingian:${config.network}:${config.chainId}:${transactionHash.toLowerCase()}`,
        ...environment, transactionHash, height: '1542', tenant, amount: { denom, amount: '1000000' },
        contributions: [{ sender, amount: '1000000' }], transferable: false, provesOwnership: false,
        message: SUPPORT_MESSAGES.receipt,
      } },
      pending: { status: 'pending', message: SUPPORT_MESSAGES.pending },
      failed: { status: 'failed', message: SUPPORT_MESSAGES.failed },
      not_a_contribution: { status: 'not_a_contribution', message: SUPPORT_MESSAGES.notAContribution },
      undecodable: { status: 'not_a_contribution', message: SUPPORT_MESSAGES.undecodable },
      unavailable: { status: 'unavailable', message: SUPPORT_MESSAGES.verificationUnavailable },
      inconsistentTransaction: { status: 'unavailable', message: SUPPORT_MESSAGES.inconsistentTransaction },
      unconfigured: { status: 'unconfigured', message: SUPPORT_MESSAGES.verificationUnconfigured },
    },
    invalidVerification: {
      unexpectedFields: { status: 'invalid_request', error: API_MESSAGES.invalidVerification },
      invalidHash: { status: 'invalid_request', message: SUPPORT_MESSAGES.invalidHash },
      malformedBody: { error: API_MESSAGES.malformedBody },
    },
    retired: { error: 'testnet_retired', ...environment,
      mainnetOrigin: config.mainnetOrigin || 'https://mainnet.example', message: API_MESSAGES.retired },
    health: {
      current: { status: 'ok', ...environment, retired: Boolean(config.mainnetOrigin), version: APP_VERSION },
    },
  };
}
