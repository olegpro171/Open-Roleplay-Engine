import { t, useLocale } from './localization';
import type { ReactNode } from 'react';

export function EditorActions({ children }: { children: ReactNode }) {
  useLocale();
  return <div className="library-editor-actions" role="group" aria-label={t("editor_actions.editor_actions")}>{children}</div>;
}
