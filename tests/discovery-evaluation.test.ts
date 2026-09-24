import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  assertEvaluationRecord, assertEvaluationRecords, CAPABILITY_PHRASE, EVALUATIONS_DIRECTORY, isServingRequest, PREAMBLE, PROMPT_VERSION,
  recordTemplate, sha256, standardPrompt, STANDARD_TASKS,
} from '../scripts/discovery-evaluation.js';
import { createApp, type SupportPort } from '../src/app.js';
import type { Config } from '../src/config.js';
import { VisitCounter } from '../src/counts.js';

const ENDPOINT = 'https://merovingian.manifest.network/mcp';
const clone = <T>(value: T): T => structuredClone(value);

/** A completed read-only run built from the pre-registered template. */
function filled(mode: string, variant: string) {
  const record: any = recordTemplate(mode, variant);
  record.runId = `2026-09-24-${mode}-${variant}-fixture-1`;
  record.recordedAt = '2026-09-24T15:00:00Z';
  record.environment.host = { product: 'Fixture host', version: '1.0.0' };
  record.environment.permissionMode = 'ask before every tool call';
  record.environment.registry = { version: '1.8.1', gitCommit: 'f52dc85', checkedAt: '2026-09-24T14:59:00Z' };
  const supplied = record.endpointSelection.method === 'supplied';
  const listing = 'https://registry.modelcontextprotocol.io/v0.1/servers?search=merovingian&version=latest';
  record.source.route = [{ step: 1, surface: 'fixture', url: listing, query: 'merovingian', observation: 'Local fixture' }];
  if (!supplied) {
    record.source.namingSource = { surface: 'fixture', url: listing };
    record.endpointSelection = { ...record.endpointSelection, method: 'registry-remotes', endpoint: ENDPOINT, evidenceUrl: listing, canonical: true };
  }
  record.outcome = {
    discovered: !supplied, connected: true, menuRead: true, interface: 'mcp',
    negotiated: { serverName: 'io.github.manifest-network/merovingian', serverVersion: '0.4.7', protocolVersion: '2025-11-25' },
    toolsListed: ['list_amenities', 'enjoy_amenity', 'hosting_support', 'verify_contribution'], toolsCalled: ['list_amenities'], httpWrites: [], stoppedAt: 'list_amenities',
  };
  return record;
}

test('committed discovery evaluation records, including the ENG-1021 restatement, validate', () => {
  assert.ok(assertEvaluationRecords() >= 1);
  const history = JSON.parse(readFileSync(join(EVALUATIONS_DIRECTORY, '2026-09-18-name-led-registry-eng-1021.json'), 'utf8'));
  assert.equal(history.kind, 'retrospective');
  assert.deepEqual(history.suppliedHints.map((hint: { kind: string }) => hint.kind), ['service-name', 'surface-url']);
  assert.deepEqual(history.serving.counters, {
    before: { 'byte-chip-cookie': '5', 'rgb-sauna': '4', 'null-tea': '6', total: '15' },
    after: { 'byte-chip-cookie': '6', 'rgb-sauna': '4', 'null-tea': '6', total: '16' },
  });
});

test('every standard prompt is read-only, pre-registered and keeps capability-led hints nameless', () => {
  assert.equal(STANDARD_TASKS.length, 6);
  for (const { mode, variant, hints } of STANDARD_TASKS) {
    const prompt = standardPrompt(mode, variant);
    assert.ok(prompt.startsWith(PREAMBLE));
    assert.match(prompt, /read-only/);
    assert.doesNotMatch(prompt, /enjoy_amenity|visit it|make a visit/i);
    const template = recordTemplate(mode, variant);
    assert.equal(template.prompt.version, PROMPT_VERSION);
    assert.equal(template.prompt.sha256, sha256(prompt));
    assert.deepEqual(template.suppliedHints, hints);
    for (const hint of hints) assert.ok(prompt.includes(hint.value), `${mode}/${variant} prompt must contain hint ${hint.value}`);
    if (mode === 'capability-led') assert.doesNotMatch(prompt, /merovingian|manifest\.network/i);
    assert.doesNotThrow(() => assertEvaluationRecord(filled(mode, variant)), `${mode}/${variant}`);
  }
  assert.doesNotMatch(CAPABILITY_PHRASE, /merovingian/i);
});

