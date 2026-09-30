# Agent Switchboard (`aswitch`)

Claude Code, Codex ve OpenCode'un kullandığı API sağlayıcısını ve modeli tek yerden yönetin: sağlayıcı değiştirin, canlı model listesinden en yeni modeli seçin, istediğiniz an aracın kendi girişine ya da **orijinal ayar dosyalarına** geri dönün. macOS, Windows ve Linux'ta çalışır. MIT lisanslı, çalışma zamanında sıfır bağımlılık (yalnızca Node.js ≥ 18).

> English: A cross-platform, zero-dependency CLI + local web UI + Electron app that switches the API provider and model used by Claude Code, Codex and OpenCode by editing their own config files, resolves the newest model live from the provider's `/models` list, supports OpenRouter (API key or OAuth PKCE), OpenCode Zen/Go and more, includes a local translating router (Claude Code → Chat Completions or OpenAI Responses, Codex → Chat Completions) so Claude Code can also use Responses-only models such as OpenCode Go/Zen `gpt-*`, and can restore the original configs in one command.

## Neler yapar

- **Aracın kendi ayar dosyası.** Claude Code `~/.claude/settings.json`, Codex `~/.codex/config.toml`, OpenCode `~/.config/opencode/opencode.json` (veya `opencode.jsonc`) dosyasını okur. Bu araçların CLI, IDE uzantısı ve masaüstü sürümleri aynı dosyayı kullandığı ölçüde değişiklik hepsine yansır. `aswitch` yalnızca kendi yönettiği anahtarları/blokları değiştirir, geri kalan ayarlarınıza dokunmaz. Bozuk (ayrıştırılamayan) bir dosyanın üzerine asla yazmaz; hata verip durur.
- **Hazır sağlayıcılar:** Anthropic, OpenAI, OpenRouter, OpenCode Zen, OpenCode Go, DeepSeek, Moonshot Kimi, Z.ai GLM, Google Gemini, Ollama. `aswitch provider add` ile OpenAI ve/veya Anthropic uyumlu herhangi bir servis eklenebilir.
- **Model başına doğru uç nokta.** OpenCode Zen/Go her modeli kendi uç noktasında sunar (dokümandaki tabloya göre: `claude-*` ve çoğu `qwen*` → `/messages`, `gpt-*`/`grok-*` → `/responses`, diğerleri → `/chat/completions`). `aswitch` seçilen modele bakıp Claude Code ve Codex'i doğrudan ya da yerel yönlendirici üzerinden bağlar; desteklenmeyen bir eşleşmede (ör. Zen'in Google-native Gemini modelleri) hiçbir dosyaya yazmadan hata verir.
- **OpenRouter:** Claude Code için Anthropic uyumlu uç nokta, Codex için Responses API. Anahtar elle girilir ya da `aswitch login openrouter` ile resmî OAuth (PKCE) akışıyla alınır.
- **Canlı model listesi.** Liste sağlayıcının `/models` uç noktasından çekilir (6 saat önbelleklenir, `--refresh` ile yenilenir). `--model latest` veya `--model latest:opus` yazarsanız, uygulama anında o filtreye uyan en yeni model seçilir. Tarih bilgisi vermeyen listelerde (ör. Zen/Go) sıralama sürüm numarasına göre yapılır; bu yüzden orada `latest:claude-opus` gibi bir filtre kullanın.
- **Yerel çeviri yönlendiricisi (`aswitch router`).** Claude Code'un Anthropic Messages isteklerini modele göre `/chat/completions`'a ya da OpenAI **Responses** API'sine (`/responses`) çevirir; böylece yalnızca Responses ile sunulan modeller (ör. OpenCode Go/Zen `gpt-*`, `grok-*`, OpenAI modelleri) de Claude Code içinde çalışır. Codex'in Responses isteklerini de yalnızca Chat Completions sunan sağlayıcılar için `/chat/completions`'a çevirir. Araç çağrıları, görseller ve akış (streaming) dahildir. Yapılandırma değişikliklerini yeniden başlatmadan anında görür.
- **Güvenli geri dönüş.** Bir dosyaya ilk dokunuşta orijinali saklanır, her değişiklikten önce zaman damgalı yedek alınır (son 50 tutulur). `aswitch official` aswitch ayarlarını kaldırıp aracın kendi girişine (Claude Pro/Max, ChatGPT) döner ve aswitch'in değiştirdiği `model` satırlarınızı geri koyar; `aswitch restore` dosyaları birebir ilk haline getirir.
- **Masaüstü arayüzü.** `aswitch ui` tarayıcıda yalnızca bu bilgisayardan erişilebilen, oturum belirteçli yerel bir panel açar; `desktop/` klasöründeki Electron uygulaması aynı paneli Mac (`.dmg`/`.zip`, Apple Silicon ve Intel), Windows (kurulum ve taşınabilir `.exe`) ve Linux (`.AppImage`, `.deb`, x64) için paketler.

