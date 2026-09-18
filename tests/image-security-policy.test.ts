import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateImageScan } from '../scripts/image-security-policy.js';

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
