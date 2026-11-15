import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionDiscoveryItem, RootConfigurationStatus, RootSendingStatus } from '@arlo/sdk';
import type { ParticipationStatus } from '@arlo/adapter-sdk';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from './client.cjs';

export type ClientContext = Context;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    arloContact: 'section' | 'unavailable' | 'contact' | 'untitled' | 'new' | 'creating' | 'ready' | 'modelUnavailable'
      | 'settings' | 'enabled' | 'disabled' | 'settingsFailed' | 'unknownHost' | 'rootConfig' | 'rootConfigFailed' | 'rootConfigDetails'
      | 'sendStatus' | 'continueCollaboration' | 'reloadSendingRules' | 'sendingFailed' | 'sendingDetails' | 'initialAllowance';
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    arloContact: {
      list(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<SessionDiscoveryItem[]>>;
      create(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<SessionDiscoveryItem>>;
      participation(sessionId: SessionId, enabled: boolean | null, signal?: AbortSignal): Promise<RemoteResult<ParticipationStatus>>;
      rootConfiguration(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<RootConfigurationStatus>>;
      sendStatus(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<RootSendingStatus>>;
      continueCollaboration(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<RootSendingStatus>>;
      reloadSendingRules(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<RootSendingStatus>>;
    };
  }
}
