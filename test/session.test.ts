// run and capture end to end against the fake bridge on an ephemeral
// 127.0.0.1 port: a fake Live track with probes, devices whose controls have
// fake display curves, and probe passes scripted per pass and key. State goes
// to a temp dir.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectBridge, type Bridge } from '../src/bridge.ts';
import type { ChainDevice, DeviceParameterState, Event, ProbeEntry, ProbeReport, Request, Track } from '../src/protocol.ts';
import { capture, run, type SessionIO } from '../src/session.ts';
import type { CaptureEntry } from '../src/types.ts';
import { startFakeBridge, type FakeBridge } from './fakeBridge.ts';

const T = 4;
const PROBE_NAME = 'open[flow] Probe';

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
  /** Set on probes. */
  key?: string;
}

const linear = (lo: number, hi: number, format: (x: number) => string) => (raw: number) => format(lo + (hi - lo) * raw);
const hzText = (hz: number) => (hz < 1000 ? `${hz.toFixed(0)} Hz` : `${(hz / 1000).toFixed(2)} kHz`);
const dbText = (db: number) => `${db.toFixed(1)} dB`;

const cont = (name: string, text: (raw: number) => string, value = 0.5): FakeParam => ({
  name,
  quantized: false,
  min: 0,
  max: 1,
  value,
  text,
});
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

const CATALOGUE: Record<string, () => FakeDevice> = {
  'EQ Eight': () => ({
    name: 'EQ Eight',
    className: 'Eq8',
    params: [
      toggle('Device On', 1),
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
        toggle(`${n} Filter On A`, 1),
        choice(`${n} Filter Type A`, EQ_TYPES, 3),
        cont(`${n} Frequency A`, linear(20, 20000, hzText)),
        cont(`${n} Gain A`, linear(-15, 15, dbText)),
      ]),
    ],
  }),
  Limiter: () => ({
    name: 'Limiter',
    className: 'Limiter',
    params: [
      toggle('Device On', 1),
      cont('Gain', linear(-12, 24, dbText), 1 / 3),
      cont('Ceiling', linear(-24, 0, dbText), 1),
      choice('Mode', ['Standard', 'Soft Clip', 'True Peak']),
    ],
  }),
  Utility: () => ({ name: 'Utility', className: 'StereoGain', params: [toggle('Device On', 1), cont('Gain', linear(-35, 35, dbText))] }),
};

const probe = (key: string): FakeDevice => ({ name: PROBE_NAME, className: 'MxDeviceAudioEffect', params: [toggle('Device On', 1)], key });

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

const TRACKS = [
  { i: 0, name: 'Music bed' },
  { i: T, name: 'Lead vocal' },
] as unknown as Track[];

/**
 * A fake bridge serving one track `T` holding `names` ("pre"/"post" are
 * probes), and probe passes whose reports come from `passes[n - 1][key]`.
 */
async function serve(names: string[], passes: Array<Record<string, ProbeReport>>) {
  const run: FakeDevice[] = names.map((name) => (name === 'pre' || name === 'post' ? probe(name) : CATALOGUE[name]!()));
  const probes = (): ProbeEntry[] =>
    run.flatMap((d, i) => (d.key ? [{ key: d.key, target: { t: T, path: [], i }, name: PROBE_NAME }] : []));
  const fake = await startFakeBridge({ probes: probes() });

  fake.handle('snapshot', (_request, { reply }) => {
    reply({ type: 'snapshot', dictMs: 0, hostMs: 0, data: { tracks: TRACKS }, model: {}, cached: true } as unknown as Event);
  });

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
  fake.handle('insertDevice', (request, { reply, broadcast }) => {
    const device = CATALOGUE[request.name]!();
    const at = request.at ?? run.length;
    run.splice(at, 0, device);
    reply({ type: 'deviceInserted', target: { t: T, path: [], i: at }, className: device.className });
    broadcast({ type: 'probes', probes: probes() });
  });
  fake.handle('paramText', (request, { reply }) => {
    const param = run[request.target.i]!.params[request.p]!;
    reply({ type: 'paramText', target: request.target, p: request.p, texts: request.values.map(param.text) });
  });
  fake.handle('setDevice', (request) => {
    const write = request.patch.param;
    if (write) run[request.target.i]!.params[write.p]!.value = write.value;
  });

  let pass = 0;
  let keys: string[] = [];
  const reportEvents = (final: boolean): Event[] =>
    keys.map((key) => ({
      type: 'probeReport',
      pass,
      key,
      target: probes().find((p) => p.key === key)!.target,
      final,
      report: passes[pass - 1]![key]!,
    }));
  fake.handle('probeListen', (request, { reply, broadcast }) => {
    if (request.on) {
      pass++;
      keys = request.keys;
      reply({ type: 'probeListening', pass, probes: keys });
      broadcast({ type: 'probePass', pass, on: true, keys });
      for (const event of reportEvents(false)) broadcast(event);
    } else if (request.pass === pass) {
      for (const event of reportEvents(true)) broadcast(event);
      broadcast({ type: 'probePass', pass, on: false, keys });
    }
  });

  return { fake, run };
}

