import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getAmenities, type AmenityId } from '../src/amenities.js';
import type { Network } from '../src/config.js';
import type { VisitCounts } from '../src/counts.js';
import { APP_VERSION, MCP_SERVER_INFO } from '../src/identity.js';
import { createSmokeFetch, SMOKE_READ_PATHS } from './smoke-request.js';

const USAGE = 'Usage: npm run smoke -- ORIGIN [CONTRIBUTION_HASH] [--mainnet] [--serve] [--live-serve-authorization REFERENCE] [--expect-unchanged-counts] [--timeout-ms 1..60000]';
const DEFAULT_TIMEOUT_MS = 15_000;
const FORM_VISIT = { amenity: 'null-tea', preference: 'porcelain' } as const;
const AMENITIES = getAmenities().map(amenity => amenity.id);
const SERVINGS = Object.freeze(Object.fromEntries(AMENITIES.map(amenity =>
  [amenity, 2 + (amenity === FORM_VISIT.amenity ? 1 : 0)],
)) as Record<AmenityId, number>);

export interface SmokeOptions {
  origin: string;
  network: Network;
  serve: boolean;
  timeoutMs: number;
  contributionHash?: string;
  liveServeAuthorization?: string;
  expectUnchangedCounts?: boolean;
}

function validateOptions(options: SmokeOptions): void {
  let url: URL;
  try { url = new URL(options.origin); } catch { throw new Error(USAGE); }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== options.origin || (url.protocol !== 'https:' && !localHttp)
    || !['testnet', 'mainnet'].includes(options.network) || typeof options.serve !== 'boolean'
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000
    || (options.contributionHash !== undefined && !/^[A-Fa-f0-9]{64}$/.test(options.contributionHash))) {
    throw new Error(USAGE);
  }
  if (options.expectUnchangedCounts && options.serve) throw new Error('--expect-unchanged-counts requires read-only mode');
  if (options.liveServeAuthorization !== undefined && (!options.serve || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(options.liveServeAuthorization))) {
    throw new Error('--live-serve-authorization requires --serve and a short authorization reference (letters, digits, dots, underscores, or hyphens)');
  }
  if (options.serve && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !options.liveServeAuthorization) {
    throw new Error('Live --serve requires --live-serve-authorization REFERENCE for an explicitly authorized target and serving budget');
  }
}

export function parseSmokeArgs(args: string[]): SmokeOptions {
  const positional: string[] = [];
  const flags = new Set<string>();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let liveServeAuthorization: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!['--mainnet', '--serve', '--timeout-ms', '--live-serve-authorization', '--expect-unchanged-counts'].includes(arg) || flags.has(arg)) throw new Error(USAGE);
    flags.add(arg);
    if (arg === '--timeout-ms') {
      const value = args[++index] || '';
      if (!/^[0-9]+$/.test(value)) throw new Error(USAGE);
      timeoutMs = Number(value);
    }
    if (arg === '--live-serve-authorization') liveServeAuthorization = args[++index] || '';
  }
  if (positional.length < 1 || positional.length > 2) throw new Error(USAGE);
  const options: SmokeOptions = {
    origin: positional[0], contributionHash: positional[1],
    network: flags.has('--mainnet') ? 'mainnet' : 'testnet', serve: flags.has('--serve'), timeoutMs,
    liveServeAuthorization, expectUnchangedCounts: flags.has('--expect-unchanged-counts'),
  };
  validateOptions(options);
  return options;
}

export function smokeBudget(options: SmokeOptions) {
  const servings = Object.fromEntries(AMENITIES.map(amenity => [amenity, options.serve ? SERVINGS[amenity] : 0])) as Record<AmenityId, number>;
  const maxServingRequests = Object.values(servings).reduce((total, count) => total + count, 0);
  return {
    // 13 HTTP reads + 6 MCP POSTs + at most one SDK GET stream probe.
    // A supplied hash adds three read-only verification requests. Reserve one
    // cancellation notification for a failed MCP request; never retry visits.
    maxRequests: SMOKE_READ_PATHS.length + 1 + 6 + 1 + 1 + maxServingRequests + (options.contributionHash ? 3 : 0),
    maxServingRequests, servings,
  };
}

interface SmokeEvidence {
  servings: { before?: VisitCounts; after?: VisitCounts };
  souvenirs: unknown[];
  contribution?: unknown;
}

export class SmokeFailure extends Error {
  constructor(cause: unknown, readonly requestsAttempted: number, readonly servingRequestsAttempted: number, readonly evidence?: SmokeEvidence) {
    super(cause instanceof Error ? cause.message : 'Smoke check failed', { cause });
    this.name = 'SmokeFailure';
  }
}

