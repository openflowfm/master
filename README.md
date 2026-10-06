# master[flow]

Pre-1.0: unstable and in active development.

Improves an iPhone recording inside Ableton Live. It talks to Live through the
SessionBridge WebSocket (`ws://127.0.0.1:17800/ws`,
[openflowfm/bridge](https://github.com/openflowfm/bridge)). It listens to the
track with two open[flow] Probes, plans a chain of Live's own devices from what
it heard, sets them in real units, checks the result and keeps what you settle
on so it can learn from it later. This first version is a CLI and a library;
there is no UI yet.

## What it does

1. **Connects** and sends `identify { client: 'mastering', name: 'master[flow]' }`.
   It then reads the snapshot and picks the track you name.
2. **Lays out the chain as a flow:** the pre probe first, the post probe last.
   Probes already on the track are moved there with `moveDevice`. Probes are Max
   for Live devices and can't be inserted, so if any are missing it says exactly
   what to drop where (for example, *Drop an open[flow] Probe at the end of the
   chain on track "Vox", after "EQ Eight".*) and exits with code 2.
3. **Listens.** It starts one pass on both probes (`probeListen`) and you play
   the recording through. The pass ends on a keypress or after `--seconds`. Only
   reports carrying its own pass number count. The pass is over when
   `probePass { on: false }` for that number arrives, whatever ended it.
4. **Plans** from the pre report ([`src/planner.ts`](src/planner.ts), pure and
   tested). Steps that aren't needed aren't added:
   - **EQ Eight:** a 48 dB/oct low cut at 0.7× where the content starts. It also
     corrects boxiness (200–500 Hz) and mic harshness (2–5 kHz) as deviations
     from a fitted spectral tilt, 60 % corrected, cuts to −6 dB and boosts to
     +3 dB at most. A band is touched only if it is content: at least 6 dB above
     its own noise floor, above −80 dBFS, and within 40 dB of the loudest band.
   - **Compressor as a de-esser**, only when 5–9 kHz energy is high (above
     −15 dB of the total for speech, −12 dB for music). Its sidechain EQ is a
     band-pass at the loudest sibilant band. Live has no dedicated de-esser.
   - **Multiband Dynamics**, only when the loudness range is wide (above 5 LU for
     speech, 8 LU for music). Thresholds come from the band levels and the ratio
     is LRA/6, clamped to 1.25–4.
   - **Limiter**, always: ceiling −1 dBTP, True Peak mode, make-up gain toward the
     target (−16 LUFS for speech, −14 for music, or `--target-lufs`).
5. **Applies.** It inserts the devices between the probes and opens them with
   `watchChains` to read control names and indexes. Each real unit ("350 Hz",
   "−3 dB") becomes a raw value by searching Live's own display text through
   `paramText`, which writes nothing. Curves are cached per device class and
   control. Each control is then written with `setDevice`, one control per
   message.
6. **Verifies** with a second pass on the post probe. It compares loudness and
   true peak with the targets and makes **one** corrective adjustment at most,
   to the Limiter's gain and ceiling.
7. **Learns.** After you've tweaked by ear, `capture` reads the final controls
   back and appends `{ pre report, plan, final settings }` to
   `~/.openflow/master/captures.jsonl`.

## Usage

```sh
npm ci
npm start -- run --track "Vox"                 # speech, −16 LUFS
npm start -- run --index 3 --material music    # −14 LUFS
npm start -- run --track "Vox" --seconds 90    # end each pass after 90 s
npm start -- run --track "Vox" --dry-run       # listen and plan, change nothing
npm start -- capture --track "Vox"             # after tweaking by ear
```

After `npm run build`, the same commands run as `node dist/cli.js …`, or as
`master-flow …` once linked.

| flag | |
|---|---|
| `--track <name>` | exact name, or part of exactly one track's name |
| `--index <n>` | Live's track index, `Track.i`; 0 is the first track |
| `--material speech\|music` | sets the default loudness target |
| `--target-lufs <x>` | loudness target |
| `--seconds <s>` | end each listening pass after `s` seconds instead of a keypress |
| `--dry-run` | plan only |
| `--host`, `--port` | the bridge; `127.0.0.1:17800` by default |
| `--state-dir <dir>` | last runs and captures; `$OPENFLOW_MASTER_DIR` or `~/.openflow/master` |
| `--log <file>` | the capture log |

## As a library

```ts
import { connectBridge, planChain, run } from '@openflow/master';
```

Everything the CLI does is in [`src/session.ts`](src/session.ts) behind a small
`SessionIO` (log lines, "the user is done"). The pieces are exported on their
own too: the planner, the display-text search, the pass lifecycle, the probe
layout, apply, verify and capture.

## Layout

```
src/bridge.ts       the socket: send, request/reply by id, events
src/protocol.ts     wire types from @openflow/protocol's global namespace, WS_PATH, DEFAULT_PORT
src/track.ts        pick the track
src/chain.ts        probe layout (pure) and the moves; readRun over watchChains
src/pass.ts         one listening pass, per the Probe contract
src/planner.ts      ProbeReport → ordered devices with settings in real units (pure)
src/display.ts      Live's display text → real units
src/paramSearch.ts  real units → raw value, by searching paramText; curve cache
src/apply.ts        insert, then write controls one per setDevice
src/verify.ts       post report vs targets; the one corrective round (pure)
src/capture.ts      read controls back; last run and the JSONL log
src/session.ts      the whole job
src/cli.ts          master-flow
test/fakeBridge.ts  a small ws server that speaks the contract, for tests
```
