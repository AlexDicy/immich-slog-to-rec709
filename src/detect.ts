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

const ITEM_NAME_TAG = 'AcquisitionRecordGroupItemName';
const ITEM_VALUE_TAG = 'AcquisitionRecordGroupItemValue';

/**
 * Reads the acquisition metadata Sony carries inside the clip.
 *
 * The clip holds an XML block of AcquisitionRecord entries, each one a name and a
 * value, in a timed metadata track. exiftool does not turn those into named tags,
 * so asking it for -CaptureGammaEquation returns nothing at all. What it reports
 * instead is one run of name tags and one run of value tags, in document order.
 * -ee reaches into the embedded track, -a keeps the repeats that exiftool would
 * otherwise collapse to the first one, and -G4 prefixes every key with its copy
 * number. That copy number is what pairs a name with its value: copy 11 of the
 * name tag belongs to copy 11 of the value tag.
 */
export async function readAcquisitionRecord(config: Config, filePath: string): Promise<Map<string, string>> {
  const { stdout } = await run(
    config.exiftoolPath,
    [
      '-ee', '-a', '-G4', '-api', 'largefilesupport=1', '-json',
      `-${ITEM_NAME_TAG}`, `-${ITEM_VALUE_TAG}`,
      // Asked for as well in case a future exiftool does expose them by name.
      '-CaptureGammaEquation', '-CaptureColorPrimaries',
      filePath,
    ],
    { timeoutMs: 5 * 60 * 1000 },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    log.warn('could not parse exiftool output', { filePath });
    return new Map();
  }

  const record = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  if (!record) return new Map();

  const names = new Map<number, string>();
  const values = new Map<number, string>();
  const named = new Map<string, string>();

  for (const [key, raw] of Object.entries(record)) {
    // The first copy carries no number, so its key is just ":TagName".
    const match = /^(?:Copy(\d+))?:(\w+)$/.exec(key);
    if (!match) continue;

    const copy = Number(match[1] ?? 0);
    const tag = match[2] as string;
    const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
    if (text === null) continue;

    if (tag === ITEM_NAME_TAG) names.set(copy, text);
    else if (tag === ITEM_VALUE_TAG) values.set(copy, text);
    else if (!named.has(tag)) named.set(tag, text);
  }

  // Anything exiftool named directly is a starting point, and the paired entries
  // read out of the document take precedence over it.
  const entries = new Map(named);
  for (const copy of [...names.keys()].sort((a, b) => a - b)) {
    const name = names.get(copy);
    const value = values.get(copy);
    if (name && value !== undefined) entries.set(name, value);
  }

  // The raw count separates "exiftool reported nothing" from "it reported tags
  // that did not pair up", which are different problems with the same symptom.
  log.debug('read acquisition metadata', { entries: entries.size, rawTags: Object.keys(record).length });
  return entries;
}

/**
 * The picture profile lives in that acquisition metadata and nowhere else. S-Log3
 * has no assigned transfer characteristic in the H.264 or HEVC specs, so the
 * container cannot describe it and does not try: a ZV-E1 clip leaves the color
 * tags unset entirely. Reading the Sony metadata is the only reliable signal.
 */
export async function readSonyGamma(config: Config, filePath: string): Promise<{ gamma: string | null; primaries: string | null }> {
  const record = await readAcquisitionRecord(config, filePath);
  return {
    gamma: record.get('CaptureGammaEquation') ?? null,
    primaries: record.get('CaptureColorPrimaries') ?? null,
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
