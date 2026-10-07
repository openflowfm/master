# master[flow]

Read [`README.md`](README.md) first. It covers what each step does and the layout
of `src/`.

- **The wire protocol is `@openflow/protocol`'s `global.d.ts`**, and its README
  states the rules. Follow the Probe contract exactly. Drop reports from other
  passes. A pass is over only on `probePass { on: false }` for your own pass.
- **Tests never connect to a real bridge.** The owner's live set runs on port 17800.
  Tests use `test/fakeBridge.ts`, a `ws` server on `127.0.0.1` with an ephemeral
  port. Nothing here binds anything other than `127.0.0.1`.
- **Never write to a set to find something out.** Real units become raw values
  through `paramText`, which writes nothing. Only the answer goes out, one control
  per `setDevice`.
- The planner (`src/planner.ts`) and the verify step (`src/verify.ts`) are pure. If
  tuning changes behaviour, change their exported constants and tests along with it.
- Nothing loads from a CDN.
- Don't use names that already mean something in a DAW: scene, clip, send,
  return, bus, transport, quantize, measure, take, bounce, cue, slot. Where a DAW
  term *is* the Live concept, use it precisely.
- Imports use the real TypeScript extension (`./planner.ts`). The source runs
  directly on Node 26, so only erasable TypeScript is allowed: no enums and no
  parameter properties.
- A change to how a step works updates the README in the same commit.

## Checks

Run these from the repo root. Each exits 0 on success.

| command | what | when |
|---|---|---|
| `npm ci` | install | after a lockfile change |
| `npm run typecheck` | `tsc -p tsconfig.json` over `src/` and `test/`; the compile check | after every change |
| `npx vitest run <file>` | one test file | while working on that file |
| `npm test` | every vitest test, fake bridge included | once, before pushing |
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/` (the `master-flow` bin) | once, before pushing |

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, `npm test` and
`npm run build` on every PR. There is no file watcher. Run the compile check and the
targeted tests instead. Trying the CLI for real needs a running bridge
([openflowfm/bridge](https://github.com/openflowfm/bridge)), Live 12.4+, and the
probes on a track.

Every agent commit must end with a blank line and a GitHub-compatible co-author trailer naming the agent that actually made it, for example `Co-authored-by: Codex <noreply@openai.com>` or `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never name an agent that didn't write the commit.
