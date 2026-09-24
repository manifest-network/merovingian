import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { parseEndpoint, readOnlyFetch, READ_ONLY_TOOLS } from '../examples/read-only-client.mjs';
import { CONNECT_GUIDE, connectionExamples, ENDPOINT, example, localized, READ_ONLY_TOOLS as HOST_READ_ONLY_TOOLS } from '../scripts/connection-examples.js';
import { createApp, type SupportPort } from '../src/app.js';
import type { Config } from '../src/config.js';
import { VisitCounter } from '../src/counts.js';
import { MCP_SERVER_INFO } from '../src/identity.js';

const CLIENT = fileURLToPath(new URL('../examples/read-only-client.mjs', import.meta.url));
const run = promisify(execFile);

const support: SupportPort = {
  getInfo: async () => { throw new Error('The read-only example must not query hosting support'); },
  getHistory: async () => { throw new Error('The read-only example must not query contribution history'); },
  verify: async () => { throw new Error('The read-only example must not verify contributions'); },
};

/** Loopback app with memory counters. Records each request after the app parsed it. */
async function fixture(t: TestContext) {
  const outer = express();
  const server = outer.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: Config = {
    network: 'mainnet', chainId: 'manifest-ledger-mainnet', publicOrigin: origin, port: 8080,
    rpcUrl: 'https://unused-rpc.example', gasPrice: '1.1umfx', pwrDenom: 'upwr', tenant: '', trustedProxyCidrs: [],
  };
  const counts = new VisitCounter(config);
  const requests: { method: string; path: string; body: any }[] = [];
  outer.use((req, res, next) => {
    res.once('finish', () => requests.push({ method: req.method, path: req.path, body: req.body }));
    next();
  });
  outer.use(createApp(config, support, counts));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    counts.close();
  });
  return { origin, counts, requests };
}

test('the read-only example reads the menu over MCP without changing serving counts', async t => {
  const f = await fixture(t);
  const before = f.counts.snapshot();
  const { stdout, stderr } = await run(process.execPath, [CLIENT, `${f.origin}/mcp`], { timeout: 30_000 });
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.deepEqual(report.server, MCP_SERVER_INFO);
  assert.equal(report.endpoint, `${f.origin}/mcp`);
  assert.deepEqual(report.tools.map((tool: { name: string }) => tool.name).sort(),
    ['enjoy_amenity', 'hosting_support', 'list_amenities', 'verify_contribution']);
  assert.deepEqual(report.tools.find((tool: { name: string }) => tool.name === 'enjoy_amenity').readOnlyHint, false);
  // Host examples may allow only tools the live server annotates as read-only.
  assert.deepEqual(report.tools.filter((tool: { readOnlyHint: boolean }) => tool.readOnlyHint).map((tool: { name: string }) => tool.name).sort(),
    [...HOST_READ_ONLY_TOOLS].sort());
  assert.deepEqual(report.visitGuide.uri, `${f.origin}/visit.md`);
  assert.deepEqual(report.amenities.map((amenity: { id: string }) => amenity.id), ['byte-chip-cookie', 'rgb-sauna', 'null-tea']);
  assert.equal(report.walletRequired, false);
  assert.deepEqual(report.toolsCalled, ['list_amenities']);

  const mcp = f.requests.filter(request => request.path === '/mcp');
  assert.equal(f.requests.length, mcp.length, 'The example contacts only the MCP endpoint');
  assert.deepEqual(mcp.filter(request => request.method === 'POST').map(request => request.body.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'resources/read', 'tools/call']);
  assert.deepEqual(mcp.filter(request => request.body?.method === 'tools/call').map(request => request.body.params.name), ['list_amenities']);
  assert.ok(mcp.filter(request => request.method !== 'POST').every(request => request.method === 'GET'));
  assert.deepEqual(f.counts.snapshot(), before);
});

