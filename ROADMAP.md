# base-gas-x402 Yol Haritası

**Hedef:** 0 işlemden, AgentCash aramalarında ilk sırada çıkan ve düzenli gelir üreten bir servise geçmek.

**Tarih:** 25 Temmuz 2026
**Mevcut durum:** Canlı, indeksli, teknik olarak sağlam, 0 işlem.

---

## İlerleme (26 Temmuz 2026 güncellemesi)

| Faz | Durum | Not |
|---|---|---|
| Faz 0 | Kısmen | `/health` ölçüm veriyor; istek sayacı henüz yok |
| Faz 1 | **Bitti** | Kod ve deploy tamam, discovery uyarıları temiz. Etkisi henüz ölçülemedi, AgentCash anlamsal indeksi 12+ saattir yenilenmedi |
| Faz 2 | **Bitti** | $0.001 → $0.005, fiyatlar env değişkenlerine taşındı |
| Faz 3 | **Bitti** | 1 → 5 endpoint |
| Faz 4 | Sırada | Dağıtım |
| Faz 5 | Kısmen | RPC yedekleme yapıldı; cache ve uptime izleme kaldı |

**Yayındaki endpoint'ler**

| Endpoint | Fiyat |
|---|---|
| `GET /gas` | $0.005 |
| `GET /gas/compare` | $0.01 |
| `GET /gas/history` | $0.01 |
| `GET /gas/cheapest-window` | $0.02 |
| `GET /health` | ücretsiz |

## 27 Temmuz gecesi: iki gizli hata

**1. `trust proxy` eksikti (kritik)**

Railway TLS'i kenarda sonlandırıp isteği düz HTTP olarak iletiyor. Express `req.protocol` değerini `http` görüyor, x402 middleware kaynak URL'ini `http://...` olarak ilan ediyordu. Bazaar kaydı bunu reddediyordu:

```
discovery request validation failed:
resource must start with 'https://' when protocol type is http
```

Bu **her saat, servisin ilk gününden beri** oluyordu. x402scan'in origin'i hiç otomatik güncellememesinin sebebi buydu. Çözüm: `app.set("trust proxy", true)`.

**2. Ödeme yükü boyut sınırı**

402 challenge'ındaki bazaar metadata'sı (açıklama, etiketler, örnek çıktı) x402 ödeme yüküne olduğu gibi gömülüyor. CDP facilitator payload'a boyut sınırı uyguluyor ve aşıldığında bunu şema hatası olarak raporluyor:

```
'paymentPayload' is invalid: must match one of [x402V2Pay...
```

Ölçülen değerler: **4188 byte kabul, 4260 byte ret.** `/gas/history` uzun açıklaması yüzünden sınırın üstündeydi ve ödeme alamıyordu. Diğer üç endpoint şans eseri altında kalmıştı, `/gas/compare` sınıra 70 byte mesafedeydi.

Çözüm: tüm route'larda bazaar açıklamaları 400-470 karakterden 112-155'e indirildi, etiketler 10-16'dan 5-6'ya. Keşfi besleyen zengin metin OpenAPI dokümanında kaldı, o ödeme yüküne dahil değil. Ayrıca 3800 byte üstünde uyarı loglayan bir erken uyarı eklendi.

**Çıkarılacak ders:** bu iki hata da sessizdi. Discovery aracı temiz rapor veriyordu, endpoint'ler canlıydı, ama biri keşfi tamamen bloke ediyor diğeri bir endpoint'in para almasını engelliyordu. Loglara bakmadan ikisi de bulunamazdı.

**Yol boyunca çıkan ek bulgular**

- Alchemy API anahtarı `/gas` yanıtında sızıyordu, kapatıldı. Anahtarın rotate edilmesi gerekiyor.
- Doğrulayıcı 40'tan fazla endpoint'i uyarı sebebi sayıyor (`ROUTE_COUNT_HIGH = 40`). Rakiplerin 67 ve 353 endpoint'i bu eşiğin üstünde. Endpoint yığmak avantaj değil.
- Ethereum'un ücretsiz public RPC'leri veri merkezi IP'lerini engelliyor. Zincir başına yedekli RPC listesi eklendi.
- Geçmiş veri bellekte tutuluyor, **her deploy sıfırlıyor**. Veri birikmesi için deploy'ların seyrekleşmesi gerekiyor.

