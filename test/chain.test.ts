// readRun and ensureProbes against the fake bridge on an ephemeral 127.0.0.1 port.

import { afterEach, describe, expect, it } from 'vitest';
import { connectBridge, type Bridge } from '../src/bridge.ts';
import { ensureProbes, PROBE_DEVICE_NAME, readRun } from '../src/chain.ts';
import type { ChainDevice, Event, ProbeEntry, WatchedChain } from '../src/protocol.ts';
import { startFakeBridge, type FakeBridge } from './fakeBridge.ts';

const PROBE_CLASS = 'MxDeviceAudioEffect';
const T = 3;

let fake: FakeBridge | undefined;
let bridge: Bridge | undefined;

afterEach(async () => {
  await bridge?.close();
  await fake?.close();
  bridge = undefined;
  fake = undefined;
});

const device = (name: string, extra: Partial<ChainDevice> = {}): ChainDevice => ({
  name,
  className: name.replace(/\s/g, ''),
  on: true,
  folded: true,
  ...extra,
});

/** A track run where entries with a `key` are probes; moves edit it like Live would. */
function liveRun(names: string[]) {
  const run = names.map((name) =>
    name.startsWith('P')
      ? { key: name.toLowerCase(), device: { ...device(PROBE_DEVICE_NAME), className: PROBE_CLASS } }
      : { key: null, device: device(name) },
  );
  const probes = (): ProbeEntry[] =>
    run.flatMap((entry, i) => (entry.key ? [{ key: entry.key, target: { t: T, path: [], i }, name: PROBE_DEVICE_NAME }] : []));
  const chain = (): WatchedChain => ({ t: T, path: [], devices: run.map((entry) => entry.device) });
  const names_ = () => run.map((entry) => entry.key?.toUpperCase() ?? entry.device.name);
  return { run, probes, chain, names: names_ };
}

async function setup(names: string[]) {
  const live = liveRun(names);
  fake = await startFakeBridge({ probes: live.probes() });
  fake.handle('watchChains', (_request, { broadcast }) => {
    broadcast({ type: 'chainState', state: { chains: [live.chain()] } });
  });
  fake.handle('moveDevice', (request, { reply, broadcast }) => {
    const [entry] = live.run.splice(request.target.i, 1);
    expect(entry!.device.className).toBe(request.className);
    live.run.splice(request.at, 0, entry!);
    reply({ type: 'deviceMoved', target: { t: T, path: [], i: request.at } });
    broadcast({ type: 'probes', probes: live.probes() });
  });
  bridge = await connectBridge({ port: fake.port });
  return { live, fake, bridge };
}

describe('readRun', () => {
  it('picks the track run out of the union and waits for the open parameters', async () => {
    fake = await startFakeBridge();
    bridge = await connectBridge({ port: fake.port });
    const reading = readRun(bridge, T, [1]);
    const request = await fake.nextRequest('watchChains');
    expect(request.subs).toEqual([{ t: T, path: [], open: [1] }]);

    const parameters = [
      { name: 'Gain', value: 0, min: -1, max: 1, defaultValue: 0, quantized: false, display: '0.0 dB', state: 0 },
    ] as unknown as ChainDevice['parameters'];
    const shells = [device('EQ Eight'), device('Limiter')];
    const others: WatchedChain[] = [
      { t: T, path: [0, 0], devices: [device('Utility')] },
      { t: 1, path: [], devices: [device('Compressor')] },
    ];
    // First the union without our parameters, then with them.
    fake.broadcast({ type: 'chainState', state: { chains: [...others, { t: T, path: [], devices: shells }] } });
    const ready = [shells[0]!, { ...shells[1]!, parameters }];
    fake.broadcast({ type: 'chainState', state: { chains: [...others, { t: T, path: [], devices: ready }] } });
    await expect(reading).resolves.toEqual(ready);
  });

  it('waits out a stale chainState that lacks the open device or has another class there', async () => {
    fake = await startFakeBridge();
    bridge = await connectBridge({ port: fake.port });
    const reading = readRun(bridge, T, [{ i: 2, className: 'Limiter' }]);
    const request = await fake.nextRequest('watchChains');
    expect(request.subs).toEqual([{ t: T, path: [], open: [2] }]);

    const parameters = [
      { name: 'Gain', value: 0, min: 0, max: 1, defaultValue: 0, quantized: false, display: '0.0 dB', state: 0 },
    ] as unknown as ChainDevice['parameters'];
    // Before the insert landed: index 2 is past the end of the run.
    const before = [device('Probe'), device('Probe')];
    fake.broadcast({ type: 'chainState', state: { chains: [{ t: T, path: [], devices: before }] } });
    // Index 2 exists and is open, but it's the post probe, not the Limiter.
    const wrong = [device('Probe'), device('EQ Eight'), { ...device('Probe'), parameters }];
    fake.broadcast({ type: 'chainState', state: { chains: [{ t: T, path: [], devices: wrong }] } });
    const ready = [device('Probe'), device('EQ Eight'), { ...device('Limiter'), parameters }, device('Probe')];
    fake.broadcast({ type: 'chainState', state: { chains: [{ t: T, path: [], devices: ready }] } });
    await expect(reading).resolves.toEqual(ready);
  });

  it('ignores states that lack the run, then rejects when it no longer resolves', async () => {
    fake = await startFakeBridge();
    bridge = await connectBridge({ port: fake.port });
    const reading = readRun(bridge, T, []);
    await fake.nextRequest('watchChains');
    fake.broadcast({ type: 'chainState', state: { chains: [{ t: 1, path: [], devices: [] }] } });
    fake.broadcast({ type: 'chainState', state: { chains: [{ t: T, path: [], devices: null }] } });
    await expect(reading).rejects.toThrow(/no longer resolves/);
  });

  it('times out when nothing arrives', async () => {
    fake = await startFakeBridge();
    bridge = await connectBridge({ port: fake.port });
    await expect(readRun(bridge, T, [], 50)).rejects.toThrow(/timed out/);
  });
});