test('the read-only example refuses serving and non-MCP requests before they reach the network', async () => {
  const endpoint = parseEndpoint('https://refuge.example/mcp');
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const guarded = readOnlyFetch(endpoint, async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: new Request(input).url, init });
    return new Response('{}', { status: 200 });
  });
  const call = (name: string) => guarded(endpoint.href, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  });
  for (const name of ['enjoy_amenity', 'hosting_support', 'verify_contribution', 'unknown']) {
    await assert.rejects(call(name), /read-only/);
  }
  for (const body of ['[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]', 'not json', '{"jsonrpc":"2.0","id":1,"method":"completion/complete"}']) {
    await assert.rejects(guarded(endpoint.href, { method: 'POST', body }), /Refusing/);
  }
  await assert.rejects(guarded(new Request(endpoint.href, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'enjoy_amenity' } }),
  })), /read-only/, 'Request objects are inspected like URL/init pairs');
  await assert.rejects(guarded('https://refuge.example/api/v1/visits', { method: 'POST', body: '{}' }), /Refusing a request/);
  await assert.rejects(guarded('https://refuge.example/mcp/', { method: 'GET' }), /Refusing a request/);
  await assert.rejects(guarded(endpoint.href, { method: 'DELETE' }), /Refusing HTTP DELETE/);
  assert.equal(sent.length, 0);

  assert.deepEqual(READ_ONLY_TOOLS, ['list_amenities']);
  await call('list_amenities');
  await guarded(endpoint.href, { method: 'GET' });
  assert.equal(sent.length, 2);
  for (const { init } of sent) {
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal);
  }
});

test('the read-only example accepts only HTTPS or loopback HTTP endpoints without credentials', () => {
  for (const endpoint of ['https://merovingian.manifest.network/mcp', 'http://localhost:8080/mcp', 'http://127.0.0.1:1/mcp', 'http://[::1]:8080/mcp']) {
    assert.equal(parseEndpoint(endpoint).href, endpoint);
  }
  for (const endpoint of ['http://merovingian.manifest.network/mcp', 'https://user:secret@refuge.example/mcp',
    'https://refuge.example/mcp?token=1', 'https://refuge.example/mcp#top', 'file:///tmp/mcp', 'not a url']) {
    assert.throws(() => parseEndpoint(endpoint), /endpoint|Usage/);
  }
});

test('the read-only example exits non-zero with usage for missing or unsafe endpoints', async () => {
  for (const args of [[], ['http://refuge.example/mcp'], ['https://a.example/mcp', 'extra']]) {
    await assert.rejects(run(process.execPath, [CLIENT, ...args], { timeout: 10_000 }), (error: { code: number; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Usage|endpoint must be/);
      return true;
    });
  }
});

const guide = readFileSync(CONNECT_GUIDE, 'utf8');
const examples = connectionExamples(guide);
const json = (id: string) => JSON.parse(example(examples, id).code);
const readOnly = (names: string[]) => names.length > 0 && names.every(name => HOST_READ_ONLY_TOOLS.includes(name));

test('the connection guide publishes one checked example per host configuration', () => {
  assert.deepEqual([...examples.keys()].sort(), [
    'claude-code-add', 'claude-code-project', 'claude-code-settings', 'codex-config',
    'cursor-cli-permissions', 'cursor-mcp-json', 'gemini-settings', 'vscode-mcp-json', 'vscode-read-only-agent',
  ]);
  for (const [id, { language, code }] of examples) {
    if (language === 'json') assert.doesNotThrow(() => JSON.parse(code), id);
    assert.doesNotMatch(code, /merovingian\.invalid|localhost|127\.0\.0\.1/, id);
  }
  assert.ok(guide.includes('```text\n' + ENDPOINT + '\n```'));
  const link = guide.match(/https:\/\/claude\.ai\/customize\/connectors\?[^\s)]+/)?.[0];
  assert.ok(link);
  assert.deepEqual(Object.fromEntries(new URL(link).searchParams), { modal: 'add-custom-connector', connectorName: 'merovingian', connectorUrl: ENDPOINT });
});

