# Find And Study OS — Production Safety Instructions

These instructions apply to every task performed in this repository.

## Primary safety objective

Production remains active while development continues. Students, applications,
documents, messages, payments, notifications, and uploaded files may be created
or changed at any time. Preserve all production data added after the local
snapshot was taken.

The local database and local storage are disposable development copies. They
must never be treated as the current source of truth for production data.

## Hard rules

- Never restore the local database or a local dump into production.
- Never synchronize local database rows back to production.
- Never replace production storage with the local storage directory.
- Never copy a local `.env` file to production.
- Never commit or push dumps, `.env` files, credentials, tokens, logs containing
  secrets, or copied production storage.
- Never run a production migration, destructive SQL statement, deployment,
  service restart, container restart, or worker restart without explicit user
  approval for that specific production action.
- Never assume GitHub matches the code currently running on the VPS. Verify the
  production commit and production worktree before planning a deployment.
- Treat all production access as read-only unless the user has explicitly
  approved a defined deployment step.

## Allowed data direction

Production data may be copied to an isolated local environment for development:

```text
Production database/storage -> Local development copy
```

Do not reverse that direction. Production receives application code and vetted
schema migrations, not local database contents or local storage snapshots.

## Database migration requirements

Before proposing a production migration:

1. Inspect the current production schema read-only.
2. Test the migration against a recent production-derived local copy.
3. Estimate locks, runtime, disk growth, and impact on active requests/workers.
4. Prefer additive and backward-compatible changes:
   - add tables;
   - add nullable columns;
   - add indexes using a production-safe method;
   - deploy code that tolerates both old and new schema states;
   - backfill separately in bounded batches when required.
5. Do not drop, truncate, rename, rewrite, or change the type of populated
   production columns without a dedicated plan and explicit approval.
6. Do not use ORM schema push/sync commands against production.
7. Review the generated SQL rather than trusting migration generation alone.

Destructive or irreversible SQL requires a fresh backup, a rollback/data
recovery plan, and explicit user confirmation immediately before execution.

## Required production deployment gate

Do not deploy until all of the following have been reported to the user:

- exact source commit and files included in the release;
- production commit and dirty-worktree status;
- migration SQL and whether it changes or locks existing data;
- current database and storage backup plan;
- expected downtime or confirmation of a backward-compatible rollout;
- worker, queue, cron, email, messaging, and portal-automation impact;
- health checks and smoke tests to run after deployment;
- code rollback plan and database recovery limitations.

Wait for explicit approval after presenting this preflight report.

## Backup policy

Immediately before an approved production release that can affect data:

- create a fresh PostgreSQL custom-format dump with `--no-owner --no-acl`;
- verify the dump exit code, SHA-256 checksum, and `pg_restore --list` output;
- capture or verify a recoverable production storage backup/snapshot;
- record the production Git commit and deployment timestamp;
- keep backups outside Git and do not expose credentials in output.

A database restore is a last resort because restoring an older snapshot can
delete valid activity that occurred after the snapshot. Prefer rolling back code
while keeping a backward-compatible database schema whenever possible.

## Workers and external integrations

Production background jobs can change data or contact real users. Deployment
planning must explicitly cover email queues, notifications, messaging,
WhatsApp/Meta integrations, portal automation, scheduled jobs, and cron tasks.

- Avoid running two incompatible worker versions concurrently.
- Require idempotency or a single-consumer transition plan.
- Do not test live integrations using production recipients.
- Keep live integrations disabled in local development.

## Local development safeguards

- Use only the local PostgreSQL endpoint on `127.0.0.1:5433` and database
  `fasos_apply_local` unless the user explicitly changes the local setup.
- Keep `ALLOW_LIVE_INTEGRATIONS=false` locally.
- Treat local startup migrations, seeders, and background workers as capable of
  modifying the local copy.
- Confirm the resolved database host before running scripts that mutate data.
- Do not use the quarantined `fasos_apply-production.unverified.dump`.

## Stop conditions

Stop and ask the user before proceeding when:

- the target database or server cannot be proven to be local;
- a command could overwrite or delete production data or storage;
- a migration is not backward compatible;
- the production worktree contains unexplained changes;
- the backup cannot be verified;
- rollback would require restoring an old database snapshot;
- a deploy could cause external messages, payments, or portal submissions;
- required secrets, ownership, target paths, or release scope are ambiguous.

When uncertain, preserve production state and present the uncertainty rather
than making an assumption.

## 2 Eylül 2026 — Institution Admissions v1 yerel eki

