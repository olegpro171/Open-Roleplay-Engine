import type { Theme } from './appearance.js';

const iconArtwork: Record<Theme, string> = {
  dark: 'peach-bold',
  light: 'light-bold',
  'midnight-black': 'midnight-black-bold',
  porcelain: 'porcelain-bold',
};

export function faviconLinks(theme: Theme) {
  const base = `/icons/favicon-${iconArtwork[theme]}`;
  return {
    svg: `${base}.svg?v=4`,
    png: theme === 'dark' ? '/icons/icon-32.png?v=4' : `${base}.png?v=4`,
  };
}

export function installIconLinks(theme: Theme) {
  return {
    manifest: theme === 'dark' ? '/site.webmanifest' : `/site-${theme}.webmanifest`,
    appleTouch: `/icons/app-${iconArtwork[theme]}-touch-180.png`,
  };
}