/** A finite, single-pass check. Importing this module never contacts a service. */
export async function runSmoke(options: SmokeOptions) {
  validateOptions(options);
  const { origin, network, serve, timeoutMs, contributionHash } = options;
  const mode = serve ? 'serving' : 'read-only';
  const chainId = network === 'mainnet' ? 'manifest-ledger-mainnet' : 'manifest-ledger-testnet';
  const budget = smokeBudget(options);
  const http = createSmokeFetch(options, budget);
  const evidence: SmokeEvidence = { servings: {}, souvenirs: [] };
  const request = (path: string, init?: RequestInit) => http.fetch(origin + path, init);
  const json = async (path: string, init?: RequestInit) => (await request(path, init)).json();
  const text = async (path: string) => (await request(path)).text();
  const checkStats = (stats: VisitCounts) => {
    assert.equal(stats.status, 'available');
    assert.equal(stats.network, network);
    assert.equal(stats.chainId, chainId);
    assert.ok(stats.since && Number.isFinite(Date.parse(stats.since)));
    if (network === 'mainnet') assert.equal(stats.storage, 'persistent');
    for (const amenity of AMENITIES) assert.match(stats.counts?.[amenity] || '', /^(0|[1-9][0-9]*)$/);
    assert.equal(stats.total, AMENITIES.reduce((total, amenity) => total + BigInt(stats.counts![amenity]), 0n).toString());
  };

  try {
    const health = await json('/healthz');
    assert.equal(health.status, 'ok');
    assert.equal(health.network, network);
    assert.equal(health.chainId, chainId);
    assert.equal(health.retired, false);
    assert.equal(health.counter, 'available', 'Serving storage must be open');
    assert.equal(health.version, APP_VERSION);
    const card = await json('/mcp/server-card');
    assert.deepEqual({ name: card.name, version: card.version }, MCP_SERVER_INFO);
    assert.equal(card.websiteUrl, origin, 'ORIGIN must exactly match the deployment PUBLIC_ORIGIN (including hostname and port)');
    const legacyCard = await json('/.well-known/mcp/server-card.json');
    assert.deepEqual(legacyCard.serverInfo, MCP_SERVER_INFO);
    const openapi = await json('/openapi.json');
    assert.equal(openapi.info.version, APP_VERSION);
    const front = await request('/');
    const frontHtml = await front.text();
    assert.match(frontHtml, /merovingian/);
    if (network === 'testnet') {
      assert.match(front.headers.get('x-robots-tag') || '', /noindex/);
    } else {
      assert.doesNotMatch(front.headers.get('x-robots-tag') || '', /noindex/);
      assert.ok(frontHtml.includes('<link rel="canonical" href="' + origin + '/">'));
      assert.match(frontHtml, /name="robots" content="index, follow"/);
    }
    const operator = await request('/operator');
    assert.match(operator.headers.get('x-robots-tag') || '', /noindex/);
    assert.equal(operator.headers.get('cache-control'), 'no-store');
    const operatorHtml = await operator.text();
    assert.match(operatorHtml, /The hosting ledger/);
    assert.match(operatorHtml, /Contribution history/);
    assert.doesNotMatch(operatorHtml, /<script/);
    const history = await json('/api/v1/contributions');
    assert.equal(history.status, 'available');
    assert.equal(history.network, network);
    assert.equal(history.chainId, chainId);
    assert.ok(history.checkedAt);
    if (contributionHash) {
      const entry = history.entries.find((entry: { transactionHash: string }) => entry.transactionHash === contributionHash.toUpperCase());
      assert.ok(entry, 'The known visitor contribution must appear in dashboard history');
      assert.ok(BigInt(entry.amount) > 0n);
      assert.ok(operatorHtml.includes(contributionHash.toUpperCase()));
    }
    const sitemap = await text('/sitemap.xml');
    if (network === 'testnet') assert.doesNotMatch(sitemap, /<loc>/);
    else {
      assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]).sort(),
        [origin + '/', origin + '/about'].sort(), 'Sitemap must contain only the public pages');
    }
    const menu = await json('/api/v1/amenities');
    assert.deepEqual(menu.amenities.map((item: { id: string }) => item.id).sort(), [...AMENITIES].sort());
    const beforeStats: VisitCounts = await json('/api/v1/stats');
    evidence.servings.before = beforeStats;
    checkStats(beforeStats);
    const guide = await text('/visit.md');
    assert.ok(guide.includes(origin + '/mcp'), 'Visit guide must use the configured PUBLIC_ORIGIN');
    assert.ok(!guide.includes('merovingian.invalid'));
    const support = await json('/api/v1/support');
    assert.equal(support.status, 'available');
    assert.equal(support.testTokensOnly, network === 'testnet');
    assert.equal(support.chainId, chainId);

    const client = new Client({ name: 'merovingian-smoke', version: APP_VERSION });
    let closing = false;
    let mcpError: Error | undefined;
    const pending = new Set<Promise<Response>>();
    const failMcp = (error: Error) => {
      if (closing) return;
      mcpError ??= error;
      void transport.close().catch(() => {});
    };
    const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      fetch: (input, init) => {
        const result = http.fetch(input, init).catch(error => { failMcp(error); throw error; });
        pending.add(result);
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    client.onerror = failMcp;
    const requestOptions = { timeout: timeoutMs, maxTotalTimeout: timeoutMs, resetTimeoutOnProgress: false };
    const mcpReady = async () => {
      while (pending.size) await Promise.all([...pending]);
      if (mcpError) throw mcpError;
    };
    const mcp = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        await mcpReady();
        const result = await operation();
        // The SDK starts its GET probe without awaiting it. Include it in the
        // acceptance result and finish discovery before any serving can start.
        await mcpReady();
        return result;
      } catch (error) { throw mcpError ?? error; }
    };
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp(() => client.callTool({ name, arguments: args }, undefined, requestOptions));
      assert.notEqual(result.isError, true, `${name}: MCP tool returned isError`);
      assert.ok(result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent),
        `${name}: missing structuredContent object`);
      return result;
    };
    const souvenirs = evidence.souvenirs;
    let contribution: unknown;
    try {
      await mcp(() => client.connect(transport, requestOptions));
      assert.deepEqual(client.getServerVersion(), MCP_SERVER_INFO);
      const tools = await mcp(() => client.listTools(undefined, requestOptions));
      assert.equal(tools.nextCursor, undefined, 'Unexpected paginated tool discovery');
      assert.deepEqual(tools.tools.map(t => t.name).sort(), ['enjoy_amenity', 'hosting_support', 'list_amenities', 'verify_contribution']);
      const mcpMenu = await callTool('list_amenities', {});
      assert.deepEqual(mcpMenu.structuredContent, menu);
      const resources = await mcp(() => client.listResources(undefined, requestOptions));
      assert.equal(resources.nextCursor, undefined, 'Unexpected paginated resource discovery');
      assert.ok(resources.resources.some(resource => resource.uri === origin + '/visit.md'));
      const resource = await mcp(() => client.readResource({ uri: origin + '/visit.md' }, requestOptions));
      const content = resource.contents[0];
      assert.ok(content && 'text' in content, 'Expected a text visit-guide resource');
      assert.equal(content.text, guide);

      if (contributionHash) {
        const unknown = await callTool('verify_contribution', { transactionHash: '0'.repeat(64) });
        assert.equal((unknown.structuredContent as { status?: unknown }).status, 'pending', 'verify_contribution: expected pending status for unknown hash');
        const input = { transactionHash: contributionHash };
        contribution = await json('/api/v1/support/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
        });
        evidence.contribution = contribution;
        assert.equal((contribution as { status: string }).status, 'confirmed');
        const repeated = await callTool('verify_contribution', input);
        assert.deepEqual(repeated.structuredContent, contribution);
      }

      if (serve) {
        await mcpReady();
        const browserVisit = await request('/visit', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
          body: new URLSearchParams(FORM_VISIT),
        });
        assert.match(await browserVisit.text(), /Save your souvenir/);
        for (const amenity of AMENITIES) {
          const input = { amenity, seed: 'smoke-acceptance' };
          const http = await json('/api/v1/visits', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
          });
          const mcp = await callTool('enjoy_amenity', input);
          assert.deepEqual(mcp.structuredContent, http);
          assert.equal(http.souvenir.network, network);
          assert.equal(http.souvenir.chainId, chainId);
          souvenirs.push(http.souvenir);
        }
      }
    } finally {
      // Close the owned transport even if connect() failed and detached it from
      // the client. This also aborts outstanding bodies and the GET probe.
      closing = true;
      await transport.close();
      await Promise.allSettled([...pending]);
    }
    const afterStats: VisitCounts = await json('/api/v1/stats');
    evidence.servings.after = afterStats;
    checkStats(afterStats);
    assert.equal(afterStats.since, beforeStats.since);
    assert.equal(afterStats.storage, beforeStats.storage);
    for (const amenity of AMENITIES) {
      assert.ok(BigInt(afterStats.counts![amenity]) >= BigInt(beforeStats.counts![amenity]) + BigInt(budget.servings[amenity]),
        'Unexpected serving count for ' + amenity);
    }
    if (options.expectUnchangedCounts) {
      assert.deepEqual(afterStats.counts, beforeStats.counts, '--expect-unchanged-counts: serving counters changed');
    }
    return {
      checkedAt: new Date().toISOString(), origin, network, mode, passed: true, health, budget,
      requestsAttempted: http.requestsAttempted, servingRequestsAttempted: http.servingRequestsAttempted, timeoutMs,
      liveServeAuthorization: options.liveServeAuthorization, expectUnchangedCounts: Boolean(options.expectUnchangedCounts),
      discoveryVerified: true, menuHttpAndMcpEquivalent: true,
      servingChecks: serve ? 'passed' : 'not-run', httpAndMcpEquivalent: serve ? true : null,
      indexingVerified: true, testnetNoindex: network === 'testnet', dashboard: { available: true, history },
      servings: { before: beforeStats, after: afterStats, unchanged: beforeStats.total === afterStats.total },
      souvenirs, contribution,
    };
  } catch (cause) {
    throw new SmokeFailure(cause, http.requestsAttempted, http.servingRequestsAttempted, evidence);
  }
}