## Kurulum

```bash
npm install -g github:cumabozkurt/agent-switchboard
# veya
git clone https://github.com/cumabozkurt/agent-switchboard && cd agent-switchboard && npm link
aswitch --version
```

## Hızlı başlangıç

```bash
# OpenRouter'a OAuth ile giriş yap; Claude Code ve Codex'i en yeni Claude Sonnet'e geçir
aswitch login openrouter
aswitch use openrouter --model latest:claude-sonnet --tools claude,codex

# OpenCode Zen'in Claude modellerini Claude Code içinde kullan (doğrudan /messages)
aswitch key set opencode-zen
aswitch models opencode-zen --filter claude
aswitch use opencode-zen --model latest:claude-opus --fast latest:claude-haiku --tools claude

# Codex'i OpenCode Zen'in GPT modelleriyle çalıştır (doğrudan /responses)
aswitch use opencode-zen --model latest:gpt --tools codex
aswitch run codex

# OpenCode Go'nun GPT modelini (yalnızca /responses) Claude Code içinde kullan
aswitch key set opencode-go
aswitch use opencode-go --model latest:gpt --tools claude
aswitch router            # ayrı bir terminalde açık kalsın

# Yalnızca Chat Completions sunan bir sağlayıcı (ör. DeepSeek, Gemini) için Codex
aswitch use deepseek --model deepseek-chat --tools codex
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
| Claude Code | `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR`) | `env` içine `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (Anthropic'in kendisi için yalnızca `ANTHROPIC_API_KEY`), `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`; ayrıca üst düzey `model` anahtarını seçilen modele ayarlar (official'da önceki değerinizi geri koyar) |
| Codex | `~/.codex/config.toml` (`CODEX_HOME`) | En üstte işaretli bir blokta `model_provider = "aswitch"` ve `model`; dosya sonunda `[model_providers.aswitch]` (`base_url`, `wire_api = "responses"`, `env_key`) |
| OpenCode | `~/.config/opencode/opencode.json` | `model`; yerleşik olmayan sağlayıcılar için `@ai-sdk/openai-compatible` (veya `/responses` için `@ai-sdk/openai`) tanımı, anahtar `{env:AD}` olarak |

Codex'in güncel sürümü yalnızca `wire_api = "responses"` destekler; bu yüzden Responses API sunmayan sağlayıcılarda Codex `aswitch router` (varsayılan `http://127.0.0.1:3456`) üzerinden bağlanır. Aynı şekilde, seçilen model sağlayıcının Anthropic uyumlu uç noktasında sunulmuyorsa Claude Code yönlendiriciye bağlanır; yönlendirici isteği o modelin API'sine çevirir:

| Modelin sunulduğu uç nokta | Claude Code | Codex |
|---|---|---|
| `/messages` (Anthropic) | doğrudan | desteklenmez |
| `/responses` (OpenAI Responses) | yönlendirici (Messages → Responses) | doğrudan |
| `/chat/completions` | yönlendirici (Messages → Chat) | yönlendirici (Responses → Chat) |

