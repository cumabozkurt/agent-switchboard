# Automation

This page lists every automated process in the repository: what triggers it, the proof that it works (links to real runs), and the steps that still need a person, with the reason. Last checked: 2026-10-01 (Europe/Istanbul).

## Summary

The pipeline needs no hands from commit to published release. There is one manual step: deciding that a version is ready and running `node scripts/release.js X.Y.Z` (or pushing a `vX.Y.Z` tag). Everything after that is automatic:

- tests on 9 OS × Node combinations, including the real macOS Keychain and Windows Credential Manager
- a real Electron UI test on Linux, macOS and Windows (offline, mock upstream)
- the real Gemini CLI driven through the router
- release notes in English and Turkish
- installers for 3 OSes, 10 files in total (Linux x64 + arm64)
- a check that all 10 files are attached
- checksums

## Automated processes

| # | Process | Workflow / file | Trigger | What it does | Evidence |
|---|---|---|---|---|---|
| 1 | Unit + integration tests, 3 OS × Node 18/20/22 | `.github/workflows/ci.yml` → `test` | every push and pull request | Runs `npm test` (157 tests; the real OS-keychain test runs on macOS/Windows only), `aswitch --version` and `aswitch providers` on ubuntu/macos/windows × Node 18/20/22 (9 jobs) | v0.3.0: [run 36781410452](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781410452) · v0.2.0: [run 36777945778](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36777945778) |
| 2 | Desktop end-to-end test | `ci.yml` → `e2e` (ubuntu, macos, windows) | every push and pull request | Installs Electron and runs `desktop/test/e2e.mjs` (Linux under Xvfb) with a throwaway HOME: 54 checks. It needs no internet: a local mock upstream answers the router and the endpoint test, and model lists come from the bundled snapshots (`E2E_LIVE=1` adds live refreshes). The checks cover keys, models, apply for all 4 tools, the router lifecycle, Gemini API through the router, round-robin balancing, scenario routing, breaker settings, profiles, fallback, usage, MCP sync, share links (including a link passed to a second instance), the keychain (stand-in `secret-tool`), tray, language switch, and quit/relaunch. Screenshots are uploaded as `e2e-screenshots-<os>` | v0.4.0: see the evidence section · v0.3.0: [run 36781410452](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781410452) (job `e2e`) |
| 2b | Real Gemini CLI | `ci.yml` → `gemini-cli` | every push and pull request | `scripts/gemini-cli-e2e.mjs` installs the latest `@google/gemini-cli` from npm into a throwaway HOME. It configures it with `aswitch use` and runs it headless through the router against a local mock upstream, checking the answer, a tool-call round-trip, `aswitch run gemini`, folder trust and the usage log | v0.4.0: see the evidence section |
| 3 | Packaging check | `ci.yml` → `package` | every push and pull request | `npm pack --dry-run` must contain the CLI, UI, i18n and bundled model snapshots. CLI and desktop versions must match. Release notes must build from the CHANGELOG | [run 36781410452](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781410452) (job `package`) |
| 4 | Code scanning | `.github/workflows/codeql.yml` | push/PR to `main`, weekly (Mon 04:41 UTC), manual | CodeQL `security-and-quality` for JavaScript/TypeScript; results in the Security tab | [run 36781410382](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781410382) (success) |
| 5 | Dependency updates | `.github/dependabot.yml` | weekly | PRs for npm (root and `desktop/`, Electron toolchain grouped) and GitHub Actions. CI runs on each PR | [PR #1](https://github.com/cumabozkurt/agent-switchboard/pull/1) (Electron 33 → 44, electron-builder 25 → 26). The branch was updated from `main`, CI passed, the local e2e passed with Electron 44, and a `release.yml` build ran on the branch ([run 36782607796](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36782607796), 3/3 builds). Merged with a normal merge commit (`7683ee3`) on 2026-10-01 |
| 6 | Release: notes | `.github/workflows/release.yml` → `release` | push of a `v*` tag | Fails if the tag ≠ `package.json` ≠ `desktop/package.json`. Builds the notes from the version's section in `CHANGELOG.md` + `CHANGELOG.tr.md` (`scripts/release-notes.js`) plus install lines. Creates the GitHub release, or updates its notes | [run 36781811536](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781811536) (job `release`) · [v0.3.0 release](https://github.com/cumabozkurt/agent-switchboard/releases/tag/v0.3.0) |
| 7 | Release: installers | `release.yml` → `build` (3 OS) | after 6 | `electron-builder` on macOS (arm64 + x64 dmg/zip), Windows (NSIS setup + portable) and Linux (x64 + arm64 AppImage and deb), attached to the release. A manual `workflow_dispatch` builds the same files as artifacts without publishing (used to check PR #1 and the arm64 targets: [run 36784759781](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36784759781)) | [run 36781811536](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781811536) · v0.2.0: [run 36778055364](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36778055364) |
| 8 | Release: verification | `release.yml` → `verify` | after 7 | Downloads the release assets and fails unless all 10 expected files exist and are non-empty. Uploads `SHA256SUMS.txt` | [run 36781811536](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781811536) (job `verify`) |
| 9 | Model list snapshots | `.github/workflows/models-refresh.yml` (`models-snapshot`) | daily 03:17 UTC (06:17 Istanbul), manual | Fetches the public model lists of OpenRouter, OpenCode Zen and OpenCode Go into `models/`. Commits only when something changed. The snapshots ship in the npm package and the desktop app as the offline fallback | Manual run: [36779114907](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36779114907) (success, lists unchanged → no commit) · manual run after the 0.3.0 push: [36781433660](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781433660) (success, unchanged) |
| 10 | One-command release | `scripts/release.js` | a person runs `node scripts/release.js X.Y.Z` | Checks: on `main`, clean tree, tag unused, EN + TR changelog sections exist. Then bumps both `package.json` files, runs the tests, commits, tags `vX.Y.Z` and pushes; steps 6–8 follow. `--dry-run` and `--no-push` are available | CI `package` job builds the notes; used to tag and push v0.3.0 (tests passed, tag `v0.3.0` pushed, release workflow started) |
| 11 | Model list at runtime | `src/models.js` | every model-list request in the app/CLI | Uses the live `/models` list (6 h cache). Offline, it falls back to the cache, then to the bundled snapshot. So the list is always the provider's current one, and the daily workflow only keeps the offline fallback fresh | Tests `features-v3.test.js` (offline fallback); e2e "model list loads" (snapshot; live with `E2E_LIVE=1`) |
| 12 | Update notice | `src/update.js`, desktop banner, `aswitch update` | app start / command, at most every 12 h | Compares with the latest GitHub release. If the API is rate-limited it falls back to the github.com redirect. Shows the version and a link. Can be disabled with `ASWITCH_NO_UPDATE_CHECK=1` | Test `features-v3.test.js` (update check); verified by hand against the real repo (API returned 403 on the build box → fallback worked) |

### Scheduled workflow: honest status

- On 2026-10-01 `models-snapshot` had never fired on its schedule; the repository was created the day before. A manual `workflow_dispatch` run succeeded ([36779114907](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36779114907)). The first scheduled run is expected at 03:17 UTC. Check it with `gh run list --workflow models-refresh.yml --event schedule`.
- GitHub **disables scheduled workflows after 60 days without repository activity**. If that happens, re-enable the workflow in the Actions tab. The app is not affected, because it always prefers the live list.
- Commits made by this workflow use `GITHUB_TOKEN`, so they **do not trigger CI**. They only change JSON data files under `models/`, and every other push is fully tested.

### CodeQL: first scan, triaged

The first CodeQL run (2026-10-01) reported 12 alerts:

- **Fixed in the release commit (4):**
  - regex built from a version string, in `scripts/release-notes.js`, reported twice;
  - a jQuery-style `$()` heuristic in the UI; `$` is `getElementById`, and it now calls `getElementById` directly;
  - a URL substring check in a test.
- **Reviewed, by design (6):** `http-to-file-access` and `file-access-to-http`.
  - The app downloads model lists into its cache and sends the saved API key to the provider the user chose. That is the product's purpose.
  - The alerts point at `fsutil.js`, `models.js`, `core.js` (endpoint test), `ui/server.js` and `scripts/snapshot-models.js`.
- **Test-only (2):**
  - a temp-file check in `test/cli.test.js`;
  - a version regex in `test/packaging.test.js`, since rewritten.

At the time, the by-design and test-only alerts were left open for a person to decide.

### CodeQL: v0.4.0 triage (done)

Cuma asked for every open alert to be re-checked. The ones that could be hardened were fixed, and the rest were dismissed through the API with a written reason. Details are in `docs/AUDIT.md` → *CodeQL*.

- **Fixed by hardening:** #9 (`ui/server.js`: the router probe port is validated by `netguard.checkPort`). Every outbound URL now goes through `netguard.checkOutboundUrl`, and model lists are sanitized by `normalizeModels`.
- **Dismissed with a reason:** #7 and #8 as *won't fix* (the key is sent to the provider the user chose, which is the purpose). #10, #11 and #12 as *won't fix* (the sanitized model cache and snapshots are written on purpose). #6 as *used in tests*.
- **New test-only findings** from the new tests (#13–#23: URL substring checks, log lines built from page text): the tests were rewritten to use exact comparisons and single-line logs.

## What still needs a human, and why

| Step | Why it is not automated |
|---|---|
| Deciding to release (running `scripts/release.js X.Y.Z` or pushing a tag) and writing the CHANGELOG entry (EN + TR) | This is an editorial decision. The notes are *generated* from the CHANGELOG, but a person writes what changed. `scripts/release.js` refuses to release without both sections |
| Code signing / notarization (macOS, Windows) | Needs a paid Apple Developer ID and a Windows code-signing certificate, owned by a person. The builds are unsigned and the README explains the first-launch prompt |
| Silent auto-update in the desktop app | `electron-updater` can update unsigned **Windows NSIS** and **Linux AppImage** builds. **macOS refuses to auto-install unsigned updates** (Squirrel.Mac requires a signature). It would also add a runtime dependency to the desktop app. We chose a notify-only banner and a download link on all platforms, which behaves the same everywhere; see the README → Limitations section. Once signing exists, `electron-updater` with `publish: github` is the planned path |
| Publishing to the npm registry | The unscoped name `agent-switchboard` is owned by another project on npm (v0.5.12). Publishing needs a scoped name (e.g. `@cumabozkurt/agent-switchboard`) and an `NPM_TOKEN` secret that only the owner can create. Until then the supported install path is `npm install -g github:cumabozkurt/agent-switchboard#vX.Y.Z`. That path is exactly what CI's `package` job checks |
| Screenshots in the README | Taken **automatically** by the e2e test (`docs/images/`, and as a CI artifact on every push). Copying new ones into the repository is a deliberate commit, so that screenshots never change without review |
| Merging Dependabot PRs | CI runs on every PR, and a person merges so that major upgrades get reviewed. PR #1 (Electron 44) was merged after checking the breaking changes: macOS 12 support was dropped, which is now documented as macOS 13+, and the postinstall download became lazy, which does not affect us. Auto-merge can be enabled for patch updates in the repository settings if wanted |
| Re-enabling the scheduled workflow after 60 idle days | This is a GitHub platform rule (see above) |

## How to cut a release

```bash
# 1. add "## [X.Y.Z] - date" sections to CHANGELOG.md and CHANGELOG.tr.md, commit
node scripts/release.js X.Y.Z --dry-run   # checks + tests, changes nothing
node scripts/release.js X.Y.Z             # bump, test, commit, tag, push
gh run watch "$(gh run list --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')"
```

## v0.3.0 evidence

- CI on the release commit `3e59988`: [run 36781698782](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781698782) (11/11 jobs green: 9 test, package, e2e). First 0.3.0 push: [run 36781410452](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781410452)
- CI on the tag: [run 36781811956](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781811956) (11/11 jobs green)
- Release workflow: [run 36781811536](https://github.com/cumabozkurt/agent-switchboard/actions/runs/36781811536)
- Release job, 3 builds and verify all green; the notes were generated from CHANGELOG (EN + TR); 9 assets (8 installers + `SHA256SUMS.txt`): https://github.com/cumabozkurt/agent-switchboard/releases/tag/v0.3.0
- Install path check: `npm install -g --prefix /tmp/x github:cumabozkurt/agent-switchboard#v0.3.0` → `aswitch --version` prints `0.3.0` and the bundled `models/` snapshots are present.