`codex/institution-admissions-v1-20260902` branch'inde ayrı `/institution`
portal shell'i, altı kurum rol paketi, review/evidence/information-request,
versioned decision + maker-checker, offer/enrolment, requirements, SLA,
PII-minimized analytics, team ve secret-reference-only integrations yüzeyi
uygulandı. Additive `0083_institution_admissions_foundation.sql` ile 13
tenant/relationship-owned ve FORCE-RLS tablo eklendi; kanonik ledger `84/84`.
Program/intake değişikliği legacy kataloğa doğrudan yazılmaz; internal ChangeSet
bekleyen append-only talep üretir.

Feature default-off'tur. Production'da ayrı non-super/non-BYPASSRLS
`fas_institution_executor` bağlantısı zorunludur. Yüksek etkili komutların local
assurance bayrağı production'da etkisizdir. Production, staging, `Next`, dış
iletişim ve portal automation wiring'i bu çalışma sırasında değiştirilmedi.
Fresh PostgreSQL migration, pure contract `7/7`, PostgreSQL security `6/6`, DB/
API/Edcons typecheck ve iki production build PASS'tir. Canlı adoption,
Control Plane provisioning, active-context/step-up, Privacy/Legal, consentli
cohort ve bağımsız review ayrı NO-GO kapılarıdır. Ayrıntı:
`INSTITUTION_ADMISSIONS_V1_IMPLEMENTATION_2026-09-02.md`.

### 2 Eylül 2026 — Institution authority hardening eki

Yukarıdaki `84/84`, `7/7` ve `6/6` yerel kanıtını supersede eder. Additive
`0084_institution_admissions_authority_hardening.sql` ile kanonik ledger
`85/85` oldu. Relationship purpose/data-scope, program/intake/assigned-reviewer
kapsamı, current membership actor bağı, kurum rol ayrımı, evidence lineage ve
decision/offer/enrolment receipt-evidence corridor'u PostgreSQL RLS/trigger
sınırında fail-closed hale getirildi. Institution Admin application reviewer
değildir; Auditor masked/read-only kalır; decision maker ile checker aynı olamaz.
Bilgi isteği update corridor'u bu dilimde DB seviyesinde kapalıdır.

Yeni ayrı `/institution/audit` yüzeyi PII-free masked append-only projection'dır.
Dedicated Institution CI workflow'u Linux/Windows/PostgreSQL 16 kapılarını,
genel convergence workflow'u da pure ve PostgreSQL institution regresyonlarını
çalıştırır. Fresh `85/85`, clean replay, pure `9/9`, exact least-privilege
executor PostgreSQL `10/10`, migration authority `29 PASS + 1` Bash-unavailable
SKIP, tenant-writer ve legacy-route inventory, full workspace typecheck, 10 dil
i18n, API/Edcons production build, data-boundary `4/4`, integration DB safety
`11/11` ve live security regression `31/31` PASS'tir. Production, staging,
`Next`, gerçek PII, external send/portal automation, merge ve deploy
değiştirilmemiştir; bunlar ayrı onay ve NO-GO kapılarında kalır.

Institution v1 code-bearing head'i
`0461c88f9d7fdf02ace2063b1b3d6c1fa0a68c30`, tree'si
`f26b88e59715d6f70bb5101fd120d0c28ea55166` ve base
`822112fb471ad53365034b9b928b5510b4c06d81` → code binary-patch SHA-256 değeri
`f5ac4f4b85fbdad148b5f813081b2259734ebbc6339e206ec0aada510e97f182` olarak
`INSTITUTION_ADMISSIONS_V1_REVIEW_PACKET_2026-09-02.md` içinde donduruldu.
Review packet commit'i code-bearing değildir; bağımsız reviewer exact final
branch HEAD'ini ayrıca kabul etmelidir.

### 2 Eylül 2026 — Institution active-context/step-up eki

Yukarıdaki Institution code/review kimliği ve `85/85`, PostgreSQL `10/10`
kanıtını supersede eder. Local-assurance escape hatch'i kaldırıldı. Karar
approve/return/reject, offer issue, enrolment transition ve requirement publish
komutları artık yalnız Ed25519 v2 signed active-context, exact current
selection/session generation, server-derived session fingerprint, HUMAN
principal, external `admissions.review` relationship, current policy/data-scope,
tek kullanımlık exact step-up ve mevcut domain maker-checker/evidence sınırları
birlikte geçerse çalışır; API token ve impersonation daima reddedilir.

Additive `0085_institution_active_context_step_up.sql` ile dört tablo eklenmiş,
Institution FORCE-RLS toplamı `17`, kanonik ledger `86/86` olmuştur. PII-free
authorization receipt insert'i current selection, relationship, membership,
tenant, principal, role package, capability ve policy satırlarını transaction
sonuna kadar `FOR SHARE` ile kilitler. Lock-only FORCE-RLS policy'leri
`WITH CHECK(false)` kullanır; exact `fas_institution_executor` selection,
relationship veya membership UPDATE privilege'ına sahip değildir. Direct team
grant kapatılmış, yalnız `PENDING_CONTROL_PLANE` membership request; direct SLA
activation/retire kapatılmış, yalnız authorization-bound `DRAFT` üretilmiştir.

