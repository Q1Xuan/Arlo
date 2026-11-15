export const SIDECAR_RECOVERY_ATTEMPTS: 5;
export const SIDECAR_RECOVERY_BUDGET_MS: 30000;

export interface ClaudeModHost {
  session: { id(): Promise<string> };
  env: { get(name: string): Promise<string | undefined> };
  fs?: { read(path: string): Promise<string> };
  http: {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      text: string;
      json?: () => unknown;
    }>;
  };
  prompt: { submit(input: { text: string }): Promise<{ drop?: string; text?: string } | undefined> };
  /** A host system notice, never model input. */
  ui?: { log(text: string): void };
  clock: {
    now(): Promise<number>;
    every(delayMs: number, callback: () => void): { cancel(): void };
    after(delayMs: number, callback: () => void): { cancel(): void };
  };
}

/** One pending input as the bridge reports it, including its own marker. */
export interface ClaudeModPendingMessage {
  nativeMessageId: string;
  messageId: string;
  text: string;
  correlationMarker?: string;
  fromEndpoint?: string;
  enqueuedAt: string;
}

export interface ClaudeCodeModDispatcherOptions {
  $: ClaudeModHost;
  pollIntervalMs?: number;
  promptSubmitTimeoutMs?: number;
  /** How long an unproven handoff waits for claim evidence before ending unknown. */
  claimEvidenceTimeoutMs?: number;
}

export class ClaudeCodeModDispatcher {
  constructor(options: ClaudeCodeModDispatcherOptions);
  /** Default window for claim evidence before a handoff ends unknown. */
  readonly claimEvidenceTimeoutMs: number;
  isIdle(): boolean;
  onTurnStart(turnId: string, event?: unknown): void;
  onTurnComplete(turnId: string, agentId?: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  report(message: ClaudeModPendingMessage, status: string, reason?: string): Promise<boolean>;
  dispatchMessage(message: ClaudeModPendingMessage): Promise<void>;
}

export function composeSubmittedPrompt(text: string, marker: string): string;

export interface ClaudeModToolHost extends ClaudeModHost {
  command: { register(definition: {
    name: string;
    description: string;
    argumentHint?: string;
    immediate?: true;
  }): Promise<{ command: string }> };
  tool: { register(definition: {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    isDeferred?: boolean;
  }): Promise<{ tool: string }> };
}

export type ClaudeModHook = (
  $: ClaudeModToolHost,
  event: { turnId?: string; agentId?: string; text?: string; sessionId?: string; reason?: string; [key: string]: unknown },
  next: (event: unknown) => Promise<unknown>,
) => unknown;

export function register(on: (event: string, handler: ClaudeModHook) => {
  catch(handler: ClaudeModHook): void;
}): void;
