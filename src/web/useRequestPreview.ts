import { useEffect, useRef, useState } from 'react';
import type { RequestEstimate, RequestPreview } from '../shared/contracts';
import { requestEstimate } from '../shared/contracts';
import type { StorySnapshot } from '../shared/transcript';
import { api, datasetChanged } from './api';
import { errorText, type MessageText } from './localization';

type Inspection = { chatId: string | null; key: string; estimate: RequestEstimate | null; request: RequestPreview | null; error: MessageText };

export function useRequestPreview(snapshot: StorySnapshot | null, draft: string, enabled: boolean, full: boolean) {
  const pending = snapshot?.latestTurn?.complete === false;
  // The next composer draft is not part of the pending turn's model input.
  const input = pending ? '' : draft;
  const [settled, setSettled] = useState('');
  const [retry, setRetry] = useState(0);
  const [inspection, setInspection] = useState<Inspection>({ chatId: null, key: '', estimate: null, request: null, error: '' });
  const cached = useRef(inspection);
  const key = JSON.stringify([snapshot?.id, snapshot?.revision, snapshot?.memory.revision, snapshot?.connection, input, retry]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(input), 1000);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    if (!full && cached.current.request) {
      const released = { ...cached.current, request: null };
      cached.current = released;
      setInspection(released);
    }
    if (!enabled || !snapshot?.connection || !pending && input !== settled) return;
    const previous = cached.current;
    if (previous.key === key && !previous.error && (!full || previous.request)) return;
    const controller = new AbortController();
    void api<RequestPreview | RequestEstimate>(`/chats/${snapshot.id}/preview`, 'POST', {
      revision: snapshot.revision, inspection: true, detail: full ? 'full' : 'estimate', ...(!pending ? { text: input } : {}),
    }, controller.signal).then(result => {
      if (controller.signal.aborted || datasetChanged()) return;
      const estimate = 'body' in result ? requestEstimate(result) : result;
      const next = { chatId: snapshot.id, key, estimate, request: 'body' in result ? result : null, error: '' };
      cached.current = next;
      setInspection(next);
    }).catch(error => {
      if (controller.signal.aborted || datasetChanged()) return;
      const retained = cached.current.chatId === snapshot.id ? cached.current : null;
      const next = { chatId: snapshot.id, key, estimate: retained?.estimate ?? null, request: retained?.request ?? null, error: errorText(error) };
      cached.current = next;
      setInspection(next);
    });
    return () => controller.abort();
  }, [key, settled, enabled, full]);
  const matching = inspection.chatId === snapshot?.id;
  return {
    estimate: matching ? inspection.estimate : null,
    request: matching ? inspection.request : null,
    current: inspection.key === key && !inspection.error && (!full || Boolean(inspection.request)),
    error: inspection.key === key ? inspection.error : '',
    retry: () => setRetry(value => value + 1),
  };
}
