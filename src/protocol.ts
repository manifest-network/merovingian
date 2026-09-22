/** Public protocol constants shared by handlers and their documentation. */
export const MAX_INPUT_BYTES = 8192;
export const MAX_VISIT_OUTPUT_BYTES = 8192;
export const MAX_FORM_PARAMETERS = 5;
export const HISTORY_LIMIT = 100;
export const FUND_CREDIT_TYPE = '/liftedinit.billing.v1.MsgFundCredit';
export const OPENAPI_MEDIA_TYPE = 'application/vnd.oai.openapi+json';

export const FUNDING_PLACEHOLDERS = Object.freeze({
  sender: '<your authorized Manifest wallet address>', amount: '<positive integer in base units>',
});

export const API_MESSAGES = Object.freeze({
  busy: 'The refuge is busy. Please try again later.',
  rateLimited: 'Visit limit reached. Please try again later.',
  originNotAllowed: 'origin_not_allowed',
  jsonRequired: 'Use Content-Type: application/json.',
  invalidVerification: 'Expected only transactionHash.',
  inputLimit: 'Request exceeds the refuge input limit.',
  malformedBody: 'Malformed request body.',
  unsupportedEncoding: 'Unsupported request content encoding or charset.',
  internalError: 'The refuge could not complete this request.',
  counterUnavailable: 'The serving counter is temporarily unavailable. Please try again later.',
  retired: 'This proof of concept has retired. Mainnet is a separate network; explicitly reconfigure your client and wallet before visiting or paying.',
});

export const SUPPORT_MESSAGES = Object.freeze({
  unconfigured: 'The contribution jar is not configured. All amenities remain free.',
  available: (network: 'testnet' | 'mainnet') => network === 'testnet'
    ? 'Keep the sauna warm with optional faucet-funded testnet PWR. These are test tokens only.'
    : 'Keep the sauna warm with an optional PWR contribution. All amenities remain free.',
  unavailable: 'Contribution queries are temporarily unavailable. All amenities remain free.',
  fundingNotice: 'Only sign with explicit wallet authorization. Hosting-credit deposits cannot be withdrawn. '
    + 'You also pay network gas. After confirmation, submit the transaction hash to /api/v1/support/verify. '
    + 'The thank-you receipt is public, non-transferable, and proves no ownership or entitlement.',
  historyUnconfigured: 'Contribution history requires a configured refuge tenant and REST endpoint.',
  historyComplete: 'All indexed funding transactions were inspected. Totals include only successful PWR funding events for this tenant.',
  historyPartial: (scanned: number, indexed: number) => `Partial history: inspected ${scanned} of ${indexed} indexed funding transactions (latest ${HISTORY_LIMIT} maximum). Totals cover only the returned rows.`,
  historyUnavailable: 'Contribution history could not be verified or queried. Totals are unavailable; this does not mean no contributions were made.',
  invalidHash: 'Provide exactly 64 hexadecimal transaction-hash characters and, optionally, a valid Manifest sender.',
  verificationUnconfigured: 'The contribution jar is not configured.',
  verificationUnavailable: 'The configured chain could not be verified or queried. No contribution has been confirmed.',
  pending: 'This transaction has not been found in the configured chain index. It may be pending, unknown, or on another network; no contribution is confirmed.',
  inconsistentTransaction: 'The chain returned incomplete or inconsistent confirmation data.',
  failed: 'This transaction failed on chain. It did not make a contribution.',
  undecodable: 'A valid signed PWR hosting-credit contribution could not be decoded from this transaction.',
  notAContribution: 'This transaction contains no matching PWR credit contribution to this refuge tenant from the requested sender.',
  receipt: 'The sauna glows a little warmer. Thank you for contributing hosting credit. This public receipt is a souvenir; it proves no wallet ownership and grants no balance or entitlement.',
});
