import { CHAIN_IDS, PWR_DENOM, type Network } from '../src/networks.js';

/** Public purchase profiles only. Wallets, budgets and recovery records belong
 * to the agent host. This module is excluded from the application image.
 * Station origins and chains: https://pwr-station.com/docs/overview
 * Payment terms: https://pwr-station.com/docs/x402
 * USDC contracts: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * The expected Manifest PWR denomination comes from shared repository config;
 * production PWR-Station's denomination response remains unverified.
 */
// Both Manifest chains use this denomination; it never selects a network.
// Keep each profile flat and frozen so imports cannot rewrite payment settings.
export const PWR_STATION_PROFILES = Object.freeze({
  testnet: Object.freeze({
    baseUrl: 'https://testnet.pwr-station.com',
    environment: 'sandbox',
    chainId: CHAIN_IDS.testnet,
    pwrDenom: PWR_DENOM,
    paymentNetwork: 'eip155:84532',
    usdcContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
  } as const),
  mainnet: Object.freeze({
    baseUrl: 'https://pwr-station.com',
    environment: 'production',
    chainId: CHAIN_IDS.mainnet,
    // Expected receiving asset; confirm the station echoes this in mainnet preflight.
    pwrDenom: PWR_DENOM,
    paymentNetwork: 'eip155:8453',
    usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
  } as const),
} satisfies Record<Network, object>);

export type PwrStationNetwork = Network;
export type PwrStationProfile = typeof PWR_STATION_PROFILES[PwrStationNetwork];
