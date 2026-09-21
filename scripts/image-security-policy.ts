import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

const policyFailures = {
  invalid_arguments: 'Expected scan, scanner metadata, exceptions, and output arguments.',
  unreadable_scan: 'Scan evidence could not be read.',
  unreadable_scanner: 'Scanner metadata could not be read.',
  unreadable_exceptions: 'Advisory exceptions could not be read.',
  invalid_scan_json: 'Scan evidence is not valid JSON.',
  invalid_scanner_json: 'Scanner metadata is not valid JSON.',
  invalid_exceptions_json: 'Advisory exceptions are not valid JSON.',
  invalid_scan_schema: 'Scan evidence does not match the required schema.',
  invalid_scanner_schema: 'Scanner metadata does not match the pinned version and required schema.',
  invalid_exceptions_schema: 'Advisory exceptions do not match the required schema.',
  stale_database: 'Vulnerability database is stale or future-dated.',
  unsupported_os: 'Unsupported image OS release.',
  missing_coverage: 'Expected OS and application dependency scan coverage.',
  detected_credentials: 'Possible credentials found in candidate image.',
  invalid_exception_window: 'Exception is expired or outside its review window.',
  duplicate_exception: 'Duplicate advisory exception.',
  unused_exception: 'Unused exception must be removed or reviewed.',
  unexpected_failure: 'Unexpected image policy evaluation failure.',
  artifact_write_failed: 'Image policy evidence could not be written.',
} as const;
type PolicyFailureCode = keyof typeof policyFailures;

class ImagePolicyError extends Error {
  constructor(readonly code: PolicyFailureCode) { super(policyFailures[code]); }
}
function fail(code: PolicyFailureCode): never { throw new ImagePolicyError(code); }
function parse<T>(schema: z.ZodType<T>, value: unknown, code: PolicyFailureCode): T {
  const result = schema.safeParse(value);
  if (!result.success) return fail(code);
  return result.data;
}

export function imagePolicyFailure(error: unknown, now = Date.now()) {
  const code = error instanceof ImagePolicyError ? error.code : 'unexpected_failure';
  return { checkedAt: new Date(now).toISOString(), passed: false as const, error: { code, message: policyFailures[code] } };
}

export function evaluateImageScan(rawScan: unknown, rawScanner: unknown, rawExceptions: unknown, now = Date.now()) {
  const scan = parse(scanSchema, rawScan, 'invalid_scan_schema');
  const scanner = parse(scannerSchema, rawScanner, 'invalid_scanner_schema');
  const exceptions = parse(z.array(exceptionSchema), rawExceptions, 'invalid_exceptions_schema');
  const updated = Date.parse(scanner.VulnerabilityDB.UpdatedAt);
  if (updated > now + 5 * 60_000 || now - updated > 48 * 60 * 60_000) fail('stale_database');
  if (scan.Metadata.OS.EOSL) fail('unsupported_os');
  if (!scan.Results.some(result => result.Class === 'os-pkgs' && result.Packages?.length)
    || !scan.Results.some(result => result.Class === 'lang-pkgs' && result.Type === 'node-pkg' && result.Packages?.length)) {
    fail('missing_coverage');
  }
  if (scan.Results.some(result => result.Secrets?.length)) fail('detected_credentials');
  const key = (advisory: string, pkg: string, version: string, target: string, path: string) => JSON.stringify([advisory,pkg,version,target,path]);
  const allowed = new Map<string, z.infer<typeof exceptionSchema>>();
  for (const item of exceptions) {
    const review = Date.parse(item.reviewedAt), expiry = Date.parse(item.expiresAt);
    if (review > now || expiry <= now || expiry <= review || expiry - review > 90 * 24 * 60 * 60_000) fail('invalid_exception_window');
    const id = key(item.advisory,item.package,item.version,item.target,item.path);
    if (allowed.has(id)) fail('duplicate_exception');
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
  if ([...allowed.keys()].some(id => !used.has(id))) fail('unused_exception');
  return {checkedAt:new Date(now).toISOString(), imageId:scan.Metadata.ImageID,
    scannerVersion:scanner.Version, databaseUpdatedAt:scanner.VulnerabilityDB.UpdatedAt,
    passed:blocked.length === 0, blocked, accepted, reported};
}

export function readImagePolicy(scan: string, scanner: string, exceptions: string, now = Date.now()) {
  try {
    const read = (path: string, kind: 'scan' | 'scanner' | 'exceptions') => {
      let text: string;
      try { text = readFileSync(path, 'utf8'); } catch { return fail(`unreadable_${kind}`); }
      try { return JSON.parse(text) as unknown; } catch { return fail(`invalid_${kind}_json`); }
    };
    return evaluateImageScan(read(scan, 'scan'), read(scanner, 'scanner'), read(exceptions, 'exceptions'), now);
  } catch (error) { return imagePolicyFailure(error, now); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scan, scanner, exceptions, output] = process.argv.slice(2);
  try {
    if (!scan || !scanner || !exceptions || !output) fail('invalid_arguments');
    const result = readImagePolicy(scan, scanner, exceptions);
    mkdirSync(dirname(output), {recursive:true});
    writeFileSync(output, JSON.stringify(result,null,2)+'\n');
    if ('error' in result) console.error(`Image advisory policy failed [${result.error.code}]: ${result.error.message}`);
    else console.log(`Image advisory policy: ${result.blocked.length} blocked, ${result.accepted.length} reviewed exceptions, ${result.reported.length} nonblocking records.`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const failure = imagePolicyFailure(error instanceof ImagePolicyError ? error : new ImagePolicyError('artifact_write_failed'));
    console.error(`Image advisory policy failed [${failure.error.code}]: ${failure.error.message}`);
    process.exitCode = 1;
  }
}
