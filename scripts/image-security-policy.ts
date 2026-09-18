import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const exceptionSchema = z.object({
  advisory: z.string().min(1), package: z.string().min(1), version: z.string().min(1),
  target: z.string().min(1), path: z.string(),
  rationale: z.string().min(30), evidence: z.url().startsWith('https://'),
  issue: z.string().regex(/^ENG-\d+$/), reviewedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict();
const vulnerabilitySchema = z.object({
  VulnerabilityID: z.string().min(1), PkgName: z.string().min(1), InstalledVersion: z.string().min(1),
  PkgPath: z.string().optional(), FixedVersion: z.string().optional(),
  Severity: z.enum(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
});
const scanSchema = z.object({
  SchemaVersion: z.literal(2), ArtifactType: z.literal('container_image'),
  Metadata: z.object({ ImageID: z.string().regex(/^sha256:[a-f0-9]{64}$/), OS: z.object({ Family: z.string().min(1), Name: z.string().min(1), EOSL: z.boolean().optional() }) }),
  Results: z.array(z.object({Target: z.string().min(1), Class: z.string(), Type: z.string(),
    Packages: z.array(z.object({Name:z.string().min(1),Version:z.string().min(1)})).optional(),
    Vulnerabilities: z.array(vulnerabilitySchema).optional(), Secrets: z.array(z.unknown()).optional()})).min(1),
});
const scannerSchema = z.object({
  Version: z.literal('0.74.0'),
  VulnerabilityDB: z.object({Version: z.literal(2), UpdatedAt: z.iso.datetime({offset:true}), NextUpdate: z.iso.datetime({offset:true})}),
});

export function evaluateImageScan(rawScan: unknown, rawScanner: unknown, rawExceptions: unknown, now = Date.now()) {
  const scan = scanSchema.parse(rawScan);
  const scanner = scannerSchema.parse(rawScanner);
  const exceptions = z.array(exceptionSchema).parse(rawExceptions);
  const updated = Date.parse(scanner.VulnerabilityDB.UpdatedAt);
  if (updated > now + 5 * 60_000 || now - updated > 48 * 60 * 60_000) throw new Error('Vulnerability database is stale or future-dated');
  if (scan.Metadata.OS.EOSL) throw new Error('Unsupported image OS release');
  if (!scan.Results.some(result => result.Class === 'os-pkgs' && result.Packages?.length)
    || !scan.Results.some(result => result.Class === 'lang-pkgs' && result.Type === 'node-pkg' && result.Packages?.length)) {
    throw new Error('Expected OS and application dependency scan coverage');
  }
  if (scan.Results.some(result => result.Secrets?.length)) throw new Error('Possible credentials found in candidate image');
  const key = (advisory: string, pkg: string, version: string, target: string, path: string) => JSON.stringify([advisory,pkg,version,target,path]);
  const allowed = new Map<string, z.infer<typeof exceptionSchema>>();
  for (const item of exceptions) {
    const review = Date.parse(item.reviewedAt), expiry = Date.parse(item.expiresAt);
    if (review > now || expiry <= now || expiry <= review || expiry - review > 90 * 24 * 60 * 60_000) throw new Error('Exception is expired or outside its review window');
    const id = key(item.advisory,item.package,item.version,item.target,item.path);
    if (allowed.has(id)) throw new Error('Duplicate advisory exception');
    allowed.set(id,item);
  }
  const blocked = [], accepted = [], reported = [];
  const used = new Set<string>();
  for (const result of scan.Results) for (const finding of result.Vulnerabilities ?? []) {
    const row = {advisory:finding.VulnerabilityID, package:finding.PkgName, version:finding.InstalledVersion,
      target:result.Target, path:finding.PkgPath ?? '', severity:finding.Severity, fixedVersion:finding.FixedVersion ?? ''};
    const id = key(row.advisory,row.package,row.version,row.target,row.path);
    // Every fixable record and every high/critical record gates the candidate.
    if (row.fixedVersion.trim() || ['HIGH','CRITICAL'].includes(row.severity)) {
      const exception = allowed.get(id);
      if (exception) { accepted.push({...row,issue:exception.issue,expiresAt:exception.expiresAt}); used.add(id); }
      else blocked.push(row);
    } else reported.push(row);
  }
  if ([...allowed.keys()].some(id => !used.has(id))) throw new Error('Unused exception must be removed or reviewed');
  return {checkedAt:new Date(now).toISOString(), imageId:scan.Metadata.ImageID,
    scannerVersion:scanner.Version, databaseUpdatedAt:scanner.VulnerabilityDB.UpdatedAt,
    passed:blocked.length === 0, blocked, accepted, reported};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [scan, scanner, exceptions, output] = process.argv.slice(2);
    if (!scan || !scanner || !exceptions || !output) throw new Error('Expected scan, scanner metadata, exceptions, and output');
    const result = evaluateImageScan(...[scan, scanner, exceptions].map(path => JSON.parse(readFileSync(path,'utf8'))) as [unknown,unknown,unknown]);
    writeFileSync(output, JSON.stringify(result,null,2)+'\n');
    console.log(`Image advisory policy: ${result.blocked.length} blocked, ${result.accepted.length} reviewed exceptions, ${result.reported.length} nonblocking records.`);
    if (!result.passed) process.exitCode = 1;
  } catch { console.error('Image advisory policy failed: invalid/missing evidence, stale database or invalid exception.'); process.exitCode = 1; }
}
