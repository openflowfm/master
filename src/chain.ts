// The track's own device run, built "as a flow": an open[flow] Probe first,
// hearing the recording as it comes in, and another last, hearing what the
// chain makes of it. Everything master[flow] inserts goes between the two.
//
// Probes are Max for Live devices, which the bridge can't insert, so a missing
// probe becomes an instruction for the person; probes that are there but in
// the wrong place are moved with `moveDevice`.

import type { Bridge } from './bridge.ts';
import type { ChainDevice, Event, ProbeEntry } from './protocol.ts';

/** What the probe device is called wherever a person is told to drop one. */
export const PROBE_DEVICE_NAME = 'open[flow] Probe';

/** One `moveDevice` within the track's own run, indexes as they are when it runs. */
export interface ProbeMove {
  /** Index of the device before this move. */
  from: number;
  /** Its `className`, which guards the move. */
  className: string;
  /** Its index after the move, counted with it lifted out. */
  at: number;
}

export type ProbeLayout =
  | {
      ok: true;
      pre: ProbeEntry;
      post: ProbeEntry;
      /** In order; each step's indexes allow for the ones before it. */
      moves: ProbeMove[];
      /** Probes between the two, left where they are. */
      extra: ProbeEntry[];
    }
  | { ok: false; moves: ProbeMove[]; instructions: string[] };

/**
 * Moves `items` as `moves` would move the run's devices. Returns a new array.
 */
export function applyMoves<T>(items: readonly T[], moves: readonly ProbeMove[]): T[] {
  const run = [...items];
  for (const move of moves) {
    const [item] = run.splice(move.from, 1);
    run.splice(move.at, 0, item as T);
  }
  return run;
}

/**
 * Plans the moves that put the track's pre probe first and its post probe
 * last, or says what the person has to drop where. `probes` are the ones on
 * the track's own run; `devices` is that run.
 */
export function planProbeLayout(trackName: string, devices: ChainDevice[], probes: ProbeEntry[]): ProbeLayout {
  for (const probe of probes) {
    if (!devices[probe.target.i]) {
      throw new Error(`probe "${probe.name}" is at ${probe.target.i}, outside the run of ${devices.length} on "${trackName}"`);
    }
  }
  const sorted = [...probes].sort((a, b) => a.target.i - b.target.i);
  // Track each device by its original index so later steps see shifted positions.
  let order = devices.map((_, index) => index);
  const moves: ProbeMove[] = [];
  const moveTo = (original: number, at: number) => {
    const from = order.indexOf(original);
    if (from === at) return;
    const move = { from, className: devices[original]!.className, at };
    moves.push(move);
    order = applyMoves(order, [move]);
  };
  const last = devices.length - 1;
  const track = `track ${JSON.stringify(trackName)}`;
  const nameAt = (position: number) => JSON.stringify(devices[order[position]!]!.name);

  if (sorted.length >= 2) {
    const pre = sorted[0]!;
    const post = sorted[sorted.length - 1]!;
    moveTo(pre.target.i, 0);
    moveTo(post.target.i, last);
    return { ok: true, pre, post, moves, extra: sorted.slice(1, -1) };
  }

  if (sorted.length === 1) {
    const probe = sorted[0]!;
    if (probe.target.i !== 0 && probe.target.i !== last) moveTo(probe.target.i, 0);
    const at = order.indexOf(probe.target.i);
    const instruction =
      at === 0
        ? `Drop an ${PROBE_DEVICE_NAME} at the end of the chain on ${track}, after ${nameAt(last)}.`
        : `Drop an ${PROBE_DEVICE_NAME} at the start of the chain on ${track}, before ${nameAt(0)}.`;
    return { ok: false, moves, instructions: [instruction] };
  }

  if (devices.length === 0) {
    return {
      ok: false,
      moves,
      instructions: [
        `The chain on ${track} is empty. Drop an ${PROBE_DEVICE_NAME} on it, then drop a second one after the first, so one sits at the start and one at the end.`,
      ],
    };
  }
  return {
    ok: false,
    moves,
    instructions: [
      `Drop an ${PROBE_DEVICE_NAME} at the start of the chain on ${track}, before ${nameAt(0)}.`,
      `Drop another ${PROBE_DEVICE_NAME} at the end of the chain on ${track}, after ${nameAt(last)}.`,
    ],
  };
}

