import type { Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { trimBoundaryNewlines } from '../shared/text.js';

const parser = unified().use(remarkParse).use(remarkGfm);
const cache = new Map<string, string>();
let cachedCharacters = 0;

function imageOnlyLink(node: Nodes): boolean {
  return (node.type === 'link' || node.type === 'linkReference') && node.children.length > 0
    && node.children.every(child => child.type === 'image' || child.type === 'imageReference');
}

/** Remove rendered Markdown images without reserializing or changing surrounding prose/code. */
export function modelText(text: string): string {
  if (!text.includes('![')) return text;
  const saved = cache.get(text);
  if (saved !== undefined) {
    cache.delete(text);
    cache.set(text, saved);
    return saved;
  }
  const tree = parser.parse(text);
  const imageReferences = new Set<string>();
  const linkReferences = new Set<string>();
  function references(node: Nodes) {
    if (node.type === 'imageReference') imageReferences.add(node.identifier);
    if (node.type === 'linkReference' && !imageOnlyLink(node)) linkReferences.add(node.identifier);
    // A reference destination used only to wrap an image is display-only too.
    if (node.type === 'linkReference' && imageOnlyLink(node)) imageReferences.add(node.identifier);
    if ('children' in node) node.children.forEach(references);
  }
  references(tree);
  const ranges: { start: number; end: number }[] = [];
  function visit(node: Nodes) {
    const image = node.type === 'image' || node.type === 'imageReference';
    const imageDefinition = node.type === 'definition' && imageReferences.has(node.identifier) && !linkReferences.has(node.identifier);
    if (image || imageOnlyLink(node) || imageDefinition) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    } else if ('children' in node) node.children.forEach(visit);
  }
  visit(tree);
  const pieces: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    pieces.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  pieces.push(text.slice(cursor));
  const stripped = ranges.length ? trimBoundaryNewlines(pieces.join('')) : text;
  const result = ranges.length && !stripped.trim() ? '' : stripped;
  // Repeated previews/preparation reuse bounded results rather than reparsing entire histories.
  if (text.length + result.length <= 100_000) {
    cache.set(text, result);
    cachedCharacters += text.length + result.length;
    while (cache.size > 256 || cachedCharacters > 1_000_000) {
      const oldest = cache.entries().next().value;
      if (!oldest) break;
      cache.delete(oldest[0]);
      cachedCharacters -= oldest[0].length + oldest[1].length;
    }
  }
  return result;
}
