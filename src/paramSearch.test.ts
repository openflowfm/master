import { describe, expect, it } from 'vitest';
import { CurveCache, findRawValue, MAX_VALUES, type ControlRef, type TextQuery } from './paramSearch.ts';
import type { Unit } from './types.ts';

/** A fake control: raw → Live-style display text, with call checks. */
function fake(ref: ControlRef, curve: (raw: number) => string): { query: TextQuery; calls: number[][] } {
  const calls: number[][] = [];
  const query: TextQuery = async (values) => {
    calls.push(values);
    expect(values.length).toBeGreaterThan(0);
    expect(values.length).toBeLessThanOrEqual(MAX_VALUES);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(ref.min);
      expect(v).toBeLessThanOrEqual(ref.max);
    }
    return values.map(curve);
  };
  return { query, calls };
}

/** EQ-style log frequency, 10 Hz – 22 kHz over 0..1. */
const freqHz = (raw: number): number => 10 * 2200 ** raw;
function freqText(raw: number): string {
  const f = freqHz(raw);
  if (f >= 10000) return `${(f / 1000).toFixed(1)} kHz`;
  if (f >= 1000) return `${(f / 1000).toFixed(2)} kHz`;
  if (f >= 100) return `${f.toFixed(0)} Hz`;
  return `${f.toFixed(1)} Hz`;
}

/** Gain: "-inf dB" at 0, up to +6 dB at 1. */
function gainText(raw: number): string {
  return raw === 0 ? '-inf dB' : `${(20 * Math.log10(raw) + 6).toFixed(1)} dB`;
}

/** Compressor-style ratio 1..100, "inf : 1" at the top. */
function ratioText(raw: number): string {
  return raw === 1 ? 'inf : 1' : `${(1 + 99 * raw ** 3).toFixed(2)} : 1`;
}

