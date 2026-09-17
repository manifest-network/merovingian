import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAINNET, mainnetPaths, publicInputs } from './mainnet-config.js';
import { createKeyringWalletProvider } from './keyring-wallet.js';

async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const allowed = ['--helper', '--home', '--keyring-backend', '--key-name'];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]!) || !args[i + 1] || values.has(args[i]!)) throw new Error('Invalid keyring-check arguments.');
    values.set(args[i]!, args[i + 1]!);
  }
  if (values.size !== allowed.length || values.get('--keyring-backend') !== 'os') {
    throw new Error('Supply --helper, --home, --keyring-backend os, and --key-name explicitly.');
  }
  const paths = mainnetPaths();
  const inputs = publicInputs(JSON.parse(await readFile(paths.config, 'utf8')), process.env);
  if (!inputs.tenant) throw new Error('Configure the public mainnet tenant first.');
  const helperPath = values.get('--helper')!;
  const wallet = await createKeyringWalletProvider({
    helperPath, home: values.get('--home')!, keyringBackend: 'os', keyName: values.get('--key-name')!,
    expectedAddress: inputs.tenant, chainId: MAINNET.chainId,
  });
  try {
    // Deliberately not either SDK provider-token challenge format. The proof is
    // verified by the adapter locally and never sent to any server or saved.
    const challenge = `Merovingian local keyring compatibility check\nNot a transaction or provider authorization\n${randomBytes(32).toString('hex')}`;
    await wallet.signArbitrary(inputs.tenant, challenge);
    const [account] = await (await wallet.getSigner()).getAccounts();
    const report = {
      checkedAt: new Date().toISOString(), status: 'passed', address: inputs.tenant,
      configuredTransactionChainId: MAINNET.chainId,
      verified: ['public key derives expected address', 'ADR-036 signature independently verified with Node/OpenSSL'],
      helperSha256: createHash('sha256').update(await readFile(helperPath)).digest('hex'),
      publicKeySha256: createHash('sha256').update(account!.pubkey).digest('hex'),
      realTransactionSigned: false, networkRequests: false, broadcast: false,
      challengeOrSignaturePersisted: false, providerTokenCreated: false,
      note: 'Local signing compatibility only; this does not prove live provider acceptance or authorize deployment.',
    };
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const output = resolve(paths.directory, 'keyring-check.json');
    const temporary = `${output}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
    console.log(JSON.stringify(report, null, 2));
  } finally { await wallet.disconnect(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Do not print filesystem, native backend, or signing payload diagnostics.
    console.error(JSON.stringify({ error: 'keyring_check_failed', message: 'Local keyring check failed. Verify the helper, public configuration, selected key, and locally unlocked OS store.' }));
    process.exitCode = 1;
  });
}
