# Audit report — v0.2.0

Date: 2026-09-30 / 2026-10-01 (Europe/Istanbul). Scope: the whole repository (CLI, core, targets, router, OAuth, UI server, UI page, Electron shell, packaging, CI, docs).

Method: code review file by file plus end-to-end runs in a **sandboxed home folder** (never the real `~/.claude` or `~/.codex`):
- `npm test` (Node `node:test`, 103 tests) on Linux, and on macOS/Windows/Linux × Node 18/20/22 in CI.
- CLI runs in both languages (`--lang`, `ASWITCH_LANG`, `aswitch lang`), including broken JSON, unreachable endpoints and unknown commands.
- The real Electron app under Xvfb driven by Playwright (`desktop/test/e2e.mjs`, 30 checks), including live model lists from OpenRouter and OpenCode Zen/Go.
- Official docs re-checked on the web: Claude Code settings/env vars, Codex `config.toml` reference, OpenCode Zen/Go endpoints.

Legend: **Fixed** = changed in v0.2.0 with a test · **OK** = verified, no change · **Known** = documented limitation.

## (a) First-time, non-technical user

| Finding | Status |
|---|---|
| No guidance on first launch; empty cards were confusing. | **Fixed** — welcome box with 3 steps on Overview when nothing is configured. |
| Several features only existed in the CLI (router, backups restore, custom providers, env help). A non-technical user needed a terminal. | **Fixed** — tabs for Router, Custom providers, Restore & backups, Environment, Settings (see (2) in the README). E2E-tested. |
| Apply result said "router needed" but gave no button; router state could go stale. | **Fixed** — *Start router* button in the result, auto-start option (on by default), result re-rendered on every status refresh. |
| Apply result showed a stray `null` (DOM `replaceChildren(null)` prints "null"). | **Fixed** — `fill()` helper drops empty parts; verified on screenshots. |
| UI only in Turkish. | **Fixed** — full English/Turkish, OS-language default. |
| Unsigned builds trigger SmartScreen/Gatekeeper. | **Known** — step-by-step bypass in README. |

## (b) Power user / CLI ergonomics

| Finding | Status |
|---|---|
| `status` printed raw JSON. | **Fixed** — readable summary; `--json` keeps the machine format. |
| No way to restore a single backup from the CLI. | **Fixed** — `aswitch backups restore <id> <file>` (current file is snapshotted first; ids validated against the backup list). |
| Unknown command dumped the entire help. | **Fixed** — one-line hint, exit code 1 (test). |
| Network errors said only "fetch failed". | **Fixed** — cause shown (`ECONNREFUSED`, `ENOTFOUND` …) (test). |
| A custom `--port` was forgotten after switching to a provider that doesn't need the router. | **Fixed** — port kept in config (test). `--port` added to help. |
| `Ctrl+C` on `aswitch router` / `aswitch ui` could leave sockets open. | **Fixed** — graceful close with `closeAllConnections`. |
| `--lang` must not swallow arguments passed through `aswitch run`. | **Fixed** — `--lang` is only parsed before `run` (test). |

## (c) Security

| Finding | Status |
|---|---|
| UI API accepted any content type → a cross-site `text/plain` form POST could reach it if the token leaked. | **Fixed** — `application/json` required (415 otherwise), token + `Host` checks kept, 1 MB body limit (tests). |
| UI used `innerHTML` in places. | **Fixed** — all DOM built with a text-only `h()` helper; test asserts no `innerHTML` in the page. Boot data injected with `<` escaped. Stricter CSP. |
| Adding a custom provider with a preset id (e.g. `openai`) and removing it deleted the preset's saved key. | **Fixed** — preset ids rejected (test). |
| `~/.agent-switchboard`, `backups/`, `originals/` were created with default permissions; backups can contain the Claude token. | **Fixed** — created `0700` on macOS/Linux (test). `config.json` and Claude `settings.json` stay `0600`. |
| Electron: links/`window.open` could navigate inside the app window. | **Fixed** — all new windows and navigations go to the system browser. |
| Router exposure: binds `127.0.0.1`, rejects `Origin` and non-local `Host` (DNS rebinding). | **OK** (existing tests). |
| Command injection: `run` uses no shell on POSIX; Windows quoting for `cmd.exe`. URL opening uses no shell. | **OK / Known** — `%VAR%` inside arguments can still be expanded by `cmd.exe` on Windows (documented). |
| Keys are not encrypted at rest. | **Known** — documented; OS keychain on the roadmap. |

## (d) Cross-platform

