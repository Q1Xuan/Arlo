import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandboxConfiguration } from './sandbox.ts';

test('desktop sandbox exposes only the installation read-only and disables host integration', () => {
  const configuration = sandboxConfiguration('E:\\software\\dsh');
  assert.match(configuration, /<Networking>Disable<\/Networking>/);
  assert.match(configuration, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);
  assert.match(configuration, /<PrinterRedirection>Disable<\/PrinterRedirection>/);
  assert.match(configuration, /<AudioInput>Disable<\/AudioInput>/);
  assert.match(configuration, /<VideoInput>Disable<\/VideoInput>/);
  assert.match(configuration, /<HostFolder>E:\\software\\dsh<\/HostFolder>/);
  assert.match(configuration, /<ReadOnly>true<\/ReadOnly>/);
  assert.equal(configuration.match(/<MappedFolder>/g)?.length, 1);
  assert.doesNotMatch(configuration, /<LogonCommand>/);
});

test('installation paths cannot inject extra mappings into the Sandbox configuration', () => {
  const configuration = sandboxConfiguration('E:\\apps\\DSH & tools');
  assert.match(configuration, /<HostFolder>E:\\apps\\DSH &amp; tools<\/HostFolder>/);
  for (const invalid of ['', '.', 'E:\\', 'C:\\', '\\\\server\\share', 'E:\\apps\\..', 'E:\\.. ', 'E:\\. ', 'C:\\.. ', 'C:\\. ', 'E:\\apps\\.. ', 'E:\\apps\\dir. ', 'E:\\apps<MappedFolder>', 'E:\\apps\nother']) {
    assert.throws(() => sandboxConfiguration(invalid), /absolute local installation directory/);
  }
});
