import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { LanInterface } from '../shared/lan.js';

export type LanRoute = (request: IncomingMessage, response: ServerResponse) => void;
export type LanTransport = { close: () => Promise<void> };
export type ListenLan = (binding: LanInterface, port: number, route: LanRoute, failed: () => void) => Promise<LanTransport>;

export const listenLan: ListenLan = (binding, port, route, failed) => {
  const sockets = new Set<Socket>();
  const server = createServer(route);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return new Promise((resolve, reject) => {
    const startingFailed = (error: Error) => { server.close(); reject(error); };
    server.once('error', startingFailed);
    server.listen({ host: binding.address, port, exclusive: true }, () => {
      server.removeListener('error', startingFailed);
      server.on('error', failed);
      resolve({ close: () => new Promise<void>(closed => {
        server.close(() => closed());
        for (const socket of sockets) socket.destroy();
      }) });
    });
  });
};
