import { createServer, type ServerResponse } from 'node:http';

export async function startMockProvider() {
  const requests: { body: Record<string, unknown>; authorization?: string }[] = [];
  const waiting: (() => void)[] = [];
  let mode: 'normal' | 'hold' | 'broken' | 'empty' | 'error' = 'normal';
  const send = (response: ServerResponse, value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body), authorization: request.headers.authorization });
    const currentMode = mode;
    if (currentMode === 'error') { response.writeHead(401).end('upstream-secret-do-not-save'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (currentMode !== 'empty') send(response, { choices: [{ index: 0, delta: { content: 'The lantern ' }, finish_reason: null }] });
    const finish = () => {
      if (response.destroyed) return;
      if (currentMode === 'broken') { response.end(); return; }
      if (currentMode !== 'empty') send(response, { choices: [{ index: 0, delta: { content: 'flickers. 🕯' }, finish_reason: null }] });
      send(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      response.end('data: [DONE]\n\n');
    };
    if (currentMode === 'hold') waiting.push(finish);
    else setTimeout(finish, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock endpoint address.');
  return {
    url: `http://127.0.0.1:${address.port}/v1`, requests,
    setMode(value: typeof mode) { mode = value; },
    finishAll() { waiting.splice(0).forEach((finish) => finish()); },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
