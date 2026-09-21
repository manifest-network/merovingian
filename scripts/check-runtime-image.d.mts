export interface RuntimeFailure {
  category: string;
  stage: string;
  operation?: string;
  exitCode?: number;
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
export function runRuntimeImageCheck(image: string, output: string, options?: {
  execute?: (args: string[]) => string;
  distribution?: string[];
  pause?: () => Promise<void>;
}): Promise<RuntimeImageReport>;
