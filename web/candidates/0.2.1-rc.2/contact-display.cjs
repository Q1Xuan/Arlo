/* Candidate-only presentation extension. No Host service, lookup or navigation. */
(function () {
  const id = 'arlo.contact';
  const guidance = 'The user selected this exact Arlo contact. Organize the necessary context and use arlo_send_message with to equal to endpoint_id to contact it. ' +
    'This contact tag has not sent any message. If the target is unavailable, do not substitute another endpoint. ' +
    'Preserve accepted/rejected/unknown and reception-status query rules; do not automatically resend business messages.';
  const rule = { id, order: -100, match(text, from) {
    const pattern = /<arlo-contact>(\{[^\n<>]*\})<\/arlo-contact>\n/gu;
    pattern.lastIndex = from;
    let match;
    while ((match = pattern.exec(text))) {
      const tail = match.index + match[0].length;
      if (!text.startsWith(guidance, tail)) continue;
      let end = tail + guidance.length;
      if (end < text.length && text[end] !== '\n') continue;
      if (text[end] === '\n') end++;
      let data;
      try { data = JSON.parse(match[1]); } catch { continue; }
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          Object.keys(data).some(key => key !== 'endpoint_id' && key !== 'label')) continue;
      const endpoint = data.endpoint_id;
      if (typeof endpoint !== 'string' || !endpoint.length || endpoint.length > 1024 || /[\u0000-\u001f\u007f]/u.test(endpoint)) continue;
      if (data.label !== undefined && (typeof data.label !== 'string' || !data.label.trim())) continue;
      return { id, start: match.index, end, data: { endpoint,
        label: data.label?.replace(/[\u0000-\u001f\u007f]/gu, ' ') ?? `Arlo · ${endpoint.slice(0, 8)}` } };
    }
  } };
  window.__ModuleLoader__.load({ id: 'arlo-contact-display', factory(require) {
    const React = require('react');
    const { ReferenceChip } = require('@deepseek-ai/dsh-client-ui-primitives');
    return { inject: ['uiConversation', 'slots'], apply(ctx) {
      ctx.effect(() => ctx.uiConversation.userText.register(rule));
      ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
        name: 'conversation.user.text.node', key: id, priority: 100,
      }, ({ node }) => React.createElement(ReferenceChip, {
        appearance: 'session', label: node.data.label, title: node.data.endpoint,
      }))));
    } };
  } });
})();
