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
  /^(?:рассмеял|засмеял|поинтересовал|осведомил|согласил|признал|взмолил|отозвал|донесл|отмахнул)(?:ся|ась|ось|ись)$/iu,
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
const speechBoundary = /[,.!?…:]/u;
const sentenceEnd = /[.!?…]/u;
const stageFragment = /^\s*(?:пауза|молчание|тишина),\s*(?:[а-яё]+\s+)?(?:вздох|кивок|улыбка|жест|взгляд|шорох)(?!\p{L})/iu;
const deliveryFragment = /^\s*(?:спокойно|ровно|тихо|негромко|глухо|сухо|мягко|резко),\s*(?:(?:почти\s+)?ш[её]потом|едва слышно|без\s+(?:[а-яё]+\s+)?(?:нам[её]ка|тени|дрожи|выражения|интонации))(?!\p{L})/iu;
const explainingVerb = /^(?:объясня|поясня)(?:ю|ем|ет|ют)$/u;
const actionVerbs = [
  /^(?:встал|сел|поднял|прижал|положил|взял|достал|снял|шагнул|отступил|соскользнул|подхватил)[аои]?$/u,
  /^(?:обернул|повернул|отвернул|перегнул|потянул|пошевелил|попытал|отшатнул|поднял)(?:ся|ась|ось|ись)$/u,
  /^(?:разворачива|поворачива|отворачива|наклоня|поднима)(?:юсь|емся|ется|ются)$/u,
  /^(?:вста(?:ю|ём|ем|ёт|ет|ют)|бер(?:у|ём|ем|ёт|ет|ут)|тян(?:усь|емся|ется|утся))$/u,
];
const nonNameStarter = /^(?:это|вот|кто|что|где|куда|откуда|зачем|почему|как|когда|если|лишь|только|не)$/u;
const actorAndPredicate = /^\s*([а-яё]+)(?:\s+(?:тут же|сразу|резко|медленно|быстро|осторожно|невольно|вдруг)){0,2}\s+([а-яё]+)(?![\p{L}-])/iu;

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

function isActorPredicate(text: string, followsSentence: boolean): boolean {
  const match = actorAndPredicate.exec(text);
  if (!match) return false;
  const subject = match[1].toLowerCase();
  const predicate = match[2].toLowerCase();
  const firstPerson = subject === 'я' || subject === 'мы';
  const explains = explainingVerb.test(predicate);
  if (!explains && !actionVerbs.some(pattern => pattern.test(predicate))) return false;
  // An action in the speaker's own voice is ambiguous after a comma and a single dash.
  if (firstPerson) return followsSentence || explains;
  if (thirdPersonSubjects.has(subject)) return true;
  // A capital can be a name. Require a recognizable predicate in the opening phrase.
  return /^\s*[А-ЯЁ]/u.test(text) && !speechParticipants.has(subject) && !nonNameStarter.test(subject);
}

function isAuthorClause(text: string, speechPunctuation: string, resumesSpeech: boolean): boolean {
  if (/^\s*["'«“„‘]/u.test(text)) return false;
  const punctuated = speechBoundary.test(speechPunctuation);
  // A verb after an ordinary pause («потом — я говорю…») is part of the speech.
  // Closing quotation marks can also end a spoken segment before an attribution.
  if (!punctuated && !/["»”]/u.test(speechPunctuation)) return false;
  const words = leadingClauseWords(text);
  // A complete «speech, — narration, — speech» pair does not need a known verb.
  // Sentence endings and a colon before resumed speech also support this structure.
  // Require actual text on both sides; streaming fragments must not complete the pair.
  if (resumesSpeech && words.length > 0 && /[,.!?…]/u.test(speechPunctuation) && /[,.:]\s*$/u.test(text)) return true;
  if (words.some(word => authorVerbs.some(pattern => pattern.test(word)))) return true;
  // «Объясняет она» is an attribution, whereas «всё объясняет» can continue the speech.
  if (explainingVerb.test(words[0] ?? '')) return true;
  if (!punctuated) return false;
  const followsSentence = sentenceEnd.test(speechPunctuation);
  if (isThirdPersonAction(words) || isActorPredicate(text, followsSentence)) return true;
  return followsSentence && (stageFragment.test(text) || deliveryFragment.test(text));
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
      const dashes: { index: number; precedingEnd: number }[] = [];
      let precedingEnd = lineStart + opening[0].length;
      for (let index = lineStart + opening[0].length; index < lineEnd; index++) {
        if (/\s/u.test(text[index])) continue;
        // Short dashes need punctuation even to be candidates, so an ordinary
        // hyphen pause does not break the lookahead for a conventional em-dash pair.
        const separator = text[index] === '—' || (/[–-]/u.test(text[index]) && speechBoundary.test(text[precedingEnd - 1]));
        if (separator && /\s/u.test(text[index - 1]) && /\s/u.test(text[index + 1] ?? '')) {
          while (quotations[quotationIndex] && quotations[quotationIndex].end <= index) quotationIndex++;
          if (!quotations[quotationIndex] || quotations[quotationIndex].start > index) dashes.push({ index, precedingEnd });
        }
        precedingEnd = index + 1;
      }
      let speechStart: number | null = lineStart + line.indexOf('—');
      for (let index = 0; index < dashes.length; index++) {
        const { index: dash, precedingEnd } = dashes[index];
        const next = dashes[index + 1]?.index ?? lineEnd;
        const punctuation = text[precedingEnd - 1] ?? '';
        if (speechStart !== null) {
          const resumesSpeech = text[dash] === '—' && next < lineEnd && text[next] === '—'
            && /\S/u.test(text.slice(next + 1, dashes[index + 2]?.index ?? lineEnd));
          if (isAuthorClause(text.slice(dash + 1, next), punctuation, resumesSpeech)) {
            ranges.push({ start: speechStart, end: precedingEnd });
            speechStart = null;
          }
        } else if (speechBoundary.test(punctuation) && /\S/u.test(text.slice(dash + 1, next))) {
          speechStart = dash;
        }
      }
      if (speechStart !== null) ranges.push({ start: speechStart, end: lineStart + line.trimEnd().length });
    }
    lineStart = lineEnd + 1;
  }
  return ranges;
}
