/* DSH's browser loader consumes a lazy CommonJS factory. Node imports the same
 * descriptor so the installed Host and Client cannot drift on RPC arguments. */
(function registerContactModule() {
  'use strict';

  /** @param {unknown} value */
  function nonemptyString(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError('Expected a nonempty session or endpoint identity.');
    }
    return value;
  }

  /** @param {unknown} value @returns {import('@arlo/sdk').SessionDiscoveryItem[]} */
  function parseContacts(value) {
    if (!Array.isArray(value)) throw new TypeError('Expected Arlo contacts.');
    for (const item of value) {
      if (item === null || typeof item !== 'object' || typeof item.deliverable !== 'boolean') {
        throw new TypeError('Invalid Arlo contact.');
      }
      nonemptyString(item.endpoint_id);
      if (item.display_name !== undefined && typeof item.display_name !== 'string') {
        throw new TypeError('Invalid Arlo contact title.');
      }
      if (item.host_kind !== undefined && (typeof item.host_kind !== 'string' || !/^[a-z][a-z0-9.-]*$/u.test(item.host_kind)) ||
          item.host_type !== undefined && typeof item.host_type !== 'string') throw new TypeError('Invalid Arlo host.');
    }
    return value;
  }

  /** Wait only for read-only discovery; menu cancellation releases the timer immediately.
   * @param {number} milliseconds @param {AbortSignal} signal @returns {Promise<void>}
   */
  function waitForDiscovery(milliseconds, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /**
   * @param {string} typeSymbol
   * @param {(value: unknown) => unknown} parse
   * @returns {import('@deepseek-ai/dsh-typert-protocol').TypertCodec}
   */
  const codec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) });
  /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
  const contactDescriptor = {
    id: '@arlo/adapter-dsh#arloContact/list',
    service: 'arloContact',
    namespace: 'arloContact',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'sessionId', wire: 'sessionId', source: 'json',
      codec: codec('@arlo/adapter-dsh#SessionId', nonemptyString),
    }],
    cancellation: { parameter: 'signal' },
    result: codec('@arlo/adapter-dsh#Contacts', parseContacts),
  };
  /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
  const createContactDescriptor = {
    ...contactDescriptor,
    id: '@arlo/adapter-dsh#arloContact/create',
    method: 'create',
    result: codec('@arlo/adapter-dsh#Contact', value => parseContacts([value])[0]),
  };
  /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
  const participationDescriptor = {
    ...contactDescriptor,
    id: '@arlo/adapter-dsh#arloContact/participation', method: 'participation',
    parameters: [...(contactDescriptor.parameters ?? []), { name: 'enabled', wire: 'enabled', source: 'json',
      codec: codec('@arlo/adapter-dsh#ParticipationChoice', value => {
        if (value !== null && typeof value !== 'boolean') throw new TypeError('Expected on, off or a settings query.');
        return value;
      }) }],
    result: codec('@arlo/adapter-dsh#ParticipationStatus', value => {
      if (!value || typeof value !== 'object' || !('configured' in value) || typeof value.configured !== 'boolean' ||
          !('effective' in value) || (value.effective !== null && typeof value.effective !== 'boolean')) {
        throw new TypeError('Invalid Arlo settings status.');
      }
      return value;
    }),
  };

  /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
  const rootConfigurationDescriptor = {
    ...contactDescriptor,
    id: '@arlo/adapter-dsh#arloContact/rootConfiguration', method: 'rootConfiguration',
    result: codec('@arlo/adapter-dsh#RootConfigurationStatus', value => {
      if (!value || typeof value !== 'object' || !('root_authenticated' in value) || value.root_authenticated !== true ||
          !('config_id' in value) || (value.config_id !== null && typeof value.config_id !== 'string') ||
          !('config_path' in value) || typeof value.config_path !== 'string' ||
          !('ownership' in value) || !['verified', 'unknown', 'conflict'].includes(String(value.ownership)) ||
          !('history' in value) || value.history !== 'unknown' ||
          !('reason' in value) || !['BOUND', 'EVIDENCE_UNAVAILABLE', 'EVIDENCE_INVALID', 'OWNER_CONFLICT',
            'HISTORY_MISSING', 'HISTORY_CORRUPT', 'STORAGE_UNAVAILABLE', 'CAPACITY_EXHAUSTED'].includes(String(value.reason)) ||
          !('guidance' in value) || typeof value.guidance !== 'string') {
        throw new TypeError('Invalid Arlo root configuration status.');
      }
      return value;
    }),
  };

  /** @param {unknown} value @returns {import('@arlo/sdk').RootSendingStatus} */
  function parseSendingStatus(value) {
    if (!value || typeof value !== 'object' ||
        !('mode' in value) || !['bounded', 'continuous'].includes(/** @type {string} */ (value.mode)) ||
        !('period_id' in value) || (value.period_id !== null && typeof value.period_id !== 'string') ||
        !('knowledge' in value) || typeof value.knowledge !== 'string' || !['known', 'unknown'].includes(value.knowledge) ||
        !('granted' in value) || !('used' in value) || !('remaining' in value) ||
        !('next_grant' in value) || !Number.isSafeInteger(value.next_grant) || Number(value.next_grant) < 1 ||
        !('control_sequence' in value) || !Number.isSafeInteger(value.control_sequence) || Number(value.control_sequence) < 0 ||
        !('daemon_id' in value) || typeof value.daemon_id !== 'string' ||
        !('rules_revision' in value) || typeof value.rules_revision !== 'string' || !value.rules_revision ||
        !('rules_error' in value) || (value.rules_error !== null && typeof value.rules_error !== 'string') ||
        !('pause_reason' in value) || ![null, 'ALLOWANCE_EXHAUSTED', 'ALLOWANCE_UNKNOWN'].includes(/** @type {null | string} */ (value.pause_reason)) ||
        !('root_configuration' in value)) throw new TypeError('Invalid Arlo sending status.');
    if (value.granted !== null && (!Number.isSafeInteger(value.granted) || Number(value.granted) < 1)) {
      throw new TypeError('Invalid Arlo issued allowance.');
    }
    if (value.knowledge === 'unknown' ? value.used !== null : !Number.isSafeInteger(value.used) || Number(value.used) < 0) {
      throw new TypeError('Invalid Arlo sending allowance.');
    }
    if (value.mode === 'continuous' ? value.remaining !== null || value.pause_reason !== null ||
        value.knowledge === 'known' && (value.period_id === null || value.granted === null)
      : value.knowledge === 'unknown' ? value.pause_reason !== 'ALLOWANCE_UNKNOWN' || value.remaining !== null
      : value.period_id === null || value.granted === null ||
        !Number.isSafeInteger(value.remaining) || Number(value.remaining) < 0 ||
        value.remaining !== Math.max(0, Number(value.granted) - Number(value.used)) ||
        value.pause_reason !== (value.remaining === 0 ? 'ALLOWANCE_EXHAUSTED' : null)) {
      throw new TypeError('Invalid Arlo sending allowance.');
    }
    if (rootConfigurationDescriptor.result.mode !== 'strict') throw new TypeError('Invalid Arlo configuration codec.');
    const configuration = /** @type {import('@arlo/sdk').RootConfigurationStatus} */
      (rootConfigurationDescriptor.result.create().parse(value.root_configuration));
    if (value.mode === 'continuous' && configuration.ownership !== 'verified') {
      throw new TypeError('Invalid Arlo continuous mode ownership.');
    }
    if ('initial_allowance' in value && value.initial_allowance !== undefined) {
      const initial = value.initial_allowance;
      if (!initial || typeof initial !== 'object' ||
          !('eligibility' in initial) || !['unknown', 'available', 'consumed'].some(entry => entry === initial.eligibility) ||
          !('reason' in initial) || !['FIRST_USE_UNPROVEN', 'FIRST_USE_VERIFIED', 'INITIAL_ALLOWANCE_CONSUMED',
            'OWNERSHIP_UNVERIFIED', 'HISTORY_UNAVAILABLE', 'DISPATCH_HISTORY_PRESENT',
            'CAPACITY_EXHAUSTED'].some(entry => entry === initial.reason) ||
          !('guidance' in initial) || typeof initial.guidance !== 'string') {
        throw new TypeError('Invalid Arlo initial allowance.');
      }
    }
    return /** @type {import('@arlo/sdk').RootSendingStatus} */ (value);
  }
  /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
  const sendStatusDescriptor = {
    ...contactDescriptor, id: '@arlo/adapter-dsh#arloContact/sendStatus', method: 'sendStatus',
    result: codec('@arlo/adapter-dsh#RootSendingStatus', parseSendingStatus),
  };
  /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
  const continueCollaborationDescriptor = {
    ...sendStatusDescriptor, id: '@arlo/adapter-dsh#arloContact/continueCollaboration', method: 'continueCollaboration',
  };
  /** @type {import('@deepseek-ai/dsh-typert-protocol').InvocationDescriptor} */
  const reloadSendingRulesDescriptor = {
    ...sendStatusDescriptor, id: '@arlo/adapter-dsh#arloContact/reloadSendingRules', method: 'reloadSendingRules',
  };

  /** A draft marker only: copying, persisting and serializing never create a root. @param {string} ref */
  function serializeReference(ref) {
    if (!ref.startsWith('new:')) return serializeContact(ref);
    if (!/^new:[a-f0-9-]{36}$/u.test(ref)) throw new TypeError('Invalid new conversation reference.');
    return `<arlo-new-contact>${ref.slice(4)}</arlo-new-contact>`;
  }

  /** @param {string} endpoint @param {string[]} endpoints */
  function shortIdentity(endpoint, endpoints) {
    let length = Math.min(8, endpoint.length);
    while (length < endpoint.length && endpoints.some(other => other !== endpoint && other.startsWith(endpoint.slice(0, length)))) {
      length++;
    }
    return endpoint.slice(0, length);
  }

  /** Serialize an exact endpoint and optional display-only label, without sending or looking up titles.
   * @param {string} ref @param {string} [label]
   */
  function serializeContact(ref, label) {
    const endpoint = nonemptyString(ref);
    const data = JSON.stringify({ endpoint_id: endpoint, ...(label ? { label } : {}) }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return `<arlo-contact>${data}</arlo-contact>\n` +
      'The user selected this exact Arlo contact. Organize the necessary context and use arlo_send_message with to equal to endpoint_id to contact it. ' +
      'This contact tag has not sent any message. If the target is unavailable, do not substitute another endpoint. ' +
      'Preserve accepted/rejected/unknown and reception-status query rules; do not automatically resend business messages.\n';
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { contactDescriptor, createContactDescriptor, participationDescriptor, rootConfigurationDescriptor,
      sendStatusDescriptor, continueCollaborationDescriptor, reloadSendingRulesDescriptor, serializeContact, serializeReference };
    return;
  }

  const dshWindow = /** @type {import('@deepseek-ai/dsh-client-modules/client').DshWindow} */ (window);
  if (!dshWindow.__ModuleLoader__) throw new Error('Arlo contacts require the DSH browser module loader.');
  dshWindow.__ModuleLoader__.load({
    id: '@arlo/adapter-dsh',
    factory() {
      return {
        inject: ['inputTriggers', 'locale', 'remote', 'conversation', 'sessions'],
        /** @param {import('./client-types.cjs').ClientContext} ctx */
        async apply(ctx) {
          ctx.effect(() => ctx.locale.register('arloContact', {
            en: { initialAllowance: 'Initial allowance: {eligibility}\nReason: {reason}\n{guidance}', reloadSendingRules: 'Reload private sending rules; takes no arguments', sendStatus: 'Query this root sending state; takes no arguments', continueCollaboration: 'Explicitly continue collaboration; takes no arguments', sendingFailed: 'Arlo sending operation failed', sendingDetails: 'Arlo dispatch attempts\nMode: {mode}\nPeriod: {period}\nUsage: {knowledge}\nGranted: {granted}\nUsed: {used}\nRemaining: {remaining}\nNext grant: {next}\nPause reason: {reason}\nRules problem: {rulesError}', section: 'Arlo contacts', unavailable: 'This conversation is not connected to Arlo yet. Type @ again to retry.', contact: 'Contact {title} · {id}', untitled: 'Untitled session', new: 'New conversation', creating: 'Creating new conversation…', ready: 'New conversation ready', modelUnavailable: 'The configured Arlo new-conversation model is unavailable. Check the Arlo plugin model setting and DSH provider configuration, then submit again.', settings: 'Arlo cross-host settings: on / off', enabled: 'Cross-host communication enabled', disabled: 'Cross-host communication disabled', settingsFailed: 'Arlo settings update failed', unknownHost: 'Unknown host', rootConfig: 'Query this root configuration; takes no arguments', rootConfigFailed: 'Arlo root configuration query failed', rootConfigDetails: 'Arlo root configuration: {id}\nLocation: {location}\nOwnership: {ownership}\nHistorical first eligibility: {history}\nReason: {reason}\n{guidance}' },
            zh: { initialAllowance: '初始额度资格：{eligibility}\n原因：{reason}\n{guidance}', reloadSendingRules: '重载私有发信规则；不接受参数', sendStatus: '查询当前根发信状态；不接受参数', continueCollaboration: '明确继续协作，开启新额度周期；不接受参数', sendingFailed: 'Arlo 发信操作失败', sendingDetails: 'Arlo 派发尝试额度\n模式：{mode}\n当前周期：{period}\n用量可知性：{knowledge}\n已发放：{granted}\n已用：{used}\n剩余：{remaining}\n下次发放：{next}\n暂停原因：{reason}\n规则问题：{rulesError}', section: 'Arlo · 联系会话', unavailable: '当前会话尚未连接 Arlo，请重新输入 @ 重试', contact: '联系 {title} · {id}', untitled: '无标题会话', new: '新对话', creating: '正在创建新对话…', ready: '新对话已就绪', modelUnavailable: 'Arlo 新对话配置的模型不可用。请检查 Arlo 插件的模型设置和 DSH 供应商配置后重新提交。', settings: 'Arlo 跨宿主设置：on 开启 / off 关闭', enabled: '跨宿主通信已开启', disabled: '跨宿主通信已关闭', settingsFailed: 'Arlo 设置更新失败', unknownHost: '未知宿主', rootConfig: '查询当前根配置；不接受参数', rootConfigFailed: 'Arlo 根配置查询失败', rootConfigDetails: 'Arlo 根配置：{id}\n配置位置：{location}\n持久归属：{ownership}\n历史首次资格：{history}\n原因：{reason}\n{guidance}' },
          }), 'arlo-contact: dictionaries');
          const t = ctx.locale.bind('arloContact');
          if (typeof ctx.conversation.registerSubmitPreparation !== 'function') {
            throw new Error('Arlo new conversations require the pinned DSH submit-preparation patch.');
          }
          await ctx.remote.$mount({ package: '@arlo/adapter-dsh', descriptors: [contactDescriptor, createContactDescriptor,
            participationDescriptor, rootConfigurationDescriptor, sendStatusDescriptor, continueCollaborationDescriptor, reloadSendingRulesDescriptor] });
          // Each mounted namespace is a separate Cordis dependency. Registering
          // inside its scope also removes the source if the namespace withdraws.
          ctx.inject(['remote.arloContact'], (scope) => {
            const lifetime = new AbortController();
            scope.effect(() => () => lifetime.abort(), 'arlo-contact: cancel preparation on unload');
            scope.effect(() => scope.conversation.registerSubmitPreparation('arlo-contact', async (session, references, signal) => {
              const selected = references.filter(reference => reference.ref.startsWith('new:'));
              if (selected.length === 0) return references.map(reference => serializeContact(reference.ref, reference.label));
              const preparationSignal = AbortSignal.any([signal, lifetime.signal]);
              preparationSignal.throwIfAborted();
              const binding = scope.sessions.binding(session.sessionId);
              if (!binding) throw new Error('The current session is no longer available.');
              const input = scope.conversation.input.for(binding.ctx);
              const block = { reason: t('creating') };
              scope.conversation.blocks.set(session.sessionId, block);
              input.notify('info', t('creating'));
              try {
                const prepared = [];
                // Preserve occurrences and their order, including repeated labels.
                // Each creation uses the existing Host contract; a failure exits
                // preparation without retrying or rolling back ordinary roots.
                for (const reference of references) {
                  preparationSignal.throwIfAborted();
                  if (!reference.ref.startsWith('new:')) {
                    prepared.push(serializeContact(reference.ref, reference.label));
                    continue;
                  }
                  const result = await scope.remote.arloContact.create(session.sessionId, preparationSignal);
                  if (!result.ok) {
                    if (result.error.code === 'arlo/contact-create-failed' && result.error.details.reason === 'MODEL_UNAVAILABLE') {
                      throw new Error(t('modelUnavailable'));
                    }
                    throw result.error;
                  }
                  preparationSignal.throwIfAborted();
                  if (!result.value.deliverable) throw new Error('The new conversation is not ready to receive.');
                  prepared.push(serializeContact(result.value.endpoint_id, t('contact', {
                    title: result.value.display_name?.trim() || t('untitled'),
                    id: shortIdentity(result.value.endpoint_id, [result.value.endpoint_id]),
                  })));
                }
                input.notify('info', t('ready'));
                return prepared;
              } finally {
                if (scope.conversation.blocks.storeFor(session.sessionId).getSnapshot() === block) {
                  scope.conversation.blocks.set(session.sessionId, undefined);
                }
              }
            }), 'arlo-contact: explicit submit preparation');
            /** @param {string} host */
            const hostLabel = host => host === 'pi' ? 'Pi' : host === 'deepseek-harness' ? 'DSH' : t('unknownHost');
            /** @type {import('@deepseek-ai/dsh-client-ui-input-trigger/client').InputTriggerSource} */
            const source = {
              trigger: '@',
              name: 'arlo-contact',
              order: -100,
              showGroupTitle: false,
              async candidates(session, { query, signal }) {
                signal.throwIfAborted();
                const deadline = Date.now() + 15000;
                let interval = 250;
                const unavailable = () => [{ name: t('unavailable'), section: t('section'), value: 'status:unavailable' }];
                let result;
                try {
                  result = await scope.remote.arloContact.list(session.sessionId, signal);
                  signal.throwIfAborted();
                  while (!result.ok && result.error.code === 'arlo/contact-unavailable'
                    && ['CALLER_NOT_ROOT', 'CHANNEL_NOT_READY'].includes(result.error.details.reason)) {
                    const remaining = deadline - Date.now();
                    if (remaining <= 0) break;
                    await waitForDiscovery(Math.min(interval, remaining), signal);
                    signal.throwIfAborted();
                    if (Date.now() >= deadline) break;
                    interval = Math.min(interval + 250, 1000);
                    result = await scope.remote.arloContact.list(session.sessionId, signal);
                    signal.throwIfAborted();
                  }
                } catch {
                  signal.throwIfAborted();
                  return unavailable();
                }
                if (!result.ok) return unavailable();
                const contacts = parseContacts(result.value).filter(item => item.deliverable);
                const endpoints = contacts.map(item => item.endpoint_id);
                /** @param {import('@arlo/sdk').SessionDiscoveryItem} item */
                const hostOf = item => item.host_kind ?? (item.host_type === 'deepseek-harness' ? 'deepseek-harness' : 'unknown');
                const selected = /^arlo:([a-z0-9.-]+):(.*)$/u.exec(query);
                const needle = (selected ? selected[2] : query).toLocaleLowerCase();
                if (!selected) {
                  const hosts = [...new Set(contacts.map(hostOf))];
                  return [{ name: t('new'), section: t('section'), icon: /** @type {const} */ ('session'), value: 'new' },
                    ...hosts.map(host => ({ name: hostLabel(host), section: t('section'), value: `host:${host}`, drill: true }))]
                    .filter(item => `${item.name} ${item.value}`.toLocaleLowerCase().includes(needle));
                }
                const items = contacts.filter(item => hostOf(item) === selected[1]).map(item => {
                  const title = item.display_name?.trim() || t('untitled');
                  const id = shortIdentity(item.endpoint_id, endpoints);
                  return {
                    name: `${title} · ${hostLabel(hostOf(item))} · ${id}`,
                    section: t('section'),
                    icon: /** @type {const} */ ('session'),
                    value: item.endpoint_id,
                    description: t('contact', { title: `${title} · ${hostLabel(hostOf(item))}`, id }),
                  };
                });
                return items
                  .filter(item => `${item.name} ${item.value}`.toLocaleLowerCase().includes(needle));
              },
              onPick({ candidate }) {
                if (candidate.value === 'hosts') return { text: '@', continue: true };
                if (candidate.value?.startsWith('host:')) return { text: `@arlo:${candidate.value.slice(5)}:`, continue: true };
                if (candidate.value === 'status:unavailable') return;
                if (candidate.value === 'new') {
                  const ref = `new:${crypto.randomUUID()}`;
                  return { insert: { source: 'arlo-contact', ref, label: t('new'), appearance: 'session', clipboardText: serializeReference(ref) } };
                }
                const endpoint = nonemptyString(candidate.value);
                return { insert: {
                  source: 'arlo-contact',
                  ref: endpoint,
                  label: candidate.description ?? candidate.name,
                  appearance: 'session',
                  clipboardText: serializeContact(endpoint),
                } };
              },
              header(_session, { query }) {
                const selected = /^arlo:([a-z0-9.-]+):/u.exec(query);
                if (!selected) return undefined;
                return [{ label: t('section'), value: 'hosts' }, { label: hostLabel(selected[1]), value: `host:${selected[1]}`, current: true }];
              },
              codec: {
                clipboardText: serializeReference,
                async serialize(ref, signal) {
                  signal.throwIfAborted();
                  return serializeReference(ref);
                },
              },
            };
            scope.effect(() => scope.inputTriggers.registerSource(source), 'arlo-contact: @ source');
            /** @param {import('@deepseek-ai/dsh-session/types').SessionId} sessionId
             * @returns {import('@deepseek-ai/dsh-client-ui-input-trigger/client').PickOutcome} */
            const settingsClaim = sessionId => ({ claim: {
              name: 'arlo-settings', token: '/arlo-settings ', hint: t('settings'), attachments: false,
              async submit(args, actx) {
                const choice = args.trim().toLowerCase();
                if (!['on', 'off', ''].includes(choice)) return { kind: 'error', text: t('settings') };
                try {
                  const result = await scope.remote.arloContact.participation(sessionId,
                    choice ? choice === 'on' : null, lifetime.signal);
                  if (!result.ok) return { kind: 'error', text: `${t('settingsFailed')}: ${result.error.code === 'arlo/contact-unavailable'
                    ? result.error.details.reason : result.error.code}` };
                  if (result.value.effective === null) return { kind: 'error', text: t('settingsFailed') };
                  const text = t(result.value.effective ? 'enabled' : 'disabled');
                  scope.conversation.input.for(actx).notify('info', text);
                  return { kind: 'success', text };
                } catch { return { kind: 'error', text: t('settingsFailed') }; }
              },
            } });
            /** @type {import('@deepseek-ai/dsh-client-ui-input-trigger/client').InputTriggerSource} */
            const settingsSource = {
              trigger: '/', name: 'arlo-settings', order: -100,
              async candidates(_session, { query, signal }) {
                signal.throwIfAborted();
                return 'arlo-settings'.includes(query.toLowerCase()) ? [{ name: 'arlo-settings', description: t('settings') }] : [];
              },
              onPick({ session }) { return settingsClaim(session.sessionId); },
              matchSpace(session, token) { if (token === '/arlo-settings') return settingsClaim(session.sessionId); },
              async matchEnter(session, line) {
                return /^\/arlo-settings(?:\s|$)/u.test(line) ? settingsClaim(session.sessionId) : undefined;
              },
            };
            scope.effect(() => scope.inputTriggers.registerSource(settingsSource), 'arlo-contact: native plugin settings');
            /** @param {import('@deepseek-ai/dsh-session/types').SessionId} sessionId
             * @returns {import('@deepseek-ai/dsh-client-ui-input-trigger/client').PickOutcome} */
            const rootConfigClaim = sessionId => ({ claim: {
              name: 'arlo-root-config', token: '/arlo-root-config ', hint: t('rootConfig'), attachments: false,
              async submit(args, actx) {
                if (args.trim()) return { kind: 'error', text: t('rootConfig') };
                try {
                  const result = await scope.remote.arloContact.rootConfiguration(sessionId, lifetime.signal);
                  if (!result.ok) return { kind: 'error', text: `${t('rootConfigFailed')}: ${result.error.code === 'arlo/contact-unavailable'
                    ? result.error.details.reason : result.error.code}` };
                  const status = result.value;
                  const text = t('rootConfigDetails', {
                    id: status.config_id ?? 'unknown', location: status.config_path,
                    ownership: status.ownership, history: status.history, reason: status.reason, guidance: status.guidance,
                  });
                  scope.conversation.input.for(actx).notify('info', text);
                  return { kind: 'success', text };
                } catch { return { kind: 'error', text: t('rootConfigFailed') }; }
              },
            } });
            /** @type {import('@deepseek-ai/dsh-client-ui-input-trigger/client').InputTriggerSource} */
            const rootConfigSource = {
              trigger: '/', name: 'arlo-root-config', order: -100,
              async candidates(_session, { query, signal }) {
                signal.throwIfAborted();
                return 'arlo-root-config'.includes(query.toLowerCase()) ? [{ name: 'arlo-root-config', description: t('rootConfig') }] : [];
              },
              onPick({ session }) { return rootConfigClaim(session.sessionId); },
              matchSpace(session, token) { if (token === '/arlo-root-config') return rootConfigClaim(session.sessionId); },
              async matchEnter(session, line) {
                return /^\/arlo-root-config(?:\s|$)/u.test(line) ? rootConfigClaim(session.sessionId) : undefined;
              },
            };
            scope.effect(() => scope.inputTriggers.registerSource(rootConfigSource), 'arlo-contact: human root configuration query');
            for (const operation of ['status', 'continue', 'reload']) {
              const name = operation === 'continue' ? 'arlo-continue' : operation === 'reload' ? 'arlo-reload-sending-rules' : 'arlo-send-status';
              const hint = operation === 'continue' ? t('continueCollaboration') : operation === 'reload' ? t('reloadSendingRules') : t('sendStatus');
              /** @param {import('@deepseek-ai/dsh-session/types').SessionId} sessionId
               * @returns {import('@deepseek-ai/dsh-client-ui-input-trigger/client').PickOutcome} */
              const claim = sessionId => ({ claim: {
                name, token: `/${name} `, hint, attachments: false,
                async submit(args, actx) {
                  if (args.trim()) return { kind: 'error', text: hint };
                  try {
                    lifetime.signal.throwIfAborted();
                    const result = operation === 'continue'
                      ? await scope.remote.arloContact.continueCollaboration(sessionId, lifetime.signal)
                      : operation === 'reload' ? await scope.remote.arloContact.reloadSendingRules(sessionId, lifetime.signal)
                      : await scope.remote.arloContact.sendStatus(sessionId, lifetime.signal);
                    lifetime.signal.throwIfAborted();
                    if (!result.ok) {
                      const error = result.error;
                      const reason = error.code === 'arlo/contact-unavailable' ? error.details.reason : error.code;
                      const diagnostic = operation === 'reload' && error.code === 'arlo/contact-unavailable' &&
                        reason === 'SENDING_RULES_INVALID' && typeof error.details.diagnostic === 'string'
                        ? `: ${error.details.diagnostic.slice(0, 1024)}` : '';
                      return { kind: 'error', text: `${t('sendingFailed')}: ${reason}${diagnostic}` };
                    }
                    const status = result.value;
                    let text = t('sendingDetails', { mode: status.mode, period: status.period_id ?? 'unknown',
                      knowledge: status.knowledge, granted: String(status.granted ?? 'unknown'), used: String(status.used ?? 'unknown'),
                      remaining: status.mode === 'continuous' ? 'unlimited' : String(status.remaining ?? 'unknown'), next: String(status.next_grant),
                      reason: status.pause_reason ?? 'none', rulesError: status.rules_error ?? 'none' });
                    if (status.initial_allowance) text += '\n' + t('initialAllowance', {
                      eligibility: status.initial_allowance.eligibility, reason: status.initial_allowance.reason,
                      guidance: status.initial_allowance.guidance,
                    });
                    scope.conversation.input.for(actx).notify('info', text);
                    return { kind: 'success', text };
                  } catch { return { kind: 'error', text: t('sendingFailed') }; }
                },
              } });
              /** @type {import('@deepseek-ai/dsh-client-ui-input-trigger/client').InputTriggerSource} */
              const command = {
                trigger: '/', name, order: -100,
                async candidates(_session, { query, signal }) {
                  signal.throwIfAborted();
                  return name.includes(query.toLowerCase()) ? [{ name, description: hint }] : [];
                },
                onPick({ session }) { return claim(session.sessionId); },
                matchSpace(session, token) { if (token === `/${name}`) return claim(session.sessionId); },
                async matchEnter(session, line) {
                  return new RegExp(`^/${name}(?:\\s|$)`, 'u').test(line) ? claim(session.sessionId) : undefined;
                },
              };
              scope.effect(() => scope.inputTriggers.registerSource(command), `arlo-contact: human ${name}`);
            }
          });
        },
      };
    },
  });
}());
