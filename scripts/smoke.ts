import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AmenityId } from '../src/amenities.js';
import type { Network } from '../src/config.js';
import type { VisitCounts } from '../src/counts.js';
import { APP_VERSION, MCP_SERVER_INFO } from '../src/identity.js';

const USAGE = 'Usage: npm run smoke -- ORIGIN [CONTRIBUTION_HASH] [--mainnet] [--serve] [--timeout-ms 1..60000]';
const DEFAULT_TIMEOUT_MS = 15_000;
const SERVINGS = { 'byte-chip-cookie': 2, 'rgb-sauna': 2, 'null-tea': 3 } as const;
const AMENITIES = Object.keys(SERVINGS) as AmenityId[];

export interface SmokeOptions {
  origin: string;
  network: Network;
  serve: boolean;
  timeoutMs: number;
  contributionHash?: string;
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
}

export function parseSmokeArgs(args: string[]): SmokeOptions {
  const positional: string[] = [];
  const flags = new Set<string>();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!['--mainnet', '--serve', '--timeout-ms'].includes(arg) || flags.has(arg)) throw new Error(USAGE);
    flags.add(arg);
    if (arg === '--timeout-ms') {
      const value = args[++index] || '';
      if (!/^[0-9]+$/.test(value)) throw new Error(USAGE);
      timeoutMs = Number(value);
    }
  }
  if (positional.length < 1 || positional.length > 2) throw new Error(USAGE);
  const options: SmokeOptions = {
    origin: positional[0], contributionHash: positional[1],
    network: flags.has('--mainnet') ? 'mainnet' : 'testnet', serve: flags.has('--serve'), timeoutMs,
  };
  validateOptions(options);
  return options;
}

export function smokeBudget(options: SmokeOptions) {
  return {
    // 13 HTTP reads + 6 MCP POSTs + at most one SDK GET stream probe.
    // A supplied hash adds three read-only verification requests. Reserve one
    // cancellation notification for a failed MCP request; never retry visits.
    maxRequests: 21 + (options.serve ? 7 : 0) + (options.contributionHash ? 3 : 0),
    maxServingRequests: options.serve ? 7 : 0,
    servings: options.serve ? SERVINGS : { 'byte-chip-cookie': 0, 'rgb-sauna': 0, 'null-tea': 0 },
  };
}

