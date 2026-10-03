# Değişiklik günlüğü

Bu projedeki önemli değişiklikler burada yazılıdır. Biçim [Keep a Changelog](https://keepachangelog.com/tr-TR/1.1.0/) kurallarına uyar, proje [Anlamsal Sürümleme](https://semver.org/lang/tr/) kullanır. İngilizce sürüm: [CHANGELOG.md](CHANGELOG.md).

## [0.4.1] - 2026-10-03

Bakım sürümü: 0.4.0'dan bu yana kod değişikliği yok.

### Değişenler
- Paketle gelen model listeleri (çevrim dışı kullanımda ve masaüstü e2e testinde kullanılır) günlük `models-snapshot` iş akışıyla yenilendi:
  - OpenCode Zen: `ling-3.1-flash-free` ve `fledge-alpha-free` eklendi.
  - OpenRouter: `inclusionai/ling-3.1-flash`, `apodex/apodex-1.1-mini:free`, `unbiased/pareto-26.10-preview` ve `nvidia/switchyard` eklendi; `openai/gpt-6.1-sol:batch` ve `openai/gpt-6.1-sol-pro:batch` kaldırıldı.

### Belgeler
- `docs/AUTOMATION.md`: v0.4.0 sürüm kanıtları (iş akışı çalıştırmaları, kurulum dosyaları, sağlama toplamları).

## [0.4.0] - 2026-10-01

### Eklenenler
- Yönlendiricide **yük dengeleme**: `aswitch balance set claude openrouter:anthropic/claude-sonnet-4.5*3 deepseek:deepseek-chat*1 [--strategy weighted|round-robin]` bir aracın isteklerini iki ya da daha çok sağlayıcı/modele dağıtır (ağırlıkla ya da sırayla). Seçilen hata verirse önce grubun diğer üyeleri, sonra yedek zinciri denenir. Masaüstü: Yönlendirici → Yük dengeleme.
- **Devre kesici**: art arda N hatadan sonra (429, 408, 5xx ya da ağ hatası; varsayılan 3) sağlayıcı bir bekleme süresi boyunca (varsayılan 30 sn) atlanır, sonra tek bir deneme isteğine izin verilir (yarı açık). Başarılı olursa devre yeniden kapanır. Diğer 4xx hataları hiç sayılmaz. Tüm adayların devresi açıksa yönlendirici hiç denemeden hata vermek yerine yine de dener. `aswitch breaker [on|off|set --failures N --cooldown S|status]` canlı durumu gösterir; `/health` ve Yönlendirici sekmesi de gösterir.
- **Senaryoya göre yönlendirme** (claude-code-router'daki gibi): `image`, `longContext` (tahmini token sayısı eşiği geçerse; varsayılan 60.000), `webSearch`, `think` (düşünme/akıl yürütme istenmiş) ya da `background` (Claude'un haiku/hızlı modeli, Gemini flash-lite) isteklerini başka bir modele gönderin: `aswitch scenario set claude longContext openrouter:google/gemini-2.5-pro`, `aswitch scenario threshold 100000`. Kullanım kaydı senaryoyu da yazar.
- `aswitch use … --via-router` doğrudan bağlantı mümkün olsa bile her zaman yönlendiriciden geçer. Doğrudan bağlı bir araca yedek zinciri, dengeleme grubu ya da senaryo tanımlanınca araç kendiliğinden yönlendiriciye alınır.
- **Paylaşım bağlantıları (`aswitch://`)**: `aswitch://provider?…`, `aswitch://profile?…` ve `aswitch://import?data=…` özel bir sağlayıcıyı, bir profili ya da tüm kurulumu içe aktarır. **Bağlantılar asla API anahtarı taşımaz**: anahtara benzeyen parametreler ve `keys` blokları atılır (uyarı gösterilir). Onay olmadan hiçbir şey uygulanmaz: masaüstü uygulaması `aswitch:` şemasını kaydeder (kurulu sürümlerde; macOS `open-url`, Windows/Linux ikinci örnek argümanı) ve her uç noktayı gösteren bir onay penceresi açar; CLI önizleme yazdırıp sorar (betiklerde onay için `--yes`). URL'ler özel sağlayıcılarla aynı kurallara uyar. Var olan kayıtlar, üzerine yazmayı seçmedikçe korunur. Bağlantı oluşturmak için `aswitch link make provider|profile|all` ve Ayarlar → Paylaşım bağlantıları.
- Kayıtlı anahtarlar için **isteğe bağlı işletim sistemi anahtar zinciri** (yerel modül gerekmez): macOS Anahtar Zinciri (`security`, sır stdin ile), Windows Kimlik Bilgisi Yöneticisi (PowerShell + `CredWrite`/`CredRead`, sır stdin ile), Linux Secret Service (`secret-tool`). `aswitch keychain on|off|status` ve Ayarlar → İşletim sistemi anahtar zinciri tüm anahtarları taşır; dosyadaki kopyayı silmeden önce her birini geri okuyup doğrular. Bundan sonra `config.json` yalnızca `@keychain` işaretleri tutar. Anahtar zinciri okunamazsa sağlayıcının ortam değişkeni kullanılır.
- **Dışa giden URL kuralı** (`src/netguard.js`): anahtar gönderilen her URL (özel sağlayıcılar, model listeleri, uç nokta testi, yönlendiricinin hedefleri) `http(s)` olmalı ve `kullanıcı:parola@` içermemeli. Düz `http` yalnızca yerel, özel ağ, `.local`/`.lan`/`.internal` ya da tek parçalı adlı sunuculara izinli. Panelin yönlendirici yoklama portu doğrulanır.
- **Gerçek Gemini CLI uçtan uca testi** (`scripts/gemini-cli-e2e.mjs`, yeni `gemini-cli` CI işi). `@google/gemini-cli` paketini npm'den geçici bir HOME'a kurar ve `aswitch use` + yönlendirici üzerinden yerel sahte bir sağlayıcıya karşı başsız çalıştırır. Şunları doğrular: akışlı yanıt, anahtar/model/araçların sağlayıcıya ulaşması, `list_directory` araç çağrısı gidiş-dönüşü, `aswitch run gemini`, güvenilen klasörde `~/.gemini/.env` okunması ve kullanım kaydı. Gemini CLI 0.62.0 ile doğrulandı.
- Linux **arm64** masaüstü sürümleri (AppImage + deb); her sürümde 10 kurulum dosyası.

### Değişenler
- **Masaüstü: Electron 33 → 44**, electron-builder 25 → 26 (Dependabot PR #1). Masaüstü uygulaması için **macOS 13 (Ventura) ya da daha yenisi gerekir** (Electron 44 macOS 12 desteğini bıraktı). CLI değişmedi: Node.js ≥ 18.
- Sağlayıcılardan gelen model listeleri temizlenir: en çok 5000 kayıt, en çok 200 karakterlik ve kontrol karakteri içermeyen kimlikler; sayısal alanlar sonlu ve ≥ 0 olmalı.
- Gemini CLI uygulandıktan sonra bir ipucu Gemini'nin klasör güvenini açıklar: Gemini CLI `~/.gemini/.env` dosyasını yalnızca güvenilen klasörlerde okur. Başsız çalıştırmalar `--skip-trust` ya da `GEMINI_CLI_TRUST_WORKSPACE=true` ister; `aswitch run gemini` her yerde çalışır.
- Electron uçtan uca testi artık internete ihtiyaç duymaz: yerel sahte bir sağlayıcı ve paketle gelen model listeleri kullanılır (`E2E_LIVE=1` canlı yenilemeyi de ekler). Test artık CI'da **Linux, macOS ve Windows** üzerinde koşar ve dengeleme/senaryo/devre kesici, paylaşım bağlantıları (ikinci örneğe verilen bağlantı dahil) ile anahtar zincirini de kapsar (54 kontrol).

### Düzeltilenler
- Modeller sekmesi: daha önce seçilmiş bir sağlayıcının geç gelen yanıtı, o an seçili sağlayıcının tablosunu silebiliyordu.
- İkinci masaüstü örneği (örneğin bir bağlantının başlattığı) kapanmadan önce kendi panel sunucusunu başlatmaz oldu.

### Güvenlik
- 0.3.0 sonrasında açık kalan CodeQL uyarıları düzeltildi ya da gerekçesi yazılarak kapatıldı (bkz. `docs/AUDIT.md`).

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
