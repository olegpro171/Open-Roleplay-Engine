import { encode } from 'gpt-tokenizer/encoding/cl100k_base';
import type { Message, TokenCounting } from '../shared/contracts.js';

// One reference vocabulary for every model. Keep the cache bounded so repeated
// previews and preparation steps can reuse counts without retaining whole chats.
const cache = new Map<string, number>();
let characters = 0;
export function countText(text: string): number {
  const saved = cache.get(text);
  if (saved !== undefined) { cache.delete(text); cache.set(text, saved); return saved; }
  // Special-looking content remains literal text rather than injected framing.
  const tokens = encode(text, { disallowedSpecial: new Set<string>() }).length;
  if (text.length <= 100_000) {
    cache.set(text, tokens); characters += text.length;
    while (cache.size > 512 || characters > 2_000_000) {
      const oldest = cache.keys().next().value!;
      cache.delete(oldest); characters -= oldest.length;
    }
  }
  return tokens;
}

export function countInput(messages: Message[]) {
  const contentTokens = messages.map(message => countText(message.content));
  // Shared small allowance, deliberately independent of the endpoint's template.
  const framingTokens = 3 + messages.reduce((sum, message) => sum + 3 + countText(message.role), 0);
  const counting: TokenCounting = {
    kind: 'reference', tokenizer: 'cl100k_base', implementation: 'gpt-tokenizer@4.0.3',
    framing: 'estimated-recipe', fallbackReason: null,
    limitations: 'Shared reference estimate for all models. Endpoint tokenization, templates and hidden additions can change usage; no exact remote-limit guarantee.',
  };
  return {
    inputTokens: contentTokens.reduce((a, b) => a + b, 0) + framingTokens,
    contentTokens, method: 'cl100k_base reference + shared framing estimate', counting, verified: false as const,
  };
}
