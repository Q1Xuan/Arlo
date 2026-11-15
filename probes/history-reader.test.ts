import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Session } from '@deepseek-ai/dsh-session';

// Separate process: no Arlo integration, declaration augmentation, Context,
// AgentRegistry, or model. Session.create validates a detached historical log;
// it does not register, create, or resume any live agent.
test('native detached history read preserves unknown external source without Arlo installed', () => {
  const saved = JSON.parse(readFileSync('history.json', 'utf8'));
  const history = Session.create(saved.header.id, saved.events, saved.header);
  const messages = history.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data);
  assert.deepEqual(messages.map(message => message.id), saved.messageIds);
  assert.deepEqual(messages.map(message => message.source), [
    { kind: 'arlo', form: 'relay' }, { kind: 'arlo', form: 'relay' },
  ]);
  assert.ok(messages.every(message => message.role === 'user'));
});
