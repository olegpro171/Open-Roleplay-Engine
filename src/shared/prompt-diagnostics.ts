export type PromptDiagnostic = {
  localized?: import('./localization.js').LocalizedMessage;
  code: string;
  message: string;
  target: 'prompts' | 'characters' | 'lorebooks';
  itemId: string;
};
