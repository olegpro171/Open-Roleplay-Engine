import { useEffect, useRef, useState, type ReactNode } from 'react';
import { characterLabel } from '../shared/library';
import { useLocale } from './localization';

export function LibraryCard({ title, description, picture, tools, details, open, disabled, heading = 'h2' }: {
  title: { name: string; titleComment?: string };
  description: string;
  picture?: ReactNode;
  tools?: ReactNode;
  details?: ReactNode;
  open?: () => void;
  disabled?: boolean;
  heading?: 'h2' | 'h3';
}) {
  const Heading = heading;
  const label = <span className="library-card-title">{title.name}
    {title.titleComment && <span className="character-comment"> · {title.titleComment}</span>}
  </span>;
  return <article className="library-card">
    <div className="library-card-body">
      {picture}
      <div className="library-card-content">
        <div className="library-card-heading">
          <Heading title={characterLabel(title)}>
            {open ? <button type="button" className="library-card-open" disabled={disabled} onClick={open}>{label}</button> : label}
          </Heading>
          {tools && <div className="library-card-tools">{tools}</div>}
        </div>
        <LibraryDescription text={description}>{details}</LibraryDescription>
      </div>
    </div>
  </article>;
}

function LibraryDescription({ text, children }: { text: string; children?: ReactNode }) {
  useLocale();
  const node = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, children]);
  return <div ref={node} className={`library-card-description${overflow ? ' overflows' : ''}`}><p>{text}</p>{children}</div>;
}
