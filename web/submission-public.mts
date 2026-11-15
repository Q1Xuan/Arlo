import type { IConversation, SubmitReference } from '@deepseek-ai/dsh-client-ui-conversation/client';

declare const conversation: IConversation;
const dispose = conversation.registerSubmitPreparation('contract-new', async (session, references, signal) => {
  signal.throwIfAborted();
  const sessionId: string = session.sessionId;
  return references.map(reference => `${sessionId}:${reference.ref}:${reference.text}`);
});
dispose();
const occurrence: SubmitReference = { source: 'contract-new', ref: 'same-ref', offset: 0, length: 1 };
void occurrence;
