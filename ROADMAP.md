# base-gas-x402 Yol Haritası

**Son güncelleme:** 27 Temmuz 2026
**Hedef:** Bulunabilir ve satılabilir bir servisten, düzenli gelir üreten bir servise geçmek.

---

## Şu anki durum

| | Başlangıç (25 Tem) | Şimdi |
|---|---|---|
| Endpoint | 1 | 5 |
| Fiyat | $0.001 | $0.005 - $0.02 |
| Discovery uyarısı | 2 | 0 |
| Bazaar kaydı | Her saat reddediliyor | Çalışıyor |
| AgentCash arama sırası | Görünmüyor | **1.** |
| Dağıtım kanalı | Yok | Skill repo, npm, 2 PR |
| Web sitesi | Yok | Yayında |
| **Üçüncü taraf işlem** | **0** | **0** |

Son satır hala işin özü. Ürün hazır, bulunabilir, tanıtımı var. Müşteri yok.

**Yayındaki varlıklar**

| Ne | Nerede |
|---|---|
| API | https://base-gas-x402-production.up.railway.app |
| Site | https://base-gas-x402.vercel.app |
| API kaynak | https://github.com/memosr/base-gas-x402 |
| Agent skill | https://github.com/memosr/base-gas-skill |
| MCP paketi | https://www.npmjs.com/package/base-gas-mcp |

| Endpoint | Fiyat |
|---|---|
| `GET /gas` | $0.005 |
| `GET /gas/compare` | $0.01 |
| `GET /gas/history` | $0.012 |
| `GET /gas/cheapest-window` | $0.02 |
| `GET /health` | ücretsiz |

---

## Bitenler

**Faz 1: Discovery optimizasyonu** — Türkçe `x-guidance` İngilizceye çevrildi, etiketler genişletildi, `L3_INPUT_SCHEMA_MISSING` ve `FAVICON_MISSING` uyarıları temizlendi, `gasLimit` parametresi eklendi.

**Faz 2: Fiyatlandırma** — $0.001'den $0.005'e çıkarıldı, tüm fiyatlar env değişkenlerine taşındı.

**Faz 3: Endpoint genişletmesi** — 1'den 5'e. `/gas/compare` (4 zincir), `/gas/history` (zaman serisi + hüküm), `/gas/cheapest-window` (saatlik sıralama), `/health` (ücretsiz kapsama raporu).

**Faz 4 (kısmen): Dağıtım** — npm paketi 0.2.0'a güncellendi, agentcash-skills'e PR #26, awesome-agentic-commerce'e PR #520, kendi skill repo'su yayınlandı, web sitesi kuruldu.

**Faz 5 (kısmen): Güvenilirlik** — zincir başına yedekli RPC listesi, ödeme yükü boyutu için erken uyarı loglaması.

**Güvenlik** — Alchemy API anahtarı `/gas` yanıtında sızıyordu, kapatıldı. *Anahtar hala rotate edilmedi.*

---

## Yol boyunca bulunanlar

**1. `trust proxy` eksikti (kritik, çözüldü)**

Railway TLS'i kenarda sonlandırıp düz HTTP iletiyor. Express `req.protocol` değerini `http` görüyor, x402 kaynağı `http://` olarak ilan ediyordu. Bazaar kaydı her saat reddediliyordu:

```
resource must start with 'https://' when protocol type is http
```

Servisin ilk gününden beri sürüyordu. x402scan'in origin'i hiç güncellememesinin ve dolayısıyla AgentCash aramasında görünmemenin tek sebebi buydu. Çözüm: `app.set("trust proxy", true)`.

**2. CDP facilitator ödeme yükünü boyutla sınırlıyor (çözüldü)**

402 challenge'ındaki bazaar metadata'sı ödeme yüküne gömülüyor. Sınır aşılınca facilitator şema hatası döndürüyor:

```
'paymentPayload' is invalid: must match one of [x402V2Pay...
```

Ölçüldü: **4188 byte kabul, 4260 byte ret.** `/gas/history` uzun açıklaması yüzünden ödeme alamıyordu. Çözüm: tüm route'larda bazaar açıklamaları 400-470 karakterden 112-155'e indirildi. Keşfi besleyen zengin metin OpenAPI'da kaldı, o yüke dahil değil.

**3. Base'de gas'ın günlük döngüsü yok (ürün kararı)**

