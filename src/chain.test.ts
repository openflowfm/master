import { describe, expect, it } from 'vitest';
import { applyMoves, planProbeLayout, PROBE_DEVICE_NAME } from './chain.ts';
import type { ChainDevice, ProbeEntry } from '@openflow/protocol';

const PROBE_CLASS = 'MxDeviceAudioEffect';

/** A run from a compact spelling: `P1` is a probe keyed `p1`, anything else a device of that name. */
function run(...names: string[]) {
  const devices: ChainDevice[] = names.map((name) => ({
    name: name.startsWith('P') ? PROBE_DEVICE_NAME : name,
    className: name.startsWith('P') ? PROBE_CLASS : name.replace(/\s/g, ''),
    on: true,
    folded: true,
  }));
  const probes: ProbeEntry[] = names.flatMap((name, i) =>
    name.startsWith('P') ? [{ key: name.toLowerCase(), target: { t: 3, path: [], i }, name: PROBE_DEVICE_NAME }] : [],
  );
  return { devices, probes, names };
}

/** The run's names after the planned moves. */
function after(names: string[], layout: ReturnType<typeof planProbeLayout>) {
  return applyMoves(names, layout.moves);
}

describe('planProbeLayout with two or more probes', () => {
  it('needs no moves when pre is already first and post already last', () => {
    const { devices, probes, names } = run('P1', 'EQ Eight', 'Limiter', 'P2');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout).toEqual({ ok: true, pre: probes[0], post: probes[1], moves: [], extra: [] });
    expect(after(names, layout)).toEqual(names);
  });

  it('moves only post when pre is already first', () => {
    const { devices, probes, names } = run('P1', 'EQ Eight', 'P2', 'Limiter');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout.moves).toEqual([{ from: 2, className: PROBE_CLASS, at: 3 }]);
    expect(after(names, layout)).toEqual(['P1', 'EQ Eight', 'Limiter', 'P2']);
  });

  it('moves only pre when post is already last', () => {
    const { devices, probes, names } = run('EQ Eight', 'Limiter', 'P1', 'P2');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout.moves).toEqual([{ from: 2, className: PROBE_CLASS, at: 0 }]);
    expect(after(names, layout)).toEqual(['P1', 'EQ Eight', 'Limiter', 'P2']);
  });

  it('moves both when they sit next to each other in the middle', () => {
    const { devices, probes, names } = run('EQ Eight', 'P1', 'P2', 'Limiter');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout.moves).toEqual([
      { from: 1, className: PROBE_CLASS, at: 0 },
      { from: 2, className: PROBE_CLASS, at: 3 },
    ]);
    expect(after(names, layout)).toEqual(['P1', 'EQ Eight', 'Limiter', 'P2']);
  });

  it('keeps the devices between the probes in their order', () => {
    const { devices, probes, names } = run('Utility', 'P1', 'EQ Eight', 'Compressor', 'P2', 'Limiter');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout.moves).toEqual([
      { from: 1, className: PROBE_CLASS, at: 0 },
      { from: 4, className: PROBE_CLASS, at: 5 },
    ]);
    expect(after(names, layout)).toEqual(['P1', 'Utility', 'EQ Eight', 'Compressor', 'Limiter', 'P2']);
  });

  it('takes the earliest as pre and the latest as post whatever order they are listed in', () => {
    const { devices, probes, names } = run('EQ Eight', 'P1', 'Limiter', 'P2');
    const layout = planProbeLayout('Vox', devices, [probes[1]!, probes[0]!]);
    expect(layout.ok && [layout.pre.key, layout.post.key]).toEqual(['p1', 'p2']);
    expect(after(names, layout)).toEqual(['P1', 'EQ Eight', 'Limiter', 'P2']);
  });

  it('moves both when pre sits near the end and post near the start of the other devices', () => {
    // Pre is the earlier by position, so "swapped" ends are both off by the whole run.
    const { devices, probes, names } = run('Limiter', 'Compressor', 'P1', 'P2', 'EQ Eight');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout.moves).toEqual([
      { from: 2, className: PROBE_CLASS, at: 0 },
      { from: 3, className: PROBE_CLASS, at: 4 },
    ]);
    expect(after(names, layout)).toEqual(['P1', 'Limiter', 'Compressor', 'EQ Eight', 'P2']);
  });

  it('turns a run of only two probes into nothing to do', () => {
    const { devices, probes } = run('P1', 'P2');
    expect(planProbeLayout('Vox', devices, probes).moves).toEqual([]);
  });

  it('reports extra probes and leaves them where they are', () => {
    const { devices, probes, names } = run('EQ Eight', 'P1', 'P2', 'Compressor', 'P3', 'Limiter');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.pre.key).toBe('p1');
    expect(layout.post.key).toBe('p3');
    expect(layout.extra.map((probe) => probe.key)).toEqual(['p2']);
    expect(after(names, layout)).toEqual(['P1', 'EQ Eight', 'P2', 'Compressor', 'Limiter', 'P3']);
  });

  it('guards each move with the class of the device it moves', () => {
    const { devices, probes } = run('EQ Eight', 'P1', 'P2', 'Limiter');
    devices[2] = { ...devices[2]!, className: 'MxDeviceOther' };
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout.moves.map((move) => move.className)).toEqual([PROBE_CLASS, 'MxDeviceOther']);
  });

  it('refuses a probe whose position is outside the run', () => {
    const { devices, probes } = run('EQ Eight', 'P1');
    expect(() => planProbeLayout('Vox', devices.slice(0, 1), probes)).toThrow(/outside the run/);
  });
});

