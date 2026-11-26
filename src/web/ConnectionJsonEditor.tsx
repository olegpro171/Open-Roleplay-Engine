import { history, historyKeymap, defaultKeymap, isolateHistory, temporarilySetTabFocusMode } from '@codemirror/commands';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import { customParameterError, JsonObjectParseError, type ConnectionParameterDraft } from './connection-parameter-draft';
import { formatJsonObject, jsonIndent } from './json-source';
import { formatMessage, t, useLocale } from './localization';

const externalChange = Annotation.define<boolean>();

export function ConnectionJsonEditor({ draft, disabled, onChange }: {
  draft: ConnectionParameterDraft; disabled: boolean; onChange: (value: string) => void;
}) {
  useLocale();
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  // CodeMirror measures offsets in logical lines with a single newline between them.
  const source = useMemo(() => draft.parameters.replace(/\r\n?/g, '\n'), [draft.parameters]);
  const initial = useRef(source);
  const change = useRef(onChange);
  change.current = onChange;
  const config = useMemo(() => new Compartment(), []);
  const error = useMemo(() => customParameterError({ ...draft, parameters: source }), [draft, source]);
  const blank = !source.trim();
  const canFormat = !disabled && !blank && !(error instanceof JsonObjectParseError);
  const label = t('libraries.custom_request_parameters');

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({ parent: host.current, doc: initial.current, extensions: [
      EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''),
      lineNumbers(), EditorView.lineWrapping, history(), config.of([]),
      keymap.of([{ key: 'Escape', run: temporarilySetTabFocusMode }, { key: 'Tab', run: view => {
        if (view.state.readOnly || view.composing) return false;
        view.dispatch(view.state.replaceSelection(jsonIndent), { scrollIntoView: true, annotations: isolateHistory.of('full') });
        return true;
      } }, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) {
          change.current(update.state.doc.toString());
        }
      }),
    ] });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [config]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    if (view.state.doc.toString() !== source) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, annotations: externalChange.of(true) });
    }
    const line = error && view.state.doc.lineAt(error.offset);
    view.dispatch({ effects: config.reconfigure([
      EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
      EditorView.contentAttributes.of({ 'aria-labelledby': id, 'aria-describedby': `${id}-status ${id}-help`,
        'aria-invalid': String(Boolean(error)), 'aria-multiline': 'true', spellcheck: 'false' }),
      EditorView.decorations.of(line ? Decoration.set([Decoration.line({ class: 'json-error-line' }).range(line.from)]) : Decoration.none),
    ]) });
  }, [config, disabled, source, error, id]);

  function jumpToError() {
    const view = editor.current;
    if (!view || !error) return;
    view.focus();
    view.dispatch({ selection: { anchor: error.offset }, effects: EditorView.scrollIntoView(error.offset, { y: 'center' }) });
  }
  function format() {
    const view = editor.current;
    if (!view || !canFormat) return;
    const formatted = formatJsonObject(source);
    if (formatted !== source) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted }, annotations: isolateHistory.of('full') });
    }
    view.focus();
  }
  let location: string | undefined;
  if (error) {
    const lines = source.slice(0, error.offset).split('\n');
    location = t('connection_json.location', {
      line: lines.length, column: Array.from(lines[lines.length - 1]).length + 1, error: formatMessage(error.localized),
    });
  }
  return <div className="connection-json">
    <div className="connection-json-heading"><span id={id} onClick={() => editor.current?.focus()}>{label}</span>
      <button type="button" className="quiet" disabled={!canFormat} onClick={format}>{t('connection_json.format')}</button>
    </div>
    <div className="connection-json-input" ref={host} />
    <div className="small" role="status" id={`${id}-status`}>
      {error ? <button type="button" className="text-link connection-json-error" onClick={jumpToError}>{location}</button>
        : <span className="muted">{t(blank ? 'connection_json.empty' : 'connection_json.valid')}</span>}
    </div>
    <small id={`${id}-help`} className="field-help muted">{t('connection_parameters.custom_help')}</small>
  </div>;
}
