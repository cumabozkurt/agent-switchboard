# Competitive analysis (September 2026)

Agent Switchboard switches the API provider and model of coding agents (Claude Code, Codex CLI, OpenCode and, since 0.3.0, Gemini CLI) and ships a small local router that translates between the Anthropic, OpenAI Chat, OpenAI Responses and Gemini wire formats. To decide what to build for 0.3.0 we looked at every active open-source project we could find that does the same job or part of it.

## Method

- Candidates came from GitHub search (topics and keywords: *claude code switch*, *codex provider*, *anthropic openai proxy*, *claude code router*, *cc-switch*, *coding agent gateway* …) and from the "similar projects" sections of the repos we found.
- **Selection rule:** the repo does provider/model/config switching or Anthropic⇄OpenAI/Gemini routing for coding agents, and `pushed_at` (checked with `gh api repos/<owner>/<repo>`) is after **2026-04-01**.
- **Review:** all 33 candidate repos were shallow-cloned (`git clone --depth 1`) into `/workspace/research/` on 2026-09-30. For each one we read the README and the relevant source: config writers, protocol converters, routing and fallback logic, and the UI.
- **Verification (2026-10-01):** `gh api repos/<owner>/<repo>` was re-run for all 33 cloned candidates (`created_at`, `pushed_at`, `archived`). All 33 were pushed after 2026-04-01. **32 are included** below. One is excluded:
  - **tbphp/gpt-load** (7,020 ★, pushed 2026-09-30, MIT): a general-purpose API key-pool and load-balancing proxy for OpenAI, Gemini and Anthropic. It is not specific to coding agents, so it falls outside "same purpose". We still noted one idea from it: a cooldown before a rate-limited key is retried.
  - Note: kxn/claude-code-companion is **archived**. It was last pushed on 2026-07-31, so it still meets the date rule.
- **Data:** stars, last push, language and license are from the GitHub API on 2026-09-30. "Tools" means the agent CLIs the project configures or serves. Model vendors such as Kimi or Qwen are counted as providers, not tools.
- **Licensing:** no code was copied. Four repos have no license (all rights reserved) and three are NOASSERTION; for those we only noted ideas at the level of a feature list. Every adopted idea was reimplemented from scratch in our own zero-dependency style. Most of the others are MIT.

## Summary table

