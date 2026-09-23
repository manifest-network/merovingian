import type { Context, Git } from './registry-publication.mjs';

export const WORKFLOW_FILE: string;
export const ENVIRONMENT: string;
export const REGISTRY_HOST: string;
export const IMAGE_NAME: string;
export const IMAGE: string;
export const DOCKER_HOST: string;
export const SOURCE_URL: string;
export const PLATFORM: Readonly<{ os: string; architecture: string }>;
export const DEFAULT_TIMEOUTS: Readonly<Timeouts>;

export interface Timeouts {
  requestMs: number; layerMs: number; dockerMs: number; saveMs: number; loadMs: number; pushMs: number;
  verifyAttempts: number; verifyIntervalMs: number;
}
type Fetch = typeof fetch;
export interface ProcessResult { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; error?: string }
export type Docker = (args: string[], options?: { timeoutMs?: number; input?: string }) => Promise<ProcessResult>;
export interface RegistryResponse {
  status: number; contentType?: string; digest?: string | null; location?: string | null; contentLength?: string | null; bytes?: Buffer; problem?: string;
}
export interface TagObservation {
  reference: string; observedAt: string; state: 'absent' | 'present' | 'error'; httpStatus?: number; problem?: string;
  digest?: string; mediaType?: string; config?: { digest: string; size: number }; layers?: { digest: string; size: number; mediaType: string }[];
}
export type Evidence = Record<string, any> & { stage: string; outcome: string; passed: boolean };

export function fileSha256(path: string): Promise<string>;
export function request(url: string, options?: { fetch?: Fetch; timeoutMs?: number; method?: string; headers?: Record<string, string>; maxBytes?: number }): Promise<RegistryResponse>;
export function anonymousToken(options: { registry: string; fetch?: Fetch; timeoutMs?: number }): Promise<{ token?: string; problem?: string }>;
export function describeManifest(response: RegistryResponse & { bytes: Buffer; contentType: string }): Omit<TagObservation, 'reference' | 'observedAt' | 'state'>;
export function lookupTag(options: { registry: string; reference: string; fetch?: Fetch; timeoutMs?: number; clock?: () => Date; token?: string }): Promise<TagObservation>;
export function decidePush(tag: TagObservation, configDigest: string): 'push' | 'already-published';
export function verifyPublished(options: {
  registry: string; version: string; digest: string | null; configDigest: string; fetch?: Fetch; timeoutMs?: number; layerTimeoutMs?: number; clock?: () => Date;
}): Promise<Record<string, any> & { passed: boolean; problems: string[] }>;
export function dockerRunner(options: { env: Record<string, string | undefined>; home: string; configDirectory: string }): Docker;
export function checkImageIdentity(image: Record<string, any>, expected: { imageId: string; version: string; sourceRevision: string }): Record<string, any>;

interface CommonOptions {
  cwd?: string; version: string; sourceRevision: string; context: Context; outputDirectory: string;
  registry?: string; fetch?: Fetch; git?: Git; clock?: () => Date; timeouts?: Partial<Timeouts>;
  refreshMain?: (options: { cwd: string; git?: Git }) => void;
}
export function runPreflight(options: CommonOptions & { cwd: string; mode: string; sourceDirectory: string; api?: string; githubToken?: string }): Promise<Evidence>;
export function readTarFiles(path: string, wanted: (name: string) => boolean, options?: { maxBytes?: number }): Promise<Map<string, Buffer>>;
export function archiveIdentity(path: string, expected: { imageId: string; version: string; sourceRevision: string }): Promise<{ configDigest: string }>;
export function runCandidate(options: CommonOptions & { docker: Docker; imageIdFile: string }): Promise<Evidence>;
export function runChecks(options: CommonOptions & { imageId: string; configDigest: string; runtimeReport: string; scanDirectory: string }): Promise<Evidence>;
export function runPublication(options: CommonOptions & {
  cwd: string; docker: Docker; imageId: string; configDigest: string; archiveSha256: string; archive: string; dockerConfigDirectory: string;
  token: string | undefined; username: string | undefined; sleep?: (ms: number) => Promise<unknown>;
}): Promise<Evidence>;
export function renderSummary(evidence: Evidence): string;
export function writeActionsFiles(evidence: Evidence, env: Record<string, string | undefined>): void;
export function parseArgs(args: string[]): { command: string; values: Record<string, string> };
