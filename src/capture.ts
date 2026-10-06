// Learning: once the user has tweaked the chain by ear, read the final controls
// back and append `{ pre report, plan, final settings }` to a local JSONL log,
// for tuning the planner later. Also keeps the last run per track, so a
// `capture` in a later process knows what was heard and planned.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Bridge } from './bridge.ts';
import { readRun } from './chain.ts';
import type { ChainDevice, ProbeEntry, ProbeReport } from './protocol.ts';
import type { CaptureEntry, CapturedDevice, Plan } from './types.ts';

/** `$OPENFLOW_MASTER_DIR`, else `~/.openflow/master`. */
export function defaultStateDir(): string {
  return process.env.OPENFLOW_MASTER_DIR ?? join(homedir(), '.openflow', 'master');
}

export const capturesFile = (dir: string) => join(dir, 'captures.jsonl');
const lastRunFile = (dir: string) => join(dir, 'last-run.json');

/** What a `run` leaves behind for a later `capture`. */
export interface LastRun {
  at: string;
  track: { i: number; name: string };
  pre: ProbeReport | null;
  plan: Plan | null;
}

/** Remember the last run, keyed by track name (indexes move; names usually don't). */
export async function saveLastRun(dir: string, run: LastRun): Promise<void> {
  const all = await readLastRuns(dir);
  all[run.track.name] = run;
  await mkdir(dir, { recursive: true });
  await writeFile(lastRunFile(dir), `${JSON.stringify(all, null, 2)}\n`);
}

export async function loadLastRun(dir: string, trackName: string): Promise<LastRun | null> {
  return (await readLastRuns(dir))[trackName] ?? null;
}

async function readLastRuns(dir: string): Promise<Record<string, LastRun>> {
  try {
    return JSON.parse(await readFile(lastRunFile(dir), 'utf8')) as Record<string, LastRun>;
  } catch {
    return {};
  }
}

export async function appendCapture(file: string, entry: CaptureEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`);
}

/** The devices strictly between the probes, or every non-probe device when they're missing. */
export function between(devices: ChainDevice[], probes: ProbeEntry[]): number[] {
  const positions = probes.map((p) => p.target.i).sort((a, b) => a - b);
  if (positions.length >= 2) {
    const first = positions[0]!;
    const last = positions[positions.length - 1]!;
    return devices.map((_, i) => i).filter((i) => i > first && i < last && !positions.includes(i));
  }
  return devices.map((_, i) => i).filter((i) => !positions.includes(i));
}

/** Read the controls of the devices between the track's probes. */
export async function captureChain(bridge: Bridge, t: number): Promise<CapturedDevice[]> {
  const probes = (await bridge.probes()).filter((p) => p.target.t === t && p.target.path.length === 0);
  const shells = await readRun(bridge, t, []);
  const open = between(shells, probes);
  const devices = await readRun(bridge, t, open);
  return open
    .map((i) => devices[i])
    .filter((d): d is ChainDevice => d !== undefined)
    .map((device) => ({
      name: device.name,
      className: device.className,
      on: device.on,
      controls: (device.parameters ?? []).map(({ name, value, display }) => ({ name, value, display })),
    }));
}
