import { z } from 'zod';
import { message } from './localization.js';

export const numericConnectionParameters = {
  temperature: z.number().min(0).max(2),
  top_p: z.number().min(0).max(1),
  presence_penalty: z.number().min(-2).max(2),
  frequency_penalty: z.number().min(-2).max(2),
  seed: z.number().int(),
};
export type NumericConnectionParameter = keyof typeof numericConnectionParameters;
export const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const stopSequenceMaxLength = 200;
const stopSequence = z.string().max(stopSequenceMaxLength);
export const stopSequenceLimit = 4;
export const stopSchema = z.union([stopSequence, z.array(stopSequence).max(stopSequenceLimit)]);

export const builtInParametersSchema = z.strictObject({
  temperature: numericConnectionParameters.temperature.optional(),
  top_p: numericConnectionParameters.top_p.optional(),
  presence_penalty: numericConnectionParameters.presence_penalty.optional(),
  frequency_penalty: numericConnectionParameters.frequency_penalty.optional(),
  seed: numericConnectionParameters.seed.optional(),
  stop: stopSchema.optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
});

export function isBuiltInParameter(key: string): key is keyof typeof builtInParametersSchema.shape {
  return Object.hasOwn(builtInParametersSchema.shape, key);
}

const reservedFields = new Set([
  'model', 'messages', 'stream', 'stream_options',
  'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'max_new_tokens',
  'n', 'tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call', 'modalities', 'audio',
]);
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const credentialKeys = new Set(['apikey', 'authorization', 'accesstoken', 'authtoken', 'bearertoken', 'clientsecret', 'password']);
const parameterBytes = 64 * 1024;
const parameterDepth = 32;

type ParameterKeyIssue = { kind: 'credentials' | 'unsafe_key' | 'depth'; path: (string | number)[] };
function invalidParameterKey(value: unknown, depth: number): ParameterKeyIssue | undefined {
  if (typeof value !== 'object' || value === null) return;
  if (depth > parameterDepth) return { kind: 'depth', path: [] };
  for (const [key, child] of Object.entries(value)) {
    if (unsafeKeys.has(key)) return { kind: 'unsafe_key', path: [key] };
    if (credentialKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return { kind: 'credentials', path: [key] };
    const issue = invalidParameterKey(child, depth + 1);
    if (issue) {
      issue.path.unshift(Array.isArray(value) ? Number(key) : key);
      return issue;
    }
  }
}

// Check raw keys before Zod parses objects, since parsers may drop special keys.
const parameterObjectSchema = z.custom<Record<string, unknown>>(value => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}, message('connection_parameters.object').fallback).superRefine((value, ctx) => {
  const issue = invalidParameterKey(value, 0);
  if (issue) {
    ctx.addIssue({ code: 'custom', message: message(`connection_parameters.${issue.kind}`).fallback, params: { sourcePath: issue.path } });
    return;
  }
  for (const key of Object.keys(value)) {
    if (reservedFields.has(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: message('connection_parameters.reserved').fallback });
    }
  }
});

export const customParametersSchema = parameterObjectSchema.pipe(
  z.object(builtInParametersSchema.shape).catchall(z.json()),
).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= parameterBytes,
  message('connection_parameters.size').fallback);
