import type { Context } from '@deepseek-ai/cordis';
import type { ArloPluginOptions } from '@arlo/adapter-dsh/runtime';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-workspace';

export type HostContext = Context;
export type ContactOptions = Pick<ArloPluginOptions, 'groupName' | 'stateDir' | 'hostType' | 'hostVersion'> & {
  autoStart?: boolean;
  settingsPath?: string;
  experimentalCompatibility?: boolean;
  newSessionModel?: { provider: string; model: string };
};
