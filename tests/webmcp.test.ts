import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { getAmenities } from '../src/amenities.js';
import { webMcpScript } from '../src/webmcp.js';

interface ToolResult { isError?: boolean; content: { type: string; text: string }[] }
interface Tool {
  name: string; description: string; inputSchema: any; annotations: { readOnlyHint: boolean };
  execute(input?: unknown, options?: { signal?: AbortSignal }): Promise<ToolResult>;
}
type BrowserFetch = (path: string, options: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

function browser(options: { placement?: 'document' | 'navigator' | 'both' | 'none'; loading?: boolean; fetch?: BrowserFetch; failRegistration?: boolean; timer?: (callback: () => void, delay: number) => unknown } = {}) {
  const tools: Tool[] = [];
  const registrations: AbortSignal[] = [];
  const calls: { path: string; options: RequestInit }[] = [];
  const events = new Map<string, () => void>();
  const context = { registerTool(tool: Tool, settings: { signal: AbortSignal }) {
    if (options.failRegistration) throw new Error('disabled');
    tools.push(tool); registrations.push(settings.signal);
  } };
  const placement = options.placement ?? 'navigator';
  const document = { readyState: options.loading ? 'loading' : 'complete',
    modelContext: placement === 'document' || placement === 'both' ? context : undefined,
    addEventListener(name: string, callback: () => void, settings: { once: boolean }) { assert.equal(settings.once, true); events.set(name, callback); },
  };
  const navigator = { modelContext: placement === 'navigator' ? context : placement === 'both' ? { registerTool() { throw new Error('legacy should not register twice'); } } : undefined };
  const fetch: BrowserFetch = async (path, settings) => {
    calls.push({ path, options: settings });
    return options.fetch ? options.fetch(path, settings) : { ok: true, json: async () => ({ source: path }) };
  };
  runInNewContext(webMcpScript, { document, navigator, fetch, AbortController, setTimeout: options.timer ?? setTimeout, clearTimeout }, { timeout: 1000 });
  return { tools, calls, events, registrations };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('WebMCP registers real tools through current or legacy API, preferring current without duplicates', async () => {
  for (const placement of ['document', 'navigator', 'both'] as const) {
    const b = browser({ placement }); await flush();
    assert.deepEqual(b.tools.map(tool => tool.name), ['merovingian_menu', 'merovingian_visit']);
    assert.equal(b.tools[0]!.annotations.readOnlyHint, true);
    assert.equal(b.tools[1]!.annotations.readOnlyHint, false);
    assert.match(b.tools[1]!.description, /repeated calls count again/);
    assert.equal(b.calls.length, 0, 'registration never performs a visit or network request');
  }
});

test('WebMCP safely skips unsupported browsers and waits for DOM readiness only once', async () => {
  const unsupported = browser({ placement: 'none' }); await flush();
  assert.equal(unsupported.tools.length, 0); assert.equal(unsupported.calls.length, 0);
  const b = browser({ loading: true }); await flush();
  assert.equal(b.tools.length, 0);
  b.events.get('DOMContentLoaded')!(); b.events.get('DOMContentLoaded')!(); await flush();
  assert.equal(b.tools.length, 2); assert.equal(b.calls.length, 0);
  browser({ failRegistration: true }); await flush();
});

test('WebMCP visit schema follows the live menu and restricts input fields and seeds', async () => {
  const b = browser(); await flush();
  const schema = b.tools[1]!.inputSchema; const menu = getAmenities();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(plain(schema.required), ['amenity']);
  assert.deepEqual(plain(schema.properties.amenity.enum), menu.map(item => item.id));
  assert.deepEqual(plain(schema.properties.preference.enum), menu.flatMap(item => item.preferences));
  assert.equal(schema.properties.seed.minLength, 1); assert.equal(schema.properties.seed.maxLength, 64);
  assert.match(schema.properties.preference.description, /server validates the pairing/);
});

test('WebMCP executes only fixed same-origin menu GET and visit POST with exact public results', async () => {
  const b = browser(); await flush();
  const menu = await b.tools[0]!.execute({ url: 'https://untrusted.invalid/' });
  const visitInput = { amenity: 'null-tea', preference: 'glass', seed: 'ephemeral' };
  const result = await b.tools[1]!.execute(visitInput);
  assert.deepEqual(b.calls.map(call => [call.path, call.options.method]), [['/api/v1/amenities', 'GET'], ['/api/v1/visits', 'POST']]);
  for (const call of b.calls) {
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.mode, 'same-origin');
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.referrerPolicy, 'no-referrer'); assert.ok(call.options.signal);
  }
  assert.equal(b.calls[0]!.options.body, undefined);
  assert.equal(b.calls[1]!.options.body, JSON.stringify(visitInput));
  assert.equal((b.calls[1]!.options.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.deepEqual(plain(menu), { content: [{ type: 'text', text: '{"source":"/api/v1/amenities"}' }] });
  assert.deepEqual(plain(result), { content: [{ type: 'text', text: '{"source":"/api/v1/visits"}' }] });
});

test('WebMCP rejects HTTP, network, and invalid JSON failures without echoing details or retrying', async () => {
  const failures: BrowserFetch[] = [
    async () => ({ ok: false, json: async () => ({ error: 'private server detail' }) }),
    async () => { throw new Error('private network detail'); },
    async () => ({ ok: true, json: async () => { throw new Error('private parse detail'); } }),
  ];
  for (const fetch of failures) {
    const b = browser({ fetch }); await flush();
    const result = await b.tools[1]!.execute({ amenity: 'rgb-sauna' });
    assert.equal(result.isError, true); assert.equal(b.calls.length, 1);
    assert.match(result.content[0]!.text, /Do not automatically retry/);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('WebMCP propagates cancellation and bounds each request to fifteen seconds', async () => {
  let timeout: (() => void) | undefined;
  const b = browser({ timer(callback, delay) { assert.equal(delay, 15000); timeout = callback; return 0; },
    fetch: async (_path, options) => new Promise((_resolve, reject) => {
      if (options.signal!.aborted) reject(new Error('aborted'));
      else options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }); await flush();
  const caller = new AbortController();
  const cancelled = b.tools[0]!.execute({}, { signal: caller.signal }); caller.abort();
  assert.equal((await cancelled).isError, true);
  const timedOut = b.tools[1]!.execute({ amenity: 'null-tea' }); timeout!();
  assert.equal((await timedOut).isError, true); assert.equal(b.calls.length, 2);
});
