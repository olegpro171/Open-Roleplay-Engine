import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { t, useLocale } from './localization';
import { Icon } from './Icon';

export const EditorActionsTarget = createContext<HTMLDivElement | null>(null);

export function EditorActions({ formId, disabled, close, cancelDisabled = false }: {
  formId: string;
  disabled: boolean;
  close: () => void;
  cancelDisabled?: boolean;
}) {
  useLocale();
  const target = useContext(EditorActionsTarget);
  if (!target) return null;
  return createPortal(<div className="library-editor-actions" role="group" aria-label={t("editor_actions.editor_actions")}>
    <button type="submit" form={formId} disabled={disabled} title={t("editor_actions.save")} aria-label={t("editor_actions.save")}>
      <Icon name="SaveOutline" /><span>{t("editor_actions.save")}</span>
    </button>
    <button type="button" className="secondary" disabled={cancelDisabled} onClick={close} title={t("character_import.cancel")} aria-label={t("character_import.cancel")}>
      <Icon name="Close" /><span>{t("character_import.cancel")}</span>
    </button>
  </div>, target);
}
