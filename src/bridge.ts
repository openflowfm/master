// The socket to SessionBridge: send, request-and-await-reply, and listen.
//
// Uses Node's own `WebSocket` client, so the app has no runtime dependency
// beyond the protocol's types. Only ever dials 127.0.0.1 unless told otherwise;
// the bridge binds nothing else.

import { DEFAULT_PORT, WS_PATH } from './protocol.ts';
import type { Event, EventOf, EventType, ProbeEntry, Request } from './protocol.ts';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
/** A request as a caller writes it: the client assigns the `id`. */
export type Outgoing = WithoutId<Request>;

export type Listener = (event: Event) => void;

/**
 * What every part of the app talks to. `connectBridge` gives the real one;
 * tests can give the same thing over a fake bridge.
 */
export interface Bridge {
  /** Fire and forget, for the requests with no reply (`setDevice`, `watchChains`, …). */
  send(message: Outgoing): void;
  /**
   * Send with an id and resolve on the event named `reply` carrying it. An
   * `error` with the same id rejects.
   */
  request<K extends EventType>(message: Outgoing, reply: K, timeoutMs?: number): Promise<EventOf<K>>;
  /** Every event, in arrival order. Returns the unsubscribe. */
  on(listener: Listener): () => void;
  /** The next event of `type` that passes `match`. No timeout unless given. */
  waitFor<K extends EventType>(
    type: K,
    match?: (event: EventOf<K>) => boolean,
    timeoutMs?: number,
  ): Promise<EventOf<K>>;
  /**
   * The bridge's latest `probes` list. It is sent on connect; if none has
   * arrived within `timeoutMs` the answer is an empty list.
   */
  probes(timeoutMs?: number): Promise<ProbeEntry[]>;
  close(): Promise<void>;
  /** Resolves when the socket has closed, from either side. */
  closed: Promise<void>;
}

export interface ConnectOptions {
  host?: string;
  port?: number;
  /** Overrides host and port entirely. */
  url?: string;
  /** Default timeout for `request`, ms. */
  timeoutMs?: number;
}

export function bridgeUrl(options: ConnectOptions = {}): string {
  if (options.url) return options.url;
  return `ws://${options.host ?? '127.0.0.1'}:${options.port ?? DEFAULT_PORT}${WS_PATH}`;
}

export class BridgeError extends Error {
  override name = 'BridgeError';
}

export async function connectBridge(options: ConnectOptions = {}): Promise<Bridge> {
  const socket = new WebSocket(bridgeUrl(options));
  const defaultTimeout = options.timeoutMs ?? 10_000;
  const listeners = new Set<Listener>();
  let latestProbes: ProbeEntry[] | null = null;
  let nextId = 1;
  let closed = false;

  socket.addEventListener('message', (message) => {
    let event: Event;
    try {
      event = JSON.parse(String(message.data)) as Event;
    } catch {
      return;
    }
    if (event.type === 'probes') latestProbes = event.probes;
    for (const listener of [...listeners]) listener(event);
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener(
      'error',
      () => reject(new BridgeError(`could not reach the bridge at ${bridgeUrl(options)}`)),
      { once: true },
    );
  });

  const closedPromise = new Promise<void>((resolve) => {
    socket.addEventListener('close', () => {
      closed = true;
      resolve();
    });
  });

  const on = (listener: Listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };

  const write = (message: Request) => {
    if (closed) throw new BridgeError('the bridge connection is closed');
    socket.send(JSON.stringify(message));
  };
  const send = (message: Outgoing) => write(message as Request);

  const waitFor = <K extends EventType>(
    type: K,
    match?: (event: EventOf<K>) => boolean,
    timeoutMs?: number,
  ) =>
    new Promise<EventOf<K>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = on((event) => {
        if (event.type !== type) return;
        const typed = event as EventOf<K>;
        if (match && !match(typed)) return;
        off();
        if (timer) clearTimeout(timer);
        resolve(typed);
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          off();
          reject(new BridgeError(`timed out waiting for ${type}`));
        }, timeoutMs);
      }
    });

  const request = <K extends EventType>(message: Outgoing, reply: K, timeoutMs = defaultTimeout) =>
    new Promise<EventOf<K>>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        off();
        reject(new BridgeError(`timed out waiting for ${reply} to ${message.type}`));
      }, timeoutMs);
      const off = on((event) => {
        if (!('id' in event) || event.id !== id) return;
        if (event.type === 'error') {
          off();
          clearTimeout(timer);
          reject(new BridgeError(event.message));
        } else if (event.type === reply) {
          off();
          clearTimeout(timer);
          resolve(event as EventOf<K>);
        }
      });
      try {
        write({ ...message, id } as Request);
      } catch (error) {
        off();
        clearTimeout(timer);
        reject(error);
      }
    });

  const probes = async (timeoutMs = 2_000) => {
    if (latestProbes) return latestProbes;
    try {
      return (await waitFor('probes', undefined, timeoutMs)).probes;
    } catch {
      return [];
    }
  };

  const close = async () => {
    if (!closed) socket.close();
    await closedPromise;
  };

  return { send, request, on, waitFor, probes, close, closed: closedPromise };
}
