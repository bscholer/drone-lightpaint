import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 1024 * 1024;
const MAX_WAYPOINTS = 5000;
const REVISIONS_KEPT = 25;
// Autosave fires every few seconds while editing; keep restore points about a minute apart.
const REVISION_GAP_MS = 60_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'lightpaint.db'));
  db.exec('PRAGMA journal_mode = WAL');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < 1) {
    db.exec(`
      BEGIN;
      CREATE TABLE routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project TEXT NOT NULL,
        waypoints INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        project TEXT NOT NULL,
        waypoints INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE INDEX revisions_route ON revisions(route_id, id);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function validate(body) {
  const p = body?.project;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, 'project must be an object');
  if (!Array.isArray(p.waypoints)) throw new HttpError(400, 'project.waypoints must be an array');
  if (p.waypoints.length > MAX_WAYPOINTS) throw new HttpError(400, `at most ${MAX_WAYPOINTS} waypoints`);
  const name = String(p.name ?? '').trim().slice(0, 100) || 'Untitled route';
  const project = { ...p, name };
  return { name, project, text: JSON.stringify(project), waypoints: p.waypoints.length };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

const rowOut = (r) => ({ id: r.id, name: r.name, waypoints: r.waypoints, created_at: r.created_at, updated_at: r.updated_at });

function parseApi(req, url, db) {
  const m = url.pathname.match(/^\/api\/routes(?:\/(\d+))?(?:\/revisions(?:\/(\d+))?)?$/);
  if (!m) throw new HttpError(404, 'not found');
  const id = m[1] && Number(m[1]);
  const revId = m[2] && Number(m[2]);
  const isRevisions = url.pathname.includes('/revisions');
  const route = () => {
    const r = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'no such route');
    return r;
  };
  return { id, revId, isRevisions, route, method: req.method };
}

async function handleApi(req, res, url, db) {
  const { id, revId, isRevisions, route, method } = parseApi(req, url, db);

  if (!id) {
    if (method === 'GET') {
      const rows = db.prepare('SELECT id, name, waypoints, created_at, updated_at FROM routes ORDER BY updated_at DESC, id DESC').all();
      return json(res, 200, rows.map(rowOut));
    }
    if (method === 'POST') {
      const { name, text, waypoints } = validate(await readJson(req));
      const { lastInsertRowid } = db
        .prepare('INSERT INTO routes (name, project, waypoints) VALUES (?, ?, ?)')
        .run(name, text, waypoints);
      const r = db.prepare('SELECT * FROM routes WHERE id = ?').get(lastInsertRowid);
      return json(res, 201, { ...rowOut(r), project: JSON.parse(r.project) });
    }
    throw new HttpError(405, 'method not allowed');
  }

  if (isRevisions) {
    route();
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    if (!revId) {
      const rows = db
        .prepare('SELECT id, name, waypoints, created_at FROM revisions WHERE route_id = ? ORDER BY id DESC')
        .all(id);
      return json(res, 200, rows);
    }
    const rev = db.prepare('SELECT * FROM revisions WHERE id = ? AND route_id = ?').get(revId, id);
    if (!rev) throw new HttpError(404, 'no such revision');
    return json(res, 200, { id: rev.id, name: rev.name, created_at: rev.created_at, project: JSON.parse(rev.project) });
  }

  if (method === 'GET') {
    const r = route();
    return json(res, 200, { ...rowOut(r), project: JSON.parse(r.project) });
  }
  if (method === 'PUT') {
    const prev = route();
    const { name, project, text, waypoints } = validate(await readJson(req));
    // Compare parsed, not as text: key order differs between clients and must not count as an edit.
    if (!isDeepStrictEqual(project, JSON.parse(prev.project))) {
      const last = db.prepare('SELECT created_at FROM revisions WHERE route_id = ? ORDER BY id DESC LIMIT 1').get(id);
      if (!last || Date.now() - Date.parse(last.created_at) >= REVISION_GAP_MS) {
        db.prepare('INSERT INTO revisions (route_id, name, project, waypoints) VALUES (?, ?, ?, ?)').run(
          id, prev.name, prev.project, prev.waypoints,
        );
        db.prepare(
          'DELETE FROM revisions WHERE route_id = ? AND id NOT IN (SELECT id FROM revisions WHERE route_id = ? ORDER BY id DESC LIMIT ?)',
        ).run(id, id, REVISIONS_KEPT);
      }
      db.prepare(
        "UPDATE routes SET name = ?, project = ?, waypoints = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
      ).run(name, text, waypoints, id);
    }
    const r = route();
    return json(res, 200, rowOut(r));
  }
  if (method === 'DELETE') {
    route();
    db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    return send(res, 204, '');
  }
  throw new HttpError(405, 'method not allowed');
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'bad path');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not found');
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw new HttpError(404, 'not found');
  }
  send(res, 200, req.method === 'HEAD' ? '' : data, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

export function createServer({ dataDir }) {
  const db = openDb(dataDir);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain' });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, db);
      return serveStatic(req, res, url);
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      json(res, status, { error: status === 500 ? 'internal error' : e.message });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = process.env.DATA_DIR ?? './data';
  createServer({ dataDir }).listen(port, () => console.log(`drone-lightpaint on :${port}, data in ${dataDir}`));
}
