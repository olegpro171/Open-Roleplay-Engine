import { useSyncExternalStore } from 'react';
import { themeSchema, type Theme } from '../shared/appearance';
import { faviconLinks, installIconLinks } from '../shared/favicon';

export const brandMarkUrl: Record<Theme, string> = {
  dark: '/icons/ore-mark-dark.svg',
  light: '/icons/ore-mark-light.svg',
  'midnight-black': '/icons/ore-mark-midnight-black.svg',
  porcelain: '/icons/ore-mark-porcelain.svg',
};

const listeners = new Set<() => void>();

export function useTheme(): Theme {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, initialTheme);
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  const chrome = getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = chrome;
  const favicon = faviconLinks(theme);
  const install = installIconLinks(theme);
  const links = [
    ['link[rel="icon"][type="image/svg+xml"]', favicon.svg],
    ['link[rel="icon"][type="image/png"]', favicon.png],
    ['link[rel="apple-touch-icon"]', install.appleTouch],
    ['link[rel="manifest"]', install.manifest],
  ];
  for (const [selector, href] of links) {
    const link = document.querySelector<HTMLLinkElement>(selector);
    if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
  }
  for (const listener of listeners) listener();
}

export function initialTheme(): Theme {
  const result = themeSchema.safeParse(document.documentElement.dataset.theme);
  return result.success ? result.data : 'dark';
}

export function themeSpeechColor(role: 'character' | 'persona'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--speech-${role}`).trim();
}
