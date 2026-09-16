import { spawn } from 'node:child_process';
import { log } from './log.js';

export interface RunOptions {
  /** Bytes of stdin to write, used to feed ffmpeg synthetic video in the self-test. */
  stdin?: Buffer;
  /** Kept so a hung ffmpeg cannot wedge the queue forever. */
  timeoutMs?: number;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    const tail = stderr.trim().split('\n').slice(-12).join('\n');
    super(`${command} exited with code ${code}${tail ? `\n${tail}` : ''}`);
    this.name = 'CommandError';
  }
}

interface RawResult {
  stdout: Buffer;
  stderr: string;
}

function spawnCollect(command: string, args: string[], options: RunOptions): Promise<RawResult> {
  const { stdin, timeoutMs = 6 * 60 * 60 * 1000 } = options;
  log.debug('running command', { command, args: args.join(' ') });

  return new Promise<RawResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error) => settle(() => reject(new Error(`failed to start ${command}: ${error.message}`))));

    child.on('close', (code) => {
      settle(() => {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code === 0) resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
        else reject(new CommandError(command, code, stderr));
      });
    });

    // ffmpeg reads stdin as a control channel unless it is closed, so always end it.
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await spawnCollect(command, args, options);
  return { stdout: stdout.toString('utf8'), stderr };
}

export async function runBinary(command: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  const { stdout } = await spawnCollect(command, args, options);
  return stdout;
}

export async function commandExists(command: string, versionArgs: string[] = ['-version']): Promise<boolean> {
  try {
    await run(command, versionArgs, { timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}
