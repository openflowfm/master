// The whole job, as a library: identify, pick the track, lay the probes out,
// listen, plan, apply, verify (one corrective round at most), and remember the
// run for `capture`. The CLI supplies the I/O; tests can supply their own.

import { applyPlan, writeSettings, type AppliedStep } from './apply.ts';
import type { Bridge } from './bridge.ts';
import { appendCapture, captureChain, capturesFile, loadLastRun, saveLastRun } from './capture.ts';
import { ensureProbes, readRun } from './chain.ts';
import { CurveCache } from './paramSearch.ts';
import { runPass, type PassResult } from './pass.ts';
import { planChain } from './planner.ts';
import type { ProbeEntry, ProbeReport, Track } from './protocol.ts';
import { pickTrack, type TrackChoice } from './track.ts';
import type { CaptureEntry, Material, Plan } from './types.ts';
import { assess, type Assessment } from './verify.ts';

export const CLIENT = { client: 'mastering', name: 'master[flow]' } as const;

export interface SessionIO {
  log(line: string): void;
  /** Resolves when the user says the recording has been played through. */
  waitForDone(): Promise<unknown>;
  /** Live progress during a pass; optional. */
  progress?(key: string, report: ProbeReport): void;
}

export interface RunOptions extends TrackChoice {
  material: Material;
  targetLufs?: number;
  /** Plan only: insert and set nothing. */
  dryRun?: boolean;
  stateDir: string;
}

export interface RunResult {
  track: Track;
  pre: ProbeReport | null;
  plan: Plan | null;
  applied: AppliedStep[];
  assessment: Assessment | null;
  /** Set when probes are missing: what to drop where. */
  instructions?: string[];
}

export function identify(bridge: Bridge, version: string): void {
  bridge.send({ type: 'identify', ...CLIENT, version });
}

export async function chooseTrack(bridge: Bridge, choice: TrackChoice): Promise<Track> {
  const snapshot = await bridge.request({ type: 'snapshot' }, 'snapshot', 120_000);
  const track = pickTrack(snapshot.data, choice);
  if (typeof track === 'string') throw new Error(track);
  return track;
}

async function listen(bridge: Bridge, keys: string[], io: SessionIO): Promise<PassResult> {
  return runPass(bridge, keys, {
    stop: io.waitForDone(),
    onReport: (key, report, final) => {
      if (!final) io.progress?.(key, report);
    },
  });
}

export async function run(bridge: Bridge, options: RunOptions, io: SessionIO): Promise<RunResult> {
  const track = await chooseTrack(bridge, options);
  io.log(`Track ${track.i}: "${track.name}".`);
  const base: RunResult = { track, pre: null, plan: null, applied: [], assessment: null };

  try {
    const probes = await ensureProbes(bridge, track);
    if (!probes.ok) {
      for (const line of probes.instructions) io.log(line);
      return { ...base, instructions: probes.instructions };
    }

    io.log('Listening. Play the recording through from the start, then press a key.');
    const first = await listen(bridge, [probes.pre.key, probes.post.key], io);
    if (first.endedBy === 'elsewhere') io.log('Another client restarted the probes; using what was heard so far.');
    const pre = first.reports.get(probes.pre.key) ?? null;
    if (!pre) {
      io.log('The pre probe reported nothing. Is the track playing into it?');
      return base;
    }

    const plan = planChain(pre, { material: options.material, targetLufs: options.targetLufs });
    io.log(`Plan (${plan.material}, ${plan.targetLufs} LUFS):`);
    for (const step of plan.steps) io.log(`  ${step.device}: ${step.why}`);
    for (const note of plan.notes) io.log(`  note: ${note}`);
    await saveLastRun(options.stateDir, { at: new Date().toISOString(), track: { i: track.i, name: track.name }, pre, plan });
    if (options.dryRun) return { ...base, pre, plan };

    // The user may have moved things while the recording played: find the
    // probes again by key, from the latest `probes` list, rather than trust a
    // position read before the pass.
    const now = await bridge.probes();
    const preNow = now.find((p) => p.key === probes.pre.key);
    const postNow = now.find((p) => p.key === probes.post.key);
    const onRun = (p: ProbeEntry | undefined): p is ProbeEntry =>
      p !== undefined && p.target.t === track.i && p.target.path.length === 0;
    if (!onRun(preNow) || !onRun(postNow) || preNow.target.i >= postNow.target.i) {
      io.log(
        `The probes on "${track.name}" moved or went away during the pass; nothing was inserted. Run again to lay them out.`,
      );
      return { ...base, pre, plan };
    }

    const cache = new CurveCache();
    const applied = await applyPlan(bridge, track.i, plan, postNow.target.i, cache);
    for (const step of applied) {
      io.log(`  ${step.device} at ${step.target.i}: ${step.written.map((w) => `${w.control} ${w.display}${w.clamped ? ' (limit)' : ''}`).join(', ')}`);
      if (step.missing.length) io.log(`    not found on this device: ${step.missing.join(', ')}`);
    }

    // Verify: the post probe only, after the chain has moved it along.
    const postKey = probes.post.key;
    io.log('Checking. Play the recording through again, then press a key.');
    const second = await listen(bridge, [postKey], io);
    const post = second.reports.get(postKey);
    if (!post) {
      io.log('The post probe reported nothing; skipping the check.');
      return { ...base, pre, plan, applied };
    }
    const assessment = assess(post, plan);
    for (const line of assessment.lines) io.log(line);

    if (assessment.corrections.length) {
      const limiter = applied.find((step) => step.device === 'Limiter');
      if (limiter) {
        const devices = await readRun(bridge, track.i, [{ i: limiter.target.i, className: limiter.className }]);
        const device = devices[limiter.target.i];
        if (device && device.className === limiter.className) {
          await writeSettings(bridge, limiter.target, device, assessment.corrections, cache);
          io.log('Corrected once. Listen, tweak by ear, then run `capture` to keep the result.');
        }
      }
    } else {
      io.log('On target. Tweak by ear if you like, then run `capture` to keep the result.');
    }
    return { ...base, pre, plan, applied, assessment };
  } finally {
    bridge.send({ type: 'watchChains', subs: [] });
  }
}

export interface CaptureOptions extends TrackChoice {
  stateDir: string;
  /** Defaults to `captures.jsonl` in the state dir. */
  file?: string;
}

export async function capture(bridge: Bridge, options: CaptureOptions, io: SessionIO): Promise<CaptureEntry> {
  const track = await chooseTrack(bridge, options);
  try {
    const final = await captureChain(bridge, track.i);
    const last = await loadLastRun(options.stateDir, track.name);
    if (!last) io.log(`No earlier run for "${track.name}" here; capturing the chain without a report or plan.`);
    const entry: CaptureEntry = {
      at: new Date().toISOString(),
      track: { i: track.i, name: track.name },
      pre: last?.pre ?? null,
      plan: last?.plan ?? null,
      final,
    };
    const file = options.file ?? capturesFile(options.stateDir);
    await appendCapture(file, entry);
    io.log(`Captured ${final.length} device(s) on "${track.name}" to ${file}.`);
    return entry;
  } finally {
    bridge.send({ type: 'watchChains', subs: [] });
  }
}
