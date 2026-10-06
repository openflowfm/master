// applyPlan against the fake bridge on an ephemeral 127.0.0.1 port, with a
// small stand-in for Live's devices: each control has a fake display curve the
// fake answers `paramText` from, and `setDevice` writes land on it.

import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan } from '../src/apply.ts';
import { connectBridge, type Bridge } from '../src/bridge.ts';
import type { ChainDevice, DeviceParameterState, Request } from '../src/protocol.ts';
import type { Plan } from '../src/types.ts';
import { startFakeBridge, type FakeBridge } from './fakeBridge.ts';

const T = 2;

// --- a fake Live -------------------------------------------------------------

interface FakeParam {
  name: string;
  quantized: boolean;
  items?: string[];
  min: number;
  max: number;
  value: number;
  text: (raw: number) => string;
}

interface FakeDevice {
  name: string;
  className: string;
  params: FakeParam[];
}

const linear = (lo: number, hi: number, format: (x: number) => string) => (raw: number) => format(lo + (hi - lo) * raw);
const hzText = (hz: number) => (hz < 1000 ? `${hz.toFixed(0)} Hz` : `${(hz / 1000).toFixed(2)} kHz`);
const dbText = (db: number) => `${db.toFixed(1)} dB`;

const cont = (name: string, text: (raw: number) => string): FakeParam => ({ name, quantized: false, min: 0, max: 1, value: 0.5, text });
const choice = (name: string, items: string[], value = 0): FakeParam => ({
  name,
  quantized: true,
  items,
  min: 0,
  max: items.length - 1,
  value,
  text: (raw) => items[Math.round(raw)] ?? '',
});
const toggle = (name: string, value = 0) => choice(name, ['Off', 'On'], value);

const EQ_TYPES = ['Low Cut 48', 'Low Cut 12', 'Low Shelf', 'Bell', 'Notch', 'High Shelf', 'High Cut 12', 'High Cut 48'];

/** EQ Eight from an older Live: band 1's switch is "1 Filter On", without the "A". */
const eqEight = (): FakeDevice => ({
  name: 'EQ Eight',
  className: 'Eq8',
  params: [
    toggle('Device On', 1),
    ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
      toggle(n === 1 ? '1 Filter On' : `${n} Filter On A`, 1),
      choice(`${n} Filter Type A`, EQ_TYPES, 3),
      cont(`${n} Frequency A`, linear(20, 20000, hzText)),
      cont(`${n} Gain A`, linear(-15, 15, dbText)),
    ]),
  ],
});

const limiter = (): FakeDevice => ({
  name: 'Limiter',
  className: 'Limiter',
  params: [
    toggle('Device On', 1),
    cont('Gain', linear(-12, 24, dbText)),
    cont('Ceiling', linear(-24, 0, dbText)),
    choice('Mode', ['Standard', 'Soft Clip', 'True Peak']),
  ],
});

const probe = (): FakeDevice => ({ name: 'open[flow] Probe', className: 'MxDeviceAudioEffect', params: [toggle('Device On', 1)] });

const CATALOGUE: Record<string, () => FakeDevice> = { 'EQ Eight': eqEight, Limiter: limiter };

function parameterState(param: FakeParam): DeviceParameterState {
  return {
    name: param.name,
    value: param.value,
    min: param.min,
    max: param.max,
    ...(param.quantized ? { items: param.items } : { defaultValue: 0.5 }),
    quantized: param.quantized,
    display: param.text(param.value),
    state: 0,
  };
}

/** Scripts the fake as track `T` holding `run`: watch, insert, paramText and setDevice. */
function serveTrack(fake: FakeBridge, run: FakeDevice[]) {
  let open: number[] = [];
  const shell = (device: FakeDevice, i: number): ChainDevice => ({
    name: device.name,
    className: device.className,
    on: true,
    folded: !open.includes(i),
    ...(open.includes(i) ? { parameters: device.params.map(parameterState) } : {}),
  });
  fake.handle('watchChains', (request, { broadcast }) => {
    const sub = request.subs.find((s) => s.t === T && s.path.length === 0);
    open = sub?.open ?? [];
    broadcast({ type: 'chainState', state: { chains: sub ? [{ t: T, path: [], devices: run.map(shell) }] : [] } });
  });
  fake.handle('insertDevice', (request, { reply }) => {
    const make = CATALOGUE[request.name];
    if (!make) return reply({ type: 'error', message: `no device called ${request.name}` });
    const at = request.at ?? run.length;
    const device = make();
    run.splice(at, 0, device);
    reply({ type: 'deviceInserted', target: { t: T, path: [], i: at }, className: device.className });
  });
  fake.handle('paramText', (request, { reply }) => {
    const param = run[request.target.i]!.params[request.p]!;
    expect(request.values.length).toBeLessThanOrEqual(64);
    for (const v of request.values) expect(v >= param.min && v <= param.max).toBe(true);
    reply({ type: 'paramText', target: request.target, p: request.p, texts: request.values.map(param.text) });
  });
  fake.handle('setDevice', (request) => {
    const write = request.patch.param;
    if (write) run[request.target.i]!.params[write.p]!.value = write.value;
  });
  return { run };
}