---

## Teşhis

Sorun teknik değil. Kod temiz, x402 akışı doğru, OpenAPI ve Bazaar discovery kurulu, CDP production facilitator bağlı. AgentCash indeksinde kayıtlısın:

```
x402OriginId : 39cfda09-3a55-4a7b-84e3-ffdadc422d63
trustTier    : origin_hosted
```

Sorun **sıralama**. AgentCash araması iki sinyali birlikte kullanıyor:

1. Anlamsal benzerlik (senin metnin ne kadar sorguya uyuyor)
2. Kullanım verisi (kaç işlem, kaç kullanıcı, ne kadar hacim)

Ölçüm sonuçları:

| Sorgu | Sıran |
|---|---|
| `base-gas-x402 live Base mainnet gas base fee priority fee transfer cost` | 2 |
| `base mainnet gas price fees` | İlk 10'da yok |

İkinci sorgu ajanların gerçekte yazacağı sorgu. Orada görünmüyorsun.

**Neden:** Genel aramada 1. sıraya çıkan `x402helper.xyz`'nin anlamsal skoru seninkinden düşük (0.642 vs 0.662) ama kullanım verisi onu yukarı taşıyor:

| | Sen | x402helper.xyz |
|---|---|---|
| İşlem | 0 | 177 |
| Kullanıcı | 0 | 28 |
| Hacim | $0 | $5.91 |
| Güvenilir kullanıcı oranı | 0 | 0.0082 |

Klasik yumurta-tavuk problemi: sıralamak için kullanım lazım, kullanım için sıralamak lazım. Bu yol haritası o döngüyü kırmak üzerine kurulu.

---

## Stratejik not: asıl rekabet avantajı nerede

Şu an pazardaki herkes aynı şeyi satıyor: **anlık gas fiyatı**. Bu bir emtia. Herhangi bir ajan ücretsiz bir RPC'ye `eth_gasPrice` atıp aynı veriyi bedava alabilir. Uzun vadede bu ürünün fiyatı sıfıra gider.

Ücretsiz RPC'nin veremeyeceği şeyler:

- **Tarihsel veri.** "Son 7 günde gas nasıl seyretti?"
- **Tahmin.** "Önümüzdeki 6 saatte en ucuz saat hangisi?"
- **Karar.** "Şimdi mi göndereyim, bekleyeyim mi?"
- **İşlem tipine göre maliyet.** Transfer, swap, NFT mint, kontrat deploy ayrı ayrı.

Bunlar veri biriktirmeyi gerektiriyor, yani zamanla derinleşen bir hendek. Rakiplerin kopyalaması aylar alır. Yol haritasının ağırlık merkezi burası.

---

## Faz 0: Ölçüm altyapısı

**Süre:** yarım gün
**Amaç:** Hiçbir şeyi optimize etmeden önce ölçebilir olmak. Şu an kaç istek geldiğini bilmiyoruz.

- [ ] `/gas` üzerine istek sayacı ekle (tarih, ödeme başarılı mı, ödeyen adres)
- [ ] Ücretsiz `/stats` endpoint'i: toplam çağrı, toplam kazanç, benzersiz cüzdan
- [ ] Railway log'larını kalıcı hale getir veya basit bir kalıcı sayaç (SQLite / Upstash Redis)
- [ ] Bugünün baseline'ını kaydet: 0 işlem, 0 kullanıcı, $0

**Başarı ölçütü:** Yarın "kaç çağrı geldi" sorusuna kesin cevap verebiliyoruz.

---

## Faz 1: Discovery optimizasyonu

**Süre:** 1 gün
**Amaç:** Kullanım verisi olmadan da anlamsal skorla yukarı çıkmak. En ucuz ve en hızlı kazanç burada.

