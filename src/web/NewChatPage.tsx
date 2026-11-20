import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolveChatDefaults, type ChatDefaultsStatus } from '../shared/chat-defaults';
import type { LibrarySnapshot } from '../shared/library';
import { characterDropdownOptions, personaDropdownOptions, type ChatParticipantsValue } from './ChatParticipants';
import { Dropdown } from './Controls';
import { Icon } from './Icon';
import type { LibraryDestination, SetupLibrary } from './Libraries';
import { LibraryCard } from './LibraryCard';
import { PictureSquare } from './Pictures';
import { message as msg, t, useLocale } from './localization';
import { useConfirmation } from './Confirmation';
import { displayLibraryRecord, libraryLabel } from './localization-labels';
import { useCreateChat } from './useCreateChat';

const compactLayoutQuery = '(max-width: 800px)';

export function NewChatPage({ library, defaults, busy, pendingTurnEdit, run, openLibrary, openChat, preferredParticipants, chooseParticipant }: {
  library: LibrarySnapshot;
  defaults: ChatDefaultsStatus;
  busy: boolean;
  pendingTurnEdit: boolean;
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
  const [compact, setCompact] = useState(() => window.matchMedia(compactLayoutQuery).matches);
  const createChat = useCreateChat(run, openChat);
  const confirmStart = useConfirmation();
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const query = window.matchMedia(compactLayoutQuery);
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    const position = scrollBeforeSelection.current;
    scrollBeforeSelection.current = null;
    if (position !== null && scroller.current) scroller.current.scrollTop = position;
  }, [preferredParticipants]);

  function selectParticipant(key: keyof ChatParticipantsValue, id: string) {
    // WebKit can scroll the page when a preview is replaced even if its size stays the same.
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
  const create = (kind: SetupLibrary) => openLibrary({ kind, action: 'create', returnTo: 'story' });
  const browse = (kind: LibraryDestination['kind']) => openLibrary({ kind, action: 'browse' });

  function renderLibraryShortcut(kind: SetupLibrary | 'prompts') {
    return <HomeLibraryShortcut label={libraryLabel(kind)} onClick={() => browse(kind)} disabled={busy} />;
  }

  function startChat(returnFocus: HTMLElement) {
    if (busy || !connection || !character) return;
    const start = () => void createChat(character, persona?.id ?? null);
    if (!pendingTurnEdit) { start(); return; }
    confirmStart({
      title: msg('new_chat.start'),
      message: msg('new_chat.discard_turn_edit'),
      actionLabel: msg('new_chat.start'),
      returnFocus,
      onConfirm: start,
    });
  }

  function renderParticipantPanel(kind: 'characters' | 'personas') {
    const isCharacter = kind === 'characters';
    const title = t(isCharacter ? 'app.character' : 'libraries.persona');
    const headingId = isCharacter ? 'story-home-character' : 'story-home-persona';
    const participant = isCharacter ? character : persona;
    const canChoose = isCharacter ? library.characters.length > 1 : library.personas.length > 0;
    const blocksChat = isCharacter && !participant;
    return <section key={kind} className={`story-home-panel story-home-participants${blocksChat ? ' blocks-chat' : ''}`} aria-labelledby={headingId}>
      <header className="story-home-panel-heading">
        <div>
          <h2 id={headingId}>{title}</h2>
          {compact && !isCharacter && <small className="muted">{t('story_home.persona_optional')}</small>}
        </div>
        {canChoose && <Dropdown aria-label={title} disabled={busy} value={participant?.id ?? ''}
          options={isCharacter ? characterDropdownOptions(library) : personaDropdownOptions(library)}
          onChange={id => selectParticipant(isCharacter ? 'characterId' : 'personaId', id)} />}
        {compact && !canChoose && !participant && <small className="muted story-home-participant-status">{t('character_editor.none_selected')}</small>}
      </header>
      {participant
        ? <LibraryCard title={participant} description={participant.description} heading="h3"
          picture={isCharacter ? <PictureSquare url={picture?.thumbnailUrl} /> : undefined}
          disabled={busy} open={() => openLibrary({ kind, id: participant.id, action: 'edit', returnTo: 'story' })} />
        : <HomeCardPlaceholder picture={isCharacter}
          description={compact ? undefined : t(isCharacter ? 'story_home.no_character_selected' : 'story_home.persona_help')} />}
      <div className="actions">
        <HomeCreateAction label={t(isCharacter ? 'story_home.create_character' : 'story_home.create_persona')}
          onClick={() => create(kind)} disabled={busy} />
        {renderLibraryShortcut(kind)}
      </div>
    </section>;
  }

  const createConnection = <HomeCreateAction label={t('story_home.create_connection')}
    onClick={() => create('connections')} disabled={busy || !!connection} />;
  const connectionHeading = t('libraries.connection');
  const noConnection = t('story_home.no_connection_selected');
  const connectionSummary = connection
    ? <p role="status" title={compact ? `${connection.name} · ${connection.model}` : undefined}>
      <strong>{connection.name}</strong>{compact ? ' · ' : <br />}<span className="muted">{connection.model}</span>
    </p>
    : null;
  const defaultPanels = <div key="defaults" className="story-home-defaults">
    <section className={`story-home-panel story-home-summary${connection ? '' : ' blocks-chat'}`} aria-labelledby="story-home-connection">
      <div className="story-home-summary-content">
        {compact ? <>
          <h2 id="story-home-connection" className="story-home-connection-heading">
            <span aria-hidden={!connection || undefined}>{connectionHeading}</span>
            <span aria-hidden={!!connection || undefined}>{noConnection}</span>
          </h2>
          <div className="story-home-connection-details">
            <div aria-hidden={!!connection || undefined}>
              {createConnection}
            </div>
            {connectionSummary}
          </div>
        </> : <>
          <h2 id="story-home-connection">{connectionHeading}</h2>
          {connectionSummary ?? <p className="muted">{noConnection}</p>}
        </>}
      </div>
      <div className="actions">
        {!compact && !connection && createConnection}
        {renderLibraryShortcut('connections')}
      </div>
    </section>
    <section className="story-home-panel story-home-summary" aria-labelledby="story-home-prompt">
      <div className="story-home-summary-content">
        <h2 id="story-home-prompt">{t('story_home.prompt')}</h2>
        {prompt && <p role="status">
          <strong>{displayLibraryRecord(prompt).name}</strong>{compact ? ' · ' : <br />}
          <span className="muted">{t('libraries.block_count', { count: prompt.blocks.length })}</span>
        </p>}
      </div>
      <div className="actions">
        {renderLibraryShortcut('prompts')}
      </div>
    </section>
  </div>;
  const participantPanels = [renderParticipantPanel('characters'), renderParticipantPanel('personas')];

  return <main ref={scroller} className={`document-panel story-home${compact ? ' story-home-compact' : ''}`} aria-labelledby="story-home-heading">
    <header className="story-home-heading">
      <h1 ref={heading} id="story-home-heading" tabIndex={-1}>{t('libraries.new_chat')}</h1>
      {library.chats.length > 0 && <button type="button" className="text-link" disabled={busy} onClick={() => browse('chats')}>
        <span>{t('story_home.open_chats')}</span><Icon name="ArrowShortForward" />
      </button>}
    </header>
    <div className="story-home-panels">
      {compact ? [...participantPanels, defaultPanels] : [defaultPanels, ...participantPanels]}
    </div>
    <div className="actions story-home-chat-actions">
      <button type="button" disabled={busy || !connection || !character} onClick={event => startChat(event.currentTarget)}>{t('new_chat.start')}</button>
    </div>
  </main>;
}

type HomeActionProps = { label: string; onClick: () => void; disabled: boolean };

function HomeLibraryShortcut({ label, onClick, disabled }: HomeActionProps) {
  return <button type="button" className="quiet" disabled={disabled} onClick={onClick}>
    <span>{label}</span><Icon name="ArrowShortForward" />
  </button>;
}

function HomeCreateAction({ label, onClick, disabled }: HomeActionProps) {
  useLocale();
  return <button type="button" className="quiet" disabled={disabled} onClick={onClick} aria-label={label}>
    <Icon name="Plus" /><span>{t('libraries.create')}</span>
  </button>;
}

function HomeCardPlaceholder({ picture, description }: { picture: boolean; description?: string }) {
  return <div className="library-card" aria-hidden={description ? undefined : true}>
    <div className="library-card-body">
      {picture && <div className="picture-square" aria-hidden="true" />}
      <div className="library-card-content">
        <span className="story-home-placeholder-title" aria-hidden="true" />
        {description ? <p className="story-home-placeholder-description small muted">{description}</p>
          : <span className="story-home-placeholder-line" />}
      </div>
    </div>
  </div>;
}
