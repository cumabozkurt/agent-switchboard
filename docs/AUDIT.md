# Audit report — v0.4.0

Date: 2026-10-01 (Europe/Istanbul). Scope: everything new in 0.4.0:
- load balancing, circuit breaker and scenario routing
- `aswitch://` share links
- optional OS keychain
- the outbound URL policy
- Electron 44
- Linux arm64
- the real Gemini CLI test and the offline e2e
- the remaining CodeQL alerts

The v0.3.0 and v0.2.0 reports below still apply to the unchanged parts.

Method:
- `npm test`: 157 tests (156 plus a real OS-keychain round-trip that runs on macOS/Windows), on macOS/Windows/Linux × Node 18/20/22 in CI.
- The real Electron 44 app driven by Playwright (`desktop/test/e2e.mjs`, 54 checks; 51 on Windows) on **Linux, macOS and Windows** in CI. It uses a local mock upstream, so no internet is needed.
- The **real Gemini CLI 0.62.0** (`@google/gemini-cli` from npm) run headless through the router in a throwaway HOME (`scripts/gemini-cli-e2e.mjs`, CI job `gemini-cli`).
- The Electron 33 → 44 breaking-change notes were read against `desktop/main.js`, and a full `release.yml` build ran on the Dependabot branch.
- Sandbox as before: `ASWITCH_HOME_OVERRIDE`, `ASWITCH_DIR`, `XDG_CONFIG_HOME`; `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `GEMINI_CLI_HOME` unset. The real `~/.claude`, `~/.codex`, `~/.gemini` and OpenCode configs were never touched.

| Area | Finding | Status |
|---|---|---|
| Electron 44 | Drops macOS 12. In Electron 42+ the `electron` package no longer downloads its binary in postinstall (lazy download) | **Handled**: README says macOS 13+. The e2e (which runs the downloaded binary) and the builds pass on all 3 OSes. No API used by `main.js` changed |
| Router | Balance/scenario/fallback targets must keep their own model even when the tool asks for another (e.g. haiku) | **Fixed during development**: those targets carry `fixedModel`; test |
| Router | Should a 4xx client error (400/401/404) count toward the breaker? | **No**: only 429, 408, 5xx and network errors count, so a bad request cannot knock out a healthy provider; test |
| Router | If every candidate's circuit is open | The router still tries them (in order) rather than failing without a request; test |
| Router | Mid-stream replay on another provider | **Not implemented on purpose**. Fallback happens only before the first byte reaches the tool. Afterwards the tool has shown part of the answer and may already be running a tool call, so a replay would duplicate output and could run tools twice. Documented in README → Limitations |
| Router | A tool connected directly would silently ignore a new fallback/balance/scenario setting | **Fixed**: `ensureRouted` moves it to the router; the CLI prints a notice and the desktop app auto-starts the router |
| Links | Links could smuggle keys, point at attacker hosts, or overwrite a provider that already has a saved key | Key-like parameters and `keys` blocks are dropped with a warning. URLs pass the outbound policy. Existing entries are kept unless overwrite is chosen, and if a base URL changes on overwrite, the saved key is removed (same rule as import). Nothing is applied without confirmation (CLI prompt/`--yes`, desktop dialog). Max 16 KB. Tests + e2e |
| Links | The desktop app must not register the scheme during development or tests | Registered only when `app.isPackaged` (and never with `ASWITCH_NO_PROTOCOL`). The deb's desktop file carries `MimeType=x-scheme-handler/aswitch` (checked in the arm64 deb built by CI) |
| Desktop | A second instance started by a link could briefly start its own panel server before quitting | **Fixed**: `create()` runs only in the primary instance. The e2e starts a second instance with a link and checks that it exits and that the first window shows the dialog |
| Keychain | Secrets must not appear on a command line (visible in `ps`) | macOS: `security -i` reads the command from stdin (hex-encoded data). Windows: the script is passed as `-EncodedCommand` without the secret, and the secret goes over stdin as base64. Linux: `secret-tool store` reads stdin |
| Keychain | macOS `security -w` prints non-ASCII passwords as hex | **Fixed after the first CI run**: values are stored as `b64:<base64>` and decoded on read. The real round-trip test (with `ü`) now passes on macOS and Windows runners |
| Keychain | Windows: `-Command -` with a here-string did not store anything | **Fixed**: `-EncodedCommand` + `$ErrorActionPreference = 'Stop'`; the real round-trip test passes |
| Keychain | Claude Code in direct mode still needs its token in `settings.json` | **Documented**. `--via-router` writes only a placeholder there |
| Netguard | Plain-http URLs to public hosts would send keys unencrypted | **Refused** (http allowed only for loopback, RFC 1918/ULA/link-local, `.local`/`.lan`/`.internal`/`.home.arpa`, single-label). URLs with `user:pass@` are refused. Tests + e2e (the UI rejects `http://proxy.example.com`) |
| Model lists | Remote lists were stored as-is | Sanitized: ≤ 5000 entries, ids ≤ 200 chars without control characters, finite non-negative numbers; test |
| Gemini CLI | Gemini CLI 0.62 loads `~/.gemini/.env` **only in trusted folders**, and in headless mode refuses untrusted folders (exit 55) | **Documented + hint after apply**: trust the folder, use `aswitch run gemini`, or `--skip-trust` / `GEMINI_CLI_TRUST_WORKSPACE=true` for headless runs. With that, the real CLI works end to end: streaming, tool declarations translated, `list_directory` round-trip, usage logged |
| UI | Models tab: a late answer for the previously selected provider could clear the current table (seen once the e2e went offline) | **Fixed**: stale answers are ignored |
| e2e (Windows) | Playwright's `_electron.launch` hangs on Windows with Electron 42+: it attaches to the Node inspector and the app never reaches "ready". The same binary starts normally without Playwright (checked in a diagnostic CI run); another project reports the same with Electron 42 | **Worked around**: on Windows the e2e starts Electron itself, drives the window with `chromium.connectOverCDP`, and evaluates main-process code through the Node inspector (hooks only with `ASWITCH_E2E_HOOKS=1`). All 54 checks pass on Linux on that path too (`E2E_CDP=1`). On Windows 51 run, because the 3 keychain UI checks use a stand-in `secret-tool` that exists only on Linux/macOS; the real Windows Credential Manager round-trip runs in `npm test` |
| e2e | The breaker save raced a policy reload; the second-instance check raced Playwright's debugger attach | **Fixed** (re-fill + poll `/health`; the second instance is now a plain child process) |

