import { speechColorSchema } from '../shared/appearance';

export type HslColor = { hue: number; saturation: number; lightness: number };

export function hexToHsl(value: string): HslColor {
  const hex = speechColorSchema.parse(value);
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const highest = Math.max(red, green, blue);
  const lowest = Math.min(red, green, blue);
  const difference = highest - lowest;
  const lightness = (highest + lowest) / 2;
  if (difference === 0) return { hue: 0, saturation: 0, lightness: lightness * 100 };
  const sector = highest === red ? (green - blue) / difference
    : highest === green ? (blue - red) / difference + 2
      : (red - green) / difference + 4;
  return {
    hue: ((sector * 60) + 360) % 360,
    saturation: difference / (1 - Math.abs(2 * lightness - 1)) * 100,
    lightness: lightness * 100,
  };
}

export function hslToHex({ hue, saturation, lightness }: HslColor): string {
  const light = lightness / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation / 100;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
  const offset = light - chroma / 2;
  const channels = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
      : sector < 3 ? [0, chroma, secondary]
        : sector < 4 ? [0, secondary, chroma]
          : sector < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  return `#${channels.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
}
