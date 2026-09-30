# Agent Switchboard (`aswitch`)

Claude Code, Codex ve OpenCode'un **CLI, IDE uzantısı ve masaüstü** sürümlerinin kullandığı API ve modelleri tek yerden yönetin: sağlayıcı değiştirin, her zaman en güncel modeli seçin, istediğiniz an **orijinal ayarlara** geri dönün. macOS, Windows ve Linux'ta çalışır. MIT lisanslı, sıfır bağımlılık (yalnızca Node.js ≥ 18).

> English: A cross-platform CLI + desktop app that switches the API provider and model used by Claude Code, Codex and OpenCode (CLI, IDE extensions, desktop apps), always resolves the newest models live, supports OpenRouter (API key or OAuth PKCE), OpenCode Zen/Go and more, and restores the original configs in one command.

## Neler yapar

- **Tek ayar, tüm sürümler.** Claude Code CLI, VS Code/JetBrains uzantısı ve masaüstü oturumları `~/.claude/settings.json` dosyasını; Codex CLI, IDE uzantısı ve Codex uygulaması `~/.codex/config.toml` dosyasını okur. `aswitch` bu dosyaları güvenli biçimde düzenler, geri kalan ayarlarınıza dokunmaz.
- **Hazır sağlayıcılar:** Anthropic, OpenAI, OpenRouter, OpenCode Zen, OpenCode Go, DeepSeek, Moonshot Kimi, Z.ai GLM, Google Gemini, Ollama. `aswitch provider add` ile OpenAI veya Anthropic uyumlu herhangi bir servis eklenebilir.
- **OpenCode Zen/Go modelleri Claude Code ve Codex içinde.** Zen ve Go hem Anthropic (`/messages`) hem OpenAI (`/responses`, `/chat/completions`) uç noktası sunduğu için iki araçta da doğrudan kullanılır.
- **OpenRouter** tüm modelleriyle: Claude Code için Anthropic uyumlu uç nokta, Codex için OpenAI uyumlu uç nokta. Anahtar ister elle girilir ister `aswitch login openrouter` ile resmî OAuth (PKCE) akışıyla alınır.
- **Her zaman en güncel model.** Model listesi sağlayıcının canlı `/models` uç noktasından çekilir. `--model latest` veya `--model latest:opus` yazarsanız uygulama anında o ailenin en yeni modeli seçilir.
- **Yerel çeviri yönlendiricisi.** Yalnızca OpenAI uyumlu API sunan sağlayıcıları (ör. OpenAI, Gemini, kendi sunucunuz) Claude Code'a bağlar; araç çağrıları ve akış (streaming) dahil.
- **Güvenli geri dönüş.** Bir dosyaya ilk dokunuşta orijinali saklanır, her değişiklikten önce zaman damgalı yedek alınır. `aswitch official` aracın kendi girişine (Claude Pro/Max veya ChatGPT OAuth) döner, `aswitch restore` dosyaları birebir ilk haline getirir.
- **Masaüstü arayüzü.** `aswitch ui` tarayıcıda yerel bir panel açar; `desktop/` klasöründeki Electron uygulaması aynı paneli Mac (`.dmg`), Windows (`.exe`) ve Linux (`.AppImage`, `.deb`) için paketler.

## Kurulum

```bash
npm install -g github:cumabozkurt/agent-switchboard
# veya
git clone https://github.com/cumabozkurt/agent-switchboard && cd agent-switchboard && npm link
```

## Hızlı başlangıç

```bash
# OpenRouter'a OAuth ile giriş yap ve Claude Code + Codex'i en yeni Claude Sonnet'e geçir
aswitch login openrouter
aswitch use openrouter --model latest:claude-sonnet --tools claude,codex

# OpenCode Zen modellerini Claude Code içinde kullan
aswitch key set opencode-zen
aswitch models opencode-zen
aswitch use opencode-zen --model latest:opus --fast latest:haiku --tools claude

# Codex'i OpenCode Go ile çalıştır (anahtar ortam değişkeniyle aktarılır)
aswitch use opencode-go --model <model-adı> --tools codex
aswitch run codex

# Yalnızca OpenAI uyumlu bir sağlayıcıyı Claude Code'a bağla
aswitch use openai --model latest:gpt --tools claude
aswitch router            # ayrı bir terminalde açık kalsın

# Aboneliğinize (Claude Pro/Max, ChatGPT) geri dön
aswitch official
# Her şeyi aswitch'ten önceki haline getir
aswitch restore
```

Tüm komutlar için `aswitch help`.

## Nasıl çalışır

| Araç | Dosya | aswitch ne yazar |
|------|-------|------------------|
| Claude Code (CLI, uzantılar, masaüstü) | `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR`) | `env` içine `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL` |
| Codex (CLI, IDE uzantısı, uygulama) | `~/.codex/config.toml` (`CODEX_HOME`) | işaretli bir blokta `model_provider`, `model` ve `[model_providers.aswitch]` |
| OpenCode | `~/.config/opencode/opencode.json` | `model` ve gerekirse `@ai-sdk/openai-compatible` sağlayıcısı |

Anahtarlar `~/.agent-switchboard/config.json` içinde yalnızca sizin okuyabileceğiniz izinle (600) tutulur. Codex ve OpenCode anahtarı dosyaya değil ortam değişkenine bakar; `aswitch run <araç>` bunu otomatik yapar, kalıcı kullanım için `aswitch env` çıktısını kabuk profilinize ekleyebilirsiniz.

## OAuth hakkında

- **OpenRouter:** Resmî OAuth PKCE akışı desteklenir (`aswitch login openrouter`).
- **Claude Pro/Max ve ChatGPT abonelikleri:** Bu oturumlar yalnızca kendi resmî istemcilerinde kullanılmak üzere verilir. `aswitch` bu belirteçleri kopyalamaz veya başka araçlara taşımaz; `aswitch official` ile Claude Code'un ve Codex'in kendi girişine (`claude /login`, `codex login`) sorunsuzca geri dönersiniz.

## Masaüstü uygulaması

```bash
cd desktop && npm install
npm start        # geliştirme
npm run dist     # bu işletim sistemi için paket üret
```

`v*` etiketi atıldığında GitHub Actions Mac, Windows ve Linux paketlerini üretir.

## Güncel modeller

Uygulama her zaman canlı listeyi kullanır. Ayrıca `models/` klasöründeki OpenRouter ve OpenCode Zen listeleri her gün GitHub Actions ile yenilenir.

## Benzer projeler

- [farion1231/cc-switch](https://github.com/farion1231/cc-switch): Claude Code, Codex, OpenCode ve Gemini CLI için masaüstü sağlayıcı değiştirici.
- [SaladDay/cc-switch-cli](https://github.com/SaladDay/cc-switch-cli): cc-switch'in terminal sürümü.
- [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router): Claude Code istekleri için model yönlendirici.

Agent Switchboard bu fikirleri tek, bağımlılıksız bir çekirdekte birleştirir: aynı kod hem CLI'ı hem masaüstü uygulamasını çalıştırır, orijinal ayarlara birebir dönüş ve canlı "latest" model seçimi yerleşiktir.

## Geliştirme

```bash
npm test   # node:test, harici bağımlılık yok
```

Katkılar memnuniyetle karşılanır. Lisans: MIT.
