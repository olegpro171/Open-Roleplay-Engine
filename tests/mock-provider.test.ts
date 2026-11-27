import { request } from 'node:http';
import { expect, it } from 'vitest';
import { startMockProvider } from './support/mock-provider.js';

it.each(['о', '🕯'])('captures a request with %s split across network chunks', async (character) => {
  const mock = await startMockProvider();
  try {
    const body = { messages: [{ role: 'user', content: character }] };
    const bytes = Buffer.from(JSON.stringify(body));
    const split = bytes.indexOf(Buffer.from(character)) + 1;

    await new Promise<void>((resolve, reject) => {
      const client = request(`${mock.url}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      }, (response) => {
        response.on('error', reject);
        response.on('end', resolve);
        response.resume();
      });
      client.on('error', reject);
      mock.server.once('request', (incoming) => {
        // Release the remaining bytes only after the mock receives the first chunk.
        incoming.once('data', () => client.end(bytes.subarray(split)));
      });
      client.write(bytes.subarray(0, split));
    });

    expect(mock.requests.map((entry) => entry.body)).toEqual([body]);
  } finally {
    await mock.close();
  }
});
