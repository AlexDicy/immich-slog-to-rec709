import { readFile } from 'node:fs/promises';

export interface Cube {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** Flat table, red index varying fastest, as .cube files are ordered. */
  table: Float64Array;
  title: string | null;
}

export async function loadCube(path: string): Promise<Cube> {
  const text = await readFile(path, 'utf8');
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let title: string | null = null;
  const entries: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)$/i);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }
    if (/^LUT_1D_SIZE\s/i.test(line)) throw new Error(`${path} is a 1D LUT, a 3D LUT is required`);

    const titleMatch = line.match(/^TITLE\s+"?(.*?)"?$/i);
    if (titleMatch) {
      title = titleMatch[1] ?? null;
      continue;
    }

    const triple = (keyword: string): [number, number, number] | null => {
      const match = line.match(new RegExp(`^${keyword}\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)$`, 'i'));
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const min = triple('DOMAIN_MIN');
    if (min) {
      domainMin = min;
      continue;
    }
    const max = triple('DOMAIN_MAX');
    if (max) {
      domainMax = max;
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length === 3) {
      const values = parts.map(Number);
      if (values.some((value) => !Number.isFinite(value))) throw new Error(`${path} has a malformed entry: "${line}"`);
      entries.push(values[0] as number, values[1] as number, values[2] as number);
      continue;
    }

    // Anything else is a keyword this parser does not need.
  }

  if (size < 2) throw new Error(`${path} has no usable LUT_3D_SIZE`);
  const expected = size ** 3 * 3;
  if (entries.length !== expected) {
    throw new Error(`${path} has ${entries.length / 3} entries, expected ${size ** 3}`);
  }

  return { size, domainMin, domainMax, table: Float64Array.from(entries), title };
}

type Rgb = [number, number, number];

/**
 * Tetrahedral interpolation, following the same case split as FFmpeg's lut3d
 * filter so that sampling a LUT here predicts what FFmpeg will actually produce.
 */
export function sampleCube(cube: Cube, input: Rgb): Rgb {
  const { size, table, domainMin, domainMax } = cube;

  const position = input.map((value, axis) => {
    const min = domainMin[axis] as number;
    const max = domainMax[axis] as number;
    const normalized = max === min ? 0 : (value - min) / (max - min);
    return Math.min(size - 1, Math.max(0, normalized * (size - 1)));
  }) as Rgb;

  const [x, y, z] = position;
  const x0 = Math.min(Math.floor(x), size - 2);
  const y0 = Math.min(Math.floor(y), size - 2);
  const z0 = Math.min(Math.floor(z), size - 2);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;

  const corner = (dr: number, dg: number, db: number): Rgb => {
    const index = ((x0 + dr) + (y0 + dg) * size + (z0 + db) * size * size) * 3;
    return [table[index] as number, table[index + 1] as number, table[index + 2] as number];
  };

  const combine = (terms: [number, Rgb][]): Rgb => {
    const out: Rgb = [0, 0, 0];
    for (const [weight, value] of terms) {
      out[0] += weight * value[0];
      out[1] += weight * value[1];
      out[2] += weight * value[2];
    }
    return out;
  };

  const c000 = corner(0, 0, 0);
  const c111 = corner(1, 1, 1);

  if (fx > fy) {
    if (fy > fz) {
      return combine([[1 - fx, c000], [fx - fy, corner(1, 0, 0)], [fy - fz, corner(1, 1, 0)], [fz, c111]]);
    }
    if (fx > fz) {
      return combine([[1 - fx, c000], [fx - fz, corner(1, 0, 0)], [fz - fy, corner(1, 0, 1)], [fy, c111]]);
    }
    return combine([[1 - fz, c000], [fz - fx, corner(0, 0, 1)], [fx - fy, corner(1, 0, 1)], [fy, c111]]);
  }
  if (fz > fy) {
    return combine([[1 - fz, c000], [fz - fy, corner(0, 0, 1)], [fy - fx, corner(0, 1, 1)], [fx, c111]]);
  }
  if (fz > fx) {
    return combine([[1 - fy, c000], [fy - fz, corner(0, 1, 0)], [fz - fx, corner(0, 1, 1)], [fx, c111]]);
  }
  return combine([[1 - fy, c000], [fy - fx, corner(0, 1, 0)], [fx - fz, corner(1, 1, 0)], [fz, c111]]);
}
