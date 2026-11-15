export interface ExtractedTarget {
  host: string | null;
  targetUrl: string | null;
  valid: boolean;
}

export interface NetworkViolationRecord {
  type: string;
  host: string;
  targetUrl: string;
  time: string;
}

export interface SetupNetworkGuardOptions {
  http?: any;
  https?: any;
  globalThis?: any;
  onViolation?: (record: NetworkViolationRecord, list: NetworkViolationRecord[]) => void;
}

export interface NetworkGuardInstance {
  unexpectedExternalCalls: NetworkViolationRecord[];
  denyIfExternal: (args: any[], type: string) => void;
  restore: () => void;
}

export function isLoopback(host: string | null | undefined): boolean;
export function extractHostAndUrl(args: any[], type?: 'http.request' | 'https.request' | 'fetch'): ExtractedTarget;
export function setupNetworkGuard(options?: SetupNetworkGuardOptions): NetworkGuardInstance;
export const name: string;
export function apply(ctx: any): Promise<void>;
