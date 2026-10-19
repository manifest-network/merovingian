export type Network = 'testnet' | 'mainnet';

export const CHAIN_IDS = Object.freeze({
  testnet: 'manifest-ledger-testnet',
  mainnet: 'manifest-ledger-mainnet',
} as const satisfies Record<Network, string>);

// Both chains use this denomination. Verify chain identity independently.
export const PWR_DENOM = 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr';
