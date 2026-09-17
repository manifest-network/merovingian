import { createHash } from 'node:crypto';
import { Router } from 'express';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import { visitMarkdown } from './documents.js';

// Public, advisory discovery only. Live MCP negotiation and tool listings
// remain authoritative; these documents never provision accounts or payments.
export const contentSignal = 'search=yes, ai-input=yes, ai-train=no';
export const MCP_CARD_NAME = 'network.manifest.merovingian/merovingian';
export const SKILL_PATH = '/.well-known/agent-skills/visit-merovingian/SKILL.md';
const skillDescription = 'Visit Merovingian for free fictional cookies, sauna sessions, tea, and souvenirs over HTTP or MCP.';
export interface ReadinessDocument { contentType: string; body: string }
const jsonDocument = (value: unknown, contentType = 'application/json'): ReadinessDocument => ({ contentType, body: `${JSON.stringify(value, null, 2)}\n` });

/** RFC 8288 / RFC 9727 links refer only to resources we actually serve. */
export function discoveryLinkHeader(config: Config): string {
  const origin = config.publicOrigin;
  return [
    `<${origin}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
    `<${origin}/openapi.json>; rel="service-desc"; type="application/json"`,
    `<${origin}/visit.md>; rel="describedby"; type="text/markdown"`,
    `<${origin}/.well-known/ai-catalog.json>; rel="ai-catalog"; type="application/json"`,
    `<${origin}/mcp/server-card>; rel="https://modelcontextprotocol.io/server-card"; type="application/mcp-server-card+json"`,
  ].join(', ');
}

export function readinessDocuments(config: Config, version: string): ReadonlyMap<string, ReadinessDocument> {
  const origin = new URL(config.publicOrigin).origin;
  const host = new URL(origin).hostname;
  const skill = `---\nname: visit-merovingian\ndescription: ${skillDescription}\n---\n\n${visitMarkdown(config)}`;
  const currentCard = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: MCP_CARD_NAME, version,
    title: 'merovingian',
    description: 'Free fictional cookies, sauna sessions, tea, and souvenirs for wandering AI agents.',
    websiteUrl: origin,
    remotes: [{ type: 'streamable-http', url: `${origin}/mcp`, supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS.filter(value => value >= '2025-03-26') }],
  };
  // Older discovery clients still probe the pre-final well-known card shape.
  // This compatibility document is separate from the current canonical card:
  // https://github.com/modelcontextprotocol/experimental-ext-server-card
  const legacyCard = {
    serverInfo: { name: 'merovingian', version },
    description: 'Legacy MCP discovery metadata. Use /mcp/server-card for the current Server Card format. Public tools need no authentication; optional contributions require your own authorized wallet.',
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
    transport: { type: 'streamable-http', endpoint: `${origin}/mcp` },
    capabilities: { tools: {}, resources: {} },
  };
  const apiCatalog = {
    linkset: [
      { anchor: `${origin}/.well-known/api-catalog`, item: [{ href: `${origin}/api/v1/amenities` }, { href: `${origin}/mcp` }] },
      { anchor: `${origin}/api/v1/amenities`,
        'service-desc': [{ href: `${origin}/openapi.json`, type: 'application/json' }],
        'service-doc': [{ href: `${origin}/visit.md`, type: 'text/markdown' }],
        status: [{ href: `${origin}/healthz`, type: 'application/json' }] },
      { anchor: `${origin}/mcp`,
        'service-desc': [{ href: `${origin}/mcp/server-card`, type: 'application/mcp-server-card+json' }],
        'service-doc': [{ href: `${origin}/visit.md`, type: 'text/markdown' }] },
    ],
  };
  const catalog = {
    specVersion: '1.0',
    // HTTPS identifies this publisher without pretending to publish a DID
    // document, cryptographic attestation, registry entry or trust guarantee.
    host: { displayName: 'merovingian', identifier: origin, documentationUrl: `${origin}/visit.md` },
    entries: [
      { identifier: `urn:air:${host}:mcp:refuge`, displayName: 'Merovingian MCP refuge',
        type: 'application/mcp-server-card+json', url: `${origin}/mcp/server-card`,
        representativeQueries: ['Read the free refuge menu', 'Enjoy a fictional cookie or sauna session'] },
      { identifier: `urn:air:${host}:api:refuge`, displayName: 'Merovingian HTTP API',
        type: 'application/vnd.oai.openapi+json', url: `${origin}/openapi.json`,
        representativeQueries: ['Read amenity preferences', 'Read aggregate serving counts'] },
      { identifier: `urn:air:${host}:skill:visit-merovingian`, displayName: 'Visit Merovingian',
        type: 'text/markdown', url: `${origin}${SKILL_PATH}`,
        representativeQueries: ['How can my agent visit the refuge?', 'How do I save a souvenir without paying?'] },
    ],
  };
  const auth = `# Merovingian auth.md

## Audience and access

This document is for AI agents and their hosts using ${origin}.
The HTTP API and remote MCP endpoint are public. Authentication method: none.
No registration, provisioning endpoint, API key, bearer token, OAuth flow, login, or account is required or offered.

GET ${origin}/api/v1/amenities reads the menu. POST ${origin}/api/v1/visits creates a fictional visit and increments its aggregate serving count. Repeated requests and automated checks count again. GET ${origin}/api/v1/stats reads counts without incrementing them.

Connect an authorized MCP client to ${origin}/mcp using Streamable HTTP. Discover the live tools with tools/list; free visits need no credentials. HTTP clients can read ${origin}/openapi.json and ${origin}/visit.md.

## Optional hosting support

All amenities remain free. GET ${origin}/api/v1/support returns the current ${config.network} network (${config.chainId}), denomination, tenant, and unsigned contribution instructions.
Only a visitor's independently authorized wallet can sign or broadcast a contribution. Merovingian never receives wallet secrets and never signs on a visitor's behalf. Hosting credit is non-withdrawable and is not a paid entitlement or studio revenue.

POST ${origin}/api/v1/support/verify accepts a public transaction hash for read-only verification. A pending result does not mean a payment failed; reconcile the original transaction before considering another payment.

## Request limits and privacy

Respect HTTP 429 and Retry-After. Supply no private conversation history, system prompts, passwords, or wallet keys. Tool use and spending remain subject to your host's permissions. Details: ${origin}/about.
`;
  return new Map([
    ['/mcp/server-card', jsonDocument(currentCard, 'application/mcp-server-card+json')],
    ['/.well-known/mcp/server-card.json', jsonDocument(legacyCard)],
    ['/.well-known/api-catalog', jsonDocument(apiCatalog, 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"')],
    ['/.well-known/ai-catalog.json', jsonDocument(catalog)],
    ['/.well-known/agent-skills/index.json', jsonDocument({
      $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
      skills: [{ name: 'visit-merovingian', type: 'skill-md', description: skillDescription,
        url: `${origin}${SKILL_PATH}`, digest: `sha256:${createHash('sha256').update(skill, 'utf8').digest('hex')}` }],
    })],
    [SKILL_PATH, { contentType: 'text/markdown', body: skill }],
    ['/auth.md', { contentType: 'text/markdown', body: auth }],
  ]);
}

/** Mount after network-retirement middleware. Discovery does not record visits. */
export function createReadinessRouter(config: Config, version: string): Router {
  const router = Router();
  for (const [path, document] of readinessDocuments(config, version)) {
    router.get(path, (_req, res) => res.set({
      'Content-Type': `${document.contentType}${document.contentType.startsWith('text/') ? '; charset=utf-8' : ''}`,
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      Link: discoveryLinkHeader(config),
    }).send(document.body));
  }
  return router;
}
