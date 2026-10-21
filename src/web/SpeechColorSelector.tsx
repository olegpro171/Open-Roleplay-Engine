import { defaultSpeechColor } from '../shared/appearance';

export function SpeechColorSelector({ value, change }: { value?: string | null; change: (value: string | null) => void }) {
  return <div className="full speech-color-selector" role="group" aria-label="Speech color selection">
    <span className="speech-color-label">Speech color</span>
    <div className="speech-color-controls">
      {value ? <>
        <input type="color" aria-label="Speech color" value={value} onChange={event => change(event.target.value)} />
        <button type="button" className="secondary" onClick={() => change(null)}>Clear color</button>
      </> : <>
        <span>Not set</span>
        <button type="button" className="secondary" onClick={() => change(defaultSpeechColor)}>Set color</button>
      </>}
    </div>
    <small className="muted">Not set uses the default from Chat appearance settings.</small>
  </div>;
}