/** A decreasing time curve over 0..127, shown in ms or s. */
const timeMs = (raw: number): number => 1000 * Math.exp(-raw / 30);
function timeText(raw: number): string {
  const ms = timeMs(raw);
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

/** A curve whose display rounds to 1 decimal: flat runs across raw. */
function quantText(raw: number): string {
  return `${(Math.round(raw * 500) / 10).toFixed(1)} %`;
}

const FREQ: ControlRef = { className: 'Eq8', control: '1 Frequency A', min: 0, max: 1 };
const GAIN: ControlRef = { className: 'Eq8', control: '1 Gain A', min: 0, max: 1 };
const RATIO: ControlRef = { className: 'Compressor2', control: 'Ratio', min: 0, max: 1 };
const TIME: ControlRef = { className: 'Fake', control: 'Decay', min: 0, max: 127 };
const QUANT: ControlRef = { className: 'Fake', control: 'Amount', min: -1, max: 1 };

async function run(ref: ControlRef, curve: (raw: number) => string, target: number, unit: Unit, cache = new CurveCache()) {
  const { query, calls } = fake(ref, curve);
  const result = await findRawValue(ref, target, unit, query, cache);
  expect(result.display).toBe(curve(result.raw));
  return { result, calls, cache };
}

describe('findRawValue', () => {
  it.each([350, 1234, 80, 5000, 15000, 10.5, 21900])('finds %d Hz on a log curve', async (target) => {
    const { result, calls } = await run(FREQ, freqText, target, 'Hz');
    expect(result.clamped).toBe(false);
    // Within half the display's resolution of the target.
    const step = target >= 10000 ? 100 : target >= 1000 ? 10 : target >= 100 ? 1 : 0.1;
    expect(Math.abs(result.reached - target)).toBeLessThanOrEqual(step / 2 + 1e-9);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('reads 350 Hz exactly', async () => {
    const { result } = await run(FREQ, freqText, 350, 'Hz');
    expect(result.display).toBe('350 Hz');
    expect(Math.abs(freqHz(result.raw) - 350)).toBeLessThan(0.5);
  });

  it('clamps targets outside the range to the nearest endpoint', async () => {
    const low = await run(FREQ, freqText, 5, 'Hz');
    expect(low.result).toMatchObject({ raw: 0, reached: 10, clamped: true });
    const high = await run(FREQ, freqText, 30000, 'Hz');
    expect(high.result).toMatchObject({ raw: 1, clamped: true });
    expect(high.calls.length).toBe(1);
  });

  it('handles a -inf endpoint on a gain curve', async () => {
    const off = await run(GAIN, gainText, -Infinity, 'dB');
    expect(off.result).toMatchObject({ raw: 0, display: '-inf dB', clamped: false });
    expect(off.calls.length).toBe(1);

    const low = await run(GAIN, gainText, -48.3, 'dB');
    expect(low.result.reached).toBeCloseTo(-48.3, 6);
    expect(low.result.clamped).toBe(false);

    const mid = await run(GAIN, gainText, -3.7, 'dB');
    expect(mid.result.reached).toBeCloseTo(-3.7, 6);

    const top = await run(GAIN, gainText, 12, 'dB');
    expect(top.result).toMatchObject({ raw: 1, reached: 6, clamped: true });
  });

  it('finds a ratio and the inf endpoint', async () => {
    const four = await run(RATIO, ratioText, 4, 'ratio');
    expect(four.result.display).toBe('4.00 : 1');
    const inf = await run(RATIO, ratioText, Infinity, 'ratio');
    expect(inf.result).toMatchObject({ raw: 1, display: 'inf : 1', clamped: false });
    const below = await run(RATIO, ratioText, 0.5, 'ratio');
    expect(below.result).toMatchObject({ raw: 0, reached: 1, clamped: true });
  });

  it('follows a decreasing curve over a wider raw range', async () => {
    const half = await run(TIME, timeText, 500, 'ms');
    expect(half.result.display).toBe('500.0 ms');
    expect(half.result.raw).toBeCloseTo(-30 * Math.log(0.5), 2);

    const short = await run(TIME, timeText, 40, 'ms');
    expect(Math.abs(short.result.reached - 40)).toBeLessThanOrEqual(0.05 + 1e-9);

    const long = await run(TIME, timeText, 2000, 'ms');
    expect(long.result).toMatchObject({ raw: 0, display: '1.00 s', reached: 1000, clamped: true });
  });

  it('settles inside flat runs of a rounding display', async () => {
    const exact = await run(QUANT, quantText, 12.3, '%');
    expect(exact.result.display).toBe('12.3 %');

    // 12.35 falls between two display steps: either neighbour is as close as the display gets.
    const between = await run(QUANT, quantText, 12.35, '%');
    expect(['12.3 %', '12.4 %']).toContain(between.result.display);
    expect(between.result.clamped).toBe(false);
    expect(between.calls.length).toBeLessThanOrEqual(3);

    const negative = await run(QUANT, quantText, -33.3, '%');
    expect(negative.result.display).toBe('-33.3 %');
  });

  it('stops after the coarse sweep when it already reads the target', async () => {
    const ref: ControlRef = { className: 'Fake', control: 'Linear', min: 0, max: 63 };
    const { result, calls } = await run(ref, (raw) => `${raw.toFixed(0)} %`, 50, '%');
    expect(result).toMatchObject({ raw: 50, display: '50 %', clamped: false });
    expect(calls.length).toBe(1);
  });

  it('uses at most one query once the cache is warm', async () => {
    const cache = new CurveCache();
    await run(FREQ, freqText, 1000, 'Hz', cache);

    for (const target of [350, 2345, 80, 12000, 30000, 1000]) {
      const { result, calls } = await run(FREQ, freqText, target, 'Hz', cache);
      expect(calls.length).toBeLessThanOrEqual(1);
      if (target <= 22000) {
        const step = target >= 10000 ? 100 : target >= 1000 ? 10 : target >= 100 ? 1 : 0.1;
        // One round inside a cached bracket: within one display step.
        expect(Math.abs(result.reached - target)).toBeLessThanOrEqual(step);
      } else {
        expect(result.clamped).toBe(true);
      }
    }
  });

  it('shares cached curves across devices of the same class and control', async () => {
    const cache = new CurveCache();
    await run(FREQ, freqText, 1000, 'Hz', cache);
    const other = await run({ ...FREQ }, freqText, 500, 'Hz', cache);
    expect(other.calls.length).toBeLessThanOrEqual(1);
    const otherControl = await run({ ...FREQ, control: '2 Frequency A' }, freqText, 500, 'Hz', cache);
    expect(otherControl.calls.length).toBeGreaterThan(1);
  });

  it('rejects a reply with the wrong number of texts', async () => {
    const query: TextQuery = async () => ['1 Hz'];
    await expect(findRawValue(FREQ, 100, 'Hz', query, new CurveCache())).rejects.toThrow(/texts/);
  });
});
