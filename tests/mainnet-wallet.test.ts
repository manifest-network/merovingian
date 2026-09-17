import assert from 'node:assert/strict';
import { createPublicKey, ECDH, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createSignerAdapter, parseLeaseUuid } from '@manifest-network/manifest-sdk';
import { createAuthTokens, createSignMessage } from '@manifest-network/manifest-sdk/deploy';
import type { createFredClientNode } from '@manifest-network/manifest-sdk/node';
import { serializeSignDoc, type StdSignDoc } from 'cosmjs-amino-modern';
import { makeSignBytes, makeSignDoc } from 'cosmjs-proto-signing-modern';
import { createMainnetWalletProvider } from '../scripts/mainnet-wallet.js';

// Public BIP-39 test vector. Never fund this address or use this mnemonic in production.
const publicMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const expectedAddress = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const expectedPublicKey = '024f4e2ad99c34d60b9ba6283c9431a8418af8673212961f97a77b6377fcd05b62';
const anotherAddress = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';

function verifies(bytes: Uint8Array, signature: string, publicKey: string): boolean {
  // Independent OpenSSL verification with standard public-key conversion, not the signer implementation.
  const point = ECDH.convertKey(Buffer.from(publicKey, 'base64'), 'secp256k1', undefined, undefined, 'uncompressed');
  assert.ok(Buffer.isBuffer(point));
  const key = createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'secp256k1',
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
  } });
  return verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
}

function adrDocument(data: string): StdSignDoc {
  return {
    account_number: '0', chain_id: '', fee: { amount: [], gas: '0' }, memo: '',
    msgs: [{ type: 'sign/MsgSignData', value: { data: Buffer.from(data, 'utf8').toString('base64'), signer: expectedAddress } }],
    sequence: '0',
  };
}

test('optional modern provider derives the standard Manifest account and satisfies Fred SDK types', async () => {
  const provider = await createMainnetWalletProvider(publicMnemonic);
  try {
    assert.equal(await provider.getAddress(), expectedAddress);
    const signer = await provider.getSigner();
    const [account] = await signer.getAccounts();
    assert.equal(account!.address, expectedAddress);
    assert.equal(Buffer.from(account!.pubkey).toString('hex'), expectedPublicKey);
    assert.equal(account!.algo, 'secp256k1');
    assert.ok(!('mnemonic' in signer));
    const sdkOptions: Parameters<typeof createFredClientNode>[0] = {
      config: { chainId: 'manifest-ledger-testnet', rpcUrl: 'https://rpc.example.invalid', gasPrice: '1umfx' },
      walletProvider: provider,
    };
    assert.equal(sdkOptions.walletProvider, provider); // Type compatibility without connecting to a provider.
  } finally { await provider.disconnect(); }
});

test('direct signing verifies independently and binds the exact Cosmos sign document', async () => {
  const provider = await createMainnetWalletProvider(publicMnemonic);
  try {
    const signer = await provider.getSigner();
    const document = makeSignDoc(Uint8Array.of(10, 0), Uint8Array.of(18, 0), 'manifest-ledger-testnet', 7);
    const result = await signer.signDirect(expectedAddress, document);
    assert.deepEqual(result.signed, document);
    assert.equal(Buffer.from(result.signature.signature, 'base64').length, 64);
    assert.equal(result.signature.pub_key.type, 'tendermint/PubKeySecp256k1');
    assert.equal(verifies(makeSignBytes(document), result.signature.signature, result.signature.pub_key.value), true);
    assert.equal(verifies(makeSignBytes({ ...document, chainId: 'another-chain' }), result.signature.signature, result.signature.pub_key.value), false);
    await assert.rejects(signer.signDirect(anotherAddress, document), /another wallet address/);
  } finally { await provider.disconnect(); }
});

