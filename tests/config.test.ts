import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const mainnetEnv: NodeJS.ProcessEnv = {
  NETWORK: 'mainnet',
  PUBLIC_ORIGIN: 'https://refuge.example',
  MANIFEST_RPC_URL: 'https://nodes.manifest.network/manifest/rpc',
  MANIFEST_REST_URL: 'https://nodes.manifest.network/manifest/api',
  PWR_DENOM: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr',
  REFUGE_TENANT: 'manifest1z5ep5m3ka5v2fn5wyv93elqh5nqlfqww2u82f4',
};

test('proxy trust defaults closed and accepts only explicit bounded IP/CIDR configuration', () => {
  assert.deepEqual(loadConfig({}).trustedProxyCidrs, []);
  assert.deepEqual(loadConfig({ TRUST_PROXY_HOPS: '0' }).trustedProxyCidrs, []);
  assert.deepEqual(loadConfig({ TRUSTED_PROXY_CIDRS: ' 192.0.2.5, 198.51.100.0/24,2001:db8::/64,::1,192.0.2.5 ' }).trustedProxyCidrs,
    ['192.0.2.5', '198.51.100.0/24', '2001:db8::/64', '::1']);
  for (const value of ['1', '3', '-1', 'false', 'true', '0.0']) {
    assert.throws(() => loadConfig({ TRUST_PROXY_HOPS: value }), /TRUST_PROXY_HOPS/);
  }
  for (const value of ['true', '1', 'loopback', 'uniquelocal', 'proxy.example', '192.0.2.5,',
    '0.0.0.0/0', '::/0', '0.0.0.0/1', '192.0.2.0/23', '::/1', '2001:db8::/63',
    '::ffff:0:0/96', '::ffff:192.0.2.0/120', '0:0:0:0:0:ffff:c000:200/120',
    '192.0.2.0/33', '::1/129', '192.0.2.1/01', '::1/64/1',
    'fe80::1%eth0', '192.0.2.1/255.255.255.0', Array(33).fill('192.0.2.1').join(',')]) {
    assert.throws(() => loadConfig({ TRUSTED_PROXY_CIDRS: value }), /TRUSTED_PROXY_CIDRS/, value);
  }
  assert.deepEqual(loadConfig({ TRUSTED_PROXY_CIDRS: '192.0.2.5/32,2001:db8::1/128,::ffff:192.0.2.5' }).trustedProxyCidrs,
    ['192.0.2.5/32', '2001:db8::1/128', '::ffff:192.0.2.5']);
});

test('counter storage is explicitly configured with an absolute path', () => {
  assert.equal(loadConfig({}).visitCountsPath, undefined);
  assert.equal(loadConfig({ VISIT_COUNTS_PATH: '/data/visits.sqlite' }).visitCountsPath, '/data/visits.sqlite');
  assert.throws(() => loadConfig({ VISIT_COUNTS_PATH: './visits.sqlite' }), /VISIT_COUNTS_PATH/);
});

test('unconfigured local app remains entirely testnet with no funded tenant', () => {
  const config = loadConfig({});
  assert.equal(config.network, 'testnet');
  assert.equal(config.chainId, 'manifest-ledger-testnet');
  assert.equal(config.tenant, '');
  assert.equal(config.publicOrigin, 'http://localhost:8080');
  assert.match(config.rpcUrl, /\/testnet\/rpc$/);
  assert.match(config.restUrl || '', /\/testnet\/api$/);
  assert.equal(config.mainnetOrigin, undefined);
  assert.throws(() => loadConfig({ NETWORK: 'unknown' }), /NETWORK/);
});

test('mainnet uses the live production chain identity with explicitly configured PWR shared by both chains', () => {
  const config = loadConfig(mainnetEnv);
  assert.equal(config.network, 'mainnet');
  assert.equal(config.chainId, 'manifest-ledger-mainnet');
  assert.equal(config.rpcUrl, mainnetEnv.MANIFEST_RPC_URL);
  assert.equal(config.restUrl, mainnetEnv.MANIFEST_REST_URL);
  assert.equal(config.pwrDenom, mainnetEnv.PWR_DENOM);
  assert.equal(config.pwrDenom, loadConfig({}).pwrDenom, 'Denomination equality does not mean the same chain or balance');
  assert.equal(config.tenant, mainnetEnv.REFUGE_TENANT);
  assert.equal(config.publicOrigin, mainnetEnv.PUBLIC_ORIGIN);
  assert.equal(config.mainnetOrigin, undefined);
  assert.equal(loadConfig({ ...mainnetEnv, CHAIN_ID: 'manifest-ledger-mainnet' }).chainId, config.chainId);
  const normalized = loadConfig({
    ...mainnetEnv,
    PUBLIC_ORIGIN: `${mainnetEnv.PUBLIC_ORIGIN}/`,
    MANIFEST_RPC_URL: `${mainnetEnv.MANIFEST_RPC_URL}/`,
    MANIFEST_REST_URL: `${mainnetEnv.MANIFEST_REST_URL}/`,
  });
  assert.equal(normalized.publicOrigin, config.publicOrigin);
  assert.equal(normalized.rpcUrl, config.rpcUrl);
  assert.equal(normalized.restUrl, config.restUrl);
});

