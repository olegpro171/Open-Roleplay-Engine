import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import themePalettes from './fixtures/theme-palettes.json';
import { themeSchema, type Theme } from '../src/shared/appearance';
import approvedDarkPalette from './fixtures/approved-dark-palette.json';

// Approved by the user on 2026-10-26. This fixture locks values and derivations,
// not a target count; update it only for an explicitly agreed palette change.
const approvedRoles = new Map(Object.entries({ ...approvedDarkPalette, ...themePalettes.darkAdditions }));
const approvedBaseColors = Object.fromEntries([...approvedRoles]
  .filter(([name]) => name.startsWith('--palette-'))
  .map(([name, value]) => [name.slice('--palette-'.length), value]));

const root = fileURLToPath(new URL('../', import.meta.url));
const web = join(root, 'src/web');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const colorLiteral = /#[\da-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi;
const cssColorNames = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey
lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy
oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato
turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/);
const namedColorLiteral = new RegExp(`(?:^|[\\s:(,'"])(?:${cssColorNames.join('|')})(?=[;\\s,)'"}]|$)`, 'gi');

function unapprovedLiterals(source: string, kind: 'css' | 'ts' = 'css', scope: 'palette' | 'component' = 'palette'): string[] {
  const values: string[] = [];
  if (kind === 'css') values.push(source);
  else {
    // Inspect quoted values and skip comments, so channel variables named
    // red/green/blue are not confused with CSS color strings. This guard is not
    // a TS parser; deliberate encoding/bypasses remain forbidden by the policy.
    const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g;
    for (const token of source.matchAll(tokens)) {
      if (token[1]) values.push(token[0].slice(1, -1));
    }
  }
  return values.flatMap(value => [
    ...value.matchAll(colorLiteral),
    ...value.matchAll(namedColorLiteral),
    ...(scope === 'component' ? value.matchAll(/\bcolor-mix\s*\(/gi) : []),
  ].map(match => match[0]));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(css|tsx?)$/.test(entry.name) ? [file] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function paletteDefinitions(source: string): [string, string][] {
  return [...withoutComments(source).matchAll(/(--[\w-]+):\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value]);
}

function paletteChanges(definitions: [string, string][], approved = approvedRoles): string[] {
  const actual = new Map(definitions);
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');
  const changes: string[] = [];
  for (const [name, value] of approved) {
    const current = actual.get(name);
    if (current === undefined || normalize(current) !== normalize(value)) changes.push(`Changed or removed approved role: ${name}`);
  }
  for (const [name, value] of actual) {
    if (approved.has(name)) continue;
    const alias = /^var\((--[\w-]+)\)$/.exec(normalize(value));
    if (name.startsWith('--palette-') || !alias || !approved.has(alias[1])) changes.push(`Unapproved new color definition: ${name}`);
  }
  if (definitions.length !== actual.size) changes.push('Duplicate palette definitions');
  return changes;
}

function paletteSource(theme: Theme): string {
  const source = withoutComments(read('src/web/palette.css'));
  const rule = /(:root(?:\[data-theme="[\w-]+"\])?)\s*\{([^}]+)\}/g;
  const blocks = [...source.matchAll(rule)];
  expect(source.replace(rule, '').trim(), 'Keep all palette definitions in the checked theme rules').toBe('');
  expect(blocks.map(match => match[1])).toEqual(themeSchema.options.map(theme => theme === 'dark' ? ':root' : `:root[data-theme="${theme}"]`));
  const block = blocks.find(match => match[1] === (theme === 'dark' ? ':root' : `:root[data-theme="${theme}"]`));
  if (!block) throw new Error(`Missing theme ${theme}`);
  const body = block[2];
  expect(body.replace(/--[\w-]+:\s*[^;]+;|color-scheme:\s*(?:dark|light);/g, '').trim(), 'Only centralized palette declarations and color-scheme belong here').toBe('');
  return body;
}

// Picker swatches and HSL ramps represent selectable user colors, not UI chrome.
// Exempt those two declarations, not the rest of the component's styling.
function withoutPickerData(source: string): string {
  return source
    .replace(/const presetGroups:[\s\S]*?\n\];/, '')
    .replace(/const channels:[\s\S]*?\n  \];/, '');
}

