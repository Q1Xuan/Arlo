const source = process.env.ARLO_ACL_SOURCE_URL ?? new URL('../../packages/sdk/src/security/index.ts', import.meta.url).href;
const { inspectWindowsAclBatch, verifyWindowsAcl } = await import(source);

if (!process.send) throw new Error('ACL squatting fixture requires IPC');
process.once('message', message => {
  if (message?.command !== 'inspect' || typeof message.target !== 'string') {
    throw new Error('Unexpected ACL fixture command');
  }
  const inspection = inspectWindowsAclBatch([message.target])[message.target];
  const result = verifyWindowsAcl(message.target, inspection);
  process.send({ result, inspection });
});
process.once('disconnect', () => process.exit(0));
process.send({ ready: true });
