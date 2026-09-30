# Security Policy · Güvenlik Politikası

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on <https://github.com/cumabozkurt/agent-switchboard/security/advisories/new>.

Include the version (`aswitch --version`), your OS, steps to reproduce and the impact. You should get an answer within 7 days.

**Never include real API keys** in reports, logs or screenshots.

## Security model (short)

- Keys are stored in `~/.agent-switchboard/config.json` (`0600`, folder `0700` on macOS/Linux). They are not encrypted; protecting your user account protects them.
- The control panel (`aswitch ui`, desktop app) and the router listen on `127.0.0.1` only. The panel requires a per-launch token, a local `Host` header, JSON content type and small bodies; the router rejects browser requests (`Origin` header) and non-local `Host` headers.
- aswitch never reads or copies Claude Pro/Max or ChatGPT login tokens.
- See the [audit report](docs/AUDIT.md) for details.

---

## Güvenlik açığı bildirme

Güvenlik sorunları için lütfen **herkese açık issue açmayın**. GitHub'ın gizli bildirim özelliğini kullanın: <https://github.com/cumabozkurt/agent-switchboard/security/advisories/new>.

Sürümü (`aswitch --version`), işletim sisteminizi, yeniden üretme adımlarını ve etkisini yazın. 7 gün içinde yanıt almanız beklenir. Bildirimlere, günlüklere veya ekran görüntülerine **asla gerçek API anahtarı eklemeyin**.
