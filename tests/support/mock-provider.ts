import { createServer, type ServerResponse } from 'node:http';

export async function startMockProvider() {
  const requests: { body: Record<string, unknown>; authorization?: string }[] = [];
  const modelRequests: { authorization?: string }[] = [];
  let modelMode: 'normal' | 'error' | 'invalid' | 'redirect' | number = 'normal';
  const waiting: (() => void)[] = [];
  let mode: 'normal' | 'repair-unchanged' | 'hold' | 'hold-first-token' | 'reasoning' | 'reasoning-only' | 'broken' | 'empty' | 'error' | 'padded' | 'whitespace' | 'placeholder' | 'no-usage' | 'bad-usage' = 'normal';
  const send = (response: ServerResponse, value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      modelRequests.push({ authorization: request.headers.authorization });
      if (typeof modelMode === 'number') { response.writeHead(modelMode).end('upstream-secret-do-not-save'); return; }
      if (modelMode === 'error') { response.writeHead(401).end('upstream-secret-do-not-save'); return; }
      if (modelMode === 'redirect') { response.writeHead(302, { Location: '/v1/redirected-models' }).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(modelMode === 'invalid' ? { data: [{ name: 'Invalid' }] } : { data: [{ id: 'synthetic-roleplay' }, { id: 'another-model' }, { id: 'synthetic-roleplay' }] })); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body), authorization: request.headers.authorization });
    const currentMode = mode;
    let repairText: string | null = null;
    try {
      const payload = JSON.parse(JSON.parse(body).messages.at(-1).content);
      if (typeof payload.previous_summary === 'string') repairText = currentMode === 'repair-unchanged' ? payload.previous_summary : `${payload.previous_summary}\nRepaired candidate ${requests.length}.`;
    } catch { /* Ordinary roleplay requests contain plain source text. */ }
    if (currentMode === 'error') { response.writeHead(401).end('upstream-secret-do-not-save'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const firstToken = () => {
      if (!response.destroyed && currentMode !== 'empty' && currentMode !== 'reasoning-only') send(response, { choices: [{ index: 0, delta: { content: currentMode === 'placeholder' ? 'placeholder' : currentMode === 'padded' ? '\r\n \nThe lantern\n\n' : currentMode === 'whitespace' ? '\n\t\n' : repairText ?? 'The lantern ' }, finish_reason: null }] });
    };
    const finish = () => {
      if (response.destroyed) return;
      if (currentMode === 'broken') { response.end(); return; }
      if (!repairText && currentMode !== 'empty' && currentMode !== 'reasoning-only' && currentMode !== 'whitespace' && currentMode !== 'placeholder') send(response, { choices: [{ index: 0, delta: { content: currentMode === 'padded' ? 'flickers. 🕯\r\n\r\n ' : 'flickers. 🕯' }, finish_reason: null }] });
      send(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (currentMode !== 'no-usage') send(response, { choices: [], usage: currentMode === 'bad-usage' ? { prompt_tokens: -1, completion_tokens: 'wrong', total_tokens: 19 } : { prompt_tokens: 321, completion_tokens: 17, total_tokens: 338 } });
      response.end('data: [DONE]\n\n');
    };
    if (currentMode === 'reasoning' || currentMode === 'reasoning-only') {
      response.flushHeaders();
      send(response, { choices: [{ index: 0, delta: { reasoning: syntheticReasoningStart }, finish_reason: null }] });
      waiting.push(() => {
        if (response.destroyed) return;
        send(response, { choices: [{ index: 0, delta: { reasoning_content: syntheticReasoningTail }, finish_reason: null }] });
        waiting.push(() => { firstToken(); waiting.push(finish); });
      });
    } else if (currentMode === 'hold-first-token') {
      response.flushHeaders();
      waiting.push(() => { firstToken(); waiting.push(finish); });
    } else {
      firstToken();
      if (currentMode === 'hold') waiting.push(finish);
      else setTimeout(finish, 20);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock endpoint address.');
  return {
    url: `http://127.0.0.1:${address.port}/v1`, requests, modelRequests,
    setMode(value: typeof mode) { mode = value; },
    setModelMode(value: typeof modelMode) { modelMode = value; },
    finishAll() { waiting.splice(0).forEach((finish) => finish()); },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

export const syntheticReasoningStart = 'Consider the scene before answering.\n' + Array.from({ length: 80 }, (_, i) => `Reasoning line ${i + 1}: preserve the lantern and the quiet tower.\n`).join('');
export const syntheticReasoningTail = 'The newest thought: keep the reply grounded in the scene.\n';
