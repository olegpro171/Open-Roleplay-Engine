import { useSyncExternalStore } from 'react';
import { themeSchema, type Theme } from '../shared/appearance';

const listeners = new Set<() => void>();

export function useTheme(): Theme {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, initialTheme);
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  const chrome = getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = chrome;
  for (const listener of listeners) listener();
}

export function initialTheme(): Theme {
  const result = themeSchema.safeParse(document.documentElement.dataset.theme);
  return result.success ? result.data : 'dark';
}

export function themeSpeechColor(role: 'character' | 'persona'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--speech-${role}`).trim();
}
