import type { SpeechRange } from './quoted-speech';

// Punctuation identifies complete interruptions; vocabulary supports incomplete/ambiguous ones.
const authorVerbs = [
  /^(?:показал|указал)[аои]?$/iu,
  /^(?:сказал|говорил|ответил|спросил|проговорил|промолвил|воскликнул|прошептал|шепнул|крикнул|выкрикнул)[аои]?$/iu,
  /^произн[её]с(?:л[аои])?$/iu,
  /^(?:добавил|продолжил|заметил|уточнил|повторил|перебил|соврал|солгал|подумал|сообщил)[аои]?$/iu,
  /^(?:возмутил|усмехнул|улыбнул|нахмурил)(?:ся|ась|ось|ись)$/iu,
  /^(?:вздохнул|замолчал|помолчал|кивнул|пожал|покачал|посмотрел|взглянул)[аои]?$/iu,
  /^(?:передразнил|вскрикнул|буркнул|бурчал|пробурчал|ворчал|проворчал|бормотал|пробормотал|твердил)[аои]?$/iu,
  /^(?:прошипел|процедил|выпалил|рявкнул|прорычал|протянул|выдохнул|пискнул|пролепетал|отрезал)[аои]?$/iu,
  /^(?:возразил|предупредил|напомнил|пояснил|объяснил|заявил)[аои]?$/iu,
  /^(?:прокричал|закричал|заорал|завопил|взвизгнул|взвыл|промямлил|пробубнил|просипел|прохрипел|пропищал)[аои]?$/iu,
  /^(?:ахнул|охнул|хмыкнул|фыркнул|всхлипнул|хихикнул|хохотнул)[аои]?$/iu,
  /^(?:переспросил|попросил|потребовал|подтвердил|протестовал|запротестовал|пообещал|съязвил|парировал|заверил)[аои]?$/iu,
  /^(?:объявил|констатировал|позвал|промычал|помолчал|скомандовал|поправил|доложил)[аои]?$/iu,
  /^(?:рассмеял|засмеял|посмеял|ухмыльнул|поинтересовал|осведомил|согласил|признал|взмолил|отозвал|донесл|отмахнул)(?:ся|ась|ось|ись)$/iu,
  /^(?:поздоровал|попрощал)(?:ся|ась|ось|ись)$/iu,
  // First/third-person present forms avoid treating spoken imperatives such as «говорите» as narration.
  /^(?:отвеча|спрашива|переспрашива|добавля|продолжа|восклица|вскрикива|требу|возража|протесту|всхлипыва|хихика|сообща)(?:ю|ем|ет|ют)$/iu,
  /^(?:повторя|выдыха|выпалива|выдавлива|заканчива|констатиру|поправля)(?:ю|ем|ет|ют)$/iu,
  /^(?:стон(?:у|ет|ем|ут)|бубн(?:ю|им|ит|ят)|доносится|доносятся)$/iu,
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
const presentPredicate = /^[а-яё]{2,}(?:(?:[аяу](?:ет|ют))(?:ся)?|(?:[её]т|ит|ут|ат|ят)ся)$/iu;
const speechBoundary = /[,.!?…:]/u;
const sentenceEnd = /[.!?…]/u;
const closingQuoteMark = /["»”“]/u;
const stageFragment = /^\s*(?:пауза|молчание|тишина),\s*(?:[а-яё]+\s+)?(?:вздох|кивок|улыбка|жест|взгляд|шорох)(?!\p{L})/iu;
const standaloneStageFragment = /^\s*(?:пауза|молчание|тишина|кивок|вздох|ухмылка|и\s+вс[её])[.,]\s*$/iu;
const standaloneDelivery = /^\s*(?:почти\s+)?ш[её]потом[.:]\s*$/iu;
const deliveryFragment = /^\s*(?:(?:совсем\s+)?(?:спокойно|ровно|тихо|негромко|глухо|сухо|мягко|резко)|едва слышно),\s*(?:(?:почти\s+)?ш[её]потом|почти писк|едва слышно|без\s+(?:[а-яё]+\s+)?(?:нам[её]ка|тени|дрожи|выражения|интонации))(?!\p{L})/iu;
const utteranceAction = /^\s*(?:(?:я|мы|он|она|они)\s+)?(?:так\s+и\s+)?(?:не\s+)?(?:закончил|договорил|оборвал|прервал)[аои]?\s+(?:свою\s+)?(?:фразу|реплику)(?!\p{L})/iu;
const utteranceBreak = /^\s*(?:фраза|реплика|слова)\s+(?:вдруг\s+)?(?:(?:оборвал|рассыпал)(?:ась|ись)|застрял[аи])(?!\p{L})/iu;
const unfinishedUtterance = /^\s*(?:(?:я|мы|он|она|они)\s+)?(?:так\s+и\s+)?не\s+(?:закончил|договорил)[аои]?(?=\s*(?:[,.!?…]|$)|\s+так\s+же\s*,)/iu;
const detachedGerund = /^\s*(?:не\s+)?(?:[а-яё]{2,}(?:[ая]ясь|[аеиу]в(?:шись)?)|глядя|смотря)(?:\s+[^\s,.!?…;:"«“„]+){0,8}\s*,/iu;
const correlativeContinuation = /^\s*(?:это|то|тогда|так|там|тут|здесь)(?!\p{L})/iu;
const dependentClauseStart = /^\s*(?:(?:а|и|но|даже)\s+)?(?:если|когда|пока|хотя|поскольку|раз|как\s+только|(?:там|тут|здесь)\s*,\s*где)(?![\p{L}-])/iu;
const explainingVerb = /^(?:объясня|поясня)(?:ю|ем|ет|ют)$/u;
const actionVerbs = [
  /^(?:встал|сел|поднял|прижал|положил|взял|достал|снял|шагнул|отступил|соскользнул|подхватил|глянул|покивал)[аои]?$/u,
  /^(?:отодвинул|подвинул|придвинул|раздвинул)[аои]?$/u,
  /^(?:обернул|повернул|отвернул|перегнул|потянул|пошевелил|попытал|отшатнул|поднял|поклонил)(?:ся|ась|ось|ись)$/u,
  /^(?:разворачива|поворачива|отворачива|наклоня|поднима)(?:юсь|емся|ется|ются)$/u,
  /^(?:вста(?:ю|ём|ем|ёт|ет|ют)|бер(?:у|ём|ем|ёт|ет|ут)|тян(?:усь|емся|ется|утся))$/u,
  /^(?:смотрит|глядит|обходит|держит|машет|ставит|проводит|прижимает|распахивает)$/u,
];
const impliedAction = /^(?:распахивает|открывает|закрывает|отворачивается|поворачивается|отвернул(?:ся|ась|ось|ись))$/u;
const nonNameStarter = /^(?:это|вот|кто|что|где|куда|откуда|зачем|почему|как|когда|если|лишь|только|не|здесь|там|тут|вчера|сегодня|завтра|сейчас|потом|теперь|сначала|наконец|уже|ещ[её]|снова)$/u;
const actorAndPredicate = /^\s*(\p{L}+(?:-\p{L}+)*)(?:\s+(?:тут же|сразу|резко|медленно|быстро|осторожно|невольно|вдруг|крепко|плотно|слегка|уже|ещ[её]|снова|[а-яё]+(?:ливо|тельно|остно|ивно))){0,2}\s+([а-яё]+)(?![\p{L}-])(?:\s+([а-яё]+)(?![\p{L}-]))?/iu;

function isPossibleName(word: string): boolean {
  const lower = word.toLowerCase();
  return /^\p{Lu}/u.test(word) && !speechParticipants.has(lower) && !nonNameStarter.test(lower);
}

function leadingClauseWords(text: string): string[] {
  const words: string[] = [];
  // Later clauses can contain speech verbs even when the opening phrase still belongs to dialogue.
  for (const token of text.matchAll(/\p{L}+(?:-\p{L}+)*|[,.!?…;:"«“„]/gu)) {
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

function isActorPredicate(text: string, allowsFirstPersonAction: boolean, allowsInferredAction: boolean): boolean {
  const match = actorAndPredicate.exec(text);
  if (!match) return false;
  const subject = match[1].toLowerCase();
  const predicate = match[2].toLowerCase();
  const firstPerson = subject === 'я' || subject === 'мы';
  const explains = explainingVerb.test(predicate);
  const object = match[3]?.toLowerCase() ?? '';
  const movesEyes = /^(?:закрыл|прикрыл|открыл|зажмурил|закатил)[аои]?$/u.test(predicate) && /^(?:глаза|веки)$/u.test(object);
  const grips = /^сжал[аои]?$/u.test(predicate) && /^(?:его|е[её]|их|меня|руку|руки|ладонь|кулак|кулаки|зубы|пальцы|плечо|плечи)$/u.test(object);
  if (!explains && !movesEyes && !grips && !actionVerbs.some(pattern => pattern.test(predicate))) {
    if (!allowsInferredAction || !presentPredicate.test(predicate)) return false;
    return thirdPersonSubjects.has(subject) || isPossibleName(match[1]);
  }
  // An action in the speaker's own voice is ambiguous after a comma and a single dash.
  if (firstPerson) return allowsFirstPersonAction || explains;
  if (thirdPersonSubjects.has(subject)) return true;
  // A capital can be a name. Require a recognizable predicate in the opening phrase.
  return isPossibleName(match[1]);
}

type SpeechResumption = { punctuation: string; crossesInternalDashes: boolean };

function hasNarrativeAction(text: string): boolean {
  const actor = actorAndPredicate.exec(text);
  if (actor && (isPossibleName(actor[1]) || thirdPersonSubjects.has(actor[1].toLowerCase()))) {
    const predicate = actor[2].toLowerCase();
    if (pastPredicate.test(predicate) || presentPredicate.test(predicate) || actionVerbs.some(pattern => pattern.test(predicate))) return true;
  }
  // Without an actor, short nouns such as «дело» give weak past-tense matches.
  return leadingClauseWords(text).some((word, index) => index > 0 && word.length > 4 && pastPredicate.test(word));
}

function isPunctuatedInterruption(text: string, subject: string, speechPunctuation: string, resumption: SpeechResumption, continuesDependentClause: boolean): boolean {
  const { punctuation: authorPunctuation, crossesInternalDashes } = resumption;
  const afterSentence = sentenceEnd.test(speechPunctuation);
  const afterComma = speechPunctuation === ',' && !correlativeContinuation.test(text);
  if (!afterSentence && !afterComma) return false;
  const punctuationMatches = /[,:]/u.test(authorPunctuation) || (afterSentence && authorPunctuation === '.');
  if (punctuationMatches && !crossesInternalDashes) return true;
  // A more distant dash can also belong to speech. Require a narrative cue
  // in the opening clause before treating several dashes as one interruption.
  const authorSentence = authorPunctuation === '.' && afterComma && !continuesDependentClause && !speechParticipants.has(subject);
  return (punctuationMatches || authorSentence) && hasNarrativeAction(text);
}

function isAuthorClause(text: string, speechPunctuation: string, quoteEnding: 'sentence' | 'phrase' | undefined,
  resumption: SpeechResumption | undefined, continuesDependentClause: boolean): boolean {
  if (/^\s*["'«“„‘]/u.test(text)) return false;
  const punctuated = speechBoundary.test(speechPunctuation);
  // A verb after an ordinary pause («потом — я говорю…») is part of the speech.
  // Closing quotation marks can also end a spoken segment before an attribution.
  if (!punctuated && !quoteEnding && !/["»”]/u.test(speechPunctuation)) return false;
  const words = leadingClauseWords(text);
  if (!words.length) return false;
  if (resumption && continuesDependentClause && speechParticipants.has(words[0])) return false;
  if (resumption && isPunctuatedInterruption(text, words[0], speechPunctuation, resumption, continuesDependentClause)) return true;
  // A leading gerund can precede an attribution across a comma («не глядя, сказала она»).
  const openingWords = detachedGerund.test(text) ? leadingClauseWords(text.slice(text.indexOf(',') + 1)) : words;
  if (openingWords.some(word => authorVerbs.some(pattern => pattern.test(word)))) return true;
  // «Объясняет она» is an attribution, whereas «всё объясняет» can continue the speech.
  if (explainingVerb.test(words[0])) return true;
  const followsSentence = sentenceEnd.test(speechPunctuation) || quoteEnding === 'sentence';
  if (!punctuated && !followsSentence) return false;
  if (quoteEnding === 'sentence' && unfinishedUtterance.test(text)) return true;
  const pairedAction = speechPunctuation === ',' && resumption?.punctuation === '.' && !continuesDependentClause;
  // After a complete sentence, a capital and a verb ending can also begin the next spoken sentence.
  const allowsInferredAction = (speechPunctuation === ',' && !continuesDependentClause)
    || (followsSentence && (resumption !== undefined || thirdPersonSubjects.has(words[0])));
  if (isThirdPersonAction(words) || isActorPredicate(text, followsSentence || pairedAction, allowsInferredAction)) return true;
  if (followsSentence && words[0] === 'и' && words[1] && impliedAction.test(words[1])) return true;
  if ((followsSentence || resumption) && standaloneStageFragment.test(text)) return true;
  return followsSentence && (stageFragment.test(text) || standaloneDelivery.test(text)
    || deliveryFragment.test(text) || utteranceAction.test(text) || utteranceBreak.test(text));
}

function endsWithQuotedSentence(text: string, quote: SpeechRange): boolean {
  let index = quote.end - 1;
  while (index > quote.start && closingQuoteMark.test(text[index])) index--;
  return sentenceEnd.test(text[index]);
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
      const dashes: { index: number; precedingEnd: number; sentenceStart: number; punctuation: string; precedingQuote?: SpeechRange }[] = [];
      let precedingEnd = lineStart + opening[0].length;
      let sentenceStart = precedingEnd;
      for (let index = lineStart + opening[0].length; index < lineEnd; index++) {
        if (/\s/u.test(text[index])) continue;
        const punctuation = text[precedingEnd - 1] ?? '';
        // Short dashes need punctuation even to be candidates, so an ordinary
        // hyphen pause does not break the lookahead for a conventional em-dash pair.
        const separator = text[index] === '—' || (/[–-]/u.test(text[index]) && speechBoundary.test(punctuation));
        if (separator && /\s/u.test(text[index - 1]) && /\s/u.test(text[index + 1] ?? '')) {
          while (quotations[quotationIndex] && quotations[quotationIndex].end <= index) quotationIndex++;
          if (!quotations[quotationIndex] || quotations[quotationIndex].start > index) {
            const quote = quotations[quotationIndex - 1];
            dashes.push({ index, precedingEnd, sentenceStart, punctuation, precedingQuote: quote?.end === precedingEnd ? quote : undefined });
          }
        }
        if (sentenceEnd.test(text[index])) sentenceStart = index + 1;
        precedingEnd = index + 1;
      }
      let speechStart: number | null = lineStart + line.indexOf('—');
      let resumeIndex = 0;
      for (let index = 0; index < dashes.length; index++) {
        const { index: dash, precedingEnd, precedingQuote, punctuation, sentenceStart } = dashes[index];
        const next = dashes[index + 1]?.index ?? lineEnd;
        if (speechStart !== null) {
          // Dashes inside an unfinished sentence cannot resume speech. Use
          // the same punctuation gate here and when leaving author narration.
          resumeIndex = Math.max(resumeIndex, index + 1);
          while (resumeIndex < dashes.length && !speechBoundary.test(dashes[resumeIndex].punctuation)) resumeIndex++;
          const resume = dashes[resumeIndex];
          const resumption = text[dash] === '—' && resume && text[resume.index] === '—'
            && /\S/u.test(text.slice(resume.index + 1, dashes[resumeIndex + 1]?.index ?? lineEnd))
            ? { punctuation: resume.punctuation, crossesInternalDashes: resumeIndex > index + 1 }
            : undefined;
          const continuesDependentClause = punctuation === ',' && (!resumption || resumption.punctuation === '.')
            && dependentClauseStart.test(text.slice(Math.max(speechStart + 1, sentenceStart), precedingEnd));
          const quoteEnding = precedingQuote && (endsWithQuotedSentence(text, precedingQuote) ? 'sentence' : 'phrase');
          if (isAuthorClause(text.slice(dash + 1, next), punctuation, quoteEnding, resumption, continuesDependentClause)) {
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
