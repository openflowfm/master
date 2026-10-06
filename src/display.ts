// Reading Live's display text (`str_for_value`) back into real units.

import type { Unit } from './types.ts';

/** A number or an infinity, with the text after it. */
interface Token {
  value: number;
  /** Digits after the decimal point; 0 for integers and infinities. */
  decimals: number;
  /** Lower-cased text following the number, trimmed. */
  rest: string;
}

const NUMBER = /([-+]?)(infinity|inf|∞|\d+(?:\.\d*)?|\.\d+)/;

function normalize(text: string): string {
  return text.replace(/[−–]/g, '-').trim().toLowerCase();
}

function token(text: string): Token | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const body = m[2] ?? '';
  const rest = text.slice(m.index + m[0].length).trim();
  if (body === 'inf' || body === 'infinity' || body === '∞') {
    return { value: sign * Infinity, decimals: 0, rest };
  }
  const dot = body.indexOf('.');
  return { value: sign * Number(body), decimals: dot < 0 ? 0 : body.length - dot - 1, rest };
}

/** The factor the unit suffix after a number applies (k → ×1000, s → ×1000 ms). */
function multiplier(rest: string, unit: Unit): number {
  if (unit === 'Hz' && rest.startsWith('k')) return 1000;
  if (unit === 'ms') {
    if (rest.startsWith('ms')) return 1;
    if (rest.startsWith('us') || rest.startsWith('µs') || rest.startsWith('μs')) return 0.001;
    if (rest.startsWith('s')) return 1000;
  }
  return 1;
}

/** A ratio side by side ("4.00 : 1", "1 : 4.00"): the larger side over the smaller. */
function ratio(text: string): { value: number; decimals: number } | null {
  const [left = '', right = ''] = text.split(':');
  const a = token(left);
  const b = token(right);
  if (!a || !b) return a ?? b;
  const hi = Math.max(Math.abs(a.value), Math.abs(b.value));
  const lo = Math.min(Math.abs(a.value), Math.abs(b.value));
  const big = Math.abs(a.value) >= Math.abs(b.value) ? a : b;
  return { value: lo === 0 || hi === Infinity ? Infinity : hi / lo, decimals: big.decimals };
}

function read(text: string, unit: Unit): { value: number; step: number } | null {
  const t = normalize(text);
  if (unit === 'ratio' && t.includes(':')) {
    const r = ratio(t);
    return r && { value: r.value, step: Number.isFinite(r.value) ? 10 ** -r.decimals : 0 };
  }
  const tok = token(t);
  if (!tok) return null;
  const k = multiplier(tok.rest, unit);
  const value = tok.value * k;
  return { value, step: Number.isFinite(value) ? 10 ** -tok.decimals * k : 0 };
}

/**
 * Parses Live's display text for a control into real units: "1.20 kHz" →
 * 1200 Hz, "-inf dB" → -Infinity, "1 : 4.00" → 4, "1.00 s" → 1000 ms.
 * Returns null when the text holds no number ("Off").
 */
export function parseDisplay(text: string, unit: Unit): number | null {
  return read(text, unit)?.value ?? null;
}

/**
 * The resolution the display text shows, in real units: "1.20 kHz" → 10 Hz,
 * "-3.0 dB" → 0.1. 0 for infinities, null when the text holds no number.
 */
export function displayStep(text: string, unit: Unit): number | null {
  return read(text, unit)?.step ?? null;
}
