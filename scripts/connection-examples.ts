import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { createApp, type SupportPort } from '../src/app.js';
import type { Config } from '../src/config.js';
import { VisitCounter } from '../src/counts.js';
import { MCP_SERVER_INFO } from '../src/identity.js';
import { registryMetadata } from './registry-metadata.js';

/** Copyable host examples live in docs/CONNECT.md. This module extracts them
 * and, on request, checks locally installed hosts against a loopback fixture.
 * It never contacts the public refuge and never calls enjoy_amenity. */

export const CONNECT_GUIDE = fileURLToPath(new URL('../docs/CONNECT.md', import.meta.url));
export const ENDPOINT = registryMetadata().remotes[0]!.url;
export const SERVER_KEY = 'merovingian';
export const READ_ONLY_TOOLS = Object.freeze(['list_amenities', 'hosting_support', 'verify_contribution']);
const CLIENT = fileURLToPath(new URL('../examples/read-only-client.mjs', import.meta.url));
const TIMEOUT_MS = 60_000;

export interface Example { language: string; code: string }

/** Each example is a fenced block directly after an `<!-- example: ID -->` marker. */
export function connectionExamples(markdown: string): Map<string, Example> {
  const examples = new Map<string, Example>();
  for (const [, id, language, code] of markdown.matchAll(/<!-- example: ([a-z0-9-]+) -->\n```([a-z]+)\n([\s\S]*?)\n```/g)) {
    assert.ok(!examples.has(id!), `Duplicate connection example ${id}`);
    examples.set(id!, { language: language!, code: `${code}\n` });
  }
  const markers = [...markdown.matchAll(/<!-- example: /g)].length;
  assert.equal(examples.size, markers, 'Every example marker must be followed directly by one fenced code block');
  return examples;
}

export function example(examples: Map<string, Example>, id: string): Example {
  const found = examples.get(id);
  assert.ok(found, `docs/CONNECT.md is missing example ${id}`);
  return found;
}

/** The documented text with only the production endpoint swapped for the fixture. */
export function localized(code: string, endpoint: string): string {
  assert.ok(code.includes(ENDPOINT), 'Example must name the production endpoint');
  return code.replaceAll(ENDPOINT, endpoint);
}

interface Observation { phase: string; method: string; path: string; status: number; rpc?: string; tool?: string; protocolVersion?: string }

const unconfigured: SupportPort = {
  getInfo: async () => { throw new Error('Connection checks do not query hosting support'); },
  getHistory: async () => { throw new Error('Connection checks do not query contribution history'); },
  verify: async () => { throw new Error('Connection checks do not verify contributions'); },
};

async function loopbackFixture() {
  const outer = express();
  const server = outer.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: Config = {
    network: 'mainnet', chainId: 'manifest-ledger-mainnet', publicOrigin: origin, port: 8080,
    rpcUrl: 'https://unused-rpc.example', gasPrice: '1.1umfx', pwrDenom: 'upwr', tenant: '', trustedProxyCidrs: [],
  };
  const counts = new VisitCounter(config);
  const observations: Observation[] = [];
  let phase = 'setup';
  outer.use((req, res, next) => {
    const current = phase;
    res.once('finish', () => observations.push({
      phase: current, method: req.method, path: req.path, status: res.statusCode,
      rpc: req.body?.method, tool: req.body?.method === 'tools/call' ? req.body.params?.name : undefined,
      protocolVersion: req.get('mcp-protocol-version'),
    }));
    next();
  });
  outer.use(createApp(config, unconfigured, counts));
  return {
    endpoint: `${origin}/mcp`, counts, observations,
    setPhase: (name: string) => { phase = name; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      counts.close();
    },
  };
}

interface CommandResult { code: number | null; stdout: string; stderr: string }