// --- tests -------------------------------------------------------------------

let fake: FakeBridge | undefined;
let bridge: Bridge | undefined;

afterEach(async () => {
  await bridge?.close();
  await fake?.close();
  bridge = undefined;
  fake = undefined;
});

/** Resolves once the fake has received everything sent before it. */
async function flush(fake: FakeBridge, bridge: Bridge) {
  bridge.send({ type: 'ping' });
  await fake.nextRequest('ping');
}

const strip = <R extends Request>({ id: _id, ...rest }: R) => rest;

const plan: Plan = {
  material: 'speech',
  targetLufs: -16,
  truePeakDb: -1,
  maxGainDb: 12,
  heldLufs: null,
  notes: [],
  steps: [
    {
      device: 'EQ Eight',
      why: 'test',
      settings: [
        // First candidate absent, second present (older Live naming).
        { kind: 'switch', controls: ['1 Filter On A', '1 Filter On'], on: true },
        { kind: 'item', controls: ['1 Filter Type A'], items: ['Low cut 48', '48'] },
        { kind: 'number', controls: ['1 Frequency A'], value: 70, unit: 'Hz' },
        { kind: 'item', controls: ['2 Filter Type A'], items: ['Bell'] },
        { kind: 'number', controls: ['2 Frequency A'], value: 2500, unit: 'Hz' },
        { kind: 'number', controls: ['2 Gain A'], value: -3.2, unit: 'dB' },
        { kind: 'switch', controls: ['8 Filter On A'], on: false },
        { kind: 'number', controls: ['9 Frequency A', '9 Frequency'], value: 100, unit: 'Hz' },
        { kind: 'item', controls: ['3 Filter Type A'], items: ['Tilt'] },
      ],
    },
    {
      device: 'Limiter',
      why: 'test',
      settings: [
        { kind: 'number', controls: ['Ceiling'], value: -1, unit: 'dB' },
        { kind: 'item', controls: ['Mode'], items: ['True Peak'] },
        // Matched case-insensitively.
        { kind: 'number', controls: ['gain'], value: 8, unit: 'dB' },
      ],
    },
  ],
};

