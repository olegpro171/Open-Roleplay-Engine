import type { SpeechRange } from './quoted-speech';

// Punctuation identifies complete interruptions; vocabulary supports incomplete/ambiguous ones.
const authorVerbs = [
  /^(?:показал|указал)[аои]?$/iu,
  /^(?:сказал|говорил|ответил|спросил|проговорил|промолвил|воскликнул|прошептал|шепнул|крикнул|выкрикнул)[аои]?$/iu,
  /^произн[её]с(?:л[аои])?$/iu,
  /^(?:добавил|продолжил|заметил|уточнил|повторил|перебил|соврал|солгал|подумал)[аои]?$/iu,
  /^(?:возмутил|усмехнул|улыбнул|нахмурил)(?:ся|ась|ось|ись)$/iu,
  /^(?:вздохнул|замолчал|помолчал|кивнул|пожал|покачал|посмотрел|взглянул)[аои]?$/iu,
  /^(?:передразнил|вскрикнул|буркнул|бурчал|пробурчал|ворчал|проворчал|бормотал|пробормотал|твердил)[аои]?$/iu,
  /^(?:прошипел|процедил|выпалил|рявкнул|прорычал|протянул|выдохнул|пискнул|пролепетал|отрезал)[аои]?$/iu,
  /^(?:возразил|предупредил|напомнил|пояснил|объяснил|заявил)[аои]?$/iu,
  /^(?:прокричал|закричал|заорал|завопил|взвизгнул|взвыл|промямлил|пробубнил|просипел|прохрипел|пропищал)[аои]?$/iu,
  /^(?:ахнул|охнул|хмыкнул|фыркнул|всхлипнул|хихикнул|хохотнул)[аои]?$/iu,
  /^(?:переспросил|попросил|потребовал|подтвердил|протестовал|запротестовал|пообещал|съязвил|парировал|заверил)[аои]?$/iu,
  /^(?:рассмеял|засмеял|поинтересовал|осведомил|согласил|признал|взмолил)(?:ся|ась|ось|ись)$/iu,
  // First/third-person present forms avoid treating spoken imperatives such as «говорите» as narration.
  /^(?:отвеча|спрашива|переспрашива|добавля|продолжа|восклица|вскрикива|требу|возража|протесту|всхлипыва|хихика)(?:ю|ем|ет|ют)$/iu,
  /^говор(?:ю|им|ит|ят)$/iu,
  /^(?:твержу|тверд(?:им|ит|ят))$/iu,
  /^шеп(?:чу|чем|чет|чут)$/iu,
  /^крич(?:у|им|ит|ат)$/iu,
  /^бормоч(?:у|ем|ет|ут)$/iu,
  /^(?:прошу|прос(?:им|ит|ят))$/iu,
  /^(?:усмеха|улыба|соглаша)(?:юсь|емся|ется|ются)$/iu,
  /^(?:призна|сме)(?:юсь|[её]мся|[её]тся|ются)$/iu,
];
const thirdPersonSubjects = new Set(['он', 'она', 'оно', 'они']);
const thirdPersonPossessives = new Set(['его', 'ее', 'её', 'их']);
const bodySubjects = new Set(['голос', 'щеки', 'лицо', 'глаза', 'взгляд', 'рука', 'руки', 'пальцы', 'губы', 'уши', 'ухо', 'хвост', 'плечи', 'дыхание', 'сердце']);
const speechParticipants = new Set(['я', 'мы', 'ты', 'вы', 'меня', 'мне', 'мной', 'нас', 'нам', 'нами', 'тебя', 'тебе', 'тобой', 'вас', 'вам', 'вами']);
const participantPossessive = /^(?:мо[йяеёи]|мое(?:го|му|й|м)|мои(?:х|м|ми)|тво[йяеёи]|твое(?:го|му|й|м)|твои(?:х|м|ми)|наш[аеиу]?|наши(?:х|м|ми)|ваш[аеиу]?|ваши(?:х|м|ми))$/u;
const pastPredicate = /^[а-яё]{2,}(?:л[аои]?|л(?:ся|ась|ось|ись))$/iu;

