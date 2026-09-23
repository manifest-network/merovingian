import { spawn } from 'node:child_process';
import { createPublicKey, ECDH, verify, type KeyObject } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { parseAddress, type SignArbitraryResult, type WalletProvider } from '@manifest-network/manifest-sdk';
import { pubkeyToAddress, serializeSignDoc, type StdSignDoc } from 'cosmjs-amino-modern';
import { makeSignBytes, type OfflineDirectSigner } from 'cosmjs-proto-signing-modern';

const MAX_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 4096;
const PUBLIC_KEY_TYPE = 'tendermint/PubKeySecp256k1';

/** Every stable code the native helper can emit (constants in tools/keyring-signer/main.go).
 * Only these are surfaced; any other diagnostic is discarded. A test keeps the lists equal. */
export const HELPER_ERROR_CODES: readonly string[] = Object.freeze([
  'ADDRESS_MISMATCH', 'CHAIN_MISMATCH', 'CORE_DUMP_PROTECTION_FAILED', 'INTERNAL_ERROR', 'INVALID_CHAIN_CONFIGURATION',
  'INVALID_CONFIGURATION', 'INVALID_EXPECTED_ADDRESS', 'INVALID_FLAGS', 'INVALID_PUBLIC_KEY', 'INVALID_REQUEST',
  'INVALID_SIGN_DOCUMENT', 'KEYRING_HOME_UNAVAILABLE', 'KEYRING_OPERATION_TIMEOUT', 'KEYRING_UNAVAILABLE_OR_LOCKED',
  'KEY_UNAVAILABLE_OR_LOCKED', 'NONINTERACTIVE_SIGNING_UNAVAILABLE', 'NONINTERACTIVE_UNLOCK_UNAVAILABLE',
  'OUTPUT_INITIALIZATION_FAILED', 'REQUEST_READ_FAILED', 'REQUEST_TOO_LARGE', 'SIGNATURE_VERIFICATION_FAILED',
  'SIGNING_FAILED', 'SIGN_DOCUMENT_FAILED', 'UNSUPPORTED_BACKEND', 'UNSUPPORTED_KEY_TYPE', 'UNSUPPORTED_OPERATION',
]);

export interface KeyringWalletOptions {
  helperPath: string;
  home: string;
  keyringBackend: 'os' | 'file' | 'kwallet' | 'pass' | 'test';
  keyName: string;
  expectedAddress: string;
  chainId: string;
  timeoutMs?: number;
}

export type KeyringRequest =
  | { operation: 'public-key' }
  | { operation: 'sign-direct'; signBytes: string }
  | { operation: 'sign-adr036'; data: string };

export interface KeyringWalletProvider extends WalletProvider {
  getSigner(): Promise<OfflineDirectSigner>;
  signArbitrary(address: string, data: string): Promise<SignArbitraryResult>;
  disconnect(): Promise<void>;
}

// The injection point is for disposable-key tests. Production uses only the
// bounded local subprocess below; no network or key export is involved.
export type KeyringRunner = (options: Readonly<KeyringWalletOptions>, request: KeyringRequest, signal: AbortSignal) => Promise<unknown>;

function checkedOptions(input: KeyringWalletOptions): Readonly<KeyringWalletOptions> {
  if (!isAbsolute(input.helperPath) || !isAbsolute(input.home)
    || /[\x00-\x1f]/.test(input.helperPath + input.home)
    || !['os', 'file', 'kwallet', 'pass', 'test'].includes(input.keyringBackend)
    || !input.keyName || input.keyName.length > 128 || /[\x00-\x1f]/.test(input.keyName)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(input.chainId)) {
    throw new Error('Invalid local keyring configuration.');
  }
  parseAddress(input.expectedAddress, 'manifest');
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('Invalid keyring timeout.');
  return Object.freeze({ ...input, timeoutMs });
}

function subprocessEnvironment(): NodeJS.ProcessEnv {
  // Do not forward app secrets, mnemonic/password variables, RPC settings,
  // NODE_OPTIONS, or helper/debug overrides into the signing process.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY',
    'GNUPGHOME', 'GPG_TTY', 'TERM']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export const runKeyringHelper: KeyringRunner = (options, request, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Keyring operation cancelled.')); return; }
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) { reject(new Error('Keyring request exceeds its size limit.')); return; }
  const args = ['--home', options.home, '--keyring-backend', options.keyringBackend,
    '--key', options.keyName, '--expected-address', options.expectedAddress, '--chain-id', options.chainId];
  const child = spawn(options.helperPath, args, {
    shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: subprocessEnvironment(),
  });
  let finished = false;
  let outputSize = 0;
  let errorSize = 0;
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    cleanup();
    child.kill('SIGKILL');
    reject(new Error(message));
  };
  const abort = () => fail('Keyring operation cancelled.');
  const timer = setTimeout(() => fail('Keyring operation timed out. Unlock the configured store locally and retry.'), options.timeoutMs ?? 15_000);
  timer.unref();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  child.on('error', () => fail('Unable to start the configured keyring helper.'));
  child.stdin.on('error', () => fail('Unable to send a request to the keyring helper.'));
  child.stdout.on('data', (chunk: Buffer) => {
    outputSize += chunk.length;
    if (outputSize > MAX_BYTES) fail('Keyring helper response exceeds its size limit.');
    else output.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errorSize += chunk.length;
    if (errorSize > MAX_ERROR_BYTES) fail('Keyring helper diagnostic exceeds its size limit.');
    else errors.push(chunk);
  });
  child.on('close', code => {
    if (finished) return;
    finished = true;
    cleanup();
    if (code !== 0) {
      // Never include native/OS diagnostics: they may contain credentials or
      // request contents. Only explicitly recognized stable codes are surfaced.
      let suffix = '';
      try {
        const result: unknown = JSON.parse(Buffer.concat(errors).toString('utf8'));
        if (typeof result === 'object' && result !== null && 'error' in result
          && typeof result.error === 'string' && HELPER_ERROR_CODES.includes(result.error)) suffix = ` (${result.error})`;
      } catch { /* Discard all unrecognized diagnostics. */ }
      reject(new Error(`Local keyring operation failed${suffix}. Check the selected key and unlock its store locally.`));
      return;
    }
    try { resolve(JSON.parse(Buffer.concat(output).toString('utf8')) as unknown); }
    catch { reject(new Error('Keyring helper returned an invalid response.')); }
  });
  if (!finished) child.stdin.end(input);
});

