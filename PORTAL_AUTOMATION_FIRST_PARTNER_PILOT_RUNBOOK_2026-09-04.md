# Portal Automation — İlk Partner Staging Pilot Runbook

Tarih: 4 Eylül 2026
Ortam: yalnız `staging.findandstudy.com`
Production durumu: **NO-GO**

## 1. Karar

İlk gerçek pilot, adı ve hesap sahibi açıkça belirlenmiş **tek** üniversite veya
partner portalıyla yapılır. Ortak worker, fan-out, otomatik fallback ve toplu
işleme pilot tamamlanmadan açılmaz.

İki ayrı hedef birbirine karıştırılmaz:

| Hedef | En düşük riskli başlangıç |
| --- | --- |
| Mevcut browser-submit hattını kanıtlama | Hesap mevcutsa Topkapı adapterıyla tek manuel canary. Topkapı tek production-active adapterdır; yine de mevcut adapterda status/artifact takibi yoktur. |
| Gerçek A–Z kapalı döngüyü kanıtlama | Seçilen gerçek partner için admin panelden yüklenecek versioned **spec v2**. Strict dry-run, identity-bound status check, doğru application number ve offer/final artifact toplama aynı sözleşmede tanımlanabilir. |

Okan aktif fakat fail-closed çalışır ve status/artifact metodu yoktur. Multico
status check içerir fakat deneysel ve artifact toplamaz. Salesforce, SIT,
United, EMU, Altınbaş, Multico ve Medipol aileleri üç doğrulanmış başarıya
kadar manual-only kalır. Yeni/yüklenen her custom adapter da aynı şekilde
manual-only başlar; bilinmeyen bir adapter anahtarı artık production-ready
sayılmaz.

Bu nedenle teknik varsayılan **Topkapı ile submit canary**, ürün hedefi için
ise **seçilen partnerin spec v2 closed-loop pilotu**dur. Hangi yolun
çalıştırılacağını gerçek hesabın sahibi, portalın izinleri ve exact login origin
belirler; bu bilgi olmadan dış trafik açılmaz.

## 2. Kullanıcıdan gereken güvenli girdiler

Pilot başlamadan aşağıdaki dört bilgi gerekir:

1. Kurum/partnerin kanonik adı ve CRM katalog kaydı.
2. Exact HTTPS login URL ve uygulama/status sayfalarının izinli origin listesi.
3. Hesabın test/sandbox mı, gerçek acente hesabı mı olduğu ve otomasyon izni.
4. İlk canary için kullanılacak sentetik veya açıkça onaylı staging öğrenci
   kaydı.

Kullanıcı adı, parola, token veya MFA recovery kodu chat'e, JSON mapping
dosyasına, Git'e ya da loga yazılmaz. Credential yalnız Portal Automation içindeki
şifreli **Portal Credentials** ekranından girilir.

## 3. Kodsuz onboarding sırası

Başlangıç noktası **Admin > Portal Automation > Partner Setup** sekmesidir.
Bu ekran credential içermeyen tek bir readiness görünümünde partner, adapter,
HTTPS portal URL'si, credential referansı, CRM katalog bağlantısı, aktif program
ve mezuniyet kanıtını birlikte gösterir. Bir partner ilk oluşturulduğunda her
zaman inactive, auto-process kapalı ve fan-out kapalıdır; readiness kapıları
geçilmeden UI veya API üzerinden etkinleştirilemez.

### P0 — Kurum ve origin dondurma

- Kurum adı, portal hesabı sahibi, login URL ve izinli origin'ler kayıt altına
  alınır.
- Redirect sonrası farklı origin, CAPTCHA/MFA zorunluluğu, eşzamanlı oturum
  kısıtı ve portal kullanım şartları doğrulanır.
- API/webhook olmadığı belgelenir; portal otomasyonu sözleşmesel olarak izinli
  değilse süreç insan görev kuyruğunda kalır.

### P1 — AI mapping paketi

- AI mapping çıktısı **specVersion 2 JSON** olmalıdır.
- Paket credential, öğrenci PII'ı, cookie/storage state veya ham portal HTML'i
  içermez.
- `meta.key`, exact `baseUrl`, exact `loginUrl`, `matches`, program seçimi,
  belge slotları, bounded workflow state'leri ve ordered outcome kuralları
  bulunur.
- Varsayılan `resolution=fallback`, `dryRunPolicy=strict` ve
  `experimental=true` kullanılır. Mevcut code adapter override edilmez.
- `jsHook` kullanılmaz. Zorunlu HTTP/GraphQL varsa yalnız exact
  `allowedOrigins` tanımlanır; ayrı privileged approval gerektirir.

### P2 — Validate, inert upload ve immutable kimlik

- Admin > Portal Automation > Adapter Management > Versioned Adapter Specs
  alanında önce **Validate** çalıştırılır.