- [ ] **`x-guidance` alanını İngilizceye çevir.** Şu an Türkçe: *"GET /gas ile canlı Base mainnet gas verisi al..."*. İndeksleme ve ajan sorguları İngilizce çalışıyor, bu doğrudan skor kaybı.
- [ ] Bazaar `tags` dizisini genişlet. Şu an: `["gas", "base", "fees", "infrastructure"]`. Ekle: `base-l2`, `coinbase-base`, `eip-1559`, `gwei`, `gas-oracle`, `transaction-cost`, `onchain-data`
- [ ] `description` metnine ajanların yazdığı ifadeleri göm: "check gas before sending a transaction", "estimate transaction cost on Base", "find cheap time to transact", "compare Base gas to other L2s"
- [ ] OpenAPI `info.description` alanını zenginleştir, sağlayıcı takma adlarını ekle (Base L2, Coinbase Base, Base mainnet)
- [ ] `serviceName` ve `summary` alanlarını rakiplerin formatına yaklaştır ama daha spesifik tut

**Başarı ölçütü:** `base mainnet gas price fees` sorgusunda ilk 10'a girmek.

---

## Faz 2: Fiyatlandırma düzeltmesi

**Süre:** 1 saat
**Amaç:** Bırakılan parayı toplamak.

Piyasa fiyatları:

| Sağlayıcı | Fiyat |
|---|---|
| **base-gas-x402 (sen)** | **$0.001** |
| BizIntel API | $0.010 |
| Basalt | $0.010 |
| x402helper.xyz | $0.013 |
| x402 Trading Hub | $0.050 |
| x402 Trading Hub (v7/v8) | $0.100 |

Piyasanın 10 ila 100 katı altındasın. Üstelik verin daha zengin: rakiplerin çoğu tek bir `gasPrice` dönerken sen base fee, üç öncelik seviyesi ve transfer maliyeti tahmini dönüyorsun.

- [ ] `/gas` fiyatını **$0.005**'e çıkar. Hala pazarın en ucuzu, ama gelir 5 katına çıkıyor.
- [ ] Fiyatı `GAS_PRICE` sabitinden env değişkenine taşı, deploy etmeden değiştirebil
- [ ] OpenAPI ve landing sayfasındaki fiyatları senkron tut (şu an ikisi de aynı sabitten besleniyor, bu iyi)

**Not:** Fiyat artışını Faz 1'den sonra yap. Önce görünürlük, sonra fiyat.

**Başarı ölçütü:** Çağrı başına gelir 5x, çağrı sayısında düşüş yok.

---

## Faz 3: Endpoint genişletmesi

**Süre:** 3 ila 5 gün
**Amaç:** Her yeni endpoint yeni bir arama yüzeyi. Rakiplerin 67 ve 353 endpoint'i var, senin 1.

Öncelik sırasına göre:

- [ ] **`GET /gas/estimate?type=transfer|swap|erc20|nft-mint|deploy`** ($0.005)
      İşlem tipine göre maliyet. En çok aranan sorgu tiplerinden biri, `x402.eruditepay.com` ve `x402helper.xyz` bu yüzden yukarıda.
- [ ] **`GET /gas/history?hours=24`** ($0.01)
      Tarihsel seyir. Faz 0'daki veri toplama altyapısını burada kullanırız. Rakiplerde yok.
- [ ] **`GET /gas/cheapest-window?hours=24`** ($0.02)
      "En ucuz saat hangisi." Ücretsiz RPC'nin veremeyeceği ilk gerçek katma değer.
- [ ] **`GET /gas/compare`** ($0.01)
      Base, Optimism, Arbitrum, Ethereum karşılaştırması. "compare Base gas to other L2s" araması rakiplerin metinlerinde var, seninkinde yok.
- [ ] **`GET /health`** (ücretsiz)
      Uptime kanıtı. Güven sinyali.

Her endpoint için: OpenAPI kaydı, Bazaar metadata, İngilizce açıklama, anahtar kelimeler.

**Başarı ölçütü:** 6 endpoint, her biri en az bir arama sorgusunda ilk 5'te.

---

## Faz 4: Dağıtım ve ilk kullanıcılar

