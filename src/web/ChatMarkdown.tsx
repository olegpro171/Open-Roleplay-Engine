import { t, useLocale } from './localization';
import { memo, useState, type CSSProperties } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SpeechOptions } from './direct-speech';
import { remarkDirectSpeech } from './remark-direct-speech';
import type { ChatTextScale } from '../shared/appearance';

// Russian detection can be disabled here independently of quotation styling.
const defaultSpeechOptions: SpeechOptions = { quotes: true, russianDialogue: true };

function InlineImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  useLocale();
  if (!src || failed) return <span className="markdown-image">{t('chat_markdown.image', { value: alt || t('interface.image') })}</span>;
  return <img className="chat-inline-image" src={src} alt={alt ?? ''} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

const components: Components = {
  a: ({ node: _node, href, children, ...props }) => href
    ? <a {...props} href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt, title }) => <InlineImage key={src} src={src} alt={alt} title={title} />,
  table: ({ node: _node, ...props }) => <div className="markdown-table" tabIndex={0} role="region" aria-label={t("chat_markdown.table")}><table {...props} /></div>,
};

function safeUrl(url: string, key: string): string {
  if (key === 'src') return /^https?:\/\//iu.test(url) ? defaultUrlTransform(url) : '';
  return /^(?:https?:|mailto:|#)/iu.test(url) ? defaultUrlTransform(url) : '';
}

export const ChatMarkdown = memo(function ChatMarkdown({ text, speech = defaultSpeechOptions, speechColor = 'var(--speech-character)', textScale = 100 }: { text: string; speech?: SpeechOptions; speechColor?: string; textScale?: ChatTextScale }) {
  useLocale();
  const style: CSSProperties & { '--direct-speech-color': string } = { '--direct-speech-color': speechColor, fontSize: `${15 * textScale / 100}px` };
  return <div className="chat-markdown" style={style}><Markdown
    remarkPlugins={[remarkGfm, [remarkDirectSpeech, speech]]}
    components={components}
    urlTransform={safeUrl}
  >{text}</Markdown></div>;
});
