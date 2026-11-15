// Passive witness: does not register tools, submit inputs, append history or change events.
let url, token;
async function observe($, event) {
  try {
    url ||= await $.env.get('ARLO_ACCEPTANCE_OBSERVER_URL');
    token ||= await $.env.get('ARLO_ACCEPTANCE_OBSERVER_TOKEN');
    if (url && token) {
      const response = await $.http.fetch(url, { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(event) });
      if (response.status !== 204) $.ui.log('ARLO_ACCEPTANCE_OBSERVER_HTTP_REFUSED');
    }
  } catch { $.ui.log('ARLO_ACCEPTANCE_OBSERVER_HTTP_UNAVAILABLE'); }
}

function boundedAgents(agents) {
  return agents.slice(0, 16).map(agent => ({
    id: agent.id, type: agent.type, status: agent.status, name: agent.name, parentId: agent.parentId,
    ...(agent.teammateId === undefined ? {} : { teammateId: agent.teammateId }),
  }));
}

export function register(on) {

  on('command.run', async ($, event, next) => {
    const result = await next(event);
    const commands = ['arlo-authorize', 'arlo-send-status', 'arlo-continue',
      'arlo-reload-sending-rules', 'arlo-settings', 'arlo-root-config'];
    if (!commands.includes(event.command)) return result;
    const text = typeof result?.text === 'string' ? result.text : '';
    const field = name => text.split('\n').find(line => line.startsWith(name + ': '))?.slice(name.length + 2);
    const boundedCount = value => /^\d{1,9}$/.test(value ?? '') ? Number(value) :
      ['unlimited', 'unknown'].includes(value) ? value : undefined;
    const mode = field('Mode');
    const pauseReason = field('Pause reason');
    const authorizationCode = ['AUTHORIZATION_REQUIRED', 'USER_AUTHORIZED', 'HISTORY_MISSING',
      'BINDING_MISMATCH', 'ALLOWANCE_UNKNOWN', 'ALLOWANCE_EXHAUSTED', 'PERMISSION_DENIED',
      'CHANNEL_NOT_READY', 'STALE_BINDING', 'STALE_GENERATION', 'INVALID_ARGUMENT'].find(code =>
        new RegExp('(^|[^A-Z0-9_])' + code + '([^A-Z0-9_]|$)').test(text));
    const authorizationSucceeded = text.includes('用户已授权绑定。');
    const originKind = ['composer', 'bridge', 'sdk', 'plugin'].includes(event.origin?.kind)
      ? event.origin.kind : 'other';
    await observe($, { type: 'command.result', sessionId: await $.session.id(), agentId: event.agentId,
      command: event.command, originKind, commandArgumentsEmpty: event.args.trim() === '',
      outputObserved: typeof result?.text === 'string',
      mode: ['bounded', 'continuous'].includes(mode) ? mode : undefined,
      remaining: boundedCount(field('Remaining')), nextGrant: boundedCount(field('Next grant')),
      pauseReason: ['none', 'ALLOWANCE_UNKNOWN', 'ALLOWANCE_EXHAUSTED'].includes(pauseReason) ? pauseReason : undefined,
      authorizationCode, authorizationSucceeded,
      crossHostEnabled: text.includes('Cross-host communication: on') ? true :
        text.includes('Cross-host communication: off') ? false : undefined });
    return result;
  });
  on('session.start', async ($, event, next) => {
    await observe($, { type: 'session.start', sessionId: await $.session.id() });
    return next(event);
  });
  on('session.end', async ($, event, next) => {
    await observe($, { type: 'session.end', sessionId: event.sessionId ?? await $.session.id(), reason: event.reason });
    return next(event);
  });
  on('turn.start', async ($, event, next) => {
    const text = typeof event.text === 'string' ? event.text : '';
    await observe($, { type: 'turn.start', sessionId: await $.session.id(), turnId: event.turnId,
      textAvailable: typeof event.text === 'string',
      markers: [...text.matchAll(/\[arlo-correlation:([0-9a-f-]+)\]/g)].slice(0, 16).map(match => match[1]),
      userPromptTags: [...text.matchAll(/\bISSUE105_USER_[0-9]{4}\b/g)].slice(0, 4).map(match => match[0]) });
    return next(event);
  }).catch(async ($, event, next) => {
    await observe($, { type: 'witness.error', stage: 'turn.start', code: 'TURN_START_OBSERVATION_FAILED',
      turnId: event.turnId, textAvailable: typeof event.text === 'string' });
    return next(event);
  });
  on('turn.complete', async ($, event, next) => {
    const result = await next(event);
    let agents = [];
    try { agents = boundedAgents(await $.agent.list()); } catch { /* Missing evidence stays missing. */ }
    let transcript;
    if (event.agentId !== undefined) {
      try {
        const messages = await $.session.messages({ agentId: event.agentId });
        if (Array.isArray(messages)) {
          const uses = messages.flatMap(message => message.toolUses ?? []).filter(use =>
            typeof use.tool === 'string' && use.tool.includes('arlo_'));
          transcript = { agentTranscriptReadable: true, transcriptArloCallCount: uses.length,
            transcriptArloDeniedCount: uses.filter(use =>
              typeof use.text === 'string' && use.text.includes('PERMISSION_DENIED') ||
              typeof use.result === 'string' && use.result.includes('PERMISSION_DENIED')).length };
        } else transcript = { agentTranscriptReadable: false };
      } catch { transcript = { agentTranscriptReadable: false }; }
    }
    await observe($, { type: 'turn.complete', sessionId: await $.session.id(), turnId: event.turnId,
      agentId: event.agentId, reason: event.reason, agents, ...transcript });
    return result;
  });
  on('agent.spawn', async ($, event, next) => {
    const result = await next(event);
    let agents = [];
    try { agents = boundedAgents(await $.agent.list()); } catch { /* Missing evidence stays missing. */ }
    await observe($, { type: 'agent.spawn', sessionId: await $.session.id(), agentId: result.agentId,
      parentAgentId: event.parentAgentId, isTeammate: event.isTeammate === true,
      teammateId: result.teammateId, background: event.background, subagentType: event.subagentType,
      name: event.name, toolUseId: event.tool_use_id, agents });
    return result;
  });
  on('tool.call', async ($, event, next) => {
    const tool = event.tool;
    const arlo = typeof tool === 'string' && tool.includes('arlo_');
    const busyWork = tool === 'Bash' && ['sleep 12', 'sleep 30', 'sleep 90'].includes(event.command);
    await observe($, { type: 'tool.start', tool, toolUseId: event.tool_use_id,
      sessionId: await $.session.id(), agentId: event.agentId,
      ...(arlo ? { to: event.to, replyTo: event.reply_to } : {}), busyWork });
    const result = await next(event);
    let body;
    try {
      const value = result?.result;
      if (arlo) {
        if (typeof value === 'string') body = JSON.parse(value);
        else if (Array.isArray(value?.content)) body = JSON.parse(value.content.find(part => part.type === 'text')?.text);
        else if (typeof result?.text === 'string') body = JSON.parse(result.text);
        else if (Array.isArray(result)) body = JSON.parse(result.find(part => part.type === 'text')?.text);
      }
    } catch { /* Only fixed metadata from a JSON tool result is observed. */ }
    await observe($, { type: 'tool.end', tool, toolUseId: event.tool_use_id,
      sessionId: await $.session.id(), agentId: event.agentId, busyWork,
      denied: typeof result?.deny === 'string' && result.deny.includes('PERMISSION_DENIED'),
      toolErrorCode: ['PERMISSION_DENIED', 'ALLOWANCE_EXHAUSTED', 'ALLOWANCE_UNKNOWN', 'CHANNEL_NOT_READY'].find(code =>
        typeof result?.deny === 'string' && result.deny.includes(code)),
      status: body?.status, messageId: body?.message_id });
    return result;
  });
}
