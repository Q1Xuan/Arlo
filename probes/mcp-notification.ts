import type { Client } from '@modelcontextprotocol/client';

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: Output } | { issues: ReadonlyArray<{ message: string }> };
  };
}

export const ARLO_PROFILE = 'arlo/session-messaging';
export const ARLO_PROFILE_VERSION = '0.1';
export const ARLO_PINNED_WIRE_REVISION = '2025-06-18';
export const ARLO_PROTOCOL_OPTIONS = { supportedProtocolVersions: [ARLO_PINNED_WIRE_REVISION] };
export const ARLO_NOTIFICATION_METHOD = 'notifications/arlo/message';

export interface ArloMessageNotificationParams {
  [key: string]: unknown;
  protocol_version: string;
  daemon_id: string;
  message_id: string;
  delivery_id: string;
  from_endpoint: string;
  to_endpoint: string;
  group_id: string;
  target_generation: number;
  delivery_seq: string;
  text: string;
  reply_to?: string;
  reply_depth: number;
  sent_at: string;
}

export function createArloClientCapabilities() {
  return {
    experimental: {
      [ARLO_PROFILE]: { version: ARLO_PROFILE_VERSION },
    },
  };
}

export function createArloServerCapabilities() {
  return {
    experimental: {
      [ARLO_PROFILE]: { version: ARLO_PROFILE_VERSION },
    },
  };
}

export const arloNotificationSchema: StandardSchemaV1<ArloMessageNotificationParams> = {
  '~standard': {
    version: 1,
    vendor: 'arlo',
    validate(value: unknown) {
      if (!value || typeof value !== 'object') {
        return { issues: [{ message: 'Params must be an object' }] };
      }
      const v = value as Record<string, unknown>;
      const requiredStringProps = [
        'protocol_version',
        'daemon_id',
        'message_id',
        'delivery_id',
        'from_endpoint',
        'to_endpoint',
        'group_id',
        'delivery_seq',
        'text',
        'sent_at',
      ];
      for (const prop of requiredStringProps) {
        if (typeof v[prop] !== 'string' || !v[prop]) {
          return { issues: [{ message: `Field "${prop}" must be a string` }] };
        }
      }
      if (v.protocol_version !== ARLO_PROFILE_VERSION) {
        return { issues: [{ message: 'UNSUPPORTED_VERSION: incompatible notification profile' }] };
      }
      if (!/^[1-9]\d*$/.test(v.delivery_seq as string)) {
        return { issues: [{ message: 'delivery_seq must be a positive canonical decimal integer' }] };
      }
      if (typeof v.target_generation !== 'number' || !Number.isInteger(v.target_generation)) {
        return { issues: [{ message: 'Field "target_generation" must be an integer' }] };
      }
      if (typeof v.reply_depth !== 'number' || !Number.isInteger(v.reply_depth)) {
        return { issues: [{ message: 'Field "reply_depth" must be an integer' }] };
      }
      if (v.reply_to !== undefined && typeof v.reply_to !== 'string') {
        return { issues: [{ message: 'Field "reply_to" must be a string if present' }] };
      }
      return { value: v as unknown as ArloMessageNotificationParams };
    },
  },
};

export function attachArloNotificationHandler(
  client: Client,
  handler: (params: ArloMessageNotificationParams) => void | Promise<void>
): () => void {
  client.setNotificationHandler(
    ARLO_NOTIFICATION_METHOD,
    { params: arloNotificationSchema as any },
    (params: any) => handler(params)
  );

  return () => {
    client.removeNotificationHandler(ARLO_NOTIFICATION_METHOD);
  };
}
