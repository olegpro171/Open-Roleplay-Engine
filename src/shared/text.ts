// Remove blank boundary lines while preserving indentation and spacing in the story.
export function trimBoundaryNewlines(text: string): string {
  return text.replace(/^(?:[\t ]*[\r\n])+|(?:[\r\n][\t ]*)+$/g, '');
}
