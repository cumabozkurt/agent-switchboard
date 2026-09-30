import net from 'node:net';
import { t } from './i18n/index.js';

// Outbound URL policy for everything aswitch fetches with a key (model lists, endpoint test, router upstreams):
//  • only http: and https:, no user:password@ in the URL;
//  • plain http only to loopback, private (RFC 1918 / ULA / link-local) or *.local / *.lan / *.internal hosts,
//    so a saved API key is never sent unencrypted over the internet.
export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || /\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (net.isIPv6(h)) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:127.');
  // Single-label names (e.g. "gateway", "host.docker.internal" handled above) resolve on the local network.
  return !h.includes('.');
}

export function checkOutboundUrl(raw, field = 'url') {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error(t('err.badUrl', { field, url: String(raw) })); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(t('err.badUrl', { field, url: String(raw) }));
  if (u.username || u.password) throw new Error(t('err.urlCredentials', { field }));
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) throw new Error(t('err.insecureUrl', { field, url: u.origin }));
  return u.toString();
}

export function checkPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(t('err.badPort', { port: String(port) }));
  return n;
}
