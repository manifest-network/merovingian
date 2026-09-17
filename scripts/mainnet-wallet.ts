import type { SignArbitraryResult, WalletProvider } from '@manifest-network/manifest-sdk';
import { Secp256k1HdWallet, type StdSignDoc } from 'cosmjs-amino-modern';
import { DirectSecp256k1HdWallet, type OfflineDirectSigner } from 'cosmjs-proto-signing-modern';

export interface MainnetWalletProvider extends WalletProvider {
  getSigner(): Promise<OfflineDirectSigner>;
  signArbitrary(address: string, data: string): Promise<SignArbitraryResult>;
  disconnect(): Promise<void>;
}

/**
 * Optional adapter for an operator who already has explicit authority over a mnemonic.
 * A public wallet address alone grants no signing ability. This module does not read,
 * create, persist, or broadcast wallets/transactions and is not used by mainnet preflight.
 * Both signing modes use published CosmJS 0.34's noble-backed wallet implementations.
 */
export async function createMainnetWalletProvider(mnemonic: string): Promise<MainnetWalletProvider> {
  let direct: DirectSecp256k1HdWallet | undefined;
  let amino: Secp256k1HdWallet | undefined;
  try {
    // The published default is m/44'/118'/0'/0/0 for both wallets.
    [direct, amino] = await Promise.all([
      DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'manifest' }),
      Secp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'manifest' }),
    ]);
  } catch {
    // Do not propagate third-party errors that could contain mnemonic input.
    throw new Error('Unable to initialize the authorized wallet mnemonic.');
  } finally {
    mnemonic = '';
  }
  const [directAccount] = await direct.getAccounts();
  const [aminoAccount] = await amino.getAccounts();
  if (!directAccount || !aminoAccount || directAccount.address !== aminoAccount.address
    || !Buffer.from(directAccount.pubkey).equals(Buffer.from(aminoAccount.pubkey))) {
    direct = undefined;
    amino = undefined;
    throw new Error('Direct and ADR-036 wallets derived different accounts.');
  }
  const address = directAccount.address;
  const connectedDirect = () => {
    if (!direct) throw new Error('Wallet has been disconnected.');
    return direct;
  };
  const assertAddress = (requested: string) => {
    if (requested !== address) throw new Error('Cannot sign for another wallet address.');
  };
  // Expose only the signer interface, not the wallet's mnemonic getter.
  const signer: OfflineDirectSigner = {
    getAccounts: () => connectedDirect().getAccounts(),
    signDirect: async (requested, document) => {
      assertAddress(requested);
      return connectedDirect().signDirect(requested, document);
    },
  };
  return {
    async getAddress() { connectedDirect(); return address; },
    async getSigner() { connectedDirect(); return signer; },
    async signArbitrary(requested, data) {
      assertAddress(requested);
      if (!amino) throw new Error('Wallet has been disconnected.');
      if (typeof data !== 'string') throw new TypeError('ADR-036 data must be a string.');
      // Match the SDK/provider ADR-036 envelope; all encoding/signing is delegated
      // to the published Amino wallet. Chain/account/sequence/fee fields are fixed.
      const document: StdSignDoc = {
        chain_id: '', account_number: '0', sequence: '0', fee: { gas: '0', amount: [] },
        msgs: [{ type: 'sign/MsgSignData', value: { signer: requested, data: Buffer.from(data, 'utf8').toString('base64') } }],
        memo: '',
      };
      const { signature } = await amino.signAmino(requested, document);
      return { pub_key: signature.pub_key, signature: signature.signature };
    },
    async disconnect() {
      // Drop references; JavaScript does not guarantee zeroization of immutable secrets.
      direct = undefined;
      amino = undefined;
    },
  };
}
