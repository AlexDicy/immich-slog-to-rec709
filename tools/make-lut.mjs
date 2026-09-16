#!/usr/bin/env node
/*
 * Generates a neutral S-Log3 / S-Gamut3.Cine to Rec.709 3D LUT in .cube format.
 *
 * Everything here is derived from Sony's published S-Log3 transfer function and
 * S-Gamut3.Cine primaries, so the output is a technically correct conversion
 * rather than a creative look. Drop in your own .cube if you want a specific look.
 *
 * Usage:
 *   node tools/make-lut.mjs [--out luts/generated-slog3-to-rec709.cube] [--size 33]
 *                           [--white 12] [--gray 0.18]
 *                           [--contrast 1.0] [--saturation 1.0]
 *                           [--verify]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// S-Log3 transfer function (Sony, "Technical Summary for S-Gamut3.Cine/S-Log3")
// ---------------------------------------------------------------------------

const SLOG3_BREAK_CV = 171.2102946929;

/** S-Log3 code value in 0..1 (over the full 0..1023 numbering) to scene linear reflectance. */
export function slog3ToLinear(v) {
  const cv = v * 1023;
  if (cv >= SLOG3_BREAK_CV) {
    return 10 ** ((cv - 420) / 261.5) * (0.18 + 0.01) - 0.01;
  }
  return ((cv - 95) * 0.01125) / (SLOG3_BREAK_CV - 95);
}

/** Inverse of the above, kept for the self-checks below. */
export function linearToSlog3(l) {
  if (l >= 0.01125) {
    return (420 + Math.log10((l + 0.01) / (0.18 + 0.01)) * 261.5) / 1023;
  }
  return ((l * (SLOG3_BREAK_CV - 95)) / 0.01125 + 95) / 1023;
}

// ---------------------------------------------------------------------------
// Color space primaries and matrix construction
// ---------------------------------------------------------------------------

const D65 = { x: 0.3127, y: 0.329 };

const S_GAMUT3_CINE = {
  r: { x: 0.766, y: 0.275 },
  g: { x: 0.225, y: 0.8 },
  b: { x: 0.089, y: -0.087 },
  w: D65,
};

const REC709 = {
  r: { x: 0.64, y: 0.33 },
  g: { x: 0.3, y: 0.6 },
  b: { x: 0.15, y: 0.06 },
  w: D65,
};

const matMul = (a, b) =>
  a.map((row, i) => b[0].map((_, j) => row.reduce((sum, _v, k) => sum + a[i][k] * b[k][j], 0)));

const matApply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

function matInvert(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error('matrix is singular');
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/** Normalized primary matrix: RGB to CIE XYZ for a set of xy primaries and white point. */
function rgbToXyzMatrix({ r, g, b, w }) {
  const xyz = ({ x, y }) => [x / y, 1, (1 - x - y) / y];
  const [Xr, Yr, Zr] = xyz(r);
  const [Xg, Yg, Zg] = xyz(g);
  const [Xb, Yb, Zb] = xyz(b);
  const m = [
    [Xr, Xg, Xb],
    [Yr, Yg, Yb],
    [Zr, Zg, Zb],
  ];
  const scale = matApply(matInvert(m), xyz(w));
  return m.map((row) => row.map((value, j) => value * scale[j]));
}

// Both spaces are D65, so no chromatic adaptation is needed.
const SGAMUT3CINE_TO_REC709 = matMul(matInvert(rgbToXyzMatrix(REC709)), rgbToXyzMatrix(S_GAMUT3_CINE));

// ---------------------------------------------------------------------------
// Tone rendering
// ---------------------------------------------------------------------------

// Hable filmic curve. Monotonic, has a toe and a shoulder, well behaved over the
// very wide range S-Log3 carries (its clipping point is about 38x mid gray).
const HABLE = { a: 0.15, b: 0.5, c: 0.1, d: 0.2, e: 0.02, f: 0.3 };

function hable(x) {
  const { a, b, c, d, e, f } = HABLE;
  return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f;
}

/**
 * Builds a scene-linear to display-linear tone curve.
 * `white` is the scene linear value that maps to display 1.0.
 * `grayTarget` is the display linear value that 18% scene gray maps to.
 */
function makeToneCurve(white, grayTarget) {
  const curve = (exposure) => (x) => hable(exposure * x) / hable(exposure * white);

  // Solve exposure so that mid gray lands exactly where we want it.
  let lo = 1e-3;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (curve(mid)(0.18) < grayTarget) lo = mid;
    else hi = mid;
  }
  const exposure = Math.sqrt(lo * hi);
  const tone = curve(exposure);
  return { tone, exposure };
}

