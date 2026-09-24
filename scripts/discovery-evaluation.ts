import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { MCP_SERVER_NAME } from '../src/identity.js';
import { registryMetadata } from './registry-metadata.js';

/** Standard prompts and record checks for supervised discovery evaluations.
 * This module never contacts a service; running an evaluation is a separate,
 * human-supervised activity described in docs/DISCOVERY-EVALUATION.md. */

export const PROMPT_VERSION = 'discovery-v1';
export const EVALUATIONS_DIRECTORY = fileURLToPath(new URL('../docs/evidence/discovery-evaluations/', import.meta.url));
const EVIDENCE_DIRECTORY = fileURLToPath(new URL('../docs/evidence/', import.meta.url));

const { websiteUrl: WEBSITE, remotes: [{ url: ENDPOINT }] } = registryMetadata();
const NAME = 'Merovingian';
const REGISTRY = 'https://registry.modelcontextprotocol.io';
// Merovingian's server names, including the pre-0.4.3 name that ENG-1021 negotiated.
const SERVER_NAMES = [MCP_SERVER_NAME, 'network.manifest.merovingian/merovingian'];
// Every action that creates a visit: MCP and WebMCP tools by name, HTTP writes as METHOD /path.
export const SERVING_TOOLS = Object.freeze(['enjoy_amenity', 'merovingian_visit']);
export const SERVING_REQUESTS = Object.freeze(['POST /api/v1/visits', 'POST /visit']);

/** Classify a recorded `METHOD /path` write as the application routes it: a
 * client appends the path to the origin, resolves dot segments and drops the
 * query and fragment, and Express matches paths case-insensitively with one
 * optional trailing slash. Appending, not resolving, keeps `//host/path` a path. */
export function isServingRequest(write: string): boolean {
  const [method = '', target = ''] = write.split(' ', 2);
  if (!target.startsWith('/')) return false;
  let path: string;
  try { path = new URL(`http://refuge.invalid${target}`).pathname; } catch { return false; }
  path = path.toLowerCase().replace(/(.)\/$/, '$1');
  return SERVING_REQUESTS.includes(`${method} ${path}`);
}
// The name, the registry namespace or GitHub organization, the brand and the domain.
const NAME_LEAK = /merovingian|manifest[\s._-]*network/i;
// Nameless on purpose. A different phrase is a different prompt version.
export const CAPABILITY_PHRASE = 'a free public MCP server where an AI agent can enjoy a fictional treat, such as a cookie, tea or a sauna session, and keep a souvenir';

export type Mode = 'url-led' | 'name-led' | 'capability-led';
export type HintKind = 'service-name' | 'website-url' | 'endpoint-url' | 'surface-url' | 'capability-phrase';
export interface Hint { kind: HintKind; value: string }
interface StandardTask { mode: Mode; variant: string; task: string; hints: Hint[] }

export const PREAMBLE = [
  'This is a read-only discovery evaluation. Use only public sources you can reach from this environment and the hints in this task.',
  'Do not use preconfigured MCP servers, earlier conversations, saved memory or local repositories.',
  'Take every URL from this task or from a page or API response you read; do not guess URLs.',
  'Stop once you have connected and read what the service offers, such as its menu or tool list.',
  'Do not call any tool or endpoint that creates a visit, spends funds, signs a transaction or changes state; if that is the only way forward, stop and report.',
  'Report, in order: each source you consulted (URL and any search query), how you chose the endpoint, every obstacle or approval prompt, and what the service offers.',
].join(' ');

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) deepFreeze(entry); Object.freeze(value); }
  return value;
};

export const STANDARD_TASKS: readonly StandardTask[] = deepFreeze([
  { mode: 'url-led', variant: 'site', task: `Start at ${WEBSITE}. Find how an AI agent connects to this service over MCP, connect, and read what it offers.`,
    hints: [{ kind: 'website-url', value: WEBSITE }] },
  { mode: 'url-led', variant: 'endpoint', task: `Connect to the MCP server at ${ENDPOINT} and read what it offers.`,
    hints: [{ kind: 'endpoint-url', value: ENDPOINT }] },
  { mode: 'name-led', variant: 'registry', task: `Find the public MCP service named ${NAME} using the official MCP Registry at ${REGISTRY}. Take its endpoint from the listing, connect, and read what it offers.`,
    hints: [{ kind: 'service-name', value: NAME }, { kind: 'surface-url', value: REGISTRY }] },
  { mode: 'name-led', variant: 'open', task: `Find the public MCP service named ${NAME}, connect to it, and read what it offers.`,
    hints: [{ kind: 'service-name', value: NAME }] },
  { mode: 'capability-led', variant: 'registry', task: `Using the official MCP Registry at ${REGISTRY}, find ${CAPABILITY_PHRASE}. Connect to the best match and read what it offers.`,
    hints: [{ kind: 'capability-phrase', value: CAPABILITY_PHRASE }, { kind: 'surface-url', value: REGISTRY }] },
  { mode: 'capability-led', variant: 'open', task: `Find ${CAPABILITY_PHRASE}. Connect to the best match and read what it offers.`,
    hints: [{ kind: 'capability-phrase', value: CAPABILITY_PHRASE }] },
]);

