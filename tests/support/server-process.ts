import { createApp } from '../../src/server/app.js';
const { app } = await createApp({ database: process.env.ROLEPLAY_TEST_DATABASE! });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ address });
