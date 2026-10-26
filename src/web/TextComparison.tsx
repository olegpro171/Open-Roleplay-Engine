import { useTheme } from './theme';
import { t, useLocale } from './localization';
import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { MergeView, goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge';

function proseTheme(dark: boolean) { return EditorView.theme({
  '&': { backgroundColor: 'var(--input-bg)', color: 'var(--text)', fontSize: '14px' },
  '.cm-content': { padding: '16px 12px', minHeight: '180px', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', lineHeight: '1.7', overflowWrap: 'anywhere' },
  '.cm-scroller': { fontFamily: 'inherit', overflowX: 'hidden' },
  '.cm-cursor': { borderLeftColor: 'var(--header-highlight)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--text-selection)' },
  '.cm-gutters': { backgroundColor: 'var(--input-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-changedLine': { backgroundColor: 'transparent' },
  // Override the merge extension's colored gradients and gutters as well as its
  // text fills, so library defaults cannot supply a separate status palette.
  '&.cm-merge-a .cm-changedText, .cm-deletedText': { backgroundColor: 'var(--diff-remove-bg)', backgroundImage: 'none', textDecoration: 'underline', textDecorationColor: 'var(--diff-remove-text)' },
  '&.cm-merge-b .cm-changedText, .cm-insertedText': { backgroundColor: 'var(--diff-add-bg)', backgroundImage: 'none', textDecoration: 'underline', textDecorationColor: 'var(--diff-add-text)' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { backgroundColor: 'var(--danger)' },
  '&.cm-merge-b .cm-changedLineGutter': { backgroundColor: 'var(--success)' },
  '.cm-inlineChangedLineGutter': { backgroundColor: 'var(--input-prompt)' },
}, { dark }); }
const darkProseTheme = proseTheme(true);
const proseThemes = { dark: darkProseTheme, light: proseTheme(false), 'midnight-black': darkProseTheme };
const nonce = () => EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '');

/** Plain text only: both panes use the same editor, typography and wrapping. */
export function TextComparison({ original, value, onChange, disabled = false, originalLabel = t("text_comparison.previous_summary"), modifiedLabel = t("text_comparison.proposed_summary") }: {
  original: string; value: string; onChange?: (value: string) => void; disabled?: boolean; originalLabel?: string; modifiedLabel?: string;
}) {
  useLocale();
  const theme = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const editors = useRef<{ modified: EditorView; merge?: MergeView; editable: Compartment; comparison: Compartment; palette: Compartment } | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const initial = useRef(value); initial.current = value;
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [collapse, setCollapse] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const editable = new Compartment(), comparison = new Compartment(), palette = new Compartment();
    const extensions = [nonce(), palette.of(proseThemes[theme]), EditorView.lineWrapping, history(), keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorState.transactionFilter.of(transaction => transaction.newDoc.length > 1_000_000 ? [] : transaction),
      editable.of([EditorState.readOnly.of(disabled || !change.current), EditorView.editable.of(!disabled && Boolean(change.current))]),
      EditorView.contentAttributes.of({ 'aria-label': modifiedLabel }),
      EditorView.updateListener.of(update => { if (update.docChanged) change.current?.(update.state.doc.toString()); })];
    const diffConfig = { scanLimit: 2_000, timeout: 100 };
    const collapseUnchanged = collapse ? { margin: 2, minSize: 4 } : undefined;
    if (compact) {
      const modified = new EditorView({ parent: container.current!, doc: initial.current, extensions: [...extensions,
        comparison.of(unifiedMergeView({ original, mergeControls: false, highlightChanges: true, syntaxHighlightDeletions: false, diffConfig, collapseUnchanged }))] });
      editors.current = { modified, editable, comparison, palette };
    } else {
      const merge = new MergeView({ parent: container.current!,
        a: { doc: original, extensions: [nonce(), palette.of(proseThemes[theme]), EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': originalLabel })] },
        b: { doc: initial.current, extensions }, highlightChanges: true, gutter: true, diffConfig, collapseUnchanged });
      editors.current = { modified: merge.b, merge, editable, comparison, palette };
    }
    return () => { const view = editors.current; if (view?.merge) view.merge.destroy(); else view?.modified.destroy(); editors.current = null; };
  }, [original, compact, originalLabel, modifiedLabel]);
  useEffect(() => {
    const view = editors.current;
    if (!view) return;
    const effects = view.palette.reconfigure(proseThemes[theme]);
    view.modified.dispatch({ effects });
    view.merge?.a.dispatch({ effects });
  }, [theme]);
  useEffect(() => {
    const view = editors.current;
    const collapseUnchanged = collapse ? { margin: 2, minSize: 4 } : undefined;
    if (view?.merge) view.merge.reconfigure({ collapseUnchanged });
    else if (view) view.modified.dispatch({ effects: view.comparison.reconfigure(unifiedMergeView({ original, mergeControls: false, highlightChanges: true, syntaxHighlightDeletions: false, diffConfig: { scanLimit: 2_000, timeout: 100 }, collapseUnchanged })) });
  }, [collapse]);
  useEffect(() => {
    const view = editors.current;
    if (!view) return;
    view.modified.dispatch({ effects: view.editable.reconfigure([EditorState.readOnly.of(disabled || !onChange), EditorView.editable.of(!disabled && Boolean(onChange))]) });
  }, [disabled, Boolean(onChange)]);
  useEffect(() => {
    const view = editors.current?.modified;
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  function navigate(forward: boolean) {
    const view = editors.current?.modified;
    if (view) { (forward ? goToNextChunk : goToPreviousChunk)(view); view.focus(); }
  }
  return <div className={`text-comparison${compact ? ' comparison-unified' : ''}`}>
    <div className="comparison-toolbar"><div className="actions"><button type="button" className="quiet" onClick={() => navigate(false)}>{t("text_comparison.previous_difference")}</button><button type="button" className="quiet" onClick={() => navigate(true)}>{t("text_comparison.next_difference")}</button></div><label className="checkbox"><input type="checkbox" checked={collapse} onChange={e => setCollapse(e.target.checked)} />{t("text_comparison.collapse_unchanged")}</label></div>
    <div className="comparison-labels">{compact ? <span>{t("text_comparison.removals_above_additions", { modifiedLabel: modifiedLabel })}</span> : <><span>{originalLabel}</span><span>{modifiedLabel}</span></>}</div>
    <div className="comparison-editors" ref={container} />
    <p className="comparison-legend"><span>{t("text_comparison.removed_text")}</span><span>{t("text_comparison.added_text")}</span>{original === value && <span>{t("text_comparison.no_text_differences")}</span>}</p>
  </div>;
}