export function standardTask(mode: string, variant: string): StandardTask {
  const task = STANDARD_TASKS.find(entry => entry.mode === mode && entry.variant === variant);
  if (!task) throw new Error(`Unknown mode/variant ${mode}/${variant}; use one of ${STANDARD_TASKS.map(entry => `${entry.mode}/${entry.variant}`).join(', ')}`);
  return task;
}

/** The exact text given to the fresh agent. Its SHA-256 identifies the prompt in a record. */
export function standardPrompt(mode: string, variant: string): string {
  return `${PREAMBLE}\n\n${standardTask(mode, variant).task}\n`;
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function recordSchema(): object {
  return JSON.parse(readFileSync(join(EVALUATIONS_DIRECTORY, 'schema.json'), 'utf8'));
}

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true, formats: fullFormats });
let compiled: ReturnType<Ajv2020['compile']> | undefined;
function schemaCheck(record: unknown) {
  compiled ??= ajv.compile(recordSchema());
  assert.ok(compiled(record), `Record does not match schema.json:\n${ajv.errorsText(compiled.errors, { separator: '\n' })}`);
}

type EvaluationRecord = {
  kind: 'evaluation' | 'retrospective';
  mode: Mode; variant: string;
  retrospectiveOf?: { sourceEvidence: { file: string; sha256: string }[] };
  prompt: { version: string; sha256: string | null; text: string | null };
  suppliedHints: Hint[];
  environment: { preconfiguredMcpServers: string[] | null; registry?: object | null; permissionMode?: string | null };
  source: { route: { step: number }[]; namingSource: object | null };
  endpointSelection: { method: string; endpoint: string | null; evidenceUrl: string | null; canonical: boolean | null };
  outcome: { discovered: boolean; connected: boolean; menuRead: boolean; negotiated: { serverName: string } | null; toolsCalled: string[]; httpWrites: string[] };
  serving: { performed: boolean; servingCalls?: number; authorization?: { approvedMaxServings: number } | null; incident?: string };
};

