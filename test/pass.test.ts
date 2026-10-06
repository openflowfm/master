import { afterEach, describe, expect, it } from 'vitest';
import { connectBridge, type Bridge } from '../src/bridge.ts';
import { runPass, stopAfter } from '../src/pass.ts';
import type { Event, ProbeReport } from '../src/protocol.ts';
import { startFakeBridge, type FakeBridge } from './fakeBridge.ts';

const target = { t: 0, path: [], i: 1 };

/** A report told apart by its integrated loudness; the rest is irrelevant here. */
const reportOf = (integrated: number) => ({ integrated }) as unknown as ProbeReport;

const reportEvent = (pass: number, key: string, integrated: number, final = false): Event => ({
  type: 'probeReport',
  pass,
  key,
  target,
  final,
  report: reportOf(integrated),
});

const integratedOf = (report: ProbeReport | undefined) => (report as unknown as { integrated: number }).integrated;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

let fake: FakeBridge | undefined;
let bridge: Bridge | undefined;

afterEach(async () => {
  await bridge?.close();
  await fake?.close();
  bridge = undefined;
  fake = undefined;
});

async function setUp() {
  fake = await startFakeBridge();
  bridge = await connectBridge({ port: fake.port });
  return { fake, bridge };
}

describe('runPass', () => {
  it('collects our reports, sends the stop with our pass, and ends on probePass off', async () => {
    const { fake, bridge } = await setUp();
    fake.handle('probeListen', (request, { reply, broadcast }) => {
      if (request.on) {
        reply({ type: 'probeListening', pass: 7, probes: request.keys });
        broadcast({ type: 'probePass', pass: 7, on: true, keys: request.keys });
      } else if (request.pass === 7) {
        broadcast(reportEvent(7, 'a', -14, true));
        broadcast(reportEvent(7, 'b', -20, true));
        broadcast({ type: 'probePass', pass: 7, on: false, keys: ['a', 'b'] });
      }
    });

    const started = deferred();
    const stop = deferred();
    const seen: Array<[string, number, boolean]> = [];
    const result = runPass(bridge, ['a', 'b'], {
      stop: stop.promise,
      onStart: (pass) => {
        expect(pass).toBe(7);
        started.resolve();
      },
      onReport: (key, report, final) => seen.push([key, integratedOf(report), final]),
    });

    await started.promise;
    fake.broadcast(reportEvent(7, 'a', -16));
    fake.broadcast(reportEvent(6, 'a', -3)); // another client's pass: dropped
    fake.broadcast(reportEvent(7, 'b', -22));
    stop.resolve();

    const done = await result;
    expect(done.pass).toBe(7);
    expect(done.endedBy).toBe('stop');
    expect(integratedOf(done.reports.get('a'))).toBe(-14);
    expect(integratedOf(done.reports.get('b'))).toBe(-20);
    expect([...done.final].sort()).toEqual(['a', 'b']);
    expect(seen).toEqual([
      ['a', -16, false],
      ['b', -22, false],
      ['a', -14, true],
      ['b', -20, true],
    ]);
    const listens = fake.received.filter((r) => r.type === 'probeListen');
    expect(listens).toHaveLength(2);
    expect(listens[1]).toEqual({ type: 'probeListen', on: false, pass: 7 });
  });

  it('ends without our stop when another client restarts the probes, and never sends a stale stop', async () => {
    const { fake, bridge } = await setUp();
    fake.handle('probeListen', (request, { reply }) => {
      if (request.on && request.id !== undefined) reply({ type: 'probeListening', pass: 3, probes: request.keys });
    });

    const started = deferred();
    const stop = deferred();
    const result = runPass(bridge, ['a'], { stop: stop.promise, onStart: () => started.resolve() });
    await started.promise;
    await fake.nextRequest('probeListen'); // our start

    // Another client restarts probe a: our pass ends with its finals, then pass 4 begins.
    fake.broadcast(reportEvent(3, 'a', -18, true));
    fake.broadcast({ type: 'probePass', pass: 3, on: false, keys: ['a'] });
    fake.broadcast({ type: 'probePass', pass: 4, on: true, keys: ['a'] });
    fake.broadcast(reportEvent(4, 'a', -60));

    const done = await result;
    expect(done.endedBy).toBe('elsewhere');
    expect(integratedOf(done.reports.get('a'))).toBe(-18);
    expect([...done.final]).toEqual(['a']);

    // The user finishing now must not send a stop; a marker sent after proves none went first.
    stop.resolve();
    await stop.promise;
    await Promise.resolve();
    bridge.send({ type: 'probeListen', on: true, keys: ['marker'] });
    expect(await fake.nextRequest('probeListen')).toEqual({ type: 'probeListen', on: true, keys: ['marker'] });
  });

  it('keeps events that arrive before probeListening', async () => {
    const { fake, bridge } = await setUp();
    fake.handle('probeListen', (request, { reply, broadcast }) => {
      if (!request.on) return;
      // The bridge's pushes beat the reply: start, a report, even the end.
      broadcast({ type: 'probePass', pass: 9, on: true, keys: request.keys });
      broadcast(reportEvent(8, 'a', -1)); // not ours
      broadcast(reportEvent(9, 'a', -12));
      broadcast(reportEvent(9, 'a', -11, true));
      broadcast({ type: 'probePass', pass: 9, on: false, keys: request.keys });
      reply({ type: 'probeListening', pass: 9, probes: request.keys });
    });

    const done = await runPass(bridge, ['a'], { stop: new Promise(() => {}) });
    expect(done.pass).toBe(9);
    expect(done.endedBy).toBe('elsewhere');
    expect(integratedOf(done.reports.get('a'))).toBe(-11);
    expect([...done.final]).toEqual(['a']);
    expect(fake.received.filter((r) => r.type === 'probeListen')).toHaveLength(1);
  });

  it('rejects when the bridge refuses the start', async () => {
    const { fake, bridge } = await setUp();
    fake.handle('probeListen', (_request, { reply }) => {
      reply({ type: 'error', message: 'no probe with key zz' });
    });

    let started = false;
    await expect(
      runPass(bridge, ['zz'], { stop: new Promise(() => {}), onStart: () => (started = true) }),
    ).rejects.toThrow('no probe with key zz');
    expect(started).toBe(false);
  });

  it('rejects rather than waiting forever when the bridge goes away mid-pass', async () => {
    const { fake, bridge } = await setUp();
    fake.handle('probeListen', (request, { reply }) => {
      if (request.on) reply({ type: 'probeListening', pass: 3, probes: request.keys });
    });

    const pending = runPass(bridge, ['a'], {
      stop: new Promise(() => {}),
      onStart: () => void fake.close(),
    });
    await expect(pending).rejects.toThrow('the bridge went away');
  });
});

describe('stopAfter', () => {
  it('resolves after the delay, or at once when aborted', async () => {
    const before = Date.now();
    await stopAfter(20);
    expect(Date.now() - before).toBeGreaterThanOrEqual(15);

    const controller = new AbortController();
    const pending = stopAfter(60_000, controller.signal);
    controller.abort();
    await pending;
  });
});
