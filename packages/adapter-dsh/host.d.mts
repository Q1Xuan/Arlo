import type Schema from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionDiscoveryItem, RootConfigurationStatus, RootSendingStatus } from '@arlo/sdk';
import type { ParticipationStatus } from '@arlo/adapter-sdk';
import type { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import type { ContactOptions, HostContext } from './host-types.mjs';

export type { ContactOptions, HostContext } from './host-types.mjs';
export const inject: string[];
export const Config: Schema<ContactOptions>;
export class ArloContactService extends TypertRemoteService {
  constructor(ctx: HostContext, harness: ReturnType<typeof createArloHarnessPlugin>, newSessionModel?: ContactOptions['newSessionModel']);
  harness: ReturnType<typeof createArloHarnessPlugin>;
  newSessionModel: ContactOptions['newSessionModel'];
  list(sessionId: SessionId, signal: AbortSignal): Promise<SessionDiscoveryItem[]>;
  create(sessionId: SessionId, signal: AbortSignal): Promise<SessionDiscoveryItem>;
  participation(sessionId: SessionId, enabled: boolean | null, signal: AbortSignal): Promise<ParticipationStatus>;
  rootConfiguration(sessionId: SessionId, signal: AbortSignal): Promise<RootConfigurationStatus>;
  sendStatus(sessionId: SessionId, signal: AbortSignal): Promise<RootSendingStatus>;
  continueCollaboration(sessionId: SessionId, signal: AbortSignal): Promise<RootSendingStatus>;
  reloadSendingRules(sessionId: SessionId, signal: AbortSignal): Promise<RootSendingStatus>;
}
export function apply(ctx: HostContext, config: ContactOptions): void;