/** BT.709 opto-electronic transfer function: display linear to code value. */
function rec709Oetf(l) {
  if (l <= 0) return 0;
  if (l < 0.018) return 4.5 * l;
  return 1.099 * l ** 0.45 - 0.099;
}

const REC709_LUMA = [0.2126, 0.7152, 0.0722];
const luma = (rgb) => REC709_LUMA[0] * rgb[0] + REC709_LUMA[1] * rgb[1] + REC709_LUMA[2] * rgb[2];

/**
 * S-Gamut3.Cine covers colors Rec.709 cannot represent, which show up as negative
 * channel values after the matrix. Desaturating toward luminance by the smallest
 * amount that brings every channel back to zero or above keeps hue and brightness
 * while avoiding the hard clipping artifacts you get from a plain clamp.
 */
function compressGamut(rgb) {
  const minChannel = Math.min(rgb[0], rgb[1], rgb[2]);
  if (minChannel >= 0) return rgb;
  const y = luma(rgb);
  if (y <= 0) return [0, 0, 0];
  // Find t in [0,1] such that lerp(rgb, y, t) has no negative channel.
  // lerp_i = rgb_i + t * (y - rgb_i) >= 0  =>  t >= -rgb_i / (y - rgb_i)
  let t = 0;
  for (let i = 0; i < 3; i++) {
    const denominator = y - rgb[i];
    if (rgb[i] < 0 && denominator > 0) t = Math.max(t, -rgb[i] / denominator);
  }
  t = Math.min(1, t);
  return rgb.map((value) => value + t * (y - value));
}

function applySaturation(rgb, amount) {
  if (amount === 1) return rgb;
  const y = luma(rgb);
  return rgb.map((value) => y + (value - y) * amount);
}

// ---------------------------------------------------------------------------
// LUT generation
// ---------------------------------------------------------------------------

function buildTransform({ white, gray, contrast, saturation }) {
  const { tone, exposure } = makeToneCurve(white, gray);
  const grayCode = rec709Oetf(gray);

  const transform = (slogRgb) => {
    const linear = slogRgb.map(slog3ToLinear);
    const rec709Linear = matApply(SGAMUT3CINE_TO_REC709, linear);
    const compressed = compressGamut(rec709Linear);
    const toned = compressed.map((value) => tone(Math.max(0, value)));
    const saturated = applySaturation(toned, saturation);
    const coded = saturated.map((value) => rec709Oetf(Math.max(0, value)));
    const contrasted = coded.map((value) => grayCode + (value - grayCode) * contrast);
    return contrasted.map((value) => Math.min(1, Math.max(0, value)));
  };

  return { transform, tone, exposure, grayCode };
}

