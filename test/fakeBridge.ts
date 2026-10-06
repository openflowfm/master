// A small stand-in for SessionBridge, speaking the contract over a real
// WebSocket on 127.0.0.1 and an ephemeral port. Tests script it per request
// type; it never touches Live and nothing here may dial the real bridge.

import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Event, ProbeEntry, Request } from '../src/protocol.ts';

export type Handler<T extends Request['type'] = Request['type']> = (
  request: Extract<Request, { type: T }>,
  ctx: { reply: (event: Event) => void; broadcast: (event: Event) => void },
) => void | Promise<void>;

export interface FakeBridge {
  /** `ws://127.0.0.1:<port>/ws` */
  url: string;
  /** Every request received, in order. */
  received: Request[];
  /** Script a reply for one request type. Unscripted requests are recorded and ignored. */
  handle<T extends Request['type']>(type: T, handler: Handler<T>): void;
  /** Send an event to every connected client. */
  broadcast(event: Event): void;
  /** Resolves on the next request of this type (or immediately if one already came and wasn't consumed). */
  nextRequest<T extends Request['type']>(type: T): Promise<Extract<Request, { type: T }>>;
  close(): Promise<void>;
}

export async function startFakeBridge(options: { probes?: ProbeEntry[] } = {}): Promise<FakeBridge> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  const handlers = new Map<string, Handler>();
  const received: Request[] = [];
  const waiters: Array<{ type: string; resolve: (r: Request) => void }> = [];
  const unconsumed: Request[] = [];
  const clients = new Set<WebSocket>();

  const broadcast = (event: Event) => {
    const text = JSON.stringify(event);
    for (const client of clients) client.send(text);
  };

  server.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    if (options.probes) socket.send(JSON.stringify({ type: 'probes', probes: options.probes } satisfies Event));
    socket.on('message', async (data) => {
      const request = JSON.parse(String(data)) as Request;
      received.push(request);
      const waiter = waiters.findIndex((w) => w.type === request.type);
      if (waiter >= 0) waiters.splice(waiter, 1)[0]!.resolve(request);
      else unconsumed.push(request);
      const handler = handlers.get(request.type);
      if (!handler) return;
      const reply = (event: Event) => {
        const withId = 'id' in request && request.id !== undefined ? { ...event, id: request.id } : event;
        socket.send(JSON.stringify(withId));
      };
      await handler(request, { reply, broadcast });
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    received,
    handle(type, handler) {
      handlers.set(type, handler as unknown as Handler);
    },
    broadcast,
    nextRequest(type) {
      const index = unconsumed.findIndex((r) => r.type === type);
      if (index >= 0) return Promise.resolve(unconsumed.splice(index, 1)[0] as never);
      return new Promise((resolve) => waiters.push({ type, resolve: resolve as (r: Request) => void }));
    },
    async close() {
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
