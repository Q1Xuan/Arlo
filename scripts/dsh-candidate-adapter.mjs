import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Compose the verified display rule into the real adapter's owned browser lifetime. */
export function prepareCandidateAdapter(directory, recipe) {
  const version = JSON.parse(fs.readFileSync(path.join(recipe, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'];
  assert.ok(['0.2.1-rc.2', '0.2.1-rc.5'].includes(version), 'Use an exact reviewed candidate recipe');
  const replace = (source, from, to) => {
    assert.equal(source.split(from).length, 2, 'Candidate client recipe must match exactly once');
    return source.replace(from, to);
  };
  fs.cpSync(path.join(recipe, 'patches'), path.join(directory, 'delivery/candidate-patches'), { recursive: true });
  let display = fs.readFileSync(path.join(recipe, 'contact-display.cjs'), 'utf8');
  display = replace(display, '(function () {', `/** @param {(id: string) => any} require */\nfunction arloDisplayFactory(require) {`);
  display = replace(display, '  const rule =', `  /** @type {import('@deepseek-ai/dsh-client-ui-conversation/client').UserTextRule<'arlo.contact'>} */\n  const rule =`);
  display = replace(display, "  window.__ModuleLoader__.load({ id: 'arlo-contact-display', factory(require) {", '');
  display = replace(display, "    const React = require('react');", "    const React = /** @type {typeof import('react')} */ (require('react'));");
  display = replace(display, "    return { inject: ['uiConversation', 'slots'], apply(ctx) {", "    return { inject: ['uiConversation', 'slots'],\n    /** @param {import('./client-types.cjs').ClientContext} ctx */\n    apply(ctx) {");
  display = replace(display, '  } });\n})();', '}');
  let client = fs.readFileSync(path.join(directory, 'client.cjs'), 'utf8');
  client = replace(client, '    factory() {', '    factory(require) {\n      const display = arloDisplayFactory(require);');
  client = replace(client, "inject: ['inputTriggers', 'locale', 'remote', 'conversation', 'sessions']", "inject: ['inputTriggers', 'locale', 'remote', 'conversation', 'sessions', 'uiConversation', 'slots']");
  client = replace(client, '        async apply(ctx) {', '        async apply(ctx) {\n          display.apply(ctx);');
  fs.writeFileSync(path.join(directory, 'client.cjs'), `${display}\n${client}`);
  fs.appendFileSync(path.join(directory, 'client-types.d.cts'), `\nimport type {} from '@deepseek-ai/dsh-client-ui-renderer/client';\ndeclare module '@deepseek-ai/dsh-client-ui-conversation/client' {\n  interface UserTextDataMap { 'arlo.contact': { endpoint: string; label: string }; }\n}\n`);
  const manifestFile = path.join(directory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.dependencies['@deepseek-ai/dsh-client-ui-renderer'] = version;
  manifest.dsh.client.inject.push('react', '@deepseek-ai/dsh-client-ui-primitives');
  // The candidate archive itself declares the single selected Host family.
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[section])) {
      if (name.startsWith('@deepseek-ai/dsh')) manifest[section][name] = version;
      if (name === '@deepseek-ai/cordis') manifest[section][name] = '4.0.5';
      if (name === '@deepseek-ai/schemastery') manifest[section][name] = '3.18.5';
    }
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}
