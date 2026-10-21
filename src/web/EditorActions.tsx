import { t, useLocale } from './localization';
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const EditorActionsTarget = createContext<HTMLDivElement | null>(null);

/** Editors retain their state and handlers while their controls live in the sidebar. */
export function EditorActions({ children }: { children: ReactNode }) {
  useLocale();
  const target = useContext(EditorActionsTarget);
  return target ? createPortal(<div className="library-editor-actions" role="group" aria-label={t("editor_actions.editor_actions")}>{children}</div>, target) : null;
}