function leadingClauseWords(text: string): string[] {
  const words: string[] = [];
  // Do not borrow an attribution from a later sentence or a nested quotation.
  for (const token of text.matchAll(/\p{L}+|[.!?…;:"«“„]/gu)) {
    if (!/^\p{L}/u.test(token[0])) break;
    words.push(token[0].toLowerCase());
    if (words.length === 12) break;
  }
  return words;
}

function isThirdPersonAction(words: string[]): boolean {
  for (let index = 1; index < words.length; index++) {
    if (!pastPredicate.test(words[index])) continue;
    const subject = words.slice(0, index);
    // «У меня голос сорвался» and «мои щёки горели» can still be the speaker's own aside.
    if (subject.some(word => speechParticipants.has(word) || participantPossessive.test(word))) continue;
    const startsWithBody = bodySubjects.has(subject[0].replaceAll('ё', 'е'));
    const ownedBody = (subject[0] === 'у' || thirdPersonPossessives.has(subject[0]))
      && subject.slice(1, 5).some(word => bodySubjects.has(word.replaceAll('ё', 'е')));
    if (thirdPersonSubjects.has(subject[0]) || startsWithBody || ownedBody) return true;
  }
  return false;
}

function isAuthorClause(text: string, speechPunctuation: string, resumesSpeech: boolean): boolean {
  if (/^\s*["'«“„‘]/u.test(text)) return false;
  const words = leadingClauseWords(text);
  // A complete «speech, — narration, — speech» pair does not need a known verb.
  // Sentence endings and a colon before resumed speech also support this structure.
  // Require actual text on both sides; streaming fragments must not complete the pair.
  if (resumesSpeech && words.length > 0 && /[,.!?…]/u.test(speechPunctuation) && /[,.:]\s*$/u.test(text)) return true;
  if (words.some(word => authorVerbs.some(pattern => pattern.test(word)))) return true;
  // Structural evidence needs a speech punctuation boundary, not just any em-dash pause.
  return /[,.:!?…]/u.test(speechPunctuation) && isThirdPersonAction(words);
}

/** Optional line-oriented heuristic. Quoted spans protect internal dashes from splitting. */
export function russianDialogueRanges(text: string, quotations: readonly SpeechRange[]): SpeechRange[] {
  const ranges: SpeechRange[] = [];
  let lineStart = 0;
  let quotationIndex = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const opening = /^[\t \u00a0\u202f]*—[\t \u00a0\u202f]+/u.exec(line);
    // Code/HTML/image barriers make the line ambiguous; leave it to basic quotation detection.
    if (opening && !line.includes('\0')) {
      const dashes: number[] = [];
      for (let index = lineStart + opening[0].length; index < lineEnd; index++) {
        while (quotations[quotationIndex] && quotations[quotationIndex].end <= index) quotationIndex++;
        if (quotations[quotationIndex] && quotations[quotationIndex].start <= index) continue;
        if (text[index] === '—' && /\s/u.test(text[index - 1]) && /\s/u.test(text[index + 1] ?? '')) dashes.push(index);
      }
      let speechStart: number | null = lineStart + line.indexOf('—');
      let clauseStart = speechStart;
      for (let index = 0; index < dashes.length; index++) {
        const dash = dashes[index];
        const next = dashes[index + 1] ?? lineEnd;
        if (speechStart !== null) {
          let speechEnd = dash;
          while (speechEnd > speechStart && /\s/u.test(text[speechEnd - 1])) speechEnd--;
          const resumesSpeech = next < lineEnd && /\S/u.test(text.slice(next + 1, dashes[index + 2] ?? lineEnd));
          if (isAuthorClause(text.slice(dash + 1, next), text[speechEnd - 1] ?? '', resumesSpeech)) {
            ranges.push({ start: speechStart, end: speechEnd });
            speechStart = null;
            clauseStart = dash + 1;
          }
        } else if (/[,.:!?…]$/u.test(text.slice(clauseStart, dash).trimEnd()) && text.slice(dash + 1, next).trim()) {
          speechStart = dash;
        }
      }
      if (speechStart !== null) ranges.push({ start: speechStart, end: lineStart + line.trimEnd().length });
    }
    lineStart = lineEnd + 1;
  }
  return ranges;
}