function base64Bytes(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid keyring signing response.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value) throw new Error('Invalid keyring signing response.');
  return bytes;
}

function checkedResponse(value: unknown, expectedAddress: string, signing: boolean) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid keyring signing response.');
  const result = value as Record<string, unknown>;
  const keys = signing ? ['address', 'publicKey', 'signature'] : ['address', 'publicKey'];
  if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key))
    || result.address !== expectedAddress) throw new Error('Keyring returned an unexpected account or response.');
  const publicKey = base64Bytes(result.publicKey, 33);
  if (![2, 3].includes(publicKey[0]!) || pubkeyToAddress({ type: PUBLIC_KEY_TYPE, value: publicKey.toString('base64') }, 'manifest') !== expectedAddress) {
    throw new Error('Keyring public key does not match the configured address.');
  }
  return { publicKey, signature: signing ? base64Bytes(result.signature, 64) : undefined };
}

function verificationKey(publicKey: Buffer): KeyObject {
  const point = ECDH.convertKey(publicKey, 'secp256k1', undefined, undefined, 'uncompressed');
  if (!Buffer.isBuffer(point)) throw new Error('Invalid keyring public key.');
  return createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'secp256k1', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
  } });
}

export function keyringAdrDocument(address: string, data: string): StdSignDoc {
  return { chain_id: '', account_number: '0', sequence: '0', fee: { gas: '0', amount: [] },
    msgs: [{ type: 'sign/MsgSignData', value: { signer: address, data: Buffer.from(data, 'utf8').toString('base64') } }], memo: '' };
}

/** Local signing only. Secret keys never cross the helper's process boundary. */
export async function createKeyringWalletProvider(input: KeyringWalletOptions, runner: KeyringRunner = runKeyringHelper): Promise<KeyringWalletProvider> {
  const options = checkedOptions(input);
  const controller = new AbortController();
  const connected = () => { if (controller.signal.aborted) throw new Error('Keyring wallet has been disconnected.'); };
  const assertAddress = (address: string) => {
    connected();
    if (address !== options.expectedAddress) throw new Error('Cannot sign for another wallet address.');
  };
  const account = checkedResponse(await runner(options, { operation: 'public-key' }, controller.signal), options.expectedAddress, false);
  const key = verificationKey(account.publicKey);
  const sign = async (request: KeyringRequest, bytes: Uint8Array): Promise<SignArbitraryResult> => {
    connected();
    const response = checkedResponse(await runner(options, request, controller.signal), options.expectedAddress, true);
    connected();
    if (!response.publicKey.equals(account.publicKey)
      || !verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, response.signature!)) throw new Error('Keyring signature verification failed.');
    return { pub_key: { type: PUBLIC_KEY_TYPE, value: response.publicKey.toString('base64') }, signature: response.signature!.toString('base64') };
  };
  const signer: OfflineDirectSigner = {
    async getAccounts() { connected(); return [{ address: options.expectedAddress, algo: 'secp256k1', pubkey: Uint8Array.from(account.publicKey) }]; },
    async signDirect(address, document) {
      assertAddress(address);
      if (document.chainId !== options.chainId) throw new Error('Refusing to sign a transaction for another chain.');
      if (!document.bodyBytes.length || !document.authInfoBytes.length) throw new Error('Refusing an incomplete transaction sign document.');
      // Snapshot caller-owned byte arrays before the asynchronous helper call.
      const signed = { ...document, bodyBytes: Uint8Array.from(document.bodyBytes), authInfoBytes: Uint8Array.from(document.authInfoBytes) };
      const bytes = makeSignBytes(signed);
      const signature = await sign({ operation: 'sign-direct', signBytes: Buffer.from(bytes).toString('base64') }, bytes);
      return { signed, signature };
    },
  };
  return {
    async getAddress() { connected(); return options.expectedAddress; },
    async getSigner() { connected(); return signer; },
    async signArbitrary(address, data) {
      assertAddress(address);
      if (typeof data !== 'string') throw new Error('ADR-036 data must be a string.');
      const bytes = serializeSignDoc(keyringAdrDocument(address, data));
      return sign({ operation: 'sign-adr036', data }, bytes);
    },
    async disconnect() { controller.abort(); },
  };
}
