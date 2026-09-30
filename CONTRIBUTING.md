# Contributing · Katkı

Thanks for helping! Türkçe açıklama aşağıda.

## Setup

```bash
git clone https://github.com/cumabozkurt/agent-switchboard
cd agent-switchboard
npm test                         # node:test, no dependencies (Node ≥ 18)
node bin/aswitch.js --help
```

Desktop app:

```bash
cd desktop
npm install
npm start                        # copies ../src into app-src/ and starts Electron
npm run e2e                      # end-to-end UI test (Linux: xvfb-run -a npm run e2e)
npm run dist                     # build installers for this OS
```

## Ground rules

- **Never touch your real config while developing.** Tests and manual runs should use a sandbox:
  `ASWITCH_HOME_OVERRIDE=/tmp/x ASWITCH_DIR=/tmp/x/.as XDG_CONFIG_HOME=/tmp/x/.config` and unset `CODEX_HOME` / `CLAUDE_CONFIG_DIR`. `test/helpers.js` does this for you.
- **Zero runtime dependencies** for the CLI (`package.json` has no `dependencies`). Dev tooling goes to `desktop/` only.
- **Every user-facing string goes through `t()`** and must exist in both `src/i18n/en.js` and `src/i18n/tr.js` with the same placeholders. `test/i18n.test.js` fails otherwise. Text sent to models stays English.
- **Only verified facts** about Claude Code / Codex / OpenCode / providers. Link the official docs in the PR.
- Never write to a config file that cannot be parsed; keep writes atomic (`writeFileSafe`).
- UI: build DOM with the `h()` helper (no `innerHTML`), keep controls labelled and keyboard reachable.
- Add a test for every bug fix.

## Adding a provider

Add an entry to `PRESETS` in `src/providers.js` (base URLs from official docs, `codexWire`, `modelsUrl`, `keyEnv`, `keyUrl`), a description `provider.<id>` in both catalogs, and a test in `test/targets.test.js`.

## Adding a language

Copy `src/i18n/en.js` to `src/i18n/<code>.js`, translate the values, register it in `src/i18n/index.js`. Run `npm test`.

## Commits and PRs

Small focused PRs, a clear description, `npm test` green. Update `CHANGELOG.md` under *Unreleased*.

---

## Türkçe

- Geliştirirken **gerçek ayar dosyalarınıza dokunmayın**; yukarıdaki yalıtılmış ortam değişkenlerini kullanın.
- CLI'ın **çalışma zamanı bağımlılığı yoktur**; öyle kalmalı.
- Kullanıcıya görünen her metin `t()` ile yazılır ve `en.js` ile `tr.js` içinde aynı yer tutucularla bulunmalıdır.
- Araçlar ve sağlayıcılar hakkında yalnızca **resmî belgelerle doğrulanmış** bilgiler kullanın.
- Her hata düzeltmesine bir test ekleyin. `npm test` yeşil olmadan PR açmayın.
