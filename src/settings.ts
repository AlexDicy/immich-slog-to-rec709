import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Config } from './config.js';
import { loadCube } from './cube.js';

/**
 * The encode parameters that decide what the graded file looks like, recorded on
 * the asset so a later run can tell whether the settings have moved on.
 *
 * The LUT is compared by a hash of the values it holds rather than by its path,
 * because the path differs between a container and a local run while the result
 * is identical, and because a LUT can be edited in place without its name
 * changing. Hashing the parsed values rather than the file's bytes means line
 * endings, comments, and number formatting do not count as a change: a .cube
 * exported on Windows has CRLF line endings, which git converts on commit.
 * Its file name is recorded only so a person reading the marker can tell which LUT
 * it was, so renaming the file does not make a clip look stale. Only things that
 * change the output belong here: adding a field that does not, such as the work
 * directory, would make every clip look stale.
 */
export interface EncodeSettings {
  crf: number;
  preset: string;
  maxHeight: number;
  maxBitrate: number;
  audioBitrate: string;
  lut: string;
  lutHash: string;
  exposure: number;
}

/**
 * What a field added after markers were already being written means when a marker
 * lacks it. Without this, adding a setting would make every existing clip look
 * stale, when they were in fact graded with what is still the default.
 */
const UNRECORDED_DEFAULTS: Partial<EncodeSettings> = { exposure: 0 };

/** Recorded for people reading the marker, not compared. */
const DESCRIPTIVE_KEYS: ReadonlySet<keyof EncodeSettings> = new Set(['lut']);

function comparedKeys(current: EncodeSettings): (keyof EncodeSettings)[] {
  return (Object.keys(current) as (keyof EncodeSettings)[]).filter((key) => !DESCRIPTIVE_KEYS.has(key));
}

function recordedValue(recorded: Record<string, unknown>, key: keyof EncodeSettings): unknown {
  return key in recorded ? recorded[key] : UNRECORDED_DEFAULTS[key];
}

const hashCache = new Map<string, string>();

async function lutHash(path: string): Promise<string> {
  const cached = hashCache.get(path);
  if (cached) return cached;
  const cube = await loadCube(path);
  const hash = createHash('sha256')
    .update(JSON.stringify({ size: cube.size, domainMin: cube.domainMin, domainMax: cube.domainMax }))
    .update(new Uint8Array(cube.table.buffer, cube.table.byteOffset, cube.table.byteLength))
    .digest('hex')
    .slice(0, 12);
  hashCache.set(path, hash);
  return hash;
}

export async function currentSettings(config: Config): Promise<EncodeSettings> {
  return {
    crf: config.encodeCrf,
    preset: config.encodePreset,
    maxHeight: config.encodeMaxHeight,
    maxBitrate: config.encodeMaxBitrate,
    audioBitrate: config.audioBitrate,
    lut: basename(config.lutPath),
    lutHash: await lutHash(config.lutPath),
    exposure: config.exposureOffset,
  };
}

/**
 * Whether a recorded settings block still matches. Anything unrecognizable,
 * including the absence of a block, counts as a mismatch: a marker written before
 * this was tracked cannot be shown to match, and reprocessing it is the safe
 * reading of "the settings changed".
 */
export function settingsMatch(recorded: unknown, current: EncodeSettings): boolean {
  if (!recorded || typeof recorded !== 'object') return false;
  const value = recorded as Record<string, unknown>;
  return comparedKeys(current).every((key) => recordedValue(value, key) === current[key]);
}

export function describeSettingsDrift(recorded: unknown, current: EncodeSettings): string {
  if (!recorded || typeof recorded !== 'object') return 'no settings were recorded';
  const value = recorded as Record<string, unknown>;
  const drifted = comparedKeys(current)
    .filter((key) => recordedValue(value, key) !== current[key])
    .map((key) => `${key} ${JSON.stringify(recordedValue(value, key))} -> ${JSON.stringify(current[key])}`);
  return drifted.length > 0 ? drifted.join(', ') : 'settings match';
}