test('every host example names the registry endpoint, and every tool filter allows only read-only tools', () => {
  assert.equal(example(examples, 'claude-code-add').code, `claude mcp add --transport http merovingian ${ENDPOINT}\n`);
  const claude = json('claude-code-settings').permissions;
  assert.ok(readOnly(claude.allow.map((rule: string) => rule.replace(/^mcp__merovingian__/, ''))));
  assert.deepEqual(claude.deny, ['mcp__merovingian__enjoy_amenity']);
  assert.ok([...claude.allow, ...claude.deny].every((rule: string) => !rule.includes('(')), 'Claude Code skips MCP rules with parentheses');
  assert.deepEqual(json('claude-code-project'), { mcpServers: { merovingian: { type: 'http', url: ENDPOINT } } });

  const codex = example(examples, 'codex-config').code.trim().split('\n');
  assert.equal(codex[0], '[mcp_servers.merovingian]');
  const table = Object.fromEntries(codex.slice(1).map(line => line.split(' = ') as [string, string]));
  assert.deepEqual(Object.keys(table), ['url', 'enabled_tools', 'default_tools_approval_mode']);
  assert.equal(JSON.parse(table.url!), ENDPOINT);
  assert.ok(readOnly(JSON.parse(table.enabled_tools!)));
  assert.equal(JSON.parse(table.default_tools_approval_mode!), 'writes');

  assert.deepEqual(json('vscode-mcp-json'), { servers: { merovingian: { type: 'http', url: ENDPOINT } } });
  const agent = example(examples, 'vscode-read-only-agent').code.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  const tools = JSON.parse(agent.match(/^tools: (\[.*\])$/m)?.[1]?.replaceAll("'", '"') ?? '[]');
  assert.ok(readOnly(tools.map((tool: string) => tool.match(/^merovingian\/([a-z_]+)$/)?.[1] ?? '')), 'The VS Code agent lists only read-only tools by qualified name');
  assert.deepEqual(json('cursor-mcp-json'), { mcpServers: { merovingian: { url: ENDPOINT } } });
  const cursor = json('cursor-cli-permissions').permissions;
  assert.ok(readOnly(cursor.allow.map((rule: string) => rule.match(/^Mcp\(merovingian:([a-z_]+)\)$/)?.[1] ?? '')));
  assert.deepEqual(cursor.deny, ['Mcp(merovingian:enjoy_amenity)']);

  const gemini = json('gemini-settings').mcpServers.merovingian;
  assert.equal(gemini.httpUrl ?? gemini.url, ENDPOINT);
  assert.ok(readOnly(gemini.includeTools));
  assert.deepEqual(gemini.excludeTools, ['enjoy_amenity']);
  assert.notEqual(gemini.trust, true);
});

test('examples that cannot filter tools in configuration are followed by a required read-only step', () => {
  const section = (heading: string) => {
    const start = guide.indexOf(`\n## ${heading}\n`);
    assert.ok(start >= 0, heading);
    const end = guide.indexOf('\n## ', start + 1);
    return guide.slice(start, end < 0 ? undefined : end);
  };
  for (const [heading, id] of [['Claude Code', 'claude-code-add'], ['VS Code', 'vscode-mcp-json'], ['Cursor', 'cursor-mcp-json']]) {
    const text = section(heading!);
    const marker = text.indexOf(`<!-- example: ${id} -->`);
    assert.ok(marker >= 0 && text.indexOf('**Required before first use:**', marker) > marker, `${heading} must require a read-only step after ${id}`);
  }
  assert.match(section('Claude web and desktop apps'), /\*\*Required before first use:\*\*[^]*`enjoy_amenity` to \*\*Blocked\*\*/);
});

test('example extraction rejects markers without a code block and swaps only the endpoint', () => {
  assert.throws(() => connectionExamples('<!-- example: lonely -->\ntext\n'), /followed directly/);
  assert.throws(() => connectionExamples('<!-- example: a -->\n```sh\nx\n```\n<!-- example: a -->\n```sh\ny\n```\n'), /Duplicate/);
  assert.equal(localized(`url = "${ENDPOINT}"`, 'http://127.0.0.1:1/mcp'), 'url = "http://127.0.0.1:1/mcp"');
  assert.throws(() => localized('url = "https://elsewhere.example/mcp"', 'http://127.0.0.1:1/mcp'), /production endpoint/);
});

test('the saved local verification report passed without servings or unexpected tool calls', () => {
  const report = JSON.parse(readFileSync(new URL('../docs/evidence/connection-examples-2026-09-24.json', import.meta.url), 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.servingCalls, 0);
  assert.equal(report.countsUnchanged, true);
  assert.deepEqual(report.toolCalls, [{ phase: 'read-only-client', tool: 'list_amenities' }]);
  assert.deepEqual(report.hosts.map((host: { host: string; status: string }) => [host.host, host.status]),
    [['read-only-client', 'verified'], ['claude-code', 'verified'], ['codex-cli', 'verified']]);
  assert.doesNotMatch(JSON.stringify(report), /\/home\/|\/tmp\/|\/Users\//, 'The public report must not contain local paths');
});
