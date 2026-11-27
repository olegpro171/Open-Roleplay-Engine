import { describe, expect, it } from 'vitest';
import { customParameterError, parseConnectionParameters } from '../src/web/connection-parameter-draft';
import { formatJsonObject } from '../src/web/json-source';

const draft = (parameters: string) => ({ parameters, builtInParameters: { numbers: {} } });

describe('Connection JSON draft', () => {
  it.each([
    ['{\n "x" 7}', '7', 'connection_json.expected_colon'],
    ['{"rows":[1,\n]}', ',', 'connection_json.expected_trailing_comma'],
    ['{ "x": true, }', ',', 'connection_json.expected_trailing_comma'],
    ['{"a":1 "b":2}', '"b"', 'connection_json.expected_separator'],
    ['{"key": }', '}', 'connection_json.expected_value'],
    ['{"a": "bad\\q"}', 'q', 'connection_json.expected_string'],
    ['{"a": "bad\\u123Z"}', 'Z', 'connection_json.expected_string'],
    ['{"a": "bad\n"}', '\n', 'connection_json.expected_string'],
    ['{"a": "bad', '', 'connection_json.expected_string'],
    ['{"a":', '', 'connection_json.expected_value'],
    ['{} true', 'true', 'connection_json.expected_end'],
    ['  [true]', '[', 'connection_parameters.object'],
    ['{"a":{"model":"ok"}, "\\u006dodel":2}', '"\\u006dodel"', 'connection_parameters.reserved_field'],
    ['{"x":"temperature", "temperature":0.5}', '"temperature":', 'connection_parameters.use_control'],
    ['{"items":[{},{"API-Key":"synthetic"}]}', '"API-Key"', 'connection_parameters.credentials'],
    ['{"items":[{"nested":{"__proto__":3}}]}', '"__proto__"', 'connection_parameters.unsafe_key'],
  ])('locates the first issue in %s', (text, target, key) => {
    const problem = customParameterError(draft(text));
    const offset = target ? text.indexOf(target) : text.length;
    expect(problem?.localized.key).toBe(key);
    expect(problem?.offset).toBe(offset);
    expect(() => parseConnectionParameters(draft(text))).toThrow(problem?.message);
  });

  it('preserves keys, order, strings and exact numbers when formatting', () => {
    const text = String.raw`{"9":[],"2":{},"num":9007199254740993,"num":2.00e-3,"s":"x, { \" }\u0061","rows":[{"k":true},null]}`;
    const expected = String.raw`{
    "9": [],
    "2": {},
    "num": 9007199254740993,
    "num": 2.00e-3,
    "s": "x, { \" }\u0061",
    "rows": [
        {
            "k": true
        },
        null
    ]
}`;
    expect(customParameterError(draft(text))).toBeUndefined();
    expect(formatJsonObject(text)).toBe(expected);
    expect(formatJsonObject(expected)).toBe(expected);
  });

  it('accepts blank drafts and enforces the combined size and depth limits', () => {
    expect(parseConnectionParameters(draft('  \n'))).toEqual({});
    const parameters = JSON.stringify({ x: 'x'.repeat(65528) });
    expect(customParameterError(draft(parameters))).toBeUndefined();
    expect(customParameterError({ parameters, builtInParameters: { numbers: { temperature: '1' } } })?.localized.key)
      .toBe('connection_parameters.size');
    const nested = '{"a":'.repeat(34) + '{}' + '}'.repeat(34);
    expect(customParameterError(draft(nested))).toMatchObject({
      offset: 32 * 5 + 1, localized: { key: 'connection_parameters.depth' },
    });
  });

  it('keeps field-specific diagnostics visible alongside an unfinished numeric control', () => {
    const input = { parameters: '{"stream":false}', builtInParameters: { numbers: { temperature: '-' } } };
    expect(customParameterError(input)?.localized.key).toBe('connection_parameters.reserved_field');
    expect(() => parseConnectionParameters(input)).toThrow(/temperature/);
  });
});
