import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { basicAuth } from 'hono/basic-auth';
import * as db from '../db.js';
import { getDb } from '../db.js';

export function createDashboard(port: number, env: Record<string, string>, config?: { defaultListId?: string }) {
  const app = new Hono();

  // Basic auth — only enabled when DASHBOARD_PASS is set
  const user = env.DASHBOARD_USER || 'admin';
  const pass = env.DASHBOARD_PASS;
  if (pass) {
    app.use('/*', basicAuth({ username: user, password: pass }));
  }

  const defaultListId = config?.defaultListId || '';

  // ─── API Routes ──────────────────────────────────────────────────────────────

  // GET /api/overview — dashboard overview data
  app.get('/api/overview', (c) => {
    const listId = c.req.query('list_id') || defaultListId;
    const days = parseInt(c.req.query('days') || '7');

    const consensus = db.getLatestConsensusForAllThemes(listId);
    const health = db.getScrapeHealth();
    const themes = db.getRecentThemes(listId, days * 24);

    return c.json({ consensus, health, themes });
  });

  // GET /api/consensus-history — consensus over time for trend chart
  app.get('/api/consensus-history', (c) => {
    const listId = c.req.query('list_id') || defaultListId;
    const theme = c.req.query('theme') || '';
    const days = parseInt(c.req.query('days') || '30');
    const snapshots = db.getConsensusSnapshots(listId, theme, days);
    return c.json({ snapshots });
  });

  // GET /api/themes — all themes with tweet counts
  app.get('/api/themes', (c) => {
    const listId = c.req.query('list_id') || defaultListId;
    const days = parseInt(c.req.query('days') || '7');
    const themes = db.getRecentThemes(listId, days * 24);
    return c.json({ themes });
  });

  // GET /api/theme/:name — deep dive on a theme
  app.get('/api/theme/:name', (c) => {
    const theme = decodeURIComponent(c.req.param('name'));
    const listId = c.req.query('list_id') || defaultListId;
    const days = parseInt(c.req.query('days') || '7');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const tweets = db.getTweetsByTheme(theme, since, listId || undefined);
    const snapshots = db.getConsensusSnapshots(listId, theme, days);

    return c.json({ theme, tweets, snapshots });
  });

  // GET /api/accounts — all accounts with stats
  app.get('/api/accounts', (c) => {
    const listId = c.req.query('list_id') || defaultListId;
    const accounts = db.getAllAccounts(listId);
    return c.json({ accounts });
  });

  // GET /api/account/:id — account detail with credibility + track record
  app.get('/api/account/:id', (c) => {
    const authorId = c.req.param('id');
    const stats = db.getAccountStats(authorId);
    const trackRecord = db.getAuthorTrackRecord(authorId);
    return c.json({ stats, track_record: trackRecord });
  });

  // GET /api/search — search tweets via FTS5
  app.get('/api/search', (c) => {
    const query = c.req.query('q') || '';
    const limit = parseInt(c.req.query('limit') || '50');
    // Sanitize FTS5 query syntax to prevent malformed/expensive queries
    const sanitized = query.replace(/['"():*^~]/g, ' ').trim();
    if (!sanitized) return c.json({ results: [] });
    const results = db.searchTweetsFTS(sanitized, Math.min(limit, 100));
    return c.json({ results });
  });

  // GET /api/health — system health
  app.get('/api/health', (c) => {
    const health = db.getScrapeHealth();
    return c.json({ health, timestamp: new Date().toISOString() });
  });

  // GET /api/track-records — top track records with hit rates
  app.get('/api/track-records', (c) => {
    const listId = c.req.query('list_id') || defaultListId;
    const minCalls = parseInt(c.req.query('min_calls') || '5');
    const records = db.getTopTrackRecords(listId, minCalls);
    return c.json({ records });
  });

  // GET /api/track-record/:authorId — single author track record
  app.get('/api/track-record/:authorId', (c) => {
    const authorId = c.req.param('authorId');
    const record = db.getAuthorTrackRecord(authorId);
    return c.json({ record });
  });

  // GET /api/theme-registry — all themes (core + discovered) with tweet counts
  app.get('/api/theme-registry', (c) => {
    const themes = db.getAllThemeDescriptions();
    const database = getDb();
    const registry = database.prepare(`
      SELECT theme, description, is_core, created_at, tweet_count
      FROM theme_registry ORDER BY tweet_count DESC
    `).all();
    return c.json({ themes: registry });
  });

  // GET /api/digests — recent digest snapshots with delta data
  app.get('/api/digests', (c) => {
    const listId = c.req.query('list_id') || defaultListId;
    const limit = parseInt(c.req.query('limit') || '10');
    const database = getDb();
    const digests = database.prepare(`
      SELECT id, list_id, generated_at, digest_type, tweet_count,
             themes_json, consensus_json, alerts_json, emerging_json
      FROM digest_snapshots
      WHERE list_id = ?
      ORDER BY generated_at DESC
      LIMIT ?
    `).all(listId, Math.min(limit, 50));
    return c.json({ digests });
  });

  // GET /api/digest/:id — single digest with full text
  app.get('/api/digest/:id', (c) => {
    const digestId = c.req.param('id');
    const database = getDb();
    const digest = database.prepare(`SELECT * FROM digest_snapshots WHERE id = ?`).get(digestId);
    return c.json({ digest: digest ?? null });
  });

  // ─── SPA: serve index.html for all non-API routes ────────────────────────────

  app.get('*', (c) => {
    const htmlPath = path.join(import.meta.dirname, 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    return c.html(html);
  });

  serve({ fetch: app.fetch, port });
  console.log(`[dashboard] Listening on http://localhost:${port}`);
  return app;
}
