import { expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockProvider, syntheticReasoningStart } from './support/mock-provider.js';
import type { ChatSnapshot } from '../src/shared/contracts.js';
import { defaultContextPreset } from '../src/shared/context.js';
import { compactPrompt } from './support/compact-prompt.js';

it.each(['hold', 'reasoning'] as const)('recovers a real server crash during %s with checkpointed output and no automatic provider retry', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-crash-'));
  const mock = await startMockProvider();
  mock.setMode(mode);
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
    if (mode === 'reasoning') await expect.poll(async () => (await getState()).generations[0]?.reasoningText).toBe(syntheticReasoningStart.slice(-2000));
    else await expect.poll(async () => (await getState()).generations[0]?.partialText).toBe('The lantern ');
    const pending = (await getState()).turns[0];
    await stop(); await start();
    const recovered = await getState();
    expect(recovered.turns[0]).toEqual(pending);
    expect(recovered.generations[0]).toMatchObject({ status: 'interrupted', partialText: mode === 'reasoning' ? '' : 'The lantern ', errorMessage: { key: 'outcome.generationInterrupted' } });
    const reasoning = await fetch(`${address}/api/chats/main/generations/${recovered.generations[0].id}/reasoning`, { headers: { cookie } }).then(response => response.json() as Promise<{ text: string }>);
    expect(reasoning.text).toBe(mode === 'reasoning' ? syntheticReasoningStart : '');
    expect(mock.requests).toHaveLength(1);
    mock.setMode('normal');
    await post('/api/retry', { revision: recovered.revision, requestId: randomUUID() });
    await expect.poll(async () => (await getState()).turns[0].complete).toBe(true);
    expect((await getState()).turns).toHaveLength(1);
    expect(mock.requests).toHaveLength(2);
    expect(JSON.stringify(mock.requests[1].body)).not.toContain('Reasoning line');
  } finally {
    await stop(); await mock.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

it('keeps committed summaries after a real process crash and resumes only on an explicit command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-context-crash-'));
  const mock = await startMockProvider();
  let child: ChildProcess | undefined, address = '', cookie = '';
  const start = async () => {
    child = fork(resolve('tests/support/server-process.ts'), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, ROLEPLAY_TEST_DATABASE: join(directory, 'chat.sqlite') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server child did not start.')), 5_000);
      child!.once('message', message => { clearTimeout(timer); resolve((message as { address: string }).address); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited: ${code}`)); });
      child!.once('error', reject);
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await stopped;
  };
  const post = async (path: string, data: unknown) => {
    const response = await fetch(address + path, { method: 'POST', headers: { cookie, Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    expect(response.ok).toBe(true); return response.json();
  };
  const library = async () => fetch(address + '/api/library', { headers: { cookie } }).then(response => response.json() as Promise<{ revision: number }>);
  let chatId = '';
  const state = () => fetch(`${address}/api/chats/${chatId}`, { headers: { cookie } }).then(response => response.json() as Promise<ChatSnapshot>);
  try {
    await start();
    const setup = await fetch(address + '/api/setup', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'crash-synthetic-password' }) });
    cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const connection = await post('/api/library', { revision: (await library()).revision, kind: 'connections', data: { name: 'Synthetic', endpoint: mock.url, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} } });
    const context = await post('/api/library', { revision: (await library()).revision, kind: 'contexts', data: { ...defaultContextPreset, connectionId: connection.id, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 1 } });
    const prompt = await post('/api/library', { revision: (await library()).revision, kind: 'prompts', data: compactPrompt });
    chatId = (await post('/api/chats', { title: 'Crash proof', targetInputTokens: 2_200, connectionId: connection.id, promptId: prompt.id, characterId: null, personaId: null, contextPresetId: context.id })).id;
    const imported = Array.from({ length: 24 }, (_, i) => ({ user: `Turn ${i}. ${'Mira offers the brass key. '.repeat(10)}`, assistant: 'Leon promises to avoid the cellar. '.repeat(8), complete: true }));
    const replace = await fetch(`${address}/api/chats/${chatId}/history`, { method: 'PUT', headers: { cookie, Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await state()).revision, turns: imported }) });
    expect(replace.ok).toBe(true);
    await post(`/api/chats/${chatId}/context/prepare`, { revision: (await state()).revision, requestId: randomUUID(), mode: 'step' });
    await expect.poll(async () => (await state()).context.jobs[0].status).toBe('succeeded');
    const committed = (await state()).context.selected;
    mock.setMode('hold');
    await post(`/api/chats/${chatId}/context/prepare`, { revision: (await state()).revision, requestId: randomUUID(), mode: 'prepare' });
    await expect.poll(() => mock.requests.length).toBe(2);
    await stop(); await start();
    const recovered = await state();
    expect(recovered.context.jobs[0].status).toBe('interrupted');
    expect(recovered.context.selected).toEqual(committed); expect(mock.requests).toHaveLength(2);
    mock.setMode('normal');
    await post(`/api/chats/${chatId}/context/prepare`, { revision: recovered.revision, requestId: randomUUID(), mode: 'prepare' });
    await expect.poll(async () => (await state()).context.jobs[0].status, { timeout: 5_000 }).toBe('succeeded');
    expect((await state()).turns).toHaveLength(24);
    expect((await state()).context.summaries.some(node => node.id === committed[0].id)).toBe(true);
  } finally { await stop(); await mock.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
