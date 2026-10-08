// One probe pass: start listening on some probes, collect their reports until
// the user is done, stop, and hand back the final numbers.
//
// Follows the protocol's Probe contract: reports are cumulative and broadcast,
// so only those carrying our pass number count; the pass is over only when
// `probePass { pass: ours, on: false }` arrives (the finals come before it),
// whether our stop ended it or something else did (another client's restart,
// the probes going away).

import { BridgeError, type Bridge } from './bridge.ts';
import type { Event, ProbeReport } from '@openflow/protocol';

export interface PassResult {
  pass: number;
  /** Latest report per probe key. */
  reports: Map<string, ProbeReport>;
  /** Keys whose final report arrived. */
  final: Set<string>;
  /** 'stop' when our stop ended it; 'elsewhere' when something else did. */
  endedBy: 'stop' | 'elsewhere';
}

export interface PassOptions {
  /** Resolves when the user is done (keypress, duration); we then send the stop. */
  stop: Promise<unknown>;
  onStart?: (pass: number) => void;
  onReport?: (key: string, report: ProbeReport, final: boolean) => void;
}

/**
 * Runs one pass on the probes named by `keys`. Rejects if the bridge refuses
 * the start (an `error` reply, e.g. an unknown key). A settled `stop` (resolved
 * or rejected) sends the stop; once the pass has ended, `stop` is ignored.
 */
export async function runPass(bridge: Bridge, keys: string[], options: PassOptions): Promise<PassResult> {
  const reports = new Map<string, ProbeReport>();
  const final = new Set<string>();
  let pass: number | null = null;
  let over = false;
  let markOver!: () => void;
  const finished = new Promise<void>((resolve) => (markOver = resolve));
  // A dropped socket ends the wait too, as a failure: no `probePass` can come.
  const ended = Promise.race([
    finished,
    bridge.closed.then(() => {
      if (!over) throw new BridgeError('the bridge went away during the listening pass');
    }),
  ]);
  ended.catch(() => {});
  // Events that arrive before `probeListening` tells us our number.
  const early: Event[] = [];

  const handle = (event: Event) => {
    if (over || pass === null) return;
    if (event.type === 'probeReport') {
      if (event.pass !== pass) return;
      reports.set(event.key, event.report);
      if (event.final) final.add(event.key);
      options.onReport?.(event.key, event.report, event.final);
    } else if (event.type === 'probePass') {
      if (event.pass !== pass || event.on) return;
      over = true;
      markOver();
    }
  };

  const off = bridge.on((event) => {
    if (event.type !== 'probeReport' && event.type !== 'probePass') return;
    if (pass === null) early.push(event);
    else handle(event);
  });

  try {
    const reply = await bridge.request({ type: 'probeListen', on: true, keys }, 'probeListening');
    pass = reply.pass;
    options.onStart?.(pass);
    for (const event of early.splice(0)) handle(event);

    let stopped = false;
    if (!over) {
      const userDone = options.stop.then(
        () => 'stop' as const,
        () => 'stop' as const,
      );
      const first = await Promise.race([ended.then(() => 'ended' as const), userDone]);
      if (first === 'stop' && !over) {
        stopped = true;
        bridge.send({ type: 'probeListen', on: false, pass });
        await ended;
      }
    }
    return { pass, reports, final, endedBy: stopped ? 'stop' : 'elsewhere' };
  } finally {
    off();
  }
}

/**
 * A `stop` for `runPass` that resolves after `ms`. Aborting `signal` clears the
 * timer and resolves at once (a stop after the pass has ended is ignored).
 */
export function stopAfter(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