describe('planProbeLayout with one probe', () => {
  it('asks for one at the end when the probe is first', () => {
    const { devices, probes } = run('P1', 'EQ Eight');
    expect(planProbeLayout('Vox', devices, probes)).toEqual({
      ok: false,
      moves: [],
      instructions: [`Drop an ${PROBE_DEVICE_NAME} at the end of the chain on track "Vox", after "EQ Eight".`],
    });
  });

  it('asks for one at the start when the probe is last', () => {
    const { devices, probes } = run('EQ Eight', 'Limiter', 'P1');
    expect(planProbeLayout('Vox', devices, probes)).toEqual({
      ok: false,
      moves: [],
      instructions: [`Drop an ${PROBE_DEVICE_NAME} at the start of the chain on track "Vox", before "EQ Eight".`],
    });
  });

  it('moves a probe in the middle to the start, then asks for one at the end', () => {
    const { devices, probes, names } = run('EQ Eight', 'P1', 'Limiter');
    const layout = planProbeLayout('Vox', devices, probes);
    expect(layout).toEqual({
      ok: false,
      moves: [{ from: 1, className: PROBE_CLASS, at: 0 }],
      instructions: [`Drop an ${PROBE_DEVICE_NAME} at the end of the chain on track "Vox", after "Limiter".`],
    });
    expect(after(names, layout)).toEqual(['P1', 'EQ Eight', 'Limiter']);
  });

  it('asks for one after the probe when it is alone on the track', () => {
    const { devices, probes } = run('P1');
    expect(planProbeLayout('Vox', devices, probes)).toEqual({
      ok: false,
      moves: [],
      instructions: [`Drop an ${PROBE_DEVICE_NAME} at the end of the chain on track "Vox", after "${PROBE_DEVICE_NAME}".`],
    });
  });
});

describe('planProbeLayout with no probe', () => {
  it('asks for one at each end', () => {
    const { devices, probes } = run('EQ Eight', 'Limiter');
    expect(planProbeLayout('Vox', devices, probes)).toEqual({
      ok: false,
      moves: [],
      instructions: [
        `Drop an ${PROBE_DEVICE_NAME} at the start of the chain on track "Vox", before "EQ Eight".`,
        `Drop another ${PROBE_DEVICE_NAME} at the end of the chain on track "Vox", after "Limiter".`,
      ],
    });
  });

  it('names the one device for both ends', () => {
    const { devices } = run('Utility');
    const layout = planProbeLayout('Vox', devices, []);
    expect(!layout.ok && layout.instructions).toEqual([
      `Drop an ${PROBE_DEVICE_NAME} at the start of the chain on track "Vox", before "Utility".`,
      `Drop another ${PROBE_DEVICE_NAME} at the end of the chain on track "Vox", after "Utility".`,
    ]);
  });

  it('says when the chain is empty', () => {
    const layout = planProbeLayout('Vox', [], []);
    expect(layout.ok).toBe(false);
    expect(layout.moves).toEqual([]);
    expect(!layout.ok && layout.instructions).toEqual([
      `The chain on track "Vox" is empty. Drop an ${PROBE_DEVICE_NAME} on it, then drop a second one after the first, so one sits at the start and one at the end.`,
    ]);
  });
});

describe('applyMoves', () => {
  it('counts `at` with the moved item lifted out', () => {
    expect(applyMoves(['a', 'b', 'c'], [{ from: 0, className: 'x', at: 2 }])).toEqual(['b', 'c', 'a']);
    expect(applyMoves(['a', 'b', 'c'], [{ from: 2, className: 'x', at: 0 }])).toEqual(['c', 'a', 'b']);
  });
});
