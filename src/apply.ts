// Lay a plan into the track between its probes, then set every control in real
// units: Live's own display text is searched for the raw value that reads as
// the target (`paramText`, writing nothing), and only the answer is written,
// one control per `setDevice`.

import type { Bridge } from './bridge.ts';
import { readRun } from './chain.ts';
import { CurveCache, findRawValue, type TextQuery } from './paramSearch.ts';
import type { ChainDevice, DeviceParameterState, DeviceTarget } from './protocol.ts';
import type { DeviceName, Plan, PlanStep, Setting } from './types.ts';

/** One control as it was written. */
export interface WrittenControl {
  control: string;
  /** What the plan asked for, in words: "350 Hz", "Bell", "on". */
  wanted: string;
  /** Live's display text for what was written. */
  display: string;
  raw: number;
  /** The control's range couldn't reach the target; it sits at the nearest end. */
  clamped: boolean;
}

export interface AppliedStep {
  device: DeviceName;
  target: DeviceTarget;
  className: string;
  written: WrittenControl[];
  /** Settings none of whose candidate control names this device has. */
  missing: string[];
}

/** Find a control by any of its candidate names, case-insensitively. */
export function findControl(
  parameters: DeviceParameterState[],
  candidates: string[],
): { p: number; parameter: DeviceParameterState } | null {
  for (const name of candidates) {
    const wanted = name.toLowerCase();
    const p = parameters.findIndex((parameter) => parameter.name.toLowerCase() === wanted);
    if (p >= 0) return { p, parameter: parameters[p]! };
  }
  return null;
}

/** The index of the first item that contains any candidate, in candidate order. */
export function findItem(items: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const wanted = candidate.toLowerCase();
    const index = items.findIndex((item) => item.toLowerCase().includes(wanted));
    if (index >= 0) return index;
  }
  return -1;
}

const describe = (setting: Setting): string => {
  if (setting.kind === 'switch') return setting.on ? 'on' : 'off';
  if (setting.kind === 'item') return setting.items[0] ?? '';
  return setting.unit === 'ratio' ? `${setting.value} : 1` : `${setting.value} ${setting.unit}`;
};

/**
 * Set some controls of one device. The device's `parameters` must be present,
 * i.e. it is open in the current watch.
 */
export async function writeSettings(
  bridge: Bridge,
  target: DeviceTarget,
  device: ChainDevice,
  settings: Setting[],
  cache: CurveCache,
): Promise<{ written: WrittenControl[]; missing: string[] }> {
  const parameters = device.parameters ?? [];
  const written: WrittenControl[] = [];
  const missing: string[] = [];

  for (const setting of settings) {
    const found = findControl(parameters, setting.controls);
    if (!found) {
      missing.push(setting.controls[0] ?? '?');
      continue;
    }
    const { p, parameter } = found;
    let raw: number;
    let display: string;
    let clamped = false;

    if (setting.kind === 'switch') {
      raw = setting.on ? parameter.max : parameter.min;
      display = setting.on ? 'on' : 'off';
    } else if (setting.kind === 'item') {
      const index = findItem(parameter.items ?? [], setting.items);
      if (index < 0) {
        missing.push(`${parameter.name}: ${setting.items.join(' / ')}`);
        continue;
      }
      raw = parameter.min + index;
      display = parameter.items![index]!;
    } else {
      const query: TextQuery = async (values) =>
        (await bridge.request({ type: 'paramText', target, p, values }, 'paramText')).texts;
      const result = await findRawValue(
        { className: device.className, control: parameter.name, min: parameter.min, max: parameter.max },
        setting.value,
        setting.unit,
        query,
        cache,
      );
      raw = result.raw;
      display = result.display;
      clamped = result.clamped;
    }

    bridge.send({ type: 'setDevice', target, patch: { param: { p, value: raw } } });
    written.push({ control: parameter.name, wanted: describe(setting), display, raw, clamped });
  }
  return { written, missing };
}

/**
 * Insert the plan's devices in order just before the post probe (at
 * `postIndex` in the track's own run), then set them. Returns where each one
 * landed and what was written.
 */
export async function applyPlan(
  bridge: Bridge,
  t: number,
  plan: Plan,
  postIndex: number,
  cache = new CurveCache(),
): Promise<AppliedStep[]> {
  const placed: Array<{ step: PlanStep; target: DeviceTarget; className: string }> = [];
  for (const [k, step] of plan.steps.entries()) {
    const reply = await bridge.request(
      { type: 'insertDevice', run: { t, path: [] }, name: step.device, at: postIndex + k },
      'deviceInserted',
    );
    placed.push({ step, target: reply.target, className: reply.className });
  }

  const devices = await readRun(
    bridge,
    t,
    placed.map(({ target }) => target.i),
  );

  const applied: AppliedStep[] = [];
  for (const { step, target, className } of placed) {
    const device = devices[target.i];
    if (!device || device.className !== className) {
      applied.push({ device: step.device, target, className, written: [], missing: step.settings.map((s) => s.controls[0] ?? '?') });
      continue;
    }
    const { written, missing } = await writeSettings(bridge, target, device, step.settings, cache);
    applied.push({ device: step.device, target, className, written, missing });
  }
  return applied;
}