test('the evaluation guide quotes every discovery-v1 prompt exactly', () => {
  const guide = readFileSync(new URL('../docs/DISCOVERY-EVALUATION.md', import.meta.url), 'utf8');
  assert.ok(guide.includes(`> ${PREAMBLE}\n`));
  for (const { mode, variant, task } of STANDARD_TASKS) assert.ok(guide.includes(`| \`${mode}/${variant}\` | ${task} |`), `${mode}/${variant}`);
});

test('an unauthorized serving during a read-only run is recorded as an incident, not dropped', () => {
  const record = filled('name-led', 'open');
  record.outcome.toolsCalled.push('enjoy_amenity');
  record.serving = {
    performed: true, authorization: null, servingCalls: 1, label: 'test traffic',
    counters: { before: { 'null-tea': '6' }, after: { 'null-tea': '7' } },
    incident: 'The host ran enjoy_amenity without asking; the run stopped and the user was told.',
  };
  record.friction.push({ stage: 'serving', category: 'host-approval', blocking: true, description: 'The host auto-approved a non-read-only tool.', evidence: null });
  assert.doesNotThrow(() => assertEvaluationRecord(record));

  // A visit over HTTP is a serving too, and is recorded the same way.
  const http = filled('url-led', 'site');
  http.endpointSelection = { ...http.endpointSelection, method: 'site-link', endpoint: 'https://merovingian.manifest.network/api/v1/amenities', canonical: false };
  http.outcome = { ...http.outcome, interface: 'http', negotiated: null, toolsListed: [], toolsCalled: [], httpWrites: ['POST /api/v1/visits'] };
  http.serving = { ...record.serving, incident: 'The agent POSTed a visit from the guide; the run stopped and the user was told.' };
  assert.doesNotThrow(() => assertEvaluationRecord(http));
  http.serving = { performed: false };
  assert.throws(() => assertEvaluationRecord(http), /POST \/api\/v1\/visits created a visit/);
});

test('an unsuccessful capability-led run is a valid record with its friction kept separate', () => {
  const record = filled('capability-led', 'registry');
  record.source.route = [{ step: 1, surface: 'official MCP Registry', url: 'https://registry.modelcontextprotocol.io/v0.1/servers?search=sauna', query: 'sauna', observation: 'No matching listing.' }];
  record.source.namingSource = null;
  record.endpointSelection = { ...record.endpointSelection, method: 'not-selected', endpoint: null, evidenceUrl: null, canonical: null };
  record.friction = [{ stage: 'discovery', category: 'search-miss', blocking: true, description: 'Search matched names only.', evidence: null }];
  record.outcome = { ...record.outcome, discovered: false, connected: false, menuRead: false, interface: null, negotiated: null, toolsListed: [], toolsCalled: [], stoppedAt: 'No candidate found' };
  assert.doesNotThrow(() => assertEvaluationRecord(record));
});