/**
 * Watches track `t`'s own run with `open` expanded and resolves with its
 * devices from the first `chainState` that has the run and the parameters of
 * every open index that exists. Rejects if the run no longer resolves (the
 * track has gone) or on timeout. Leaves the watch in place; whoever owns the
 * view sends the next `watchChains`.
 */
export function readRun(bridge: Bridge, t: number, open: number[], timeoutMs = 5_000): Promise<ChainDevice[]> {
  return new Promise<ChainDevice[]>((resolve, reject) => {
    const finish = (settle: () => void) => {
      off();
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`timed out reading the chain on track ${t}`))),
      timeoutMs,
    );
    const off = bridge.on((event: Event) => {
      if (event.type !== 'chainState') return;
      const run = event.state.chains.find((chain) => chain.t === t && chain.path.length === 0);
      if (!run) return;
      const devices = run.devices;
      if (devices === null) {
        finish(() => reject(new Error(`the chain on track ${t} no longer resolves`)));
        return;
      }
      const ready = open.every((index) => index >= devices.length || devices[index]!.parameters !== undefined);
      if (ready) finish(() => resolve(devices));
    });
    try {
      bridge.send({ type: 'watchChains', subs: [{ t, path: [], open }] });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export type EnsuredProbes =
  | { ok: true; pre: ProbeEntry; post: ProbeEntry; devices: ChainDevice[] }
  | { ok: false; instructions: string[] };

/** How long to wait for the bridge's `probes` broadcast after moving. */
const PROBES_SETTLE_MS = 500;

const onRun = (t: number) => (probe: ProbeEntry) => probe.target.t === t && probe.target.path.length === 0;

/**
 * Makes the track's own run start with its pre probe and end with its post
 * probe, moving probes that are there, and otherwise says what to drop where.
 */
export async function ensureProbes(
  bridge: Bridge,
  track: { i: number; name: string },
): Promise<EnsuredProbes> {
  const t = track.i;
  const probes = (await bridge.probes()).filter(onRun(t));
  const devices = await readRun(bridge, t, []);
  const layout = planProbeLayout(track.name, devices, probes);
  if (layout.moves.length === 0) {
    return layout.ok
      ? { ok: true, pre: layout.pre, post: layout.post, devices }
      : { ok: false, instructions: layout.instructions };
  }

  // Keep the newest `probes` broadcast that arrives once the last move is under way.
  const heard: { probes: ProbeEntry[] | null; lastMoveSent: boolean } = { probes: null, lastMoveSent: false };
  const off = bridge.on((event) => {
    if (event.type === 'probes' && heard.lastMoveSent) heard.probes = event.probes;
  });
  try {
    for (const [index, move] of layout.moves.entries()) {
      heard.lastMoveSent = index === layout.moves.length - 1;
      await bridge.request(
        { type: 'moveDevice', target: { t, path: [], i: move.from }, className: move.className, to: { t, path: [] }, at: move.at },
        'deviceMoved',
      );
    }
    if (!layout.ok) return { ok: false, instructions: layout.instructions };
    if (!heard.probes) {
      heard.probes = await bridge.waitFor('probes', undefined, PROBES_SETTLE_MS).then(
        (event) => event.probes,
        () => null,
      );
    }
  } finally {
    off();
  }
  const fresh = heard.probes;

  const moved = await readRun(bridge, t, []);
  const positions = applyMoves(
    devices.map((_, index) => index),
    layout.moves,
  );
  const recomputed = probes.map((probe) => ({ ...probe, target: { ...probe.target, i: positions.indexOf(probe.target.i) } }));
  const latest = (fresh ?? []).filter(onRun(t));
  const find = (key: string) => latest.find((probe) => probe.key === key) ?? recomputed.find((probe) => probe.key === key)!;

  return { ok: true, pre: find(layout.pre.key), post: find(layout.post.key), devices: moved };
}
