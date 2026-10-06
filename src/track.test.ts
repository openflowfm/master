import { describe, expect, it } from 'vitest';
import type { Snapshot, Track } from './protocol.ts';
import { pickTrack } from './track.ts';

function track(i: number, name: string): Track {
  return { i, name, color: 0, colorIndex: 0, isMidi: false, isGroup: false, isGrouped: false, groupIndex: -1, isFolded: false };
}

function snapshot(...names: string[]): Snapshot {
  return { tracks: names.map((name, i) => track(i, name)) } as Snapshot;
}

const snap = snapshot('Vox', 'Vox Double', 'Guitar L', 'Guitar R', 'Bass');

describe('pickTrack', () => {
  it('picks by index', () => {
    expect(pickTrack(snap, { index: 4 })).toEqual(track(4, 'Bass'));
  });

  it('prefers index over name', () => {
    expect(pickTrack(snap, { index: 0, name: 'Bass' })).toEqual(track(0, 'Vox'));
  });

  it('errors on an unknown index, listing tracks', () => {
    const r = pickTrack(snap, { index: 9 });
    expect(typeof r).toBe('string');
    expect(r).toContain('index 9');
    expect(r).toContain('  4  Bass');
  });

  it('picks an exact name case-insensitively, even when it is also a partial match', () => {
    expect(pickTrack(snap, { name: 'vox' })).toEqual(track(0, 'Vox'));
  });

  it('picks a unique partial name', () => {
    expect(pickTrack(snap, { name: 'dOUB' })).toEqual(track(1, 'Vox Double'));
  });

  it('errors on an ambiguous exact name', () => {
    const r = pickTrack(snapshot('Vox', 'vox'), { name: 'VOX' });
    expect(typeof r).toBe('string');
    expect(r).toContain('2 tracks are called "VOX"');
    expect(r).toContain('  1  vox');
  });

  it('errors on an ambiguous partial name', () => {
    const r = pickTrack(snap, { name: 'guitar' });
    expect(typeof r).toBe('string');
    expect(r).toContain('matches 2 tracks');
    expect(r).toContain('  2  Guitar L');
  });

  it('errors on an unknown name, listing tracks', () => {
    const r = pickTrack(snap, { name: 'Drums' });
    expect(r).toContain('No track called "Drums"');
    expect(r).toContain('  0  Vox');
  });

  it('errors when nothing is given', () => {
    const r = pickTrack(snap, {});
    expect(typeof r).toBe('string');
    expect(r).toContain('--track');
    expect(r).toContain('  3  Guitar R');
  });
});