## CodeQL

After the v0.3.0 triage, alerts #6–#12 were open. Each was re-checked for v0.4.0:

| # | Rule | Location | Decision |
|---|---|---|---|
| 6 | `js/file-system-race` | `test/cli.test.js` | **Dismissed: used in tests.** The test writes into its own `mkdtemp` folder to check that `writeFileSafe` keeps the file mode; no other process can race it |
| 7 | `js/file-access-to-http` | `src/models.js` | **Dismissed: won't fix.** Sending the saved key to that provider's model-list URL is the feature. The URL now passes `netguard.checkOutboundUrl` |
| 8 | `js/file-access-to-http` | `src/core.js` (endpoint test) | **Dismissed: won't fix.** Same reason; URL checked by the outbound policy |
| 9 | `js/file-access-to-http` | `src/ui/server.js` | **Fixed**: the router-probe port comes from config and is now validated by `netguard.checkPort` |
| 10 | `js/http-to-file-access` | `scripts/snapshot-models.js` | **Dismissed: won't fix.** A maintainer script that writes public model lists to `models/*.json` on purpose; data goes through `normalizeModels` |
| 11, 12 | `js/http-to-file-access` | `src/fsutil.js` | **Dismissed: won't fix.** The atomic writer behind the model cache; data sanitized by `normalizeModels`, parsed only as JSON |
| 13–21 | URL substring checks, log lines from page text | new tests (`e2e.mjs`, `links-keychain.test.js`, `gemini-cli-e2e.mjs`) | **Fixed** in the tests: exact comparisons, and single-line log output |
| 22, 23 | `js/log-injection` | `desktop/test/e2e.mjs`, `scripts/gemini-cli-e2e.mjs` | **Dismissed: used in tests.** Test output that goes only to the CI log, already reduced to one line with control characters stripped |
| 24 | `js/unvalidated-dynamic-method-call` | `desktop/test/e2e.mjs` (inspector client) | **Fixed**: only integer ids are looked up, and only functions are called |

The dismissals were made through `gh api -X PATCH …/code-scanning/alerts/N` with the comments above (GitHub limits each comment to 280 characters).

## Not verified