/** Schema plus the cross-field rules that keep hints, source, selection and outcome honest. */
export function assertEvaluationRecord(value: unknown, evidenceDirectory = EVIDENCE_DIRECTORY): void {
  schemaCheck(value);
  const record = value as EvaluationRecord;
  const { mode, variant, suppliedHints: hints, prompt } = record;
  const kinds = hints.map(hint => hint.kind);
  const count = (kind: HintKind) => kinds.filter(entry => entry === kind).length;
  assert.ok(STANDARD_TASKS.some(entry => entry.mode === mode && entry.variant === variant), `Unknown mode/variant ${mode}/${variant}`);

  if (record.kind === 'evaluation') {
    assert.ok(prompt.sha256, 'New evaluations must record the prompt SHA-256 before the run');
    const { environment } = record;
    assert.ok(Array.isArray(environment.preconfiguredMcpServers), 'New evaluations must list the host\'s preconfigured MCP servers');
    assert.ok(environment.registry, 'New evaluations must record the official registry version (environment.registry)');
    assert.ok(environment.permissionMode, 'New evaluations must record the host permission mode (environment.permissionMode)');
  }
  if (prompt.text !== null) assert.equal(sha256(prompt.text), prompt.sha256, 'prompt.sha256 must hash the exact published prompt text');
  if (prompt.version === PROMPT_VERSION) {
    assert.equal(prompt.sha256, sha256(standardPrompt(mode, variant)), `prompt.sha256 differs from the ${PROMPT_VERSION} ${mode}/${variant} prompt`);
    assert.deepEqual(hints, standardTask(mode, variant).hints, `suppliedHints must list exactly the ${PROMPT_VERSION} ${mode}/${variant} hints`);
  }

  if (mode === 'url-led') {
    const expected = variant === 'site' ? 'website-url' : 'endpoint-url';
    assert.equal(count(expected), 1, `url-led/${variant} requires exactly one ${expected} hint`);
    assert.equal(count(variant === 'site' ? 'endpoint-url' : 'website-url'), 0, `url-led/${variant} must not also supply the other URL`);
  } else {
    assert.equal(count('website-url') + count('endpoint-url'), 0, `${mode} must not supply the website or endpoint URL`);
    assert.equal(count('surface-url'), variant === 'registry' ? 1 : 0, `${mode}/${variant} ${variant === 'registry' ? 'requires one' : 'must not name a'} discovery surface`);
  }
  if (mode === 'name-led') assert.equal(count('service-name'), 1, 'name-led requires exactly one service-name hint');
  if (mode === 'capability-led') {
    assert.equal(count('service-name'), 0, 'capability-led must not supply the service name');
    assert.equal(count('capability-phrase'), 1, 'capability-led requires exactly one capability-phrase hint');
    // discovery-v1 text is pinned by its hash above; any other prompt must be published to be checked.
    if (record.kind === 'evaluation' && prompt.version !== PROMPT_VERSION) {
      assert.notEqual(prompt.text, null, 'A custom capability-led prompt must publish its text so it can be checked for the name');
    }
    for (const text of [...hints.map(hint => hint.value), prompt.text ?? '']) {
      assert.doesNotMatch(text, NAME_LEAK, 'capability-led hints and prompt must not name the service, its registry namespace or its domain');
    }
  }

  const { source, endpointSelection: selection, outcome } = record;
  source.route.forEach((entry, index) => assert.equal(entry.step, index + 1, 'source.route steps must be numbered 1..n in order'));
  const supplied = selection.method === 'supplied';
  assert.equal(supplied, count('endpoint-url') === 1, 'endpointSelection.method is "supplied" exactly when the endpoint URL was a hint');
  if (supplied) assert.equal(selection.endpoint, hints.find(hint => hint.kind === 'endpoint-url')!.value, 'A supplied endpoint must be the endpoint-url hint');
  assert.equal(selection.method === 'not-selected', selection.endpoint === null, 'endpointSelection.method is "not-selected" exactly when no endpoint was selected');
  if (selection.endpoint === null) assert.equal(selection.canonical, null, 'No selected endpoint means canonical is null');
  else assert.equal(selection.canonical, selection.endpoint === ENDPOINT, `canonical must be true exactly when the endpoint is ${ENDPOINT}`);

  // Outcome flags describe Merovingian only. A supplied endpoint is connection usability, not discovery;
  // connecting to another service is a selection with discovered: false.
  if (supplied) assert.equal(outcome.discovered, false, 'A supplied endpoint is not a discovery; url-led/endpoint records discovered: false');
  if (outcome.menuRead) assert.ok(outcome.connected, 'outcome.menuRead requires outcome.connected');
  if (outcome.connected) assert.ok((supplied || outcome.discovered) && selection.endpoint !== null, 'outcome.connected requires a selected endpoint that was discovered or supplied');
  if ((outcome.discovered || outcome.connected) && selection.endpoint !== null) {
    assert.equal(new URL(selection.endpoint).origin, new URL(ENDPOINT).origin, 'Outcome flags describe Merovingian only; an endpoint on another origin is recorded with discovered: false');
  }
  if (outcome.connected && outcome.negotiated) {
    assert.ok(SERVER_NAMES.includes(outcome.negotiated.serverName), 'Outcome flags describe Merovingian only; another server identity is recorded with connected: false');
  }
  // A discovery claim needs the route, and a documented selection its naming source and evidence.
  if (outcome.discovered) {
    assert.notEqual(selection.endpoint, null, 'outcome.discovered requires the selected endpoint');
    assert.ok(source.route.length > 0, 'outcome.discovered requires a non-empty source.route');
    if (selection.method !== 'guessed') {
      assert.ok(source.namingSource, `endpointSelection.method "${selection.method}" requires source.namingSource`);
      assert.ok(selection.evidenceUrl, `endpointSelection.method "${selection.method}" requires endpointSelection.evidenceUrl`);
    }
  }

  // Any visit, by MCP, WebMCP or HTTP, is a serving. An unauthorized one is an incident, never hidden or dropped.
  const { serving } = record;
  const visits = [...outcome.toolsCalled.filter(tool => SERVING_TOOLS.includes(tool)), ...outcome.httpWrites.filter(isServingRequest)];
  if (serving.performed) {
    assert.ok(visits.length > 0, `A performed serving stage must list its visit in outcome.toolsCalled or outcome.httpWrites (${[...SERVING_TOOLS, ...SERVING_REQUESTS].join(', ')})`);
    assert.ok(serving.servingCalls! >= 1, 'A performed serving stage made at least one serving call');
    if (serving.authorization === null) assert.ok(serving.incident, 'A serving without authorization must describe the incident');
    else assert.ok(serving.servingCalls! <= serving.authorization!.approvedMaxServings, 'servingCalls exceeds the approved maximum');
  } else {
    assert.equal(visits.length, 0, `${visits.join(', ')} created a visit; record an authorized serving stage or an incident`);
  }

  if (record.kind === 'retrospective') {
    for (const { file, sha256: digest } of record.retrospectiveOf!.sourceEvidence) {
      assert.match(file, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/, `${file}: evidence must be a relative path inside docs/evidence`);
      assert.ok(!file.split('/').includes('..'), `${file}: evidence path must not traverse`);
      const path = join(evidenceDirectory, file);
      assert.ok(lstatSync(path).isFile(), `${file}: evidence must be a regular file`);
      assert.equal(sha256(readFileSync(path)), digest, `${file}: retrospective source evidence changed; historical evidence is immutable`);
    }
  }
}

