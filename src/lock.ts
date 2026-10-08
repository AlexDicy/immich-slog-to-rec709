import { open, rm, stat, utimes } from 'node:fs/promises';

const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 5 * HEARTBEAT_MS;

export interface Lock {
  release(): Promise<void>;
}

/**
 * Claims a lock file shared by every process using the same work directory, such
 * as the server and a backfill started alongside it, or two backfills. Process ids
 * mean nothing across containers sharing a volume, so the holder proves it is
 * alive by touching the file instead, and one left behind by a killed process is
 * taken over once it stops being touched.
 *
 * Returns null when another process holds the lock.
 */
export async function tryLock(path: string): Promise<Lock | null> {
  if (!(await create(path))) {
    if (!(await isStale(path))) return null;
    await rm(path, { force: true });
    if (!(await create(path))) return null;
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(path, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    async release() {
      clearInterval(heartbeat);
      await rm(path, { force: true });
    },
  };
}

async function create(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx');
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function isStale(path: string): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(path);
    return Date.now() - mtimeMs > STALE_AFTER_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
