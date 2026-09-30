# Değişiklik günlüğü

Bu projedeki önemli değişiklikler burada yazılıdır. Biçim [Keep a Changelog](https://keepachangelog.com/tr-TR/1.1.0/) kurallarına uyar, proje [Anlamsal Sürümleme](https://semver.org/lang/tr/) kullanır. İngilizce sürüm: [CHANGELOG.md](CHANGELOG.md).

## [0.3.0] - 2026-10-01

Benzer 32 açık kaynak projenin incelenmesine dayanır (bkz. `docs/COMPETITIVE-ANALYSIS.md`).

### Eklenenler
- **Gemini CLI desteği**: dördüncü hedef araç. aswitch `~/.gemini/.env` içine işaretli bir blok yazar (`GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, izin 0600) ve `~/.gemini/settings.json` içinde API anahtarı ile girişi ve modeli ayarlar. Önceki değerler saklanır; `aswitch official --tools gemini` ve `aswitch restore` bunları geri koyar. Google AI Studio anahtarları doğrudan bağlanır; diğer tüm sağlayıcılar yönlendiriciden geçer. Yönlendirici artık Gemini API'sini (`generateContent`, SSE ile `streamGenerateContent`, `countTokens`) konuşuyor ve bunu Anthropic Messages, Chat Completions ya da Responses biçimine çeviriyor. `aswitch run gemini` desteklenir.
- **8 yeni hazır sağlayıcı** (toplam 18): MiniMax, xAI (Grok), Groq, Mistral, Cerebras, NVIDIA NIM, SiliconFlow, LM Studio (yerel, anahtarsız). Gemini hazır ayarı artık Gemini CLI'a doğrudan da hizmet veriyor.
- **Profiller**: `aswitch profile save|use|rm|list` her aracın o an kullandığını (sağlayıcı, model, hızlı model) kaydeder ve tek adımda uygular. **Projeye özel profil**: `aswitch profile project <ad>` klasöre `.aswitch.json` yazar; `aswitch run` aracı başlatmadan önce o klasörün profilini uygular.
- **Uç nokta testi**: `aswitch ping [sağlayıcı ...]` gecikmeyi ölçer ve anahtarın kabul edildiğini, reddedildiğini ya da eksik olduğunu söyler. Masaüstü: API anahtarları sekmesinde "Uç noktaları test et" düğmesi ve gecikme sütunu.
- Yönlendiricide **yedek model zinciri**: `aswitch fallback set claude opencode-go:glm-5.1 ollama:qwen3`. 429, 408, 5xx ya da ağ hatasında (araca henüz tek bayt gönderilmediyse) sıradaki sağlayıcı/model denenir. `/health`, `aswitch status` ve Yönlendirici sekmesinde görünür.
- **Kullanım ve istek kaydı**: yönlendirici her isteğin özet bilgisini (zaman, araç, sağlayıcı, model, durum, gecikme, ilk token süresi, girdi/çıktı/önbellek token'ları) `~/.agent-switchboard/usage.jsonl` dosyasına yazar (0600, en fazla 5000 satır; istem, yanıt ya da anahtar asla yazılmaz). Tahmini maliyet, önbellekteki model listesinde sağlayıcının yayımladığı fiyatlardan hesaplanır. `aswitch usage [--days N] [--recent] [--json] [--clear] [--log on|off]` ve "Kullanım ve kayıtlar" sekmesi.
- **MCP sunucu eşitleme**: `aswitch mcp` Claude Code, Codex, OpenCode ve Gemini CLI'daki MCP sunucularını listeler; `aswitch mcp sync --from claude --to codex,opencode,gemini [--only a,b] [--overwrite]` bunları her aracın biçimine çevirerek kopyalar (stdio ve http/sse, env ve başlıklarla). Aynı adlı sunucular `--overwrite` verilmedikçe korunur. Her yazmadan önce yedek alınır. Claude Code yalnızca kaynaktır (çalışırken `~/.claude.json` dosyasını kendisi yeniden yazar). Masaüstü: "MCP sunucuları" sekmesi.
- **İçe / dışa aktarma**: `aswitch export [dosya] [--with-keys]` ve `aswitch import <dosya> [--overwrite]` özel sağlayıcıları, profilleri, yedek zincirlerini ve ayarları başka bir bilgisayara taşır (anahtarlar yalnızca istenirse). Masaüstü: Ayarlar → İçe / dışa aktar.
- Yönlendiricide **düşünme (reasoning) çevirisi**: Chat sağlayıcılarından (DeepSeek, Kimi, GLM, OpenRouter …) gelen `reasoning_content` / `reasoning` ve Responses akıl yürütme özetleri Claude Code'a düşünme blokları olarak akar; Claude'un `thinking` isteği OpenRouter `reasoning` ya da Responses `reasoning.effort` olarak iletilir (sağlayıcı reddederse bir kez onsuz yeniden denenir). Yerelde üretilen düşünme blokları, istek gerçek bir Anthropic uç noktasına giderken çıkarılır.
- **Ortam değişkeni çakışma uyarısı**: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` ya da `GEMINI_API_KEY` gibi değişkenler tanımlıysa `aswitch status` ve Genel bakış sekmesi uyarır; bunlar aswitch'in yazdığı dosyaların önüne geçer (yalnızca adlar gösterilir, değerler asla).
- `stop_sequences` Chat Completions sağlayıcılarına iletilir (en fazla 4, OpenAI sınırı; Responses API'de karşılığı yok).
- Masaüstü uygulamasında **tepsi / menü çubuğu simgesi**: profil uygula, tüm araçları resmî girişe döndür, yönlendiriciyi başlat/durdur, pencereyi aç, çık.
- **Güncelleme bildirimi**: CLI (`aswitch update`) ve masaüstü uygulaması (bilgi şeridi) GitHub Releases'i en fazla 12 saatte bir denetler; yalnızca bildirir, indirmez. `ASWITCH_NO_UPDATE_CHECK=1` kapatır. API hız sınırına takılırsa github.com yönlendirmesine düşer.
- **Çevrimdışı model listeleri**: günlük model anlık görüntüleri artık npm paketinde ve masaüstü uygulamasında geliyor; sağlayıcıya ulaşılamazsa ve yerel önbellek yoksa bunlar kullanılır.

### Otomasyon
- CI her gönderimde gerçek Electron uçtan uca testini (Playwright, 40+ denetim) xvfb altında çalıştırır ve ekran görüntülerini yükler; paketleme işi npm paketinin içeriğini ve CLI ile masaüstü sürümlerinin aynı olduğunu denetler.
- Sürüm notları `CHANGELOG.md` + `CHANGELOG.tr.md` dosyalarından üretilir; sürüm işi iki `package.json` sürümüyle eşleşmeyen etiketi reddeder; doğrulama işi 8 kurulum dosyasının da eklendiğini denetler ve `SHA256SUMS.txt` yayımlar.
- `scripts/release.js <sürüm>`: tek komutla sürüm (denetimler, sürüm artırma, testler, commit, etiket, push).
- Dependabot (npm kök + masaüstü, GitHub Actions) ve CodeQL kod taraması.
- `docs/AUTOMATION.md` her otomatik süreci kanıtıyla ve hâlâ insan gerektiren adımları listeler.

### Değişenler
- `--tools` verilmeden `aswitch use`, `~/.gemini` varsa Gemini CLI'ı da hedefler.
- Masaüstü uygulamasının simgesi var; pencere ve tepsi aynı panel API anahtarını kullanır.

## [0.2.0] - 2026-10-01

İngilizce ve Türkçe arayüz, masaüstü uygulamasında tüm CLI özellikleri, Electron uçtan uca testi ve çok sayıda düzeltme. Ayrıntılar: [CHANGELOG.md](CHANGELOG.md#020---2026-10-01).

## [0.1.0] – [0.1.3] - 2026-09-30

İlk sürümler. Ayrıntılar: [CHANGELOG.md](CHANGELOG.md).
