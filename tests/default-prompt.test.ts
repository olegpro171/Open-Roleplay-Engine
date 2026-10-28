import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { defaultPrompt, promptSchema } from '../src/shared/library.js';
import { createApp } from '../src/server/app.js';
import { compactPrompt } from './support/compact-prompt.js';
import { assembleRequest } from '../src/core/prompt.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'ore-default-prompt-'));
  directories.push(directory);
  return join(directory, 'chat.sqlite');
}

it('seeds the supplied preset exactly, apart from its name, on a fresh installation', () => {
  // SHA-256 of the supplied JSON serialized compactly, with only its name changed.
  expect(createHash('sha256').update(JSON.stringify(defaultPrompt)).digest('hex'))
    .toBe('8b1d44aeb881dda8fa99e462bae663b9f88042383e2a59a9431d05d50810a9dc');
  expect(promptSchema.parse(defaultPrompt)).toEqual(defaultPrompt);
  const store = new Store(database());
  try {
    expect(store.libraries().prompts).toEqual([{ ...defaultPrompt, id: 'default', revision: 0 }]);
    const chatId = store.createChat({ title: 'New story', targetInputTokens: 32000, connectionId: null, promptId: 'default', characterId: null, personaId: null });
    const snapshot = store.engineSnapshot(chatId);
    const request = assembleRequest({ name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 64000, maxOutputTokens: 1000, customParameters: {} }, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context);
    const expectedText = defaultPrompt.blocks.flatMap(block => block.kind === 'text' ? [{ role: block.role, content: block.text.replaceAll('{{char}}', 'Character').replaceAll('{{user}}', 'You') }] : []);
    expect(request.body.messages).toEqual(expectedText);
  } finally { store.close(); }
});

it.each([compactPrompt, { name: 'Owner edited prompt', blocks: [{ id: 'owner', name: 'Owner instructions', kind: 'text' as const, enabled: true, role: 'system' as const, text: 'Keep this saved text.' }] }])('preserves saved $name across restart', saved => {
  const path = database();
  let store = new Store(path);
  try {
    store.saveLibrary(store.libraryRevision(), 'prompts', saved, 'default');
    const before = store.libraries();
    store.close();
    store = new Store(path);
    expect(store.libraries()).toEqual(before);
  } finally { store.close(); }
});

it('restores the current factory preset only through an explicit revision-checked command', async () => {
  const { app, store } = await createApp({ database: database() });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'synthetic-default-password' } });
    expect(setup.statusCode).toBe(200);
    const headers = { host: 'localhost', origin: 'http://localhost', cookie: String(setup.headers['set-cookie']).split(';')[0] };
    store.saveLibrary(store.libraryRevision(), 'prompts', compactPrompt, 'default');
    const revision = store.libraryRevision();
    const restore = (value: number) => app.inject({ method: 'POST', url: '/api/library/default/restore', headers, payload: { revision: value } });
    const before = store.libraries();
    expect((await restore(revision - 1)).statusCode).toBe(409);
    expect(store.libraries()).toEqual(before);
    expect((await restore(revision)).statusCode).toBe(200);
    expect(store.libraries().prompts).toEqual([{ ...defaultPrompt, id: 'default', revision: 2 }]);
  } finally { await app.close(); }
});

it('keeps legacy inline-settings input independent of factory prose', () => {
  const request = assembleRequest(
    { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10000, maxOutputTokens: 100, customParameters: {} },
    { title: 'Legacy story', instructions: 'Owner inline instructions.', character: 'A tower keeper.', persona: 'A visitor.', targetInputTokens: 1000 },
    [],
  );
  expect(request.body.messages).toEqual([
    { role: 'system', content: 'Owner inline instructions.' },
    { role: 'system', content: 'A tower keeper.' },
    { role: 'system', content: 'A visitor.' },
  ]);
});
