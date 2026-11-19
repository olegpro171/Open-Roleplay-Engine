import { Component, type ReactNode } from 'react';
import type { StorySnapshot } from '../shared/transcript';

type Props = {
  snapshot: StorySnapshot;
  captureScroll: () => void;
  restoreScroll: () => void;
  children: ReactNode;
};

export class TranscriptFrame extends Component<Props, object, boolean> {
  getSnapshotBeforeUpdate(previous: Props) {
    const changed = previous.snapshot !== this.props.snapshot;
    // WebKit can clamp the scroller during an intermediate layout while React
    // replaces turn content. Sample the position before those DOM mutations.
    if (changed) this.props.captureScroll();
    return changed;
  }

  componentDidUpdate(_previous: Props, _state: object, changed: boolean) {
    if (changed) this.props.restoreScroll();
  }

  render() {
    return <div className="transcript-frame">{this.props.children}</div>;
  }
}
