export function replaceNameMacros(text: string, user: string, character: string): string {
  return text.replace(/{{\s*(user|char)\s*}}/gi, (_match, key: string) => key.toLowerCase() === 'user' ? user : character);
}