/** Reserve each run before contacting the target, then atomically replace only
 * that run's pending record. Exclusive creation preserves earlier evidence and
 * creates fresh private inodes even when legacy reports had wider permissions. */
async function writeReport(path: string, value: unknown, reserve = false) {
  const target = reserve ? path : path + '.tmp';
  const file = await open(target, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  if (!reserve) {
    try { await rename(target, path); }
    catch (error) { await rm(target, { force: true }).catch(() => {}); throw error; }
  }
}

function storageError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'report-storage-failed';
}

async function main(args: string[]) {
  let options: SmokeOptions | undefined;
  let reportPath: string | undefined;
  let reserved = false;
  const runId = randomUUID();
  let report: Awaited<ReturnType<typeof runSmoke>>;
  try {
    options = parseSmokeArgs(args);
    const directory = options.network === 'mainnet' ? '.local/mainnet' : '.local';
    await mkdir(directory, { recursive: true, mode: 0o700 });
    reportPath = directory + '/smoke-' + (options.serve ? 'serving-' : 'read-only-') + runId + '.json';
    await writeReport(reportPath, {
      runId, startedAt: new Date().toISOString(), status: 'running', origin: options.origin,
      mode: options.serve ? 'serving' : 'read-only', budget: smokeBudget(options),
      liveServeAuthorization: options.liveServeAuthorization,
    }, true);
    reserved = true;
    report = await runSmoke(options);
  } catch (error) {
    const failure = {
      runId, checkedAt: new Date().toISOString(), passed: false,
      stage: reserved ? 'checks' : 'preflight',
      error: error instanceof SmokeFailure ? error.message
        : options ? 'Report storage preflight failed: ' + storageError(error)
        : error instanceof Error ? error.message : 'Smoke preflight failed',
      mode: options ? options.serve ? 'serving' : 'read-only' : undefined,
      budget: options ? smokeBudget(options) : undefined,
      requestsAttempted: error instanceof SmokeFailure ? error.requestsAttempted : 0,
      servingRequestsAttempted: error instanceof SmokeFailure ? error.servingRequestsAttempted : 0,
      evidence: error instanceof SmokeFailure ? error.evidence : undefined,
    };
    let reportWritten = false;
    if (reserved && reportPath) {
      try { await writeReport(reportPath, failure); reportWritten = true; } catch { /* Failure evidence is also emitted below. */ }
    }
    console.error(JSON.stringify({ ...failure, report: reportPath, reportWritten }, null, 2));
    process.exitCode = 1;
    return;
  }
  const summary = {
    runId, origin: options.origin, network: options.network, mode: report.mode, passed: true,
    budget: report.budget, requestsAttempted: report.requestsAttempted,
    servingRequestsAttempted: report.servingRequestsAttempted, servingChecks: report.servingChecks,
    countsUnchanged: report.servings.unchanged, contributionVerified: Boolean(report.contribution), report: reportPath,
  };
  try {
    await writeReport(reportPath!, { runId, ...report });
    console.log(JSON.stringify({ ...summary, reportWritten: true }, null, 2));
  } catch (error) {
    // All checks and serving mutations already completed. Preserve the complete
    // evidence on stdout, and distinguish storage failure from failed checks.
    console.log(JSON.stringify({
      ...summary, reportWritten: false, reportError: storageError(error), recoveryReport: { runId, ...report },
    }, null, 2));
    process.exitCode = 2;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; } // For imports from stdin/eval, argv[1] may not be a file.
}

if (isEntrypoint()) {
  await main(process.argv.slice(2));
}
