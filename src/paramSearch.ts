// Finding the raw value that makes a Live control read a real-unit target.
//
// Live's built-in controls take a raw value (mostly 0–1) and map it to a
// display like "350 Hz" through a curve only Live knows. The bridge's
// `paramText` request asks Live for the display text of up to 64 raw values at
// once without writing anything, so the curve is sampled in batches and
// narrowed around the target.

import { displayStep, parseDisplay } from './display.ts';
import type { Unit } from './types.ts';

/** Display texts for raw values of one control, at most 64 per call, in order. */
export type TextQuery = (values: number[]) => Promise<string[]>;

/** One control of one device class, with its raw range. */
export interface ControlRef {
  className: string;
  control: string;
  min: number;
  max: number;
}

/** One sampled point of a control's curve. */
export interface CurvePoint {
  raw: number;
  text: string;
  /** The text in real units, or null when it holds no number. */
  value: number | null;
  /** The resolution the text shows, in real units. */
  step: number;
}

/** The most raw values one `paramText` request may carry. */
export const MAX_VALUES = 64;

/** Query rounds for a search with nothing cached around the target. */
const COLD_ROUNDS = 3;
/** Query rounds once cached points already bracket the target. */
const WARM_ROUNDS = 1;

/**
 * Sampled curve points per device class and control. Live's curves belong to
 * the class, so one EQ Eight's "1 Frequency A" curve serves every EQ Eight.
 * Points are kept per unit too, since parsing depends on it.
 */
export class CurveCache {
  readonly #curves = new Map<string, Map<number, CurvePoint>>();

  #key(className: string, control: string, unit: Unit): string {
    return `${className}\u0000${control}\u0000${unit}`;
  }

  /** The cached points for a control, sorted by raw value. */
  points(className: string, control: string, unit: Unit): CurvePoint[] {
    const curve = this.#curves.get(this.#key(className, control, unit));
    return curve ? [...curve.values()].sort((a, b) => a.raw - b.raw) : [];
  }

  add(className: string, control: string, unit: Unit, points: CurvePoint[]): void {
    const key = this.#key(className, control, unit);
    let curve = this.#curves.get(key);
    if (!curve) {
      curve = new Map();
      this.#curves.set(key, curve);
    }
    for (const p of points) curve.set(p.raw, p);
  }

  clear(): void {
    this.#curves.clear();
  }
}

export interface FoundValue {
  /** The raw value to write. */
  raw: number;
  /** Live's display text at `raw`. */
  display: string;
  /** `display` in real units. */
  reached: number;
  /** True when the target lies outside what the control can reach. */
  clamped: boolean;
}

type Numbered = CurvePoint & { value: number };

function distance(value: number, target: number): number {
  return value === target ? 0 : Math.abs(value - target);
}

/** Whether a point reads the target within the display's own resolution. */
function reads(p: Numbered, target: number): boolean {
  const d = distance(p.value, target);
  return d <= p.step / 2 + Math.abs(target) * 1e-12 || d === 0;
}

function best(points: Numbered[], target: number): Numbered | undefined {
  let found: Numbered | undefined;
  for (const p of points) {
    if (!found || distance(p.value, target) < distance(found.value, target)) found = p;
  }
  return found;
}

/** The narrowest adjacent pair whose values straddle the target. */
function bracket(points: Numbered[], target: number): [Numbered, Numbered] | undefined {
  let found: [Numbered, Numbered] | undefined;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Numbered;
    const b = points[i + 1] as Numbered;
    if ((a.value - target) * (b.value - target) < 0) {
      if (!found || b.raw - a.raw < found[1].raw - found[0].raw) found = [a, b];
    }
  }
  return found;
}

/** Up to `MAX_VALUES` evenly spaced raw values strictly inside lo..hi. */
function interior(lo: number, hi: number, known: Set<number>): number[] {
  const out: number[] = [];
  for (let k = 1; k <= MAX_VALUES; k++) {
    const v = lo + ((hi - lo) * k) / (MAX_VALUES + 1);
    if (v > lo && v < hi && !known.has(v)) out.push(v);
  }
  return [...new Set(out)];
}

/** `MAX_VALUES` evenly spaced raw values across min..max, endpoints included. */
function sweep(min: number, max: number, known: Set<number>): number[] {
  const out: number[] = [];
  for (let k = 0; k < MAX_VALUES; k++) {
    const v = k === MAX_VALUES - 1 ? max : min + ((max - min) * k) / (MAX_VALUES - 1);
    if (!known.has(v)) out.push(v);
  }
  return [...new Set(out)];
}

/**
 * Finds the raw value at which the control's display reads `target` (in
 * `unit`), or the nearest it can get.
 *
 * Cold, it sweeps 64 values across min..max, then twice sweeps 64 values
 * inside the adjacent pair that straddles the target, stopping as soon as a
 * display reads the target within its own resolution. Points go into `cache`,
 * so a later search on the same class and control finds its bracket there and
 * spends at most one query. A target outside the reachable range gives the
 * nearest endpoint with `clamped: true`. Every value sent lies in min..max.
 */
export async function findRawValue(
  ref: ControlRef,
  target: number,
  unit: Unit,
  query: TextQuery,
  cache: CurveCache,
): Promise<FoundValue> {
  const { className, control } = ref;
  const min = Math.min(ref.min, ref.max);
  const max = Math.max(ref.min, ref.max);
  if (Number.isNaN(target)) throw new Error('findRawValue: target is NaN');

  const current = (): Numbered[] =>
    cache
      .points(className, control, unit)
      .filter((p): p is Numbered => p.value !== null && p.raw >= min && p.raw <= max);

  const ask = async (values: number[]): Promise<void> => {
    const texts = await query(values);
    if (texts.length !== values.length) {
      throw new Error(`paramText answered ${texts.length} texts for ${values.length} values`);
    }
    cache.add(
      className,
      control,
      unit,
      values.map((raw, i) => {
        const text = texts[i] ?? '';
        return { raw, text, value: parseDisplay(text, unit), step: displayStep(text, unit) ?? 0 };
      }),
    );
  };

  const known = (): Set<number> => new Set(cache.points(className, control, unit).map((p) => p.raw));
  const hasEnds = (): boolean => {
    const raws = known();
    return raws.has(min) && raws.has(max);
  };

  const startPoints = current();
  let rounds =
    startPoints.length > 0 && (bracket(startPoints, target) || hasEnds()) ? WARM_ROUNDS : COLD_ROUNDS;

  for (;;) {
    const points = current();
    const top = best(points, target);
    if (top && reads(top, target)) return found(top, false);
    const pair = bracket(points, target);
    if (!pair) {
      if (hasEnds() || rounds === 0) {
        if (!top) throw new Error(`no numeric display for ${className} / ${control}`);
        return found(top, true);
      }
      rounds--;
      await ask(sweep(min, max, known()));
      continue;
    }
    const values = rounds > 0 ? interior(pair[0].raw, pair[1].raw, known()) : [];
    if (values.length === 0) return found(top ?? pair[0], false);
    rounds--;
    await ask(values);
  }
}

function found(p: Numbered, clamped: boolean): FoundValue {
  return { raw: p.raw, display: p.text, reached: p.value, clamped };
}
