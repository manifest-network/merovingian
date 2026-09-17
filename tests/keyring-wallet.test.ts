import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSignerAdapter, parseLeaseUuid } from '@manifest-network/manifest-sdk';
import { createAuthTokens } from '@manifest-network/manifest-sdk/deploy';
import { makeSignDoc } from 'cosmjs-proto-signing-modern';
import { SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { createMainnetWalletProvider } from '../scripts/mainnet-wallet.js';
import { createKeyringWalletProvider, runKeyringHelper, type KeyringRunner, type KeyringWalletOptions } from '../scripts/keyring-wallet.js';

// Public fixture only. No production keyring is accessed by these tests.
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const address = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const options: KeyringWalletOptions = {
  helperPath: '/fixture/keyring-signer', home: '/fixture/keyring', keyringBackend: 'test',
  keyName: 'fixture', expectedAddress: address, chainId: 'manifest-ledger-testnet',
};

async function fixture() {
  const wallet = await createMainnetWalletProvider(mnemonic);
  const signer = await wallet.getSigner();
  const [account] = await signer.getAccounts();
  let signingCalls = 0;
  const runner: KeyringRunner = async (_options, request) => {
    const identity = { address, publicKey: Buffer.from(account!.pubkey).toString('base64') };
    if (request.operation === 'public-key') return identity;
    signingCalls++;
    const result = request.operation === 'sign-direct'
      ? (await signer.signDirect(address, SignDoc.decode(Buffer.from(request.signBytes, 'base64')))).signature
      : await wallet.signArbitrary(address, request.data);
    return { ...identity, signature: result.signature };
  };
  return { runner, wallet, signingCalls: () => signingCalls };
}

test('keyring wallet supplies SDK transaction and provider signing with independently verified results', async () => {
  const fixtureWallet = await fixture();
  const wallet = await createKeyringWalletProvider(options, fixtureWallet.runner);
  try {
    assert.equal(await wallet.getAddress(), address);
    const signer = await wallet.getSigner();
    const doc = makeSignDoc(Uint8Array.of(10, 0), Uint8Array.of(18, 0), options.chainId, 7);
    const signedPromise = signer.signDirect(address, doc);
    doc.bodyBytes[0] = 255;
    const result = await signedPromise;
    assert.deepEqual([...result.signed.bodyBytes], [10, 0]);
    assert.equal(result.signature.pub_key.type, 'tendermint/PubKeySecp256k1');
    const tokens = createAuthTokens(createSignerAdapter(wallet), { chainId: options.chainId });
    const lease = parseLeaseUuid('11111111-1111-4111-8111-111111111111');
    for (const token of [await tokens.getAuthToken(lease), await tokens.getLeaseDataAuthToken(lease, 'a'.repeat(64))]) {
      const body = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      assert.equal(body.tenant, address);
      assert.equal(body.lease_uuid, lease);
      assert.equal(Buffer.from(body.signature, 'base64').length, 64);
    }
    assert.equal(fixtureWallet.signingCalls(), 3);
  } finally { await wallet.disconnect(); await fixtureWallet.wallet.disconnect(); }
});

test('wrong account, wrong chain, incomplete document, and disconnected signers fail before signing', async () => {
  const fixtureWallet = await fixture();
  const wallet = await createKeyringWalletProvider(options, fixtureWallet.runner);
  const signer = await wallet.getSigner();
  try {
    const doc = makeSignDoc(Uint8Array.of(10, 0), Uint8Array.of(18, 0), options.chainId, 0);
    await assert.rejects(signer.signDirect(address, { ...doc, chainId: 'manifest-ledger-mainnet' }), /another chain/);
    await assert.rejects(signer.signDirect(address, { ...doc, bodyBytes: new Uint8Array() }), /incomplete/);
    await assert.rejects(wallet.signArbitrary('another-address', 'fixture'), /another wallet/);
    await wallet.disconnect();
    await assert.rejects(wallet.signArbitrary(address, 'fixture'), /disconnected/);
    await assert.rejects(signer.signDirect(address, doc), /disconnected/);
    await assert.rejects(signer.getAccounts(), /disconnected/);
    assert.equal(fixtureWallet.signingCalls(), 0);
  } finally { await fixtureWallet.wallet.disconnect(); }
});

test('helper identity and altered signatures are rejected rather than trusted', async () => {
  const fixtureWallet = await fixture();
  try {
    await assert.rejects(createKeyringWalletProvider(options, async (...args) => ({
      ...(await fixtureWallet.runner(...args) as object), address: 'unexpected',
    })), /unexpected account/);
    await assert.rejects(createKeyringWalletProvider(options, async (...args) => ({
      ...(await fixtureWallet.runner(...args) as object), privateKey: 'must-not-be-returned',
    })), /unexpected account or response/);
    const wallet = await createKeyringWalletProvider(options, async (...args) => {
      const value = await fixtureWallet.runner(...args);
      return args[1].operation === 'public-key' ? value : { ...(value as object), signature: Buffer.alloc(64).toString('base64') };
    });
    try { await assert.rejects(wallet.signArbitrary(address, 'fixture'), /signature verification failed/); }
    finally { await wallet.disconnect(); }
  } finally { await fixtureWallet.wallet.disconnect(); }
});

async function fakeHelper(source: string, callback: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-keyring-process-'));
  const path = join(directory, 'helper.cjs');
  try {
    await writeFile(path, '#!/usr/bin/env node\n' + source, { mode: 0o700 });
    await chmod(path, 0o700);
    await callback(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('local helper uses argument arrays and does not inherit mnemonic or Node loader settings', async () => {
  const oldMnemonic = process.env.COSMOS_MNEMONIC;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  process.env.COSMOS_MNEMONIC = 'public-secret-looking-test-value';
  process.env.NODE_OPTIONS = '--this-must-not-reach-the-helper';
  try {
    await fakeHelper(`process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({args:process.argv.slice(2), mnemonicPresent:!!process.env.COSMOS_MNEMONIC, nodeOptionsPresent:!!process.env.NODE_OPTIONS})));`, async helperPath => {
      const keyName = 'fixture;$(no-shell-command)';
      const value = await runKeyringHelper({ ...options, helperPath, keyName }, { operation: 'public-key' }, new AbortController().signal) as { args: string[]; mnemonicPresent: boolean; nodeOptionsPresent: boolean };
      assert.equal(value.args[value.args.indexOf('--key') + 1], keyName);
      assert.equal(value.mnemonicPresent, false);
      assert.equal(value.nodeOptionsPresent, false);
    });
  } finally {
    if (oldMnemonic === undefined) delete process.env.COSMOS_MNEMONIC; else process.env.COSMOS_MNEMONIC = oldMnemonic;
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
  }
});

test('native errors are sanitized and subprocess requests, responses and waits are bounded', async () => {
  await fakeHelper(`process.stderr.write('sensitive-looking-backend-diagnostic'); process.exit(1);`, async helperPath => {
    await assert.rejects(runKeyringHelper({ ...options, helperPath }, { operation: 'public-key' }, new AbortController().signal), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('sensitive-looking'));
      return true;
    });
  });
  await fakeHelper(`setInterval(() => {}, 1000);`, async helperPath => {
    await assert.rejects(runKeyringHelper({ ...options, helperPath, timeoutMs: 150 }, { operation: 'public-key' }, new AbortController().signal), /timed out/);
  });
  await fakeHelper(`process.stdout.write('x'.repeat(70000));`, async helperPath => {
    await assert.rejects(runKeyringHelper({ ...options, helperPath }, { operation: 'public-key' }, new AbortController().signal), /size limit/);
  });
  await assert.rejects(runKeyringHelper(options, { operation: 'sign-adr036', data: 'x'.repeat(70000) }, new AbortController().signal), /size limit/);
  await assert.rejects(createKeyringWalletProvider({ ...options, home: '/bad\0path' }), /Invalid local keyring configuration/);
});
