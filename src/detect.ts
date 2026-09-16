import type { Config } from './config.js';
import { run } from './exec.js';
import { log } from './log.js';

export interface Probe {
  width: number;
  height: number;
  pixelFormat: string;
  colorRange: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  frameRate: string | null;
  hasAudio: boolean;
}

export interface Detection {
  isLog: boolean;
  /** How the verdict was reached, recorded on the asset so decisions are auditable. */
  method: 'gamma-metadata' | 'pixel-statistics' | 'none';
  /** Sony's CaptureGammaEquation, when present. */
  gamma: string | null;
  colorPrimaries: string | null;
  reason: string;
}

/**
 * Sony writes the picture profile into the acquisition metadata carried in the clip,
 * not into the container's color tags. S-Log3 has no assigned code in the H.264 or
 * HEVC specs, so the container almost always claims Rec.709 regardless of the
 * profile in use. Reading the Sony metadata is the only reliable signal.
 */
export async function readSonyGamma(config: Config, filePath: string): Promise<{ gamma: string | null; primaries: string | null }> {
  const { stdout } = await run(
    config.exiftoolPath,
    ['-ee', '-api', 'largefilesupport=1', '-json', '-CaptureGammaEquation', '-CaptureColorPrimaries', filePath],
    { timeoutMs: 5 * 60 * 1000 },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    log.warn('could not parse exiftool output', { filePath });
    return { gamma: null, primaries: null };
  }

  const record = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  const asString = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    // exiftool returns an array when the tag repeats across the clip's metadata blocks.
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
  };

  return {
    gamma: asString(record?.['CaptureGammaEquation']),
    primaries: asString(record?.['CaptureColorPrimaries']),
  };
}

export async function probe(config: Config, filePath: string): Promise<Probe> {
  const { stdout } = await run(
    config.ffprobePath,
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_entries', 'stream=index,codec_type,width,height,pix_fmt,color_range,color_primaries,color_transfer,r_frame_rate',
      filePath,
    ],
    { timeoutMs: 5 * 60 * 1000 },
  );

  const parsed = JSON.parse(stdout) as { streams?: Record<string, unknown>[] };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream['codec_type'] === 'video');
  if (!video) throw new Error(`no video stream found in ${filePath}`);

  return {
    width: Number(video['width']),
    height: Number(video['height']),
    pixelFormat: String(video['pix_fmt'] ?? ''),
    colorRange: (video['color_range'] as string | undefined) ?? null,
    colorPrimaries: (video['color_primaries'] as string | undefined) ?? null,
    colorTransfer: (video['color_transfer'] as string | undefined) ?? null,
    frameRate: (video['r_frame_rate'] as string | undefined) ?? null,
    hasAudio: streams.some((stream) => stream['codec_type'] === 'audio'),
  };
}

/**
 * Last resort for clips whose acquisition metadata was stripped in transit.
 * S-Log3 sits in a narrow band well above black with very low saturation: its
 * floor is code 95 of 1023 and a normally exposed frame rarely passes code 700.
 * This is a weaker signal than the metadata, so it stays off unless enabled.
 */
export async function detectFromPixels(config: Config, filePath: string): Promise<{ isLog: boolean; reason: string }> {
  const { stderr } = await run(
    config.ffmpegPath,
    [
      '-nostdin', '-hide_banner',
      '-i', filePath,
      // Sample across the clip rather than trusting one frame, which may be a fade.
      '-vf', 'fps=1/5,scale=in_range=full:out_range=full,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
      '-frames:v', '24',
      '-f', 'null', '-',
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );

  const values = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  if (values.length === 0) return { isLog: false, reason: 'no luma statistics available' };

  // signalstats reports on the source bit depth, so normalize to 0..1.
  const { pixelFormat } = await probe(config, filePath);
  const maxValue = pixelFormat.includes('10') ? 1023 : pixelFormat.includes('12') ? 4095 : 255;
  const normalized = values.map((value) => value / maxValue);
  const mean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const lowest = Math.min(...normalized);
  const highest = Math.max(...normalized);

  // S-Log3 black is 95/1023 = 0.093, and mid gray is 420/1023 = 0.41. Average luma
  // for log footage clusters between those. A Rec.709 clip of the same scene sits lower.
  const isLog = mean > 0.3 && mean < 0.62 && lowest > 0.08;
  return {
    isLog,
    reason: `mean luma ${mean.toFixed(3)} over ${values.length} samples (range ${lowest.toFixed(3)}..${highest.toFixed(3)})`,
  };
}

export async function detect(config: Config, filePath: string): Promise<Detection> {
  const { gamma, primaries } = await readSonyGamma(config, filePath);

  if (gamma) {
    const isLog = config.logGammaPattern.test(gamma);
    return {
      isLog,
      method: 'gamma-metadata',
      gamma,
      colorPrimaries: primaries,
      reason: `CaptureGammaEquation is "${gamma}"`,
    };
  }

  if (config.pixelFallbackEnabled) {
    const { isLog, reason } = await detectFromPixels(config, filePath);
    return {
      isLog,
      method: 'pixel-statistics',
      gamma: null,
      colorPrimaries: primaries,
      reason: `no gamma metadata, fell back to pixel statistics: ${reason}`,
    };
  }

  return {
    isLog: false,
    method: 'none',
    gamma: null,
    colorPrimaries: primaries,
    reason: 'no CaptureGammaEquation in the file and the pixel fallback is disabled',
  };
}
