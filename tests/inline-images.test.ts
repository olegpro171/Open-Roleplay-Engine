import { describe, expect, it } from 'vitest';
import { assembleRequest } from '../src/core/prompt.js';
import { defaultPrompt } from '../src/shared/library.js';
import type { ChatSettings, Connection, Turn } from '../src/shared/contracts.js';
import type { ChatSnapshot } from '../src/shared/contracts.js';
import { modelText } from '../src/core/model-text.js';
import { summaryRequest } from '../src/core/context-plan.js';
import { sourceOf } from '../src/core/context.js';
import { defaultContextPreset, type SummaryNode } from '../src/shared/context.js';

const connection: Connection = { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: {} };
const settings: ChatSettings = { title: 'Images', instructions: '', character: '', persona: '', targetInputTokens: 5_000 };
const turn = (text: string): Turn => ({ id: 'greeting', position: 1, complete: true,
  user: { id: 'u', revision: 0, text: '' }, assistant: { id: 'a', revision: 0, text } });
const sources = (managed: boolean) => ({ character: null, persona: null, prompt: { ...defaultPrompt, id: 'images', revision: 0,
  blocks: defaultPrompt.blocks.filter(block => block.id === 'messages' || managed && block.id === 'summary') } });

describe('inline images in model input', () => {
  it.each([
    ['Before ![alt](https://example.com/a_(b).png "title") after.', 'Before  after.'],
    ['Before\n\n![alt][scene]\n\n[scene]: <https://example.com/a.png> "title"', 'Before'],
    ['![scene]\n\n[scene]: https://example.com/a.png', ''],
    ['![scene][]\n\n[scene]: https://example.com/a.png', ''],
    ['  ![](https://example.com/a.png)  ', ''],
    ['[![alt](https://example.com/a.png)](https://example.com/full.png)', ''],
    ['[![alt][image]][full]\n\n[image]: https://example.com/a.png\n[full]: https://example.com/full.png', ''],
    ['![alt][scene] [ordinary link][scene]\n\n[scene]: https://example.com/a.png', ' [ordinary link][scene]\n\n[scene]: https://example.com/a.png'],
    ['`![](https://example.com/code.png)`\n\n```md\n![alt](https://example.com/code.png)\n```', '`![](https://example.com/code.png)`\n\n```md\n![alt](https://example.com/code.png)\n```'],
    ['Escaped \\![](https://example.com/literal.png) and ![unfinished](https://example.com/', 'Escaped \\![](https://example.com/literal.png) and ![unfinished](https://example.com/'],
    ['Keep **formatting**,  spacing!\n\n![alt](javascript:bad)\n\n    indented code', 'Keep **formatting**,  spacing!\n\n\n\n    indented code'],
  ])('removes only rendered image syntax from %s', (source, expected) => {
    expect(modelText(source)).toBe(expected);
    expect(modelText(source)).toBe(expected);
  });

  it.each([true, false])('excludes images from greetings, pending input and budgets (managed: %s)', managed => {
    const prose = 'She waited. "Let me stay."';
    const greeting = turn(`${prose}\n\n![hidden alt](https://example.com/${'long-image-name-'.repeat(200)}.png)`);
    const pending = { ...turn('partial image response'), id: 'pending', complete: false, user: { id: 'pending-user', revision: 0, text: 'Stay. ![](https://example.com/user.png)' } };
    const request = assembleRequest(connection, settings, [greeting, pending], sources(managed));
    expect(request.body.messages).toEqual([{ role: 'assistant', content: prose }, { role: 'user', content: 'Stay. ' }]);
    const plain = assembleRequest(connection, settings, [turn(prose), { ...pending, user: { ...pending.user, text: 'Stay. ' } }], sources(managed));
    expect(request.budget).toEqual(plain.budget);
    expect(request.coverage).toEqual(plain.coverage);
    expect(greeting.assistant.text).toContain('![hidden alt]');
    expect(assembleRequest(connection, { ...settings, targetInputTokens: plain.budget.inputTokens }, [greeting, pending], sources(managed)).body.messages).toEqual(plain.body.messages);
  });

  it('keeps image-only turns in coverage while omitting their empty outgoing parts', () => {
    const greeting = turn('![](https://example.com/only.png)');
    const request = assembleRequest(connection, settings, [greeting, { ...turn('A visitor arrives.'), id: 'second' }], sources(true));
    expect(request.body.messages).toEqual([{ role: 'assistant', content: 'A visitor arrives.' }]);
    expect(request.coverage.map(source => source.turnId)).toEqual(['greeting', 'second']);
    expect(() => assembleRequest(connection, settings, [greeting], sources(true))).toThrow('resolved prompt is empty');
  });

  it('filters resolved character/prompt text without shifting the Messages insertion point', () => {
    const promptSources = sources(false);
    promptSources.prompt.blocks = [
      { id: 'image', name: 'Image', enabled: true, kind: 'text', role: 'system', text: '![](https://example.com/prompt.png)' },
      ...promptSources.prompt.blocks,
      { id: 'after', name: 'After', enabled: true, kind: 'text', role: 'system', text: 'Closing instructions.' },
    ];
    expect(assembleRequest(connection, settings, [turn('Hello.')], promptSources).body.messages).toEqual([
      { role: 'assistant', content: 'Hello.' }, { role: 'system', content: 'Closing instructions.' },
    ]);
  });

  it('excludes images from extraction, promotion, prior memory and repair while retaining source baselines', () => {
    const image = '\n\n![hidden alt](https://example.com/private-image.png)';
    const greeting = turn('The gate opened.' + image);
    const summary: SummaryNode = { id: 'summary', revision: 0, level: 1, text: 'An open gate.' + image, turns: [sourceOf(greeting)], children: [], prior: [], approved: true, manual: false, createdAt: '' };
    const later = { ...turn('A visitor arrives.' + image), id: 'later', position: 2 };
    const snapshot: ChatSnapshot = { id: 'chat', revision: 0, connection, hasApiKey: false, settings, sources: sources(true), turns: [greeting, later], generations: [],
      context: { revision: 0, summaries: [summary], selected: [summary], archivedTurnIds: [greeting.id], jobs: [], preset: { ...defaultContextPreset, id: 'preset', revision: 0 } } };
    const operation = { level: 1, turnIds: [greeting.id], children: [] };
    const extraction = summaryRequest(snapshot, operation, connection).request;
    expect(JSON.parse(extraction.body.messages.at(-1)?.content ?? '').sources).toEqual([{ turn: 1, user: '', assistant: 'The gate opened.' }]);
    expect(extraction.summarySources).toEqual([{ turnId: greeting.id, user: '', assistant: greeting.assistant.text }]);
    const promotion = summaryRequest(snapshot, { ...operation, level: 2, children: [summary] }, connection).request;
    const withPrior = summaryRequest(snapshot, { level: 1, turnIds: [later.id], children: [] }, connection).request;
    expect(withPrior.body.messages).toContainEqual({ role: 'system', content: 'Earlier memory for reference only; do not repeat or extend its coverage:\nAn open gate.' });
    const edited = { ...snapshot, turns: [{ ...greeting, assistant: { ...greeting.assistant, revision: 1, text: 'The gate closed.' + image } }, later] };
    const repair = summaryRequest(edited, { ...operation, repair: summary }, connection, new Map(), extraction).request;
    const repairPayload = JSON.parse(repair.body.messages.at(-1)?.content ?? '');
    expect(repairPayload.previous_summary).toBe('An open gate.');
    expect(repairPayload.changes).toContainEqual(expect.objectContaining({ before: 'The gate opened.', after: 'The gate closed.' }));
    expect(repair.summarySources?.[0].assistant).toContain(image);
    for (const request of [extraction, promotion, withPrior, repair, assembleRequest(connection, settings, snapshot.turns, snapshot.sources, snapshot.context)]) {
      expect(JSON.stringify(request.body)).not.toContain('private-image');
      expect(JSON.stringify(request.body)).not.toContain('hidden alt');
    }
    expect(summary.text).toContain(image);
  });
});
