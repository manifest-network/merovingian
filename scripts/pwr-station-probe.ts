import { pathToFileURL } from 'node:url';
import { Secp256k1HdWallet } from 'cosmjs-amino-modern';
import { loadConfig } from '../src/config.js';
import { SupportService } from '../src/support.js';
import { PwrStationClient, StationError, type StationSigner } from './pwr-station-client.js';

/** Creates a temporary QA login and unpaid quotes; never creates orders or pays. */
export async function probeStation(tenant: string) {
  const config = loadConfig({ NETWORK: 'testnet', REFUGE_TENANT: tenant });
  const support = new SupportService(config);
  try {
    const info = await support.getInfo();
    if (info.status !== 'available' || !info.hostingCredit) throw new StationError('TESTNET_CREDIT_ACCOUNT_REQUIRED');
    const wallet = await Secp256k1HdWallet.generate(24, { prefix: 'manifest' });
    const [account] = await wallet.getAccounts();
    const signer: StationSigner = {
      getAddress: async () => account.address,
      signArbitrary: async (address, message) => {
        const { signature } = await wallet.signAmino(address, { chain_id: '', account_number: '0', sequence: '0',
          fee: { amount: [], gas: '0' }, memo: '', msgs: [{ type: 'sign/MsgSignData',
            value: { signer: address, data: Buffer.from(message).toString('base64') } }] });
        return signature;
      },
    };
    const target = { chainId: 'manifest-ledger-testnet' as const, denom: info.denom, recipient: info.hostingCredit.creditAddress };
    const client = new PwrStationClient(target, 100);
    await client.login(signer);
    const packages = await client.packages();
    const selected = packages.filter(p => p.price_cents + p.fees_cents <= 100)
      .sort((a, b) => a.price_cents + a.fees_cents - b.price_cents - b.fees_cents)[0];
    if (!selected) throw new StationError('NO_QA_PACKAGE_WITHIN_LIMIT');
    const results: object[] = [];
    async function quote(client: PwrStationClient, recipientKind: string, path: 'x402' | 'checkout') {
      try {
        const q = await client.quote(selected!.id, path);
        results.push({ recipientKind, paymentPath: path, status: 'quote_validated', environment: q.environment,
          chainId: q.chain_id, totalCents: q.total_cents, pwrBaseUnits: q.net_pwr_base_units });
      } catch (error) {
        results.push({ recipientKind, paymentPath: path, status: 'blocked',
          code: error instanceof StationError ? error.code : 'PROBE_FAILED', httpStatus: error instanceof StationError ? error.status : 0 });
      }
    }
    await quote(client, 'existing_credit_account', 'x402');
    await quote(client, 'existing_credit_account', 'checkout');
    // Control changes only the recipient type: it distinguishes a credit-address
    // validation failure from a generally unavailable package/checkout service.
    const control = new PwrStationClient({ ...target, recipient: account.address }, 100);
    await control.login(signer);
    await quote(control, 'ordinary_wallet_control', 'checkout');
    return { checkedAt: new Date().toISOString(), network: 'manifest-ledger-testnet',
      creditAddress: target.recipient, packages, results, ordersCreated: 0, paymentsSubmitted: 0, servings: 0 };
  } finally { support.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tenant, ...extra] = process.argv.slice(2);
  if (!tenant || extra.length) {
    console.error('Usage: npm run pwr-station:probe -- TESTNET_TENANT');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await probeStation(tenant), null, 2)); }
    catch (error) { console.error(JSON.stringify({ error: error instanceof StationError ? error.code : 'PROBE_FAILED' })); process.exitCode = 1; }
  }
}
