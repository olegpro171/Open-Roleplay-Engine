import { describe, expect, it } from 'vitest';
import { directSpeechRanges } from '../src/web/direct-speech';
import { russianDialogueRegressions } from './support/russian-dialogue-fixtures';

function speech(text: string, options?: Parameters<typeof directSpeechRanges>[1]) {
  return directSpeechRanges(text, options).map(range => text.slice(range.start, range.end));
}

describe('quoted direct speech', () => {
  it.each([
    ['Mara asked "How are you?"', ['"How are you?"']],
    ['“Hello,” she said. «Привет», — ответила Мара.', ['“Hello,”', '«Привет»']],
    ["'Hello,' she said. ‘I’m here.’", ["'Hello,'", '‘I’m here.’']],
    ["Don't style Mara's words or d’Artagnan.", []],
    ['Он сказал: «Она ответила: „Да“».', ['«Она ответила: „Да“»']],
    ['"Unfinished stream', []],
    ['"before\0after"', []],
    ['"First" and "second".', ['"First"', '"second"']],
  ])('isolates balanced spans in %s', (text, expected) => {
    expect(speech(text)).toEqual(expected);
  });
});

describe('optional Russian dialogue heuristic', () => {
  it.each(russianDialogueRegressions)('excludes the reported narration: $narration', fixture => {
    expect(speech(fixture.text)).toEqual(fixture.speech);
    expect(speech(fixture.text, { russianDialogue: false })).toEqual([]);
  });

  it.each([
    ['— Стой! — она отшатнулась от двери. — Там кто-то есть.', ['— Стой!', '— Там кто-то есть.']],
    ['— Тише! — её голос дрожал. — Нас услышат.', ['— Тише!', '— Нас услышат.']],
    ['— Стой! — у Марии руки задрожали. — Не подходи.', ['— Стой!', '— Не подходи.']],
    ['— Стой! — голос дрожал, но она сдержалась, — не подходи.', ['— Стой!', '— не подходи.']],
    ['— Привет! — отвечает она.', ['— Привет!']],
    ['— Ты здесь? — она после долгой и очень неловкой паузы буркнула в ответ.', ['— Ты здесь?']],
    ['— Тише! — пробормотали они. — Нас услышат.', ['— Тише!', '— Нас услышат.']],
  ])('recognizes related narration beyond the reported wording in %s', (text, expected) => {
    expect(speech(text)).toEqual(expected);
  });

  it.each([
    '— Я испугалась! — у меня голос сорвался, представляешь?',
    '— Смотри! — щёки у меня горели от стыда.',
    '— Представь! — руки у тебя дрожали от холода.',
    '— Вот что произошло! — представляешь? Она буркнула что-то в ответ.',
    '— Послушай! — «Она буркнула в ответ» — вот что он написал.',
    '— Слушай! — голос у неё как колокольчик.',
    '— Это — она отшатнулась от двери.',
  ])('keeps ambiguous spoken asides highlighted in %s', text => {
    expect(speech(text)).toEqual([text]);
  });

  it.each([
    ['— Здесь мне лучше, — сказала девушка.', ['— Здесь мне лучше,']],
    ['— Оставайся. В Москве спокойнее, — ответил молодой офицер.', ['— Оставайся. В Москве спокойнее,']],
    ['— И тут он поворачивается ко мне и заявляет: «Ты никуда не поедешь!» — представляешь? — возмутилась Анна. — А я ему: «Это мы еще посмотрим».', ['— И тут он поворачивается ко мне и заявляет: «Ты никуда не поедешь!» — представляешь?', '— А я ему: «Это мы еще посмотрим».']],
    ['— Я увиделась с Александром. Он задал мне вопрос: «Почему игнорируешь мои звонки?» — «Я была занята работой», — соврала я.', ['— Я увиделась с Александром. Он задал мне вопрос: «Почему игнорируешь мои звонки?» — «Я была занята работой»,']],
    ['— Если мы не успеем... — он на секунду замолчал, прислушиваясь к шагам за дверью, — хотя нет, мы обязаны успеть.', ['— Если мы не успеем...', '— хотя нет, мы обязаны успеть.']],
    ['— Послушайте! — воскликнул Пётр, но тут же добавил тише: — Я ведь не знал, что «своевременно» в вашем понимании означает «с опозданием на час».', ['— Послушайте!', '— Я ведь не знал, что «своевременно» в вашем понимании означает «с опозданием на час».']],
    ['—\u00a0Здесь мне лучше,\u00a0— сказала девушка.', ['—\u00a0Здесь мне лучше,']],
    ['Narration — an ordinary pause.\n- A Markdown list item.\n—word\n—слово', []],
    ['— Привет.\nОписание.\n  — Прощай.', ['— Привет.', '— Прощай.']],
    ['— «Да — сказал бы любой», — ответила она.', ['— «Да — сказал бы любой»,']],
    ['— Она ответила — «Я сказала правду».', ['— Она ответила — «Я сказала правду».']],
  ])('isolates speech and leaves author clauses plain in %s', (text, expected) => {
    expect(speech(text)).toEqual(expected);
  });

  it('can be disabled without losing quotation styling', () => {
    const text = '— Привет, — сказала Мара. «До встречи». Ответ — обычное тире.';
    expect(speech(text, { russianDialogue: false })).toEqual(['«До встречи»']);
    expect(speech(text, { quotes: false })).toEqual(['— Привет,']);
    expect(speech(text, { quotes: false, russianDialogue: false })).toEqual([]);
  });
});
