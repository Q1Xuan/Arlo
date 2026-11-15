import { appendFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';

// A Node test reporter, deliberately excluding error objects and test stdout:
// product logs and fictional credential canaries stay in the private run directory.
export default async function* report(events) {
  for await (const { type, data } of events) {
    if (process.env.ARLO_ACCEPTANCE_LOG && (type === 'test:stdout' || type === 'test:stderr' || type === 'test:fail')) {
      const log = process.env.ARLO_ACCEPTANCE_LOG;
      let bytes = 0;
      try { bytes = statSync(log).size; } catch {}
      const remaining = 8 * 1024 * 1024 - bytes;
      if (remaining > 0) {
        const detail = Buffer.from(`${type}: ${type === 'test:fail' ? inspect(data, { depth: 5 }) : data.message}\n`);
        appendFileSync(log, detail.subarray(0, remaining));
      }
    }
    if (type === 'test:pass' || type === 'test:fail') {
      yield JSON.stringify({
        event: type, name: data.name, file: data.file ?? null,
        line: data.line ?? null, nesting: data.nesting,
        status: data.skip || data.todo ? 'not-run' : type === 'test:pass' ? 'passed' : 'failed',
        skip: typeof data.skip === 'string' ? data.skip : Boolean(data.skip),
        todo: typeof data.todo === 'string' ? data.todo : Boolean(data.todo),
        durationMs: data.details?.duration_ms ?? null,
        failureType: data.details?.error?.failureType ?? null,
      }) + '\n';
    } else if (type === 'test:summary') {
      yield JSON.stringify({ event: type, file: data.file ?? null, success: data.success, counts: data.counts }) + '\n';
    }
  }
}