- Dönen canonical SHA-256 ve byte size pilot kaydına alınır.
- Upload yeni immutable version oluşturur ve **disabled** kalır; upload hiçbir
  approval veya activation devralmaz.
- Privileged veya jsHook blocker varsa Super Admin exact version ve exact hash
  üzerinden ayrı karar verir. Approval olmadan activation denenmez.
- Versiyon etkinleştirilse bile university `isActive=false`, auto-process kapalı,
  fan-out kapalı ve global automation Test Mode'da tutulur.

### P3 — CRM bağları ve credential

- Üniversite kaydı inactive oluşturulur ve exact CRM university ID'ye bağlanır.
- Program/intake mapping yalnız benzersiz hedeflere yapılır; belirsiz eşleşme
  fail-closed kalır.
- Portal credential şifreli UI'dan girilir; API yalnız `hasCredentials`
  boolean'ını döndürür.
- Test-login yalnız bu tek hesap için `job_kind=test_login` olarak dedicated
  worker'a kuyruğa alınır; API tarayıcı başlatmaz ve `202 + status URL` döner.
  Loglarda credential, cookie, PII ve application number bulunmadığı doğrulanır.
- Test Login sonucu yalnız mevcut partner generation, enabled adapter
  version/hash, encrypted credential sürümü ve runtime release kimliğiyle bağlı
  append-only receipt olarak geçerlidir. Aynı request key farklı sonuç veya
  evidence için tekrar kullanılamaz.

### P4 — Strict dry-run

- Scope `selected`, yalnız pilot kurum; trigger stage canlı Application Pipeline
  kataloğundaki bir non-terminal stage olur.
- Dedicated worker yalnız `WORKER_EXECUTION_MODES=test_login,dry` ile çalışır;
  `real`, fan-out, fallback ve scheduler kapalı kalır. Dry-run yalnız admin
  tarafından tek kayıt için kuyruğa alınır; API tarayıcı başlatmaz ve
  `202 + status URL` döner.
- API ve worker aynı exact release artefaktını ve aynı `RELEASE_ID` değerini
  kullanır. Receipt release bağı uyuşmazsa yürütme fail-closed reddedilir.
- Spec v2 strict dry-run login/read-only gözlem yapabilir fakat application
  workflow mutation, upload, field fill, final click, HTTP mutation veya GraphQL
  çalıştıramaz.
- Beklenen sonuç: portal state doğru algılanır, program ve identity hedefi
  benzersizdir, hiçbir submission başarı olarak yazılmaz ve dış yazı
  denominator'ları değişmez.
- Başarılı Strict Dry Run receipt'i exact application ve portal submission
  çiftine composite FK ile bağlı olmalıdır; serbest bir ekran testi otomasyon
  kilidini açamaz. Sonraki başarısız kontrol önceki başarılı receipt'i geçersiz
  kılar.

### P5 — Tek gerçek manual canary

- Ayrı maker-checker kaydında exact application, adapter key, version, hash,
  program/intake ve operator kimliği onaylanır.
- `mode=real` yalnız tek manual submission için açılır; scheduler, fan-out ve
  fallback kapalıdır.
- Sonuç ancak açık portal success evidence ile `submitted` olabilir. Retry aynı
  idempotency kimliğiyle duplicate başvuru yaratmamalıdır.
- `externalRef`, polling için adaptera özgü opaque kimlik olabilir; CRM'deki
  **University Application ID** alanına doğrudan kopyalanmaz.
- University Application ID yalnız status check'in exact externalRef ile aynı
  başvuru satırını bulduğu, semantic label/structured field/matched-row kaynağı
  taşıdığı ve `identityBound + targetBound + uniqueMatch` kanıtlarının üçü de
  true olduğu durumda yazılır. Mevcut farklı değer overwrite edilmez; review
  conflict oluşturur.

### P6 — Kapalı döngü takip

- Status sweep önce manuel ve tek submission için `job_kind=status_check`
  olarak dedicated worker'a kuyruğa alınır. API yalnız
  `status_check_next_at=now()` yazar; tarayıcı veya artifact collector çalıştırmaz.
- Status gözlemi ve artifact collection yalnız worker'da yürür. Pilot boyunca
  scheduler kapalıdır ve API `202 + status URL` döner.
- `MISSING_DOCUMENT` sonucu bounded belge kodu/etiketi ve redacted observation
  üretmelidir; öğrenciye dış mesaj bu pilotta otomatik gönderilmez.
- Offer/final status tek başına stage değiştiremez. Exact allowlisted origin,
  content-length, hard 15 MiB, MIME allowlist, magic-byte ve SHA-256 kanıtı
  geçen artifact Application Documents'a `portal_automation` kaynağıyla düşer.
