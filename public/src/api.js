// Thin client for the route store in server.js. Relative URLs so it works
// behind any path prefix; Cloudflare Access cookies ride along automatically.

async function call(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body && JSON.stringify(body),
    keepalive: method === 'PUT', // lets a save finish while the tab is closing
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export const api = {
  list: () => call('api/routes'),
  get: (id) => call(`api/routes/${id}`),
  create: (project) => call('api/routes', 'POST', { project }),
  save: (id, project) => call(`api/routes/${id}`, 'PUT', { project }),
  remove: (id) => call(`api/routes/${id}`, 'DELETE'),
  revisions: (id) => call(`api/routes/${id}/revisions`),
  revision: (id, rev) => call(`api/routes/${id}/revisions/${rev}`),
};