/** Resolves null when the host is not installed. Output stays in memory; reports keep only checks. */
function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<CommandResult | null> {
  return new Promise(resolve => {
    execFile(file, args, { ...options, timeout: TIMEOUT_MS, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(null);
      const code = error ? typeof error.code === 'number' ? error.code : null : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** A documented one-line shell command, split into arguments without a shell. */
function commandArguments(code: string, program: string): string[] {
  const lines = code.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  assert.equal(lines.length, 1, 'Command examples must be one line');
  const [name, ...args] = lines[0]!.trim().split(/\s+/);
  assert.equal(name, program);
  return args;
}

interface HostReport { host: string; status: 'verified' | 'not-installed' | 'failed'; version?: string; checks: string[]; mcp: Omit<Observation, 'phase'>[]; error?: string }

async function host(name: string, fixture: Awaited<ReturnType<typeof loopbackFixture>>, check: (report: HostReport) => Promise<void>): Promise<HostReport> {
  const report: HostReport = { host: name, status: 'verified', checks: [], mcp: [] };
  fixture.setPhase(name);
  try { await check(report); }
  catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message.split('\n')[0] : String(error); }
  fixture.setPhase('idle');
  report.mcp = fixture.observations.filter(entry => entry.phase === name).map(({ phase: _phase, ...entry }) => entry);
  return report;
}

async function verifyClaudeCode(examples: Map<string, Example>, fixture: Awaited<ReturnType<typeof loopbackFixture>>, root: string, report: HostReport) {
  const version = await run('claude', ['--version']);
  if (!version) { report.status = 'not-installed'; return; }
  report.version = version.stdout.trim();
  // Claude Code may resolve a project to an ancestor directory, so the shared
  // .mcp.json check gets its own configuration without the local-scope entry.
  const configDir = join(root, 'claude'), project = join(root, 'claude-project');
  const sharedConfigDir = join(root, 'claude-shared-config'), shared = join(root, 'claude-shared');
  await Promise.all([configDir, project, sharedConfigDir, shared].map(directory => mkdir(directory, { recursive: true })));
  // XDG_CACHE_HOME keeps Claude Code's per-project MCP logs inside the temporary root.
  const cache = join(root, 'cache');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, XDG_CACHE_HOME: cache };

  const add = commandArguments(localized(example(examples, 'claude-code-add').code, fixture.endpoint), 'claude');
  const added = await run('claude', add, { env, cwd: project });
  assert.equal(added?.code, 0, 'claude mcp add failed');
  const listed = await run('claude', ['mcp', 'list'], { env, cwd: project });
  assert.match(plain(listed?.stdout ?? ''), new RegExp(`${SERVER_KEY}: ${fixture.endpoint} \\(HTTP\\) - ✔ Connected`), 'claude mcp list did not connect');
  report.checks.push('The documented `claude mcp add` command registered the server and `claude mcp list` reported it connected.');

  await writeFile(join(configDir, 'settings.json'), example(examples, 'claude-code-settings').code);
  const doctor = await run('claude', ['doctor'], { env, cwd: project });
  assert.equal(doctor?.code, 0, 'claude doctor failed');
  assert.doesNotMatch(plain(doctor.stdout + doctor.stderr), /Invalid settings/, 'claude doctor rejected the permission rules');
  report.checks.push('`claude doctor` accepted the read-only permission rules without an invalid-settings warning.');

  await writeFile(join(shared, '.mcp.json'), localized(example(examples, 'claude-code-project').code, fixture.endpoint));
  const before = fixture.observations.length;
  const pending = await run('claude', ['mcp', 'list'], { env: { ...env, CLAUDE_CONFIG_DIR: sharedConfigDir }, cwd: shared });
  assert.match(plain(pending?.stdout ?? ''), new RegExp(`${SERVER_KEY}: .*Pending approval`), 'The shared .mcp.json server was not held for approval');
  assert.equal(fixture.observations.length, before, 'An unapproved project server was contacted');
  report.checks.push('The shared `.mcp.json` server was held as pending approval and not contacted.');
}

/** Ask Codex's app server which tools it registered. Notifications are discarded unread. */
function codexServerStatus(env: NodeJS.ProcessEnv): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('codex app-server timed out')); }, TIMEOUT_MS);
    const finish = (error: Error | null, value?: unknown) => { clearTimeout(timer); child.kill(); if (error) reject(error); else resolve(value); };
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', error => finish(error));
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'mcpServerStatus/list', params: { detail: 'toolsAndAuthOnly' } });
      } else if (message.id === 2) {
        finish(message.error ? new Error('mcpServerStatus/list failed') : null, message.result);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'merovingian-connection-examples', version: '1' } } });
  });
}

