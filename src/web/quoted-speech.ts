export type SpeechRange = { start: number; end: number };

const closingQuote = new Map([
  ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»'], ['„', '“'],
]);
const wordCharacter = /[\p{L}\p{N}]/u;

/** Balanced quotation only; an unfinished streamed quotation stays ordinary text. */
export function quotedSpeechRanges(text: string): SpeechRange[] {
  const ranges: SpeechRange[] = [];
  const stack: { start: number; close: string }[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\0') {
      stack.length = 0;
      continue;
    }
    // Apostrophes in contractions, possessives and names are not quotation marks.
    if ((character === "'" || character === '’') && wordCharacter.test(text[index - 1] ?? '') && wordCharacter.test(text[index + 1] ?? '')) continue;
    const open = stack.at(-1);
    if (open?.close === character) {
      stack.pop();
      if (stack.length === 0 && index > open.start + 1) ranges.push({ start: open.start, end: index + 1 });
      continue;
    }
    const close = closingQuote.get(character);
    if (!close) continue;
    if ((character === "'" || character === '‘' || character === '"') && wordCharacter.test(text[index - 1] ?? '')) continue;
    stack.push({ start: index, close });
  }
  return ranges;
}