describe('applyPlan', () => {
  it('inserts the steps in order before the post probe, then writes each control in real units', async () => {
    fake = await startFakeBridge();
    const live = serveTrack(fake, [probe(), probe()]);
    bridge = await connectBridge({ port: fake.port });

    const applied = await applyPlan(bridge, T, plan, 1);
    await flush(fake, bridge);

    const inserts = fake.received.filter((r) => r.type === 'insertDevice').map(strip);
    expect(inserts).toEqual([
      { type: 'insertDevice', run: { t: T, path: [] }, name: 'EQ Eight', at: 1 },
      { type: 'insertDevice', run: { t: T, path: [] }, name: 'Limiter', at: 2 },
    ]);
    expect(live.run.map((d) => d.name)).toEqual(['open[flow] Probe', 'EQ Eight', 'Limiter', 'open[flow] Probe']);

    const watches = fake.received.filter((r) => r.type === 'watchChains');
    expect(watches.map(strip)).toEqual([{ type: 'watchChains', subs: [{ t: T, path: [], open: [1, 2] }] }]);

    // Each write, as Live would now read it.
    const eq = live.run[1]!;
    const lim = live.run[2]!;
    const writes = fake.received.flatMap((r) => {
      if (r.type !== 'setDevice' || !r.patch.param) return [];
      const device = live.run[r.target.i]!;
      const param = device.params[r.patch.param.p]!;
      return [{ device: device.name, control: param.name, raw: r.patch.param.value, reads: param.text(r.patch.param.value) }];
    });
    const p = (device: FakeDevice, name: string) => device.params.findIndex((param) => param.name === name);
    expect(writes).toEqual([
      { device: 'EQ Eight', control: '1 Filter On', raw: 1, reads: 'On' },
      { device: 'EQ Eight', control: '1 Filter Type A', raw: 0, reads: 'Low Cut 48' },
      { device: 'EQ Eight', control: '1 Frequency A', raw: expect.any(Number), reads: '70 Hz' },
      { device: 'EQ Eight', control: '2 Filter Type A', raw: 3, reads: 'Bell' },
      { device: 'EQ Eight', control: '2 Frequency A', raw: expect.any(Number), reads: '2.50 kHz' },
      { device: 'EQ Eight', control: '2 Gain A', raw: expect.any(Number), reads: '-3.2 dB' },
      { device: 'EQ Eight', control: '8 Filter On A', raw: 0, reads: 'Off' },
      { device: 'Limiter', control: 'Ceiling', raw: expect.any(Number), reads: '-1.0 dB' },
      { device: 'Limiter', control: 'Mode', raw: 2, reads: 'True Peak' },
      { device: 'Limiter', control: 'Gain', raw: expect.any(Number), reads: '8.0 dB' },
    ]);
    // Every write targets the device where it was inserted.
    const targets = fake.received.flatMap((r) => (r.type === 'setDevice' ? [r.target] : []));
    expect(targets.slice(0, 7).every((t) => t.t === T && t.path.length === 0 && t.i === 1)).toBe(true);
    expect(targets.slice(7).every((t) => t.t === T && t.path.length === 0 && t.i === 2)).toBe(true);

    // Only continuous controls are searched, each through its own index.
    const searched = new Set(
      fake.received.flatMap((r) => (r.type === 'paramText' ? [`${r.target.i}/${r.p}`] : [])),
    );
    expect(searched).toEqual(
      new Set([
        `1/${p(eq, '1 Frequency A')}`,
        `1/${p(eq, '2 Frequency A')}`,
        `1/${p(eq, '2 Gain A')}`,
        `2/${p(lim, 'Ceiling')}`,
        `2/${p(lim, 'Gain')}`,
      ]),
    );

    expect(applied.map(({ device, target, className, missing }) => ({ device, target, className, missing }))).toEqual([
      {
        device: 'EQ Eight',
        target: { t: T, path: [], i: 1 },
        className: 'Eq8',
        missing: ['9 Frequency A', '3 Filter Type A: Tilt'],
      },
      { device: 'Limiter', target: { t: T, path: [], i: 2 }, className: 'Limiter', missing: [] },
    ]);
    expect(applied[0]!.written.map((w) => [w.control, w.wanted, w.display, w.clamped])).toEqual([
      ['1 Filter On', 'on', 'on', false],
      ['1 Filter Type A', 'Low cut 48', 'Low Cut 48', false],
      ['1 Frequency A', '70 Hz', '70 Hz', false],
      ['2 Filter Type A', 'Bell', 'Bell', false],
      ['2 Frequency A', '2500 Hz', '2.50 kHz', false],
      ['2 Gain A', '-3.2 dB', '-3.2 dB', false],
      ['8 Filter On A', 'off', 'off', false],
    ]);
    expect(applied[1]!.written.map((w) => [w.control, w.display])).toEqual([
      ['Ceiling', '-1.0 dB'],
      ['Mode', 'True Peak'],
      ['Gain', '8.0 dB'],
    ]);
  });

  it('clamps a target the control cannot reach to the nearest end', async () => {
    fake = await startFakeBridge();
    const live = serveTrack(fake, [probe(), probe()]);
    bridge = await connectBridge({ port: fake.port });

    const loud: Plan = {
      ...plan,
      steps: [{ device: 'Limiter', why: 'test', settings: [{ kind: 'number', controls: ['Gain'], value: 40, unit: 'dB' }] }],
    };
    const [step] = await applyPlan(bridge, T, loud, 1);
    await flush(fake, bridge);
    expect(step!.written).toEqual([{ control: 'Gain', wanted: '40 dB', display: '24.0 dB', raw: 1, clamped: true }]);
    expect(live.run[1]!.params[1]!.value).toBe(1);
  });

  it('writes nothing and rejects when the run never shows the class Live said it inserted', async () => {
    fake = await startFakeBridge();
    const live = serveTrack(fake, [probe(), probe()]);
    // Live answers with a class the watched run doesn't hold at that index.
    fake.handle('insertDevice', (request, { reply }) => {
      live.run.splice(request.at!, 0, limiter());
      reply({ type: 'deviceInserted', target: { t: T, path: [], i: request.at! }, className: 'Eq8' });
    });
    bridge = await connectBridge({ port: fake.port });

    await expect(
      applyPlan(bridge, T, { ...plan, steps: [plan.steps[0]!] }, 1, undefined, 100),
    ).rejects.toThrow(/timed out reading the chain/);
    await flush(fake, bridge);
    expect(fake.received.some((r) => r.type === 'setDevice' || r.type === 'paramText')).toBe(false);
  });
});
