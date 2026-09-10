import { closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { acquireRefreshLock } from '../../mcp-refresh-lock.ts';

let release;
process.on('message', async message => {
  if (message === 'release') {
    release?.();
    return;
  }
  if (message !== 'acquire') return;
  try {
    const lock = await acquireRefreshLock('shared', process.argv[2]);
    const marker = join(process.argv[2], 'critical-section');
    const fd = openSync(marker, 'wx');
    release = () => {
      closeSync(fd);
      unlinkSync(marker);
      lock.release();
      process.send({ event: 'released' });
    };
    process.send({ event: 'acquired' });
  } catch (error) {
    process.send({ event: 'error', message: String(error) });
  }
});
process.send({ event: 'ready' });
