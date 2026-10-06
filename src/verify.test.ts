import { describe, expect, it } from 'vitest';
import type { ProbeReport } from './protocol.ts';
import type { Plan } from './types.ts';
import { assess, GAIN_RANGE_DB, limiterValue } from './verify.ts';

function report(over: Partial<ProbeReport> = {}): ProbeReport {
  return {
    seconds: 30,
    sampleRate: 48000,
    lufsIntegrated: -16,
    lufsShortTermMax: -14,
    loudnessRange: 5,
    truePeakDb: -1.5,
    samplePeakDb: -1.6,
    rmsDb: -18,
    overSamples: 0,
    dcOffset: 0,
    correlation: 1,
    bands: [],
    ...over,
  };
}

function plan(gain = 4, ceiling = -1.2): Plan {
  return {
    material: 'speech',
    targetLufs: -16,
    truePeakDb: -1,
    steps: [
      { device: 'EQ Eight', why: 'tone', settings: [{ kind: 'number', controls: ['Gain'], value: 99, unit: 'dB' }] },
      {
        device: 'Limiter',
        why: 'loudness',
        settings: [
          { kind: 'number', controls: ['Gain', 'Input Gain'], value: gain, unit: 'dB' },
          { kind: 'number', controls: ['Ceiling'], value: ceiling, unit: 'dB' },
        ],
      },
    ],
    notes: [],
  };
}

describe('limiterValue', () => {
  it("reads the Limiter step's Gain and Ceiling, not another device's", () => {
    expect(limiterValue(plan(4, -1.2), 'Gain')).toBe(4);
    expect(limiterValue(plan(4, -1.2), 'Ceiling')).toBe(-1.2);
  });

  it('is null without a Limiter or without the control', () => {
    const p = plan();
    expect(limiterValue({ ...p, steps: [p.steps[0]!] }, 'Gain')).toBeNull();
    const noCeiling: Plan = {
      ...p,
      steps: [{ device: 'Limiter', why: '', settings: [p.steps[1]!.settings[0]!] }],
    };
    expect(limiterValue(noCeiling, 'Ceiling')).toBeNull();
  });
});

describe('assess', () => {
  it('is ok with no corrections when on target', () => {
    const a = assess(report(), plan());
    expect(a.ok).toBe(true);
    expect(a.corrections).toEqual([]);
    expect(a.loudnessErrorLu).toBe(0);
    expect(a.peakOverDb).toBe(0);
  });

  it('within 1 LU needs no correction', () => {
    const a = assess(report({ lufsIntegrated: -16.9 }), plan());
    expect(a.loudnessErrorLu).toBe(0.9);
    expect(a.corrections).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it('corrects gain by the error when quiet, from the plan gain by default', () => {
    const a = assess(report({ lufsIntegrated: -19 }), plan(4));
    expect(a.loudnessErrorLu).toBe(3);
    expect(a.ok).toBe(false);
    expect(a.corrections).toEqual([{ kind: 'number', controls: ['Gain'], value: 7, unit: 'dB' }]);
  });

  it('corrects gain downward when loud, from the current gain', () => {
    const a = assess(report({ lufsIntegrated: -13.5 }), plan(4), { gainDb: 2, ceilingDb: -1.2 });
    expect(a.loudnessErrorLu).toBe(-2.5);
    expect(a.corrections).toEqual([{ kind: 'number', controls: ['Gain'], value: -0.5, unit: 'dB' }]);
  });

  it('clamps the corrected gain to the gain range', () => {
    const [lo, hi] = GAIN_RANGE_DB;
    const up = assess(report({ lufsIntegrated: -40 }), plan(20));
    expect(up.corrections).toEqual([{ kind: 'number', controls: ['Gain'], value: hi, unit: 'dB' }]);
    const down = assess(report({ lufsIntegrated: 0 }), plan(-10));
    expect(down.corrections).toEqual([{ kind: 'number', controls: ['Gain'], value: lo, unit: 'dB' }]);
  });

  it('adds no gain correction when already pinned at the clamp', () => {
    const a = assess(report({ lufsIntegrated: -40 }), plan(GAIN_RANGE_DB[1]));
    expect(a.corrections).toEqual([]);
  });

  it('with no loudness says so and corrects no gain', () => {
    const a = assess(report({ lufsIntegrated: null }), plan());
    expect(a.lufs).toBeNull();
    expect(a.loudnessErrorLu).toBeNull();
    expect(a.corrections).toEqual([]);
    expect(a.lines.some((l) => /no integrated loudness/i.test(l))).toBe(true);
  });

  it('lowers the ceiling by the excess when true peak is over beyond tolerance', () => {
    const a = assess(report({ truePeakDb: 0 }), plan(4, -1.2));
    expect(a.peakOverDb).toBe(1);
    expect(a.ok).toBe(false);
    expect(a.corrections).toEqual([{ kind: 'number', controls: ['Ceiling'], value: -2.2, unit: 'dB' }]);
  });

  it('tolerates a true peak just over the ceiling', () => {
    const a = assess(report({ truePeakDb: -0.8 }), plan());
    expect(a.peakOverDb).toBe(0.2);
    expect(a.corrections).toEqual([]);
  });

  it('falls back to the plan ceiling when the plan has no Limiter', () => {
    const p = plan();
    const a = assess(report({ truePeakDb: 0 }), { ...p, steps: [] });
    expect(a.corrections).toEqual([{ kind: 'number', controls: ['Ceiling'], value: -2, unit: 'dB' }]);
  });

  it('can correct both gain and ceiling at once, and reports full-scale samples', () => {
    const a = assess(report({ lufsIntegrated: -18, truePeakDb: 0.5, overSamples: 3 }), plan(4, -1));
    expect(a.corrections.map((c) => c.controls[0])).toEqual(['Gain', 'Ceiling']);
    expect(a.lines.some((l) => l.includes('3 samples'))).toBe(true);
  });
});
