import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ScrollFollow } from './scroll-follow';

type Anchor = { turnId: string; offset: number; progress: number; width: number };

// Keep the visible turn and the reading position within it stable as text reflows.
export function useTranscriptScroll(chatId: string | null, content: unknown, editing: boolean) {
  const transcript = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | null>(null);
  const follow = useRef(new ScrollFollow()).current;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const previousChat = useRef<string | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const captureRef = useRef<(forceAnchor?: boolean) => void>(() => {});
  const restoreRef = useRef<(trackMovement?: boolean) => void>(() => {});
  function captureScroll() { captureRef.current(false); }
  function restoreScroll() { restoreRef.current(false); }
  function preservePosition(holdAnchor = false) {
    captureRef.current();
    if (holdAnchor) follow.following = false;
  }
  function followingLatest() { return follow.following; }

  function scrollToLatest() {
    follow.following = true;
    const node = transcript.current;
    if (node) follow.scrollToEnd(node);
    setAwayFromLatest(false);
  }

  useLayoutEffect(() => {
    const node = transcript.current;
    const frame = node?.parentElement;
    const conversation = frame?.parentElement;
    if (!node || !frame || !conversation || !chatId) return;
    if (previousChat.current !== chatId) {
      previousChat.current = chatId;
      anchor.current = null;
      follow.following = true;
    }
    follow.rememberPosition(node);
    let width = node.clientWidth;
    let height = node.clientHeight;
    let footerHeight: number | undefined;
    const syncFooterHeight = () => {
      // Measure the space reserved by the composer and its notices. Extend the
      // scrollport and its bottom padding together so the reading area stays clear.
      const nextHeight = Math.max(0, conversation.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom);
      if (nextHeight !== footerHeight) {
        footerHeight = nextHeight;
        frame.style.setProperty('--composer-stack-height', `${nextHeight}px`);
      }
    };
    const turns = () => Array.from(node.querySelectorAll<HTMLElement>('[data-turn-id]'));
    const updateLatestButton = () => {
      // Keep the floating action clear of the turn controls near the bottom.
      setAwayFromLatest(node.scrollHeight - node.scrollTop - node.clientHeight >= 80);
    };
    const captureAnchor = () => {
      const top = node.getBoundingClientRect().top;
      const turn = turns().find(turn => turn.getBoundingClientRect().bottom > top);
      const turnId = turn?.dataset.turnId;
      if (turn && turnId) {
        const rect = turn.getBoundingClientRect();
        const offset = top - rect.top;
        anchor.current = { turnId, offset, progress: offset / rect.height, width: node.clientWidth };
      }
    };
    const capture = (forceAnchor = true) => {
      if (editingRef.current) return;
      if (follow.readMovement(node) || forceAnchor) captureAnchor();
    };
    const restore = (trackMovement = true) => {
      syncFooterHeight();
      width = node.clientWidth;
      height = node.clientHeight;
      // An expanding editor and its caret own the reading position until it
      // closes. Following the latest turn would hide the beginning of the edit.
      if (editingRef.current) {
        follow.rememberPosition(node);
        return;
      }
      if (trackMovement) capture(false);
      if (follow.following) follow.scrollToEnd(node);
      else if (anchor.current) {
        const savedAnchor = anchor.current;
        const turn = turns().find(turn => turn.dataset.turnId === savedAnchor.turnId);
        if (turn) {
          const rect = turn.getBoundingClientRect();
          const widthChanged = savedAnchor.width !== width;
          // Appending text can grow this same turn. Scaling the offset in that
          // case would move the reader down even with follow paused.
          const offset = widthChanged || savedAnchor.offset >= rect.height
            ? rect.height * savedAnchor.progress : savedAnchor.offset;
          const adjustment = rect.top - node.getBoundingClientRect().top + offset;
          if (adjustment !== 0) {
            node.scrollTop += adjustment;
            follow.rememberPosition(node);
          }
          if (widthChanged) captureAnchor();
        }
      }
      if (!trackMovement && !follow.following) follow.rememberPosition(node);
      updateLatestButton();
    };
    const onScroll = () => {
      // A resize can dispatch a scroll event before ResizeObserver runs.
      if (editingRef.current) {
        follow.rememberPosition(node);
        updateLatestButton();
      } else if (width !== node.clientWidth || height !== node.clientHeight) restore();
      else if (follow.readMovement(node)) {
        captureAnchor();
        updateLatestButton();
      }
    };
    captureRef.current = capture;
    restoreRef.current = restore;
    restore();
    capture();
    const observer = new ResizeObserver(() => restore());
    observer.observe(node);
    observer.observe(frame);
    observer.observe(conversation);
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
      captureRef.current = () => {};
      restoreRef.current = () => {};
    };
  }, [chatId, follow]);

  const jumpToTurn = useCallback((turnId: string) => {
    const node = transcript.current;
    if (!node?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`)) return;
    // Align through the same transcript-only scroll path as anchor restoration.
    // scrollIntoView can also scroll the overflow-hidden document in WebKit.
    follow.following = false;
    anchor.current = { turnId, offset: 0, progress: 0, width: node.clientWidth };
    restoreRef.current(false);
    // Near the end the scroller can clamp the requested alignment.
    captureRef.current();
  }, [follow]);

  useLayoutEffect(() => {
    // Closing an inline editor can reposition the scroller as its controls
    // disappear. Resume the reading position held before the edit.
    if (!editing) restoreRef.current(false);
  }, [editing]);
  useLayoutEffect(() => {
    const node = transcript.current;
    if (!node || !chatId) return;
    // Lazy images can change a turn's height after its Markdown has rendered.
    // Observe only the bounded mounted window, including newly loaded pages.
    const observer = new ResizeObserver(() => restoreRef.current());
    node.querySelectorAll<HTMLElement>('[data-turn-id]').forEach(turn => observer.observe(turn));
    return () => observer.disconnect();
  }, [content, chatId]);
  return { transcript, awayFromLatest, scrollToLatest, preservePosition, followingLatest, jumpToTurn, captureScroll, restoreScroll };
}
