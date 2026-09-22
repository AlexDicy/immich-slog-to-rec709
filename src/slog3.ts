/**
 * Sony's S-Log3 transfer function, from the "Technical Summary for
 * S-Gamut3.Cine/S-Log3". Code values are in the full 0..1023 numbering, where 95
 * is black and 420 is 18% gray.
 */

const BREAK_CODE = 171.2102946929;
const LINEAR_AT_BREAK = 0.01125;

export function slog3ToLinear(code: number): number {
  if (code >= BREAK_CODE) return 10 ** ((code - 420) / 261.5) * (0.18 + 0.01) - 0.01;
  return ((code - 95) * LINEAR_AT_BREAK) / (BREAK_CODE - 95);
}

export function linearToSlog3(linear: number): number {
  if (linear >= LINEAR_AT_BREAK) return 420 + Math.log10((linear + 0.01) / (0.18 + 0.01)) * 261.5;
  return (linear * (BREAK_CODE - 95)) / LINEAR_AT_BREAK + 95;
}

/** Moves an S-Log3 code value by a number of stops, the way opening the aperture would. */
export function shiftExposure(code: number, stops: number): number {
  return linearToSlog3(slog3ToLinear(code) * 2 ** stops);
}

/**
 * The same shift as an FFmpeg expression over a lutrgb channel value, which runs
 * from 0 to maxval. It is the two functions above written out with st() and ld()
 * holding the intermediate values, so the selftest can compare the two directly.
 */
export function shiftExposureExpression(stops: number): string {
  const gain = 2 ** stops;
  const toLinear = `if(gte(ld(0),${BREAK_CODE}),pow(10,(ld(0)-420)/261.5)*0.19-0.01,(ld(0)-95)*${LINEAR_AT_BREAK}/(${BREAK_CODE}-95))`;
  const toCode = `if(gte(ld(1),${LINEAR_AT_BREAK}),420+log((ld(1)+0.01)/0.19)/log(10)*261.5,ld(1)*(${BREAK_CODE}-95)/${LINEAR_AT_BREAK}+95)`;
  return [
    'st(0,val/maxval*1023)',
    `st(1,${toLinear}*${gain})`,
    `clip(${toCode}/1023*maxval,0,maxval)`,
  ].join(';');
}
