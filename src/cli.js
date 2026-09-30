// CLI yardımcıları (test edilebilsin diye bin/ dışında).

// Değer almayan bayraklar: ardından gelen sözcüğü değer olarak yutmazlar.
const BOOLEAN = new Set(['refresh', 'no-open', 'all', 'help', 'version', 'json']);

export function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out[k] = a.slice(eq + 1);
      else if (BOOLEAN.has(k)) out[k] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function envLine(shell, k, v) {
  if (shell === 'powershell') return `$env:${k}='${v.replace(/'/g, "''")}'`;
  if (shell === 'cmd') return `set "${k}=${v}"`;
  if (shell === 'fish') return `set -gx ${k} '${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `export ${k}='${v.replace(/'/g, `'\\''`)}'`;
}

export function defaultShell() {
  if (process.platform !== 'win32') return /fish$/.test(process.env.SHELL || '') ? 'fish' : 'sh';
  if (process.env.SHELL || process.env.MSYSTEM) return 'sh'; // Git Bash / MSYS
  return 'powershell';
}

