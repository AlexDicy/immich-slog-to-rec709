const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const optionalEnv = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

const numberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
};

const booleanEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean, got "${raw}"`);
};

/** Accepts a plain bit count or an ffmpeg style suffix: 20000000, 20000k, 20M. */
const bitrateEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(raw);
  if (!match) throw new Error(`${name} must be a bitrate such as 20M, 20000k, or 20000000, got "${raw}"`);
  const suffix = (match[2] ?? '').toLowerCase();
  const scale = suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return Math.round(Number(match[1]) * scale);
};

const listEnv = (name: string, fallback: string[]): string[] => {
  const raw = process.env[name]?.trim();
  if (raw === undefined) return fallback;
  if (raw === '') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
};

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const config = {
    immichUrl: requireEnv('IMMICH_URL').replace(/\/+$/, ''),
    immichApiKey: requireEnv('IMMICH_API_KEY'),

    port: numberEnv('PORT', 8710),
    bindAddress: optionalEnv('BIND_ADDRESS', '0.0.0.0'),
    /** Must match the workflow's "Header value". Leave empty only on a trusted network. */
    webhookToken: optionalEnv('WEBHOOK_TOKEN', ''),
    webhookHeader: optionalEnv('WEBHOOK_HEADER', 'x-grader-token').toLowerCase(),

    lutPath: optionalEnv('LUT_PATH', '/app/luts/lc_709_type_a.cube'),
    /** Stops of exposure added to the S-Log3 footage before the LUT. Negative darkens. */
    exposureOffset: numberEnv('EXPOSURE_OFFSET', 0),
    workDir: optionalEnv('WORK_DIR', '/tmp/slog-grader'),
    ffmpegPath: optionalEnv('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: optionalEnv('FFPROBE_PATH', 'ffprobe'),
    exiftoolPath: optionalEnv('EXIFTOOL_PATH', 'exiftool'),

    /** Cheap pre-filter. Empty list means consider every video. */
    cameraModels: listEnv('CAMERA_MODELS', ['ZV-E1']),
    /** Gamma values that count as log footage, matched against Sony's CaptureGammaEquation. */
    logGammaPattern: new RegExp(optionalEnv('LOG_GAMMA_PATTERN', '^s-log'), 'i'),
    /** Only used when the camera wrote no gamma metadata at all. Off by default. */
    pixelFallbackEnabled: booleanEnv('PIXEL_FALLBACK_ENABLED', false),

    encodeCrf: numberEnv('ENCODE_CRF', 18),
    encodePreset: optionalEnv('ENCODE_PRESET', 'slow'),
    /** 0 keeps the source resolution. */
    encodeMaxHeight: numberEnv('ENCODE_MAX_HEIGHT', 0),
    /** Bits per second the video stream may not exceed. 0 leaves CRF uncapped. */
    encodeMaxBitrate: bitrateEnv('ENCODE_MAX_BITRATE', 0),
    audioBitrate: optionalEnv('AUDIO_BITRATE', '192k'),

    gradedSuffix: optionalEnv('GRADED_SUFFIX', '_rec709'),
    metadataKey: optionalEnv('METADATA_KEY', 'slog-grader'),
    stackAssets: booleanEnv('STACK_ASSETS', true),
    tagAssets: booleanEnv('TAG_ASSETS', true),
    originalTag: optionalEnv('ORIGINAL_TAG', 'S-Log3'),
    gradedTag: optionalEnv('GRADED_TAG', 'Rec709 graded'),
    /** Hides the S-Log original from the main timeline. Stacking already collapses it. */
    archiveOriginal: booleanEnv('ARCHIVE_ORIGINAL', false),

    concurrency: numberEnv('CONCURRENCY', 1),
    keepWorkFiles: booleanEnv('KEEP_WORK_FILES', false),
    dryRun: booleanEnv('DRY_RUN', false),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };

  if (config.concurrency < 1) throw new Error('CONCURRENCY must be at least 1');
  if (config.encodeCrf < 0 || config.encodeCrf > 51) throw new Error('ENCODE_CRF must be between 0 and 51');
  if (Math.abs(config.exposureOffset) > 4) throw new Error('EXPOSURE_OFFSET must be between -4 and 4 stops');
  if (config.encodeMaxHeight < 0) throw new Error('ENCODE_MAX_HEIGHT must be 0 or positive');
  if (!config.gradedSuffix) throw new Error('GRADED_SUFFIX must not be empty, it prevents reprocessing loops');
  // There is no escaping that gets a single quote through ffmpeg's filtergraph parser.
  if (config.lutPath.includes("'")) throw new Error('LUT_PATH must not contain a single quote');

  return config;
}
