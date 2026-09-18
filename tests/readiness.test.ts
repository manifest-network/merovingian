import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Config } from '../src/config.js';
import { createReadinessRouter, discoveryLinkHeader, readinessDocuments, SKILL_PATH } from '../src/readiness.js';
import { APP_VERSION } from '../src/identity.js';

const config: Config = { network: 'mainnet', chainId: 'manifest-ledger-mainnet', publicOrigin: 'https://merovingian.manifest.network', port: 8080, rpcUrl: 'https://nodes.manifest.network/manifest/rpc', gasPrice: '0.5upwr', pwrDenom: 'upwr', tenant: '', trustProxyHops: 0 };
const documents = readinessDocuments(config);
const readJson = (path: string) => JSON.parse(documents.get(path)!.body);

test('MCP discovery distinguishes current connection metadata from truthful legacy compatibility', () => {
  const current = readJson('/mcp/server-card');
  assert.equal(current.$schema, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json');
  assert.match(current.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.equal(current.version, APP_VERSION);
  assert.ok(current.description.length <= 100);
  assert.equal(current.remotes[0].type, 'streamable-http');
  assert.equal(current.remotes[0].url, `${config.publicOrigin}/mcp`);
  assert.ok(current.remotes[0].supportedProtocolVersions.includes('2025-11-25'));
  assert.equal(current.capabilities, undefined); assert.equal(current.tools, undefined);
  const legacy = readJson('/.well-known/mcp/server-card.json');
  assert.equal(legacy.serverInfo.version, current.version);
  assert.equal(legacy.transport.endpoint, current.remotes[0].url);
  assert.deepEqual(Object.keys(legacy.capabilities), ['tools', 'resources']);
  assert.match(legacy.description, /Legacy/);
});

test('skill discovery digest matches exact served bytes and describes visit side effects', () => {
  const index = readJson('/.well-known/agent-skills/index.json');
  assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  const skill = documents.get(SKILL_PATH)!;
  assert.equal(index.skills.length, 1); assert.equal(index.skills[0].type, 'skill-md');
  assert.equal(index.skills[0].url, `${config.publicOrigin}${SKILL_PATH}`);
  assert.equal(index.skills[0].digest, `sha256:${createHash('sha256').update(skill.body).digest('hex')}`);
  assert.match(skill.body, /^---\nname: visit-merovingian\ndescription:/);
  assert.match(skill.body, /increments.*serving count/);
  assert.match(skill.body, /Repeated requests/);
  assert.match(skill.body, /without recording a visit/);
});

test('API and AI catalogs reference real public interfaces without fabricated authentication or identity', () => {
  const api = readJson('/.well-known/api-catalog');
  assert.ok(api.linkset[0].item.some((item: { href: string }) => item.href === `${config.publicOrigin}/mcp`));
  assert.equal(api.linkset[1]['service-desc'][0].href, `${config.publicOrigin}/openapi.json`);
  assert.match(documents.get('/.well-known/api-catalog')!.contentType, /^application\/linkset\+json/);
  const ai = readJson('/.well-known/ai-catalog.json');
  assert.equal(ai.host.identifier, config.publicOrigin);
  for (const entry of ai.entries) {
    assert.match(entry.identifier, /^urn:air:merovingian\.manifest\.network:/);
    assert.ok(entry.url.startsWith(config.publicOrigin));
    assert.equal(entry.data, undefined);
    assert.ok(entry.representativeQueries.length >= 2);
  }
  assert.equal(documents.has('/.well-known/oauth-authorization-server'), false);
  assert.equal(documents.has('/.well-known/oauth-protected-resource'), false);
  assert.equal(documents.has('/.well-known/agent-card.json'), false);
  const auth = documents.get('/auth.md')!.body;
  assert.match(auth, /^# .*auth\.md/); assert.match(auth, /Authentication method: none/);
  assert.match(auth, /never receives wallet secrets/); assert.match(auth, /not a paid entitlement or studio revenue/);
  assert.match(discoveryLinkHeader(config), /rel="api-catalog"/);
});

test('discovery HTTP supports GET/HEAD, public CORS, exact bytes and unknown-path fallback', async t => {
  const app = express(); app.use(createReadinessRouter(config));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [path, document] of documents) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200); assert.equal(await response.text(), document.body);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('content-type')!, new RegExp(`^${document.contentType.split(';')[0].replace(/[+]/g, '\\+')}`));
    const head = await fetch(origin + path, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.match(head.headers.get('link')!, /api-catalog/);
  }
  assert.equal((await fetch(origin + '/.well-known/agent-skills/unknown/SKILL.md')).status, 404);
});
