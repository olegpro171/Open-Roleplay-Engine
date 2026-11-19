import { z } from 'zod';
import type { Connection } from '../shared/contracts';
import { customParametersSchema, isBuiltInParameter, numericConnectionParameters, reasoningEffortSchema, stopSchema } from '../shared/connection-parameters';
import { validationMessage } from '../shared/localization-validation';
import { LocalizedError, message } from './localization';

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
    parameters: JSON.stringify(Object.fromEntries(custom), null, 2),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new LocalizedError(message('libraries.custom_parameters_must_be_valid_json'));
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

export function parseConnectionParameters({ builtInParameters, parameters }: ConnectionParameterDraft): Connection['customParameters'] {
  const custom = parameters.trim() ? parseJson(parameters) : {};
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
    throw new LocalizedError(message('connection_parameters.object'));
  }
  const builtInKey = Object.keys(custom).find(isBuiltInParameter);
  if (builtInKey) throw new LocalizedError(message('connection_parameters.use_control', { field: builtInKey }));
  const values: Record<string, unknown> = { ...custom };
  for (const key of numericKeys) {
    const text = builtInParameters.numbers[key]?.trim();
    if (!text) continue;
    const schema = numericConnectionParameters[key];
    const value = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(text)
      ? Number(text.replace(',', '.')) : Number.NaN;
    if (!schema.safeParse(value).success) {
      const range = { min: String(schema.minValue), max: String(schema.maxValue) };
      throw new LocalizedError(message(key === 'seed' ? 'connection_parameters.invalid_seed' : 'connection_parameters.invalid_number', { field: key, ...range }));
    }
    values[key] = value;
  }
  if (builtInParameters.stop !== undefined) values.stop = builtInParameters.stop;
  if (builtInParameters.reasoning_effort !== undefined) values.reasoning_effort = builtInParameters.reasoning_effort;
  const parsed = customParametersSchema.safeParse(values);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const field = issue.path[0];
    if (typeof field === 'string' && issue.message === message('connection_parameters.reserved').fallback) {
      throw new LocalizedError(message('connection_parameters.reserved_field', { field }));
    }
    throw new LocalizedError(validationMessage(issue));
  }
  return parsed.data;
}
