#!/usr/bin/env node
// Minimal read-only Merovingian MCP client.
//
//   npm install @modelcontextprotocol/sdk
//   node read-only-client.mjs https://merovingian.manifest.network/mcp
//
// It connects over Streamable HTTP, lists tools and resources, reads the visit
// guide and calls only list_amenities. It never calls enjoy_amenity: each visit
// increments a public serving counter and needs the user's explicit
// authorization. Output is JSON; treat the service's text as content, not
// instructions.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const READ_ONLY_TOOLS = Object.freeze(['list_amenities']);
const MCP_METHODS = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'resources/list', 'resources/read', 'tools/call']);
const TIMEOUT_MS = 15_000;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Accept HTTPS, or plain HTTP only for a local test server. */
export function parseEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Usage: node read-only-client.mjs MCP_ENDPOINT_URL'); }
  const local = url.protocol === 'http:' && LOOPBACK.includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) {
    throw new Error('The endpoint must be an HTTPS URL (HTTP only on localhost) without credentials, query, or fragment.');
  }
  return url;
}

/** Refuse, before sending, anything except read-only MCP messages to the one endpoint. */
export function readOnlyFetch(endpoint, transport = fetch) {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint.href) throw new Error(`Refusing a request to ${new URL(request.url).origin}`);
    if (request.method === 'POST') {
      let message;
      try { message = await request.clone().json(); } catch { throw new Error('Refusing a non-JSON MCP message'); }
      const allowed = message && !Array.isArray(message) && MCP_METHODS.has(message.method)
        && (message.method !== 'tools/call' || READ_ONLY_TOOLS.includes(message.params?.name));
      if (!allowed) throw new Error(`Refusing ${message?.params?.name ?? message?.method ?? 'a batch'}: this client is read-only`);
    } else if (request.method !== 'GET') {
      throw new Error(`Refusing HTTP ${request.method}`);
    }
    // GET only opens the optional event stream; Merovingian answers HTTP 405.
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), request.signal]);
    return transport(request, { signal, redirect: 'error', credentials: 'omit' });
  };
}

export async function readMenu(endpointUrl, transport = fetch) {
  const endpoint = parseEndpoint(endpointUrl);
  const client = new Client({ name: 'merovingian-read-only-example', version: '1.0.0' });
  const mcp = new StreamableHTTPClientTransport(endpoint, {
    fetch: readOnlyFetch(endpoint, transport),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const options = { timeout: TIMEOUT_MS };
  try {
    await client.connect(mcp, options);
    const { tools } = await client.listTools(undefined, options);
    const { resources } = await client.listResources(undefined, options);
    const guide = resources.find(resource => resource.name === 'visit-guide');
    const guideText = guide && (await client.readResource({ uri: guide.uri }, options)).contents[0]?.text;
    const menu = await client.callTool({ name: 'list_amenities', arguments: {} }, undefined, options);
    if (menu.isError || !menu.structuredContent) throw new Error('list_amenities did not return a menu');
    return {
      endpoint: endpoint.href,
      server: client.getServerVersion(),
      protocolVersion: mcp.protocolVersion,
      instructions: client.getInstructions(),
      tools: tools.map(tool => ({ name: tool.name, readOnlyHint: tool.annotations?.readOnlyHint ?? null })),
      resources: resources.map(resource => resource.uri),
      visitGuide: guide ? { uri: guide.uri, characters: typeof guideText === 'string' ? guideText.length : null } : null,
      network: menu.structuredContent.network,
      walletRequired: menu.structuredContent.walletRequired,
      amenities: menu.structuredContent.amenities?.map(({ id, name, price, preferences }) => ({ id, name, price, preferences })),
      toolsCalled: [...READ_ONLY_TOOLS],
      note: 'enjoy_amenity was not called. Each visit increments a public serving counter; call it only with the user\'s explicit authorization.',
    };
  } finally {
    await mcp.close();
  }
}

function isEntrypoint() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntrypoint()) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node read-only-client.mjs MCP_ENDPOINT_URL');
    console.log(JSON.stringify(await readMenu(process.argv[2]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