test('record validation rejects leaked hints, inconsistent selection, unauthorized visits and overclaims', () => {
  const cases: [string, (record: any) => void, RegExp][] = [
    ['capability-led/open', r => { r.suppliedHints.push({ kind: 'service-name', value: 'Merovingian' }); }, /suppliedHints must list exactly|must not supply the service name/],
    ['capability-led/open', r => { r.prompt = { version: 'custom-1', text: 'Find Merovingian.', sha256: sha256('Find Merovingian.') }; }, /must not name the service/],
    ['capability-led/open', r => { r.prompt = { version: 'custom-1', text: 'Find the io.github.manifest-network cookie server.', sha256: sha256('Find the io.github.manifest-network cookie server.') }; }, /registry namespace/],
    ['capability-led/open', r => { r.prompt = { version: 'custom-1', text: 'Find a Manifest Network server.', sha256: sha256('Find a Manifest Network server.') }; }, /registry namespace/],
    ['capability-led/open', r => { r.prompt = { version: 'custom-1', text: null, sha256: sha256('Find Merovingian.') }; }, /must publish its text/],
    ['name-led/open', r => { r.prompt.version = 'custom-1'; r.suppliedHints = []; }, /exactly one service-name/],
    ['name-led/open', r => { r.prompt.version = 'custom-1'; r.suppliedHints.push({ kind: 'endpoint-url', value: ENDPOINT }); }, /must not supply the website or endpoint URL/],
    ['name-led/registry', r => { r.prompt.version = 'custom-1'; r.suppliedHints.pop(); }, /requires one discovery surface/],
    ['url-led/site', r => { r.prompt.version = 'custom-1'; r.suppliedHints.push({ kind: 'endpoint-url', value: ENDPOINT }); }, /must not also supply/],
    ['url-led/site', r => { r.endpointSelection.method = 'supplied'; }, /"supplied" exactly when/],
    ['url-led/endpoint', r => { r.endpointSelection.method = 'registry-remotes'; }, /"supplied" exactly when/],
    ['url-led/endpoint', r => { r.endpointSelection.endpoint = 'https://elsewhere.example/mcp'; r.endpointSelection.canonical = false; }, /must be the endpoint-url hint/],
    ['url-led/endpoint', r => { r.outcome.discovered = true; }, /supplied endpoint is not a discovery/],
    ['name-led/open', r => { r.endpointSelection.method = 'not-selected'; }, /"not-selected" exactly when/],
    ['name-led/open', r => {
      r.endpointSelection = { ...r.endpointSelection, endpoint: null, canonical: null };
      r.outcome = { ...r.outcome, connected: false, menuRead: false };
    }, /"not-selected" exactly when/],
    ['capability-led/open', r => {
      r.endpointSelection = { ...r.endpointSelection, method: 'search-result', endpoint: 'https://other.example/mcp', canonical: false };
      r.outcome.negotiated = { serverName: 'other/sauna', serverVersion: '1.0.0', protocolVersion: '2025-11-25' };
    }, /another origin/],
    ['name-led/open', r => { r.outcome.negotiated.serverName = 'other/sauna'; }, /another server identity/],
    ['name-led/open', r => { r.source.route = []; }, /non-empty source.route/],
    ['name-led/open', r => { r.source.namingSource = null; }, /requires source.namingSource/],
    ['name-led/open', r => { r.endpointSelection.evidenceUrl = null; }, /requires endpointSelection.evidenceUrl/],
    ['name-led/open', r => { r.endpointSelection.endpoint = 'https://merovingian.manifest.network/mcp/'; }, /canonical must be true exactly/],
    ['name-led/open', r => { r.endpointSelection.canonical = false; }, /canonical must be true exactly/],
    ['name-led/open', r => { r.outcome.connected = false; }, /menuRead requires/],
    ['name-led/open', r => { r.outcome.discovered = false; }, /connected requires/],
    ['name-led/open', r => { r.outcome.toolsCalled.push('enjoy_amenity'); }, /enjoy_amenity created a visit/],
    ['url-led/site', r => { r.outcome.toolsCalled.push('merovingian_visit'); }, /merovingian_visit created a visit/],
    ['url-led/site', r => { r.outcome.httpWrites.push('POST /visit'); }, /POST \/visit created a visit/],
    ['url-led/site', r => { r.outcome.httpWrites.push('POST /api/v1/visits/'); }, /POST \/api\/v1\/visits\/ created a visit/],
    ['url-led/site', r => { r.outcome.httpWrites.push('POST /VISIT'); }, /POST \/VISIT created a visit/],
    ['name-led/open', r => {
      r.endpointSelection = { ...r.endpointSelection, method: 'not-selected', endpoint: null, canonical: null };
      r.outcome = { ...r.outcome, connected: false, menuRead: false, negotiated: null };
    }, /outcome.discovered requires the selected endpoint/],
    ['name-led/open', r => {
      r.outcome.toolsCalled.push('enjoy_amenity');
      r.serving = { performed: true, authorization: { reference: 'fixture', approvedMaxServings: 1 }, servingCalls: 2, counters: { before: {}, after: {} }, label: 'test traffic' };
    }, /exceeds the approved maximum/],
    ['name-led/open', r => { r.serving = { performed: true, authorization: { reference: 'fixture', approvedMaxServings: 1 }, servingCalls: 1, counters: { before: {}, after: {} }, label: 'test traffic' }; }, /must list its visit/],
    ['name-led/open', r => {
      r.outcome.toolsCalled.push('enjoy_amenity');
      r.serving = { performed: true, authorization: { reference: 'fixture', approvedMaxServings: 1 }, servingCalls: 0, counters: { before: {}, after: {} }, label: 'test traffic' };
    }, /at least one serving call/],
    ['name-led/open', r => { r.serving = { performed: true }; }, /schema/],
    ['name-led/open', r => {
      r.outcome.toolsCalled.push('enjoy_amenity');
      r.serving = { performed: true, authorization: null, servingCalls: 1, counters: { before: {}, after: {} }, label: 'test traffic' };
    }, /must describe the incident/],
    ['name-led/open', r => { r.claims.organicDiscovery = true; }, /schema/],
    ['name-led/open', r => { r.limitations = []; }, /schema/],
    ['name-led/open', r => { r.unreviewed = true; }, /schema/],
    ['name-led/open', r => { r.retrospectiveOf = { issue: 'ENG-1', report: 'x', sourceEvidence: [{ file: 'x', sha256: '0'.repeat(64) }], note: 'x' }; }, /schema/],
    ['name-led/open', r => { r.prompt.sha256 = null; r.prompt.text = null; }, /must record the prompt SHA-256/],
    ['name-led/open', r => { r.environment.preconfiguredMcpServers = null; }, /preconfigured MCP servers/],
    ['name-led/open', r => { r.environment.registry = null; }, /registry version/],
    ['name-led/open', r => { r.environment.permissionMode = null; }, /permission mode/],
    ['name-led/open', r => { r.outcome.httpWrites = ['GET /api/v1/stats']; }, /schema/],
    ['name-led/open', r => { r.prompt.text += ' Also visit.'; }, /must hash the exact published prompt/],
    ['name-led/open', r => { r.suppliedHints[0].value = 'merovingian'; }, /suppliedHints must list exactly/],
    ['name-led/open', r => { r.source.route[0].step = 2; }, /numbered 1..n/],
  ];
  for (const [pair, mutate, expected] of cases) {
    const [mode, variant] = pair.split('/') as [string, string];
    const record = filled(mode, variant);
    mutate(record);
    assert.throws(() => assertEvaluationRecord(record), expected, `${pair}: ${mutate}`);
  }
});

