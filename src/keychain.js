// Optional OS keychain storage for API keys, without native modules:
//   macOS   → `security` (secret passed hex-encoded over stdin with `security -i`, never on the command line)
//   Windows → PowerShell + advapi32 CredWrite/CredRead/CredDelete (script and secret over stdin)
//   Linux   → `secret-tool` (libsecret; secret over stdin)
// config.json then only holds the marker "@keychain" for that provider; the real key lives in the OS store.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const KEYCHAIN_REF = '@keychain';
export const SERVICE = 'agent-switchboard';
const cache = new Map();

function onPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (process.env.PATH || '').split(path.delimiter).some(d => d && exts.some(e => { try { return fs.statSync(path.join(d, bin + e)).isFile(); } catch { return false; } }));
}

export function keychainBackend() {
  const forced = process.env.ASWITCH_KEYCHAIN_BACKEND; // tests / unusual setups
  if (forced) return forced === 'none' ? null : forced;
  if (process.platform === 'darwin') return onPath('security') || fs.existsSync('/usr/bin/security') ? 'macos' : null;
  if (process.platform === 'win32') return 'windows';
  return onPath('secret-tool') ? 'linux' : null;
}

const run = (cmd, args, input) => spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 20000, windowsHide: true });
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const safeAcct = a => { if (!/^[A-Za-z0-9._-]{1,64}$/.test(a)) throw new Error('bad keychain account'); return a; };

const WIN_CS = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class AswCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr c);
  public static bool Write(string target, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret); var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.Persist = 2;
    c.UserName = "agent-switchboard"; c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    try { return CredWrite(ref c, 0); } finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); } finally { CredFree(p); } }
  public static bool Delete(string target) { return CredDelete(target, 1, 0); }
}
"@
`;
function winPs(body) {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], WIN_CS + body + '\n');
  return r;
}
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const psStr = s => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

export function kcSet(account, secret, backend = keychainBackend()) {
  const acct = safeAcct(account);
  if (!secret) return kcDelete(acct, backend);
  let r;
  if (backend === 'macos') r = run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${acct} -l ${SERVICE} -X ${hex(secret)}\n`);
  else if (backend === 'windows') r = winPs(`if ([AswCred]::Write(${psStr(`${SERVICE}:${acct}`)}, ${psStr(secret)})) { 'ok' } else { exit 3 }`);
  else if (backend === 'linux') r = run('secret-tool', ['store', `--label=${SERVICE} ${acct}`, 'service', SERVICE, 'account', acct], secret);
  else throw new Error('no keychain');
  if (r.error || r.status !== 0) throw new Error(`keychain write failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
  cache.set(acct, secret);
}

export function kcGet(account, backend = keychainBackend()) {
  const acct = safeAcct(account);
  if (cache.has(acct)) return cache.get(acct);
  let r;
  if (backend === 'macos') r = run('security', ['find-generic-password', '-s', SERVICE, '-a', acct, '-w']);
  else if (backend === 'windows') r = winPs(`$v = [AswCred]::Read(${psStr(`${SERVICE}:${acct}`)}); if ($v -eq $null) { exit 4 }; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))`);
  else if (backend === 'linux') r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', acct]);
  else return '';
  if (r.error || r.status !== 0) return '';
  const v = backend === 'windows' ? Buffer.from(r.stdout.trim(), 'base64').toString('utf8') : r.stdout.replace(/\r?\n$/, '');
  if (v) cache.set(acct, v);
  return v;
}

export function kcDelete(account, backend = keychainBackend()) {
  const acct = safeAcct(account);
  cache.delete(acct);
  if (backend === 'macos') run('security', ['delete-generic-password', '-s', SERVICE, '-a', acct]);
  else if (backend === 'windows') winPs(`[void][AswCred]::Delete(${psStr(`${SERVICE}:${acct}`)})`);
  else if (backend === 'linux') run('secret-tool', ['clear', 'service', SERVICE, 'account', acct]);
}

export function clearKeychainCache() { cache.clear(); }