Institution code-bearing head `b117e71a013e57efe5e9ce67f777c6b2fe39472f`,
tree `782daa3c4166e7db074bbb2f983562863e2edd8f`, base
`822112fb471ad53365034b9b928b5510b4c06d81` → code binary-patch SHA-256
`4400a1164d4647f9b244ab3ae9cb15145697c9c3ffce2abf3d396b432dbfe329`
ve byte uzunluğu `438510` olarak review packet'te dondurulmuştur. Base→code
farkı `4 commit / 46 dosya / 7.507 ekleme / 31 silme`dir. Fresh PostgreSQL
16.15 `86/86` + clean replay, pure contract `9/9`, pure authorization `9/9`,
exact least-privilege PostgreSQL `12/12`, migration authority `29 PASS + 1`
Bash-unavailable SKIP, tenant writer `166/166` ve `2.222` surface, legacy route
`72/794`, full workspace typecheck, 10 dil i18n, API/Edcons builds,
data-boundary `4/4`, integration DB safety `11/11` ve security regression
`31/31` PASS'tir.

Active-context selection issuer, MFA step-up issuer, Ed25519 key-ring, Control
Plane request apply, staging migration/UAT ve bağımsız review henüz yapılmadı.
Production, staging, `Next`, gerçek PII, dış mesaj/SIS/portal execution,
push/merge/deploy değiştirilmemiştir ve ayrı açık onay gerektirir.

### 2 Eylül 2026 — Institution case-intake eki

Yukarıdaki `86/86` kanıtını supersede eder. Additive
`0086_institution_case_intake_receipts.sql` ile kanonik ledger `87/87`,
Institution FORCE-RLS toplamı `18` olmuştur. Varsayılan kapalı intake adapter'ı
yalnız başarılı gerçek portal submission'ı; current tenant→legacy branch,
application/student, external `admissions.review` relationship/institution,
program ve portal-university mapping bağları aynı transaction'da geçerse kurum
review queue'sunda case'e dönüştürür. Case `shared_profile={}` ve deterministik
maskeli öğrenci referansı taşır; ham external reference, result JSON,
screenshot, iletişim/kimlik veya belge içeriği projection'a girmez.

Source snapshot, external reference, command ve receipt SHA-256 ile dondurulur;
`institution_case_intake_receipts` append-only, case source bağı immutable ve
aynı submission idempotent/concurrency-safe'tir. Exact
`fas_institution_intake_executor` hiçbir Institution tablosunda SELECT/INSERT
yetkisine sahip değildir; yalnız ayrı NOLOGIN/non-super/non-BYPASSRLS owner'lı,
`row_security=on` SECURITY DEFINER fonksiyonunu çalıştırır. Feature modu
`off|allowlist|all` olup varsayılan `off`tur; route/worker wiring, backfill,
staging/production activation, dış portal çağrısı ve gerçek PII yoktur.

Fresh PostgreSQL 16.15 `87/87` + clean replay, pure Institution contract
`10/10`, authorization `9/9`, intake `4/4`, Institution PostgreSQL `12/12`,
intake PostgreSQL `5/5`, migration authority `30 PASS + 1` Bash-unavailable
SKIP, tenant writer `167/167` ve `2.226` surface, legacy route `72/794`, full
workspace typecheck, 10 dil i18n, API/Edcons production builds, data-boundary
`4/4`, integration DB safety `11/11` ve security regression `31/31` PASS'tir.
Production-prefix `66→87` harness'i CI'da bağlanmıştır; bu dilimde mevcut yerel
`fasos_apply_local` DB'si korunmuş ve yeniden oluşturulmamıştır. Bağımsız review,
staging adoption/rollback, dedicated owner/executor provisioning, consentli
allowlist job wiring ve Privacy/Legal hâlâ NO-GO kapılarıdır.

Institution case-intake dahil güncel code-bearing head
`6cb9dd3e2d7f33644c4b98d948d6a91fc02791e4`, tree
`82e52312f660c56fc5ad11871e0e4086388b4bc4`, base
`822112fb471ad53365034b9b928b5510b4c06d81` → code farkı
`6 commit / 51 dosya / 8.922 ekleme / 31 silme`, binary-patch SHA-256
`7812ea20a9c670ac6b3b0c86c19061c8710c04f5c7a9d1020d7cac8e1d1fe2f3`
ve byte uzunluğu `512541` olarak review packet'te dondurulmuştur. Review packet
commit'i code-bearing değildir; bağımsız reviewer exact final branch HEAD'ini
ayrıca kabul etmelidir.

### 2 Eylül 2026 — Institution consent-bound evidence eki

