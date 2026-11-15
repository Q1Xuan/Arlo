import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [target, command, managerArgs, ...args] = process.argv.slice(2);
const { runCli } = await import(pathToFileURL(path.join(target, 'lib/bin.js')).href);
if (typeof runCli !== 'function') throw new Error('DSH_NATIVE_MANAGER_UNAVAILABLE');
process.argv = [process.execPath, path.join(target, 'lib/bin.js'), ...args];
await runCli({ packageManager: { command, args: JSON.parse(managerArgs) } });
