import { spawn } from 'node:child_process';

// Command used to open a URL in the default browser, without a shell.
// Only http(s) URLs are accepted: FileProtocolHandler/open/xdg-open would also launch local files.
export function openCommand(url, platform = process.platform) {
  if (!/^https?:\/\//i.test(String(url))) return null;
  if (platform === 'darwin') return ['open', [url]];
  // cmd /c start would interpret & in URLs (e.g. OAuth query strings); rundll32 takes the URL verbatim.
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export function openUrl(url) {
  const cmd = openCommand(url);
  if (!cmd) return;
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is also printed, so it can be opened manually */ }
}
