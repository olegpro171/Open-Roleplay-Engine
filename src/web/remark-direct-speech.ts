import type { Nodes, PhrasingContent, Root, Text } from 'mdast';
import { directSpeechRanges, type SpeechOptions } from './direct-speech';

function formatInline(children: PhrasingContent[], options: SpeechOptions): PhrasingContent[] {
  const projection: string[] = [];
  const offsets = new Map<Text, number>();
  let length = 0;
  function collect(nodes: PhrasingContent[]) {
    for (const node of nodes) {
      if ('children' in node) collect(node.children);
      else {
        const value = node.type === 'text' ? node.value : node.type === 'break' ? '\n' : '\0';
        if (node.type === 'text') offsets.set(node, length);
        projection.push(value);
        length += value.length;
      }
    }
  }
  collect(children);
  const ranges = directSpeechRanges(projection.join(''), options);
  let rangeIndex = 0;

  function textNodes(value: string): PhrasingContent[] {
    // Chat prose preserves soft line breaks without turning all Markdown whitespace into preformatted text.
    return value.split('\n').flatMap((line, index): PhrasingContent[] => [
      ...(index ? [{ type: 'break' as const }] : []),
      ...(line ? [{ type: 'text' as const, value: line }] : []),
    ]);
  }

  function speechNodes(value: string): PhrasingContent[] {
    const nodes: PhrasingContent[] = [];
    // Detection still uses dashes as boundaries; presentation never applies speech styling to them.
    for (const [index, part] of value.split('—').entries()) {
      if (index) nodes.push({ type: 'text', value: '—' });
      if (part) nodes.push({
        type: 'strong',
        data: { hProperties: { className: ['direct-speech'] } },
        children: textNodes(part),
      });
    }
    return nodes;
  }

  function rewrite(nodes: PhrasingContent[]): PhrasingContent[] {
    return nodes.flatMap((node): PhrasingContent[] => {
      if ('children' in node) return [{ ...node, children: rewrite(node.children) }];
      if (node.type !== 'text') return [node];
      const start = offsets.get(node);
      if (start === undefined) return [node];
      const end = start + node.value.length;
      const result: PhrasingContent[] = [];
      let cursor = start;
      while (ranges[rangeIndex] && ranges[rangeIndex].end <= start) rangeIndex++;
      for (let index = rangeIndex; ranges[index] && ranges[index].start < end; index++) {
        const range = ranges[index];
        const speechStart = Math.max(start, range.start);
        const speechEnd = Math.min(end, range.end);
        result.push(...textNodes(node.value.slice(cursor - start, speechStart - start)));
        for (const speechNode of speechNodes(node.value.slice(speechStart - start, speechEnd - start))) result.push(speechNode);
        cursor = speechEnd;
      }
      result.push(...textNodes(node.value.slice(cursor - start)));
      return result;
    });
  }
  return rewrite(children);
}

/** Works on rendered prose, so markup delimiters, code and URL destinations are never speech. */
export function remarkDirectSpeech(options: SpeechOptions = {}) {
  return (tree: Root) => {
    function visit(node: Nodes) {
      if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
        node.children = formatInline(node.children, options);
      } else if ('children' in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}