export class SmokeFailure extends Error {
  constructor(cause: unknown, readonly requestsAttempted: number, readonly servingRequestsAttempted: number) {
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
  let requestsAttempted = 0;
  let servingRequestsAttempted = 0;
  const boundedFetch: typeof fetch = async (input, init) => {
    assert.ok(requestsAttempted < budget.maxRequests, 'Smoke request budget exceeded');
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, origin, 'Smoke requests must stay on the requested origin');
    const method = init?.method || 'GET';
    const message = url.pathname === '/mcp' && method === 'POST' ? JSON.parse(String(init?.body)) : undefined;
    const serving = method === 'POST' && (['/visit', '/api/v1/visits'].includes(url.pathname)
      || message?.method === 'tools/call' && message.params?.name === 'enjoy_amenity');
    if (serving) {
      assert.ok(servingRequestsAttempted < budget.maxServingRequests, 'Serving requests require --serve and a remaining budget');
      servingRequestsAttempted++;
    }
    requestsAttempted++;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]);
    // Redirects can replay POSTs. Keep the deadline active through body reads,
    // including SDK notifications and the optional GET stream probe.
    return fetch(input, { ...init, redirect: 'error', signal });
  };
  const request = async (path: string, init?: RequestInit) => {
    const response = await boundedFetch(origin + path, init);
    if (response.status !== 200) {
      await response.body?.cancel();
      assert.fail((init?.method || 'GET') + ' ' + path + ': expected HTTP 200, received ' + response.status);
    }
    return response;
  };
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
    assert.equal(health.version, APP_VERSION);
    const card = await json('/mcp/server-card');
    assert.deepEqual({ name: card.name, version: card.version }, MCP_SERVER_INFO);
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
      assert.ok(sitemap.includes('<loc>' + origin + '/</loc>'));
      assert.ok(sitemap.includes('<loc>' + origin + '/about</loc>'));
      assert.doesNotMatch(sitemap, /\/operator|\/api\/|\/mcp/);
    }
    const menu = await json('/api/v1/amenities');
    assert.deepEqual(menu.amenities.map((item: { id: string }) => item.id).sort(), [...AMENITIES].sort());
    const beforeStats: VisitCounts = await json('/api/v1/stats');
    checkStats(beforeStats);
    const guide = await text('/visit.md');
    assert.ok(guide.includes(origin + '/mcp'));
    assert.ok(!guide.includes('merovingian.invalid'));
    const support = await json('/api/v1/support');
    assert.equal(support.status, 'available');
    assert.equal(support.testTokensOnly, network === 'testnet');
    assert.equal(support.chainId, chainId);

    const client = new Client({ name: 'merovingian-smoke', version: APP_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      fetch: boundedFetch,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const requestOptions = { timeout: timeoutMs, maxTotalTimeout: timeoutMs, resetTimeoutOnProgress: false };
    const callTool = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, requestOptions);
    const souvenirs: unknown[] = [];
    let contribution: unknown;
    try {
      await client.connect(transport, requestOptions);
      assert.deepEqual(client.getServerVersion(), MCP_SERVER_INFO);
      const tools = await client.listTools(undefined, requestOptions);
      assert.equal(tools.nextCursor, undefined, 'Unexpected paginated tool discovery');
      assert.deepEqual(tools.tools.map(t => t.name).sort(), ['enjoy_amenity', 'hosting_support', 'list_amenities', 'verify_contribution']);
      const mcpMenu = await callTool('list_amenities', {});
      assert.equal(mcpMenu.isError, undefined);
      assert.deepEqual(mcpMenu.structuredContent, menu);
      const resources = await client.listResources(undefined, requestOptions);
      assert.equal(resources.nextCursor, undefined, 'Unexpected paginated resource discovery');
      assert.ok(resources.resources.some(resource => resource.uri === origin + '/visit.md'));
      const resource = await client.readResource({ uri: origin + '/visit.md' }, requestOptions);
      const content = resource.contents[0];
      assert.ok(content && 'text' in content, 'Expected a text visit-guide resource');
      assert.equal(content.text, guide);

      if (contributionHash) {
        const unknown = await callTool('verify_contribution', { transactionHash: '0'.repeat(64) });
        assert.equal((unknown.structuredContent as { status: string }).status, 'pending');
        const input = { transactionHash: contributionHash };
        contribution = await json('/api/v1/support/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
        });
        assert.equal((contribution as { status: string }).status, 'confirmed');
        const repeated = await callTool('verify_contribution', input);
        assert.equal(repeated.isError, undefined);
        assert.deepEqual(repeated.structuredContent, contribution);
      }

      if (serve) {
        const browserVisit = await request('/visit', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
          body: new URLSearchParams({ amenity: 'null-tea', preference: 'porcelain' }),
        });
        assert.match(await browserVisit.text(), /Save your souvenir/);
        for (const amenity of AMENITIES) {
          const input = { amenity, seed: 'smoke-acceptance' };
          const http = await json('/api/v1/visits', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
          });
          const mcp = await callTool('enjoy_amenity', input);
          assert.equal(mcp.isError, undefined);
          assert.deepEqual(mcp.structuredContent, http);
          assert.equal(http.souvenir.network, network);
          assert.equal(http.souvenir.chainId, chainId);
          souvenirs.push(http.souvenir);
        }
      }
    } finally {
      // Close the owned transport even if connect() failed and detached it from
      // the client. This also aborts outstanding bodies and the GET probe.
      await transport.close();
    }
    const afterStats: VisitCounts = await json('/api/v1/stats');
    checkStats(afterStats);
    assert.equal(afterStats.since, beforeStats.since);
    assert.equal(afterStats.storage, beforeStats.storage);
    for (const amenity of AMENITIES) {
      assert.ok(BigInt(afterStats.counts![amenity]) >= BigInt(beforeStats.counts![amenity]) + BigInt(budget.servings[amenity]),
        'Unexpected serving count for ' + amenity);
    }
    return {
      checkedAt: new Date().toISOString(), origin, network, mode, passed: true, health, budget,
      requestsAttempted, servingRequestsAttempted, timeoutMs,
      discoveryVerified: true, menuHttpAndMcpEquivalent: true,
      servingChecks: serve ? 'passed' : 'not-run', httpAndMcpEquivalent: serve ? true : null,
      indexingVerified: true, testnetNoindex: network === 'testnet', dashboard: { available: true, history },
      servings: { before: beforeStats, after: afterStats, unchanged: beforeStats.total === afterStats.total },
      souvenirs, contribution,
    };
  } catch (cause) {
    throw new SmokeFailure(cause, requestsAttempted, servingRequestsAttempted);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let options: SmokeOptions | undefined;
  let report: Awaited<ReturnType<typeof runSmoke>> | undefined;
  try {
    options = parseSmokeArgs(process.argv.slice(2));
    report = await runSmoke(options);
    const directory = options.network === 'mainnet' ? '.local/mainnet' : '.local';
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const reportPath = directory + '/smoke-' + report.mode + '.json';
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({
      origin: options.origin, network: options.network, mode: report.mode, passed: true,
      budget: report.budget, requestsAttempted: report.requestsAttempted,
      servingRequestsAttempted: report.servingRequestsAttempted, servingChecks: report.servingChecks,
      countsUnchanged: report.servings.unchanged, contributionVerified: Boolean(report.contribution), report: reportPath,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      passed: false, error: error instanceof Error ? error.message : 'Smoke check failed',
      mode: options ? options.serve ? 'serving' : 'read-only' : undefined,
      budget: options ? smokeBudget(options) : undefined,
      requestsAttempted: error instanceof SmokeFailure ? error.requestsAttempted : report?.requestsAttempted ?? 0,
      servingRequestsAttempted: error instanceof SmokeFailure ? error.servingRequestsAttempted : report?.servingRequestsAttempted ?? 0,
    }, null, 2));
    process.exitCode = 1;
  }
}
