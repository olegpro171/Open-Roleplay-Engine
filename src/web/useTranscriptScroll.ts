import { useLayoutEffect, useRef, useState } from 'react';

type Anchor = { turnId: string; progress: number };

// Keep the visible turn and the reading position within it stable as text reflows.
export function useTranscriptScroll(chatId: string | null, content: unknown) {
  const transcript = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | null>(null);
  const following = useRef(true);
  const previousChat = useRef<string | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);

  function scrollToLatest() {
    following.current = true;
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
    setAwayFromLatest(false);
  }

  useLayoutEffect(() => {
    const node = transcript.current;
    if (!node || !chatId) return;
    if (previousChat.current !== chatId) {
      previousChat.current = chatId;
      anchor.current = null;
      following.current = true;
    }
    let width = node.clientWidth, height = node.clientHeight;
    const turns = () => Array.from(node.querySelectorAll<HTMLElement>('[data-turn-id]'));
    const capture = () => {
      const top = node.getBoundingClientRect().top;
      const turn = turns().find(turn => turn.getBoundingClientRect().bottom > top);
      if (turn) {
        const rect = turn.getBoundingClientRect();
        anchor.current = { turnId: turn.dataset.turnId!, progress: (top - rect.top) / rect.height };
      }
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      setAwayFromLatest(!following.current);
    };
    const restore = () => {
      width = node.clientWidth; height = node.clientHeight;
      if (following.current) node.scrollTop = node.scrollHeight;
      else if (anchor.current) {
        const turn = turns().find(turn => turn.dataset.turnId === anchor.current!.turnId);
        if (turn) {
          const rect = turn.getBoundingClientRect();
          node.scrollTop += rect.top - node.getBoundingClientRect().top + rect.height * anchor.current.progress;
        }
      }
      setAwayFromLatest(node.scrollHeight - node.scrollTop - node.clientHeight >= 80);
    };
    const onScroll = () => {
      // A resize can dispatch a scroll event before ResizeObserver runs.
      if (width !== node.clientWidth || height !== node.clientHeight) restore();
      else capture();
    };
    restore();
    capture();
    const observer = new ResizeObserver(restore);
    observer.observe(node);
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); node.removeEventListener('scroll', onScroll); };
  }, [chatId]);

  useLayoutEffect(() => {
    if (following.current) scrollToLatest();
  }, [content, chatId]);

  return { transcript, awayFromLatest, scrollToLatest };
}