Model tablosu olmayan sağlayıcılarda: Anthropic uç noktası varsa Claude Code doğrudan bağlanır; yoksa Responses sunan sağlayıcılar (OpenAI) Responses ile, diğerleri Chat Completions ile konuşur. Ana model ile `--fast` modeli farklı uç noktalardaysa (ör. Zen'de `claude-*` + `gpt-*-mini`) ikisi de yönlendiriciden geçer; `/messages` modelleri yönlendiricide çevrilmeden iletilir. `aswitch use` (ve arayüz) yönlendirici gerektiğinde bunu söyler.

Anahtarlar `~/.agent-switchboard/config.json` içinde (POSIX'te 600 izinle) tutulur. Claude Code anahtarı `settings.json` içinden okur (bu dosya da 600 izinle yazılır). Codex ve OpenCode anahtarı ortam değişkeninden okur:

- `aswitch run codex` / `aswitch run opencode` gerekli değişkeni ayarlayıp aracı başlatır.
- Kalıcı kullanım için `aswitch env` çıktısını kabuk profilinize ekleyin (yalnızca aktif Codex/OpenCode sağlayıcılarının anahtarları; hepsi için `--all`, kabuk için `--shell sh|fish|powershell|cmd`).
- Ya da `aswitch use ... --codex-key command` ile Codex anahtarı her istekte `aswitch key get <sağlayıcı>` komutundan alır (Codex'in `[model_providers.<id>.auth]` özelliği); ortam değişkeni gerekmez. Bu mod CLI'dan kullanılmalıdır, masaüstü uygulaması ortam değişkeni modunu kullanır.

`aswitch official` varsayılan olarak Claude Code ve Codex'e uygulanır; OpenCode'un "resmî" modu olmadığı için `--tools opencode` verildiğinde OpenCode dosyası orijinaline döndürülür.

## Yönlendirici sınırlamaları

- Akıl yürütme (thinking/reasoning) içeriği çevrilmez: Responses'tan gelen `reasoning` öğeleri ve Claude Code'un `thinking` blokları atlanır; yalnızca metin ve araç çağrıları aktarılır.
- Claude Code → Responses çevirisi durumsuzdur (`store: false`; her istek tüm geçmişi taşır). `stop_sequences` Responses'ta karşılığı olmadığı için iletilmez; Claude Code'un sunucu tarafı araçları (ör. web arama) yalnızca `input_schema` taşıyan istemci araçları iletildiği için aktarılmaz.
- Araç sonuçlarındaki görseller, araç çıktısı yalnızca metin taşıdığından ayrı bir kullanıcı mesajıyla gönderilir.
- Codex'in sağlayıcıda barındırılan araçları (ör. `web_search`) Chat Completions'ta karşılığı olmadığı için iletilmez; `apply_patch` gibi serbest biçimli araçlar tek parametreli fonksiyon olarak aktarılır.
- `count_tokens` yaklaşık bir tahmindir.
- Yönlendirici yalnızca `127.0.0.1` üzerinde dinler ve tarayıcıdan (Origin başlığı taşıyan) gelen istekleri reddeder.

## OAuth hakkında

- **OpenRouter:** Resmî OAuth PKCE akışı desteklenir (`aswitch login openrouter`).
- **Claude Pro/Max ve ChatGPT abonelikleri:** Bu oturumlar yalnızca kendi resmî istemcilerinde kullanılmak üzere verilir. `aswitch` bu belirteçleri kopyalamaz veya başka araçlara taşımaz; `aswitch official` ile Claude Code'un ve Codex'in kendi girişine (`claude /login`, `codex login`) geri dönersiniz.

## Masaüstü uygulaması

```bash
cd desktop && npm install
npm start        # geliştirme
npm run dist     # bu işletim sistemi için paket üret
```

`v*` etiketi atıldığında GitHub Actions Mac (arm64 + x64), Windows (x64) ve Linux (x64) paketlerini üretip GitHub Release'e ekler. Paketler imzasızdır; macOS'ta ilk açılışta sağ tık → Aç gerekebilir.

## Güncel modeller

Uygulama her zaman canlı listeyi kullanır. Ayrıca `models/` klasöründeki OpenRouter, OpenCode Zen ve OpenCode Go listeleri her gün GitHub Actions ile yenilenir (liste değişmediyse commit atılmaz).

## Benzer projeler

- [farion1231/cc-switch](https://github.com/farion1231/cc-switch): Claude Code, Codex, OpenCode ve Gemini CLI için masaüstü sağlayıcı değiştirici.
- [SaladDay/cc-switch-cli](https://github.com/SaladDay/cc-switch-cli): cc-switch'in terminal sürümü.
- [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router): Claude Code istekleri için model yönlendirici.

Agent Switchboard bu fikirleri tek, bağımlılıksız bir çekirdekte birleştirir: aynı kod hem CLI'ı hem masaüstü uygulamasını çalıştırır; orijinal ayarlara birebir dönüş ve canlı "latest" model seçimi yerleşiktir.

## Geliştirme

```bash
npm test   # node:test, harici bağımlılık yok
```

Katkılar memnuniyetle karşılanır. Lisans: MIT.
