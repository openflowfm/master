// The app's own vocabulary: what the planner hands to the apply step, and what
// the capture log stores. Nothing here is on the wire.

import type { ProbeReport } from './protocol.ts';

/** What the recording is, which sets the default loudness target. */
export type Material = 'speech' | 'music';

/** Default integrated-loudness targets, LUFS. */
export const DEFAULT_TARGET_LUFS: Record<Material, number> = { speech: -16, music: -14 };

/** The true-peak ceiling every plan aims under, dBTP. */
export const TRUE_PEAK_CEILING_DB = -1;

/** Live's browser names for the built-in devices a plan may insert. */
export type DeviceName = 'EQ Eight' | 'Compressor' | 'Multiband Dynamics' | 'Limiter';

/** Units a numeric setting is stated in, matched against Live's display text. */
export type Unit = 'Hz' | 'dB' | 'ratio' | 'ms' | '%';

/**
 * One control to set, in real units. `controls` lists candidate parameter
 * names in order of preference (`DeviceParameter.name`, matched
 * case-insensitively), because Live's names differ between versions; the
 * first one the device has wins.
 */
export type Setting =
  /** A continuous control, searched for through `paramText`. */
  | { kind: 'number'; controls: string[]; value: number; unit: Unit }
  /**
   * A quantized control set to one of its `items`: the first candidate in
   * `items` that any of the control's items contains, case-insensitively.
   */
  | { kind: 'item'; controls: string[]; items: string[] }
  /** An on/off control. */
  | { kind: 'switch'; controls: string[]; on: boolean };

export interface PlanStep {
  device: DeviceName;
  /** One line for the user: why this device is here. */
  why: string;
  settings: Setting[];
}

export interface Plan {
  material: Material;
  /** Integrated loudness the chain aims for, LUFS. */
  targetLufs: number;
  /** True-peak ceiling, dBTP. */
  truePeakDb: number;
  /**
   * The most make-up gain the Limiter may add, dB: whatever keeps the
   * recording's broadband noise floor at or under -60 dBFS, and never above
   * +12. Verify holds to it too.
   */
  maxGainDb: number;
  /**
   * Set when that cap stops the plan short of `targetLufs`: the integrated
   * loudness it is left at instead, LUFS. Verify counts that as a pass.
   */
  heldLufs: number | null;
  /** Devices in chain order. Only the ones that are needed. */
  steps: PlanStep[];
  /** Anything the user should know that isn't a device, e.g. "no loudness yet". */
  notes: string[];
}

/** One control as it was read back from the chain, for the capture log. */
export interface CapturedControl {
  name: string;
  value: number;
  display: string;
}

export interface CapturedDevice {
  name: string;
  className: string;
  on: boolean;
  controls: CapturedControl[];
}

/** One line of the learning log: what was heard, what was planned, where the user left it. */
export interface CaptureEntry {
  at: string;
  track: { i: number; name: string };
  pre: ProbeReport | null;
  plan: Plan | null;
  final: CapturedDevice[];
}
