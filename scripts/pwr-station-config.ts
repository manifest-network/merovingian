/** Public purchase profiles only. Wallets, budgets and recovery records belong
 * to the agent host. This module is excluded from the application image.
 * Station origins, chains and payment terms: https://pwr-station.com/docs/x402
 * USDC contracts: https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
const PWR_DENOM = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';

// Both Manifest chains use this denomination; it never selects a network.
// Keep each profile flat and frozen so imports cannot rewrite payment settings.
export const PWR_STATION_PROFILES = Object.freeze({
  testnet: Object.freeze({
    baseUrl: 'https://testnet.pwr-station.com',
    environment: 'sandbox',
    chainId: 'manifest-ledger-testnet',
    pwrDenom: PWR_DENOM,
    paymentNetwork: 'eip155:84532',
    usdcContract: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
  } as const),
  mainnet: Object.freeze({
    baseUrl: 'https://pwr-station.com',
    environment: 'production',
    chainId: 'manifest-ledger-mainnet',
    pwrDenom: PWR_DENOM,
    paymentNetwork: 'eip155:8453',
    usdcContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
  } as const),
});

export type PwrStationNetwork = keyof typeof PWR_STATION_PROFILES;
export type PwrStationProfile = typeof PWR_STATION_PROFILES[PwrStationNetwork];
