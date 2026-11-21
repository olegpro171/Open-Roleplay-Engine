import type { ReactNode } from 'react';

export function ChatMessage({ role, speaker, children }: {
  role: 'user' | 'assistant';
  speaker: string;
  children: ReactNode;
}) {
  return <div className={`part ${role}`}>
    <div className="part-heading"><strong>{speaker}</strong></div>
    {children}
  </div>;
}