test('mainnet never inherits missing deployment settings, including REST needed for funding history', () => {
  assert.throws(() => loadConfig({ NETWORK: 'mainnet' }), /Mainnet requires/);
  for (const key of ['PUBLIC_ORIGIN', 'MANIFEST_RPC_URL', 'MANIFEST_REST_URL', 'PWR_DENOM', 'REFUGE_TENANT']) {
    for (const missing of [undefined, '']) {
      assert.throws(() => loadConfig({ ...mainnetEnv, [key]: missing }), /Mainnet requires/, `${key} must be explicit`);
    }
  }
});

test('chain identities cannot cross networks or use the obsolete placeholder chain ID', () => {
  for (const chainId of ['manifest-ledger-testnet', 'manifest-1', 'unknown-mainnet']) {
    assert.throws(() => loadConfig({ ...mainnetEnv, CHAIN_ID: chainId }), /CHAIN_ID/);
  }
  for (const chainId of ['manifest-ledger-mainnet', 'manifest-1', 'unknown-testnet']) {
    assert.throws(() => loadConfig({ NETWORK: 'testnet', CHAIN_ID: chainId }), /CHAIN_ID/);
  }
});

test('mainnet rejects recognizable testnet endpoints and explicitly testnet-labeled tokens', () => {
  const testnet = loadConfig({});
  for (const patch of [
    { MANIFEST_RPC_URL: testnet.rpcUrl },
    { MANIFEST_REST_URL: testnet.restUrl },
    { MANIFEST_RPC_URL: 'https://rpc.testnet.example/manifest' },
    { MANIFEST_REST_URL: 'https://nodes.example/manifest/TESTNET/api' },
    { PWR_DENOM: 'factory/manifest1different/testnet-pwr' },
    { PUBLIC_ORIGIN: 'http://localhost:8080' },
  ]) {
    assert.throws(() => loadConfig({ ...mainnetEnv, ...patch }), /Mainnet must/);
  }
});

test('configured chain endpoints require HTTPS without credentials, queries, or fragments', () => {
  for (const key of ['MANIFEST_RPC_URL', 'MANIFEST_REST_URL']) {
    for (const value of [
      'http://nodes.example/manifest',
      'https://user:password@nodes.example/manifest',
      'https://nodes.example/manifest?network=testnet',
      'https://nodes.example/manifest#testnet',
    ]) {
      assert.throws(() => loadConfig({ ...mainnetEnv, [key]: value }), new RegExp(key));
    }
  }
});

test('public origins cannot carry credentials, paths, query data, or fragments', () => {
  for (const value of [
    'https://user:password@refuge.example', 'https://refuge.example/path',
    'https://refuge.example/?q=x', 'https://refuge.example/#fragment', 'http://public.example',
  ]) {
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: value }));
  }
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:8080' }).publicOrigin, 'http://127.0.0.1:8080');
});

test('retirement records a separate mainnet origin while preserving testnet financial configuration', () => {
  const original = loadConfig({ PUBLIC_ORIGIN: 'https://proof.example' });
  const retired = loadConfig({ PUBLIC_ORIGIN: 'https://proof.example', MAINNET_ORIGIN: 'https://refuge.example' });
  assert.equal(retired.mainnetOrigin, 'https://refuge.example');
  for (const key of ['network', 'chainId', 'rpcUrl', 'restUrl', 'pwrDenom', 'tenant'] as const) {
    assert.equal(retired[key], original[key]);
  }
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://refuge.example', MAINNET_ORIGIN: 'https://refuge.example/' }));
  assert.throws(() => loadConfig({ MAINNET_ORIGIN: 'http://localhost:8081' }), /MAINNET_ORIGIN/);
  assert.throws(() => loadConfig({ ...mainnetEnv, MAINNET_ORIGIN: 'https://other.example' }), /only to retire testnet/);
});
