#!/usr/bin/env node
// master-flow: the command line over `session.ts`.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { connectBridge } from './bridge.ts';
import { defaultStateDir } from './capture.ts';
import { stopAfter } from './pass.ts';
import { capture, identify, run, type SessionIO } from './session.ts';
import type { Material } from './types.ts';

const USAGE = `master-flow — improve a recording on a Live track, through the bridge.

Usage:
  master-flow run     --track <name> | --index <n>  [options]
  master-flow capture --track <name> | --index <n>  [--log <file>]

run:      lay out the probes, listen, plan a chain, set it, check it.
capture:  after tweaking by ear, append {pre report, plan, final settings}
          to the learning log.

Options:
  --track <name>        track name (exact, or part of exactly one name)
  --index <n>           Live's track index, 0 = first track
  --material <m>        speech (default) or music
  --target-lufs <x>     loudness target; default -16 speech, -14 music
  --seconds <s>         end each listening pass after s seconds instead of a keypress
  --dry-run             plan only; insert and set nothing
  --port <n>            bridge port on 127.0.0.1 (default 17800)
  --state-dir <dir>     where runs and captures are kept (default ~/.openflow/master)
  --log <file>          the capture log (default <state-dir>/captures.jsonl)
  -h, --help
`;

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Resolves on the next key (TTY) or line (piped stdin). Ctrl-C exits. */
function nextKey(): Promise<void> {
  const stdin = process.stdin;
  return new Promise((resolve) => {
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (data: Buffer) => {
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      if (data[0] === 3) process.exit(130);
      resolve();
    });
  });
}

const number = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${flag} wants a number, got "${value}"`);
  return n;
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      track: { type: 'string' },
      index: { type: 'string' },
      material: { type: 'string', default: 'speech' },
      'target-lufs': { type: 'string' },
      seconds: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      port: { type: 'string' },
      'state-dir': { type: 'string' },
      log: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || (command !== 'run' && command !== 'capture')) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  if (values.material !== 'speech' && values.material !== 'music') throw new Error('--material is speech or music');
  const material: Material = values.material;
  const seconds = number(values.seconds, '--seconds');
  const choice = { name: values.track, index: number(values.index, '--index') };
  const stateDir = values['state-dir'] ?? defaultStateDir();

  let lastProgress = 0;
  const io: SessionIO = {
    log: (line) => process.stdout.write(`${line}\n`),
    waitForDone: () => (seconds !== undefined ? stopAfter(seconds * 1000) : nextKey()),
    progress: (key, report) => {
      const now = Date.now();
      if (now - lastProgress < 2000) return;
      lastProgress = now;
      const lufs = report.lufsIntegrated === null ? '—' : report.lufsIntegrated.toFixed(1);
      process.stdout.write(`  ${report.seconds.toFixed(0)} s heard, ${lufs} LUFS (${key.slice(0, 6)})\n`);
    },
  };

  const bridge = await connectBridge({ port:number(values.port, '--port') });
  try {
    identify(bridge, version());
    if (command === 'capture') {
      await capture(bridge, { ...choice, stateDir, file: values.log }, io);
      return 0;
    }
    const result = await run(
      bridge,
      { ...choice, material, targetLufs: number(values['target-lufs'], '--target-lufs'), dryRun: values['dry-run'], stateDir },
      io,
    );
    return result.instructions ? 2 : 0;
  } finally {
    await bridge.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`master-flow: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
