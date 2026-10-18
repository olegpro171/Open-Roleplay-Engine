import { quotedSpeechRanges, type SpeechRange } from './quoted-speech';
import { russianDialogueRanges } from './russian-dialogue';

export type SpeechOptions = { quotes?: boolean; russianDialogue?: boolean };

export function directSpeechRanges(text: string, options: SpeechOptions = {}): SpeechRange[] {
  const quotations = quotedSpeechRanges(text);
  const ranges = [
    ...(options.quotes === false ? [] : quotations),
    ...(options.russianDialogue === false ? [] : russianDialogueRanges(text, quotations)),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SpeechRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
