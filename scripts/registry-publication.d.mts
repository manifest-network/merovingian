export const SERVER_NAME: string;
export const REGISTRY_URL: string;
export const PRODUCTION_ORIGIN: string;
export const REPOSITORY: string;
export const WORKFLOW_FILE: string;
export const ENVIRONMENT: string;
export const PUBLISHER: Readonly<{ version: string; commit: string; asset: string; archiveSha256: string; binarySha256: string }>;
export const DEFAULT_TIMEOUTS: Readonly<Timeouts>;
export const LIVE_MAIN_REF: string;

export interface Timeouts {
  requestMs: number; loginMs: number; publishMs: number; logoutMs: number; validateMs: number;
  acceptanceMs: number; verifyAttempts: number; verifyIntervalMs: number;
}
export class PublicationError extends Error {
  constructor(code: string, message: string);
  code: string;
}
export interface JsonResponse {
  url: string; requestedAt: string; observedAt: string; status: number; contentType?: string; json?: any; bytes?: Buffer; problem?: string;
}
export interface RecordObservation {
  url: string; observedAt: string; httpStatus: number; state: 'absent' | 'present' | 'error'; problem?: string;
  version?: string; status?: string; isLatest?: boolean; publishedAt?: string | null; metadataMatch?: boolean;
}
export interface VersionsObservation {
  url: string; observedAt: string; httpStatus: number; state: 'absent' | 'present' | 'error'; problem?: string;
  versions?: { version: string; status: string; isLatest: boolean }[];
}
export interface RegistryLookup {
  exact: RecordObservation; latest: RecordObservation; versions?: VersionsObservation; exactResponse: JsonResponse;
}
export interface Context { workflowRevision: string; run: { id: string; attempt: number; url: string } | null }
export type Git = (cwd: string, args: string[]) => Buffer;
export type Fetch = typeof fetch;
export type Evidence = Record<string, any> & { stage: string; outcome: string; passed: boolean };

export function parseReleaseVersion(value: unknown): number[];
export function compareVersions(left: string, right: string): -1 | 0 | 1;
export function sanitizeMessage(value: unknown, limit?: number): string;
export function getJson(url: string, options?: {
  fetch?: Fetch; timeoutMs?: number; headers?: Record<string, string>; maxBytes?: number; clock?: () => Date;
}): Promise<JsonResponse>;
export function registryUrls(registry: string, version: string): { exactVersion: string; latest: string; versions: string; serverVersion: string };
export function describeRecord(response: JsonResponse, server: unknown): RecordObservation;
export function lookupRegistry(options: {
  registry?: string; version: string; server: unknown; fetch?: Fetch; timeoutMs?: number; clock?: () => Date; includeVersions?: boolean;
}): Promise<RegistryLookup>;
export function decidePublication(lookup: { exact: RecordObservation; latest: RecordObservation; versions?: VersionsObservation }, version: string):
  { decision: 'publish' | 'already-published'; latestRelation: string };
export function verificationProblems(lookup: { exact: RecordObservation; latest: RecordObservation }, version: string): string[];
export function checkMetadata(bytes: Buffer, version: string, packageVersion: unknown): { server: Record<string, unknown>; sha256: string; bytes: number };
export function checkSource(options: {
  cwd: string; sourceRevision: unknown; workflowRevision: string; mainRef?: string; version: string; git?: Git;
}): { revision: string; workflowRevision: string; mainRevision: string; releaseCommit: boolean; serverJson: Buffer };
export function refreshMain(options: { cwd: string; git?: Git }): void;
export function checkDispatch(env: Record<string, string | undefined>): Context;
export function checkEnvironment(options: {
  api?: string; token?: string; fetch?: Fetch; timeoutMs?: number; clock?: () => Date;
}): Promise<Record<string, any> & { passed: boolean; problems: string[] }>;
export function checkDeployment(options: {
  origin?: string; version: string; fetch?: Fetch; timeoutMs?: number; clock?: () => Date;
}): Promise<Record<string, any> & { passed: boolean; requestsAttempted: number; servingRequestsAttempted: number; problem?: string }>;
export function runProcess(file: string, args: string[], options: {
  cwd?: string; env: Record<string, string>; timeoutMs: number; maxOutput?: number;
}): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; error?: string }>;
export function childEnvironment(source: Record<string, string | undefined>, home: string, extra?: string[]): Record<string, string>;
export function validateWithPublisher(options: {
  publisher: string; serverJsonPath: string; home: string; env: Record<string, string | undefined>; timeoutMs?: number;
}): Promise<Record<string, any> & { passed: boolean }>;
export function acceptanceArguments(origin: string): string[];
export function runAcceptance(options: {
  cwd: string; env: Record<string, string | undefined>; origin?: string; timeoutMs?: number; command?: string[]; clock?: () => Date;
}): Promise<Record<string, any> & { passed: boolean }>;
interface CommonOptions {
  cwd: string; version: string; sourceRevision: string; context: Context; outputDirectory: string;
  env: Record<string, string | undefined>; publisher: string; registry?: string; origin?: string;
  fetch?: Fetch; git?: Git; clock?: () => Date; timeouts?: Partial<Timeouts>; refreshMain?: (options: { cwd: string; git?: Git }) => void;
}
export function runPreflight(options: CommonOptions & {
  mode: string; api?: string; githubToken?: string; acceptanceCommand?: string[];
}): Promise<Evidence>;
export function runPublication(options: CommonOptions & {
  expectedSha256: string; home: string; sleep?: (milliseconds: number) => Promise<unknown>;
}): Promise<Evidence>;
export function renderSummary(evidence: Evidence): string;
export function writeActionsFiles(evidence: Evidence, env: Record<string, string | undefined>): void;
export function parseArgs(args: string[]): { command: string; values: Record<string, string> };
export function repositoryRoot(): string;
