// Match whole JSON strings so punctuation and whitespace inside them stay literal.
const tokenPattern = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
const whitespace = /[ \n\r\t]*/y;
export const jsonIndent = '    ';

type Frame = {
  kind: 'array' | 'object';
  state: 'first' | 'key' | 'colon' | 'value' | 'separator';
  index: number;
  comma: number;
  matchesPath: boolean;
};

type JsonExpectation = 'trailing_comma' | 'key' | 'colon' | 'value' | 'separator' | 'end' | 'string';
type SourcePosition = { offset: number; expected?: JsonExpectation };

// The string token failed. Find the malformed escape, raw control character,
// or end of input where the closing quote is missing.
function invalidString(text: string, quote: number): SourcePosition {
  let offset = quote + 1;
  while (offset < text.length) {
    const char = text[offset++];
    if (char.charCodeAt(0) < 32) return { offset: offset - 1, expected: 'string' };
    if (char !== '\\') continue;
    if (text[offset] === 'u') {
      offset++;
      for (let digit = 0; digit < 4; digit++, offset++) {
        if (!/[\da-fA-F]/.test(text[offset] ?? '')) return { offset, expected: 'string' };
      }
    } else if ('"\\/bfnrt'.includes(text[offset] ?? ' ') && offset < text.length) {
      offset++;
    } else return { offset, expected: 'string' };
  }
  return { offset, expected: 'string' };
}

// JSON.parse owns acceptance. Walk the source only to locate its first syntax
// error or a schema path, including escaped keys and repeated names in siblings.
export function locateJson(text: string, path: readonly PropertyKey[] = []): SourcePosition {
  const stack: Frame[] = [];
  let offset = 0;
  let found = 0;
  let rootRead = false;
  let keyMatches = false;
  while (true) {
    whitespace.lastIndex = offset;
    whitespace.exec(text);
    offset = whitespace.lastIndex;
    const parent = stack.at(-1);
    if (!parent && rootRead) return offset === text.length ? { offset: found } : { offset, expected: 'end' };
    tokenPattern.lastIndex = offset;
    const token = tokenPattern.exec(text)?.[0];
    const closer = parent?.kind === 'object' ? '}' : ']';
    if (!token && text[offset] === '"') return invalidString(text, offset);
    if (parent && token === closer && parent.comma >= 0 && (parent.state === 'key' || parent.state === 'value')) {
      return { offset: parent.comma, expected: 'trailing_comma' };
    }
    if (parent && token === closer && (parent.state === 'first' || parent.state === 'separator')) {
      stack.pop();
    } else if (parent?.state === 'separator') {
      if (token !== ',') return { offset, expected: 'separator' };
      parent.comma = offset;
      parent.state = parent.kind === 'object' ? 'key' : 'value';
    } else if (parent?.state === 'colon') {
      if (token !== ':') return { offset, expected: 'colon' };
      parent.state = 'value';
    } else if (parent?.kind === 'object' && (parent.state === 'first' || parent.state === 'key')) {
      if (!token?.startsWith('"')) return { offset, expected: 'key' };
      keyMatches = parent.matchesPath && path[stack.length - 1] === JSON.parse(token);
      if (keyMatches && stack.length === path.length) found = offset;
      parent.comma = -1;
      parent.state = 'colon';
    } else {
      if (!token || /^[}\],:]$/.test(token)) return { offset, expected: 'value' };
      const matchesPath = !parent || (parent.kind === 'array'
        ? parent.matchesPath && path[stack.length - 1] === parent.index
        : keyMatches);
      if (!parent || (parent.kind === 'array' && matchesPath && stack.length === path.length)) found = offset;
      if (parent) {
        parent.index++;
        parent.state = 'separator';
      } else rootRead = true;
      if (token === '{' || token === '[') {
        stack.push({ kind: token === '{' ? 'object' : 'array', state: 'first', index: 0, comma: -1, matchesPath });
      }
    }
    offset = tokenPattern.lastIndex;
  }
}

// The source must parse as a JSON object. Preserve duplicate keys, number literals,
// escapes, and source order, all of which a parse/stringify round trip can change.
export function formatJsonObject(text: string): string {
  const parts: string[] = [];
  let depth = 0;
  let previous = '';
  for (const [token] of text.matchAll(new RegExp(tokenPattern.source, 'g'))) {
    const closes = token === '}' || token === ']';
    const opened = previous === '{' || previous === '[';
    if (closes) depth--;
    if ((opened && !closes) || previous === ',' || (closes && !opened)) {
      parts.push('\n', jsonIndent.repeat(depth));
    } else if (previous === ':') parts.push(' ');
    parts.push(token);
    if (token === '{' || token === '[') depth++;
    previous = token;
  }
  return parts.join('');
}
