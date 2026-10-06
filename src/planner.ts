// The planner: turns what the probe heard before any processing (a
// `ProbeReport`) into an ordered chain of Live's built-in devices with target
// settings in real units. Pure: no I/O, no Live, same report in, same plan out.
//
// Chain order is fixed: EQ Eight → Compressor (as a de-esser) → Multiband
// Dynamics → Limiter. Every step but the Limiter is added only when the report
// says it is needed.

import type { ProbeBand, ProbeReport } from './protocol.ts';
import {
  DEFAULT_TARGET_LUFS,
  TRUE_PEAK_CEILING_DB,
  type Material,
  type Plan,
  type PlanStep,
  type Setting,
} from './types.ts';

// --- tuning constants --------------------------------------------------------

/**
 * Noise-floor rule. A band is "above its noise floor", and so may be EQ'd or
 * count as content, only when all three hold:
 * - its mean sits at least `NOISE_MARGIN_DB` above its floor (10th
 *   percentile). Steady hiss and hum have mean ≈ floor, so they never pass;
 * - its mean is above `ABSOLUTE_MIN_DB` dBFS, so near-silent bands are ignored;
 * - its mean is within `CONTENT_RANGE_DB` of the loudest band's mean, so
 *   bands far below everything else (inaudible in context) are ignored.
 */
export const NOISE_MARGIN_DB = 6;
export const ABSOLUTE_MIN_DB = -80;
export const CONTENT_RANGE_DB = 40;

/** The high-pass sits at this fraction of the lowest content band's centre. */
export const HIGH_PASS_FACTOR = 0.7;
/** No high-pass when it would land below this: there is nothing to cut. */
export const HIGH_PASS_MIN_HZ = 25;
/** Never put the high-pass above this, whatever the report says. */
export const HIGH_PASS_MAX_HZ = 120;

/** Spectral-tilt fit covers content bands in this range, Hz. */
export const TILT_FIT_MIN_HZ = 63;
export const TILT_FIT_MAX_HZ = 12500;
/** Fewer correctable bands than this in the fit range: no tonal corrections. */
export const TILT_FIT_MIN_BANDS = 5;

/** Boxiness region, Hz (band centres inclusive). */
export const BOX_RANGE_HZ: readonly [number, number] = [200, 500];
/** Mic-harshness region, Hz (band centres inclusive). */
export const HARSH_RANGE_HZ: readonly [number, number] = [2000, 5000];
/** Residuals smaller than this (dB, either sign) are left alone. */
export const MIN_DEVIATION_DB = 1;
/** Share of the residual an EQ band takes back out. */
export const CORRECTION_FRACTION = 0.6;
/** Deepest cut an EQ band makes, dB. */
export const MAX_CUT_DB = -6;
/** Biggest boost an EQ band makes, dB. */
export const MAX_BOOST_DB = 3;

/** Sibilance region, Hz (band centres inclusive: 5k, 6.3k, 8k). */
export const SIBILANCE_RANGE_HZ: readonly [number, number] = [5000, 9000];
/**
 * De-ess when the sibilance region holds more than this share of the total
 * band energy, dB. Music carries more legitimate top end (cymbals), so its
 * threshold is higher.
 */
export const SIBILANCE_THRESHOLD_DB: Record<Material, number> = { speech: -15, music: -12 };
/** De-esser threshold sits this far below the loudest sibilance band's peak. */
export const DE_ESS_DEPTH_DB = 6;
export const DE_ESS_RATIO = 4;
export const DE_ESS_ATTACK_MS = 1;
export const DE_ESS_RELEASE_MS = 60;

/** Multiband Dynamics crossovers, Hz. */
export const LOW_MID_CROSSOVER_HZ = 120;
export const MID_HIGH_CROSSOVER_HZ = 2500;
/** Skip Multiband Dynamics when loudness range is at or below this, LU. */
export const MAX_LRA_WITHOUT_COMPRESSION: Record<Material, number> = { speech: 5, music: 8 };
/** Ratio = LRA / this, clamped to the ratio range. */
export const LRA_PER_RATIO_STEP = 6;
export const MIN_RATIO = 1.25;
export const MAX_RATIO = 4;
/** Ratio when the report has no loudness range yet. */
export const DEFAULT_RATIO = 2;
/** A band group quieter than this (energy sum, dBFS) gets no threshold. */
export const MIN_GROUP_DB = ABSOLUTE_MIN_DB;
/** Thresholds are clamped into this range, dB. */
export const THRESHOLD_RANGE_DB: readonly [number, number] = [-60, 0];