**Süre:** Sürekli
**Amaç:** Yumurta-tavuk döngüsünü kırmak. Sıralamayı yükselten şey `trustedUserUsageRatio`, yani **güvenilir kullanıcılardan** gelen çağrılar. Kendi cüzdanınla kendini çağırman işe yaramaz (zaten `self_send_not_allowed` ile engelleniyor).

- [ ] `base-gas-mcp` reposunu tamamla ve yayınla. Ajanlar MCP olarak kurabilsin.
- [ ] AgentCash skills reposuna PR aç: [Merit-Systems/agentcash-skills](https://github.com/Merit-Systems/agentcash-skills). Kabul edilirse doğrudan binlerce ajanın kurulum listesine girersin.
- [ ] x402scan ve mppscan kayıtlarını doğrula, eksik metadata varsa tamamla
- [ ] `awesome-x402` reposuna PR aç
- [ ] X üzerinde @agentcashdev ve @x402scan etiketleyerek duyur, canlı demo linkiyle
- [ ] AgentCash Discord'unda geliştirici kanalında paylaş
- [ ] İlk 10 gerçek kullanıcıya ulaş: x402 geliştiren kişilere doğrudan yaz, endpoint'i ücretsiz denemelerini iste

**Başarı ölçütü:** 30 gün içinde 10 benzersiz cüzdandan 100 işlem.

---

## Faz 5: Güvenilirlik ve hendek

**Süre:** Sürekli
**Amaç:** Trafik gelince kaybetmemek.

- [ ] RPC yanıtlarını 2 ila 5 saniye cache'le. Aynı blok için tekrar tekrar RPC çağırmanın anlamı yok, hem maliyet hem gecikme.
- [ ] Yedek RPC sağlayıcı ekle (Alchemy veya QuickNode). `mainnet.base.org` tek nokta arıza riski.
- [ ] Rate limiting, kötüye kullanıma karşı
- [ ] Uptime monitörü (UptimeRobot veya Better Stack), landing sayfasında rozet göster
- [ ] Gas verisini sürekli topla ve sakla. Faz 3'teki tarihsel endpoint'lerin yakıtı bu, ve zamanla değeri artan tek varlığın.

**Başarı ölçütü:** %99.5 uptime, p95 yanıt süresi 500ms altı.

---

## Zaman çizelgesi

| Hafta | Odak |
|---|---|
| 1 | Faz 0 + Faz 1 (ölçüm ve discovery) |
| 2 | Faz 2 + Faz 3 başlangıcı (fiyat ve ilk 2 endpoint) |
| 3 | Faz 3 tamamlama (kalan endpoint'ler) |
| 4 | Faz 4 (dağıtım hamlesi) |
| Sürekli | Faz 5 |

---

## Takip edilecek metrikler

Her hafta Faz 0'daki `/stats` endpoint'inden oku:

| Metrik | Bugün | 30 gün hedefi |
|---|---|---|
| Toplam çağrı | 0 | 100 |
| Benzersiz cüzdan | 0 | 10 |
| Hacim (USD) | $0 | $0.50 |
| Endpoint sayısı | 1 | 6 |
| `base mainnet gas price fees` sıralaması | 10+ | ilk 3 |

Hedefler mütevazi görünüyor ama pazar da çok küçük. Rakiplerin çoğunda 0 işlem var, en iyisinde 177. Yani ilk 100 işlem seni pazarın üst yüzde 10'una sokar.

---

## Kabuller ve riskler

- **Pazar erken.** Toplam hacim küçük. Bu bir risk değil, fırsat. Herkes sıfırdan başlıyor.
- **Anlık gas fiyatı emtialaşacak.** Bu yüzden Faz 3'te tarihsel ve tahmine dayalı ürünlere geçiyoruz.
- **Sıralama algoritması değişebilir.** AgentCash yeni bir ürün. Kullanım ağırlığı azalabilir veya artabilir. Bu yüzden hem anlamsal (Faz 1) hem kullanım (Faz 4) tarafında paralel çalışıyoruz.
- **Railway ücretsiz katmanı.** Trafik artarsa maliyet çıkabilir. Faz 5'te izlenmeli.
