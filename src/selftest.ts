import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { run, runBinary, commandExists } from './exec.js';
import { buildFilterChain } from './grade.js';
import { probe } from './detect.js';
import { log } from './log.js';

/**
 * Verifies the grading chain end to end without needing a camera file.
 *
 * A synthetic clip is written byte by byte with known S-Log3 code values, pushed
 * through the exact filter chain the real pipeline uses, then decoded back and
 * measured. If the color range handling in grade.ts is wrong, mid gray lands in
 * the wrong place and these checks say so. That is the one part of the pipeline
 * that cannot be reasoned about from the file formats alone.
 */

const WIDTH = 64;
const HEIGHT = 64;
const FRAMES = 6;
const NEUTRAL_CHROMA_10BIT = 512;

/** S-Log3 reference code values and the Rec.709 8-bit value each should render to. */
interface Patch {
  name: string;
  slogCode: number;
  expected8Bit: number;
  tolerance: number;
}

// Expected values come from interpolating the generated LUT on its neutral axis.
// The tolerances absorb the 33-point LUT's interpolation error plus H.264 and
// 4:2:0 rounding, both of which are worth a unit or two at 8 bits.
const PATCHES: Patch[] = [
  { name: 'S-Log3 black (code 95)', slogCode: 95, expected8Bit: 0, tolerance: 3 },
  { name: 'S-Log3 18% gray (code 420)', slogCode: 420, expected8Bit: 104, tolerance: 4 },
  { name: 'S-Log3 90% white (code 598)', slogCode: 598, expected8Bit: 186, tolerance: 5 },
  { name: 'S-Log3 +4 stops (code 729)', slogCode: 729, expected8Bit: 231, tolerance: 5 },
];

/** One frame of yuv422p10le at a flat neutral luma. */
function buildFrame(lumaCode: number): Buffer {
  const luma = Buffer.alloc(WIDTH * HEIGHT * 2);
  for (let i = 0; i < WIDTH * HEIGHT; i++) luma.writeUInt16LE(lumaCode, i * 2);

  // 4:2:2 means chroma is half width, full height.
  const chromaSamples = (WIDTH / 2) * HEIGHT;
  const chroma = Buffer.alloc(chromaSamples * 2);
  for (let i = 0; i < chromaSamples; i++) chroma.writeUInt16LE(NEUTRAL_CHROMA_10BIT, i * 2);

  return Buffer.concat([luma, chroma, chroma]);
}

async function renderPatch(config: Config, workDir: string, patch: Patch): Promise<{ r: number; g: number; b: number }> {
  const sourcePath = join(workDir, `source-${patch.slogCode}.mp4`);
  const gradedPath = join(workDir, `graded-${patch.slogCode}.mp4`);

  // Write the synthetic clip, tagged the way a Sony camera tags S-Log3: limited
  // range, Rec.709 primaries, even though the samples are S-Log3 code values.
  const rawFrames = Buffer.concat(Array.from({ length: FRAMES }, () => buildFrame(patch.slogCode)));
  await run(
    config.ffmpegPath,
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv422p10le',
      '-s', `${WIDTH}x${HEIGHT}`,
      '-r', '25',
      '-i', 'pipe:0',
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv422p10le',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      sourcePath,
    ],
    { stdin: rawFrames },
  );

  // Confirm the encode preserved the exact code value before trusting the rest.
  const decodedSource = await runBinary(config.ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', 'scale=in_range=full:out_range=full',
    '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le', 'pipe:1',
  ]);
  const roundTripped = decodedSource.readUInt16LE(0);
  if (Math.abs(roundTripped - patch.slogCode) > 1) {
    throw new Error(`synthetic clip did not round trip: wrote ${patch.slogCode}, read back ${roundTripped}`);
  }

  const sourceProbe = await probe(config, sourcePath);
  const filterChain = buildFilterChain(config, config.lutPath, sourceProbe);

  await run(config.ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourcePath,
    '-vf', filterChain,
    '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    gradedPath,
  ]);

  // Decode normally. The graded file is correctly tagged limited range, so the
  // default range handling is the right one to use when reading it back.
  const decodedGraded = await runBinary(config.ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', gradedPath,
    '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);

  // Sample the middle of the frame to stay clear of any edge filtering.
  const centerOffset = ((HEIGHT / 2) * WIDTH + WIDTH / 2) * 3;
  return {
    r: decodedGraded[centerOffset] ?? -1,
    g: decodedGraded[centerOffset + 1] ?? -1,
    b: decodedGraded[centerOffset + 2] ?? -1,
  };
}

export async function selftest(config: Config): Promise<number> {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    log.info(`[${pass ? 'pass' : 'FAIL'}] ${name}`, { detail });
  };

  for (const [name, command, args] of [
    ['ffmpeg', config.ffmpegPath, ['-version']],
    ['ffprobe', config.ffprobePath, ['-version']],
    ['exiftool', config.exiftoolPath, ['-ver']],
  ] as const) {
    check(`${name} is available`, await commandExists(command, [...args]), command);
  }

  let lutHeader = '';
  try {
    const contents = await readFile(config.lutPath, 'utf8');
    const sizeMatch = contents.match(/^LUT_3D_SIZE\s+(\d+)/m);
    const entries = contents.split('\n').filter((line) => /^[-\d]/.test(line.trim())).length;
    const size = Number(sizeMatch?.[1] ?? 0);
    lutHeader = `size ${size}, ${entries} entries`;
    check('LUT file is readable and complete', size > 1 && entries === size ** 3, lutHeader);
  } catch (error) {
    check('LUT file is readable and complete', false, `${config.lutPath}: ${(error as Error).message}`);
  }

  if (checks.some((c) => !c.pass)) {
    log.error('prerequisites failed, skipping the render checks');
    return 1;
  }

  const workDir = join(config.workDir, 'selftest');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    for (const patch of PATCHES) {
      const { r, g, b } = await renderPatch(config, workDir, patch);
      const neutral = Math.max(Math.abs(r - g), Math.abs(g - b)) <= 3;
      const onTarget = Math.abs(r - patch.expected8Bit) <= patch.tolerance;
      check(
        `${patch.name} renders neutral`,
        neutral,
        `rgb(${r}, ${g}, ${b})`,
      );
      check(
        `${patch.name} renders at 8-bit ${patch.expected8Bit}`,
        onTarget,
        `got ${r}, expected ${patch.expected8Bit} +/- ${patch.tolerance}`,
      );
    }
  } finally {
    if (!config.keepWorkFiles) await rm(workDir, { recursive: true, force: true });
  }

  const failures = checks.filter((c) => !c.pass);
  if (failures.length === 0) {
    log.info(`all ${checks.length} checks passed`);
    return 0;
  }
  log.error(`${failures.length} of ${checks.length} checks failed`, {
    failed: failures.map((f) => f.name).join('; '),
  });
  return 1;
}
