import { expect, it } from 'vitest';
import { hexToHsl, hslToHex } from '../src/web/hsl-color';

it('converts known HSL colors, hue wraparound and achromatic boundaries to opaque hex', () => {
  for (const [hue, hex] of [[0, '#ff0000'], [60, '#ffff00'], [120, '#00ff00'], [180, '#00ffff'], [240, '#0000ff'], [300, '#ff00ff'], [360, '#ff0000']] as const) {
    expect(hslToHex({ hue, saturation: 100, lightness: 50 })).toBe(hex);
  }
  expect(hslToHex({ hue: 280, saturation: 0, lightness: 50 })).toBe('#808080');
  expect(hslToHex({ hue: 280, saturation: 100, lightness: 0 })).toBe('#000000');
  expect(hslToHex({ hue: 280, saturation: 100, lightness: 100 })).toBe('#ffffff');
  expect(hslToHex({ hue: 210, saturation: 60, lightness: 80 })).toBe('#adcceb');
  expect(hexToHsl('#00FF00')).toEqual({ hue: 120, saturation: 100, lightness: 50 });
  expect(hexToHsl('#ffffff')).toEqual({ hue: 0, saturation: 0, lightness: 100 });
});

it('preserves exact hex bytes through HSL conversion, including arbitrary saved colors', () => {
  const values = ['#a8c9f0', '#eeaa88', '#010101', '#fefefe', '#000001', '#fffffe', '#123456'];
  for (let red = 0; red <= 255; red += 17) {
    for (let green = 0; green <= 255; green += 17) {
      for (let blue = 0; blue <= 255; blue += 17) {
        values.push(`#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`);
      }
    }
  }
  for (const hex of values) expect(hslToHex(hexToHsl(hex))).toBe(hex);
});