/** Limiter make-up gain is clamped into this range, dB. */
export const MAKEUP_GAIN_RANGE_DB: readonly [number, number] = [-12, 24];

// --- analysis helpers --------------------------------------------------------

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Energy sum of band levels, dBFS. -150 when there are none. */
export function energySumDb(levels: number[]): number {
  const sum = levels.reduce((acc, db) => acc + 10 ** (db / 10), 0);
  return sum > 0 ? Math.max(-150, 10 * Math.log10(sum)) : -150;
}

/** Loudest band mean, dBFS. */
export function loudestMeanDb(report: ProbeReport): number {
  return report.bands.reduce((max, b) => Math.max(max, b.meanDb), -150);
}

/** Whether a band clears the noise-floor rule (see `NOISE_MARGIN_DB`). */
export function isAboveFloor(band: ProbeBand, loudestDb: number): boolean {
  return (
    band.meanDb - band.floorDb >= NOISE_MARGIN_DB &&
    band.meanDb > ABSOLUTE_MIN_DB &&
    band.meanDb >= loudestDb - CONTENT_RANGE_DB
  );
}

/** Centre of the lowest band that carries real content, Hz, or null if none does. */
export function contentStartHz(report: ProbeReport): number | null {
  const loudest = loudestMeanDb(report);
  const first = report.bands.find((b) => isAboveFloor(b, loudest));
  return first ? first.hz : null;
}

/** High-pass frequency for a report, Hz, or null when none is needed. */
export function highPassHz(report: ProbeReport): number | null {
  const start = contentStartHz(report);
  if (start === null) return null;
  const hz = Math.round(start * HIGH_PASS_FACTOR);
  if (hz < HIGH_PASS_MIN_HZ) return null;
  return Math.min(hz, HIGH_PASS_MAX_HZ);
}

export interface BandResidual {
  hz: number;
  /** Band mean minus the fitted tilt at its centre, dB. Positive = too loud. */
  residualDb: number;
}

/**
 * Residuals of the correctable bands against a straight line fitted (least
 * squares) to their means over log2 frequency, within the fit range. Empty
 * when fewer than `TILT_FIT_MIN_BANDS` bands qualify.
 */
