export type PromptDiagnostic = {
  code: string;
  message: string;
  target: 'prompts' | 'characters' | 'lorebooks';
  itemId: string;
};
