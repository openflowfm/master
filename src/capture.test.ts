import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendCapture, between, capturesFile, loadLastRun, saveLastRun, type LastRun } from './capture.ts';
import type { ChainDevice, ProbeEntry } from '@openflow/protocol';
import type { CaptureEntry } from './types.ts';

const devices = (n: number): ChainDevice[] =>
  Array.from({ length: n }, (_, i) => ({ name: `D${i}`, className: 'X', on: true, folded: true }));

const probe = (i: number): ProbeEntry => ({ key: `p${i}`, target: { t: 0, path: [], i }, name: 'Probe' });

describe('between', () => {
  it('gives the devices strictly between two probes', () => {
    expect(between(devices(6), [probe(1), probe(4)])).toEqual([2, 3]);
  });

  it('sorts probes by position', () => {
    expect(between(devices(6), [probe(4), probe(1)])).toEqual([2, 3]);
  });

  it('spans first to last probe and leaves out extra probes', () => {
    expect(between(devices(7), [probe(0), probe(3), probe(6)])).toEqual([1, 2, 4, 5]);
  });

  it('is empty when the probes are adjacent', () => {
    expect(between(devices(4), [probe(1), probe(2)])).toEqual([]);
  });

  it('falls back to every non-probe device with fewer than two probes', () => {
    expect(between(devices(4), [probe(2)])).toEqual([0, 1, 3]);
    expect(between(devices(3), [])).toEqual([0, 1, 2]);
  });
});

describe('state files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'master-capture-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (i: number, name: string, at: string): LastRun => ({ at, track: { i, name }, pre: null, plan: null });

  it('loads null when nothing was saved', async () => {
    expect(await loadLastRun(dir, 'Vox')).toBeNull();
    expect(await loadLastRun(join(dir, 'missing'), 'Vox')).toBeNull();
  });

  it('round-trips the last run per track name', async () => {
    const nested = join(dir, 'a', 'b');
    await saveLastRun(nested, run(0, 'Vox', 't1'));
    await saveLastRun(nested, run(1, 'Bass', 't2'));
    await saveLastRun(nested, run(3, 'Vox', 't3'));
    expect(await loadLastRun(nested, 'Vox')).toEqual(run(3, 'Vox', 't3'));
    expect(await loadLastRun(nested, 'Bass')).toEqual(run(1, 'Bass', 't2'));
    expect(await loadLastRun(nested, 'Drums')).toBeNull();
  });

  it('appends one JSON line per capture, creating the directory', async () => {
    const file = capturesFile(join(dir, 'new', 'deeper'));
    const entry = (at: string): CaptureEntry => ({
      at,
      track: { i: 0, name: 'Vox' },
      pre: null,
      plan: null,
      final: [{ name: 'Limiter', className: 'Limiter', on: true, controls: [{ name: 'Gain', value: 0.5, display: '3.0 dB' }] }],
    });
    await appendCapture(file, entry('t1'));
    await appendCapture(file, entry('t2'));
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.slice(0, -1).map((l) => JSON.parse(l))).toEqual([entry('t1'), entry('t2')]);
  });
});