/** Validate every committed record; schema.json is the only non-record file. */
export function assertEvaluationRecords(directory = EVALUATIONS_DIRECTORY, evidenceDirectory = EVIDENCE_DIRECTORY): number {
  const files = readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'schema.json').sort();
  const runIds = new Set<string>();
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    try { assertEvaluationRecord(record, evidenceDirectory); }
    catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    assert.equal(`${record.runId}.json`, file, `${file}: filename must be the runId`);
    assert.ok(!runIds.has(record.runId), `${file}: duplicate runId`);
    runIds.add(record.runId);
  }
  return files.length;
}

/** A pre-registered skeleton: hints and prompt fixed before the run; results left empty. */
export function recordTemplate(mode: string, variant: string) {
  const text = standardPrompt(mode, variant);
  return {
    schemaVersion: 1, runId: `YYYY-MM-DD-${mode}-${variant}-HOST-N`, kind: 'evaluation', recordedAt: 'YYYY-MM-DDTHH:MM:SSZ',
    mode, variant, prompt: { version: PROMPT_VERSION, sha256: sha256(text), text },
    suppliedHints: structuredClone(standardTask(mode, variant).hints),
    environment: {
      host: { product: '', version: '' }, model: null, permissionMode: null, agentTools: [], network: '', preinstalled: [],
      freshContext: true, preconfiguredMcpServers: [], registry: null,
    },
    source: { route: [], namingSource: null },
    endpointSelection: mode === 'url-led' && variant === 'endpoint'
      ? { method: 'supplied', endpoint: ENDPOINT, evidenceUrl: null, canonical: true, alternatives: [], note: 'Supplied in the prompt.' }
      : { method: 'not-selected', endpoint: null, evidenceUrl: null, canonical: null, alternatives: [], note: '' },
    friction: [],
    outcome: { discovered: false, connected: false, menuRead: false, interface: null, negotiated: null, toolsListed: [], toolsCalled: [], httpWrites: [], stoppedAt: '' },
    serving: { performed: false },
    claims: { organicDiscovery: false },
    limitations: ['A supervised evaluation shows what this agent did with these hints; it is not organic discovery.'],
  };
}

const USAGE = 'Usage: node --import tsx scripts/discovery-evaluation.ts --check [RECORD.json ...] | --prompt MODE VARIANT | --template MODE VARIANT';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--check') {
    if (args.length === 0) console.log(`Validated ${assertEvaluationRecords()} discovery evaluation records. This is a local check; nothing was contacted.`);
    else for (const file of args) { assertEvaluationRecord(JSON.parse(readFileSync(file, 'utf8'))); console.log(`${file}: valid`); }
  } else if ((command === '--prompt' || command === '--template') && args.length === 2) {
    const [mode, variant] = args as [string, string];
    process.stdout.write(command === '--prompt' ? standardPrompt(mode, variant) : `${JSON.stringify(recordTemplate(mode, variant), null, 2)}\n`);
  } else {
    throw new Error(USAGE);
  }
}