Yukarıdaki Institution case-intake code/review kimliği ve `87/87` kanıtını
supersede eder. Additive `0087_institution_evidence_share_receipts.sql` ile
kanonik ledger `88/88`, Institution FORCE-RLS toplamı `19` olmuştur. Kurum
reviewer'ı artık serbest evidence hash giremez; yalnız exact institution case'e,
Journey verified evidence/requirement sonucuna ve en son aktif
`institution.admissions.evidence_share` in-app consent receipt'ine bağlı,
PII-minimized manifesti seçebilir. Ham document byte veya private object ref
kurum projection'ına girmez.

Share receipt append-only'dir. Idempotent replay current relationship,
verified-evidence ve consent durumunu yeniden doğrular; consent withdrawal eski
receipt replay'ini ve yeni assessment'i reddeder. Assessment DB timestamp'i,
current reviewer membership'i ve program/intake/case scope'u PostgreSQL
trigger/RLS sınırında tekrar doğrulanır. Exact
`fas_institution_evidence_share_executor` tablo yetkisiz/EXECUTE-only; fonksiyon
owner'ı NOLOGIN/non-super/non-BYPASSRLS'tir. Feature `off|allowlist|all`,
varsayılan `off`; adapter default-unwired'dır ve consent, dış gönderim veya
belge aktarımı üretmez.

Güncel code-bearing head `efb8d10e948db878857421be3b9f1b45a77bc8f8`,
tree `e2d0af4a2ee65167937b1e5146311151272c50e0`, base
`822112fb471ad53365034b9b928b5510b4c06d81` → code farkı
`8 commit / 56 dosya / 10.595 ekleme / 31 silme`, binary-patch SHA-256
`a8a2b16a923247bffb0b250287fb3ccc4f904202d4086f163bd4645921be2d5e`
ve byte uzunluğu `589418` olarak review packet'te dondurulmuştur.

Fresh PostgreSQL 16.15 `88/88` + clean replay, pure Institution contract
`11/11`, authorization `9/9`, intake `4/4`, evidence-share `4/4`, Institution
PostgreSQL `12/12`, intake PostgreSQL `5/5`, evidence-share PostgreSQL `7/7`,
migration authority `31 PASS + 1` Bash-unavailable SKIP, tenant writer `168/168`
ve `2.231` surface, legacy route `72/794`, full workspace typecheck, 10 dil
i18n, API/Edcons production builds, data-boundary `4/4`, integration DB safety
`11/11` ve security regression `31/31` PASS'tir.

Production, staging, `Next`, GitHub remote, gerçek PII, consent creation,
worker/route wiring, dış mesaj/SIS/portal execution, merge ve deploy
değiştirilmemiştir. Bağımsız review, staging `0083–0087` adoption/rollback,
dedicated owner/executor provisioning, active-context/MFA issuer'ları,
Privacy/Legal ve consentli staging allowlist UAT ayrı NO-GO kapılarıdır.

### 2 Eylül 2026 — Institution reviewed-evidence enrolment eki

Yukarıdaki Institution consent-bound evidence code/review kimliği ve `88/88`
kanıtını supersede eder. Additive
`0088_institution_enrolment_evidence_binding.sql` ile kanonik ledger `89/89`
olmuştur. Yeni bir enrolment confirmation artık istemcinin verdiği SHA-256 ile
ilerleyemez; exact evidence-share receipt, ona bağlı en son `VERIFIED`
assessment, application program/intake'ine ait güncel `PUBLISHED` requirement
set içindeki `ENROLMENT_CONFIRMATION` evidence type ve hâlâ aktif en son consent
aynı transaction'da yeniden doğrulanır. Tarihsel confirmed satırlar migration
sırasında korunur; migration sonrasındaki her yeni confirmation source türünden
bağımsız receipt-bound'dır.

`institution_enrolments` share-receipt ve assessment kimliklerini composite FK
ile taşır. SECURITY DEFINER resolver current `DECISION_APPROVER` principal,
membership, `admissions.review` relationship, `application.enrolment` data
scope, case state, RLS ve DB saatini fail-closed doğrular. Portal eski hash
prompt'unu kaldırır; reviewer değerlendirmesi exact güncel yayımlanmış kurum
requirement kimliğine bağlanmadan confirmation düğmesi açılmaz. Consent
withdrawal hem resolver'ı hem receipt replay'ini reddeder.

Güncel code-bearing head `7df0c426eb259193191f916324550da3e8edbf05`,
tree `31cef9d0bb5cda77e88cfdf1e557cbc28a6691be`, güncel staging target-base
`453d47cbe1b97c0d09b022181de658f6efd0326d` → code farkı
`17 commit / 57 dosya / 11.333 ekleme / 31 silme`, binary-patch SHA-256
`3fd11784255bb99cff744bd5686b4eefbed5177fdcf65186c5b8fac116e9f779`
ve byte uzunluğu `630792` olarak review packet'te dondurulmuştur.

