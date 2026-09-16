import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { ImmichClient } from './immich.js';
import { Pipeline } from './pipeline.js';
import { Queue } from './queue.js';
import { startServer } from './server.js';
import { backfill, parseBackfillArgs } from './backfill.js';
import { selftest } from './selftest.js';
import { log, setLogLevel, errorMessage } from './log.js';

const USAGE = `Usage: node dist/index.js <command>

Commands:
  serve                     Listen for Immich workflow webhooks and grade what arrives
  backfill [--list]         Run over videos already in the library
           [--limit N]      --list prints candidates and downloads nothing
           [--force]        --force regrades everything, ignoring the markers
           [--changed]      --changed regrades what was graded with settings
                            that no longer match, replacing the old output
  selftest                  Check the tools and verify the LUT renders known values correctly

Configuration is read from the environment. See .env.example.`;

/**
 * A work directory that exists but cannot be written to is the likeliest way this
 * ends up misconfigured in a container, where the image runs as an unprivileged
 * user and a mounted volume belongs to root. Creating the directory is not enough
 * of a test, because the mount point itself already exists, so this writes into it.
 */
async function prepareWorkDir(directory: string): Promise<void> {
  const probe = join(directory, `.write-probe-${process.pid}`);
  try {
    await mkdir(directory, { recursive: true });
    await mkdir(probe);
  } catch (error) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const asUser = uid === null ? '' : `, and this process runs as uid ${uid}`;
    throw new Error(`WORK_DIR ${directory} is not writable: ${errorMessage(error)}${asUser}`);
  } finally {
    await rm(probe, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  // selftest needs the tools and the LUT but not a reachable Immich server, so
  // the placeholders let it run before anything is configured.
  if (command === 'selftest') {
    process.env['IMMICH_URL'] ||= 'http://localhost:2283';
    process.env['IMMICH_API_KEY'] ||= 'selftest';
  }

  const config = loadConfig();
  setLogLevel(config.logLevel);
  await prepareWorkDir(config.workDir);

  if (command === 'selftest') return selftest(config);

  const immich = new ImmichClient(config);
  try {
    await immich.ping();
  } catch (error) {
    log.error('cannot reach Immich', { url: config.immichUrl, error: errorMessage(error) });
    return 1;
  }
  log.info('connected to Immich', { url: config.immichUrl });

  const pipeline = new Pipeline(config, immich);

  switch (command) {
    case 'serve': {
      const queue = new Queue(config.concurrency);
      startServer(config, pipeline, queue);
      return new Promise<number>(() => {
        // Runs until a signal arrives.
      });
    }
    case 'backfill':
      return backfill(config, immich, pipeline, parseBackfillArgs(rest));
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

/**
 * Setting exitCode and letting the event loop drain is safer than process.exit,
 * which can tear down a keep-alive socket while a request is still in flight.
 * The timer is a backstop for anything that refuses to settle.
 */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 10_000).unref();
}

main()
  .then(finish)
  .catch((error) => {
    log.error('fatal', { error: errorMessage(error) });
    finish(1);
  });
