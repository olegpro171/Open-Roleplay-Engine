import { expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockProvider } from './support/mock-provider.js';
import type { ChatSnapshot } from '../src/shared/contracts.js';

it('recovers a real server crash with checkpointed text and no automatic provider retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-crash-'));
  const mock = await startMockProvider();
  mock.setMode('hold');
  let child: ChildProcess | undefined;
  let address = '';
  let cookie = '';
  const start = async () => {
    child = fork(resolve('tests/support/server-process.ts'), [], {
      execArgv: ['--import', 'tsx'], env: { ...process.env, ROLEPLAY_TEST_DATABASE: join(directory, 'chat.sqlite') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server child did not start.')), 5000);
      child!.once('message', (message) => { clearTimeout(timer); resolve((message as { address: string }).address); });
      child!.once('error', reject);
      child!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server child exited with code ${code}.`)); });
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGKILL'); await stopped;
  };
  const getState = async () => fetch(`${address}/api/chat`, { headers: { cookie } }).then((response) => response.json() as Promise<ChatSnapshot>);
  const post = (path: string, body: unknown, method = 'POST') => fetch(`${address}${path}`, { method, headers: { cookie, Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await start();
    const setup = await post('/api/setup', { password: 'crash-synthetic-password' });
    cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const initial = await getState();
    await post('/api/settings', { revision: initial.revision, settings: initial.settings, connection: { name: 'Mock', endpoint: mock.url, model: 'mock', contextWindow: 32_000, maxOutputTokens: 1000, customParameters: {} } }, 'PUT');
    const configured = await getState();
    await post('/api/turns', { revision: configured.revision, requestId: randomUUID(), text: 'I enter the tower.' });
    await expect.poll(async () => (await getState()).generations[0]?.partialText).toBe('The lantern ');
    const pending = (await getState()).turns[0];
    await stop(); await start();
    const recovered = await getState();
    expect(recovered.turns[0]).toEqual(pending);
    expect(recovered.generations[0]).toMatchObject({ status: 'interrupted', partialText: 'The lantern ' });
    expect(mock.requests).toHaveLength(1);
    mock.setMode('normal');
    await post('/api/retry', { revision: recovered.revision, requestId: randomUUID() });
    await expect.poll(async () => (await getState()).turns[0].complete).toBe(true);
    expect((await getState()).turns).toHaveLength(1);
    expect(mock.requests).toHaveLength(2);
  } finally {
    await stop(); await mock.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
