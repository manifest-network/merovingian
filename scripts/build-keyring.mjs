import { spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = resolve(root, '.local/go-cache');
const temporary = resolve(root, '.local/go-tmp');
const output = resolve(root, '.local/mainnet/bin/keyring-signer');
for (const directory of [cache, temporary, resolve(root, '.local/mainnet/bin')]) await mkdir(directory, { recursive: true, mode: 0o700 });
const child = spawn('go', ['build', '-p=2', '-mod=readonly', '-trimpath', '-o', output, '.'], {
  cwd: resolve(root, 'tools/keyring-signer'), shell: false, stdio: 'inherit',
  env: { ...process.env, GOCACHE: cache, GOTMPDIR: temporary, TMPDIR: temporary, GOMAXPROCS: '2' },
});
child.on('error', () => { console.error('Unable to start Go. Install the documented Go toolchain first.'); process.exitCode = 1; });
child.on('exit', async code => {
  process.exitCode = code ?? 1;
  if (code === 0) { await chmod(output, 0o700); console.log('Built the local keyring helper; no wallet was opened.'); }
});
