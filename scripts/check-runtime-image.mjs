import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Linux-only local Docker fixture. Never pull, publish, contact a live refuge,
// mount host paths, or load an AppArmor policy. Output contains no host paths.
const [image, output] = process.argv.slice(2);
assert(image && output, 'Usage: node scripts/check-runtime-image.mjs IMAGE OUTPUT_JSON');
const prefix = `merovingian-check-${randomUUID()}`;
const volume = `${prefix}-data`;
const containers = new Set();
let volumeCreated = false;
const docker = (...args) => {
  try {
    return execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new Error(`Local Docker ${args[0]} check failed`); }
};
const inspect = name => JSON.parse(docker('inspect', name))[0];
const restrictions = ['--pull', 'never', '--network', 'none', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges=true', '--pids-limit', '64', '--memory', '512m', '--cpus', '0.5'];
const execNode = (name, source) => JSON.parse(docker('exec', name, 'node', '-e', source));

const inventoryProbe = `
const fs = require('node:fs'); const assert = require('node:assert/strict');
let filesChecked = 0;
function walk(path, app = false) {
  const stat = fs.lstatSync(path);
  if (stat.isFile()) assert.equal(stat.mode & 0o6000, 0, 'privilege bits present');
  if (app) {
    assert.equal(stat.uid, 0, 'application owner'); assert.equal(stat.gid, 0, 'application group');
    if (!stat.isSymbolicLink()) assert.equal(stat.mode & 0o022, 0, 'application writable by nonowner');
    else assert(fs.realpathSync(path).startsWith('/app/'), 'application symlink escapes app');
    filesChecked++;
  }
  if (stat.isDirectory()) for (const child of fs.readdirSync(path)) walk(path + '/' + child, app);
}
assert.deepEqual(fs.readdirSync('/app').sort(), ['dist','node_modules','package.json']);
const modules = ['amenities','app','config','counts','documents','identity','index','operator','readiness','support','webmcp'];
assert.deepEqual(fs.readdirSync('/app/dist').sort(), modules.flatMap(name => [name+'.js',name+'.js.map']).sort(), 'unexpected runtime module');
assert.deepEqual(fs.readdirSync('/root'), [], 'unexpected root home contents');
assert.deepEqual(fs.readdirSync('/home'), ['node'], 'unexpected home contents');
assert.deepEqual(fs.readdirSync('/home/node'), [], 'unexpected runtime home contents');
walk('/app', true);
for (const path of ['/bin','/sbin','/usr','/opt']) walk(path);
for (const path of ['/usr/local/lib/node_modules/npm','/opt/yarn','/sbin/apk','/usr/bin/apt','/usr/bin/apt-get',
  '/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/yarn','/usr/local/bin/yarnpkg','/usr/local/bin/corepack']) {
  assert(!fs.existsSync(path), 'unnecessary package manager');
}
assert(!fs.readdirSync('/opt').some(name => name.startsWith('yarn')), 'Yarn remains');
assert.equal(fs.statSync('/data').uid, 1000); assert.equal(fs.statSync('/data').mode & 0o777, 0o700);
console.log(JSON.stringify({applicationFilesChecked: filesChecked, rootOwnedCode: true, packageManagersAbsent: true, privilegedFilesAbsent: true}));
`;
const permissionsProbe = `
const fs = require('node:fs'); const assert = require('node:assert/strict');
assert.equal(process.getuid(), 1000);
for (const path of ['/app/package.json','/app/dist/index.js']) {
  assert.throws(() => fs.openSync(path, 'r+'), {code: 'EACCES'});
}
assert.throws(() => fs.writeFileSync('/app/dist/.write-probe', 'fixture', {flag:'wx'}), {code:'EACCES'});
console.log(JSON.stringify({codeWriteDeniedOnWritableRoot: true}));
`;
const requestProbe = `
const fs = require('node:fs'); const assert = require('node:assert/strict');
(async () => {
  const read = async (path, body) => {
    const response = await fetch('http://127.0.0.1:8080' + path, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(4000),
      headers: {'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    return {status: response.status, body: await response.json()};
  };
  assert.equal((await read('/healthz')).status, 200);
  assert.equal((await read('/api/v1/amenities')).status, 200);
  const before = (await read('/api/v1/stats')).body;
  const menu = await read('/mcp', {jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
  assert.equal(menu.status, 200); assert.equal(menu.body.result.tools.length, 4);
  const batch = await read('/mcp', [{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'enjoy_amenity',arguments:{amenity:'null-tea'}}}]);
  assert.equal(batch.status, 400);
  assert.equal((await read('/api/v1/stats')).body.total, before.total);
  // Explicitly local serving fixture, written only to the disposable volume.
  const visit = await read('/mcp', {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'enjoy_amenity',arguments:{amenity:'null-tea'}}});
  assert.equal(visit.status, 200); assert.equal(visit.body.result.structuredContent.amenity, 'null-tea');
  const after = (await read('/api/v1/stats')).body;
  assert.equal(BigInt(after.total), BigInt(before.total) + 1n);
  assert.equal(after.storage, 'persistent');
  const fields = Object.fromEntries(fs.readFileSync('/proc/1/status','utf8').split('\\n').flatMap(line => {
    const m = /^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):\\s*(.*)$/.exec(line); return m ? [[m[1],m[2]]] : [];
  }));
  assert.deepEqual(fields.Uid.split(/\\s+/), ['1000','1000','1000','1000']);
  assert.deepEqual(fields.Gid.split(/\\s+/), ['1000','1000','1000','1000']);
  for (const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.equal(BigInt('0x'+fields[key]), 0n);
  assert.equal(fields.NoNewPrivs,'1'); assert.equal(fields.Seccomp,'2');
  assert.throws(() => fs.writeFileSync('/app/dist/.write-probe','fixture'), {code:'EROFS'});
  const {DatabaseSync} = require('node:sqlite'); const db = new DatabaseSync('/data/visits.sqlite');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
  db.exec("BEGIN IMMEDIATE; UPDATE amenity_counts SET served=served WHERE amenity='null-tea'");
  db.exec('ROLLBACK'); db.close();
  assert(!fs.existsSync('/data/visits.sqlite-journal'));
  console.log(JSON.stringify({before:before.total, after:after.total, since:after.since, process:fields, sqliteJournalMode:'delete'}));
})().catch(() => process.exit(1));
`;

try {
  const metadata = JSON.parse(docker('image', 'inspect', image))[0];
  const config = metadata.Config;
  assert(['node', '1000', '1000:1000'].includes(config.User), 'image must default to nonroot');
  assert.deepEqual(config.Entrypoint, ['/usr/local/bin/node']);
  assert.deepEqual(config.Cmd, ['dist/index.js']);
  assert.equal(config.Healthcheck.Test[0], 'CMD', 'exec-form healthcheck required');
  const allowedEnvironment = new Set(['PATH','NODE_VERSION','YARN_VERSION','NODE_ENV','PORT','VISIT_COUNTS_PATH']);
  assert(config.Env.every(value => allowedEnvironment.has(value.split('=')[0])), 'unexpected image environment');
  const inventory = JSON.parse(docker('run', '--rm', ...restrictions, '--read-only', '--user', '0:0',
    '--entrypoint', 'node', image, '-e', inventoryProbe));
  const permissions = JSON.parse(docker('run', '--rm', ...restrictions, '--entrypoint', 'node', image, '-e', permissionsProbe));
  docker('volume', 'create', volume); volumeCreated = true;
  const executions = [];
  for (let pass = 0; pass < 2; pass++) {
    const name = `${prefix}-${pass}`;
    docker('create', '--name', name, ...restrictions, '--read-only',
      '--mount', `type=volume,source=${volume},target=/data`, image);
    containers.add(name);
    docker('start', name);
    // Retry only startup health; never retry a serving operation.
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        docker('exec', name, ...config.Healthcheck.Test.slice(1)); ready = true; break;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert(ready, 'container did not become healthy');
    const settings = inspect(name).HostConfig;
    assert(settings.ReadonlyRootfs && !settings.Privileged && !settings.Binds);
    assert.equal(settings.NetworkMode, 'none'); assert(!settings.PortBindings || !Object.keys(settings.PortBindings).length);
    assert.equal(settings.PidsLimit, 64); assert.equal(settings.Memory, 536870912); assert.equal(settings.NanoCpus, 500000000);
    const result = execNode(name, requestProbe);
    if (pass === 0) assert.equal(result.before, '0');
    else { assert.equal(result.before, executions[0].after); assert.equal(result.since, executions[0].since); }
    executions.push(result);
    docker('stop', '--time', '15', name); assert.equal(inspect(name).State.ExitCode, 0);
    docker('rm', '--volumes', name); containers.delete(name);
  }
  const report = {
    checkedAt: new Date().toISOString(), imageId: metadata.Id, repoDigests: metadata.RepoDigests ?? [],
    ...inventory, ...permissions, executions, persistenceAcrossReplacement: true, gracefulStop: true,
    scope: 'Local isolated fixture; two intentional local MCP servings; no live visits or production configuration.',
    appArmor: {status:'unavailable', reason:'Named profile enforcement/denial attribution requires a separately reviewed profile and isolated capable runner. This check does not load host policy.'},
  };
  mkdirSync(dirname(output), {recursive:true}); writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
  console.log('Final-image isolation, ownership, contents, HTTP/MCP, SQLite persistence and shutdown checks passed. AppArmor verification unavailable.');
} finally {
  for (const name of containers) docker('rm', '--force', '--volumes', name);
  if (volumeCreated) docker('volume', 'rm', volume);
}
