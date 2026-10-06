import { describe, expect, it } from 'vitest';
import { displayStep, parseDisplay } from './display.ts';

describe('parseDisplay', () => {
  it.each([
    ['350 Hz', 'Hz', 350],
    ['1.20 kHz', 'Hz', 1200],
    ['12.5k', 'Hz', 12500],
    ['22.0 kHz', 'Hz', 22000],
    ['-3.0 dB', 'dB', -3],
    ['0.00 dB', 'dB', 0],
    ['6.0 dB', 'dB', 6],
    ['−12.0 dB', 'dB', -12],
    ['4.00 : 1', 'ratio', 4],
    ['1 : 4.00', 'ratio', 4],
    ['2.5', 'ratio', 2.5],
    ['12.0 ms', 'ms', 12],
    ['1.00 s', 'ms', 1000],
    ['0.5 s', 'ms', 500],
    ['50 %', '%', 50],
    ['-12.5 %', '%', -12.5],
    ['42', 'dB', 42],
    ['.5', '%', 0.5],
  ] as const)('%s (%s) → %d', (text, unit, value) => {
    expect(parseDisplay(text, unit)).toBeCloseTo(value, 9);
  });

  it('reads infinities', () => {
    expect(parseDisplay('-inf dB', 'dB')).toBe(-Infinity);
    expect(parseDisplay('inf : 1', 'ratio')).toBe(Infinity);
    expect(parseDisplay('1 : inf', 'ratio')).toBe(Infinity);
  });

  it('returns null for text with no number', () => {
    expect(parseDisplay('Off', 'dB')).toBeNull();
    expect(parseDisplay('', 'Hz')).toBeNull();
    expect(parseDisplay('Peak', '%')).toBeNull();
  });
});

describe('displayStep', () => {
  it('gives the resolution the text shows, in real units', () => {
    expect(displayStep('1.20 kHz', 'Hz')).toBeCloseTo(10, 9);
    expect(displayStep('350 Hz', 'Hz')).toBe(1);
    expect(displayStep('-3.0 dB', 'dB')).toBeCloseTo(0.1, 9);
    expect(displayStep('1 : 4.00', 'ratio')).toBeCloseTo(0.01, 9);
    expect(displayStep('1.00 s', 'ms')).toBeCloseTo(10, 9);
    expect(displayStep('-inf dB', 'dB')).toBe(0);
    expect(displayStep('Off', 'dB')).toBeNull();
  });
});
