import { serve } from '@hono/node-server';
import { createApp } from './server/app.js';

const port = 9797;

serve({ fetch: createApp({}).fetch, port }, () => {
  console.log(`warrden listening on port ${port}`);
});