- Clicking an `aswitch://` link in a real browser on macOS/Windows with an installed build. The registration path (`setAsDefaultProtocolClient`, the electron-builder `protocols` config and the deb `MimeType`) and the handling path (second-instance argv, `open-url`) are covered separately: the e2e covers the argv path, and the deb metadata was inspected.
- Linux arm64 builds were produced by CI and their package metadata inspected, but they were not run on arm64 hardware.
- The real Linux Secret Service (`secret-tool` with GNOME Keyring) was not run; CI Linux uses a stand-in with the same command-line contract.


# Audit report — v0.3.0

Date: 2026-10-01 (Europe/Istanbul). Scope: everything new in 0.3.0 (Gemini CLI target and Gemini-API router, profiles, fallback chain, usage log, MCP sync, import/export, endpoint test, update check, tray, env-conflict warning) plus the release/CI pipeline. The v0.2.0 report below still applies to the unchanged parts.

Method:
- `npm test`: 140 tests on Linux, and on macOS/Windows/Linux × Node 18/20/22 in CI.
- CLI runs of every new command in a **sandboxed home** (`ASWITCH_HOME_OVERRIDE`, `ASWITCH_DIR`, `XDG_CONFIG_HOME`; `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `GEMINI_CLI_HOME` unset), in both languages.
- The real Electron app under Xvfb driven by Playwright (`desktop/test/e2e.mjs`, now 40+ checks). This includes:
  - a Gemini API request through the router, answered in Gemini's error format;
  - an MCP sync from a fake `~/.claude.json`;
  - the tray icon.
  The same test now runs in CI on every push.
- A review of 32 similar projects (33 cloned, 1 excluded) (`docs/COMPETITIVE-ANALYSIS.md`) to pick features and to compare behaviour.

| Area | Finding | Status |
|---|---|---|
| Gemini CLI | `~/.gemini/.env` is shadowed by a project `.env`, and shell variables win over both | **Known**, documented; `aswitch run gemini` injects the variables directly; `status` warns about shell variables |
| Gemini CLI | `official` must not leave `selectedType = gemini-api-key` behind | **Fixed** (the previous value is saved in state and put back); test |
| Gemini CLI | Checkbox in the Switch tab was unticked even when Gemini CLI is installed | **Fixed**: it is pre-ticked when `~/.gemini` exists (e2e check) |
| Router | Thinking blocks produced locally must not be sent back to a real Anthropic endpoint (invalid signature) | **Fixed**: `stripLocalThinking` on the passthrough path; test |
| Router | A provider that rejects `reasoning` would break every request with thinking on | **Fixed**: one retry without it on HTTP 400; test |
| Router | Fallback after bytes were streamed would duplicate output | **By design**: fallback only before the first byte; documented |
| MCP sync | Codex TOML header regex missed `[mcp_servers.x.env]` subtables | **Fixed**; test |
| MCP sync | `~/.claude.json` is rewritten by a running Claude Code | **By design**: Claude Code is a source only |
| Import | An imported file with `--overwrite` could point an existing custom provider (and its saved key) at another server | **Fixed**: the saved key is dropped when the base URL changes; profile entries are sanitised; test |
| Usage log | Must never contain prompts or keys | **OK**: metadata only, `0600`, capped at 5000 lines; test |
| Update check | Anonymous GitHub API returns 403 on shared/CI IPs (seen on the build box) | **Fixed**: falls back to the `releases/latest` redirect on github.com; 12 h cache; `ASWITCH_NO_UPDATE_CHECK=1`; test |
| Env conflicts | `ANTHROPIC_*`, `OPENAI_BASE_URL`, `GEMINI_*` in the shell override aswitch silently | **Fixed**: warning in `status` and Overview (names only) |
| i18n | New strings | **OK**: EN/TR catalogs identical (≈415 keys), enforced by test |
| CI | Electron e2e ran only on the maintainer's machine | **Fixed**: `e2e` job under Xvfb, screenshots uploaded as an artifact |
| Release | Release notes were edited by hand; no checksums; tag/version mismatch not caught | **Fixed**: notes from CHANGELOG (EN + TR); version check; verify job with 8-file check and `SHA256SUMS.txt` |
| Supply chain | No dependency or code scanning | **Fixed**: Dependabot (npm ×2, Actions) and CodeQL |
| npm | The unscoped name `agent-switchboard` belongs to someone else on npm | **Known**: install from GitHub (`npm i -g github:cumabozkurt/agent-switchboard#v0.3.0`); see AUTOMATION.md |

Not verified: the real Gemini CLI binary against the router (only the protocol, with a fake upstream and the Gemini request shapes from its docs); the tray on macOS/Windows (built by CI, not UI-tested).

---

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
