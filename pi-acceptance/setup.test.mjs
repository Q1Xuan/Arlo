import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eventually, inbound, lastTool, modelText, modelTool, nativeScenario, sendFromNative } from './harness.mjs';

// Same confirmed seam as existing contacts acceptance, with registration done
// by the consumed CLI and native package settings instead of adapter injection.
test('private CLI registration loads through Pi user packages and native contacts send and receive an associated reply',
  { timeout: 180_000, skip: !process.env.ARLO_PI_INSTALL_REPORT && 'requires a consumed compiled installation report' }, async t => {
    const rig = await nativeScenario('cli-setup');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha', {}, { setup: true, beforeSetup: ({ home, setupArgs, setupCli }) => {
      const lock = path.join(home, 'settings.json.lock');
      fs.mkdirSync(lock);
      try {
        const failed = spawnSync(process.execPath, setupArgs, { encoding: 'utf8', cwd: home });
        fs.writeFileSync(path.join(home, 'setup-failure-command.json'), JSON.stringify({ executable: process.execPath,
          args: setupArgs, status: failed.status, signal: failed.signal, stdout: failed.stdout, stderr: failed.stderr }, null, 2));
        assert.equal(failed.status, 1, failed.stdout + failed.stderr);
        assert.ok(['REGISTRATION_INCOMPLETE', 'HOST_PACKAGE_OPERATION_FAILED'].includes(JSON.parse(failed.stdout).error));
        const status = spawnSync(process.execPath, [setupCli, 'setup-status', ...setupArgs.slice(2)], { encoding: 'utf8', cwd: home });
        assert.equal(JSON.parse(status.stdout).transaction, 'prepared');
      } finally { fs.rmSync(lock, { recursive: true }); }
      const settingsFile = path.join(home, 'settings.json');
      const current = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); current.retainedAfterFailedSetup = true;
      fs.writeFileSync(settingsFile, JSON.stringify(current));
    } });
    await alpha.ready();
    assert.ok(fs.existsSync(path.join(alpha.home, 'arlo-setup/pi.json')), 'CLI owns the native user registration');
    const bravo = await rig.start('bravo', {}, { setup: true });
    await bravo.ready();
    await alpha.submit('/arlo-doctor');
    const notice = await eventually(() => alpha.events().findLast(event => event.type === 'notification' &&
      event.message.includes('Arlo compatibility')), Boolean, 'live installed host doctor');
    assert.match(notice.message, /Node executable: /);
    assert.match(notice.message, /Required contracts: satisfied/);
    alpha.write('@');
    await eventually(() => alpha.output, text => text.includes('Arlo · Pi'), 'native contact host row');
    alpha.write('\r');
    await eventually(() => alpha.output, text => text.includes('Arlo · Pi: select session'), 'native session row');
    alpha.write('\r');
    const selected = await eventually(() => alpha.events().findLast(event => event.type === 'draft')?.text,
      text => /@arlo:pi:ep-[0-9a-f-]+/.test(text ?? ''), 'precise native contact');
    const endpoint = selected.match(/@arlo:pi:(ep-[0-9a-f-]+)/)[1];
    let sent, reply, step = 0, replyStep = 0;
    rig.handlers.set('alpha', request => {
      if (inbound(request.body, 'CLI_PI_REPLY')) return modelText('Associated reply received.')(request);
      if (step++ === 0) return modelTool('arlo_send_message', { to: endpoint, text: 'CLI_PI_REQUEST' })(request);
      if (step === 2) { sent = lastTool(request.body); assert.equal(sent.status, 'accepted'); return modelTool('arlo_get_message_status', { message_id: sent.message_id })(request); }
      assert.equal(lastTool(request.body).status, 'accepted');
      return modelText('Sent and checked.')(request);
    });
    rig.handlers.set('bravo', request => {
      if (replyStep++ === 0) {
        const source = inbound(request.body, 'CLI_PI_REQUEST');
        assert.ok(source, 'real receiving model sees actively delivered input');
        return modelTool('arlo_send_message', { to: source.from_endpoint, reply_to: source.message_id, text: 'CLI_PI_REPLY' })(request);
      }
      if (replyStep === 2) { reply = lastTool(request.body); assert.equal(reply.status, 'accepted'); return modelTool('arlo_get_message_status', { message_id: reply.message_id })(request); }
      assert.equal(lastTool(request.body).status, 'accepted');
      return modelText('Replied and checked.')(request);
    });
    await alpha.submit('Send the selected native contact our CLI_PI_REQUEST and query its reception.');
    const observed = await eventually(() => rig.requests.find(request => request.peer === 'alpha' && inbound(request.body, 'CLI_PI_REPLY')),
      Boolean, 'associated native reply', 45_000);
    assert.equal(inbound(observed.body, 'CLI_PI_REPLY').reply_to, sent.message_id);
    assert.deepEqual(rig.errors, []);
    await eventually(() => bravo.events().filter(event => event.type === 'agent_settled_handler_complete').length,
      count => count >= 1, 'reply and reception query finish before uninstall');
    const installation = JSON.parse(fs.readFileSync(process.env.ARLO_PI_INSTALL_REPORT, 'utf8'));
    const setupCli = path.resolve(path.dirname(installation.entries.daemonEntry), '../bin/arlo.js');
    const doctor = await promisify(execFile)(process.execPath, [setupCli, 'doctor', '--state-dir', rig.stateDir, '--json'], { encoding: 'utf8' });
    const daemonReport = JSON.parse(doctor.stdout);
    assert.equal(daemonReport.runtime.executable, process.execPath);
    assert.equal(daemonReport.runtime.node, process.versions.node);
    assert.equal(daemonReport.runtime.pid, process.pid, 'doctor observes the actual Daemon process, independently of the CLI child');
    fs.writeFileSync(path.join(rig.directory, 'daemon-doctor.json'), doctor.stdout);

    const uninstallArgs = [setupCli, 'uninstall', '--host', 'pi', '--target', path.resolve(path.dirname(installation.entries.piEntry), '..'),
      '--adapter', path.resolve(path.dirname(installation.entries.adapterEntry), '..'), '--agent-dir', alpha.home, '--apply', '--json'];
    const removed = spawnSync(process.execPath, uninstallArgs, { encoding: 'utf8' });
    fs.writeFileSync(path.join(alpha.home, 'uninstall-command.json'), JSON.stringify({ executable: process.execPath, args: uninstallArgs,
      status: removed.status, signal: removed.signal, stdout: removed.stdout, stderr: removed.stderr }, null, 2));
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).phase, 'removed-pending-reload');
    const starts = alpha.events().filter(event => event.type === 'session_start').length;
    await alpha.submit('/acceptance-reload');
    await eventually(() => alpha.events().filter(event => event.type === 'session_start').length,
      count => count > starts, 'normal native reload after uninstall');
    rig.handlers.set('alpha', modelText('Ordinary native work remains available after uninstall.'));
    await alpha.submit('CLI_PI_AFTER_UNINSTALL: ordinary local work.');
    const clean = await eventually(() => rig.requests.find(request => request.peer === 'alpha' &&
      JSON.stringify(request.body.messages).includes('CLI_PI_AFTER_UNINSTALL')), Boolean, 'reloaded host calls local model without Arlo');
    assert.equal(clean.body.tools.some(tool => tool.function?.name?.startsWith('arlo_')), false,
      'native reload no longer loads the removed adapter');
    const charlie = await rig.start('charlie', {}, { setup: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(alpha.home, 'settings.json'), 'utf8')).retainedAfterFailedSetup, true);
    await charlie.ready();
    rig.handlers.set('charlie', modelText('Other installed clients still receive.'));
    await sendFromNative(rig, bravo, 'charlie', 'CLI_PI_SHARED_DAEMON_SURVIVES');
    await eventually(() => rig.requests.some(request => request.peer === 'charlie' && inbound(request.body, 'CLI_PI_SHARED_DAEMON_SURVIVES')),
      Boolean, 'other clients communicate through the same shared Daemon after uninstall');
  });
