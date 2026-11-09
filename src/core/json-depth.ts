export const maxSavedJsonDepth = 100;

// Only the current path needs stack space. Imported JSON can be very wide.
export function withinJsonDepth(value: unknown, remaining = maxSavedJsonDepth): boolean {
  if (remaining < 0) return false;
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) {
    return value.every(item => withinJsonDepth(item, remaining - 1));
  }
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      const child: unknown = Reflect.get(value, key);
      if (!withinJsonDepth(child, remaining - 1)) return false;
    }
  }
  return true;
}
