import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from '../src/web/ChatMarkdown';
import { russianDialogueRegressions } from './support/russian-dialogue-fixtures';

function render(text: string, speech?: Parameters<typeof ChatMarkdown>[0]['speech']) {
  return renderToStaticMarkup(createElement(ChatMarkdown, { text, speech }));
}

describe('chat Markdown presentation', () => {
  it('styles opening, resuming and internal em dashes within detected speech', () => {
    const html = render('— Привет, — сказала Мара. — «Стой — подожди».');
    const highlighted = Array.from(html.matchAll(/<strong class="direct-speech">([^<]*)<\/strong>/gu), match => match[1]);
    expect(highlighted).toEqual(['— Привет,', '— «Стой — подожди».']);
    expect(html).toContain('<strong class="direct-speech">— Привет,</strong> — сказала Мара. ');
    expect(html).toContain('<strong class="direct-speech">— «Стой — подожди».</strong>');
  });

  it('styles em dashes inside quotations when Russian detection is disabled', () => {
    const html = render('Mara said "*Wait — please*."', { russianDialogue: false });
    expect(html).toContain('<em><strong class="direct-speech">Wait — please</strong></em>');
    expect(html).toContain('<strong class="direct-speech">.&quot;</strong>');
  });

  it.each(russianDialogueRegressions)('renders the reported author clause as plain prose: $narration', fixture => {
    const html = render(fixture.text);
    const highlighted = Array.from(html.matchAll(/<strong class="direct-speech">([^<]*)<\/strong>/gu), match => match[1]);
    expect(highlighted).toEqual(fixture.speech);
    expect(html).toContain(fixture.narration);
  });

  it('renders common Markdown and GFM without changing the source', () => {
    const source = '# Arrival\n\n*Quiet* and **ready**, ~~late~~.\nNext line.\n\n- First\n- Second\n\n> A note.\n\n| Who | Where |\n| --- | --- |\n| Mara | Home |\n\n- [x] Arrived';
    const html = render(source);
    for (const expected of ['<h1>Arrival</h1>', '<em>Quiet</em>', '<strong>ready</strong>', '<del>late</del>', '<br/>', '<ul>', '<li>First</li>', '<blockquote>', '<table>', '<td>Mara</td>', 'type="checkbox"', 'disabled=""']) expect(html).toContain(expected);
    expect(render(source)).toBe(html);
  });

  it('keeps quoted speech styled across inline formatting and link labels', () => {
    const html = render('Mara asked "**Stay** *here* [with me](https://example.com/?q=%22plain%22)".');
    expect(html).toContain('Mara asked <strong class="direct-speech">&quot;</strong>');
    expect(html).toContain('<strong><strong class="direct-speech">Stay</strong></strong>');
    expect(html).toContain('<em><strong class="direct-speech">here</strong></em>');
    expect(html).toContain('<strong class="direct-speech">with me</strong></a>');
    expect(html).toContain('href="https://example.com/?q=%22plain%22"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('preserves code literally and never treats it as dialogue or bridges through it', () => {
    const html = render('`"inline"`\n\n```text\n— Привет, — сказала Мара.\n"quoted"\n```\n\n"before `code` after"');
    expect(html).toContain('<code>&quot;inline&quot;</code>');
    expect(html).toContain('— Привет, — сказала Мара.\n&quot;quoted&quot;');
    expect(html).not.toContain('class="direct-speech"');
  });

  it('styles speech on separate soft lines and can disable only the Russian heuristic', () => {
    const text = '— Привет, — сказала Мара.\n— Останься.\n«До встречи».';
    const html = render(text);
    expect(html).toContain('<strong class="direct-speech">— Привет,</strong> — сказала Мара.<br/>');
    expect(html).toContain('<strong class="direct-speech">— Останься.</strong><br/>');
    const disabled = render(text, { russianDialogue: false });
    expect(disabled).not.toContain('class="direct-speech">—');
    expect(disabled).toContain('<strong class="direct-speech">«До встречи»</strong>');
  });

  it('handles incomplete streaming Markdown and quotes before rendering the completed span', () => {
    expect(render('Mara said "*Hello')).not.toContain('class="direct-speech"');
    const completed = render('Mara said "*Hello*, traveler."');
    expect(completed).toContain('<em><strong class="direct-speech">Hello</strong></em>');
    expect(completed).toContain('<strong class="direct-speech">, traveler.&quot;</strong>');
  });

  it('renders untrusted HTML as text, blocks unsafe URLs and renders safe Markdown images', () => {
    const html = render('<script>alert("bad")</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n[bad](javascript:alert%281%29) [data](data:text/html,bad) [relative](/api/logout) [safe](https://example.com)\n\n![portrait](https://example.com/portrait.png)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toMatch(/<img[^>]*src="https:\/\/example.com\/portrait.png"/u);
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toMatch(/<script\b/iu);
    expect(html).not.toContain('<img src="https://example.com/tracker"');
    expect(html).not.toMatch(/href="(?:javascript:|data:|\/api)/iu);
  });

  it('supports empty alt text and reference images while blocking local and unsafe image destinations', () => {
    const html = render('![](https://example.com/empty.png)\n\n![scene][picture]\n\n[picture]: http://example.com/scene.png\n\n![local](/api/logout) ![mail](mailto:bad@example.com) ![data](data:image/png;base64,AA) ![script](javascript:alert%281%29)');
    expect(html.match(/<img\b/gu)).toHaveLength(2);
    expect(html).toContain('src="https://example.com/empty.png"');
    expect(html).toContain('src="http://example.com/scene.png"');
    expect(html).toContain('[Image: local]');
    expect(html).not.toMatch(/src="(?:\/|mailto:|data:|javascript:)/iu);
  });
});
