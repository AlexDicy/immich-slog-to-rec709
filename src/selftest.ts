import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { run, runBinary, toolVersion } from './exec.js';
import { buildFilterChain } from './grade.js';
import { probe } from './detect.js';
import { loadCube, sampleCube, type Cube } from './cube.js';
import { extractAssetId } from './server.js';
import { shiftExposure } from './slog3.js';
import { log, errorMessage } from './log.js';

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

/**
 * S-Log3 reference code values to test, from Sony's technical summary.
 *
 * The expected output is not hardcoded. It is read from whichever LUT is loaded, by
 * sampling it the same way FFmpeg will, so these checks prove that the code values
 * reach the LUT unshifted and come back out correctly encoded. That is a property of
 * the filter chain, not of any particular LUT, so swapping in a different .cube does
 * not invalidate the test.
 */
interface Patch {
  name: string;
  slogCode: number;
}

const PATCHES: Patch[] = [
  { name: 'S-Log3 black (code 95)', slogCode: 95 },
  { name: 'S-Log3 18% gray (code 420)', slogCode: 420 },
  { name: 'S-Log3 90% white (code 598)', slogCode: 598 },
  { name: 'S-Log3 +4 stops (code 729)', slogCode: 729 },
];

// Absorbs H.264 quantization, 4:2:0 chroma handling, and the limited-range round trip.
const TOLERANCE_8BIT = 5;

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

/**
 * What the loaded LUT says a neutral S-Log3 code value becomes, as 8-bit Rec.709,
 * after the exposure offset has moved it.
 */
function predict(cube: Cube, slogCode: number, exposure = 0): [number, number, number] {
  const input = Math.min(1023, Math.max(0, shiftExposure(slogCode, exposure))) / 1023;
  const output = sampleCube(cube, [input, input, input]);
  return output.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255)) as [number, number, number];
}

async function renderPatch(config: Config, workDir: string, patch: Patch): Promise<[number, number, number]> {
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
  return [
    decodedGraded[centerOffset] ?? -1,
    decodedGraded[centerOffset + 1] ?? -1,
    decodedGraded[centerOffset + 2] ?? -1,
  ];
}

export async function selftest(config: Config): Promise<number> {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    log.info(`[${pass ? 'pass' : 'FAIL'}] ${name}`, { detail });
  };

  // The version is reported, not just the presence of the tool. Debian's exiftool
  // 12.57 reads only part of the Sony acquisition record on longer clips, which
  // looks exactly like footage that carries no picture profile, so knowing which
  // version is installed is the first thing worth checking when detection is quiet.
  for (const [name, command, args] of [
    ['ffmpeg', config.ffmpegPath, ['-version']],
    ['ffprobe', config.ffprobePath, ['-version']],
    ['exiftool', config.exiftoolPath, ['-ver']],
  ] as const) {
    const version = await toolVersion(command, [...args]);
    check(`${name} is available`, version !== null, version ?? command);
  }

  // The webhook payload shape is not part of the Immich API spec, so it is pinned
  // here: the event Immich actually posts has to parse, and nothing else carried in
  // that same payload may be mistaken for the asset's own id.
  const ID = '11111111-2222-3333-4444-555555555555';
  const payloads: [string, string, string | null][] = [
    [
      'the event Immich posts',
      JSON.stringify({
        type: 'AssetV1',
        trigger: 'AssetMetadataExtraction',
        data: { asset: { id: ID, ownerId: '99999999-9999-9999-9999-999999999999', stackId: null } },
      }),
      ID,
    ],
    ['a bare asset object', JSON.stringify({ id: ID }), ID],
    ['an asset wrapper', JSON.stringify({ asset: { id: ID } }), ID],
    ['a payload carrying no asset id', JSON.stringify({ data: { asset: { ownerId: ID } } }), null],
    ['a body that is not JSON', 'not json', null],
    ['an id that is not a uuid', JSON.stringify({ id: '../../etc/passwd' }), null],
  ];
  for (const [name, body, expected] of payloads) {
    const actual = extractAssetId(body);
    check(`webhook payload, ${name}`, actual === expected, `got ${actual === null ? 'no id' : actual}`);
  }

  let cube: Cube | null = null;
  try {
    cube = await loadCube(config.lutPath);
    check('LUT file parses and is complete', true, `${cube.size}^3 entries${cube.title ? `, "${cube.title}"` : ''}`);
  } catch (error) {
    check('LUT file parses and is complete', false, `${config.lutPath}: ${errorMessage(error)}`);
  }

  if (!cube || checks.some((c) => !c.pass)) {
    log.error('prerequisites failed, skipping the render checks');
    return 1;
  }

  // Where this LUT puts 18% gray. A neutral Rec.709 conversion lands on 104, but a
  // creative look such as Sony's LC_709 may sit elsewhere, which is not a problem.
  const grayPrediction = predict(cube, 420);
  log.info('LUT reference points', {
    lut: config.lutPath,
    black95: predict(cube, 95).join(','),
    gray420: grayPrediction.join(','),
    white598: predict(cube, 598).join(','),
  });

  const workDir = join(config.workDir, 'selftest');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  // The offset is rendered even when it is not configured, so the expression is
  // proven to work in this FFmpeg before anyone turns it on.
  const exposures = [...new Set([0, 1, config.exposureOffset])];
  const cases = exposures.flatMap((exposure) => PATCHES.map((patch) => ({ exposure, patch })));

  try {
    for (const { exposure, patch } of cases) {
      const rendered = await renderPatch({ ...config, exposureOffset: exposure }, workDir, patch);
      const expected = predict(cube, patch.slogCode, exposure);
      const worstDeviation = Math.max(
        ...([0, 1, 2] as const).map((channel) =>
          Math.abs((rendered[channel] as number) - (expected[channel] as number)),
        ),
      );
      const offsetLabel = exposure === 0 ? '' : ` at ${exposure > 0 ? '+' : ''}${exposure} stops`;
      check(
        `${patch.name}${offsetLabel} matches what the LUT predicts`,
        worstDeviation <= TOLERANCE_8BIT,
        `rendered rgb(${rendered.join(', ')}), LUT predicts rgb(${expected.join(', ')}), worst off by ${worstDeviation}`,
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
