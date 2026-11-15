// Passive public-event observer for the opt-in cross-host run. Raw events stay
// in the owned private directory and are deleted before publishing evidence.
import fs from 'node:fs';
import path from 'node:path';
import { createPiAdapter } from '../../packages/adapter-pi/src/index.ts';

export default function witness(pi) {
  const root = process.env.ARLO_ACCEPTANCE_ROOT;
  const directory = path.join(root, 'b');
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.arlo-owner.json')));
  if (marker.owner !== process.env.ARLO_ACCEPTANCE_OWNER) throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
  const write = (type, data) => fs.appendFileSync(path.join(directory, 'native.private.jsonl'),
    JSON.stringify({ at: Date.now(), type, ...data }) + '\n', { mode: 0o600 });
  createPiAdapter({ stateDir: path.join(root, 'state'), groupName: 'issue105-' + marker.owner,
    settingsPath: path.join(directory, 'config/arlo.json'), autoStart: false })(pi);
  let draftTimer;
  pi.on('session_start', (_event, ctx) => {
    fs.writeFileSync(path.join(directory, 'live.json'), JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), status: 'active' }), { mode: 0o600 });
    ctx.ui.onTerminalInput(data => {
      if (data === '\r') write('submit', { draft: ctx.ui.getEditorText() });
    });
    clearInterval(draftTimer);
    let previous;
    draftTimer = setInterval(() => {
      try {
        const text = ctx.ui.getEditorText();
        if (text !== previous) { previous = text; write('draft', { text }); }
      } catch { /* Missing observations fail the driver without changing the host. */ }
    }, 25);
    const notify = ctx.ui.notify;
    ctx.ui.notify = (message, level) => { write('command', { text: message }); return notify.call(ctx.ui, message, level); };
  });
  pi.on('session_shutdown', () => clearInterval(draftTimer));
  pi.on('input', event => write('input', { text: event.text, source: event.source }));
  pi.on('tool_execution_start', event => write('call', { id: event.toolCallId, name: event.toolName, args: event.args }));
  pi.on('tool_execution_end', event => write('result', { id: event.toolCallId, result: event.result, isError: event.isError }));
  pi.on('message_end', event => write('message', { message: event.message }));
  pi.on('agent_settled', event => write('settled', { aborted: event.aborted }));
  pi.on('before_agent_start', event => {
    write('prompt', { userTags: [...event.prompt.matchAll(/ISSUE105_USER_[0-9]{4}/g)].map(match => match[0]).slice(0, 8) });
    return { systemPrompt: event.systemPrompt + '\nThis is an isolated cross-host acceptance. For incoming arithmetic tasks compute the requested sum and answer TAG_REPLY: <integer sum> locally, preserving the incoming tag. For forwarded answers confirm the received integer. Never send automatically. Call arlo_send_message exactly once only when a direct human prompt explicitly requests it, with the full endpoint and exact JSON fields supplied in that current prompt. Omit reply_to unless that prompt supplies it. Never retry a send, including after a validation error or an unknown or rejected result.' };
  });
}