test('ADR-036 signs serialized UTF-8 data with the fixed account, chain, fee and message envelope', async () => {
  const provider = await createMainnetWalletProvider(publicMnemonic);
  try {
    const data = 'manifest refuge auth: cookies 🍪\nno transaction';
    const result = await provider.signArbitrary(expectedAddress, data);
    const document = adrDocument(data);
    assert.equal(verifies(serializeSignDoc(document), result.signature, result.pub_key.value), true);
    assert.equal(verifies(Buffer.from(data, 'utf8'), result.signature, result.pub_key.value), false);
    const variants: StdSignDoc[] = [
      { ...document, chain_id: 'manifest-ledger' }, { ...document, account_number: '1' },
      { ...document, sequence: '1' }, { ...document, fee: { gas: '1', amount: [] } },
      { ...document, memo: 'different domain' }, adrDocument(`${data}!`),
      { ...document, msgs: [{ type: 'cosmos-sdk/MsgSend', value: document.msgs[0]!.value }] },
    ];
    for (const changed of variants) assert.equal(verifies(serializeSignDoc(changed), result.signature, result.pub_key.value), false);
    await assert.rejects(provider.signArbitrary(anotherAddress, data), /another wallet address/);
  } finally { await provider.disconnect(); }
});

test('SDK provider authentication uses modern signatures and neither path falls back to legacy elliptic', async (context) => {
  // Resolve the legacy dependency through the installed SDK's declared signer dependency.
  const legacySignerRequire = createRequire(import.meta.resolve('@cosmjs/proto-signing'));
  const legacyCryptoRequire = createRequire(legacySignerRequire.resolve('@cosmjs/crypto'));
  const elliptic = legacyCryptoRequire('elliptic') as { ec: { prototype: { sign: (...args: unknown[]) => unknown } } };
  context.mock.method(elliptic.ec.prototype, 'sign', () => { throw new Error('Legacy elliptic signing is forbidden'); });
  const provider = await createMainnetWalletProvider(publicMnemonic);
  try {
    const signer = await provider.getSigner();
    const direct = makeSignDoc(new Uint8Array(), new Uint8Array(), 'fixture-chain', 0);
    const signed = await signer.signDirect(expectedAddress, direct);
    assert.equal(verifies(makeSignBytes(direct), signed.signature.signature, signed.signature.pub_key.value), true);
    const adapter = createSignerAdapter(provider, 'manifest');
    const tokens = createAuthTokens(adapter, { chainId: 'manifest-ledger-testnet' });
    const lease = parseLeaseUuid('11111111-1111-4111-8111-111111111111');
    const token = JSON.parse(Buffer.from(await tokens.getAuthToken(lease), 'base64').toString('utf8')) as {
      tenant: string; lease_uuid: string; timestamp: number; pub_key: string; signature: string;
    };
    assert.equal(token.tenant, expectedAddress);
    assert.equal(token.lease_uuid, lease);
    const message = createSignMessage(token.tenant, lease, token.timestamp);
    assert.equal(verifies(serializeSignDoc(adrDocument(message)), token.signature, token.pub_key), true);
  } finally { await provider.disconnect(); }
});

test('disconnect revokes previously returned signer access and initialization errors omit input', async () => {
  const provider = await createMainnetWalletProvider(publicMnemonic);
  const signer = await provider.getSigner();
  await provider.disconnect();
  await provider.disconnect();
  await assert.rejects(provider.getAddress(), /disconnected/);
  await assert.rejects(provider.getSigner(), /disconnected/);
  await assert.rejects(async () => signer.getAccounts(), /disconnected/);
  await assert.rejects(signer.signDirect(expectedAddress, makeSignDoc(new Uint8Array(), new Uint8Array(), 'fixture', 0)), /disconnected/);
  await assert.rejects(provider.signArbitrary(expectedAddress, 'fixture'), /disconnected/);
  const invalidInput = 'this invalid mnemonic must never appear in an error';
  await assert.rejects(createMainnetWalletProvider(invalidInput), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(invalidInput));
    assert.match(error.message, /Unable to initialize/);
    return true;
  });
});
