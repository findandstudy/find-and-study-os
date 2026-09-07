# Program İçeriği Yerelleştirme — Uygulama Notu

Tarih: 7 Eylül 2026
Durum: Yerel uygulama ve doğrulama tamamlandı; staging/production değişmedi.

## Sonuç

- Sistem arayüzü için kanonik dil kümesi 16 dile çıkarıldı: `en`, `tr`, `ar`, `fr`, `ru`, `fa`, `zh`, `hi`, `es`, `id`, `ur`, `tk`, `ky`, `kk`, `uz`, `tg`.
- Program adı, açıklaması, alanı, süresi, intake ve gereksinimleri için İngilizce tek kaynak kabul edilir.
- Yeni program oluşturulduğunda veya kaynak alanlardan biri değiştiğinde diğer 15 dil için çeviri işleri veritabanında otomatik ve kalıcı olarak kuyruğa alınır.
- Yalnız `published` durumundaki güncel çeviriler kullanıcıya gösterilir. Çeviri hazır değilse sistem güvenli biçimde İngilizce kaynağa döner ve bu durumu `fallbackUsed` ile belirtir.

## Veri ve işlem sözleşmesi

`0107_program_content_translations.sql` migration'ı `program_translations` tablosunu, kuyruk durumlarını, iş lease'lerini, retry zamanlarını ve kaynak hash bağını oluşturur.

Durumlar:

- `queued`: işlenmeyi bekliyor
- `processing`: süreli worker lease'i altında
- `retrying`: geçici hatadan sonra zamanlanmış tekrar
- `published`: güncel ve yayına uygun
- `failed`: retry bütçesi bitmiş veya kalıcı hata
- `stale_manual`: İngilizce kaynak değiştiği için manuel çevirinin insan kontrolü gerekiyor

Kaynak değişiklikleri aktif lease'i geçersizleştirir. Eski kaynağa göre dönen worker sonucu source-hash koşulu nedeniyle yazılamaz. Manuel çeviriler worker tarafından ezilmez.

## Çeviri sağlayıcısı ve worker

- Worker varsayılan olarak kapalıdır: `PROGRAM_TRANSLATION_WORKER_ENABLED=false`.
- Eşzamanlılık `PROGRAM_TRANSLATION_CONCURRENCY` ile yönetilir ve `1..8` aralığı dışında fail-safe değere döner.
- Sağlayıcı önceliği yönetim panelinde yapılandırılmış Anthropic/Claude, ardından OpenAI entegrasyonudur.
- API anahtarı yalnız istek sırasında bellekte çözülür; loglara program metni, kişisel veri veya secret yazılmaz.
- Sağlayıcı yanıtı katı JSON şeması, alan listesi, boyut sınırları ve null-koruma ile doğrulanır.
- Rate-limit, timeout ve geçici sağlayıcı hataları kontrollü backoff ile en fazla beş denemeye kadar yürütülür.

## Ürün yüzeyleri

- Admin Katalog program formu İngilizce açıklamayı kabul eder.
- Program satırında `x/15` çeviri kapsamı, dil/durum/hata/deneme ayrıntısı ve güvenli retry kontrolleri bulunur.
- Program import/export şablonunda `Description` alanı vardır.
- Public Programs, Staff Course Finder ve AI bot program araması seçilen dili ister; güncel çeviri yoksa İngilizceyi kullanır.
- API'deki `locale`, eğitim dili filtresi olan mevcut `language` parametresinden ayrıdır.
- Sitemap 16 locale için hreflang üretir; Urduca da RTL dilidir.

## Staging aktivasyon kapısı

Staging'e geçiş ayrı onayla şu sırada yapılmalıdır:

1. Kod deploy edilir ve migration `0107` yalnız kanonik migrator ile uygulanır.
2. Claude veya OpenAI entegrasyonu yönetim panelinden doğrulanır.
3. Worker ayrı process olarak veya izin verilen background-job koordinatörü içinde önce concurrency `1` ile açılır.
4. Bir sentetik programda 15/15 sonuç, fallback, kaynak güncellemesi ve stale-manual davranışı doğrulanır.
5. Kuyruk derinliği, hata kodları, retry ve sağlayıcı rate-limit'i gözlenir; sonra kontrollü artırılır.

## Kanıt

- Migration ledger ve uygulanmış yerel DB: `108/108`
- Program translation contract testleri: `6/6`
- PostgreSQL tetikleyici/kuyruk testi: PASS (`15 locale`, lease invalidation, manual review, cascade)
- i18n kontrolü: `16 language`, `5020` kullanılan anahtar, key ve placeholder parity PASS
- Tam workspace typecheck: PASS
- API production build: PASS
- Edcons production build ve `16 × 6` sitemap: PASS

## Bilinen yayın öncesi kalite işi

Yeni altı arayüz sözlüğü (`ur`, `tk`, `ky`, `kk`, `uz`, `tg`) yapısal olarak eksiksiz ve makine çevirisi başlangıç sürümüdür. Production'da dil kalitesi iddiası için native dil incelemesi yapılmalıdır. İmzalı e-posta şablonları halen beş dilde native metin taşır ve diğer dillerde güvenli İngilizce fallback kullanır; bu çalışma program içeriği otomasyonundan ayrıdır.
