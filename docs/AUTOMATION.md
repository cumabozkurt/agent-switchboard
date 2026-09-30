# Automation

This page lists every automated process in the repository: what triggers it, the proof that it works (links to real runs), and the steps that still need a person, with the reason. Last checked: 2026-10-01 (Europe/Istanbul).

## Summary

The pipeline needs no hands from commit to published release. There is one manual step: deciding that a version is ready and running `node scripts/release.js X.Y.Z` (or pushing a `vX.Y.Z` tag). Everything after that is automatic:

- tests on 9 OS × Node combinations
- a real Electron UI test
- release notes in English and Turkish
- installers for 3 OSes, 8 files in total
- a check that all 8 files are attached
- checksums

## Automated processes

| # | Process | Workflow / file | Trigger | What it does | Evidence |
|---|---|---|---|---|---|
| 1 | Unit + integration tests, 3 OS × Node 18/20/22 | `.github/workflows/ci.yml` → `test` | every push and pull request | Runs `npm test` (140 tests), `aswitch --version` and `aswitch providers` on ubuntu/macos/windows × Node 18/20/22 (9 jobs) | v0.3.0: CI_MAIN_URL · v0.2.0: [run 36777945778](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36777945778) |
| 2 | Desktop end-to-end test | `ci.yml` → `e2e` | every push and pull request | Installs Electron and runs `desktop/test/e2e.mjs` under Xvfb with a throwaway HOME: 40+ checks. These cover keys, live models, apply for all 4 tools, the router lifecycle, Gemini API through the router, profiles, fallback, usage, MCP sync, tray, language switch, and quit/relaunch. Screenshots are uploaded as the `e2e-screenshots` artifact | CI_MAIN_URL (job `e2e`) |
| 3 | Packaging check | `ci.yml` → `package` | every push and pull request | `npm pack --dry-run` must contain the CLI, UI, i18n and bundled model snapshots. CLI and desktop versions must match. Release notes must build from the CHANGELOG | CI_MAIN_URL (job `package`) |
| 4 | Code scanning | `.github/workflows/codeql.yml` | push/PR to `main`, weekly (Mon 04:41 UTC), manual | CodeQL `security-and-quality` for JavaScript/TypeScript; results in the Security tab | CODEQL_URL |
| 5 | Dependency updates | `.github/dependabot.yml` | weekly | PRs for npm (root and `desktop/`, Electron toolchain grouped) and GitHub Actions. CI runs on each PR | Configured in 0.3.0; PRs appear in the Pull requests tab when updates exist |
| 6 | Release: notes | `.github/workflows/release.yml` → `release` | push of a `v*` tag | Fails if the tag ≠ `package.json` ≠ `desktop/package.json`. Builds the notes from the version's section in `CHANGELOG.md` + `CHANGELOG.tr.md` (`scripts/release-notes.js`) plus install lines. Creates the GitHub release, or updates its notes | REL_URL (job `release`) · [v0.3.0 release](https://github.com/cumabozkurt/agent-switchboard/releases/tag/v0.3.0) |
| 7 | Release: installers | `release.yml` → `build` (3 OS) | after 6 | `electron-builder` on macOS (arm64 + x64 dmg/zip), Windows (NSIS setup + portable) and Linux (AppImage + deb), attached to the release | REL_URL · v0.2.0: [run 36778055364](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36778055364) |
| 8 | Release: verification | `release.yml` → `verify` | after 7 | Downloads the release assets and fails unless all 8 expected files exist and are non-empty. Uploads `SHA256SUMS.txt` | REL_URL (job `verify`) |
| 9 | Model list snapshots | `.github/workflows/models-refresh.yml` (`models-snapshot`) | daily 03:17 UTC (06:17 Istanbul), manual | Fetches the public model lists of OpenRouter, OpenCode Zen and OpenCode Go into `models/`. Commits only when something changed. The snapshots ship in the npm package and the desktop app as the offline fallback | Manual run: [36779114907](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36779114907) (success, lists unchanged → no commit) · SNAP_URL |
| 10 | One-command release | `scripts/release.js` | a person runs `node scripts/release.js X.Y.Z` | Checks: on `main`, clean tree, tag unused, EN + TR changelog sections exist. Then bumps both `package.json` files, runs the tests, commits, tags `vX.Y.Z` and pushes; steps 6–8 follow. `--dry-run` and `--no-push` are available | CI `package` job builds the notes; used for v0.3.0 (see below) |
| 11 | Model list at runtime | `src/models.js` | every model-list request in the app/CLI | Uses the live `/models` list (6 h cache). Offline, it falls back to the cache, then to the bundled snapshot. So the list is always the provider's current one, and the daily workflow only keeps the offline fallback fresh | Tests `features-v3.test.js` (offline fallback) and e2e "live model list loads" |
| 12 | Update notice | `src/update.js`, desktop banner, `aswitch update` | app start / command, at most every 12 h | Compares with the latest GitHub release. If the API is rate-limited it falls back to the github.com redirect. Shows the version and a link. Can be disabled with `ASWITCH_NO_UPDATE_CHECK=1` | Test `features-v3.test.js` (update check); verified by hand against the real repo (API returned 403 on the build box → fallback worked) |