describe('ensureProbes', () => {
  it('moves both probes to the ends and returns where they landed', async () => {
    const { live, fake, bridge } = await setup(['EQ Eight', 'P1', 'Compressor', 'P2', 'Limiter']);
    const result = await ensureProbes(bridge, { i: T, name: 'Vox' });

    const moves = fake.received.filter((request) => request.type === 'moveDevice');
    expect(moves.map(({ id: _id, ...rest }) => rest)).toEqual([
      { type: 'moveDevice', target: { t: T, path: [], i: 1 }, className: PROBE_CLASS, to: { t: T, path: [] }, at: 0 },
      { type: 'moveDevice', target: { t: T, path: [], i: 3 }, className: PROBE_CLASS, to: { t: T, path: [] }, at: 4 },
    ]);
    expect(live.names()).toEqual(['P1', 'EQ Eight', 'Compressor', 'Limiter', 'P2']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pre).toEqual({ key: 'p1', target: { t: T, path: [], i: 0 }, name: PROBE_DEVICE_NAME });
    expect(result.post).toEqual({ key: 'p2', target: { t: T, path: [], i: 4 }, name: PROBE_DEVICE_NAME });
    expect(result.devices.map((d) => d.name)).toEqual([PROBE_DEVICE_NAME, 'EQ Eight', 'Compressor', 'Limiter', PROBE_DEVICE_NAME]);
  });

  it('ignores probes on other tracks and inside racks', async () => {
    const { fake, bridge } = await setup(['P1', 'EQ Eight', 'P2']);
    const elsewhere: ProbeEntry[] = [
      { key: 'x', target: { t: 1, path: [], i: 0 }, name: PROBE_DEVICE_NAME },
      { key: 'y', target: { t: T, path: [1, 0], i: 0 }, name: PROBE_DEVICE_NAME },
    ];
    const own = (await bridge.probes()).slice();
    fake.broadcast({ type: 'probes', probes: [...elsewhere, ...own] } satisfies Event);
    await bridge.waitFor('probes');
    const result = await ensureProbes(bridge, { i: T, name: 'Vox' });
    expect(fake.received.some((request) => request.type === 'moveDevice')).toBe(false);
    expect(result.ok && [result.pre.key, result.post.key]).toEqual(['p1', 'p2']);
  });

  it('sends no move and returns instructions when there is no probe', async () => {
    const { fake, bridge } = await setup(['EQ Eight', 'Limiter']);
    const result = await ensureProbes(bridge, { i: T, name: 'Vox' });
    expect(fake.received.some((request) => request.type === 'moveDevice')).toBe(false);
    expect(result).toEqual({
      ok: false,
      instructions: [
        `Drop an ${PROBE_DEVICE_NAME} at the start of the chain on track "Vox", before "EQ Eight".`,
        `Drop another ${PROBE_DEVICE_NAME} at the end of the chain on track "Vox", after "Limiter".`,
      ],
    });
  });

  it('moves a lone probe in the middle to the start, then asks for one at the end', async () => {
    const { live, fake, bridge } = await setup(['EQ Eight', 'P1', 'Limiter']);
    const result = await ensureProbes(bridge, { i: T, name: 'Vox' });
    const moves = fake.received.filter((request) => request.type === 'moveDevice');
    expect(moves).toHaveLength(1);
    expect(live.names()).toEqual(['P1', 'EQ Eight', 'Limiter']);
    expect(result).toEqual({
      ok: false,
      instructions: [`Drop an ${PROBE_DEVICE_NAME} at the end of the chain on track "Vox", after "Limiter".`],
    });
  });
});
