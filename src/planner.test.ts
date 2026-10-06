import { describe, expect, it } from 'vitest';
import type { ProbeBand, ProbeReport } from './protocol.ts';
import type { PlanStep, Setting } from './types.ts';
import {
  MAX_BOOST_DB,
  MAX_CUT_DB,
  MAX_RATIO,
  MIN_RATIO,
  SIBILANCE_THRESHOLD_DB,
  bandResiduals,
  contentStartHz,
  highPassHz,
  planChain,
  ratioForLra,
  sibilance,
} from './planner.ts';

const ISO = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

interface Opts {
  /** Lowest band with content, Hz. Below it: silence. */
  start?: number;
  /** Highest band with content, Hz. Above it: silence. */
  end?: number;
  /** Per-band changes to mean (dB) applied on top of the tilt. */
  bumps?: Record<number, number>;
  /** Bands turned into steady noise: mean == floor at this level. */
  steady?: Record<number, number>;
  lra?: number | null;
  lufs?: number | null;
}

/** A clean recording: -3 dB/octave tilt, 20 dB between mean and floor. */
function report(o: Opts = {}): ProbeReport {
  const start = o.start ?? 80;
  const end = o.end ?? 12500;
  const bands: ProbeBand[] = ISO.map((hz) => {
    if (o.steady?.[hz] !== undefined) {
      const l = o.steady[hz]!;
      return { hz, meanDb: l, floorDb: l - 1, peakDb: l + 1 };
    }
    if (hz < start || hz > end) return { hz, meanDb: -110, floorDb: -112, peakDb: -105 };
    const meanDb = -30 - 3 * Math.log2(hz / 1000) + (o.bumps?.[hz] ?? 0);
    return { hz, meanDb, floorDb: meanDb - 20, peakDb: meanDb + 8 };
  });
  return {
    seconds: 30,
    sampleRate: 48000,
    lufsIntegrated: o.lufs === undefined ? -20 : o.lufs,
    lufsShortTermMax: -14,
    loudnessRange: o.lra === undefined ? 4 : o.lra,
    truePeakDb: -3,
    samplePeakDb: -3.2,
    rmsDb: -22,
    overSamples: 0,
    dcOffset: 0,
    correlation: 1,
    bands,
  };
}

const devices = (steps: PlanStep[]) => steps.map((s) => s.device);
const step = (steps: PlanStep[], device: string) => steps.find((s) => s.device === device);
function value(s: PlanStep | undefined, control: string): number | undefined {
  const hit = s?.settings.find((x): x is Extract<Setting, { kind: 'number' }> => x.kind === 'number' && x.controls[0] === control);
  return hit?.value;
}

describe('analysis helpers', () => {
  it('finds content start at the lowest band above its noise floor', () => {
    expect(contentStartHz(report({ start: 100 }))).toBe(100);
    // Steady hum at 50 Hz (mean == floor) is not content.
    expect(contentStartHz(report({ start: 100, steady: { 50: -40 } }))).toBe(100);
  });

  it('places the high-pass at 0.7x content start, none when content reaches 20 Hz', () => {
    expect(highPassHz(report({ start: 100 }))).toBe(70);
    expect(highPassHz(report({ start: 20 }))).toBeNull();
  });

  it('fits the tilt so a clean spectrum has no residuals over 1 dB', () => {
    const r = bandResiduals(report());
    expect(r.length).toBeGreaterThan(5);
    for (const b of r) expect(Math.abs(b.residualDb)).toBeLessThan(1);
  });

  it('ratio rises with loudness range, clamped, moderate when unknown', () => {
    expect(ratioForLra(10)).toBeLessThan(ratioForLra(18));
    expect(ratioForLra(100)).toBe(MAX_RATIO);
    expect(ratioForLra(6)).toBe(MIN_RATIO);
    expect(ratioForLra(null)).toBe(2);
  });
});

