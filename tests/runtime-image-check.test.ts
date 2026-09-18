import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import test, { type TestContext } from 'node:test';
import { expectedDistribution, runRuntimeImageCheck } from '../scripts/check-runtime-image.mjs';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merovingian-runtime-check-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  return {directory, output:join(directory, 'runtime.json')};
}

function dockerFixture(fault: (args: string[]) => void = () => {}) {
  const calls: string[][] = [];
  let pass = -1;
  const execute = (args: string[]): string => {
    calls.push(args); fault(args);
    if (args[0] === 'image') return JSON.stringify([{Id:`sha256:${'a'.repeat(64)}`, Config:{
      User:'1000:1000', Entrypoint:['/usr/local/bin/node'], Cmd:['dist/index.js'], Env:['NODE_ENV=production'],
      Healthcheck:{Test:['CMD', '/usr/local/bin/node', '-e', 'process.exit(0)']},
    }}]);
    if (args[0] === 'run') return JSON.stringify(args.includes('--read-only')
      ? {applicationFilesChecked:12, rootOwnedCode:true, packageManagersAbsent:true, privilegedFilesAbsent:true}
      : {codeWriteDeniedOnWritableRoot:true, writableRootTemporaryFiles:true});
    if (args[0] === 'create') { pass++; return 'fixture-container'; }
    if (args[0] === 'inspect') return JSON.stringify([{State:{ExitCode:0}, HostConfig:{
      ReadonlyRootfs:true, Privileged:false, Binds:null, NetworkMode:'none', PidsLimit:64,
      Memory:536870912, NanoCpus:500000000, Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=16m,mode=1777'},
    }}]);
    if (args[0] === 'exec' && args[2] === 'node') return JSON.stringify({before:String(pass), after:String(pass + 1),
      since:'2026-09-18T18:00:00.000Z', sqliteJournalMode:'delete', boundedTemporaryFiles:true,
      process:{Uid:'1000 1000 1000 1000', Gid:'1000 1000 1000 1000', CapInh:'0', CapPrm:'0', CapEff:'0', CapBnd:'0', CapAmb:'0', NoNewPrivs:'1', Seccomp:'2'}});
    return '';
  };
  return {calls, execute};
}

test('runtime report survives an initial Docker failure without copying stderr or host paths', async t => {
  const {directory, output} = fixture(t);
  const docker = dockerFixture(() => { throw Object.assign(new Error(`private failure ${directory}`), {stderr:'secret-token and /private/operator/path', status:17}); });
  await assert.rejects(runRuntimeImageCheck('fixture', output, {execute:docker.execute, distribution:['index.js']}), /docker_command_failed.*image-metadata/);
  const raw = readFileSync(output, 'utf8'), report = JSON.parse(raw);
  assert.equal(report.passed, false);
  assert.deepEqual(report.completedChecks, []);
  assert.equal(report.error.exitCode, 17);
  assert.doesNotMatch(raw, /secret-token|private\/operator|private failure/);
  assert.ok(!raw.includes(directory));
});