// --- reports -----------------------------------------------------------------

const ISO = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/**
 * A speech recording: silence below 100 Hz (so the plan high-passes), a plain
 * -3 dB/octave tilt above it (no EQ bumps, little sibilance), a narrow
 * loudness range (no multiband), and `lufs` integrated.
 */
function report(lufs: number | null, truePeakDb = -6): ProbeReport {
  return {
    seconds: 60,
    sampleRate: 48000,
    lufsIntegrated: lufs,
    lufsShortTermMax: lufs === null ? null : lufs + 5,
    loudnessRange: 4,
    truePeakDb,
    samplePeakDb: truePeakDb - 0.4,
    rmsDb: (lufs ?? -40) - 2,
    overSamples: 0,
    dcOffset: 0,
    correlation: 0.98,
    bands: ISO.map((hz) => {
      if (hz < 100) return { hz, meanDb: -150, floorDb: -150, peakDb: -150 };
      const mean = Math.round((-30 - 3 * Math.log2(hz / 1000)) * 10) / 10;
      return { hz, meanDb: mean, floorDb: mean - 20, peakDb: mean + 10 };
    }),
  };
}

const PRE = report(-24);
/** What the post probe hears on the first pass; planning from it would give a different Limiter gain. */
const DECOY = report(-10);

// --- harness -----------------------------------------------------------------

let fake: FakeBridge | undefined;
let bridge: Bridge | undefined;
let stateDir: string | undefined;

afterEach(async () => {
  await bridge?.close();
  await fake?.close();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
  bridge = undefined;
  fake = undefined;
  stateDir = undefined;
});

async function setUp(names: string[], passes: Array<Record<string, ProbeReport>>) {
  const served = await serve(names, passes);
  fake = served.fake;
  bridge = await connectBridge({ url: fake.url });
  stateDir = await mkdtemp(join(tmpdir(), 'master-session-test-'));
  const lines: string[] = [];
  const io: SessionIO = { log: (line) => lines.push(line), waitForDone: () => Promise.resolve() };
  return { ...served, bridge, stateDir, io, lines };
}

/** Resolves once the fake has received everything sent before it. */
async function flush(fake: FakeBridge, bridge: Bridge) {
  bridge.send({ type: 'ping' });
  await fake.nextRequest('ping');
}

const ofType = <K extends Request['type']>(requests: Request[], type: K) =>
  requests.filter((r): r is Extract<Request, { type: K }> => r.type === type);

/** Requests sent after the start of the `n`th probe pass (1-based). */
function afterPass(requests: Request[], n: number): Request[] {
  let seen = 0;
  const index = requests.findIndex((r) => r.type === 'probeListen' && r.on && ++seen === n);
  return index < 0 ? [] : requests.slice(index + 1);
}

// --- tests -------------------------------------------------------------------

