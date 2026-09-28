import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, resolveChat } from './config.js';
import { getEmbedder, resolveEmbedding } from './indexing/embed.js';
import { getDb, sweepExpired } from './db.js';
import { router } from './http/routes.js';
import { sweepJobs } from './http/jobs.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Caddy terminates TLS in front of this
app.use(express.json({ limit: '16kb' }));

app.use(router);

// The widget bundle, served with a long cache. Built by `npm run build`.
const widgetPath = resolve(process.cwd(), '../widget/dist/widget.js');
app.get('/widget.js', (_req, res) => {
  if (!existsSync(widgetPath)) {
    res.status(404).type('application/javascript')
      .send('console.error("[kleio] widget bundle not built: run npm run build in widget/");');
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.type('application/javascript').sendFile(widgetPath);
});

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'No such endpoint.' });
});

getDb(); // run migrations on boot

const swept = sweepExpired();
if (swept > 0) console.log(`[sweep] removed ${swept} expired session(s) at boot`);

setInterval(() => {
  try {
    const n = sweepExpired();
    sweepJobs();
    if (n > 0) console.log(`[sweep] removed ${n} expired session(s)`);
  } catch (e) {
    console.error('[sweep] failed', e);
  }
}, 60 * 60 * 1000).unref();

const server = app.listen(config.port, () => {
  console.log(`site-chat api on :${config.port}`);
  console.log(`  db          ${config.databasePath}`);
  const chat = resolveChat();
  console.log(`  chat        ${chat.provider}/${chat.model}`);
  const embedding = resolveEmbedding();
  console.log(`  embeddings  ${embedding.provider}/${embedding.model}`);
  const missing = [
    config.chatProvider === 'anthropic' && !config.anthropicApiKey && 'ANTHROPIC_API_KEY',
    config.chatProvider === 'gemini' && !config.geminiApiKey && 'GEMINI_API_KEY',
    config.embeddingProvider === 'openai' && !config.openaiApiKey && 'OPENAI_API_KEY',
    config.embeddingProvider === 'voyage' && !config.voyageApiKey && 'VOYAGE_API_KEY',
    config.embeddingProvider === 'gemini' && !config.geminiApiKey && 'GEMINI_API_KEY',
    !config.adminToken && 'ADMIN_TOKEN (/admin/stats disabled)',
    config.ipHashSalt === 'dev-salt-do-not-use-in-prod' && 'IP_HASH_SALT (using dev default)',
  ].filter(Boolean);
  if (missing.length > 0) console.warn(`  ! not set: ${missing.join(', ')}`);

  // A local model is downloaded on first use and takes a moment to load.
  // Doing that now means the first visitor after a deploy does not wait for it.
  if (embedding.provider === 'local') {
    const started = Date.now();
    getEmbedder().embed(['warm up'], 'query').then(
      () => console.log(`  embeddings  local model ready in ${Date.now() - started}ms`),
      (e: unknown) => console.error('  ! local embedding model failed to load:', e),
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
