import { characterLabel, personaLabel, type LibrarySnapshot } from '../shared/library';
import { Dropdown } from './Controls';
import { readLibrarySort, sortLibraryItems } from './library-sorting';
import { t, useLocale } from './localization';
import { CharacterAvatar } from './Pictures';

export function characterDropdownOptions(library: LibrarySnapshot) {
  const pictures = new Map(library.characterPictures.map(picture => [picture.characterId, picture.thumbnailUrl]));
  return [
    { value: '', label: t("character_editor.none_selected") },
    ...sortLibraryItems(library.characters, readLibrarySort('characters'), characterLabel, item => library.dates[item.id]).map(character => ({
      value: character.id,
      label: characterLabel(character),
      leading: <CharacterAvatar url={pictures.get(character.id)} />,
    })),
  ];
}
export function personaDropdownOptions(library: LibrarySnapshot) {
  return [
    { value: '', label: t("character_editor.none_selected") },
    ...sortLibraryItems(library.personas, readLibrarySort('personas'), personaLabel, item => library.dates[item.id])
      .map(item => ({ value: item.id, label: personaLabel(item) })),
  ];
}
export type ChatParticipantsValue = { characterId: string | null; personaId: string | null };

export function ChatParticipants({ library, value, change, disabled }: {
  library: LibrarySnapshot;
  value: ChatParticipantsValue;
  change: (value: ChatParticipantsValue) => void;
  disabled: boolean;
}) {
  useLocale();
  return <div className="form-grid">
    <label>{t('app.character')}<Dropdown aria-label={t('app.character')} disabled={disabled}
      value={value.characterId ?? ''} onChange={id => change({ ...value, characterId: id || null })} options={characterDropdownOptions(library)} /></label>
    <label>{t('libraries.persona')}<Dropdown aria-label={t('libraries.persona')} disabled={disabled}
      value={value.personaId ?? ''} onChange={id => change({ ...value, personaId: id || null })} options={personaDropdownOptions(library)} /></label>
  </div>;
}
