import { acquireDaemonLock } from '@arlo/daemon/storage';

await acquireDaemonLock(process.argv[2]!, 'startup-owner', process.pid);
process.send?.({ locked: true });
setInterval(() => {}, 1000);
