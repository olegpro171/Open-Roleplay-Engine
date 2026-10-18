import { memo } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SpeechOptions } from './direct-speech';
import { remarkDirectSpeech } from './remark-direct-speech';

// Russian detection can be disabled here independently of quotation styling.
const defaultSpeechOptions: SpeechOptions = { quotes: true, russianDialogue: true };

const components: Components = {
  a: ({ node: _node, href, children, ...props }) => href
    ? <a {...props} href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  // Model/card content must not initiate remote image requests as a side effect of reading a chat.
  img: ({ alt }) => <span className="markdown-image">[Image: {alt || 'image'}]</span>,
  table: ({ node: _node, ...props }) => <div className="markdown-table" tabIndex={0} role="region" aria-label="Table"><table {...props} /></div>,
};

function safeUrl(url: string): string {
  return /^(?:https?:|mailto:|#)/iu.test(url) ? defaultUrlTransform(url) : '';
}

export const ChatMarkdown = memo(function ChatMarkdown({ text, speech = defaultSpeechOptions }: { text: string; speech?: SpeechOptions }) {
  return <div className="chat-markdown"><Markdown
    remarkPlugins={[remarkGfm, [remarkDirectSpeech, speech]]}
    components={components}
    urlTransform={safeUrl}
  >{text}</Markdown></div>;
});