export function bandResiduals(report: ProbeReport): BandResidual[] {
  const loudest = loudestMeanDb(report);
  const pts = report.bands.filter(
    (b) => b.hz >= TILT_FIT_MIN_HZ && b.hz <= TILT_FIT_MAX_HZ && isAboveFloor(b, loudest),
  );
  if (pts.length < TILT_FIT_MIN_BANDS) return [];
  const xs = pts.map((b) => Math.log2(b.hz));
  const ys = pts.map((b) => b.meanDb);
  const n = pts.length;
  const mx = xs.reduce((a, x) => a + x, 0) / n;
  const my = ys.reduce((a, y) => a + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return pts.map((b, i) => ({ hz: b.hz, residualDb: ys[i]! - (my + slope * (xs[i]! - mx)) }));
}

export interface Correction {
  hz: number;
  /** EQ gain to apply, dB: already partial and capped. */
  gainDb: number;
}

/**
 * The correction for one region: the band with the largest residual (either
 * sign) inside it, if that residual is at least `MIN_DEVIATION_DB`. Gain is
 * `-residual × CORRECTION_FRACTION`, clamped to `MAX_CUT_DB`..`MAX_BOOST_DB`.
 */
export function regionCorrection(
  residuals: BandResidual[],
  range: readonly [number, number],
): Correction | null {
  const inRange = residuals.filter((r) => r.hz >= range[0] && r.hz <= range[1]);
  if (inRange.length === 0) return null;
  const worst = inRange.reduce((a, b) => (Math.abs(b.residualDb) > Math.abs(a.residualDb) ? b : a));
  if (Math.abs(worst.residualDb) < MIN_DEVIATION_DB) return null;
  const gainDb = round1(clamp(-worst.residualDb * CORRECTION_FRACTION, MAX_CUT_DB, MAX_BOOST_DB));
  return gainDb === 0 ? null : { hz: worst.hz, gainDb };
}

export interface Sibilance {
  /** Sibilance-region energy relative to all band energy, dB (≤ 0). */
  relativeDb: number;
  /** The loudest band in the region, or null when none clears the noise floor. */
  band: ProbeBand | null;
}

/**
 * Sibilance level: energy in the 5–9 kHz bands relative to the energy of all
 * bands. `band` is the loudest of those bands that clears the noise floor, so
 * steady hiss there never reads as sibilance worth de-essing.
 */
export function sibilance(report: ProbeReport): Sibilance {
  const loudest = loudestMeanDb(report);
  const region = report.bands.filter(
    (b) => b.hz >= SIBILANCE_RANGE_HZ[0] && b.hz <= SIBILANCE_RANGE_HZ[1],
  );
  const total = energySumDb(report.bands.map((b) => b.meanDb));
  const relativeDb = region.length ? energySumDb(region.map((b) => b.meanDb)) - total : -150;
  const live = region.filter((b) => isAboveFloor(b, loudest));
  const band = live.length ? live.reduce((a, b) => (b.meanDb > a.meanDb ? b : a)) : null;
  return { relativeDb, band };
}

/** Multiband Dynamics ratio for a loudness range. */
export function ratioForLra(lra: number | null): number {
  if (lra === null) return DEFAULT_RATIO;
  return Math.round(clamp(lra / LRA_PER_RATIO_STEP, MIN_RATIO, MAX_RATIO) * 100) / 100;
}

// --- steps -------------------------------------------------------------------

const num = (controls: string[], value: number, unit: Extract<Setting, { kind: 'number' }>['unit']): Setting => ({
  kind: 'number',
  controls,
  value,
  unit,
});
const item = (controls: string[], items: string[]): Setting => ({ kind: 'item', controls, items });
const on = (controls: string[]): Setting => ({ kind: 'switch', controls, on: true });

function eqBand(n: number, items: string[], hz: number, gainDb: number | null): Setting[] {
  const s: Setting[] = [
    on([`${n} Filter On A`, `${n} Filter On`]),
    item([`${n} Filter Type A`, `${n} Filter Type`], items),
    num([`${n} Frequency A`, `${n} Frequency`], hz, 'Hz'),
  ];
  if (gainDb !== null) s.push(num([`${n} Gain A`, `${n} Gain`], gainDb, 'dB'));
  return s;
}

function eqStep(report: ProbeReport): PlanStep | null {
  const hp = highPassHz(report);
  const residuals = bandResiduals(report);
  const box = regionCorrection(residuals, BOX_RANGE_HZ);
  const harsh = regionCorrection(residuals, HARSH_RANGE_HZ);
  if (hp === null && !box && !harsh) return null;

  const settings: Setting[] = [];
  const parts: string[] = [];
  if (hp !== null) {
    settings.push(...eqBand(1, ['Low Cut 48', 'Low cut 48', '48'], hp, null));
    parts.push(`cuts rumble below ${hp} Hz`);
  }
  if (box) {
    settings.push(...eqBand(2, ['Bell'], box.hz, box.gainDb));
    parts.push(`${box.gainDb < 0 ? 'tames boxiness' : 'fills a dip'} at ${box.hz} Hz`);
  }
  if (harsh) {
    settings.push(...eqBand(3, ['Bell'], harsh.hz, harsh.gainDb));
    parts.push(`${harsh.gainDb < 0 ? 'softens mic harshness' : 'restores presence'} at ${harsh.hz} Hz`);
  }
  const why = `EQ Eight ${parts.join(' and ')}.`;
  return { device: 'EQ Eight', why, settings };
}

function deEsserStep(report: ProbeReport, material: Material): PlanStep | null {
  const sib = sibilance(report);
  if (!sib.band || sib.relativeDb <= SIBILANCE_THRESHOLD_DB[material]) return null;
  const threshold = round1(clamp(sib.band.peakDb - DE_ESS_DEPTH_DB, ...THRESHOLD_RANGE_DB));
  return {
    device: 'Compressor',
    why: `Sibilance around ${sib.band.hz} Hz is strong, so a Compressor keyed on that band acts as a de-esser.`,
    settings: [
      on(['S/C EQ On', 'Sidechain EQ On']),
      item(['S/C EQ Type', 'Sidechain EQ Type'], ['Bandpass', 'Band Pass', 'Band']),
      num(['S/C EQ Freq', 'S/C EQ Frequency', 'Sidechain EQ Freq'], sib.band.hz, 'Hz'),
      num(['Threshold'], threshold, 'dB'),
      num(['Ratio'], DE_ESS_RATIO, 'ratio'),
      num(['Attack'], DE_ESS_ATTACK_MS, 'ms'),
      num(['Release'], DE_ESS_RELEASE_MS, 'ms'),
    ],
  };
}

function multibandStep(report: ProbeReport, material: Material): PlanStep | null {
  const lra = report.loudnessRange;
  if (lra !== null && lra <= MAX_LRA_WITHOUT_COMPRESSION[material]) return null;
  const ratio = ratioForLra(lra);
  const groups: [string, ProbeBand[]][] = [
    ['Low', report.bands.filter((b) => b.hz < LOW_MID_CROSSOVER_HZ)],
    ['Mid', report.bands.filter((b) => b.hz >= LOW_MID_CROSSOVER_HZ && b.hz < MID_HIGH_CROSSOVER_HZ)],
    ['High', report.bands.filter((b) => b.hz >= MID_HIGH_CROSSOVER_HZ)],
  ];
  const settings: Setting[] = [
    num(['Low-Mid Crossover'], LOW_MID_CROSSOVER_HZ, 'Hz'),
    num(['Mid-High Crossover'], MID_HIGH_CROSSOVER_HZ, 'Hz'),
  ];
  for (const [name, bands] of groups) {
    const level = energySumDb(bands.map((b) => b.meanDb));
    if (level < MIN_GROUP_DB) continue;
    settings.push(
      num([`Above Threshold (${name})`], round1(clamp(level, ...THRESHOLD_RANGE_DB)), 'dB'),
      num([`Above Ratio (${name})`], ratio, 'ratio'),
    );
  }
  const why =
    lra === null
      ? 'Multiband Dynamics evens out level at a moderate ratio until a loudness range is measured.'
      : `Loudness range is ${round1(lra)} LU, so Multiband Dynamics evens out the level per band.`;
  return { device: 'Multiband Dynamics', why, settings };
}

function limiterStep(report: ProbeReport, targetLufs: number, notes: string[]): PlanStep {
  let gain = 0;
  if (report.lufsIntegrated === null) {
    notes.push('No integrated loudness measured yet, so the Limiter adds no make-up gain.');
  } else {
    const wanted = targetLufs - report.lufsIntegrated;
    gain = round1(clamp(wanted, ...MAKEUP_GAIN_RANGE_DB));
    if (gain !== round1(wanted)) {
      notes.push(`Reaching ${targetLufs} LUFS needs ${round1(wanted)} dB; make-up gain is held at ${gain} dB.`);
    }
  }
  return {
    device: 'Limiter',
    why: `Limiter brings the level toward ${targetLufs} LUFS and keeps true peaks under ${TRUE_PEAK_CEILING_DB} dBTP.`,
    settings: [
      num(['Ceiling'], TRUE_PEAK_CEILING_DB, 'dB'),
      item(['Mode'], ['True Peak']),
      num(['Gain'], gain, 'dB'),
    ],
  };
}

// --- entry point -------------------------------------------------------------

/** Map the pre-processing probe report to an ordered device chain. */
export function planChain(
  report: ProbeReport,
  options: { material: Material; targetLufs?: number },
): Plan {
  const { material } = options;
  const targetLufs = options.targetLufs ?? DEFAULT_TARGET_LUFS[material];
  const notes: string[] = [];
  const steps = [
    eqStep(report),
    deEsserStep(report, material),
    multibandStep(report, material),
    limiterStep(report, targetLufs, notes),
  ].filter((s): s is PlanStep => s !== null);
  return { material, targetLufs, truePeakDb: TRUE_PEAK_CEILING_DB, steps, notes };
}