- Offer/final artifact eksikse approval proposal açık kalır; stage ilerlemez.
- Sekizinci ardışık hata lane'i quarantine eder. Resume yalnız insan incelemesi
  ve audit ile yapılır.

### P7 — Mezuniyet ve sınırlı otomasyon

- Aynı adapter için en az üç ayrı manual real submission, durable success proof
  ve doğru hedef bağlarıyla tamamlanır.
- Üç başarı aynı öğrenciye tekrarlı denemeler veya yalnız URL'deki herhangi bir
  kod olamaz; evidence paketinde application/student/program hedefleri ayrı
  gösterilir.
- Mezuniyet sonrası ilk otomasyon ayarı:
  - global concurrency `1`;
  - pilot lane concurrency `1`;
  - scope yalnız pilot kurum;
  - tek non-terminal trigger stage;
  - fan-out `off`;
  - fallback `off`;
  - bounded scheduler cadence;
  - email/WhatsApp/payment/public notification kill-switch'leri açık.
- En az 24 saat hatasız soak ve queue/observation reconciliation görülmeden
  concurrency artırılmaz.

### P8 — Konfigürasyon değişikliği sonrası yeniden doğrulama

- Credential ekleme, değiştirme veya silme; adapter versiyonu
  enable/disable/rollback; privileged approval geri alma; portal anahtarı,
  adapter, CRM katalog bağı veya multi-portal routing değişikliği partneri
  otomatik olarak inactive duruma getirir, auto-process ve fan-out'u kapatır.
- Değişen adapter/credential için bekleyen submission'lar sabit bir
  review-required hata koduyla iptal edilir. Çalışmakta olan submission varsa
  değişiklik `409` ile fail-closed reddedilir ve transaction bütünüyle geri
  alınır; yarım credential/spec değişikliği oluşmaz.
- Aynı kural university key/ad/name, adapter key, CRM catalog bağı, defaults ve
  multi-portal routing değişiklikleri için de uygulanır; queue eski routing ile
  çalışmaya devam edemez.
- Yüklenen/unknown adapterın üç başarılı kanıt sayacı, o anda etkin olan spec
  versiyonunun activation epoch'undan itibaren hesaplanır. Eski versiyonun
  başarıları yeni versiyonu otomatik moda mezun edemez.
- Değişiklik sonrası P3 test-login, P4 strict dry-run ve gerekli manual canary
  kanıtları yeniden tamamlanmadan otomasyon tekrar açılmaz.

## 4. Zorunlu stop koşulları

Aşağıdakilerden biri oluşursa lane hemen durur ve insan exception queue'suna
alınır:

- login origin veya portal state beklenenden farklı;
- CAPTCHA/MFA/terms ekranı değişmiş;
- birden fazla öğrenci/application/program eşleşmesi;
- application number yalnız URL, link index'i veya unlabeled koddan geliyor;
- portal success ve CRM evidence çelişiyor;
- required upload için portal/server proof yok;
- aynı idempotency anahtarında farklı içerik;
- redirect allowlist dışına çıkıyor;
- timeout, sekiz ardışık hata veya quarantine;
- external-write denominator'ında beklenmeyen artış;
- başka portal lane'inde backlog veya latency etkisi.

## 5. Pilot kabul kanıtı

Her canary için PII/secret içermeyen paket aşağıdakileri içerir:

- partner adı, adapter key, immutable version ve full SHA-256;
- izinli origin listesi ve credential reference var/yok bilgisi;
- application ID'nin hashlenmiş hedef kimliği;
- preflight sonucu ve mandatory document coverage;
- queue/lane lease, attempt, duration ve final disposition;
- durable submit receipt; official application number için ayrı semantic proof;
- status observation hash ve normalized disposition;
- varsa artifact kind, MIME, byte size ve content SHA-256;
- before/after mesaj, broadcast, portal submission, finance mutation ve Journey
  outbox denominator'ları;
- health, restart, fatal log, queue depth ve disk headroom;
- rollback/disable tatbikatı sonucu.

## 6. Production geçiş kapısı

Staging pilotinin başarılı olması production yetkisi vermez. Production için
ayrı olarak exact reviewed release, current production ledger/prefix, row ve
lock impact, credential owner, network/origin policy, backup+restore kanıtı,
worker resource budget, canary rollback ve proje sahibinin açık production
onayı gerekir. `Find-And-Study-OS-Next`, PR merge ve production bu runbook'un
dışındadır.

## 7. Şu anki blokaj

Teknik altyapı ve no-outbound test zemini hazırdır. Gerçek pilotu başlatmak için
eksik olan dış girdiler: **ilk partnerin adı, exact login URL'si, hesap türü ve
credential'ın şifreli UI'dan girilmesi**. Bunlar gelene kadar worker, scheduler,
real submit, fan-out ve fallback kapalı kalır.
