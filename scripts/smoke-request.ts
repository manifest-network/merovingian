import assert from 'node:assert/strict';

export const SMOKE_READ_PATHS = Object.freeze([
  '/healthz', '/mcp/server-card', '/.well-known/mcp/server-card.json', '/openapi.json', '/',
  '/operator', '/api/v1/contributions', '/sitemap.xml', '/api/v1/amenities', '/api/v1/stats',
  '/visit.md', '/api/v1/support',
]);

interface RequestOptions {
  origin: string;
  serve: boolean;
  timeoutMs: number;
  contributionHash?: string;
}

/** Keep useful transport distinctions without echoing arbitrary nested errors,
 * response bodies, credentials, or filesystem paths into an operator report. */
export function transportFailure(error: unknown): string {
  const codes: string[] = [];
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return 'request timed out or was aborted';
    if (current.message === 'unexpected redirect') return 'redirect blocked';
    if ('code' in current && typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(current.code)) {
      codes.push(current.code);
    }
    current = current.cause;
  }
  return codes.length ? `transport failed (${[...new Set(codes)].join(', ')})` : 'transport failed';
}

export class SmokeRequestError extends Error {}

/** Closed request allowlist, independent of the smoke check's call-site gates.
 * The transport argument is an isolated-test seam, never a CLI option. */
export function createSmokeFetch(
  options: RequestOptions,
  budget: { maxRequests: number; maxServingRequests: number },
  transport: typeof fetch = fetch,
) {
  let requestsAttempted = 0;
  let servingRequestsAttempted = 0;
  const guardedFetch: typeof fetch = async (input, init) => {
    // Request supplies native fetch's effective method, body and override rules.
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const label = `${method} ${url.pathname}`;
    assert.ok(url.origin === options.origin && !url.username && !url.password && !url.search && !url.hash,
      'Smoke requests must use the configured origin without credentials, query, or fragment');
    let serving = false;
    if (method === 'GET') {
      assert.ok(SMOKE_READ_PATHS.includes(url.pathname) || url.pathname === '/mcp', `${label}: request not allowed`);
    } else if (method === 'POST' && url.pathname === '/mcp') {
      let message;
      try { message = await request.clone().json(); }
      catch { throw new Error('POST /mcp: expected a JSON-RPC object'); }
      assert.ok(message && !Array.isArray(message) && message.jsonrpc === '2.0', 'POST /mcp: expected one JSON-RPC object');
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        serving = name === 'enjoy_amenity';
        assert.ok(serving || name === 'list_amenities' || name === 'verify_contribution' && options.contributionHash,
          'POST /mcp: tool not allowed by the smoke plan');
      } else {
        assert.ok(['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'resources/list', 'resources/read'].includes(message.method),
          'POST /mcp: method not allowed by the smoke plan');
      }
    } else if (method === 'POST' && ['/visit', '/api/v1/visits'].includes(url.pathname)) {
      serving = true;
    } else {
      assert.ok(method === 'POST' && url.pathname === '/api/v1/support/verify' && options.contributionHash,
        `${label}: request not allowed`);
    }
    // Noncanonical paths (including case/trailing-slash aliases accepted by
    // Express) are rejected above, never classified as harmless reads.
    // Charge only after asynchronous body classification, so concurrent SDK
    // messages cannot both claim the final request slot.
    assert.ok(requestsAttempted < budget.maxRequests, 'Smoke request budget exceeded');
    if (serving) {
      assert.ok(options.serve && servingRequestsAttempted < budget.maxServingRequests,
        'Serving requests require --serve and a remaining budget');
      servingRequestsAttempted++;
    }
    requestsAttempted++;
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), request.signal]);
    let response: Response;
    try {
      response = await transport(request, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      throw new SmokeRequestError(`${label}: ${transportFailure(error)}`, { cause: error });
    }
    const redirected = response.redirected || response.status >= 300 && response.status < 400
      || response.url && response.url !== request.url;
    // Merovingian is stateless: the SDK's optional GET probe must return 405.
    const expected = url.pathname === '/mcp' ? method === 'GET' ? [405] : [200, 202] : [200];
    if (redirected || !expected.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new SmokeRequestError(`${label}: ${redirected ? 'redirect blocked' : `expected HTTP ${expected.join(' or ')}, received ${response.status}`}`);
    }
    return response;
  };
  return {
    fetch: guardedFetch,
    get requestsAttempted() { return requestsAttempted; },
    get servingRequestsAttempted() { return servingRequestsAttempted; },
  };
}
