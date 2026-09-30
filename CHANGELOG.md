# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Turkish: [CHANGELOG.tr.md](CHANGELOG.tr.md).

## [0.3.0] - 2026-10-01

Based on a review of 33 similar open-source projects (see `docs/COMPETITIVE-ANALYSIS.md`).

### Added
- **Gemini CLI support**: fourth target tool. aswitch writes a marked block in `~/.gemini/.env` (`GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, mode 0600) and sets API-key auth and the model in `~/.gemini/settings.json`. Previous values are saved and put back by `aswitch official --tools gemini` and `aswitch restore`. Google AI Studio keys connect directly; every other provider goes through the router, which now speaks the Gemini API (`generateContent`, `streamGenerateContent` with SSE, `countTokens`) and translates to Anthropic Messages, Chat Completions or Responses. `aswitch run gemini` is supported.
- **8 new provider presets** (18 in total): MiniMax, xAI (Grok), Groq, Mistral, Cerebras, NVIDIA NIM, SiliconFlow, LM Studio (local, no key). The Gemini preset now also serves Gemini CLI directly.
- **Profiles**: `aswitch profile save|use|rm|list` stores what every tool uses (provider, model, fast model) and applies it in one step. **Per-project profiles**: `aswitch profile project <name>` writes `.aswitch.json`; `aswitch run` applies the folder's profile before starting the tool.
- **Endpoint test**: `aswitch ping [provider ...]` measures latency and tells whether the key is accepted, rejected or missing. Desktop: "Test endpoints" button with a latency column in the Keys tab.
- **Model fallback chain** in the router: `aswitch fallback set claude opencode-go:glm-5.1 ollama:qwen3`. On 429, 408, 5xx or a network error (before any byte was sent to the tool) the next provider/model is tried. Shown in `/health`, `aswitch status` and the Router tab.
- **Usage and request log**: the router records per-request metadata (time, tool, provider, model, status, latency, time to first token, input/output/cached tokens) in `~/.agent-switchboard/usage.jsonl` (0600, capped at 5000 lines; never prompts, answers or keys). Estimated cost from the provider's published prices in the cached model list. `aswitch usage [--days N] [--recent] [--json] [--clear] [--log on|off]`, and a "Usage & logs" tab.
- **MCP server sync**: `aswitch mcp` lists the MCP servers of Claude Code, Codex, OpenCode and Gemini CLI; `aswitch mcp sync --from claude --to codex,opencode,gemini [--only a,b] [--overwrite]` copies them (stdio and http/sse, with env and headers), converting between each tool's format. Existing servers with the same name are kept unless `--overwrite`. Every write is backed up. Claude Code is a source only (it rewrites `~/.claude.json` while running). Desktop: "MCP servers" tab.
- **Import / export**: `aswitch export [file] [--with-keys]` and `aswitch import <file> [--overwrite]` move custom providers, profiles, fallbacks and settings between machines (keys only when asked). Desktop: Settings → Import / export.
- **Thinking / reasoning translation** in the router: `reasoning_content` / `reasoning` from Chat providers (DeepSeek, Kimi, GLM, OpenRouter …) and Responses reasoning summaries are streamed to Claude Code as thinking blocks; Claude's `thinking` request is forwarded as OpenRouter `reasoning` or Responses `reasoning.effort` (retried once without it if the provider rejects it). Locally generated thinking blocks are stripped before a request goes back to a real Anthropic endpoint.
- **Environment conflict warning**: `aswitch status` and the Overview tab warn when variables such as `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `GEMINI_API_KEY` are set, because they take priority over the files aswitch writes (names only, values are never shown).
- `stop_sequences` are forwarded to Chat Completions providers (max 4, the OpenAI limit; the Responses API has no equivalent).
- **Tray / menu bar icon** in the desktop app: apply a profile, go back to all official logins, start/stop the router, open the window, quit.
- **Update notice**: the CLI (`aswitch update`) and the desktop app (banner) check GitHub Releases at most every 12 hours; notify-only, no download. `ASWITCH_NO_UPDATE_CHECK=1` turns it off. Falls back to the github.com redirect when the API is rate-limited.
- **Offline model lists**: the daily model snapshots now ship inside the npm package and the desktop app and are used when the provider cannot be reached and there is no local cache.

### Automation
- CI runs the real Electron end-to-end test (Playwright, 40+ checks) under xvfb on every push and uploads the screenshots; a packaging job checks the npm tarball contents and that CLI and desktop versions agree.
- Release notes are generated from `CHANGELOG.md` + `CHANGELOG.tr.md`; the release job refuses a tag that does not match both `package.json` versions; a verify job checks that all 8 installers are attached and publishes `SHA256SUMS.txt`.
- `scripts/release.js <version>`: one-command release (checks, bump, tests, commit, tag, push).
- Dependabot (npm root + desktop, GitHub Actions) and CodeQL code scanning.
- `docs/AUTOMATION.md` lists every automated process with evidence, and what still needs a human.

### Changed
- `aswitch use` without `--tools` also targets Gemini CLI when `~/.gemini` exists.
- The desktop app has an icon; the window and tray share the panel's API token.

## [0.2.0] - 2026-10-01

### Added
- **English and Turkish everywhere**: desktop UI (language switcher in the header and in Settings, saved in config, defaults to the OS language), CLI help/messages/errors (`--lang en|tr`, `aswitch lang en|tr|auto`, `ASWITCH_LANG`), router error messages, OAuth callback page, Electron menu and window title. Zero-dependency i18n module (`src/i18n/`) with a test that keeps catalogs in sync.
- **Desktop app covers every CLI feature**: router start/stop/restart with clear state and port, auto-start when a tool needs the router, custom providers add/remove, view and restore any single backup, environment-variable help per shell (masked by default), settings tab with all file paths, welcome guide on first run.
- `aswitch backups restore <id> <file>`, `aswitch lang`, human-readable `aswitch status` (`--json` for scripts), clean `Ctrl+C` shutdown of `aswitch router` and `aswitch ui`.
- Electron end-to-end test (`desktop/test/e2e.mjs`, Playwright over Electron) and real screenshots in `docs/images/`.
- `README.tr.md`, `CONTRIBUTING.md`, `SECURITY.md`, issue templates, `docs/AUDIT.md`.

### Fixed
- Windows: opening URLs with `&` (including the OpenRouter OAuth URL) was broken by `cmd /c start`; now uses `rundll32 url.dll,FileProtocolHandler`.
- A custom router port was forgotten after switching to a provider that does not need the router.
- Adding a custom provider with a built-in id could delete the built-in provider's saved key; now rejected.
- Desktop app: router is stopped cleanly on quit; only one instance can run; links open in the system browser; port-in-use and an already-running router are detected.
- OAuth: a friendly error when the callback port is busy.
- Network errors now show the real cause (e.g. `ECONNREFUSED`) instead of "fetch failed".
- Unknown CLI commands print a short hint instead of the whole help text.
- The apply result in the UI printed a stray "null" and did not follow language/router changes.

### Security
- Control panel API requires `Content-Type: application/json` (blocks cross-site form posts) and limits request bodies to 1 MB; stricter CSP; UI builds all DOM with text nodes (no `innerHTML`).
- `~/.agent-switchboard` and its `backups/` and `originals/` folders are created owner-only (`0700`) on macOS/Linux.
- Text the router injects into model prompts is fixed English, independent of the UI language.
- `.gitattributes` forces LF so the CLI shebang keeps working when packed on Windows.
- Only `http(s)` URLs are handed to the system URL opener.

## [0.1.3] - 2026-09-30

### Added
- Router: Claude Code can use Responses-only models (Anthropic Messages ⇄ OpenAI Responses translation), and `/messages` models are passed through when main and fast models live on different endpoints.

## [0.1.2] - 2026-09-30

### Fixed
- Comprehensive audit: Codex Responses/auth settings, restoring the user's previous `model` lines on `official`, router for both Claude Code and Codex, atomic and safe file writes, UI XSS hardening, CLI flag parsing, macOS x64 builds.

## [0.1.1] - 2026-09-30

### Added
- Package metadata and automatic upload of desktop builds to GitHub Releases.

## [0.1.0] - 2026-09-30

### Added
- First release: CLI, local web UI and Electron app to switch the API provider and model of Claude Code, Codex and OpenCode; live model lists; OpenRouter OAuth; local router; backups and restore.

[0.2.0]: https://github.com/cumabozkurt/agent-switchboard/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/cumabozkurt/agent-switchboard/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/cumabozkurt/agent-switchboard/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/cumabozkurt/agent-switchboard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cumabozkurt/agent-switchboard/releases/tag/v0.1.0
