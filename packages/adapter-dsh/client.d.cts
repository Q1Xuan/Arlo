import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'arlo/contact-unavailable': { readonly reason: string; readonly diagnostic?: string };
    'arlo/contact-create-failed': { readonly reason: string };
  }
}

/** Shared Host and Client invocation descriptor. */
export const contactDescriptor: InvocationDescriptor;
export const createContactDescriptor: InvocationDescriptor;
export const participationDescriptor: InvocationDescriptor;
export const rootConfigurationDescriptor: InvocationDescriptor;
export const sendStatusDescriptor: InvocationDescriptor;
export const continueCollaborationDescriptor: InvocationDescriptor;
export const reloadSendingRulesDescriptor: InvocationDescriptor;
/** Pure model-visible serialization of an exact selected endpoint. */
export function serializeContact(ref: string, label?: string): string;
export function serializeReference(ref: string): string;
