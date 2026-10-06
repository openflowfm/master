// Compare what the post probe heard against the plan's targets, and work out
// the one corrective adjustment the app is allowed to make. Pure.

import type { ProbeReport } from './protocol.ts';
import type { Plan, Setting } from './types.ts';

/** Integrated loudness within this many LU of the target counts as reached. */
export const LOUDNESS_TOLERANCE_LU = 1;
/** True peak may sit this far above the ceiling before it counts as over. */
export const PEAK_TOLERANCE_DB = 0.3;
/** The Limiter's make-up gain stays inside this range, as in the planner. */
export const GAIN_RANGE_DB: readonly [number, number] = [-12, 24];

export interface Assessment {
  lufs: number | null;
  truePeakDb: number;
  /** Target minus measured, LU; null when no loudness was measured. */
  loudnessErrorLu: number | null;
  /** How far true peak is above the ceiling, dB (0 when under). */
  peakOverDb: number;
  ok: boolean;
  /** Limiter settings for the corrective round; empty when nothing needs it. */
  corrections: Setting[];
  lines: string[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The value the plan gave a numeric Limiter control, by its first name. */
export function limiterValue(plan: Plan, control: 'Gain' | 'Ceiling'): number | null {
  const limiter = plan.steps.find((step) => step.device === 'Limiter');
  const setting = limiter?.settings.find((s) => s.kind === 'number' && s.controls[0] === control);
  return setting?.kind === 'number' ? setting.value : null;
}

/**
 * Assess the post report. `gainDb` and `ceilingDb` are what the Limiter is
 * set to now (the plan's values unless already corrected).
 */
export function assess(
  post: ProbeReport,
  plan: Plan,
  current: { gainDb: number; ceilingDb: number } = {
    gainDb: limiterValue(plan, 'Gain') ?? 0,
    ceilingDb: limiterValue(plan, 'Ceiling') ?? plan.truePeakDb,
  },
): Assessment {
  const lines: string[] = [];
  const corrections: Setting[] = [];
  const lufs = post.lufsIntegrated;
  const loudnessErrorLu = lufs === null ? null : round1(plan.targetLufs - lufs);
  const peakOverDb = round1(Math.max(0, post.truePeakDb - plan.truePeakDb));

  if (loudnessErrorLu === null) {
    lines.push('No integrated loudness after the chain yet; play more of the recording to check it.');
  } else if (Math.abs(loudnessErrorLu) <= LOUDNESS_TOLERANCE_LU) {
    lines.push(`Loudness ${round1(lufs!)} LUFS, within ${LOUDNESS_TOLERANCE_LU} LU of ${plan.targetLufs}.`);
  } else {
    const [lo, hi] = GAIN_RANGE_DB;
    const gain = round1(Math.min(hi, Math.max(lo, current.gainDb + loudnessErrorLu)));
    lines.push(
      `Loudness ${round1(lufs!)} LUFS, ${Math.abs(loudnessErrorLu)} LU ${loudnessErrorLu > 0 ? 'under' : 'over'} ${plan.targetLufs}: Limiter gain ${current.gainDb} → ${gain} dB.`,
    );
    if (gain !== current.gainDb) corrections.push({ kind: 'number', controls: ['Gain'], value: gain, unit: 'dB' });
  }

  if (peakOverDb > PEAK_TOLERANCE_DB) {
    const ceiling = round1(current.ceilingDb - peakOverDb);
    lines.push(
      `True peak ${round1(post.truePeakDb)} dBTP is over ${plan.truePeakDb}: Limiter ceiling ${current.ceilingDb} → ${ceiling} dB.`,
    );
    corrections.push({ kind: 'number', controls: ['Ceiling'], value: ceiling, unit: 'dB' });
  } else {
    lines.push(`True peak ${round1(post.truePeakDb)} dBTP, under ${plan.truePeakDb}.`);
  }
  if (post.overSamples > 0) lines.push(`${post.overSamples} samples reached full scale.`);

  return { lufs, truePeakDb: post.truePeakDb, loudnessErrorLu, peakOverDb, ok: corrections.length === 0, corrections, lines };
}
