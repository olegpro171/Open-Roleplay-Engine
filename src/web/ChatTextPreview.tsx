import type { Appearance } from '../shared/appearance';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatMessage } from './ChatMessage';
import { t, useLocale } from './localization';

export type ChatPreviewAppearance = Pick<Appearance, 'chatTextScale' | 'characterSpeechColor' | 'personaSpeechColor'>;

export function ChatTextPreview({ chatTextScale, characterSpeechColor, personaSpeechColor }: ChatPreviewAppearance) {
  useLocale();
  return <div className="chat-text-preview" role="region" aria-label={t('chat_appearance_settings.chat_text_preview')}>
    <ChatMessage role="user" speaker={t('app.you')}>
      <div className="prose">
        <ChatMarkdown text={t('chat_appearance_settings.preview_user_message')} textScale={chatTextScale}
          speechColor={personaSpeechColor ?? 'var(--speech-persona)'} />
      </div>
    </ChatMessage>
    <ChatMessage role="assistant" speaker={t('app.character')}>
      <div className="prose">
        <ChatMarkdown text={t('chat_appearance_settings.preview_assistant_message')} textScale={chatTextScale}
          speechColor={characterSpeechColor ?? 'var(--speech-character)'} />
      </div>
    </ChatMessage>
  </div>;
}