test('runtime probe diagnostics preserve the failed check and cleanup attempts the volume after container failure', async t => {
  const {output} = fixture(t);
  const docker = dockerFixture(args => {
    if (args[0] === 'exec' && args[2] === 'node') throw Object.assign(new Error('raw secret'), {
      stderr:'secret-token\nMEROVINGIAN_PROBE_FAILURE:sqlite-journal\n/private/operator/path', status:1,
    });
    if (args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm')) throw Object.assign(new Error('cleanup secret'), {status:2});
  });
  await assert.rejects(runRuntimeImageCheck('fixture', output, {execute:docker.execute, distribution:['index.js']}), /probe_failed.*application-probe.*sqlite-journal/);
  const raw = readFileSync(output, 'utf8'), report = JSON.parse(raw);
  assert.equal(report.error.probeCheck, 'sqlite-journal');
  assert.equal(report.error.exitCode, 1, 'cleanup cannot replace the original failure');
  assert.deepEqual(report.completedChecks, ['image-metadata','image-inventory','writable-root-permissions']);
  assert.equal(report.cleanup.containersAttempted, 1);
  assert.equal(report.cleanup.volumesAttempted, 1);
  // The helper embeds JavaScript in Docker arguments; checking only the outer
  // .mjs file cannot detect syntax errors in those generated programs.
  for (const args of docker.calls) {
    const expression = args.indexOf('-e');
    if (expression !== -1) assert.doesNotThrow(() => new Script(args[expression + 1]!));
  }
  assert.equal(report.cleanup.failures.length, 2);
  assert.equal(docker.calls.at(-1)?.[0], 'volume');
  assert.doesNotMatch(raw, /secret-token|private\/operator|cleanup secret/);
});

test('only known probe identifiers enter runtime diagnostics', async t => {
  const {output} = fixture(t);
  const docker = dockerFixture(args => {
    if (args[0] === 'run') throw Object.assign(new Error('raw secret'), {stderr:'MEROVINGIAN_PROBE_FAILURE:secret-token', status:1});
  });
  await assert.rejects(runRuntimeImageCheck('fixture', output, {execute:docker.execute, distribution:['index.js']}));
  const raw = readFileSync(output, 'utf8');
  assert.equal(JSON.parse(raw).error.category, 'docker_command_failed');
  assert.doesNotMatch(raw, /secret-token/);
});

test('runtime success reports both passes and temporary files; cleanup failure still blocks acceptance', async t => {
  const {output} = fixture(t);
  const docker = dockerFixture();
  const report = await runRuntimeImageCheck('fixture', output, {execute:docker.execute, distribution:['index.js']});
  assert.equal(report.passed, true);
  assert.equal(report.executions.length, 2);
  assert.equal(report.writableRootTemporaryFiles, true);
  assert.equal(report.cleanup.volumesAttempted, 1);
  assert.ok(docker.calls.filter(args => args[0] === 'create').every(args => args.includes('/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777')));
  const failing = dockerFixture(args => { if (args[0] === 'volume' && args[1] === 'rm') throw new Error('private cleanup failure'); });
  await assert.rejects(runRuntimeImageCheck('fixture', output, {execute:failing.execute, distribution:['index.js']}), /cleanup_failed/);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).passed, false);
});

test('distribution inventory follows TypeScript sources and options while rejecting operator tooling outside src', t => {
  const {directory} = fixture(t);
  mkdirSync(join(directory, 'src', 'nested'), {recursive:true});
  writeFileSync(join(directory, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(directory, 'src', 'operator.ts'), 'export {};\n');
  writeFileSync(join(directory, 'src', 'nested', 'new-module.ts'), 'export {};\n');
  const config = {compilerOptions:{rootDir:'src',outDir:'dist',sourceMap:true},include:['src/**/*.ts']};
  writeFileSync(join(directory, 'tsconfig.build.json'), JSON.stringify(config));
  assert.deepEqual(expectedDistribution(directory), ['index.js','index.js.map','nested/new-module.js','nested/new-module.js.map','operator.js','operator.js.map']);
  config.compilerOptions.sourceMap = false;
  writeFileSync(join(directory, 'tsconfig.build.json'), JSON.stringify(config));
  assert.deepEqual(expectedDistribution(directory), ['index.js','nested/new-module.js','operator.js']);
  mkdirSync(join(directory, 'scripts')); writeFileSync(join(directory, 'scripts', 'operator-signer.ts'), 'export {};\n');
  config.include.push('scripts/*.ts');
  writeFileSync(join(directory, 'tsconfig.build.json'), JSON.stringify(config));
  assert.throws(() => expectedDistribution(directory), /runtime source escapes src/);
});

test('always-run workflow evidence records dependency or build failure before runtime checks exist', t => {
  const {directory} = fixture(t);
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const section = workflow.split('      - name: Record image job outcome\n')[1]!.split('      - name: Upload sanitized image evidence')[0]!;
  assert.match(section, /if: always\(\)/);
  const shell = section.split('        run: |\n')[1]!.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  for (const failed of ['dependencies','build']) {
    const stages = ['checkout','node','dependencies','build','runtime','scan'];
    const env = Object.fromEntries(stages.map((stage, index) => [`IMAGE_${stage.toUpperCase()}`, index < stages.indexOf(failed) ? 'success' : stage === failed ? 'failure' : 'skipped']));
    execFileSync('bash', ['-c', shell], {cwd:directory,env:{...process.env,...env},stdio:'pipe'});
    const report = JSON.parse(readFileSync(join(directory, '.local/image-security/job-status.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.stageOutcomes[failed], 'failure');
    assert.equal(report.stageOutcomes.runtime, 'skipped');
  }
});