function writeCube(path, size, transform, header) {
  const lines = [...header.map((line) => `# ${line}`), `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
  // .cube ordering: red index varies fastest, then green, then blue.
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = transform([r / (size - 1), g / (size - 1), b / (size - 1)]);
        lines.push(out.map((value) => value.toFixed(6)).join(' '));
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------

const close = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;

function verify({ white, gray, contrast, saturation }) {
  const { transform, tone, exposure, grayCode } = buildTransform({ white, gray, contrast, saturation });
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass, detail });

  // S-Log3 reference code values, from Sony's technical summary.
  check('S-Log3 code 95 is scene black', close(slog3ToLinear(95 / 1023), 0, 1e-9), `${slog3ToLinear(95 / 1023).toExponential(3)}`);
  check('S-Log3 code 420 is 18% gray', close(slog3ToLinear(420 / 1023), 0.18, 1e-9), `${slog3ToLinear(420 / 1023).toFixed(9)}`);
  check('S-Log3 code 598 is 90% white', close(slog3ToLinear(598 / 1023), 0.9, 2e-3), `${slog3ToLinear(598 / 1023).toFixed(6)}`);

  // The two branches of the piecewise function must meet.
  const belowBreak = slog3ToLinear((SLOG3_BREAK_CV - 1e-6) / 1023);
  const aboveBreak = slog3ToLinear((SLOG3_BREAK_CV + 1e-6) / 1023);
  check('S-Log3 branches are continuous', close(belowBreak, aboveBreak, 1e-6), `${belowBreak.toFixed(9)} vs ${aboveBreak.toFixed(9)}`);

  // Round trip through the published forward and inverse functions.
  let worstRoundTrip = 0;
  for (let cv = 0; cv <= 1023; cv += 1) {
    const v = cv / 1023;
    worstRoundTrip = Math.max(worstRoundTrip, Math.abs(linearToSlog3(slog3ToLinear(v)) - v));
  }
  check('S-Log3 round trip is exact', worstRoundTrip < 1e-9, `worst error ${worstRoundTrip.toExponential(3)}`);

  // Sony publishes the RGB-to-XYZ matrix directly, which is an independent check on
  // both the primaries above and the matrix construction code.
  const publishedSGamut3CineToXyz = [
    [0.5990839208, 0.2489255161, 0.1024464902],
    [0.2150758201, 0.8850685017, -0.1001443219],
    [-0.0320658495, -0.0276583907, 1.148781991],
  ];
  const computedSGamut3CineToXyz = rgbToXyzMatrix(S_GAMUT3_CINE);
  let worstMatrix = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      worstMatrix = Math.max(worstMatrix, Math.abs(computedSGamut3CineToXyz[i][j] - publishedSGamut3CineToXyz[i][j]));
    }
  }
  check('S-Gamut3.Cine to XYZ matrix matches Sony', worstMatrix < 1e-9, `worst deviation ${worstMatrix.toExponential(3)}`);

  // Round tripping Rec.709 through XYZ must return the identity.
  const identity = matMul(matInvert(rgbToXyzMatrix(REC709)), rgbToXyzMatrix(REC709));
  let worstIdentity = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      worstIdentity = Math.max(worstIdentity, Math.abs(identity[i][j] - (i === j ? 1 : 0)));
    }
  }
  check('Rec.709 round trip through XYZ is the identity', worstIdentity < 1e-12, `worst deviation ${worstIdentity.toExponential(3)}`);

  // Every matrix row should sum to 1 so that neutral stays neutral.
  const rowSums = SGAMUT3CINE_TO_REC709.map((row) => row[0] + row[1] + row[2]);
  check('matrix preserves neutral', rowSums.every((s) => close(s, 1, 1e-9)), rowSums.map((s) => s.toFixed(9)).join(', '));

  // Tone curve anchors.
  check('tone curve puts 18% gray on target', close(tone(0.18), gray, 1e-6), `${tone(0.18).toFixed(6)}`);
  check('tone curve puts white at 1.0', close(tone(white), 1, 1e-6), `${tone(white).toFixed(6)}`);

  // Full pipeline: a neutral S-Log3 gray must come out as neutral Rec.709 at the
  // expected code value. 0.18 display linear encodes to 0.409 through the BT.709 OETF.
  const grayOut = transform([420 / 1023, 420 / 1023, 420 / 1023]);
  check('18% gray patch renders neutral', close(grayOut[0], grayOut[1], 1e-6) && close(grayOut[1], grayOut[2], 1e-6), grayOut.map((v) => v.toFixed(6)).join(', '));
  check('18% gray patch renders at Rec.709 0.409', close(grayOut[0], grayCode, 1e-6), `${grayOut[0].toFixed(6)} (8-bit ${Math.round(grayOut[0] * 255)})`);

  // Black must stay at black and the transform must be monotonic on the neutral axis.
  const blackOut = transform([95 / 1023, 95 / 1023, 95 / 1023]);
  check('S-Log3 black renders to 0', close(blackOut[0], 0, 1e-6), `${blackOut[0].toFixed(6)}`);

  let monotonic = true;
  let previous = -1;
  for (let cv = 0; cv <= 1023; cv++) {
    const value = transform([cv / 1023, cv / 1023, cv / 1023])[0];
    if (value < previous - 1e-9) monotonic = false;
    previous = value;
  }
  check('neutral ramp is monotonic', monotonic, 'no reversals across 0..1023');

  // No output may leave the legal 0..1 range.
  let inRange = true;
  const step = 1 / 16;
  for (let r = 0; r <= 1.0001; r += step) {
    for (let g = 0; g <= 1.0001; g += step) {
      for (let b = 0; b <= 1.0001; b += step) {
        for (const value of transform([Math.min(r, 1), Math.min(g, 1), Math.min(b, 1)])) {
          if (value < -1e-9 || value > 1 + 1e-9) inRange = false;
        }
      }
    }
  }
  check('all outputs stay within 0..1', inRange, 'sampled 17^3 grid');

  return { checks, transform, tone, exposure, grayCode };
}

function printExposureTable(tone, grayCode, contrast) {
  const rows = [];
  for (let stops = -7; stops <= 8; stops++) {
    const sceneLinear = 0.18 * 2 ** stops;
    const slogCode = linearToSlog3(sceneLinear);
    const displayLinear = tone(sceneLinear);
    let code = rec709Oetf(displayLinear);
    code = grayCode + (code - grayCode) * contrast;
    code = Math.min(1, Math.max(0, code));
    rows.push({
      stops: stops >= 0 ? `+${stops}` : `${stops}`,
      sceneLinear: sceneLinear.toFixed(4),
      slog10bit: slogCode <= 1 ? Math.round(slogCode * 1023) : '>1023',
      rec709: code.toFixed(4),
      rec7098bit: Math.round(code * 255),
    });
  }
  const header = ['stops', 'scene linear', 'S-Log3 10-bit', 'Rec.709', '8-bit'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
  console.log(`  ${line(header)}`);
  console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of rows) console.log(`  ${line(Object.values(row))}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    out: 'luts/generated-slog3-to-rec709.cube',
    size: 33,
    white: 12,
    gray: 0.18,
    contrast: 1,
    saturation: 1,
    verify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify') {
      options.verify = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!(key in options)) throw new Error(`unknown option: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    options[key] = key === 'out' ? value : Number(value);
  }
  if (!Number.isInteger(options.size) || options.size < 2 || options.size > 64) {
    throw new Error('--size must be an integer between 2 and 64');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log('S-Gamut3.Cine to Rec.709 matrix (computed from published primaries):');
  for (const row of SGAMUT3CINE_TO_REC709) {
    console.log(`  ${row.map((v) => v.toFixed(4).padStart(8)).join(' ')}`);
  }
  console.log();

  const { checks, transform, tone, exposure, grayCode } = verify(options);
  console.log('Self-checks:');
  for (const { name, pass, detail } of checks) {
    console.log(`  [${pass ? 'pass' : 'FAIL'}] ${name}${detail ? ` (${detail})` : ''}`);
  }
  const failures = checks.filter((c) => !c.pass);
  console.log();

  console.log(`Tone curve: white point ${options.white} scene linear, solved exposure ${exposure.toFixed(4)}`);
  printExposureTable(tone, grayCode, options.contrast);
  console.log();

  if (failures.length > 0) {
    console.error(`${failures.length} self-check(s) failed, not writing the LUT.`);
    process.exit(1);
  }

  if (options.verify) {
    console.log('Verify-only run, no LUT written.');
    return;
  }

  writeCube(options.out, options.size, transform, [
    'S-Log3 / S-Gamut3.Cine to Rec.709',
    'Generated by immich-slog-grader tools/make-lut.mjs',
    `white=${options.white} gray=${options.gray} contrast=${options.contrast} saturation=${options.saturation}`,
    'Input domain is S-Log3 code values 0..1 over the full 0..1023 numbering.',
  ]);
  console.log(`Wrote ${options.out} (${options.size}^3 = ${options.size ** 3} entries).`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('make-lut.mjs')) {
  main();
}