describe('run', () => {
  it('plans from the pre probe, inserts between the probes, and corrects a loudness miss once on the Limiter', async () => {
    const { fake, bridge, stateDir, io, lines, run: live } = await setUp(['pre', 'Utility', 'post'], [
      { pre: PRE, post: DECOY },
      { post: report(-20, -1.5) },
    ]);

    const result = await run(bridge, { name: 'vocal', material: 'speech', stateDir }, io);
    await flush(fake, bridge);

    expect(result.track.name).toBe('Lead vocal');
    expect(result.pre).toEqual(PRE);
    expect(result.plan!.steps.map((s) => s.device)).toEqual(['EQ Eight', 'Limiter']);
    // From PRE (-24 LUFS → -16), not from the post probe's -10.
    const gain = result.plan!.steps[1]!.settings.find((s) => s.controls[0] === 'Gain');
    expect(gain).toMatchObject({ value: 8 });

    const listens = ofType(fake.received, 'probeListen').filter((r) => r.on);
    expect(listens.map((r) => r.on && r.keys)).toEqual([['pre', 'post'], ['post']]);

    const inserts = ofType(fake.received, 'insertDevice').map(({ id: _id, ...rest }) => rest);
    expect(inserts).toEqual([
      { type: 'insertDevice', run: { t: T, path: [] }, name: 'EQ Eight', at: 2 },
      { type: 'insertDevice', run: { t: T, path: [] }, name: 'Limiter', at: 3 },
    ]);
    expect(live.map((d) => d.key ?? d.name)).toEqual(['pre', 'Utility', 'EQ Eight', 'Limiter', 'post']);
    // Every insert and write came between the two passes.
    expect(ofType(afterPass(fake.received, 1), 'insertDevice')).toHaveLength(2);
    expect(ofType(afterPass(fake.received, 2), 'insertDevice')).toHaveLength(0);

    // The check heard -20 LUFS: 4 LU under, so the Limiter's Gain goes 8 → 12 dB, and nothing else moves.
    const limiter = live[3]!;
    const gainP = limiter.params.findIndex((p) => p.name === 'Gain');
    const corrections = ofType(afterPass(fake.received, 2), 'setDevice');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.target).toEqual({ t: T, path: [], i: 3 });
    expect(corrections[0]!.patch.param!.p).toBe(gainP);
    expect(limiter.params[gainP]!.text(corrections[0]!.patch.param!.value)).toBe('12.0 dB');
    expect(result.assessment!.corrections).toEqual([{ kind: 'number', controls: ['Gain'], value: 12, unit: 'dB' }]);
    expect(lines).toContain('Corrected once. Listen, tweak by ear, then run `capture` to keep the result.');

    // The view is released at the end.
    expect(ofType(fake.received, 'watchChains').at(-1)!.subs).toEqual([]);
  });

  it('makes no correction when the check is on target', async () => {
    const { fake, bridge, stateDir, io, lines } = await setUp(['pre', 'Utility', 'post'], [
      { pre: PRE, post: DECOY },
      { post: report(-16.3, -1.2) },
    ]);

    const result = await run(bridge, { name: 'Lead vocal', material: 'speech', stateDir }, io);
    await flush(fake, bridge);

    expect(result.applied.map((s) => s.device)).toEqual(['EQ Eight', 'Limiter']);
    expect(result.assessment!.ok).toBe(true);
    expect(ofType(fake.received, 'setDevice').length).toBeGreaterThan(0);
    expect(ofType(afterPass(fake.received, 2), 'setDevice')).toEqual([]);
    expect(lines).toContain('On target. Tweak by ear if you like, then run `capture` to keep the result.');
  });

  it('returns instructions and sends no insert or listen when the probes are missing', async () => {
    const { fake, bridge, stateDir, io, lines } = await setUp(['Utility'], []);

    const result = await run(bridge, { index: T, material: 'speech', stateDir }, io);
    await flush(fake, bridge);

    expect(result.instructions).toEqual([
      `Drop an ${PROBE_NAME} at the start of the chain on track "Lead vocal", before "Utility".`,
      `Drop another ${PROBE_NAME} at the end of the chain on track "Lead vocal", after "Utility".`,
    ]);
    expect(lines).toEqual(expect.arrayContaining(result.instructions!));
    expect(result.plan).toBeNull();
    expect(ofType(fake.received, 'insertDevice')).toEqual([]);
    expect(ofType(fake.received, 'probeListen')).toEqual([]);
    expect(ofType(fake.received, 'watchChains').at(-1)!.subs).toEqual([]);
  });

  it('plans but inserts and sets nothing on a dry run', async () => {
    const { fake, bridge, stateDir, io } = await setUp(['pre', 'post'], [{ pre: PRE, post: DECOY }]);

    const result = await run(bridge, { name: 'vocal', material: 'speech', stateDir, dryRun: true }, io);
    await flush(fake, bridge);

    expect(result.plan!.steps.map((s) => s.device)).toEqual(['EQ Eight', 'Limiter']);
    expect(result.applied).toEqual([]);
    expect(result.assessment).toBeNull();
    expect(ofType(fake.received, 'probeListen').filter((r) => r.on)).toHaveLength(1);
    for (const type of ['insertDevice', 'setDevice', 'paramText'] as const) {
      expect(ofType(fake.received, type)).toEqual([]);
    }
  });
});

describe('capture', () => {
  it('appends the last run and the controls between the probes to captures.jsonl', async () => {
    const { fake, bridge, stateDir, io, run: live } = await setUp(['pre', 'Utility', 'EQ Eight', 'post'], [
      { pre: PRE, post: DECOY },
    ]);

    const planned = await run(bridge, { name: 'vocal', material: 'speech', stateDir, dryRun: true }, io);
    // The user tweaks by ear.
    live[1]!.params[1]!.value = 0.6;

    const entry = await capture(bridge, { name: 'vocal', stateDir }, io);
    await flush(fake, bridge);

    const text = await readFile(join(stateDir, 'captures.jsonl'), 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const saved = JSON.parse(lines[0]!) as CaptureEntry;
    expect(saved).toEqual(entry);
    expect(saved.track).toEqual({ i: T, name: 'Lead vocal' });
    expect(saved.pre).toEqual(PRE);
    expect(saved.plan).toEqual(planned.plan);

    const controls = (device: FakeDevice) =>
      device.params.map((p) => ({ name: p.name, value: p.value, display: p.text(p.value) }));
    expect(saved.final).toEqual([
      { name: 'Utility', className: 'StereoGain', on: true, controls: controls(live[1]!) },
      { name: 'EQ Eight', className: 'Eq8', on: true, controls: controls(live[2]!) },
    ]);
    expect(saved.final[0]!.controls[1]).toEqual({ name: 'Gain', value: 0.6, display: '7.0 dB' });

    // Only the devices between the probes were opened.
    const opens = ofType(fake.received, 'watchChains').map((r) => r.subs[0]?.open);
    expect(opens).toContainEqual([1, 2]);
    expect(opens.flat().filter((i) => i === 0 || i === 3)).toEqual([]);
  });
});