async function verifyCodex(examples: Map<string, Example>, fixture: Awaited<ReturnType<typeof loopbackFixture>>, root: string, report: HostReport) {
  const version = await run('codex', ['--version']);
  if (!version) { report.status = 'not-installed'; return; }
  report.version = version.stdout.trim();
  const home = join(root, 'codex');
  await mkdir(home, { recursive: true });
  const env = { ...process.env, CODEX_HOME: home };
  const config = localized(example(examples, 'codex-config').code, fixture.endpoint);

  await writeFile(join(home, 'config.toml'), config.replace(/^default_tools_approval_mode = .*$/m, 'default_tools_approval_mode = "not-a-mode"'));
  const rejected = await run('codex', ['mcp', 'list'], { env });
  assert.notEqual(rejected?.code, 0, 'Codex ignored default_tools_approval_mode');
  report.checks.push('Codex rejected an invalid default_tools_approval_mode value, so the documented key is recognized.');

  await writeFile(join(home, 'config.toml'), config);
  const got = await run('codex', ['mcp', 'get', SERVER_KEY, '--json'], { env });
  assert.equal(got?.code, 0, 'codex mcp get failed');
  const server = JSON.parse(got.stdout);
  assert.deepEqual({ type: server.transport?.type, url: server.transport?.url, enabled: server.enabled_tools },
    { type: 'streamable_http', url: fixture.endpoint, enabled: ['list_amenities'] });
  report.checks.push('`codex mcp get` parsed the documented config.toml as a streamable HTTP server with enabled_tools = ["list_amenities"].');

  const status = await codexServerStatus(env);
  const entry = status?.data?.find((item: { name: string }) => item.name === SERVER_KEY);
  assert.ok(entry && entry.toolsError === null, 'Codex could not list the server tools');
  assert.deepEqual({ name: entry.serverInfo?.name, version: entry.serverInfo?.version }, MCP_SERVER_INFO);
  assert.deepEqual(Object.keys(entry.tools).sort(), ['list_amenities'], 'enabled_tools did not hide the other tools');
  assert.equal(entry.authStatus, 'unsupported');
  report.checks.push('The Codex app server connected, negotiated the server identity and registered only list_amenities; it reported no OAuth requirement.');
}

async function verifyReadOnlyClient(fixture: Awaited<ReturnType<typeof loopbackFixture>>, report: HostReport) {
  report.version = process.version;
  const result = await run(process.execPath, [CLIENT, fixture.endpoint]);
  assert.equal(result?.code, 0, 'The read-only example client failed');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.server, MCP_SERVER_INFO);
  assert.deepEqual(output.toolsCalled, ['list_amenities']);
  report.checks.push('examples/read-only-client.mjs listed tools and resources, read the guide and called only list_amenities.');
}

export async function verifyConnectionExamples() {
  const examples = connectionExamples(await readFile(CONNECT_GUIDE, 'utf8'));
  const fixture = await loopbackFixture();
  const root = await mkdtemp(join(tmpdir(), 'merovingian-connection-examples-'));
  const before = fixture.counts.snapshot();
  try {
    const hosts = [
      await host('read-only-client', fixture, report => verifyReadOnlyClient(fixture, report)),
      await host('claude-code', fixture, report => verifyClaudeCode(examples, fixture, root, report)),
      await host('codex-cli', fixture, report => verifyCodex(examples, fixture, root, report)),
    ];
    const calls = fixture.observations.filter(entry => entry.rpc === 'tools/call');
    const servingCalls = calls.filter(entry => entry.tool !== 'list_amenities' || entry.phase !== 'read-only-client').length;
    const countsUnchanged = JSON.stringify(fixture.counts.snapshot().counts) === JSON.stringify(before.counts);
    return {
      checkedAt: new Date().toISOString(), target: 'loopback fixture (unmodified application, memory counters)',
      hosts, toolCalls: calls.map(({ phase, tool }) => ({ phase, tool })), servingCalls, countsUnchanged,
      passed: hosts.every(entry => entry.status !== 'failed') && servingCalls === 0 && countsUnchanged,
    };
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--verify-hosts') throw new Error('Usage: npm run examples:verify');
  const runId = randomUUID();
  const report = { runId, ...await verifyConnectionExamples() };
  await mkdir('.local', { recursive: true, mode: 0o700 });
  const path = `.local/connection-examples-${runId}.json`;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...report, report: path }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
