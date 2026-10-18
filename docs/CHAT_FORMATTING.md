# Chat formatting

Story uses one Markdown renderer for greetings, user input, assistant responses, selected response versions and streamed/failed/cancelled partial text. Emphasis, strong emphasis, headings, ordered/unordered lists, blockquotes, inline/fenced code and the GitHub-flavored table, strikethrough and task-list extensions are supported. Soft line breaks remain visible. Code and tables scroll horizontally inside the conversation when needed.

This is a display transformation. Editors show the original source; persistence, summaries, lore scanning, token counting and request inspection continue to use the original text. Existing records need no migration. Raw HTML is displayed literally and never executed. Links accept HTTP(S), mailto and same-page fragments, with external destinations opening in a separate tab without opener/referrer access. Relative and unsafe schemes are inert. Markdown images display `[Image: alt text]` without fetching resources; this is not a multimedia feature.

## Quoted speech

Balanced `"…"`, `'…'`, `“…”`, `‘…’`, `«…»` and `„…“` spans are bold and light blue, including the quotation marks. Nested pairs are included in the outer span. Apostrophes inside words do not start or end a quotation. This recognizes quoted text, including quotations that are not literally spoken dialogue; it does not infer narrative meaning. Unclosed streamed quotations remain ordinary text until their closing mark arrives.

Speech styling excludes every em dash (`—`), including line-opening dashes, dashes before resumed speech and dashes inside quotations. Surrounding speech and quotation marks retain their styling. This is applied by the renderer after detection, so dashes still establish dialogue boundaries and the independently optional Russian detector is unchanged.

Detection runs on inline prose after Markdown parsing. A quotation may cross emphasis, strong emphasis or link-label boundaries. Code, images, raw HTML and other non-prose nodes form barriers; code contents and link destinations are never restyled. Parsing is local to an inline block, so a quotation does not extend across blank paragraphs, table cells or unrelated list items.

## Optional Russian dialogue

`russian-dialogue.ts` is independent of the quotation detector. Its deliberately limited heuristic:

1. Requires an em dash followed by horizontal whitespace at the start of a line, allowing indentation and nonbreaking spaces. An em dash inside ordinary narration does not activate dialogue mode.
2. Uses the opening dash to identify speech. Spaced em dashes inside balanced quotations do not divide its detected coverage; rendering leaves all em dashes outside speech styling.
3. Checks at most twelve words of the first clause after a separating dash, stopping at sentence punctuation, a colon or a quotation. An explicit vocabulary recognizes common attribution/action verbs, including inflected `передразнила`, `буркнула`, `пробормотали` and present-tense `отвечает`. A later sentence or quoted phrase cannot supply an attribution for an earlier spoken aside.
4. After a speech punctuation boundary, also recognizes third-person action/body-language clauses with a past-tense predicate: `она отшатнулась`, `у Аири голос сорвался`, `Щёки у неё горели`, or `её голос дрожал`. This fallback requires an initial third-person pronoun or body/voice subject (including an owner introduced by `у`). First/second-person subject cues such as `у меня` or `руки у тебя` prevent the fallback from consuming the speaker's own aside. The separating dash and the entire author clause, including subsequent narrative sentences, stay plain.
5. Resumes speech at a following spaced em dash when the author clause ends with a comma, colon or sentence punctuation. The resuming dash stays outside speech styling. Other speech punctuation remains styled; whitespace before an author separator stays plain.
6. Resets at each line. A line containing code or another non-prose barrier is left to quotation-only detection.

Exact-span tests cover the original six examples and the five follow-up examples; rendered-prose and browser tests also exercise every follow-up case. In particular, `представляешь?` stays within speech, nested quoted replies do not become author clauses, and `он на секунду замолчал…` is excluded before speech resumes. The follow-up cases exposed the original short verb list's inability to recognize additional attributions or body-language narration; the expanded vocabulary and structural fallback address those patterns. This is not a Russian grammar parser: unfamiliar attribution verbs, unusual punctuation and narrative text resembling an attribution can still produce missed or incorrect boundaries. Body-language clauses without a recognizable past-tense predicate or subject cue are not inferred. Line-wrapped em-dash dialogue is not inferred across separate lines. No model calls or language service are used.

Set `defaultSpeechOptions.russianDialogue` to `false` in `src/web/ChatMarkdown.tsx` to disable this detector while retaining quotes. The component also accepts independent `speech` options for tests/future controls. The combiner in `direct-speech.ts` is the only integration point for removing the Russian module. `--direct-speech-color` in `src/web/style.css` supplies the temporary `#a8c9f0`; a future preference can override that inherited variable without modifying detection.

## Verification

`tests/direct-speech.test.ts` checks exact ranges, all supplied examples, related action/voice patterns, negative spoken asides, quote variants, apostrophes, nonbreaking spaces, ordinary narration and independent disabling. `tests/chat-markdown.test.ts` checks rendered Markdown, the follow-up author clauses, cross-format spans, code barriers, incremental incomplete text, and inert HTML/unsafe URLs/images. `tests/browser/markdown.spec.ts` exercises copied greetings, source editing, version selection through every follow-up case, reload, real mock-provider streaming and exact saved/outgoing source at desktop and phone-sized widths, with screenshots and overflow checks. These checks establish the documented patterns, not universal grammatical accuracy or actual phone behavior.