describe('interface palette approval boundary', () => {
  it('keeps independent colors in the approved base palette', () => {
    expect(Object.keys(themePalettes.darkAdditions).filter(name => Object.hasOwn(approvedDarkPalette, name))).toEqual([]);
    const source = paletteSource('dark');
    const definitions = [...source.matchAll(/--palette-([\w-]+):\s*(#[\da-f]{6});/g)];
    expect(Object.fromEntries(definitions.map(([, name, color]) => [name, color]))).toEqual(approvedBaseColors);
    expect(unapprovedLiterals(source)).toEqual(definitions.map(([, , color]) => color));
  });

  it('locks approved role values and derivations while allowing semantic aliases', () => {
    expect(paletteChanges(paletteDefinitions(paletteSource('dark')))).toEqual([]);
    const approved: [string, string][] = [...approvedRoles];
    expect(paletteChanges(approved.map(([name, value]) => [name, value.replaceAll(',', ',\n  ')]))).toEqual([]);
    expect(paletteChanges([...approved, ['--new-semantic-role', 'var(--text)']])).toEqual([]);
    expect(paletteChanges(approved.map(([name, value]) => [name, name === '--header-highlight' ? value.replace('75%', '76%') : value])))
      .toEqual(['Changed or removed approved role: --header-highlight']);
    expect(paletteChanges([...approved, ['--new-shade', 'color-mix(in srgb, var(--accent) 5%, var(--page))']]))
      .toEqual(['Unapproved new color definition: --new-shade']);
    expect(paletteChanges(approved.filter(([name]) => name !== '--surface'))).toContain('Changed or removed approved role: --surface');
    expect(paletteChanges([...approved, ['--text', 'var(--muted)']])).toContain('Duplicate palette definitions');
  });

  it.each([['light', themePalettes.lightOverrides], ['midnight-black', themePalettes.midnightBlackOverrides]] as const)('locks %s overrides and supplies every shared role', (theme, approved) => {
    const overrides = paletteDefinitions(paletteSource(theme));
    expect(paletteChanges(overrides, new Map(Object.entries(approved)))).toEqual([]);
    const dark = new Map(paletteDefinitions(paletteSource('dark')));
    const themed = new Map([...dark, ...overrides]);
    expect([...themed.keys()].sort()).toEqual([...dark.keys()].sort());
  });

  it('requires web components and styles to reuse palette roles', () => {
    const failures: string[] = [];
    for (const file of sourceFiles(web)) {
      if (file === join(web, 'palette.css')) continue;
      let source = withoutComments(readFileSync(file, 'utf8'));
      if (file === join(web, 'ColorPicker.tsx')) source = withoutPickerData(source);
      // SVG mask black controls alpha only; it never supplies a visible UI color.
      const visibleSource = source.replace("stroke='black'", '');
      const literals = unapprovedLiterals(visibleSource, file.endsWith('.css') ? 'css' : 'ts', 'component');
      if (literals.length) failures.push(`${relative(root, file)}: ${literals.join(', ')}`);
      if (/--palette-[\w-]+['"]?\s*:/.test(source)) failures.push(`${relative(root, file)}: base palette redefinition`);
    }
    expect(failures, 'Reuse src/web/palette.css roles; see docs/PALETTE.md before adding colors.').toEqual([]);
  });

  it('detects literal additions in CSS, editor styles and gradients without rejecting role references', () => {
    for (const source of ['color: #123456;', "color: 'salmon'", 'border: 1px solid rebeccapurple;', 'background: rgb(1 2 3);', 'background: linear-gradient(red, blue);', 'color: oklch(50% .2 30);']) {
      expect(unapprovedLiterals(source), source).not.toEqual([]);
    }
    expect(unapprovedLiterals('color: var(--text); background: color-mix(in srgb, var(--accent) 20%, transparent);')).toEqual([]);
    expect(unapprovedLiterals('background: color-mix(in srgb, var(--accent) 20%, transparent);', 'css', 'component')).not.toEqual([]);
    expect(unapprovedLiterals('const red = 1, green = 2, blue = 3; // gray and black\n', 'ts')).toEqual([]);
    expect(unapprovedLiterals("const style = { color: 'salmon', background: '#123456' };", 'ts')).toHaveLength(2);
  });

  it('keeps palette roles resolvable without circular or missing references', () => {
    for (const theme of themeSchema.options) {
      const definitions = new Map([...paletteDefinitions(paletteSource('dark')), ...(theme === 'dark' ? [] : paletteDefinitions(paletteSource(theme)))]);
      function visit(name: string, path: string[]): void {
        expect(path, `Circular palette reference: ${[...path, name].join(' → ')}`).not.toContain(name);
        const value = definitions.get(name);
        if (value === undefined) throw new Error(`Missing palette role ${name}`);
        for (const [, dependency] of value.matchAll(/var\((--[\w-]+)\)/g)) visit(dependency, [...path, name]);
      }
      for (const name of definitions.keys()) visit(name, []);
    }
  });

  it('resolves variables used by styles and editor components, including runtime speech and text scale', () => {
    const source = sourceFiles(web).map(file => withoutComments(readFileSync(file, 'utf8'))).join('\n');
    const defined = new Set([...source.matchAll(/(--[\w-]+)['"]?\s*:/g)].map(([, name]) => name));
    const used = new Set([...source.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name));
    expect([...used].filter(name => !defined.has(name))).toEqual([]);
  });

  it('keeps initial browser chrome aligned with the dark palette', () => {
    const manifest: { background_color: string; theme_color: string } = JSON.parse(read('public/site.webmanifest'));
    expect(manifest.background_color).toBe(approvedBaseColors.page);
    expect(manifest.theme_color).toBe(approvedBaseColors.chrome);
    expect(read('index.html')).toContain(`<meta name="theme-color" content="${approvedBaseColors.chrome}"`);
  });
});