Fresh PostgreSQL 16.15 `89/89` + clean replay ve production-prefix `66→89`
replay PASS; pure Institution contract `12/12`, authorization `9/9`, intake
`4/4`, evidence-share `4/4`, Institution PostgreSQL `12/12`, intake PostgreSQL
`5/5`, evidence/enrolment PostgreSQL `8/8`, migration authority `31 PASS + 1`
Bash-unavailable SKIP, tenant writer `168/168` ve `2.231` surface, legacy route
`72/794`, full workspace typecheck, 10 dil i18n, API/Edcons production builds,
data-boundary `4/4`, integration DB safety `11/11` ve security regression
`31/31` PASS'tir. Control Plane foundation, Student Journey G45, ChangeSet
adapter, durable audit/reconciliation ve active-context session/lifecycle/repair
PostgreSQL kapıları da `89/89` üzerinde PASS'tir.

Taslak PR #31'in ilk Institution ve convergence workflow run'ları
`33721164042`/`33721163999`, same-source intake yarışında advisory lock bekleyen
ikinci `SERIALIZABLE` transaction'ın stale snapshot ile legacy unique
constraint'e düştüğünü yakaladı. `0fcb46fb`, transaction advisory lock'u
koruyarak caller isolation'ı `READ COMMITTED` yaptı; local disposable PostgreSQL
intake paketi yeniden `5/5` PASS'tir.

Bu ilk düzeltmeden sonraki exact-head run'lar `33722590201`/`33722590203`, aynı
stale-snapshot yarışını evidence-share caller'ında yakaladı. `05c93cbc`, advisory
lock'u koruyup evidence-share transaction'ını `READ COMMITTED` yaptı; pure suite
`4/4`, PostgreSQL suite concurrency vakasıyla art arda beş kez `8/8` PASS'tir.
Code/review head `9d2cf546bbdd8a53a69474cc9fe7a1abc99b2d81` için Institution
Admissions Gate run `33723307855` ve Live-first Convergence Gate run
`33723307835` SUCCESS'tir.

Final docs-only head `1f9101d06cbed197685057d53cc4224b54792464` için Institution
Admissions Gate `33723726118` ve convergence gate `33723726120` SUCCESS'tir.
Bu kanıttan sonra staging target branch'ine çıkan catalog bulk-import hardening
commit'i `453d47cb`, Institution branch'ine çatışmasız merge edilmiştir. Local
catalog `5/5`, Institution pure `12+9+4+4`, intake PostgreSQL `5/5` ve
evidence/enrolment PostgreSQL suite'i art arda üç kez `8/8` PASS'tir; merge
sonrası exact-head remote CI henüz beklenmektedir.

Production, staging, `Next`, gerçek PII, live feature state,
dış mesaj/SIS/portal execution, merge ve deploy değiştirilmemiştir. Bağımsız
review, staging `0083–0088` adoption/rollback, dedicated role provisioning,
active-context/MFA issuer'ları, Privacy/Legal ve consentli staging UAT ayrı
NO-GO kapılarıdır.

## 4 Eylül 2026 — Portal Automation kapalı-döngü v1 yerel eki

`codex/reporting-intelligence-center-20260903` branch'inde Portal Automation
üretim dilimi üç yerel commit halinde ilerlemiştir. Application trigger seçimi
artık canlı pipeline stage kataloğundan gelir; yeni veya drift etmiş stage
otomatik seçilmez ve terminal/won/lost stage dış submit başlatamaz. No-code
adapter JSON yükleme yüzeyi boyut/schema/unknown-property kontrolü, kanonik
SHA-256, immutable version, dry-run/fixture kanıtı ve privileged/jsHook için
ayrı version-bound onaylarla fail-closed çalışır.
Version 2 adapter paketi artık bounded read-only `statusCheck` de tanımlayabilir;
navigate/wait/capture/assert/setVar ve non-mutating HTTP GET dışındaki adımlar
reddedilir. Status, structured missing-document ve official application number
mapping'i uygulama koduna dokunmadan yapılır; identity proof ve official number
yalnız yakalanan application identity istenen external reference ile exact
eşleşirse üretilir. Status kontrolü privileged version approval kapsamındadır.

Additive `0090_portal_lifecycle_observations.sql` ve
`0091_portal_application_artifact_intake.sql` ile kanonik ledger `92/92`
olmuştur. Portal status gözlemleri submission+application composite FK,
redaction, bounded missing-document list, semantic identity proof ve hash ile
append-only/deduplicated tutulur. University application number yalnız exact
labeled/structured/matched-row kanıtı varsa Application tabına yazılır; mevcut
farklı değer overwrite edilmez, approval queue'ya conflict düşer. Offer,
payment, final acceptance ve student card stage değişiklikleri exact artifact
olmadan önerilemez; hiçbir lifecycle proposal portal mutation, dış mesaj,
ödeme veya otomatik CRM stage değişikliği yetkisi taşımaz.

