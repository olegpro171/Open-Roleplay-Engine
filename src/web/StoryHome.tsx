import { useEffect, useLayoutEffect, useRef } from 'react';
import { resolveChatDefaults, type ChatDefaultsStatus } from '../shared/chat-defaults';
import type { LibrarySnapshot } from '../shared/library';
import { characterDropdownOptions, personaDropdownOptions, type ChatParticipantsValue } from './ChatParticipants';
import { Dropdown } from './Controls';
import type { LibraryDestination, SetupLibrary } from './Libraries';
import { LibraryCard } from './LibraryCard';
import { PictureSquare } from './Pictures';
import { t, useLocale } from './localization';
import { displayLibraryRecord, newLibraryLabel } from './localization-labels';
import { useCreateChat } from './useCreateChat';

export function StoryHome({ library, defaults, busy, run, openLibrary, openChat, preferredParticipants, chooseParticipant }: {
  library: LibrarySnapshot;
  defaults: ChatDefaultsStatus;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  openLibrary: (destination: LibraryDestination) => void;
  openChat: (id: string, destination: 'story' | 'settings') => void;
  preferredParticipants: ChatParticipantsValue;
  chooseParticipant: (key: keyof ChatParticipantsValue, id: string | null) => void;
}) {
  useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const scrollBeforeSelection = useRef<number | null>(null);
  const createChat = useCreateChat(run, openChat);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    const position = scrollBeforeSelection.current;
    scrollBeforeSelection.current = null;
    if (position !== null && scroller.current) scroller.current.scrollTop = position;
  }, [preferredParticipants]);

  function selectParticipant(key: keyof ChatParticipantsValue, id: string) {
    // WebKit can scroll Home when a preview is replaced even if its size stays the same.
    scrollBeforeSelection.current = scroller.current?.scrollTop ?? null;
    chooseParticipant(key, id || null);
  }

  const { connectionId, promptId } = resolveChatDefaults(defaults.settings, library);
  const connection = library.connections.find(item => item.id === connectionId);
  const prompt = library.prompts.find(item => item.id === promptId);
  const character = library.characters.find(item => item.id === preferredParticipants.characterId)
    ?? (library.characters.length === 1 ? library.characters[0] : undefined);
  const persona = library.personas.find(item => item.id === preferredParticipants.personaId);
  const picture = library.characterPictures.find(item => item.characterId === character?.id);
  const hasCharacter = library.characters.length > 0;
  const hasPersona = library.personas.length > 0;
  const create = (kind: SetupLibrary) => openLibrary({ kind, action: 'create', returnTo: 'story' });
  const browse = (kind: LibraryDestination['kind']) => openLibrary({ kind, action: 'browse' });

  return <main ref={scroller} className="document-panel story-home" aria-labelledby="story-home-heading">
    <h1 ref={heading} id="story-home-heading" tabIndex={-1}>{t('story_home.welcome')}</h1>
    <p className="muted">{t(!connection ? 'story_home.next_connection' : !hasCharacter ? 'story_home.next_character' : 'story_home.next_chat')}</p>
    <div className="story-home-panels">
      <section className="story-home-panel story-home-summary" aria-labelledby="story-home-connection">
        <h2 id="story-home-connection">{t('libraries.connection')}</h2>
        {connection && <p role="status"><strong>{connection.name}</strong><br /><span className="muted">{connection.model}</span></p>}
        <div className="actions">
          {!connection && <button type="button" disabled={busy} onClick={() => create('connections')}>{t('story_home.add_connection')}</button>}
          <button type="button" className="secondary" disabled={busy} onClick={() => browse('connections')}>{t('story_home.manage_connections')}</button>
        </div>
      </section>
      <section className="story-home-panel story-home-summary" aria-labelledby="story-home-prompt">
        <h2 id="story-home-prompt">{t('story_home.prompt')}</h2>
        {prompt && <p role="status"><strong>{displayLibraryRecord(prompt).name}</strong><br />
          <span className="muted">{t('libraries.block_count', { count: prompt.blocks.length })}</span></p>}
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => browse('prompts')}>{t('story_home.manage_prompts')}</button>
        </div>
      </section>
      <section className="story-home-panel story-home-participants" aria-labelledby="story-home-character">
        <header className="story-home-panel-heading">
          <h2 id="story-home-character">{t('app.character')}</h2>
          {library.characters.length > 1 && <Dropdown aria-label={t('app.character')} disabled={busy}
            value={character?.id ?? ''} options={characterDropdownOptions(library)}
            onChange={id => selectParticipant('characterId', id)} />}
        </header>
        {character
          ? <LibraryCard title={character} description={character.description} picture={<PictureSquare url={picture?.thumbnailUrl} />} heading="h3" />
          : <ParticipantCardPlaceholder picture label={t('story_home.no_character_selected')}
            actionLabel={newLibraryLabel('characters')} create={() => create('characters')} disabled={busy} />}
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => browse('characters')}>{t('story_home.manage_characters')}</button>
        </div>
      </section>
      <section className="story-home-panel story-home-participants" aria-labelledby="story-home-persona">
        <header className="story-home-panel-heading">
          <h2 id="story-home-persona">{t('libraries.persona')}</h2>
          {hasPersona && <Dropdown aria-label={t('libraries.persona')} disabled={busy}
            value={persona?.id ?? ''} options={personaDropdownOptions(library)}
            onChange={id => selectParticipant('personaId', id)} />}
        </header>
        {persona
          ? <LibraryCard title={persona} description={persona.description} heading="h3" />
          : <ParticipantCardPlaceholder label={t('story_home.persona_help')}
            actionLabel={newLibraryLabel('personas')} create={() => create('personas')} disabled={busy} />}
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => browse('personas')}>{t('story_home.manage_personas')}</button>
        </div>
      </section>
    </div>
    <div className="actions story-home-chat-actions">
      <button type="button" disabled={busy || !connection || !character} onClick={() => {
        if (!busy && connection && character) void createChat(character, persona?.id ?? null);
      }}>{t('libraries.new_chat')}</button>
      {library.chats.length > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => browse('chats')}>{t('story_home.open_chats')}</button>}
    </div>
  </main>;
}

function ParticipantCardPlaceholder({ picture, label, actionLabel, create, disabled }: {
  picture?: boolean; label: string; actionLabel: string; create: () => void; disabled: boolean;
}) {
  return <div className="library-card">
    <div className="library-card-body">
      {picture && <div className="picture-square" aria-hidden="true" />}
      <div className="library-card-content">
        <span className="story-home-placeholder-title" aria-hidden="true" />
        <div className="story-home-placeholder-description small muted">
          <p>{label}</p>
          <button type="button" className="text-link" disabled={disabled} onClick={create}>{actionLabel}</button>
        </div>
      </div>
    </div>
  </div>;
}
