import { createUserMessage } from '@deepseek-ai/dsh-llm';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    arlo: { kind: 'arlo'; form: 'relay' };
  }
}

export function arloMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'arlo', form: 'relay' } });
}
