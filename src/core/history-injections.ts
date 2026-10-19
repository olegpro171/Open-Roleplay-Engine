/** Depth is measured against original nonblank history, never other injections. */
export function injectHistory<T>(history: T[], nonblank: (entry: T) => boolean, injections: { depth: number; entry: T }[]): T[] {
  const eligible = history.flatMap((entry, index) => nonblank(entry) ? [index] : []);
  const insertions = new Map<number, T[]>();
  for (const { depth, entry } of injections) {
    const index = depth === 0 ? (eligible.at(-1) ?? -1) + 1 : eligible[Math.max(0, eligible.length - depth)] ?? 0;
    const group = insertions.get(index) ?? [];
    group.push(entry);
    insertions.set(index, group);
  }
  return history.flatMap((entry, index) => [...insertions.get(index) ?? [], entry]).concat(insertions.get(history.length) ?? []);
}
