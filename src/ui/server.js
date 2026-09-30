import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from '../core.js';
import { openUrl } from '../open.js';
import { openRouterLogin } from '../oauth.js';
import { startRouter } from '../router.js';

const page = fileURLToPath(new URL('./index.html', import.meta.url));
const isLocalHost = h => /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(h || '');

// Yalnızca 127.0.0.1'e bağlanır ve her oturumda rastgele bir belirteç ister;
// böylece başka bir web sitesi anahtarlarınıza veya ayarlarınıza erişemez.
export async function startUi({ port = 4567, open = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  let router = null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
    if (!isLocalHost(req.headers.host)) return json(403, { error: 'Yalnızca yerel erişim' }); // DNS yeniden bağlama koruması
    if (u.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      });
      res.end(fs.readFileSync(page, 'utf8'));
      return;
    }
    if (!u.pathname.startsWith('/api/')) return json(404, { error: 'yok' });
    if (req.method !== 'POST') return json(405, { error: 'Yalnızca POST' });
    const given = String(req.headers['x-aswitch-token'] || '');
    if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(403, { error: 'Geçersiz oturum belirteci' });
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      switch (u.pathname) {
        case '/api/status': return json(200, { ...core.status(), routerRunning: !!router, routerPort: router?.address()?.port || null });
        case '/api/providers': return json(200, core.providers());
        case '/api/models': return json(200, await core.models(body.provider, { refresh: !!body.refresh }));
        case '/api/key': core.setKey(body.provider, body.key || ''); return json(200, { ok: true });
        case '/api/use': return json(200, await core.useProvider({ provider: body.provider, model: body.model, fastModel: body.fastModel, tools: body.tools, codexKey: body.codexKey }));
        case '/api/official': return json(200, core.useOfficial(body.tools));
        case '/api/restore': return json(200, core.restore(body.tools));
        case '/api/provider': core.addProvider(body.id, body); return json(200, { ok: true });
        case '/api/login/openrouter': core.setKey('openrouter', await openRouterLogin()); return json(200, { ok: true });
        case '/api/router/start': {
          if (!router) {
            const t = core.routerTargets();
            router = await startRouter({ port: t.port, targets: () => core.routerTargets() });
          }
          return json(200, { ok: true });
        }
        case '/api/router/stop': if (router) { router.close(); router = null; } return json(200, { ok: true });
        default: return json(404, { error: 'yok' });
      }
    } catch (e) { return json(400, { error: e.message }); }
  });
  server.on('close', () => { if (router) { router.close(); router = null; } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  if (open) openUrl(url);
  return { server, url, token };
}
