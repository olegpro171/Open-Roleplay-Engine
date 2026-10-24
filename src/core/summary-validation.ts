export type SummaryRejectionCode = 'incomplete_summary' | 'empty_summary' | 'placeholder_summary' | 'refused_summary' | 'repetitive_summary';

export type SummaryValidation =
  | { accepted: true; text: string }
  | { accepted: false; code: SummaryRejectionCode; message: string };

function comparable(text: string): string {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').trim();
}

function isPlaceholder(text: string): boolean {
  // Inspect common wrappers without changing an accepted summary's formatting.
  const value = text.replace(/^```(?:text|markdown)?\s*\n([\s\S]*?)\n```$/iu, '$1')
    .replace(/^<summary>\s*([\s\S]*?)\s*<\/summary>$/iu, '$1')
    .replace(/^(?:here (?:is|is your|is the) (?:the |your )?summary|summary)\s*:\s*/iu, '')
    .replace(/^[\s\[\]{}<>"'`*_]+|[\s\[\]{}<>"'`*_.!]+$/gu, '').trim();
  return !value || /^(?:(?:this is (?:a |the )?)?placeholder(?: (?:text|summary|response))?|(?:insert|enter|add|put) (?:the |a |your )?(?:summary|text|content)(?: here)?|(?:summary|text|content) (?:goes here|here)|summary|todo|tbd|n\/?a|none|null|undefined|lorem ipsum(?:[\s\S]*)?)$/iu.test(value);
}

function isRefusal(text: string): boolean {
  // Match model-directed refusals at the start, not phrases quoted inside a story.
  const opening = text.replace(/^(?:(?:i(?:'|’)?m sorry|i am sorry|sorry|i apologize|unfortunately)[,.!:\s]*(?:but\s+)?)/iu, '');
  return /^(?:as an? (?:ai|language model)\b|i(?:\s+(?:cannot|can not|can(?:'|’)t|won(?:'|’)t|will not|am unable to|must (?:decline|refuse))|['’]m unable to)\s+(?:(?:assist|help)(?: you)? (?:with (?:(?:this|that)\b|the (?:request|content|material))|(?:to )?(?:summari[sz]e|process|fulfil|fulfill))|(?:provide|generate|create|write)\s+(?:(?:a|the|this|that)\s+)?(?:summary|response|content)|(?:continue with (?:this|that|the) (?:task|request)|summari[sz]e|comply|fulfil|fulfill|process this request))\b|(?:this|that|your) request (?:violates|goes against)\b)/iu.test(opening)
    || /^(?:извините[,!\s]*(?:но\s+)?)?я не могу (?:помочь с (?:этим|данным) запросом|выполнить (?:этот|данный) запрос|(?:суммировать|резюмировать|обобщить) (?:этот|данный) (?:текст|материал))/iu.test(text);
}

function isRepetitionLoop(text: string): boolean {
  const words = text.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
  // Six or more repetitions covering the entire response are a strong loop signal.
  // Do not reject short, sparse summaries merely for their length.
  for (let width = 1; width <= Math.min(24, Math.floor(words.length / 6)); width++) {
    if (words.every((word, index) => word === words[index % width])) return true;
  }
  return false;
}

/** Heuristics detect obvious bad output, not factual accuracy or faithful recall. */
export function validateSummary(text: string, finishReason: string): SummaryValidation {
  if (finishReason !== 'stop') return { accepted: false, code: 'incomplete_summary', message: 'The summary did not finish normally. Its source context must remain selected.' };
  const inspected = comparable(text);
  if (!/[\p{L}\p{N}]/u.test(inspected)) return { accepted: false, code: 'empty_summary', message: 'The summarizer returned no usable text.' };
  if (isPlaceholder(inspected)) return { accepted: false, code: 'placeholder_summary', message: 'The summarizer returned placeholder text instead of a summary.' };
  if (isRefusal(inspected)) return { accepted: false, code: 'refused_summary', message: 'The summarizer appears to have refused the request.' };
  if (isRepetitionLoop(inspected)) return { accepted: false, code: 'repetitive_summary', message: 'The summarizer appears to be stuck repeating the same text.' };
  return { accepted: true, text: text.trim() };
}
