// Remove blank boundary lines while preserving indentation and spacing in the story.
export function trimBoundaryNewlines(text: string): string {
  return text.replace(/^(?:[\t ]*[\r\n])+|(?:[\r\n][\t ]*)+$/g, '');
}

export function appendContinuation(reply: string, addition: string): string {
  // Imported replies may already end with a paragraph break. Keep their bytes.
  if (/(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n|\r|\n)[\t ]*$/.test(reply)) return reply + addition;
  if (reply.endsWith('\r')) return reply + '\r' + addition;
  return reply + (/[\r\n][\t ]*$/.test(reply) ? '\n' : '\n\n') + addition;
}