No-code v2 status mapping offer/deposit/acceptance/final/student-card artifact
kontrolünü de tanımlayabilir. Artifact ikinci fazda, yalnız ilgili status bunu
gerektirip application'da dosya yoksa indirilir. Exact allowlisted origin,
redirect-deny + final-origin recheck, zorunlu content-length, hard `15 MiB`,
MIME allowlist ve PDF/JPEG/PNG magic-byte eşliği fail-closed'dur.
Application-scoped content-addressed object key retry'da aynı dosyayı kullanır;
DB kaydı observation+submission+application composite FK ve içerik hashiyle
idempotent bağlıdır. İnsan kullanıcı taklit edilmez, kaynak `portal_automation`
olarak görünür ve stage-document delete API'si bu kanıtı silmez. Dosya mevcut
Application belge alanında Portal Automation badge'iyle görünür.

Status sync PostgreSQL `SKIP LOCKED` row lease ve adapter+university advisory
lane lease kullanır. Böylece aynı portal hesabında tek browser session, farklı
kurumlarda paralellik vardır. Her lane ayrı login/session/timeout sınırındadır;
başarı cadence'i disposition'a göre deterministik jitter ile `2–24 saat`, hata
retry'si bounded exponential jitter, sekizinci hatada quarantine'dır. Raw
browser/provider error veya application number API/log/operasyon ekranına
çıkmaz. Admin Operations sekmesi yalnız aggregate lane sağlıkları, redacted
observation metadata, pending review ve audited quarantine resume gösterir.
Offer/final acceptance monitoring'i sonlandırmaz; yalnız enrolment, reject,
full quota, duplicate/already-registered ve withdrawal terminaldir.

Dedicated `Portal Automation Gate` Linux, Windows ve PostgreSQL 16 kapılarını
tanımlar. Yerel kanıt: fresh `92/92` + clean replay, portal pure `26/26`, dynamic
stage `4/4`, PostgreSQL observation/lane/Guardian/operations/artifact `7/7`, migration
authority `31 PASS + 1` Bash-unavailable SKIP, package manager `6/6`, workspace
ve hedef API/worker typecheck, 10 dil i18n, API ve Edcons production build PASS.
Exact code-bearing head `4f4ce4df3e01b0e71e84a64c02424847a1e6056f`
remote'a push edilmiştir; Institution Admissions `33882911515`, Portal
Automation `33882911634` ve Live-first Convergence `33882911333` Actions
run'larının üçü de SUCCESS'tir.

Proje sahibinin staging deploy onayıyla aynı exact head yalnız
`staging.findandstudy.com` ortamına alınmıştır. Checksum'lı pre-adoption backup
`staging-backup-20260904T140614Z-852b03b671e1` izole PostgreSQL 16.15 restore
tatbikatında ledger `90`, 13 sentetik user, sıfır application ve sıfır portal
submission üretmiştir; disposable container kaldırılmıştır. En az yetkili
migration runner staging ledger'ını `90/90 → 92/92` taşımıştır. Release
`staging-20260904T143054Z-4f4ce4df3e01`, runtime image SHA-256 kimliği
`7c4de1e8c79c16ab94423529e2a9f939d3882a573fcbeb5a14469dd479db601d`dır.
Yalnız staging app konteyneri recreate edilmiş; UID/GID `10042`, read-only
rootfs, cap-drop ALL, no-new-privileges, healthy, restart `0`, public health
HTTP `200` + `dbConnected=true`, altı ek örnek exact release PASS'tir. Final
disk `%80`, `21.072.498.688` byte boştur; prune yoktur.

Authenticated salt-okunur UAT Rules, Operations, Adapter Management,
Submission Board ve Audit Log sekmelerini doğrulamıştır. Trigger stage'ler
Application Pipeline'dan dinamik gelir ve terminal Enrolled/Rejected seçimleri
disabled'dır. `ALLOW_LIVE_INTEGRATIONS=false`, email disabled, background jobs
disabled, AI external reply kill-switch active ve portal worker sayısı `0`
kalmıştır; dış portal çağrısı, submit, poll, adapter upload veya ayar mutasyonu
yapılmamıştır. Production, `Next`, PR merge, gerçek credential/PII ve canlı dış
etki değiştirilmemiştir. Ayrıntı:
`PORTAL_AUTOMATION_CLOSED_LOOP_V1_IMPLEMENTATION_2026-09-04.md`.

