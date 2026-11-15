import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const originalSeedSha256 = 'af3ff948cf3f132edbddebea93e2f9f02233b390a94bd4c9842182300be811bb';
const sha = value => createHash('sha256').update(value).digest('hex');

/** Mirror the patched package helper into the exact published browser seed. */
export function projectContactSeed(source, primitives) {
  assert.equal(sha(source), originalSeedSha256, 'Unexpected DSH 0.2.0-rc.2 browser seed; review this transform before upgrading');
  const start = primitives.indexOf('const ARLO_CONTACT_RE = ');
  const end = primitives.indexOf('/** Sentence punctuation', start);
  assert.ok(start >= 0 && end > start, 'The installed ui-primitives contact patch is missing');
  const helper = primitives.slice(start, end);
  assert.ok(helper.includes('function arloContactRanges(text)'));
  const original = 'function Tk(e,n,o=[],s="skill",a){const u=[];';
  assert.equal(source.split(original).length, 2, 'Expected one seeded projectUserText implementation');
  assert.ok(source.includes('projectUserText:Tk'));
  return source.replace(original, () => `${helper}\nfunction Tk(e,n,o=[],s="skill",a,p){if(p!==void 0)e=arloContactPreview(e,p);const u=arloContactRanges(e);`);
}

/** Patch only a new private consumer; atomically replace the asset to avoid mutating pnpm hardlinks. */
export function patchWebPrimitives(consumer) {
  const consumerRequire = createRequire(path.join(consumer, 'package.json'));
  const dshRequire = createRequire(consumerRequire.resolve('@deepseek-ai/dsh/package.json'));
  const frontendRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-host-frontend-static/package.json'));
  const frontendPackage = frontendRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json');
  assert.equal(JSON.parse(fs.readFileSync(frontendPackage, 'utf8')).version, '0.2.0-rc.2');
  const asset = path.join(path.dirname(frontendPackage), 'dist/assets/index-5SrrfWpU.js');
  const relativeAsset = path.relative(consumer, fs.realpathSync(asset));
  assert.ok(relativeAsset !== '..' && !relativeAsset.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeAsset),
    'The frontend seed must be inside the private consumer');
  const source = fs.readFileSync(asset, 'utf8');
  const primitives = fs.readFileSync(frontendRequire.resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8');
  const patched = projectContactSeed(source, primitives);
  const temporary = `${asset}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, patched);
  fs.renameSync(temporary, asset);
  return { packageVersion: '0.2.0-rc.2', asset: relativeAsset.replaceAll(path.sep, '/'),
    originalSha256: originalSeedSha256, patchedSha256: sha(patched) };
}
