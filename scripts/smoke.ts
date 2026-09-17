import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const network = args.includes('--mainnet') ? 'mainnet' : 'testnet';
const positional = args.filter(arg => arg !== '--mainnet');
const [origin, contributionHash] = positional;
const chainId = network === 'mainnet' ? 'manifest-ledger-mainnet' : 'manifest-ledger-testnet';
if (positional.length > 2 || args.some(arg => arg.startsWith('--') && arg !== '--mainnet')
  || (contributionHash && !/^[A-Fa-f0-9]{64}$/.test(contributionHash))) {
  throw new Error('Usage: node --import tsx scripts/smoke.ts HTTPS_ORIGIN [CONTRIBUTION_HASH] [--mainnet]');
}
if (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
  throw new Error('Usage: node --import tsx scripts/smoke.ts HTTPS_ORIGIN [CONTRIBUTION_HASH] [--mainnet]');
}
const fetchOptions = { signal: AbortSignal.timeout(15_000) };
const healthResponse = await fetch(`${origin}/healthz`, fetchOptions);
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.network, network);
assert.equal(health.chainId, chainId);
assert.equal(health.retired, false);
const front = await fetch(origin, { signal: AbortSignal.timeout(15_000) });
assert.equal(front.status, 200);
const frontHtml = await front.text();
assert.match(frontHtml, /merovingian/);
if (network === 'testnet') {
  assert.match(front.headers.get('x-robots-tag') || '', /noindex/);
} else {
  assert.doesNotMatch(front.headers.get('x-robots-tag') || '', /noindex/);
  assert.ok(frontHtml.includes(`<link rel="canonical" href="${origin}/">`));
  assert.match(frontHtml, /name="robots" content="index, follow"/);
}
const operator = await fetch(`${origin}/operator`, { signal: AbortSignal.timeout(15_000) });
assert.equal(operator.status, 200);
assert.match(operator.headers.get('x-robots-tag') || '', /noindex/);
assert.equal(operator.headers.get('cache-control'), 'no-store');
const operatorHtml = await operator.text();
assert.match(operatorHtml, /The hosting ledger/);
assert.match(operatorHtml, /Contribution history/);
assert.doesNotMatch(operatorHtml, /<script/);
const historyResponse = await fetch(`${origin}/api/v1/contributions`, { signal: AbortSignal.timeout(15_000) });
assert.equal(historyResponse.status, 200);
const history = await historyResponse.json();
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
const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
if (network === 'testnet') assert.doesNotMatch(sitemap, /<loc>/);
else {
  assert.ok(sitemap.includes(`<loc>${origin}/</loc>`));
  assert.ok(sitemap.includes(`<loc>${origin}/about</loc>`));
  assert.doesNotMatch(sitemap, /\/operator|\/api\/|\/mcp/);
}
const menu = await (await fetch(`${origin}/api/v1/amenities`)).json();
assert.equal(menu.amenities.length, 3);
const beforeStats = await (await fetch(`${origin}/api/v1/stats`)).json();
assert.equal(beforeStats.status, 'available');
assert.equal(beforeStats.network, network);
if (network === 'mainnet') assert.equal(beforeStats.storage, 'persistent');
const guide = await (await fetch(`${origin}/visit.md`)).text();
assert.ok(guide.includes(`${origin}/mcp`));
assert.ok(!guide.includes('merovingian.invalid'));
const browserVisit = await fetch(`${origin}/visit`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
  body: new URLSearchParams({ amenity: 'null-tea', preference: 'porcelain' }), signal: AbortSignal.timeout(15_000),
});
assert.equal(browserVisit.status, 200);
assert.match(await browserVisit.text(), /Save your souvenir/);

const client = new Client({ name: 'merovingian-live-acceptance', version: '0.4.1' });
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
const souvenirs: unknown[] = [];
let contribution: unknown;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['enjoy_amenity', 'hosting_support', 'list_amenities', 'verify_contribution']);
  for (const item of menu.amenities) {
    const input = { amenity: item.id, seed: 'live-acceptance' };
    const response = await fetch(`${origin}/api/v1/visits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200);
    const http = await response.json();
    const mcp = await client.callTool({ name: 'enjoy_amenity', arguments: input });
    assert.equal(mcp.isError, undefined);
    assert.deepEqual(mcp.structuredContent, http);
    assert.equal(http.souvenir.network, network);
    assert.equal(http.souvenir.chainId, chainId);
    souvenirs.push(http.souvenir);
  }
  const support = await (await fetch(`${origin}/api/v1/support`)).json();
  assert.equal(support.status, 'available');
  assert.equal(support.testTokensOnly, network === 'testnet');
  assert.equal(support.chainId, chainId);
  const unknown = await client.callTool({ name: 'verify_contribution', arguments: { transactionHash: '0'.repeat(64) } });
  assert.equal((unknown.structuredContent as { status: string }).status, 'pending');
  if (contributionHash) {
    const request = { transactionHash: contributionHash };
    const response = await fetch(`${origin}/api/v1/support/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(15_000) });
    contribution = await response.json();
    assert.equal((contribution as { status: string }).status, 'confirmed');
    const repeated = await client.callTool({ name: 'verify_contribution', arguments: request });
    assert.deepEqual(repeated.structuredContent, contribution);
  }
} finally { await client.close(); }
const afterStats = await (await fetch(`${origin}/api/v1/stats`)).json();
assert.equal(afterStats.status, 'available');
assert.equal(afterStats.since, beforeStats.since);
for (const amenity of menu.amenities) {
  const minimumIncrease = amenity.id === 'null-tea' ? 3n : 2n;
  assert.ok(BigInt(afterStats.counts[amenity.id]) >= BigInt(beforeStats.counts[amenity.id]) + minimumIncrease);
}
const directory = network === 'mainnet' ? '.local/mainnet' : '.local';
await mkdir(directory, { recursive: true, mode: 0o700 });
const reportPath = `${directory}/live-acceptance.json`;
const report = { checkedAt: new Date().toISOString(), origin, health, httpAndMcpEquivalent: true, indexingVerified: true, testnetNoindex: network === 'testnet', dashboard: { available: true, history }, servings: { before: beforeStats, after: afterStats }, souvenirs, contribution };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ origin, network, passed: true, amenities: souvenirs.length, dashboardVerified: true, contributionVerified: Boolean(contribution), report: reportPath }, null, 2));
