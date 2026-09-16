import type { Config } from './config.js';
import { run } from './exec.js';
import type { Probe } from './detect.js';
import { log } from './log.js';

/**
 * Builds the video filter chain that applies the LUT.
 *
 * The range handling is the part that has to be exactly right. S-Log3 defines its
 * reference points as absolute code values in the 0..1023 numbering: 95 is black,
 * 420 is 18% gray, 598 is 90% white, and the LUT's input domain is those code
 * values mapped onto 0..1. A ZV-E1 clip is tagged full range and carries no
 * transfer or primaries at all, so the default decode already matches, but a clip
 * tagged limited range would have 64..940 stretched out to 0..1 and every
 * reference point shifted before the LUT ever saw it, wrecking the shadows in
 * particular. Forcing in_range=full keeps the stored code values untouched however
 * the clip is tagged.
 *
 * On the way out the values are ordinary Rec.709, so they are written back as
 * limited range and tagged accordingly, which is what players expect.
 */
export function buildFilterChain(config: Config, lutPath: string, probe: Probe): string {
  const steps: string[] = [];

  // Re-tag as full range without touching the samples, so the RGB conversion below
  // does not apply a range expansion.
  steps.push('scale=in_range=full:out_range=full');

  // Work at 16 bits per channel so the LUT is not applied to already-quantized
  // 8-bit values. gbrp16le keeps the planar layout lut3d prefers.
  steps.push('format=gbrp16le');

  steps.push(`lut3d=file=${escapeFilterPath(lutPath)}:interp=tetrahedral`);

  if (config.encodeMaxHeight > 0 && probe.height > config.encodeMaxHeight) {
    // -2 keeps the width even, which H.264 with yuv420p requires.
    steps.push(`scale=-2:${config.encodeMaxHeight}:flags=lanczos`);
  }

  steps.push('scale=in_range=full:out_range=tv');
  steps.push('format=yuv420p');

  // Label the result Rec.709 so players do not have to guess. This has to be done
  // here rather than with the encoder's -color_primaries and -color_trc options:
  // the frame properties carried down from the source win over those, and a ZV-E1
  // clip arrives with both unset, so setting them on the encoder is dropped and
  // the output ends up tagged "unknown".
  steps.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');

  return steps.join(',');
}

/**
 * The LUT path is a filter option value inside a filtergraph description, so the
 * filtergraph parser reads it before lut3d does. Quoting it and escaping the
 * separators is what keeps a Windows drive letter's colon, or a comma or bracket
 * in a filename, from being taken for filtergraph syntax. Forward slashes work on
 * both platforms. A single quote cannot be escaped in a way this parser accepts,
 * so loadConfig rejects those paths rather than leaving ffmpeg to fail later.
 */
function escapeFilterPath(path: string): string {
  const forwardSlashed = path.replace(/\\/g, '/');
  return `'${forwardSlashed.replace(/([:,\[\]])/g, '\\$1')}'`;
}

export interface GradeOptions {
  inputPath: string;
  outputPath: string;
  probe: Probe;
}

export async function grade(config: Config, options: GradeOptions): Promise<void> {
  const filterChain = buildFilterChain(config, config.lutPath, options.probe);

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-i', options.inputPath,

    '-map', '0:v:0',
    '-map', '0:a?',

    '-vf', filterChain,

    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', config.encodePreset,
    '-crf', String(config.encodeCrf),
    '-pix_fmt', 'yuv420p',

    // Carry over rotation, creation time, and the rest of the container tags.
    '-map_metadata', '0',
    '-movflags', '+faststart+use_metadata_tags',
  ];

  if (options.probe.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', config.audioBitrate);
  }

  args.push(options.outputPath);

  log.debug('grading', { filterChain });
  const started = Date.now();
  const { stderr } = await run(config.ffmpegPath, args);
  if (stderr.trim()) log.debug('ffmpeg output', { stderr: stderr.trim().split('\n').slice(-5).join(' | ') });
  log.info('graded clip', { seconds: Math.round((Date.now() - started) / 1000) });
}
