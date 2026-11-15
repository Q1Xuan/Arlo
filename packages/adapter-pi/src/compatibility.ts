import path from 'node:path';
import { VERSION, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { inspectPiEnvironment } from './environment.ts';

// Discrete versions promoted after installed native acceptance; never a range.
export const formalPiVersions: readonly string[] = ['1.1.0', '1.2.0', '1.3.0', '1.4.0'];
export type PiCompatibilityPolicy = 'verified' | 'experimental';

export function missingPiMethods(object: object, methods: readonly string[], prefix: string): string[] {
  return methods.filter(method => typeof Reflect.get(object, method) !== 'function')
    .map(method => `${prefix}.${method}`);
}

/** Read the current public context without submitting input or changing history. */
export function inspectPiCompatibility(pi: ExtensionAPI, ctx: ExtensionContext, policy: PiCompatibilityPolicy) {
  const missing: string[] = [];
  const requireMethods = (object: object, methods: string[], prefix: string) => {
    missing.push(...missingPiMethods(object, methods, prefix));
  };
  let rootContext = false;
  try {
    requireMethods(pi, ['sendMessage', 'sendUserMessage', 'appendEntry'], 'pi');
    requireMethods(ctx, ['isIdle', 'abort'], 'context');
    requireMethods(ctx.ui, ['notify', 'setStatus', 'setEditorComponent', 'getEditorComponent', 'addAutocompleteProvider', 'onTerminalInput', 'select'], 'ui');
    const manager = ctx.sessionManager;
    requireMethods(manager, ['getHeader', 'getSessionId', 'getSessionFile', 'getCwd', 'getEntries', 'getSessionName'], 'sessionManager');
    if (missing.length === 0) {
      const header = manager.getHeader();
      const file = manager.getSessionFile();
      const cwd = manager.getCwd();
      rootContext = ctx.mode === 'tui' && header?.type === 'session' &&
        header === manager.getHeader() && !!header.id && header.id === manager.getSessionId() &&
        !!file && path.isAbsolute(file) && path.isAbsolute(cwd) && header.cwd === cwd &&
        Array.isArray(manager.getEntries()) && typeof ctx.isIdle() === 'boolean';
    }
  } catch { missing.push('current-context-unavailable'); }
  const formal = formalPiVersions.includes(VERSION);
  const requiredContracts = {
    ready: missing.length === 0 && rootContext && (formal || policy === 'experimental'),
    reason: missing.length ? 'MISSING_PI_CAPABILITY' as const : !rootContext ? 'ROOT_CONTEXT_REQUIRED' as const
      : !formal && policy !== 'experimental' ? 'UNSUPPORTED_PI_VERSION' as const : 'SATISFIED' as const,
  };
  return { version: VERSION, policy, formal, missing, rootContext,
    hostSupportPolicy: formal ? 'formal' as const : 'experimental-required' as const, requiredContracts,
    ...inspectPiEnvironment(VERSION) };
}

export type PiCompatibilityReport = ReturnType<typeof inspectPiCompatibility>;
