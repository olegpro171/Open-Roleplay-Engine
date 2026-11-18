import { useState } from 'react';
import type { LibrarySnapshot } from '../shared/library';
import { ChatParticipants, type ChatParticipantsValue } from './ChatParticipants';
import { t, useLocale } from './localization';
import { useCreateChat } from './useCreateChat';

export function NewChat({ library, busy, run, created, cancel }: {
  library: LibrarySnapshot;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  created: (id: string, destination: 'story' | 'settings') => void;
  cancel: () => void;
}) {
  useLocale();
  const [participants, setParticipants] = useState<ChatParticipantsValue>({ characterId: null, personaId: null });
  const createChat = useCreateChat(run, created);
  const character = library.characters.find(item => item.id === participants.characterId);
  const persona = library.personas.find(item => item.id === participants.personaId);
  return <form onSubmit={event => {
    event.preventDefault();
    if (!busy) void createChat(character, persona?.id ?? null);
  }}><fieldset disabled={busy}><legend>{t('libraries.new_chat')}</legend>
    <ChatParticipants library={library} value={{ characterId: character?.id ?? null, personaId: persona?.id ?? null }} change={setParticipants} disabled={busy} />
    <div className="actions">
      <button>{t('libraries.create_chat')}</button>
      <button type="button" className="quiet" onClick={cancel}>{t('character_import.cancel')}</button>
    </div>
  </fieldset></form>;
}
