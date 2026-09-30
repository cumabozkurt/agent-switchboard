import http from 'node:http';
import crypto from 'node:crypto';
import { openUrl } from './open.js';
import { t } from './i18n/index.js';

// OpenRouter'ın resmî OAuth PKCE akışı: tarayıcıda giriş yapılır, kullanıcıya ait bir API anahtarı döner.
// https://openrouter.ai/docs/use-cases/oauth-pkce
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function openRouterLogin({ port = 3000, fetchImpl = fetch, log = console.log } = {}) {
  const { verifier, challenge } = pkcePair();
  const callback = `http://localhost:${port}/callback`;
  const authUrl = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, callback);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const c = u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Agent Switchboard</title><h2 style="font-family:system-ui">${c ? t('oauth.done') : t('oauth.noCode')}</h2>`);
      server.close();
      c ? resolve(c) : reject(new Error(t('oauth.noCodeErr')));
    });
    server.once('error', e => reject(new Error(e.code === 'EADDRINUSE' ? t('oauth.portInUse', { port }) : e.message)));
    server.listen(port, '127.0.0.1', () => {
      log(t('oauth.opening', { url: authUrl }));
      openUrl(authUrl);
    });
    setTimeout(() => { server.close(); reject(new Error(t('oauth.timeout'))); }, 300000).unref();
  });
  const res = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' })
  });
  if (!res.ok) throw new Error(t('oauth.keyFailed', { status: res.status }));
  const { key } = await res.json();
  return key;
}
