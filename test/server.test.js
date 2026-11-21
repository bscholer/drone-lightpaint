import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  const server = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const proj = (name, n = 2) => ({ project: { name, waypoints: Array.from({ length: n }, (_, i) => ({ alt: i })) } });

test('create, list, get, update, delete', () =>
  withServer(async (call) => {
    const c = await call('POST', '/api/routes', proj('Heart', 3));
    assert.equal(c.status, 201);
    assert.equal(c.body.waypoints, 3);
    const id = c.body.id;
    assert.equal((await call('GET', '/api/routes')).body[0].name, 'Heart');
    assert.equal((await call('GET', `/api/routes/${id}`)).body.project.waypoints.length, 3);
    const u = await call('PUT', `/api/routes/${id}`, proj('Heart v2', 5));
    assert.equal(u.body.name, 'Heart v2');
    assert.equal((await call('GET', `/api/routes/${id}`)).body.waypoints, 5);
    assert.equal((await call('DELETE', `/api/routes/${id}`)).status, 204);
    assert.equal((await call('GET', `/api/routes/${id}`)).status, 404);
  }));

test('revisions: one per gap, identical saves ignored, cascade on delete', () =>
  withServer(async (call) => {
    const { body } = await call('POST', '/api/routes', proj('A'));
    const id = body.id;
    await call('PUT', `/api/routes/${id}`, proj('A', 3)); // first change snapshots the original
    await call('PUT', `/api/routes/${id}`, proj('A', 4)); // within the gap: no second snapshot
    await call('PUT', `/api/routes/${id}`, proj('A', 4)); // identical: no-op
    await call('PUT', `/api/routes/${id}`, { project: { waypoints: [{ alt: 0 }, { alt: 1 }, { alt: 2 }, { alt: 3 }], name: 'A' } }); // reordered keys: no-op
    const revs = (await call('GET', `/api/routes/${id}/revisions`)).body;
    assert.equal(revs.length, 1);
    assert.equal(revs[0].waypoints, 2);
    const rev = await call('GET', `/api/routes/${id}/revisions/${revs[0].id}`);
    assert.equal(rev.body.project.waypoints.length, 2);
    await call('DELETE', `/api/routes/${id}`);
    assert.equal((await call('GET', `/api/routes/${id}/revisions`)).status, 404);
  }));

test('validation and unknown routes', () =>
  withServer(async (call) => {
    assert.equal((await call('POST', '/api/routes', { project: { name: 'x' } })).status, 400);
    assert.equal((await call('POST', '/api/routes', {})).status, 400);
    assert.equal((await call('PUT', '/api/routes/99', proj('x'))).status, 404);
    assert.equal((await call('PATCH', '/api/routes')).status, 405);
    assert.equal((await call('GET', '/api/nope')).status, 404);
    const blank = await call('POST', '/api/routes', proj('   '));
    assert.equal(blank.body.name, 'Untitled route');
  }));

test('static files, healthz, no path traversal', () =>
  withServer(async (call) => {
    assert.equal((await call('GET', '/healthz')).body, 'ok\n');
    const idx = await call('GET', '/');
    assert.equal(idx.status, 200);
    assert.match(idx.body, /Firefly/);
    assert.equal((await call('GET', '/src/geo.js')).status, 200);
    assert.equal((await call('GET', '/..%2fserver.js')).status, 404);
    assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
  }));
