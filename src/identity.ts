import { readFileSync } from 'node:fs';

// src/ and compiled dist/ share the same parent package.json, including in Docker.
const packageJson: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!packageJson || typeof packageJson !== 'object' || !('version' in packageJson)
  || typeof packageJson.version !== 'string' || !packageJson.version) {
  throw new Error('package.json must contain an application version');
}

export const APP_VERSION = packageJson.version;
export const MCP_SERVER_NAME = 'io.github.manifest-network/merovingian';
export const MCP_SERVER_INFO = { name: MCP_SERVER_NAME, version: APP_VERSION };
