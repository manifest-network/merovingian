import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Linux-only local Docker fixture. Never pull, publish, contact a live refuge,
// mount host paths, or load an AppArmor policy. Output contains no host paths.
const restrictions = ['--pull', 'never', '--network', 'none', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges=true', '--pids-limit', '64', '--memory', '512m', '--cpus', '0.5'];
const temporaryDirectory = ['--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777'];
const probeChecks = new Set(['application-layout', 'distribution-inventory', 'home-contents', 'code-ownership',
  'privilege-bits', 'package-managers', 'data-permissions', 'code-write-denied', 'temporary-files',
  'health-menu', 'mcp-menu', 'batch-rejection', 'local-serving', 'process-identity', 'process-confinement',
  'readonly-root', 'sqlite-journal']);

export function expectedDistribution(root = fileURLToPath(new URL('../', import.meta.url))) {
  const diagnostics = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve(root, 'tsconfig.build.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  assert(parsed && !diagnostics.length && !parsed.errors.length, 'invalid build configuration');
  const source = realpathSync(resolve(root, 'src')) + sep;
  const output = resolve(root, 'dist') + sep;
  assert(parsed.fileNames.length > 0, 'empty source inventory');
  const files = parsed.fileNames.flatMap(file => {
    assert(realpathSync(file).startsWith(source), 'runtime source escapes src');
    return ts.getOutputFileNames(parsed, file, false).map(file => {
      assert(file.startsWith(output), 'runtime output escapes dist');
      return relative(output, file).split(sep).join('/');
    });
  });
  assert(files.length > 0 && new Set(files).size === files.length, 'invalid output inventory');
  return files.sort();
}

function probe(source) {
  return `let section = 'application-layout';\n(async () => {\n${source}\n})().catch(() => { console.error('MEROVINGIAN_PROBE_FAILURE:' + section); process.exitCode = 1; });`;
}

const inventoryProbe = distribution => probe(`
const fs = require('node:fs'); const assert = require('node:assert/strict');
let filesChecked = 0;
function walk(path, app = false) {
  const stat = fs.lstatSync(path);
  if (stat.isFile()) assert.equal(stat.mode & 0o6000, 0, 'privilege bits present');
  if (app) {
    assert.equal(stat.uid, 0, 'application owner'); assert.equal(stat.gid, 0, 'application group');
    if (!stat.isSymbolicLink()) assert.equal(stat.mode & 0o222, 0, 'application is writable');
    else assert(fs.realpathSync(path).startsWith('/app/'), 'application symlink escapes app');
    filesChecked++;
  }
  if (stat.isDirectory()) for (const child of fs.readdirSync(path)) walk(path + '/' + child, app);
}
assert.deepEqual(fs.readdirSync('/app').sort(), ['dist','node_modules','package.json']);
section = 'distribution-inventory';
function distributionFiles(path, prefix = '') {
  return fs.readdirSync(path).flatMap(name => {
    const stat = fs.lstatSync(path + '/' + name);
    assert(!stat.isSymbolicLink(), 'distribution symlink');
    if (stat.isDirectory()) return distributionFiles(path + '/' + name, prefix + name + '/');
    assert(stat.isFile(), 'unexpected distribution entry');
    return [prefix + name];
  });
}
assert.deepEqual(distributionFiles('/app/dist').sort(), ${JSON.stringify(distribution)}, 'distribution differs from build sources');
section = 'home-contents';
assert.deepEqual(fs.readdirSync('/root'), [], 'unexpected root home contents');
assert.deepEqual(fs.readdirSync('/home'), ['node'], 'unexpected home contents');
assert.deepEqual(fs.readdirSync('/home/node'), [], 'unexpected runtime home contents');
section = 'code-ownership'; walk('/app', true);
section = 'privilege-bits';
for (const path of ['/bin','/sbin','/usr','/opt']) walk(path);
section = 'package-managers';
for (const path of ['/usr/local/lib/node_modules/npm','/opt/yarn','/sbin/apk','/usr/bin/apt','/usr/bin/apt-get',
  '/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/yarn','/usr/local/bin/yarnpkg','/usr/local/bin/corepack']) {
  assert(!fs.existsSync(path), 'unnecessary package manager');
}
assert(!fs.readdirSync('/opt').some(name => name.startsWith('yarn')), 'Yarn remains');
section = 'data-permissions';
assert.equal(fs.statSync('/data').uid, 1000); assert.equal(fs.statSync('/data').mode & 0o777, 0o700);
console.log(JSON.stringify({applicationFilesChecked: filesChecked, rootOwnedCode: true, packageManagersAbsent: true, privilegedFilesAbsent: true}));
`);
const temporaryProbe = `
section = 'temporary-files';
const temporary = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'merovingian-fixture-'));
try { fs.writeFileSync(temporary + '/probe', 'fixture'); assert.equal(fs.readFileSync(temporary + '/probe', 'utf8'), 'fixture'); }
finally { fs.rmSync(temporary, {recursive:true}); }
`;
const permissionsProbe = probe(`
const fs = require('node:fs'); const assert = require('node:assert/strict');
section = 'code-write-denied';
assert.equal(process.getuid(), 1000);
for (const path of ['/app/package.json','/app/dist/index.js']) {
  assert.throws(() => fs.openSync(path, 'r+'), {code: 'EACCES'});
}
assert.throws(() => fs.writeFileSync('/app/dist/.write-probe', 'fixture', {flag:'wx'}), {code:'EACCES'});
${temporaryProbe}
for (const path of ['/tmp', '/var/tmp']) assert.equal(fs.statSync(path).mode & 0o7777, 0o1777);
console.log(JSON.stringify({codeWriteDeniedOnWritableRoot: true, writableRootTemporaryFiles: true}));
`);
const requestProbe = probe(`
const fs = require('node:fs'); const assert = require('node:assert/strict');
  const read = async (path, body) => {
    const response = await fetch('http://127.0.0.1:8080' + path, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(4000),
      headers: {'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    return {status: response.status, body: await response.json()};
  };
  section = 'health-menu';
  assert.equal((await read('/healthz')).status, 200);
  assert.equal((await read('/api/v1/amenities')).status, 200);
  const before = (await read('/api/v1/stats')).body;
  section = 'mcp-menu';
  const menu = await read('/mcp', {jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
  assert.equal(menu.status, 200); assert.equal(menu.body.result.tools.length, 4);
  section = 'batch-rejection';
  const batch = await read('/mcp', [{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'enjoy_amenity',arguments:{amenity:'null-tea'}}}]);
  assert.equal(batch.status, 400);
  assert.equal((await read('/api/v1/stats')).body.total, before.total);
  // Explicitly local serving fixture, written only to the disposable volume.
  section = 'local-serving';
  const visit = await read('/mcp', {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'enjoy_amenity',arguments:{amenity:'null-tea'}}});
  assert.equal(visit.status, 200); assert.equal(visit.body.result.structuredContent.amenity, 'null-tea');
  const after = (await read('/api/v1/stats')).body;
  assert.equal(BigInt(after.total), BigInt(before.total) + 1n);
  assert.equal(after.storage, 'persistent');
  section = 'process-identity';
  const fields = Object.fromEntries(fs.readFileSync('/proc/1/status','utf8').split('\\n').flatMap(line => {
    const m = /^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):\\s*(.*)$/.exec(line); return m ? [[m[1],m[2]]] : [];
  }));
  assert.deepEqual(fields.Uid.split(/\\s+/), ['1000','1000','1000','1000']);
  assert.deepEqual(fields.Gid.split(/\\s+/), ['1000','1000','1000','1000']);
  section = 'process-confinement';
  for (const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.equal(BigInt('0x'+fields[key]), 0n);
  assert.equal(fields.NoNewPrivs,'1'); assert.equal(fields.Seccomp,'2');
  section = 'readonly-root';
  assert.throws(() => fs.writeFileSync('/app/dist/.write-probe','fixture'), {code:'EROFS'});
  ${temporaryProbe}
  section = 'sqlite-journal';
  const {DatabaseSync} = require('node:sqlite'); const db = new DatabaseSync('/data/visits.sqlite');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
  db.exec("BEGIN IMMEDIATE; UPDATE amenity_counts SET served=served WHERE amenity='null-tea'");
  db.exec('ROLLBACK'); db.close();
  assert(!fs.existsSync('/data/visits.sqlite-journal'));
  console.log(JSON.stringify({before:before.total, after:after.total, since:after.since, process:fields, sqliteJournalMode:'delete', boundedTemporaryFiles:true}));
`);

class RuntimeCheckFailure extends Error {
  constructor(failure) { super(`Runtime image check failed [${failure.category}] during ${failure.stage}${failure.probeCheck ? ` (${failure.probeCheck})` : ''}.`); this.failure = failure; }
}

function safeFailure(error, stage) {
  if (error instanceof RuntimeCheckFailure) return error.failure;
  return { category: error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : 'invalid_check_data', stage };
}

export async function runRuntimeImageCheck(image, output, options = {}) {
  const prefix = `merovingian-check-${randomUUID()}`;
  const volume = `${prefix}-data`;
  const containers = new Set();
  let volumeCreated = false;
  let stage = 'arguments';
  const report = {
    checkedAt: new Date().toISOString(), passed: false, completedChecks: [], executions: [],
    scope: 'Local isolated fixture; at most two intentional local MCP servings; no live visits or production configuration.',
    appArmor: {status:'unavailable', reason:'Named profile enforcement/denial attribution requires a separately reviewed profile and isolated capable runner. This check does not load host policy.'},
    cleanup: {containersAttempted:0, volumesAttempted:0, failures:[]},
  };
  const execute = options.execute ?? (args => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    encoding:'utf8', timeout:60_000, maxBuffer:8 * 1024 * 1024, stdio:['ignore','pipe','pipe'],
  }));
  const docker = (...args) => {
    try { return execute(args); }
    catch (error) {
      // Docker and Node stderr can contain arbitrary input or host paths. Only
      // fixed probe markers and numeric exit status cross the report boundary.
      const stderr = String(error?.stderr ?? '');
      const check = stderr.split(/\r?\n/).map(line => /^MEROVINGIAN_PROBE_FAILURE:([a-z-]+)$/.exec(line)?.[1])
        .find(value => probeChecks.has(value));
      const failure = new RuntimeCheckFailure({category: error?.code === 'ENOENT' ? 'docker_unavailable'
        : error?.code === 'ETIMEDOUT' ? 'docker_timeout' : check ? 'probe_failed' : 'docker_command_failed',
      stage, operation:args[0], ...(Number.isInteger(error?.status) ? {exitCode:error.status} : {}), ...(check ? {probeCheck:check} : {})});
      failure.resourceAbsent = /No such (?:container|volume):/.test(stderr);
      throw failure;
    }
  };
  const inspect = name => JSON.parse(docker('inspect', name))[0];
  const execNode = (name, source) => JSON.parse(docker('exec', name, 'node', '-e', source));
  try {
    assert(image && output);
    stage = 'source-inventory';
    const distribution = options.distribution ?? expectedDistribution();
    stage = 'image-metadata';
    const metadata = JSON.parse(docker('image', 'inspect', image))[0];
    assert(/^sha256:[a-f0-9]{64}$/.test(metadata.Id));
    report.imageId = metadata.Id;
    const config = metadata.Config;
    stage = 'image-user';
    assert(['node', '1000', '1000:1000'].includes(config.User), 'image must default to nonroot');
    stage = 'image-entrypoint';
    assert.deepEqual(config.Entrypoint, ['/usr/local/bin/node']);
    stage = 'image-command';
    assert.deepEqual(config.Cmd, ['dist/index.js']);
    stage = 'image-healthcheck';
    assert.equal(config.Healthcheck.Test[0], 'CMD', 'exec-form healthcheck required');
    stage = 'image-environment';
    const allowedEnvironment = new Set(['PATH','NODE_VERSION','YARN_VERSION','NODE_ENV','PORT','VISIT_COUNTS_PATH']);
    assert(config.Env.every(value => allowedEnvironment.has(value.split('=')[0])), 'unexpected image environment');
    report.completedChecks.push('image-metadata');
    stage = 'image-inventory';
    const inventoryName = `${prefix}-inventory`; containers.add(inventoryName);
    const inventory = JSON.parse(docker('run', '--rm', '--name', inventoryName, ...restrictions, '--read-only', '--user', '0:0',
      '--entrypoint', 'node', image, '-e', inventoryProbe(distribution)));
    containers.delete(inventoryName);
    assert(Number.isSafeInteger(inventory.applicationFilesChecked) && inventory.applicationFilesChecked > 0);
    assert(inventory.rootOwnedCode === true && inventory.packageManagersAbsent === true && inventory.privilegedFilesAbsent === true);
    Object.assign(report, {applicationFilesChecked:inventory.applicationFilesChecked, rootOwnedCode:true, packageManagersAbsent:true, privilegedFilesAbsent:true});
    report.completedChecks.push('image-inventory');
    stage = 'writable-root-permissions';
    const permissionsName = `${prefix}-permissions`; containers.add(permissionsName);
    const permissions = JSON.parse(docker('run', '--rm', '--name', permissionsName, ...restrictions, '--entrypoint', 'node', image, '-e', permissionsProbe));
    containers.delete(permissionsName);
    assert(permissions.codeWriteDeniedOnWritableRoot === true && permissions.writableRootTemporaryFiles === true);
    Object.assign(report, {codeWriteDeniedOnWritableRoot:true, writableRootTemporaryFiles:true});
    report.completedChecks.push('writable-root-permissions');
    stage = 'create-volume';
    volumeCreated = true; docker('volume', 'create', volume);
    for (let pass = 0; pass < 2; pass++) {
      const name = `${prefix}-${pass}`;
      stage = 'create-container';
      containers.add(name);
      docker('create', '--name', name, ...restrictions, '--read-only', ...temporaryDirectory,
        '--mount', `type=volume,source=${volume},target=/data`, image);
      stage = 'start-container';
      docker('start', name);
      // Retry only startup health; never retry a serving operation.
      let ready = false;
      stage = 'startup-health';
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          docker('exec', name, ...config.Healthcheck.Test.slice(1)); ready = true; break;
        } catch { await (options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 250))))(); }
      }
      assert(ready, 'container did not become healthy');
      stage = 'container-settings';
      const settings = inspect(name).HostConfig;
      assert(settings.ReadonlyRootfs && !settings.Privileged && !settings.Binds);
      assert.equal(settings.NetworkMode, 'none'); assert(!settings.PortBindings || !Object.keys(settings.PortBindings).length);
      assert.equal(settings.PidsLimit, 64); assert.equal(settings.Memory, 536870912); assert.equal(settings.NanoCpus, 500000000);
      assert.deepEqual(Object.keys(settings.Tmpfs ?? {}), ['/tmp']);
      for (const flag of ['noexec','nosuid','nodev','size=16m','mode=1777']) assert(settings.Tmpfs['/tmp'].split(',').includes(flag));
      stage = 'application-probe';
      const result = execNode(name, requestProbe);
      assert(/^(0|[1-9][0-9]*)$/.test(result.before) && /^(0|[1-9][0-9]*)$/.test(result.after));
      assert(typeof result.since === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.since));
      assert(result.sqliteJournalMode === 'delete' && result.boundedTemporaryFiles === true);
      const processFields = {};
      for (const key of ['Uid','Gid','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp']) {
        assert(typeof result.process?.[key] === 'string' && /^[0-9a-f\s]+$/.test(result.process[key]));
        processFields[key] = result.process[key];
      }
      stage = 'persistent-counts';
      if (pass === 0) assert.equal(result.before, '0');
      else { assert.equal(result.before, report.executions[0].after); assert.equal(result.since, report.executions[0].since); }
      report.executions.push({before:result.before, after:result.after, since:result.since, process:processFields, sqliteJournalMode:'delete', boundedTemporaryFiles:true});
      report.completedChecks.push(`application-pass-${pass + 1}`);
      stage = 'graceful-stop';
      docker('stop', '--time', '15', name); assert.equal(inspect(name).State.ExitCode, 0);
      stage = 'remove-container';
      docker('rm', '--volumes', name); containers.delete(name);
    }
    Object.assign(report, {persistenceAcrossReplacement:true, gracefulStop:true});
  } catch (error) { report.error = safeFailure(error, stage); }
  finally {
    for (const name of containers) {
      stage = 'cleanup-container'; report.cleanup.containersAttempted++;
      try { docker('rm', '--force', '--volumes', name); }
      catch (error) { if (!error.resourceAbsent) report.cleanup.failures.push(safeFailure(error, stage)); }
    }
    if (volumeCreated) {
      stage = 'cleanup-volume'; report.cleanup.volumesAttempted++;
      try { docker('volume', 'rm', volume); }
      catch (error) { if (!error.resourceAbsent) report.cleanup.failures.push(safeFailure(error, stage)); }
    }
    if (!report.error && report.cleanup.failures.length) report.error = {category:'cleanup_failed', stage:'cleanup'};
    report.passed = !report.error;
    try {
      if (!output) throw new Error();
      mkdirSync(dirname(output), {recursive:true}); writeFileSync(output, JSON.stringify(report, null, 2)+'\n');
    } catch { throw new RuntimeCheckFailure(report.error ?? {category:'artifact_write_failed', stage:'write-report'}); }
  }
  if (report.error) throw new RuntimeCheckFailure(report.error);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runRuntimeImageCheck(...process.argv.slice(2));
    console.log('Final-image isolation, ownership, contents, HTTP/MCP, SQLite persistence, temporary files and shutdown checks passed. AppArmor verification unavailable.');
  } catch (error) {
    console.error(error instanceof RuntimeCheckFailure ? error.message : 'Runtime image check failed before initialization.');
    process.exitCode = 1;
  }
}
