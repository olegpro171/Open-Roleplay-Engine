import { jsonIndent, locateJson } from './json-source';
import { z } from 'zod';
import type { Connection } from '../shared/contracts';
import { customParametersSchema, isBuiltInParameter, numericConnectionParameters, reasoningEffortSchema, stopSchema, type NumericConnectionParameter } from '../shared/connection-parameters';
import type { LocalizedMessage } from '../shared/localization';
import { validationMessage } from '../shared/localization-validation';
import { LocalizedError, message } from './localization';

export type ConnectionField = NumericConnectionParameter | 'customParameters' | 'name' | 'endpoint' | 'apiKey' | 'model';

export class ConnectionFieldError extends LocalizedError {
  constructor(message: LocalizedMessage, readonly field: ConnectionField = 'customParameters', readonly offset = 0) {
    super(message);
  }
}

export class JsonObjectParseError extends ConnectionFieldError {
  constructor(message: LocalizedMessage, offset: number) {
    super(message, 'customParameters', offset);
  }
}

const numericParameterKey = z.object(numericConnectionParameters).keyof();
const numericKeys = numericParameterKey.options;
export const builtInParameterDraftSchema = z.strictObject({
  numbers: z.partialRecord(numericParameterKey, z.string()),
  stop: stopSchema.optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
});
export type BuiltInParameterDraft = z.infer<typeof builtInParameterDraftSchema>;
export type ConnectionParameterDraft = { builtInParameters: BuiltInParameterDraft; parameters: string };

export function connectionParameterDraft(values: Connection['customParameters']): ConnectionParameterDraft {
  const numbers: BuiltInParameterDraft['numbers'] = {};
  for (const key of numericKeys) {
    const value = values[key];
    if (value !== undefined) numbers[key] = String(value);
  }
  const custom = Object.entries(values).filter(([key]) => !isBuiltInParameter(key));
  return {
    builtInParameters: { numbers, stop: values.stop, reasoning_effort: values.reasoning_effort },
    parameters: JSON.stringify(Object.fromEntries(custom), null, jsonIndent),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const { offset, expected } = locateJson(text);
    throw new JsonObjectParseError(message(expected ? `connection_json.expected_${expected}` : 'libraries.custom_parameters_must_be_valid_json'), offset);
  }
}

export function recoverConnectionParameters(saved: Connection['customParameters'], draft: {
  parameters: string; builtInParameters?: BuiltInParameterDraft;
}): ConnectionParameterDraft {
  if (draft.builtInParameters) return { parameters: draft.parameters, builtInParameters: draft.builtInParameters };
  // Older browser drafts kept the entire edited map as JSON. Retain invalid text for correction.
  try {
    const previous = customParametersSchema.safeParse(parseJson(draft.parameters));
    if (previous.success) return connectionParameterDraft(previous.data);
  } catch (error) {
    if (!(error instanceof LocalizedError)) throw error;
  }
  return { ...connectionParameterDraft(saved), parameters: draft.parameters };
}

function parseCustomObject(parameters: string): Record<string, unknown> {
  const custom = parameters.trim() ? parseJson(parameters) : {};
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
    throw new JsonObjectParseError(message('connection_parameters.object'), locateJson(parameters).offset);
  }
  const builtInKey = Object.keys(custom).find(isBuiltInParameter);
  if (builtInKey) throw new ConnectionFieldError(message('connection_parameters.use_control', { field: builtInKey }), 'customParameters', locateJson(parameters, [builtInKey]).offset);
  return { ...custom };
}

function builtInValues(builtInParameters: BuiltInParameterDraft, allowIncomplete: boolean) {
  const values: Record<string, unknown> = {};
  for (const key of numericKeys) {
    const text = builtInParameters.numbers[key]?.trim();
    if (!text) continue;
    const schema = numericConnectionParameters[key];
    const value = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(text)
      ? Number(text.replace(',', '.')) : Number.NaN;
    if (!schema.safeParse(value).success) {
      if (allowIncomplete) continue;
      const range = { min: String(schema.minValue), max: String(schema.maxValue) };
      throw new ConnectionFieldError(message(key === 'seed' ? 'connection_parameters.invalid_seed' : 'connection_parameters.invalid_number', { field: key, ...range }), key);
    }
    values[key] = value;
  }
  if (builtInParameters.stop !== undefined) values.stop = builtInParameters.stop;
  if (builtInParameters.reasoning_effort !== undefined) values.reasoning_effort = builtInParameters.reasoning_effort;
  return values;
}

function validateParameterMap(values: Record<string, unknown>, source: string): Connection['customParameters'] {
  const parsed = customParametersSchema.safeParse(values);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue.path[0];
    const path = issue.code === 'custom' && Array.isArray(issue.params?.sourcePath) ? issue.params.sourcePath : issue.path;
    const { offset } = locateJson(source, path);
    if (typeof field === 'string' && issue.message === message('connection_parameters.reserved').fallback) {
      throw new ConnectionFieldError(message('connection_parameters.reserved_field', { field }), 'customParameters', offset);
    }
    throw new ConnectionFieldError(validationMessage(issue), 'customParameters', offset);
  }
  return parsed.data;
}

export function parseConnectionParameters({ builtInParameters, parameters }: ConnectionParameterDraft): Connection['customParameters'] {
  return validateParameterMap({ ...parseCustomObject(parameters), ...builtInValues(builtInParameters, false) }, parameters);
}

export function customParameterError({ builtInParameters, parameters }: ConnectionParameterDraft): ConnectionFieldError | undefined {
  try {
    // Include valid controls in the combined size limit while the user edits an unfinished number.
    validateParameterMap({ ...parseCustomObject(parameters), ...builtInValues(builtInParameters, true) }, parameters);
  } catch (error) {
    if (error instanceof ConnectionFieldError) return error;
    throw error;
  }
}