Aynı gün staging adoption sonrası no-outbound sentetik adapter kapısı da
tamamlanmıştır. Exact deployed build image read-only rootfs ve `--network none`
ile v2 adapter production slice'ı `26/26` geçmiştir. Ayrı tmpfs PostgreSQL
16.15 konteyneri `--network none`, loopback `5433` ve exact `0→92` migration
ile çalışmış; adapter admin/version, observation, distributed lane lease, fair
claim, quarantine, Guardian idempotency, operations authorization ve artifact
testleri `8/8` PASS olmuştur. Test DB sonunda `92/92` ve user/application/
submission/observation/spec `0/0/0/0/0` olarak reconcile edilmiş, disposable
container kaldırılmıştır. İlk `5432` denemesi hard target pin tarafından
fail-closed reddedilmiş ve artık bırakmadan temizlenmiştir.

Canlı staging'de yalnız aggregate read yapılmıştır: active credential `0`,
portal university `0`, adapter spec `0`, lane `0`; messages, broadcasts,
portal submissions, finance mutation requests ve Journey outbox
denominator'ları `0/0/0/0/0` kalmıştır. UI Test Mode'da, automation/fallback/
fan-out/scheduler kapalı, Operations sayaçları sıfırdır. Health exact release,
ledger `92/92`, restart `0`, fatal log `0` ve leftover UAT container `0`
PASS'tir. Gerçek credential/university/adapter olmadığından portal worker
açılmamıştır. İlk gerçek partner; exact origin, encrypted credential reference,
immutable adapter version, dry-run ve ayrı activation approval ile tek staging
pilot olarak onboard edilmeden live worker veya outbound portal trafiği NO-GO'dur.

Aynı gün custom adapter graduation sınırı fail-closed sertleştirilmiştir.
Bilinmeyen veya admin panelden yüklenen her adapter artık deneysel/manual-only
başlar; üç ayrı durable başarı kanıtı olmadan auto-process açılamaz. API her
portal-university satırında server-authoritative `experimental`,
`staticExperimental`, `successCount`, `graduationThreshold` ve `graduated`
durumunu döner; UI registry dışı anahtarı da muhafazakâr biçimde kilitler. Kod
commit'leri `86c15011`, `2b0dbb86`, exact route-inventory head'i `575763b1`dir.
Bu head için Portal Automation `33888388971`, Convergence `33888388995` ve
Institution `33888389135` Actions run'ları SUCCESS'tir. Network-none adapter
slice `535/535`, registry `15/15`, disposable PostgreSQL graduation `9/9` ve
Portal Management projection `9/9` PASS'tir; API/Edcons direct typecheck PASS,
disposable konteyner kalmamıştır.

Pre-deploy checksum backup
`staging-backup-20260904T151905Z-4f4ce4df3e01` (`4.684.775` byte, SHA-256
`abc53f4b6c0ce35cd2fa43f04f63bb93de4c22114433685c48056ee69272ae8e`)
network-none PostgreSQL 16.15 restore drill'inde ledger `92`, 13 sentetik user,
sıfır application/submission üretmiştir. Exact staging release
`staging-20260904T152458Z-575763b13e6a`, runtime image
`sha256:ed82bb6320f0bfec30e0794f0249128a65a376885b90ece7655f0a9dc3e140fa`
olarak sağlıklıdır; restart `0`, UID/GID `10042`, read-only rootfs, cap-drop ALL
ve no-new-privileges korunur. Altı public health örneği exact release + HTTP
`200` + `dbConnected=true` geçmiştir. Ledger ve aggregate sayaç dizisi
`92|0|0|0|0|0|0|0|0|0|0|0`, worker `0`, dört kill-switch exact ve fatal log
`0`dır. Salt-okunur UI regresyonu kurallar/operasyon/adapter/üniversite
sekmelerini geçmiştir; dış eylem yoktur. İlk pilotin kanonik runbook'u
`PORTAL_AUTOMATION_FIRST_PARTNER_PILOT_RUNBOOK_2026-09-04.md`dir. Partner adı,
exact login origin, hesap/otomasyon izni ve encrypted UI credential girişi
gelmeden worker, real submit, status sweep, fallback veya fan-out NO-GO'dur;
credential chat'e yazılmaz. Production, `Next` ve merge değişmemiştir.

## 5 Eylül 2026 — Portal partner execution verification yerel eki

`codex/reporting-intelligence-center-20260903` çalışma ağacında, commit/push
yapılmadan Portal Automation onboarding ve execution kapıları sertleştirildi.
Additive `0092_portal_partner_verification_receipts.sql` ve fallback soft-delete
benzersizliğini düzelten `0093_portal_program_fallback_active_uniqueness.sql`
ile kanonik yerel ledger `94/94` oldu. Test Login ve Strict Dry Run artık partner generation,
adapter key, enabled spec ID/version/SHA-256, encrypted credential row/update
time ve runtime release kimliğine bağlı append-only receipt'tir; geçmiş çalışma
otomatik kanıt sayılmaz. En yeni current-binding sonuç otoritedir, başarısız
tekrar eski PASS'i iptal eder ve aynı idempotency key farklı evidence ile
kullanılamaz. Strict Dry Run receipt'i database composite FK ile exact
submission/application çiftine bağlıdır.

