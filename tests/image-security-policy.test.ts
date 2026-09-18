import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateImageScan, imagePolicyFailure } from '../scripts/image-security-policy.js';

const now = Date.parse('2026-09-18T18:00:00Z');
const scanner = {Version:'0.74.0',VulnerabilityDB:{Version:2,UpdatedAt:'2026-09-18T07:00:00Z',NextUpdate:'2026-09-19T07:00:00Z'}};
const finding = {VulnerabilityID:'CVE-fixture',PkgName:'fixture',InstalledVersion:'1',Severity:'HIGH',PkgPath:'app/node_modules/fixture/package.json'};
const scan = (vulnerabilities: unknown[] = [finding]) => ({SchemaVersion:2,ArtifactType:'container_image',Metadata:{ImageID:`sha256:${'a'.repeat(64)}`,OS:{Family:'alpine',Name:'3.24.2'}},Results:[
  {Target:'alpine',Class:'os-pkgs',Type:'alpine',Packages:[{Name:'musl',Version:'1.2.6'}]},
  {Target:'Node.js',Class:'lang-pkgs',Type:'node-pkg',Packages:[{Name:'fixture',Version:'1'}],Vulnerabilities:vulnerabilities},
]});
const exception = {advisory:'CVE-fixture',package:'fixture',version:'1',target:'Node.js',path:finding.PkgPath,
  rationale:'Fixture vendor evidence confirms the affected component is not shipped.',evidence:'https://example.com/vendor-advisory',
  issue:'ENG-1041',reviewedAt:'2026-09-18T08:00:00Z',expiresAt:'2026-10-18T08:00:00Z'};

test('image policy blocks severe or fixable advisories and keeps unfixed low records visible', () => {
  const result = evaluateImageScan(scan([finding,{...finding,VulnerabilityID:'low-fix',Severity:'LOW',FixedVersion:'2'},{...finding,VulnerabilityID:'low-unfixed',Severity:'LOW'}]),scanner,[],now);
  assert.equal(result.passed,false); assert.equal(result.blocked.length,2); assert.equal(result.reported.length,1);
  assert.equal(evaluateImageScan(scan([]),scanner,[],now).passed,true);
});

test('image exceptions bind advisory, package, installed version, target and path exactly', () => {
  assert.equal(evaluateImageScan(scan(),scanner,[exception],now).accepted.length,1);
  for (const field of ['advisory','package','version','target','path'] as const) {
    assert.throws(() => evaluateImageScan(scan(),scanner,[{...exception,[field]:'different'}],now), /Unused exception/);
  }
  assert.throws(() => evaluateImageScan(scan(),scanner,[exception,exception],now), /Duplicate/);
});

test('image policy refuses incomplete scans, stale databases and expired or excessive exceptions', () => {
  assert.throws(() => evaluateImageScan({},scanner,[],now));
  assert.throws(() => evaluateImageScan({...scan(),Results:[]},scanner,[],now));
  assert.throws(() => evaluateImageScan({...scan(),Results:[scan().Results[0]]},scanner,[],now), /coverage/);
  assert.throws(() => evaluateImageScan({...scan(),Results:scan().Results.map(row => ({...row,Packages:[]}))},scanner,[],now), /coverage/);
  assert.throws(() => evaluateImageScan({...scan(),Results:scan().Results.map(row => ({...row,Secrets:[{RuleID:'fixture'}]}))},scanner,[],now), /credentials/);
  assert.throws(() => evaluateImageScan(scan(),{...scanner,VulnerabilityDB:{...scanner.VulnerabilityDB,UpdatedAt:'2026-09-15T07:00:00Z'}},[],now), /stale/);
  assert.throws(() => evaluateImageScan(scan(),scanner,[{...exception,expiresAt:'2026-09-18T17:00:00Z'}],now), /expired/);
  assert.throws(() => evaluateImageScan(scan(),scanner,[{...exception,expiresAt:'2027-09-18T17:00:00Z'}],now), /window/);
});

test('policy failures retain specific safe categories without exposing arbitrary evidence', () => {
  const secret = '/private/operator/secret-token';
  const cases: [unknown, unknown, unknown, string][] = [
    [{...scan(),Metadata:{...scan().Metadata,OS:{...scan().Metadata.OS,EOSL:true}}}, scanner, [], 'unsupported_os'],
    [{...scan(),Results:scan().Results.map(row => ({...row,Secrets:[{Match:secret}]}))}, scanner, [], 'detected_credentials'],
    [scan(), {...scanner,VulnerabilityDB:{...scanner.VulnerabilityDB,UpdatedAt:'2026-09-15T07:00:00Z'}}, [], 'stale_database'],
    [scan(), scanner, [{...exception,advisory:'unused'}], 'unused_exception'],
    [scan(), scanner, [{...exception,evidence:secret}], 'invalid_exceptions_schema'],
    [{private:secret}, scanner, [], 'invalid_scan_schema'],
    [scan(), {private:secret}, [], 'invalid_scanner_schema'],
  ];
  for (const [scanValue, scannerValue, exceptionsValue, code] of cases) {
    let failure;
    try { evaluateImageScan(scanValue, scannerValue, exceptionsValue, now); }
    catch (error) { failure = imagePolicyFailure(error, now); }
    assert.equal(failure?.error.code, code);
    assert.equal(failure?.passed, false);
    assert.ok(!JSON.stringify(failure).includes(secret));
  }
  assert.equal(imagePolicyFailure(new Error(secret), now).error.code, 'unexpected_failure');
});

test('policy CLI always writes categorized failure evidence for unreadable or malformed input', t => {
  const directory = mkdtempSync(join(tmpdir(), 'merovingian-policy-check-'));
  t.after(() => rmSync(directory, {recursive:true,force:true}));
  const evidence = join(directory, 'secret-token.json');
  const output = join(directory, 'nested', 'policy.json');
  const run = () => spawnSync(process.execPath, ['--import','tsx',fileURLToPath(new URL('../scripts/image-security-policy.ts', import.meta.url)),
    evidence,evidence,evidence,output], {encoding:'utf8'});
  for (const malformed of [undefined, 'private-secret-token {not-json']) {
    if (malformed) writeFileSync(evidence, malformed);
    const result = run();
    assert.equal(result.status, 1);
    const raw = readFileSync(output, 'utf8'), report = JSON.parse(raw);
    assert.equal(report.error.code, malformed ? 'invalid_scan_json' : 'unreadable_scan');
    assert.match(result.stderr, new RegExp(report.error.code));
    for (const text of [raw,result.stdout,result.stderr]) {
      assert.doesNotMatch(text, /secret-token|not-json/);
      assert.ok(!text.includes(directory));
    }
  }
});