describe('planChain', () => {
  it('a clean, full-range, steady recording gets only a Limiter', () => {
    const plan = planChain(report({ start: 20 }), { material: 'speech' });
    expect(devices(plan.steps)).toEqual(['Limiter']);
    expect(plan.notes).toEqual([]);
  });

  it('adds only a high-pass EQ when content starts high', () => {
    const plan = planChain(report({ start: 100 }), { material: 'speech' });
    const eq = step(plan.steps, 'EQ Eight');
    expect(devices(plan.steps)).toEqual(['EQ Eight', 'Limiter']);
    expect(value(eq, '1 Frequency A')).toBe(70);
    expect(value(eq, '1 Frequency A')!).toBeLessThan(100);
    const type = eq!.settings.find((s) => s.controls[0] === '1 Filter Type A');
    expect(type).toEqual({ kind: 'item', controls: ['1 Filter Type A', '1 Filter Type'], items: ['Low Cut 48', 'Low cut 48', '48'] });
    expect(eq!.settings.some((s) => s.controls[0] === '2 Gain A')).toBe(false);
  });

  it('cuts boxiness partially, capped at the cut limit', () => {
    const small = step(planChain(report({ start: 20, bumps: { 315: 4 } }), { material: 'speech' }).steps, 'EQ Eight');
    expect(value(small, '2 Frequency A')).toBe(315);
    const g = value(small, '2 Gain A')!;
    expect(g).toBeLessThan(-1);
    expect(g).toBeGreaterThan(-4);
    const big = step(planChain(report({ start: 20, bumps: { 315: 20 } }), { material: 'speech' }).steps, 'EQ Eight');
    expect(value(big, '2 Gain A')).toBe(MAX_CUT_DB);
  });

  it('caps boosts at +3 dB', () => {
    const eq = step(planChain(report({ start: 20, bumps: { 3150: -12 } }), { material: 'speech' }).steps, 'EQ Eight');
    expect(value(eq, '3 Frequency A')).toBe(3150);
    expect(value(eq, '3 Gain A')).toBe(MAX_BOOST_DB);
  });

  it('ignores deviations under 1 dB', () => {
    const plan = planChain(report({ start: 20, bumps: { 400: 0.8, 2500: -0.8 } }), { material: 'speech' });
    expect(step(plan.steps, 'EQ Eight')).toBeUndefined();
  });

  it('does not EQ a band sitting at its noise floor', () => {
    // 4 kHz is 12 dB too loud but is steady hiss (mean == floor).
    const level = -30 - 3 * Math.log2(4) + 12;
    const plan = planChain(report({ start: 20, steady: { 4000: level } }), { material: 'speech' });
    expect(step(plan.steps, 'EQ Eight')).toBeUndefined();
  });

  it('de-esses only when sibilance is high, at the loudest sibilance band', () => {
    const calm = report({ start: 20 });
    expect(sibilance(calm).relativeDb).toBeLessThan(SIBILANCE_THRESHOLD_DB.speech);
    expect(step(planChain(calm, { material: 'speech' }).steps, 'Compressor')).toBeUndefined();

    const hot = report({ start: 20, bumps: { 5000: 12, 6300: 18, 8000: 14 } });
    expect(sibilance(hot).relativeDb).toBeGreaterThan(SIBILANCE_THRESHOLD_DB.speech);
    const comp = step(planChain(hot, { material: 'speech' }).steps, 'Compressor');
    expect(value(comp, 'S/C EQ Freq')).toBe(6300);
    expect(comp!.settings.find((s) => s.controls[0] === 'S/C EQ On')).toMatchObject({ kind: 'switch', on: true });
  });

  it('does not de-ess steady hiss in the sibilance region', () => {
    const plan = planChain(report({ start: 20, steady: { 5000: -20, 6300: -20, 8000: -20 } }), { material: 'speech' });
    expect(step(plan.steps, 'Compressor')).toBeUndefined();
  });

  it('adds Multiband Dynamics only above the per-material loudness range', () => {
    expect(step(planChain(report({ start: 20, lra: 5 }), { material: 'speech' }).steps, 'Multiband Dynamics')).toBeUndefined();
    expect(step(planChain(report({ start: 20, lra: 7 }), { material: 'speech' }).steps, 'Multiband Dynamics')).toBeDefined();
    expect(step(planChain(report({ start: 20, lra: 7 }), { material: 'music' }).steps, 'Multiband Dynamics')).toBeUndefined();
    const md = step(planChain(report({ start: 20, lra: null }), { material: 'music' }).steps, 'Multiband Dynamics');
    expect(value(md, 'Above Ratio (Mid)')).toBe(2);
    expect(value(md, 'Low-Mid Crossover')).toBe(120);
    expect(value(md, 'Mid-High Crossover')).toBe(2500);
    expect(value(md, 'Above Threshold (Low)')).toBeLessThan(0);
  });

  it('raises the ratio with loudness range', () => {
    const lo = step(planChain(report({ start: 20, lra: 10 }), { material: 'speech' }).steps, 'Multiband Dynamics');
    const hi = step(planChain(report({ start: 20, lra: 20 }), { material: 'speech' }).steps, 'Multiband Dynamics');
    expect(value(hi, 'Above Ratio (Low)')!).toBeGreaterThan(value(lo, 'Above Ratio (Low)')!);
  });

  it('orders every step EQ → de-esser → multiband → limiter', () => {
    const r = report({ start: 100, bumps: { 315: 5, 6300: 18 }, lra: 15 });
    expect(devices(planChain(r, { material: 'speech' }).steps)).toEqual([
      'EQ Eight',
      'Compressor',
      'Multiband Dynamics',
      'Limiter',
    ]);
  });

  it('limiter: -1 dBTP true-peak ceiling, gain toward target, clamped', () => {
    const plan = planChain(report({ start: 20, lufs: -22 }), { material: 'speech' });
    const lim = plan.steps.at(-1)!;
    expect(lim.device).toBe('Limiter');
    expect(lim.settings[0]).toEqual({ kind: 'number', controls: ['Ceiling'], value: -1, unit: 'dB' });
    expect(lim.settings).toContainEqual({ kind: 'item', controls: ['Mode'], items: ['True Peak'] });
    expect(value(lim, 'Gain')).toBe(6);
    expect(plan.truePeakDb).toBe(-1);

    const custom = planChain(report({ start: 20, lufs: -22 }), { material: 'speech', targetLufs: -19 });
    expect(value(custom.steps.at(-1), 'Gain')).toBe(3);

    const quiet = planChain(report({ start: 20, lufs: -70 }), { material: 'speech' });
    expect(value(quiet.steps.at(-1), 'Gain')).toBe(24);
    expect(quiet.notes.length).toBe(1);
  });

  it('null loudness: gain 0 and a note', () => {
    const plan = planChain(report({ start: 20, lufs: null }), { material: 'music' });
    expect(value(plan.steps.at(-1), 'Gain')).toBe(0);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatch(/loudness/i);
  });

  it('uses default targets per material', () => {
    expect(planChain(report({ lufs: -20 }), { material: 'speech' }).targetLufs).toBe(-16);
    const music = planChain(report({ lufs: -20 }), { material: 'music' });
    expect(music.targetLufs).toBe(-14);
    expect(value(music.steps.at(-1), 'Gain')).toBe(6);
  });

  it('every step has a one-sentence why', () => {
    const r = report({ start: 100, bumps: { 315: 5, 6300: 18 }, lra: 15 });
    for (const s of planChain(r, { material: 'speech' }).steps) expect(s.why).toMatch(/^[^.]+\.$/);
  });
});