| # | Repo | ★ | Last push | Lang | Tools | Key features | License |
|---|---|---:|---|---|---|---|---|
| 1 | [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 139,126 | 2026-09-30 | Rust (Tauri) | Claude Code, Codex, Gemini CLI, OpenCode, OpenClaw, Claude Desktop, more | 90+ presets, local proxy with failover, MCP/Skills/prompt sync, usage & quota, speed test, tray, deep links, WebDAV/cloud sync, auto-update | MIT |
| 2 | [SaladDay/cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) | 5,202 | 2026-09-29 | Rust | Claude Code, Codex, Gemini CLI, OpenCode, OpenClaw, Hermes, pi | TUI + CLI port of cc-switch, MCP sync, WebDAV sync, backup, import/export | MIT |
| 3 | [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 37,486 | 2026-09-26 | TypeScript | Claude Code (+ Codex/OpenCode presets) | Scenario routing (background/think/long-context/web-search), transformers per provider, retries, fallback models, request logs, UI, status line | MIT |
| 4 | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 53,642 | 2026-09-30 | Go | Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Droid | Exposes subscription CLIs as OpenAI/Gemini/Claude APIs, multi-account round-robin, model aliases | MIT |
| 5 | [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) | 12,660 | 2026-09-30 | JavaScript | Claude Code, Codex, Gemini CLI, Droid | Self-hosted relay, per-user API keys, usage & cost stats, account pools | MIT |
| 6 | [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub) | 3,389 | 2026-09-30 | TypeScript | Claude Code, Codex, Gemini CLI | Weighted/priority load balancing, circuit breaker, session stickiness, LiteLLM price sync, dashboard | MIT |
| 7 | [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) | 626 | 2026-09-30 | Rust | Claude Code (on ChatGPT/Kimi/Grok backends) | Anthropic→Responses/Chat translation, thinking mapping, monitor TUI | MIT |
| 8 | [1rgs/claude-code-proxy](https://github.com/1rgs/claude-code-proxy) | 3,753 | 2026-06-23 | Python | Claude Code | haiku/sonnet → SMALL/BIG model mapping via LiteLLM | none |
| 9 | [starbaser/ccproxy](https://github.com/starbaser/ccproxy) | 347 | 2026-08-10 | Python | Claude Code | LiteLLM-based hooks/rules routing, MCP bridging | NOASSERTION |
| 10 | [lich0821/ccNexus](https://github.com/lich0821/ccNexus) | 972 | 2026-08-31 | Go | Claude Code, Codex | Endpoint rotation & failover, Claude/OpenAI/Gemini conversion, desktop UI, WebDAV backup, stats | MIT |
| 11 | [kxn/claude-code-companion](https://github.com/kxn/claude-code-companion) (archived) | 303 | 2026-07-31 | Go | Claude Code | Priority failover, response validation, tag routing, request log UI | none |
| 12 | [CaddyGlow/ccproxy-api](https://github.com/CaddyGlow/ccproxy-api) | 275 | 2026-05-02 | Python | Claude Code, Codex | Plugin system (access log, analytics, pricing), OpenAI-compatible endpoint | MIT |
| 13 | [BigStrongSun/ccswitchmulti](https://github.com/BigStrongSun/ccswitchmulti) | 119 | 2026-09-30 | Rust | Codex | Multi-model router for Codex, per-model upstream | MIT |
| 14 | [SailingLoong/LoongPort](https://github.com/SailingLoong/LoongPort) | 139 | 2026-09-30 | Rust | Claude Code, Codex, OpenCode, Gemini CLI | Auto-pick upstream by price/TTFT, session stickiness, tray, auto-update | MIT |
| 15 | [glidea/claude-worker-proxy](https://github.com/glidea/claude-worker-proxy) | 275 | 2026-07-10 | TypeScript | Claude Code | Cloudflare Worker converting Claude API → Gemini/OpenAI | MIT |
| 16 | [Able-rip/cc-VisionRouter](https://github.com/Able-rip/cc-VisionRouter) | 78 | 2026-06-07 | JavaScript | Claude Code | Routes requests with images to a vision model | MIT |
| 17 | [codejunkie99/claude-model-switch](https://github.com/codejunkie99/claude-model-switch) | 12 | 2026-07-12 | Rust | Claude Code | opus/sonnet/haiku tier mapping, Claude Code plugin commands | MIT |
| 18 | [hishamkaram/claude-code-router](https://github.com/hishamkaram/claude-code-router) | 10 | 2026-09-30 | Go | Claude Code | Fallback, load balancing, team profiles | MIT |
| 19 | [zuoliangyu/cc-switch-web](https://github.com/zuoliangyu/cc-switch-web) | 18 | 2026-09-24 | Rust | Claude Code, Codex, OpenCode, OpenClaw | Web version of cc-switch, deep links, env-variable conflict detection | MIT |
| 20 | [gstranded/codex-switch](https://github.com/gstranded/codex-switch) | 5 | 2026-09-30 | Rust | Codex | Profile export/import for migration, SHA256SUMS on releases | MIT |
| 21 | [grey0758/codex-provider-switcher](https://github.com/grey0758/codex-provider-switcher) | 4 | 2026-09-24 | Rust | Codex | Keys in OS keychain, atomic writes, tray | MIT |
| 22 | [superheroYu/deepseek-v4-opencode-claude-code-bridge](https://github.com/superheroYu/deepseek-v4-opencode-claude-code-bridge) | 42 | 2026-08-25 | JavaScript | Claude Code, OpenCode, Codex | DeepSeek bridge with reasoning_content mapping, health check, usage | MIT |
| 23 | [Apale7/opencode-provider-switch](https://github.com/Apale7/opencode-provider-switch) | 3 | 2026-07-31 | Go | OpenCode | Alias proxy, Health and Log tabs, tray | none |
| 24 | [2hmad/ccswitch](https://github.com/2hmad/ccswitch) | 9 | 2026-09-09 | Shell | Claude Code | Multi-account vault (swaps subscription logins — ToS-sensitive) | MIT |
| 25 | [becomeless/cc-x](https://github.com/becomeless/cc-x) | 1 | 2026-08-28 | Go | Claude Code | Env-only switching, session vs default scope, self-update | MIT |
| 26 | [christerjohansson/loki-gateway](https://github.com/christerjohansson/loki-gateway) | 2 | 2026-05-02 | JavaScript | Claude Code, OpenCode | Switches provider when rate-limited | none |
| 27 | [asiflow/hyper-claude-code](https://github.com/asiflow/hyper-claude-code) | 5 | 2026-09-24 | Python | Claude Code | Cost tracking, mid-stream recovery | NOASSERTION |
| 28 | [Mukller/claude-code-gateway](https://github.com/Mukller/claude-code-gateway) | 0 | 2026-09-11 | Go | Claude Code, OpenCode | Fallback chains, circuit breaker, latency-based LB, scenario routing, CSV export | MIT |
| 29 | [xiaoliu10/claude-code-router-next](https://github.com/xiaoliu10/claude-code-router-next) | 11 | 2026-09-20 | TypeScript | Claude Code, Codex, OpenCode, Gemini CLI | Fork of CCR with Codex Responses support, usage stats (TTFT, cache hits) | MIT |
| 30 | [wangxiajun68/ClaudeBar](https://github.com/wangxiajun68/ClaudeBar) | 1 | 2026-09-30 | Swift | Claude Code | macOS menu-bar switcher | MIT |
| 31 | [punisher1/claude-code-tool](https://github.com/punisher1/claude-code-tool) | 7 | 2026-06-18 | Rust | Claude Code | CLI provider switcher | MIT |
| 32 | [sarukas/claude-code-agent-sdk-router](https://github.com/sarukas/claude-code-agent-sdk-router) | 5 | 2026-09-09 | TypeScript | Claude Code | Setup wizard, named route sets | NOASSERTION |

## Feature frequency → what we built

| Feature (projects that have it) | Status in Agent Switchboard |
|---|---|
| Gemini CLI as a target (cc-switch, cc-switch-cli, LoongPort, CLIProxyAPI, relay-service, claude-code-hub, ccr-next) | **Added in 0.3.0** (config + Gemini-API router endpoints) |
| Large preset catalogue (cc-switch 90+, CCR) | 18 built-in presets now (+8); custom providers for the rest |
| Fallback / failover (CCR, ccNexus, companion, claude-code-hub, gateway, loki, hishamkaram) | **Added**: per-tool fallback chain in the router |
| Load balancing / circuit breaker (claude-code-hub, gateway; also the excluded gpt-load) | **Added in 0.4.0**: weighted / round-robin groups per tool, and a per-provider breaker (N failures → cooldown → one half-open trial), in CLI + desktop |
| Usage / cost / request log (cc-switch, CCR, relay-service, hub, ccproxy-api, ccr-next, hyper) | **Added**: metadata-only JSONL log, TTFT, tokens, estimated cost |
| Speed test / health (cc-switch, bridge, opencode-provider-switch, LoongPort) | **Added**: `aswitch ping` + Keys tab button |
| MCP sync (cc-switch, cc-switch-cli, ccproxy) | **Added**: list + sync across 4 tools |
| Profiles / import-export / migration (cc-switch-cli, codex-switch, hishamkaram) | **Added**: profiles, per-project `.aswitch.json`, export/import |
| Tray / menu bar (cc-switch, LoongPort, codex-provider-switcher, opencode-provider-switch, ClaudeBar) | **Added** in the desktop app |
| Thinking / reasoning translation (raine proxy, CCR transformers, DeepSeek bridge) | **Added** |
| Auto-update (cc-switch, LoongPort, cc-x) | **Notify-only** (unsigned builds; see AUTOMATION.md) |
| SHA256SUMS on releases (codex-switch) | **Added** (release verify job) |
| Deep links (cc-switch, cc-switch-web) | **Added in 0.4.0**: `aswitch://provider`, `profile`, `import`. There is always a confirmation step and keys are never imported. The scheme is registered by the installed desktop app (electron-builder `protocols`); links also work with `aswitch link` |
| WebDAV / cloud sync (cc-switch, cc-switch-cli, ccNexus) | Not added; export/import covers manual migration |
| OS keychain for keys (codex-provider-switcher) | **Added in 0.4.0, optional**, still with zero dependencies: macOS `security`, Windows Credential Manager via PowerShell, Linux `secret-tool`. The secret is passed over stdin |
| Scenario routing (long-context / background / image → model) (CCR, gateway, VisionRouter) | **Added in 0.4.0**: image, longContext (configurable threshold), webSearch, think, background, per tool |
| Multi-account subscription pooling (CLIProxyAPI, relay-service, ccswitch) | **Deliberately not done** — sharing or pooling subscription OAuth tokens conflicts with provider terms |

## Per-repo notes (ideas worth adopting)

1. **cc-switch.** This is the reference for breadth.
   - *Adopted:* Gemini CLI via `.env` + `settings.json`, MCP sync, speed test, tray quick switch, usage view.
   - *Noted:* deep links (`ccswitch://`), a Skills/prompt sync, and a per-provider "test connection" before applying.
2. **cc-switch-cli.** Shows that a terminal-only user wants everything the GUI has.
   - *Adopted:* export/import and backup listing.
   - *Noted:* the TUI.
3. **claude-code-router.** Its transformer idea is per-provider request/response patches.
   - *Adopted:* reasoning mapping and fallback models.
   - *Noted:* scenario routing (long context → big-context model, web search → search model) and a status line.
4. **CLIProxyAPI.** Useful for model aliases and the Gemini API surface we mirror in the router.
   - *Not adopted:* serving subscription logins as an API; we keep official logins inside their own tools only.
5. **claude-relay-service.** Per-user keys and cost accounting.
   - *Adopted:* the cost estimate idea, from published per-token prices.
6. **claude-code-hub.** Circuit breaker and session stickiness.
   - *Adopted:* only the "retry on 429/5xx before any byte is streamed" rule.
   - *Noted:* LiteLLM price sync, if the provider's own price list is missing.
7. **raine/claude-code-proxy.**
   - *Adopted:* thinking-block translation and a clear model-mapping story for Responses backends.
8. **1rgs/claude-code-proxy (no license).**
   - *Idea only:* the SMALL/BIG mapping, which we already had as `--fast`.
9. **starbaser/ccproxy.** Rule hooks.
   - *Noted:* pluggable request rules (e.g. token-count-based routing).
10. **ccNexus.**
    - *Adopted:* Gemini conversion in the same proxy and endpoint rotation (as a fallback chain).
11. **claude-code-companion (no license).**
    - *Idea:* response validation (reject malformed upstream JSON early) and a request log UI. We built our own usage tab.
12. **ccproxy-api.** Its access-log/analytics/pricing plugins confirmed the "metadata only" log design.
13. **ccswitchmulti.**
    - *Noted:* per-model upstreams for Codex (we route per tool; per model is a candidate).
14. **LoongPort.** Picks the upstream by price/TTFT and sticks to it for a session.
    - *Adopted:* recording TTFT, which is what makes such a choice possible later.
    - *Also adopted:* tray and update notice.
15. **claude-worker-proxy.**
    - *Noted:* running the translator on a serverless edge. Out of scope for a local tool.
16. **cc-VisionRouter.**
    - *Noted:* route image-bearing requests to a vision model. Candidate for scenario routing.
17. **claude-model-switch.**
    - *Noted:* a Claude Code plugin/slash command to switch from inside a session.
18. **hishamkaram/claude-code-router.**
    - *Adopted:* team/named profiles (as profiles plus export/import).
19. **cc-switch-web.**
    - *Noted:* env-variable conflict detection. **Adopted** in 0.3.0: `aswitch status` / Overview warn when `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GEMINI_API_KEY` … override the config; we also document the project-`.env` shadowing for Gemini CLI.
20. **codex-switch.**
    - *Adopted:* SHA256SUMS on releases and a migration file (export/import).
21. **codex-provider-switcher.**
    - *Adopted:* atomic writes (we already had these).
    - *Noted:* OS keychain, left out to keep zero dependencies.
22. **deepseek-v4-opencode-claude-code-bridge.**
    - *Adopted:* the mapping of `reasoning_content` to thinking and a health endpoint showing the provider and fallbacks.
23. **opencode-provider-switch (no license).**
    - *Idea:* Health and Log tabs. We built Usage & logs plus the endpoint test.
24. **2hmad/ccswitch.** Multi-account vault for subscription logins.
    - *Not adopted* (ToS).
25. **cc-x.** Session vs default scope.
    - *Adopted:* `aswitch run` with per-project profiles, which gives the session-scoped switch.
    - *Also adopted:* the update check.
26. **loki-gateway (no license).**
    - *Idea:* switch provider on rate limit. This is our fallback chain on 429.
27. **hyper-claude-code (NOASSERTION).**
    - *Idea:* cost tracking.
    - *Noted:* mid-stream recovery. We only fall back before any bytes are sent, because replaying a half-sent stream would duplicate output.
28. **claude-code-gateway.**
    - *Adopted:* the fallback chains.
    - *Noted:* CSV export of usage (our `--json` output is the building block) and latency-based load balancing.
29. **claude-code-router-next.**
    - *Adopted:* usage stats with TTFT and cached tokens.
    - *Also:* Codex Responses support, which we already had.
30. **ClaudeBar.**
    - *Adopted:* the menu-bar quick switch, as the tray.
31. **claude-code-tool.** A simple CLI switcher; confirms that profiles are the core UX.
32. **claude-code-agent-sdk-router (NOASSERTION).**
    - *Idea:* a first-run wizard. We have a welcome guide.
    - *Noted:* named route sets, which map to our profiles.

## Where Agent Switchboard stands after 0.4.0

- **Unique combination**: one zero-dependency Node package (CLI + web panel + Electron app) that configures Claude Code, Codex, OpenCode *and* Gemini CLI, with a built-in router for all four wire formats (Anthropic Messages, Chat Completions, Responses, Gemini). Most switchers only edit configs, and most routers only serve Claude Code.
- **Safety**: every write is backed up; managed blocks leave user settings intact; full restore to the pre-aswitch state; official logins are never copied between tools.
- **Closed in 0.4.0:** load balancing and circuit breaker, scenario routing, deep links, the optional OS keychain, Linux arm64 builds, and e2e on all three desktop OSes plus a real Gemini CLI run in CI.
- **Gaps that remain** (see README → Roadmap): cloud sync (export/import and share links cover manual moves), a TUI, signed builds with silent auto-update, Codex with `/messages`-only models, and mid-stream replay (left out on purpose, see README → Limitations).
