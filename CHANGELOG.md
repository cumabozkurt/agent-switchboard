# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