Manual/per-application enqueue, automatic trigger, inline drain, dedicated
worker, fallback, program refresh ve status-monitoring yolları execution öncesi
current evidence'i fail-closed yeniden doğrular. Dry run current Test Login +
strict v2 adapter; real submit/fallback/poll ayrıca current Strict Dry Run
ister. Credential, adapter version/approval veya partner routing değişikliği
queued işleri sabit review-required koduyla iptal eder, partneri inactive,
auto-process/fan-out'u off yapar ve generation artırır; running browser işi
varsa mutation `409` ile transaction bütünüyle reddedilir. Submit seçim listesi
yalnız current evidence'i olan aktif DB partnerlerini ve secret-free
`dryRunReady`/`realRunReady` durumunu döndürür. Environment-only credential ve
orphan registry adapter yeni partneri açamaz.

Partner Setup UI server-authoritative configuration → Test Login → activation
for verification → Strict Dry Run → manual pilot → automation → operations
akışını ve doğrudan next-action düğmelerini gösterir. Trigger stage seçimi
Application Pipeline kataloğundan dinamik kalır; yeni/drift etmiş/terminal
stage otomatik seçilemez. Uploaded specs common async runner'da inline ve worker
yollarında çözülür. Legacy dry diagnostic'ler hard dry mode'a alındı;
record-specific `complete-1959` package komutu kaldırıldı.

Temiz disposable PostgreSQL 16 kanıtı: fresh `0→94`, replay `94→94`, production
prefix `66→94→94` ve DB portal suite `91/91` (fallback API `7/7` dahil),
static portal contracts `61/61`, worker
lane/target/queue/writeback `4/4 + 2/2 + 5/5 + 9/9`, fallback runner `31/31`,
package manager `6/6`, migration
authority `31 PASS + 1` Bash-unavailable SKIP, workspace typecheck, 10 dil i18n,
API ve Edcons production build PASS. Soft-delete edilmiş fallback business key
partial unique index ile yeniden kullanılabilir; eşzamanlı aynı-key create
transaction kilidiyle tam bir `201` ve bir kontrollü `409` üretir. Hiçbir partner portalına browser çağrısı
yapılmadı. Staging, production, GitHub, live worker/credential/PII/external
delivery, merge ve `Next` değiştirilmedi. Yeni migration hiçbir historical
receipt üretmediği için adoption sonrasında her partner Test Login + Strict Dry
Run akışından ayrı geçirilmeksizin execution açılamaz.

## 5 Eylül 2026 — Operations & Growth foundation yerel eki

Claude review worktree'inde commit/push/deploy yapılmadan, mevcut
application/task/document/portal/integration omurgasını yeniden yazmayan ilk
operasyon dilimi eklendi. `/admin/operations` ve `/staff/work`; görev,
başvuru, belge, portal observation/proposal ve offer son tarihlerini bounded,
deterministik, read-only bir iş/istisna projeksiyonunda birleştirir. Evidence,
Integration, Offer/Visa/Enrolment ve Communication/Consent aynı workspace'te
mevcut kaynaklara bağlanır; consent/guardian authority veya workflow mutation
üretmez. Non-live integration testleri artık başarı sayılmaz; `simulated` veya
`not_supported` olarak görünür.

Additive `0097_social_operations_foundation.sql` ile sosyal hesap registry,
content brief, append-only maker-checker review, publication intent ve
append-only performance snapshot tabloları eklendi. Beş tablo FORCE RLS ve
tenant+organization scope kullanır. `/admin/social` ile `/api/social/*` yalnız
planlama, hesap referansı, takvim ve içerik onay foundation'ını açar; ham secret
ve external account ref tutulmaz, provider publishing/ad-spend/video üretimi
kapalıdır. Production rollout default-off, exact UUIDv7 scope ve least-privilege
executor kimliği ister. Manager approve edemez; creator kendi brief'ini
onaylayamaz.

Yerel PostgreSQL 16.15 ledger'ı veri reseti olmadan `97→98` taşındı; `5/5`
social tablo FORCE RLS ve 13 policy doğrulandı. Migration catalog `98/98`, pure
social `3/3`, operations queue `4/4`, workspace/API/Edcons typecheck, 10 dil
i18n, OpenAPI codegen ve API/Edcons production build PASS'tir. Local
Control Plane'de tenant/org seed olmadığı için sosyal UI güvenli biçimde
configuration-required gösterir. Staging, production, GitHub, `Next`, external
provider ve gerçek PII değiştirilmemiştir. Kanonik kayıt:
`OPERATIONS_GROWTH_FOUNDATION_IMPLEMENTATION_2026-09-05.md`.
