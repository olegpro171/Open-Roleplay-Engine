import { memo, type CSSProperties } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SpeechOptions } from './direct-speech';
import { remarkDirectSpeech } from './remark-direct-speech';
import { defaultSpeechColor, type ChatTextScale } from '../shared/appearance';

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

export const ChatMarkdown = memo(function ChatMarkdown({ text, speech = defaultSpeechOptions, speechColor = defaultSpeechColor, textScale = 100 }: { text: string; speech?: SpeechOptions; speechColor?: string; textScale?: ChatTextScale }) {
  const style: CSSProperties & { '--direct-speech-color': string } = { '--direct-speech-color': speechColor, fontSize: `${15 * textScale / 100}px` };
  return <div className="chat-markdown" style={style}><Markdown
    remarkPlugins={[remarkGfm, [remarkDirectSpeech, speech]]}
    components={components}
    urlTransform={safeUrl}
  >{text}</Markdown></div>;
});
