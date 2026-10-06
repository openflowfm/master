// Pick the track to work on from a snapshot, by name or by index.

import type { Snapshot, Track } from './protocol.ts';

export interface TrackChoice {
  /** Exact name (case-insensitive), or a part of exactly one track's name. */
  name?: string;
  /** Live's track index, `Track.i` — 0 is the first track. */
  index?: number;
}

/** The chosen track, or an error message that lists what there is. */
export function pickTrack(snapshot: Snapshot, choice: TrackChoice): Track | string {
  const tracks = snapshot.tracks;
  const list = () => tracks.map((t) => `  ${t.i}  ${t.name}`).join('\n');

  if (choice.index !== undefined) {
    const track = tracks.find((t) => t.i === choice.index);
    return track ?? `No track at index ${choice.index}. Tracks:\n${list()}`;
  }
  if (choice.name !== undefined) {
    const wanted = choice.name.toLowerCase();
    const exact = tracks.filter((t) => t.name.toLowerCase() === wanted);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return `${exact.length} tracks are called "${choice.name}"; pick one with --index:\n${list()}`;
    const partial = tracks.filter((t) => t.name.toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) return `"${choice.name}" matches ${partial.length} tracks; be more exact or use --index:\n${list()}`;
    return `No track called "${choice.name}". Tracks:\n${list()}`;
  }
  return `Name a track with --track <name> or --index <n>. Tracks:\n${list()}`;
}