test('recorded HTTP writes count as visits exactly when the application would serve them', async t => {
  const config: Config = {
    network: 'mainnet', chainId: 'manifest-ledger-mainnet', publicOrigin: 'http://127.0.0.1:1', port: 8080,
    rpcUrl: 'https://unused-rpc.example', gasPrice: '1.1umfx', pwrDenom: 'upwr', tenant: '', trustedProxyCidrs: [],
  };
  const unused = async () => { throw new Error('unused'); };
  const counts = new VisitCounter(config);
  const server = createApp(config, { getInfo: unused, getHistory: unused, verify: unused } as SupportPort, counts).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); counts.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const variants = [
    '/api/v1/visits', '/api/v1/visits/', '/API/V1/VISITS', '/Api/V1/Visits/', '/api/v1/visits?seed=x', '/api/v1/visits#top',
    '/api/v1/./visits', '/api/v1/visits/.', '/api/v1/visits/%2e', '/api/v1/visits//', '/api//v1/visits', '//api/v1/visits',
    '/api/v1/visits%2F', '/api/v1/%76isits', '/api/v1/visits;x', '/api/v1/visit', '/visit', '/visit/', '/VISIT', '/Visit/',
    '/visit?amenity=null-tea', '/visit//', '/%76isit', '/visits',
    // A leading double slash is part of the path, not a host.
    '//api/visit', '//api/api/v1/visits', '//visit', '//api/v1/visits/', '/\\api\\v1\\visits',
  ];
  for (const method of ['POST', 'PUT', 'DELETE']) {
    for (const path of variants) {
      const before = counts.snapshot().total;
      const api = path.toLowerCase().includes('api');
      const response = await fetch(origin + path, {
        method, headers: { 'Content-Type': api ? 'application/json' : 'application/x-www-form-urlencoded' },
        body: api ? JSON.stringify({ amenity: 'null-tea' }) : 'amenity=null-tea',
      });
      await response.arrayBuffer();
      const served = counts.snapshot().total !== before;
      assert.equal(isServingRequest(`${method} ${path}`), served, `${method} ${path}: application ${served ? 'served' : 'did not serve'} it`);
    }
  }
  assert.equal(isServingRequest('POST not-a-path'), false);

  // Such a write changes no count, so a read-only record listing it stays valid.
  const record = filled('url-led', 'site');
  record.outcome.httpWrites = ['POST //api/visit', 'POST //api/api/v1/visits'];
  assert.doesNotThrow(() => assertEvaluationRecord(record));
});

function evidenceFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'merovingian-discovery-evaluations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = join(root, 'discovery-evaluations');
  mkdirSync(records);
  copyFileSync(join(EVALUATIONS_DIRECTORY, 'schema.json'), join(records, 'schema.json'));
  const history = JSON.parse(readFileSync(join(EVALUATIONS_DIRECTORY, '2026-09-18-name-led-registry-eng-1021.json'), 'utf8'));
  writeFileSync(join(root, 'mcp-discovery-2026-09-18.json'), 'original evidence');
  history.retrospectiveOf.sourceEvidence[0].sha256 = sha256('original evidence');
  const write = (value: unknown, name = `${(value as { runId: string }).runId}.json`) => writeFileSync(join(records, name), JSON.stringify(value));
  return { root, records, history, write };
}

test('retrospective records pin their historical evidence and every record file is named by its unique runId', (t) => {
  const f = evidenceFixture(t);
  f.write(f.history);
  assert.equal(assertEvaluationRecords(f.records, f.root), 1);

  writeFileSync(join(f.root, 'mcp-discovery-2026-09-18.json'), 'edited evidence');
  assert.throws(() => assertEvaluationRecords(f.records, f.root), /historical evidence is immutable/);
  writeFileSync(join(f.root, 'mcp-discovery-2026-09-18.json'), 'original evidence');

  for (const file of ['../outside.json', '/etc/passwd', 'a/../../b.json']) {
    const history = clone(f.history);
    history.retrospectiveOf.sourceEvidence[0].file = file;
    assert.throws(() => assertEvaluationRecord(history, f.root), /relative path|must not traverse/, file);
  }

  const record = filled('url-led', 'site');
  f.write(record, 'renamed.json');
  assert.throws(() => assertEvaluationRecords(f.records, f.root), /filename must be the runId/);
  rmSync(join(f.records, 'renamed.json'));
  f.write(record);
  assert.equal(assertEvaluationRecords(f.records, f.root), 2);
});
