import { useRef } from 'react';
import { defaultChatInputTarget } from '../shared/chat-defaults';
import { api } from './api';
import { t } from './localization';

export function useCreateChat(
  run: (action: () => Promise<unknown>) => Promise<boolean>,
  created: (id: string, destination: 'story' | 'settings') => void,
) {
  const submitting = useRef(false);
  return async (character: { id: string; name: string } | undefined, personaId: string | null) => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      const title = character ? character.name.slice(0, 100) : t('libraries.a_new_story');
      const settings = { title, targetInputTokens: defaultChatInputTarget, characterId: character?.id ?? null, personaId };
      const request: { result?: { id: string; connectionId: string | null } } = {};
      const saved = await run(async () => {
        request.result = await api<{ id: string; connectionId: string | null }>('/chats', 'POST', settings);
      });
      if (saved && request.result) created(request.result.id, request.result.connectionId ? 'story' : 'settings');
    } finally {
      submitting.current = false;
    }
  };
}
