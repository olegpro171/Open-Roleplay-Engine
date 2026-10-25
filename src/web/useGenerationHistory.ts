import { useEffect, useRef, useState } from 'react';
import type { GenerationPage } from '../shared/contracts';
import { api, datasetChanged } from './api';
import { errorText, type MessageText } from './localization';

export function useGenerationHistory(chatId: string | null, enabled: boolean, change: string, selectedId: string) {
  const [navigation, setNavigation] = useState<{ chatId: string | null; cursors: (string | null)[] }>({ chatId: null, cursors: [null] });
  const [page, setPage] = useState<{ chatId: string; cursor: string | null; key: string; data: GenerationPage } | null>(null);
  const [error, setError] = useState<MessageText>('');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const cursors = navigation.chatId === chatId ? navigation.cursors : [null];
  const cursor = cursors.at(-1) ?? null;
  const identity = JSON.stringify([chatId, enabled, change, retry, selectedId]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const request = useRef<AbortController | null>(null);

  async function load(next: string | null): Promise<boolean> {
    if (!chatId || !enabled) return false;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const parameters = new URLSearchParams();
      if (next) parameters.set('before', next);
      if (selectedId) parameters.set('selected', selectedId);
      const data = await api<GenerationPage>(`/chats/${chatId}/generations${parameters.size ? `?${parameters}` : ''}`, 'GET', undefined, controller.signal);
      if (controller.signal.aborted || currentIdentity.current !== identity || datasetChanged()) return false;
      setPage({ chatId, cursor: next, key: identity, data });
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && currentIdentity.current === identity) setError(errorText(cause));
      return false;
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted && currentIdentity.current === identity) setLoading(false);
      }
    }
  }
  useEffect(() => {
    if (enabled) void load(cursor);
    else setLoading(false);
    return () => request.current?.abort();
  }, [identity]);
  const data = page?.chatId === chatId ? page.data : null;
  const hasPage = page?.chatId === chatId && page.cursor === cursor;
  const ready = hasPage && page.key === identity;
  async function move(direction: 'older' | 'newer' | 'latest'): Promise<boolean> {
    if (!chatId || request.current || !hasPage) return false;
    const next = direction === 'latest' ? null : direction === 'older' ? data?.nextBefore : cursors.length > 1 ? cursors[cursors.length - 2] : undefined;
    if (next === undefined || direction === 'older' && next === null) return false;
    if (!await load(next)) return false;
    setNavigation({ chatId, cursors: direction === 'latest' ? [null] : direction === 'older' ? [...cursors, next] : cursors.slice(0, -1) });
    return true;
  }
  return { items: data?.items ?? [], selected: data?.selected, missingSelected: ready && data?.selected === null, ready,
    older: Boolean(data?.nextBefore), newer: cursors.length > 1, loading, error, move, retry: () => setRetry(value => value + 1) };
}
