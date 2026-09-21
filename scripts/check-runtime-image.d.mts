export interface RuntimeFailure {
  category: string;
  stage: string;
  operation?: string;
  exitCode?: number;
  containerExitCode?: number;
  probeCheck?: string;
}
export interface RuntimeImageReport {
  checkedAt: string;
  passed: boolean;
  imageId?: string;
  completedChecks: string[];
  executions: Record<string, unknown>[];
  error?: RuntimeFailure;
  cleanup: { containersAttempted: number; volumesAttempted: number; failures: RuntimeFailure[] };
  [key: string]: unknown;
}
export function expectedDistribution(root?: string): string[];
export const healthcheckCommand: string[];
export const healthcheckCases: {
  name: string; code: number; port?: string; proxy?: boolean; status?: number;
  raw?: string; drip?: boolean; deadline?: boolean; invalidPort?: boolean;
  bodyBytes?: number; hangBody?: boolean; hang?: boolean; redirectPort?: number;
}[];
export function healthcheckProbe(command: string[]): string;
export function runRuntimeImageCheck(image: string, output: string, options?: {
  execute?: (args: string[]) => string;
  distribution?: string[];
  pause?: () => Promise<void>;
}): Promise<RuntimeImageReport>;
