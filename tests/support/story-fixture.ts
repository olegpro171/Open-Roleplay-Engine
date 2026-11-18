import { chatGroups, chats } from '../../src/persistence/schema.js';
import { Store } from '../../src/persistence/store.js';
import { createApp } from '../../src/server/app.js';
import { defaultChatInputTarget } from '../../src/shared/chat-defaults.js';
import type { ChatSettings } from '../../src/shared/contracts.js';
import { defaultInstructions } from '../../src/shared/library.js';

// Legacy API, migration, and lifecycle scenarios address a known initial branch.
export function seedStory(store: Store) {
  const settings: ChatSettings = {
    title: 'A new story', instructions: defaultInstructions, character: '', persona: '',
    targetInputTokens: defaultChatInputTarget, connectionId: null, promptId: 'default',
    characterId: null, personaId: null, contextPresetId: null, lorebookId: null,
  };
  store.sqlite.transaction(() => {
    store.db.insert(chatGroups).values({ id: 'main', settings }).run();
    store.db.insert(chats).values({ id: 'main', groupId: 'main', revision: 0, settings: {} }).run();
  })();
}

export function openStoryStore(...options: ConstructorParameters<typeof Store>) {
  const store = new Store(...options);
  try { seedStory(store); return store; }
  catch (error) { store.close(); throw error; }
}

export async function createStoryApp(options: Parameters<typeof createApp>[0]) {
  const application = await createApp(options);
  try { seedStory(application.store); return application; }
  catch (error) { await application.app.close(); throw error; }
}
