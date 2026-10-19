import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const EditorActionsTarget = createContext<HTMLDivElement | null>(null);

/** Editors retain their state and handlers while their controls live in the sidebar. */
export function EditorActions({ children }: { children: ReactNode }) {
  const target = useContext(EditorActionsTarget);
  return target ? createPortal(<div className="library-editor-actions" role="group" aria-label="Editor actions">{children}</div>, target) : null;
}
