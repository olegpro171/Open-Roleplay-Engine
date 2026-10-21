import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLibrarySort, sortLibraryItems, sortOptions } from '../src/web/library-sorting';
import type { LibraryDates } from '../src/shared/library';

const entries = [
  { id: 'b', name: 'Bravo', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: null },
  { id: 'a', name: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
  { id: 'z', name: 'Legacy', createdAt: null, updatedAt: null },
];
const order = (method: Parameters<typeof sortLibraryItems>[1]) => sortLibraryItems(entries, method, item => item.name, item => item).map(item => item.id);
afterEach(() => { vi.unstubAllGlobals(); });

describe('library presentation sorting', () => {
  it('validates saved preferences and falls back when storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'message-asc' });
    expect(readLibrarySort('chats')).toBe('message-asc');
    expect(readLibrarySort('characters')).toBe('created-desc');
    vi.stubGlobal('localStorage', { getItem: () => 'unsupported-value' });
    expect(readLibrarySort('chats')).toBe('message-desc');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage blocked'); } });
    expect(readLibrarySort('characters')).toBe('created-desc');
  });
  it('sorts names in both directions without changing the input list', () => {
    expect(order('name-asc')).toEqual(['a', 'b', 'z']);
    expect(order('name-desc')).toEqual(['z', 'b', 'a']);
    expect(entries.map(item => item.id)).toEqual(['b', 'a', 'z']);
  });
  it('sorts dates in either direction, falls back to added for unedited items, and keeps unknown dates last', () => {
    expect(order('created-desc')).toEqual(['b', 'a', 'z']);
    expect(order('created-asc')).toEqual(['a', 'b', 'z']);
    expect(order('updated-desc')).toEqual(['a', 'b', 'z']);
    expect(order('updated-asc')).toEqual(['b', 'a', 'z']);
  });
  it('sorts chats by message date, using creation only for chats without dated messages', () => {
    const chats = entries.map(item => ({ ...item, lastMessageAt: item.id === 'a' ? '2026-01-04T00:00:00.000Z' : null }));
    expect(sortLibraryItems(chats, 'message-desc', item => item.name, item => item).map(item => item.id)).toEqual(['a', 'b', 'z']);
    expect(sortLibraryItems(chats, 'message-asc', item => item.name, item => item).map(item => item.id)).toEqual(['b', 'a', 'z']);
    expect(sortOptions('characters').some(option => option.value.startsWith('message-'))).toBe(false);
  });
  it('uses natural, case-insensitive names and stable identities to break ties', () => {
    const tied = ['10', '2', 'b', 'a'].map(id => ({ id, name: id.length === 1 && /[ab]/.test(id) ? 'SAME' : `Card ${id}` }));
    const dates: LibraryDates = { createdAt: null, updatedAt: null };
    expect(sortLibraryItems(tied, 'created-desc', item => item.name, () => dates).map(item => item.id)).toEqual(['2', '10', 'a', 'b']);
  });
});
