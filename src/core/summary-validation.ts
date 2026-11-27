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

function isRussianRefusal(text: string): boolean {
  const opening = text
    .replace(/^(?:(?:извините|извини|простите|прости|прошу\s+прощения|мне\s+жаль|сожалею|к\s+сожалению|увы)[,.!:…—\s]+(?:но\s+)?){1,2}/iu, '')
    .replace(/^как\s+(?:ии|языковая\s+модель|модель\s+ии|искусственный\s+интеллект)\s*,\s*/iu, '');
  const inability = /^(?:я\s+)?(?:не\s+(?:могу|смогу|вправе)|не\s+в\s+состоянии|не\s+имею\s+возможности|отказываюсь)\s+/iu.exec(opening);
  if (!inability) {
    return /^(?:я\s+)?(?:вынужден[аы]?|должен|должна)\s+отказаться\s+от\s+(?:выполнения\s+)?(?:(?:этого|данного|вашего)\s+)?(?:запроса|задания)(?![\p{L}\p{M}\p{N}_])/iu.test(opening)
      || /^(?:(?:этот|данный|ваш)\s+)?запрос\s+(?:нарушает|противоречит|не\s+соответствует)\s+(?:(?:нашим|наши)\s+)?(?:правилам?|политик[еу]|условиям?)(?:\s+(?:использования|безопасности|платформы|сервиса|модерации|контента)(?![\p{L}\p{M}\p{N}_])|(?=\s*(?:[.!?…]|$)))/iu.test(opening);
  }

  const action = opening.slice(inability[0].length);
  const refusalEnding = /^\s*(?:[.!?…]|$|,\s*(?:поскольку|так\s+как|потому\s+что|но\s+(?:я\s+)?могу)\s)/iu;
  const help = /^помочь(?:\s+(?:вам|тебе))?(\s+с\s+этим)?/iu.exec(action);
  if (help && (help[1] || opening !== text) && refusalEnding.test(action.slice(help[0].length))) return true;

  const summary = /^(?:сделать|составить|подготовить|предоставить|написать|создать|сгенерировать|дать)\s+(?:запрошенн(?:ую|ое|ый)\s+)?(?:(?:краткую\s+)?(?:сводку|выжимку)|краткое\s+(?:изложение|содержание)|(?:краткий\s+)?пересказ|(?:краткое\s+)?резюме)(?![\p{L}\p{M}\p{N}_])/iu.exec(action);
  if (summary) {
    // A qualifier must refer to source text. This preserves phrases like «резюме для новой должности».
    const tail = action.slice(summary[0].length);
    return refusalEnding.test(tail)
      || /^\s+(?:по\s+(?:(?:этому|данному|предоставленному)\s+)?(?:тексту|материалу|контенту|отрывку|фрагменту|запросу)|(?:(?:для\s+)?(?:этого|данного|предоставленного)\s+)?(?:текста|материала|контента|отрывка|фрагмента|запроса))(?![\p{L}\p{M}\p{N}_])/iu.test(tail);
  }

  return /^помочь\s+(?:(?:вам|тебе)\s+)?с\s+(?:этим|данным|таким|вашим)\s+(?:запросом|заданием|вопросом|текстом|материалом|контентом)(?![\p{L}\p{M}\p{N}_])/iu.test(action)
    || /^(?:выполнить|выполнять|обработать|исполнить|удовлетворить|ответить\s+на)\s+(?:(?:(?:этот|данный|такой|ваш)\s+)?запрос|(?:это|данное|ваше)\s+задание|(?:эту|вашу)\s+просьбу)(?![\p{L}\p{M}\p{N}_])/iu.test(action)
    || /^продолжить\s+(?:(?:выполнение|обработку)\s+(?:этого|данного|вашего)\s+(?:запроса|задания)|(?:работу\s+)?с\s+(?:этим|данным)\s+(?:запросом|текстом|материалом))(?![\p{L}\p{M}\p{N}_])/iu.test(action)
    || /^(?:суммировать|резюмировать|обобщить|пересказать|кратко\s+изложить)\s+(?:содержание\s+)?(?:(?:этот|этого|данный|данного|предоставленный|предоставленного|такой|ваш|вашего|эту|этой)\s+)?(?:текста?|материала?|контента?|отрыв(?:ок|ка)|фрагмента?|истори[ию])(?![\p{L}\p{M}\p{N}_])/iu.test(action);
}

function isRefusal(text: string): boolean {
  // Match model-directed refusals at the start, not phrases quoted inside a story.
  const opening = text.replace(/^(?:(?:i(?:'|’)?m sorry|i am sorry|sorry|i apologize|unfortunately)[,.!:\s]*(?:but\s+)?)/iu, '');
  return /^(?:as an? (?:ai|language model)\b|i(?:\s+(?:cannot|can not|can(?:'|’)t|won(?:'|’)t|will not|am unable to|must (?:decline|refuse))|['’]m unable to)\s+(?:(?:assist|help)(?: you)? (?:with (?:(?:this|that)\b|the (?:request|content|material))|(?:to )?(?:summari[sz]e|process|fulfil|fulfill))|(?:provide|generate|create|write)\s+(?:(?:a|the|this|that)\s+)?(?:summary|response|content)|(?:continue with (?:this|that|the) (?:task|request)|summari[sz]e|comply|fulfil|fulfill|process this request))\b|(?:this|that|your) request (?:violates|goes against)\b)/iu.test(opening)
    || isRussianRefusal(text);
}

/** Increment only when saved-text refusal detection changes. */
export const summaryRefusalFilterVersion = 2;
export function containsSummaryRefusal(text: string): boolean {
  return isRefusal(comparable(text));
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