İki bağımsız 15 saatlik pencerede ölçüldü, en ucuz ve en pahalı saat arasındaki fark **%0**. `/gas/cheapest-window` "en ucuz saat" satmaya çalışıyordu, satacak bir şey yoktu.

Düzeltildi: `hasDailyCycle: false` ve düz bir dille "zamanlama tasarruf sağlamaz" cevabı. `/gas/history` de artık spread %1'in altındaysa `flat` diyor, sahte bir `cheap` hükmü vermiyor.

Bu hatayı ürünü test eden bir ajan buldu.

**4. Rekabet ilk sandığımızdan yoğun**

En az beş rakip Base gas endpoint'i var. `gas.ivan-tempo.xyz` yedi zincir kapsıyor, `statepulse-api` geçmiş veriyi $0.001'e satıyor, `httpay.xyz` yüzdelik ve trend analizi sunuyor. "Geçmiş veri bir hendek" değerlendirmesi yanlıştı.

**5. Sıralamada kullanım verisi ağır basıyor**

`payanagent.com` anlamsal sıralamada 19. olduğu halde toplam skorda 3. sırada, çünkü 397 bin işlemi var. Metin optimizasyonu bizi 1. sıraya taşıdı ama kullanım verisi biriktikçe bu avantaj erir.

---

## Kalanlar

### Faz 4: İlk kullanıcılar (öncelik)

- [ ] **Agregatörlere gir.** Gerçek trafiğin olduğu yer. `payanagent.com` (397K işlem, 726 kullanıcı), `x402helper.xyz` (178 işlem, 29 kullanıcı), `httpay.xyz` (307 endpoint). Rakip değil dağıtım kanalı, arza ihtiyaçları var.
- [ ] **Doğrudan ajan geliştiricilerine ulaş.** x402scan üzerinden Base'de işlem yapanları tespit et, ilk 10 kişiye yaz.
- [ ] **PR'ları takip et.** agentcash-skills #26 ve awesome-agentic-commerce #520 açık.
- [ ] **X hesabı aç** (proje için ayrı hesap, sonra).

### Faz 5: Güvenilirlik ve hendek

- [ ] **Geçmiş veriyi kalıcı hale getir (Upstash Redis, ücretsiz katman).** Artık öncelikli: veri bellekte ve her deploy sıfırlıyor, ama site "168 saat retention" tanıtıyor. En ayrıştırıcı özellik buna bağlı.
- [ ] **Alchemy anahtarını rotate et.** Sızmıştı, kod düzeltildi ama anahtar değişmedi.
- [ ] RPC yanıtlarını 2-5 saniye cache'le
- [ ] Rate limiting
- [ ] Uptime monitörü

### Sitede düzeltilecekler

- [ ] "No competitor does this" ifadesini "I have not found another that does" ile değiştir. Kanıtlanamayan olumsuzlama.
- [ ] Örnekleme sürekliliği ima eden cümleyi düzelt: veri bellekte ve deploy'da sıfırlanıyor, bunu açıkça yaz.
- [ ] `/health` için CORS ekle, sitedeki kapsama satırı canlı sayı gösterebilsin (tek satır)
- [ ] Findings bölümünü ayrı bir teknik yazıya taşımayı değerlendir
- [ ] Custom domain

### Açık ürün soruları

- **`/gas/cheapest-window` bu haliyle satılabilir mi?** Base düz olduğu için sürekli "yapacak bir şey yok" diyor. Dürüst ama $0.02'lik bir cevap için ince. Fiyat düşürülmeli veya endpoint anomali tespitine (`gas-anomaly`) çevrilmeli.
- **`/gas/history` fiyatı $0.012, rakipte $0.001 var.** Zengin çıktı bunu haklı çıkarıyor mu, yoksa fiyat kırılmalı mı?
- **`HISTORY_PRICE_USD=0.012` env değişkeni** dünkü bir testten kaldı. Bilinçli bir fiyat değil, temizlenmeli.

---

## Takip metrikleri

| Metrik | 25 Tem | 27 Tem | 30 gün hedefi |
|---|---|---|---|
| Üçüncü taraf işlem | 0 | 0 | 100 |
| Benzersiz cüzdan | 0 | 0 | 10 |
| Endpoint | 1 | 5 | 5 |
| Arama sırası (`cheapest-window`) | yok | **1.** | ilk 3'te kal |
| Dağıtım kanalı | 0 | 4 | 6 |

Sıralama kazanıldı. Sıradaki tek metrik kullanım.
