import { useId, useState, type ReactNode } from 'react';

export function ChatWorkspace({ sidebar, actions, children }: { sidebar: ReactNode; actions: ReactNode; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <main className="story-layout">
    <aside className="story-meta" aria-label="Current chat">
      <button className="quiet chat-details-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>Chat details <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
      <div id={detailsId} className={`chat-details${expanded ? ' expanded' : ''}`}>{sidebar}</div>
      <div className="chat-page-actions">{actions}</div>
    </aside>
    {children}
  </main>;
}