### Scheduled workflow: honest status

- On 2026-10-01 `models-snapshot` had never fired on its schedule; the repository was created the day before. A manual `workflow_dispatch` run succeeded ([36779114907](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36779114907)). The first scheduled run is expected at 03:17 UTC. Check it with `gh run list --workflow models-refresh.yml --event schedule`.
- GitHub **disables scheduled workflows after 60 days without repository activity**. If that happens, re-enable the workflow in the Actions tab. The app is not affected, because it always prefers the live list.
- Commits made by this workflow use `GITHUB_TOKEN`, so they **do not trigger CI**. They only change JSON data files under `models/`, and every other push is fully tested.

## What still needs a human, and why

| Step | Why it is not automated |
|---|---|
| Deciding to release (running `scripts/release.js X.Y.Z` or pushing a tag) and writing the CHANGELOG entry (EN + TR) | This is an editorial decision. The notes are *generated* from the CHANGELOG, but a person writes what changed. `scripts/release.js` refuses to release without both sections |
| Code signing / notarization (macOS, Windows) | Needs a paid Apple Developer ID and a Windows code-signing certificate, owned by a person. The builds are unsigned and the README explains the first-launch prompt |
| Silent auto-update in the desktop app | `electron-updater` can update unsigned **Windows NSIS** and **Linux AppImage** builds. **macOS refuses to auto-install unsigned updates** (Squirrel.Mac requires a signature). It would also add a runtime dependency to the desktop app. We chose a notify-only banner and a download link on all platforms, which behaves the same everywhere; see the README → Limitations section. Once signing exists, `electron-updater` with `publish: github` is the planned path |
| Publishing to the npm registry | The unscoped name `agent-switchboard` is owned by another project on npm (v0.5.12). Publishing needs a scoped name (e.g. `@cumabozkurt/agent-switchboard`) and an `NPM_TOKEN` secret that only the owner can create. Until then the supported install path is `npm install -g github:cumabozkurt/agent-switchboard#vX.Y.Z`. That path is exactly what CI's `package` job checks |
| Screenshots in the README | Taken **automatically** by the e2e test (`docs/images/`, and as a CI artifact on every push). Copying new ones into the repository is a deliberate commit, so that screenshots never change without review |
| Merging Dependabot PRs | CI runs on every PR. A person merges, so that major upgrades (e.g. Electron) are reviewed. Auto-merge can be enabled in the repository settings if wanted |
| macOS/Windows UI testing | The e2e test runs on Linux (Xvfb). macOS/Windows builds are produced and verified to exist, but their UI is not driven automatically: GitHub's macOS runners need extra permissions for UI automation, and Windows would need a separate e2e job, a candidate for later |
| Re-enabling the scheduled workflow after 60 idle days | This is a GitHub platform rule (see above) |

## How to cut a release

```bash
# 1. add "## [X.Y.Z] - date" sections to CHANGELOG.md and CHANGELOG.tr.md, commit
node scripts/release.js X.Y.Z --dry-run   # checks + tests, changes nothing
node scripts/release.js X.Y.Z             # bump, test, commit, tag, push
gh run watch "$(gh run list --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')"
```

## v0.3.0 evidence

- CI on the release commit: CI_MAIN_URL
- CI on the tag: CI_TAG_URL
- Release workflow: REL_URL
- Release with 8 installers + `SHA256SUMS.txt`: https://github.com/cumabozkurt/agent-switchboard/releases/tag/v0.3.0