| Finding | Status |
|---|---|
| Windows: `cmd /c start <url>` breaks URLs containing `&` → **OpenRouter OAuth could not open correctly on Windows**. | **Fixed** — `rundll32 url.dll,FileProtocolHandler <url>`; only `http(s)` URLs are opened (test). |
| CRLF: a CRLF checkout/pack of `bin/aswitch.js` would break the shebang on macOS/Linux. | **Fixed** — `.gitattributes` forces LF; test checks the shebang line. |
| Codex `config.toml` with CRLF endings. | **OK** — line endings preserved (existing test). |
| Atomic rename on Windows when the file is locked (EPERM/EBUSY). | **OK** — retry then direct write (existing). |
| Paths: `%USERPROFILE%\.claude`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`. | **OK** — match official docs. |
| CI runs the full suite on Windows, macOS, Linux × Node 18/20/22. | **OK** |

## (e) Correctness vs official docs (re-verified 2026-09-30)

| Item | Status |
|---|---|
| Claude Code: user settings `~/.claude/settings.json`, `CLAUDE_CONFIG_DIR`, `env` block; shell-exported variables override file values; `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_AUTH_TOKEN` (Bearer); `ANTHROPIC_SMALL_FAST_MODEL` deprecated and not written. | **OK** — FAQ now mentions shell overrides and project-level settings. |
| Codex: `model_provider`, `[model_providers.<id>]` with `base_url`, `env_key`, `env_key_instructions`, `wire_api` (only `"responses"`), `auth` command table (not combined with `env_key`); reserved ids `openai`, `ollama`, `lmstudio` (aswitch uses `aswitch`). | **OK** |
| OpenCode: `opencode.json`/`.jsonc`, `{env:VAR}`, Zen `opencode` / Go `opencode-go` endpoints per model. | **OK** |

## (f) Protocol translation fidelity

| Finding | Status |
|---|---|
| Messages ⇄ Chat, Messages ⇄ Responses, Responses ⇄ Chat: text, tool calls/results, images, streaming (SSE), usage, stop reasons, errors mapped to the caller's error shape. | **OK** — 28 router tests (`router.test.js`, `router-responses.test.js`). |
| Text injected into prompts (image notes, tool placeholders, error prefix) changed with the UI language. | **Fixed** — fixed English constants; only human-facing errors are localized. |
| Reasoning/thinking not translated; `stop_sequences` and hosted tools not forwarded; `count_tokens` is an estimate; Codex cannot use `/messages`-only models. | **Known** — documented. |

## (g) Failure and recovery

| Finding | Status |
|---|---|
| Corrupt/unparseable config: never overwritten, clear error naming the file; status shows the tool as "unreadable". | **OK** (tests); now localized. |
| Router port already in use → friendly error; an aswitch router already running on that port is detected as *external* instead of failing. | **Fixed** (tests). |
| OAuth callback port busy → friendly error. | **Fixed** |
| Desktop quit with router running → router stopped before exit (3 s cap); relaunch restores language and auto-starts router if needed. | **Fixed** — E2E-verified (port freed after quit). |
| Second desktop instance started a second server. | **Fixed** — single-instance lock; the first window is focused (E2E). |
| Partial writes. | **OK** — temp file + rename. |
| Restore after files were deleted/created. | **OK** — files that did not exist are removed again (tests). |

## (h) i18n completeness

| Finding | Status |
|---|---|
| All strings in code were Turkish. | **Fixed** — 300+ keys in `en.js`/`tr.js`. |
| Tests: identical keys and placeholders in both catalogs; every `t('…')` key used in code exists (dynamic key families checked explicitly); no Turkish characters left in code outside catalogs; resolution order; CLI `--lang`/env/persist. | **Fixed** (`test/i18n.test.js`). |
| Electron menu/title follow the language live; `<html lang>` set. | **Fixed** (E2E). |

## (i) Packaging, release, CI

| Finding | Status |
|---|---|
| npm `files` missing `README.tr.md`/`CHANGELOG.md`; description Turkish-only. | **Fixed** (test). |
| Root and desktop versions must match. | **OK** (test) — both 0.2.0. |
| `desktop/package-lock.json` generated locally. | **Fixed** — ignored, like before, to keep CI resolution unchanged. |
| E2E script for the desktop app. | **Fixed** — `npm run e2e` in `desktop/`. |
| Release workflow creates the release once, then 3 OS builds upload 8 assets. | **OK** |
| Linux arm64 / signed builds. | **Known** — roadmap. |

## (j) Accessibility

| Finding | Status |
|---|---|
| Tabs lacked ARIA roles and keyboard navigation. | **Fixed** — `tablist`/`tab`/`tabpanel`, roving tabindex, arrows/Home/End (E2E). |
| Results only visual. | **Fixed** — `aria-live` activity log; labelled inputs; visible focus. |
| Status conveyed by colour only. | **Fixed** — badges carry text ("Running", "Stopped"). |

## (k) Docs accuracy

| Finding | Status |
|---|---|
| README was Turkish-only and partly outdated (no UI walkthrough, no matrices). | **Fixed** — new `README.md` (EN) + `README.tr.md`, real screenshots only, commands verified against `--help`, UI labels verified against the catalogs, file examples produced by real runs. |
| Test checks that both READMEs link to each other and only reference existing screenshots; CHANGELOG contains the current version. | **Fixed** (`packaging.test.js`). |

## Not verified

- Real model replies through real paid API keys (demo keys were used; public model lists were fetched live).
- The Electron UI on macOS and Windows (built by CI, UI-tested on Linux only).
- Linux arm64 builds (not produced).
