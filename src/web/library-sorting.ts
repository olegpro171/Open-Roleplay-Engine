import { t, locale } from './localization';
import { z } from 'zod';
import type { LibraryDates, LibraryKind } from '../shared/library';

export type LibrarySection = LibraryKind | 'chats';
export const librarySortSchema = z.enum(['name-asc', 'name-desc', 'created-desc', 'created-asc', 'updated-desc', 'updated-asc', 'message-desc', 'message-asc']);
export type LibrarySort = z.infer<typeof librarySortSchema>;

export function sortOptions(section: LibrarySection) {
  return [
    { value: 'name-asc', label: t("library-sorting.name_a_z") },
    { value: 'name-desc', label: t("library-sorting.name_z_a") },
    { value: 'created-desc', label: t("library-sorting.added_newest") },
    { value: 'created-asc', label: t("library-sorting.added_oldest") },
    { value: 'updated-desc', label: t("library-sorting.edited_newest") },
    { value: 'updated-asc', label: t("library-sorting.edited_oldest") },
    ...(section === 'chats' ? [
      { value: 'message-desc', label: t("library-sorting.message_recent") },
      { value: 'message-asc', label: t("library-sorting.message_oldest") },
    ] : []),
  ];
}

export function defaultLibrarySort(section: LibrarySection): LibrarySort {
  return section === 'chats' ? 'message-desc' : 'created-desc';
}

export function readLibrarySort(section: LibrarySection): LibrarySort {
  try {
    const result = librarySortSchema.safeParse(localStorage.getItem(`roleplay-library-sort-${section}`));
    if (result.success && sortOptions(section).some(option => option.value === result.data)) return result.data;
  } catch { /* Sorting remains available when browser storage is unavailable. */ }
  return defaultLibrarySort(section);
}

type ItemDates = LibraryDates & { lastMessageAt?: string | null };

/** Presentation order only; never mutate the authoritative snapshot or editor data. */
export function sortLibraryItems<T extends { id: string }>(items: readonly T[], method: LibrarySort, name: (item: T) => string, dates: (item: T) => ItemDates | undefined): T[] {
  const names = new Intl.Collator(locale(), { sensitivity: 'base', numeric: true });
  const direction = method.endsWith('-asc') ? 1 : -1;
  function date(item: T): string | null {
    const value = dates(item);
    if (!value) return null;
    if (method.startsWith('updated-')) return value.updatedAt ?? value.createdAt;
    if (method.startsWith('message-')) return value.lastMessageAt ?? value.createdAt;
    return value.createdAt;
  }
  return [...items].sort((a, b) => {
    const byName = names.compare(name(a), name(b));
    if (method.startsWith('name-')) return byName * direction || a.id.localeCompare(b.id);
    const first = date(a), second = date(b);
    // Unknown historical dates stay at the end in either direction.
    if (first === null && second !== null) return 1;
    if (second === null && first !== null) return -1;
    const byDate = first !== null && second !== null ? first.localeCompare(second) * direction : 0;
    return byDate || byName || a.id.localeCompare(b.id);
  });
}
