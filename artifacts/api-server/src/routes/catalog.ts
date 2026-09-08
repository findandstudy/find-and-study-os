import { Router, type IRouter, json } from "express";
import { db, countriesTable, citiesTable, universitiesTable, programsTable, catalogOptionsTable, programDocumentRequirementsTable, degreeDocumentRequirementsTable } from "@workspace/db";
import { eq, ilike, sql, and, or, asc, inArray, notInArray, isNotNull } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { MANAGER_ROLES } from "../lib/roles";
import { invalidateDocCatalog as invalidateDocCatalogCache, loadDocCatalog, loadDocCatalogKeySet } from "../lib/docCatalog";
import { invalidateCurrencyCatalog } from "../lib/currencyCatalog";
import { normalizeDialCode } from "../lib/dialCodes";
import { normalizeProgramImportRows, collectUniversitiesToCreate } from "../lib/programImportHeaders";
import * as XLSX from "xlsx";

// Catalog bulk-import endpoints accept JSON arrays of thousands of rows
// (Excel imports). The global body limit is intentionally small (1mb) for
// DoS hardening, so these specific authenticated routes opt-in to a larger
// limit. They are already gated by requireAuth + MANAGER_ROLES.
const bulkJson = json({ limit: "20mb" });

// PROGRAM_DOC_TYPES'ı kaldırdık (Task #179). Belge sütun anahtarları artık
// admin-managed `catalog_options` (category='documents') tablosundan dinamik
// olarak okunuyor — kataloğa yeni eklenen tipler import'ta otomatik tanınır,
// silinen tipler "Tanımsız belge sütunları" uyarısına düşer. Cache, in-flight
// dedupe ve fallback davranışı `src/lib/docCatalog.ts` içinde.
//
// Bilinen önemli farklar:
//  - sortOrder eskiden hardcoded dizinin index'iydi (deterministik). Artık
//    katalog satırlarının döndüğü sırada index alıyoruz; admin-managed
//    sort_order ile uyumlu olması için içerideki `docCatalog.ts` SQL'i
//    isteğe bağlı olarak ORDER BY eklenebilir. Şu an aynı tipler için
//    sortOrder kararlı (Set/Object.keys ekleme sırasını korur).

function parseDocCellValue(v: any): { value: "mandatory" | "optional" | null; invalid: boolean } {
  if (v === undefined || v === null) return { value: null, invalid: false };
  const s = String(v).trim().toLowerCase();
  if (!s) return { value: null, invalid: false };
  if (s === "mandatory") return { value: "mandatory", invalid: false };
  if (s === "optional") return { value: "optional", invalid: false };
  return { value: null, invalid: true };
}

const router: IRouter = Router();

/* ─── COUNTRIES ─────────────────────────────────────────────── */

router.get("/countries", async (req, res): Promise<void> => {
  const { search, name, code, status, withDialCode, page = "1", limit = "200" } = req.query as Record<string, string>;
  const safeInt = (v: string, fallback: number) => /^\d+$/.test(v) ? parseInt(v, 10) : fallback;
  const pageNum = Math.max(1, safeInt(page, 1));
  const limitNum = Math.min(500, Math.max(1, safeInt(limit, 200)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (search) conditions.push(ilike(countriesTable.name, `%${search}%`));
  if (name) conditions.push(ilike(countriesTable.name, `%${name}%`));
  if (code) conditions.push(ilike(countriesTable.code, `%${code}%`));
  if (status === "active") conditions.push(eq(countriesTable.isActive, true));
  else if (status === "inactive") conditions.push(eq(countriesTable.isActive, false));
  // Phone-code dropdowns request only countries that actually carry a dial code.
  if (withDialCode === "1" || withDialCode === "true") conditions.push(isNotNull(countriesTable.dialCode));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(countriesTable).where(where);
  const data = await db.select().from(countriesTable).where(where)
    .orderBy(countriesTable.name).limit(limitNum).offset(offset);

  res.json({ data, meta: { total: Number(count), page: pageNum, limit: limitNum } });
});

// Public (no-auth) country list for embed/web-to-lead/public-apply phone and
// nationality selectors. Only active countries; supports `search` and the
// `withDialCode` filter. Mounted under /api/public/* so it is CSRF-exempt.
router.get("/public/countries", async (req, res): Promise<void> => {
  const { search, withDialCode } = req.query as Record<string, string>;
  const conditions = [eq(countriesTable.isActive, true)];
  if (search) {
    const term = search.trim();
    // Match by country name (Turkish-aware, case-insensitive ilike) OR by dial
    // code: normalize both the query and the stored code to digits-only so
    // "90"/"+90"/" 90 " all resolve to Turkey, "213" to Algeria, etc. This
    // mirrors the embed widget's client-side name+code search.
    const digits = term.replace(/[^0-9]/g, "");
    const clauses = [ilike(countriesTable.name, `%${term}%`)];
    if (digits) {
      clauses.push(sql`regexp_replace(coalesce(${countriesTable.dialCode}, ''), '[^0-9]', '', 'g') LIKE ${digits + "%"}`);
    }
    conditions.push(or(...clauses)!);
  }
  if (withDialCode === "1" || withDialCode === "true") conditions.push(isNotNull(countriesTable.dialCode));
  const data = await db
    .select({ id: countriesTable.id, name: countriesTable.name, code: countriesTable.code, flagEmoji: countriesTable.flagEmoji, dialCode: countriesTable.dialCode })
    .from(countriesTable)
    .where(and(...conditions))
    .orderBy(countriesTable.name)
    .limit(500);
  res.json({ data });
});

router.post("/countries", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const { name, code, flagEmoji, dialCode, isActive = true } = req.body;
  if (!name || !code) { res.status(400).json({ error: "name and code are required" }); return; }
  try {
    const [country] = await db.insert(countriesTable).values({ name, code: code.toUpperCase(), flagEmoji, dialCode: normalizeDialCode(dialCode), isActive }).returning();
    await logAudit(req.user!.id, "create_country", "country", country.id, { name, code }, req.ip);
    res.status(201).json(country);
  } catch { res.status(409).json({ error: "Country code or name already exists" }); }
});

router.post("/countries/bulk", bulkJson, requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const rows: { name: string; code: string; flagEmoji?: string; dialCode?: string }[] = req.body;
  if (!Array.isArray(rows) || rows.length === 0) { res.status(400).json({ error: "Expected non-empty array" }); return; }
  const values = rows.map(r => ({ name: r.name, code: r.code.toUpperCase(), flagEmoji: r.flagEmoji ?? null, dialCode: normalizeDialCode(r.dialCode), isActive: true }));
  const inserted = await db.insert(countriesTable).values(values).onConflictDoNothing().returning();
  await logAudit(req.user!.id, "bulk_import_countries", "country", undefined, { count: inserted.length }, req.ip);
  res.json({ inserted: inserted.length, skipped: rows.length - inserted.length });
});

router.patch("/countries/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { name, code, flagEmoji, dialCode, isActive } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (code !== undefined) updates.code = code.toUpperCase();
  if (flagEmoji !== undefined) updates.flagEmoji = flagEmoji;
  if (dialCode !== undefined) updates.dialCode = normalizeDialCode(dialCode);
  if (isActive !== undefined) updates.isActive = isActive;
  const [country] = await db.update(countriesTable).set(updates).where(eq(countriesTable.id, id)).returning();
  if (!country) { res.status(404).json({ error: "Not found" }); return; }
  res.json(country);
});

router.delete("/countries/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  await db.delete(countriesTable).where(eq(countriesTable.id, id));
  res.sendStatus(204);
});

/* ─── CITIES ─────────────────────────────────────────────────── */

router.get("/cities", async (req, res): Promise<void> => {
  const { countryId, search, name, status, page = "1", limit = "500" } = req.query as Record<string, string>;
  const safeInt = (v: string, fallback: number) => /^\d+$/.test(v) ? parseInt(v, 10) : fallback;
  const pageNum = Math.max(1, safeInt(page, 1));
  const limitNum = Math.min(1000, Math.max(1, safeInt(limit, 500)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (countryId && /^\d+$/.test(countryId)) conditions.push(eq(citiesTable.countryId, parseInt(countryId, 10)));
  if (search) conditions.push(ilike(citiesTable.name, `%${search}%`));
  if (name) conditions.push(ilike(citiesTable.name, `%${name}%`));
  if (status === "active") conditions.push(eq(citiesTable.isActive, true));
  else if (status === "inactive") conditions.push(eq(citiesTable.isActive, false));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(citiesTable).where(where);
  const data = await db.select().from(citiesTable).where(where)
    .orderBy(citiesTable.name).limit(limitNum).offset(offset);

  res.json({ data, meta: { total: Number(count), page: pageNum, limit: limitNum } });
});

router.post("/cities", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const { name, countryId, isActive = true } = req.body;
  if (!name || !countryId) { res.status(400).json({ error: "name and countryId are required" }); return; }
  const [city] = await db.insert(citiesTable).values({ name, countryId, isActive }).returning();
  await logAudit(req.user!.id, "create_city", "city", city.id, { name, countryId }, req.ip);
  res.status(201).json(city);
});

router.post("/cities/bulk", bulkJson, requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const rows: { name: string; countryId?: number; countryCode?: string }[] = req.body;
  if (!Array.isArray(rows) || rows.length === 0) { res.status(400).json({ error: "Expected non-empty array" }); return; }

  const allCountries = await db.select().from(countriesTable);
  const codeMap = Object.fromEntries(allCountries.map(c => [c.code.toUpperCase(), c.id]));

  const values = rows.map(r => {
    const cid = r.countryId ?? (r.countryCode ? codeMap[r.countryCode.toUpperCase()] : undefined);
    if (!cid) return null;
    return { name: r.name, countryId: cid, isActive: true };
  }).filter(Boolean) as { name: string; countryId: number; isActive: boolean }[];

  if (values.length === 0) { res.status(400).json({ error: "No valid rows (countryId or countryCode required)" }); return; }
  const inserted = await db.insert(citiesTable).values(values).returning();
  await logAudit(req.user!.id, "bulk_import_cities", "city", undefined, { count: inserted.length }, req.ip);
  res.json({ inserted: inserted.length, skipped: rows.length - inserted.length });
});

router.patch("/cities/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { name, countryId, isActive } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (countryId !== undefined) updates.countryId = countryId;
  if (isActive !== undefined) updates.isActive = isActive;
  const [city] = await db.update(citiesTable).set(updates).where(eq(citiesTable.id, id)).returning();
  if (!city) { res.status(404).json({ error: "Not found" }); return; }
  res.json(city);
});

router.delete("/cities/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  await db.delete(citiesTable).where(eq(citiesTable.id, id));
  res.sendStatus(204);
});

/* ─── UNIVERSITIES BULK ──────────────────────────────────────── */

router.post("/universities/bulk", bulkJson, requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const rows: {
    name: string; country: string; city?: string; website?: string;
    description?: string; ranking?: number; logoUrl?: string;
    universityType?: string; taxType?: string; taxPercent?: number;
    qsRanking?: number; timesRanking?: number; shanghaiRanking?: number;
    cwtsLeidenRanking?: number; address?: string; onlinePaymentUrl?: string;
    cricosLink?: string; documentsLink?: string; currentFeeListLink?: string;
    initialDepositOptions?: string; admissionProcess?: string;
    contactPersonName?: string; contactPersonPhone?: string; contactPersonEmail?: string;
    status?: string; isActive?: string | boolean;
  }[] = req.body;
  if (!Array.isArray(rows) || rows.length === 0) { res.status(400).json({ error: "Expected non-empty array" }); return; }

  const values = rows.filter(r => r.name && r.country).map(r => ({
    name: r.name, country: r.country, city: r.city ?? null,
    website: r.website ?? null, description: r.description ?? null,
    ranking: r.ranking ? Number(r.ranking) : null, logoUrl: r.logoUrl ?? null,
    universityType: r.universityType ?? null,
    taxType: r.taxType ?? null,
    taxPercent: r.taxPercent ? Number(r.taxPercent) : null,
    qsRanking: r.qsRanking ? Number(r.qsRanking) : null,
    timesRanking: r.timesRanking ? Number(r.timesRanking) : null,
    shanghaiRanking: r.shanghaiRanking ? Number(r.shanghaiRanking) : null,
    cwtsLeidenRanking: r.cwtsLeidenRanking ? Number(r.cwtsLeidenRanking) : null,
    address: r.address ?? null,
    onlinePaymentUrl: r.onlinePaymentUrl ?? null,
    cricosLink: r.cricosLink ?? null,
    documentsLink: r.documentsLink ?? null,
    currentFeeListLink: r.currentFeeListLink ?? null,
    initialDepositOptions: r.initialDepositOptions ?? null,
    admissionProcess: r.admissionProcess ?? null,
    contactPersonName: r.contactPersonName ?? null,
    contactPersonPhone: r.contactPersonPhone ?? null,
    contactPersonEmail: r.contactPersonEmail ?? null,
    status: r.status ?? "open",
    isActive: r.isActive === false || (typeof r.isActive === "string" && ["no", "false", "0"].includes(r.isActive.toLowerCase().trim())) ? false : true,
  }));

  if (values.length === 0) { res.status(400).json({ error: "No valid rows" }); return; }
  const inserted = await db.insert(universitiesTable).values(values).onConflictDoNothing().returning();
  await logAudit(req.user!.id, "bulk_import_universities", "university", undefined, { count: inserted.length }, req.ip);
  res.json({ inserted: inserted.length, skipped: rows.length - inserted.length });
});

/* ─── PROGRAMS BULK ──────────────────────────────────────────── */

/**
 * Boş "Programs" Excel şablonu — programs/bulk endpoint'inin tanıdığı
 * tüm sabit sütunları + canlı belge kataloğundaki tüm aktif belge
 * anahtarlarını içeren bir XLSX döner. Admin elle sütun adı takip etmek
 * zorunda kalmasın; şablonu indir → doldur → yükle akışı 0 unknown
 * column ile geçsin diye. Task #181 (Task #179'un üstüne).
 *
 * Sütun sırası: önce sabit alanlar (POST /programs/bulk şemasındaki
 * NON_DOC_COLUMNS ile birebir aynı sıra), sonra `loadDocCatalogKeySet()`
 * çıktısı (admin-managed `sort_order` koruyor). Importer aynı kaynaktan
 * okuduğu için round-trip deterministik.
 *
 * Auth: manager+; katalog hassas yapılandırma, dış istemcilere açmıyoruz.
 */
const PROGRAM_TEMPLATE_FIXED_COLUMNS = [
  "universityId", "universityName", "name", "description", "degree", "field", "language",
  "duration", "tuitionFee", "currency", "scholarship", "intakes",
  "requirements", "commissionRate", "applicationFee", "advancedFee",
  "depositFee", "serviceFeeAmount", "discountedFee", "languageFee",
  "feeType", "minGpa", "minLanguageScore", "quota", "isActive",
] as const;

router.get("/programs/import-template", requireAuth, requireRole(...MANAGER_ROLES), async (_req, res): Promise<void> => {
  try {
    const catalog = await loadDocCatalog();
    const docKeys = Object.keys(catalog);
    if (docKeys.length === 0) {
      res.status(503).json({ error: "Belge kataloğu yüklenemedi, lütfen tekrar deneyin." });
      return;
    }

    const headerOrder = [...PROGRAM_TEMPLATE_FIXED_COLUMNS, ...docKeys];
    // json_to_sheet derives headers from the keys of the first object,
    // in insertion order. Build a single blank example row so the XLSX
    // surfaces every column even when no data is provided.
    const blankRow: Record<string, string> = Object.create(null);
    for (const h of headerOrder) blankRow[h] = "";

    const ws = XLSX.utils.json_to_sheet([blankRow], { header: headerOrder as string[] });
    ws["!cols"] = headerOrder.map((h) => ({ wch: Math.min(Math.max(h.length + 2, 14), 40) }));

    const notesRows: Record<string, string>[] = [
      { Column: "universityName", Required: "Yes (or universityId)", Notes: "Exact name as it appears in the Universities tab. Case-insensitive but spelling must match." },
      { Column: "universityId", Required: "Yes (or universityName)", Notes: "Numeric university id (alternative to universityName)." },
      { Column: "name", Required: "Yes", Notes: "Canonical English program name (e.g. Computer Engineering)." },
      { Column: "description", Required: "No", Notes: "Canonical English description. The system automatically queues all 15 translations." },
      { Column: "degree / field / language / duration", Required: "No", Notes: "Free text." },
      { Column: "tuitionFee / scholarship / applicationFee / advancedFee / depositFee / serviceFeeAmount / discountedFee / languageFee", Required: "No", Notes: "Numeric (no currency symbol)." },
      { Column: "currency", Required: "No", Notes: "ISO code: USD, EUR, TRY, GBP. Defaults to USD." },
      { Column: "intakes", Required: "No", Notes: "Comma-separated: 'Fall, Spring, Summer'." },
      { Column: "commissionRate / minGpa / minLanguageScore / quota", Required: "No", Notes: "Numeric." },
      { Column: "feeType", Required: "No", Notes: "Free text: 'per year', 'per semester', 'one-time'." },
      { Column: "isActive", Required: "No", Notes: "Yes / No (defaults to Yes)." },
      { Column: "— Document columns —", Required: "", Notes: `Şablon ${docKeys.length} aktif belge sütunu içerir (admin kataloğundan canlı üretilmiştir).` },
      { Column: "Allowed cell values", Required: "", Notes: "'mandatory' = student MUST upload. 'optional' = shown but not required. (blank) = not requested." },
      { Column: "Removed columns", Required: "", Notes: "Sütunları silerseniz mevcut programlarda DEĞİŞMEZ; sadece dolu hücreler yazılır." },
    ];
    const wsNotes = XLSX.utils.json_to_sheet(notesRows);
    wsNotes["!cols"] = [{ wch: 50 }, { wch: 22 }, { wch: 80 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Programs");
    XLSX.utils.book_append_sheet(wb, wsNotes, "Instructions");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="programs_template_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(buf));
  } catch (err: any) {
    console.error("[programs/import-template] failed:", err?.message || err);
    res.status(500).json({ error: "Failed to build template" });
  }
});

router.post("/programs/bulk", bulkJson, requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  try {
  const rows: ({
    universityId?: number; universityName?: string; name: string; description?: string;
    degree?: string; field?: string; language?: string;
    duration?: string; tuitionFee?: number; currency?: string;
    scholarship?: number; intakes?: string; requirements?: string;
    commissionRate?: number; applicationFee?: number; advancedFee?: number;
    depositFee?: number; serviceFeeAmount?: number; discountedFee?: number;
    languageFee?: number; feeType?: string; minGpa?: number; minLanguageScore?: number;
    quota?: number; isActive?: string | boolean;
  } & Record<string, any>)[] = req.body;
  if (!Array.isArray(rows) || rows.length === 0) { res.status(400).json({ error: "Expected non-empty array" }); return; }

  // Round-trip guarantee: the importer must accept the system's own export
  // headers (`Program`, `University`, `Fee Type`, …). Remap friendly headers
  // to internal keys before any validation.
  const normalizedRows = normalizeProgramImportRows(rows) as typeof rows;

  const allUnis = await db.select({ id: universitiesTable.id, name: universitiesTable.name }).from(universitiesTable);
  const uniNameMap = Object.fromEntries(allUnis.map(u => [u.name.trim().toLowerCase(), u.id]));

  // Auto-create universities that don't exist yet (user-approved decision):
  // collect unresolved names first (dedup case-insensitive + trim, so 50
  // programs of one new university create it ONCE), re-check against the DB
  // map, then insert the truly-new ones and extend the name map.
  const createdUniversities: string[] = [];
  {
    // Only rows that would otherwise be valid program rows (non-empty
    // program name) contribute — a fully-invalid import must not pollute
    // the universities catalog with side-effect inserts.
    const values = collectUniversitiesToCreate(
      normalizedRows as Record<string, unknown>[],
      uniNameMap,
    );
    const UNI_CHUNK = 500;
    for (let off = 0; off < values.length; off += UNI_CHUNK) {
      const inserted = await db.insert(universitiesTable)
        .values(values.slice(off, off + UNI_CHUNK))
        .returning({ id: universitiesTable.id, name: universitiesTable.name });
      for (const u of inserted) {
        uniNameMap[u.name.trim().toLowerCase()] = u.id;
        createdUniversities.push(u.name);
      }
    }
  }

  // Belge sütun anahtarlarını canlı katalogtan oku (5dk cache, in-flight
  // dedupe, fail→eski cache). Anahtarları sabit bir sıraya (alfabetik)
  // koyuyoruz ki tüm satırlar için sortOrder deterministik kalsın — eski
  // hardcoded dizinin sağladığı garanti.
  // loadDocCatalogKeySet() preserves the admin-managed `sort_order` from
  // catalog_options (loader SELECTs ORDER BY sort_order, id). Spreading
  // the Set keeps that order, so the importer's `sortOrder` field matches
  // what the widget/UI uses elsewhere.
  const docKeySet = await loadDocCatalogKeySet();
  const docKeys = [...docKeySet];
  if (docKeys.length === 0) {
    // Katalog tamamen boş veya DB hiç ulaşılamadı ve cache de yok: import
    // sessizce belge sütunlarını yok sayarsa kullanıcı sebebini anlayamaz.
    res.status(503).json({
      error: "Belge kataloğu yüklenemedi, lütfen tekrar deneyin.",
    });
    return;
  }
  const docKeyOrder = new Map(docKeys.map((k, i) => [k, i]));
  // Set of column header names from the incoming payload that we tried to
  // match against the catalog but didn't recognise. Reported back so the
  // admin sees "you imported a column called `xyz_form` that isn't in the
  // catalog — was it renamed or removed?" instead of it silently dropping.
  const unknownDocCols = new Set<string>();
  // Well-known non-document column names from the program payload schema;
  // anything that's neither a known doc key nor one of these gets flagged
  // as an unknown doc-column candidate.
  const NON_DOC_COLUMNS = new Set<string>([
    "universityId", "universityName", "name", "description", "degree", "field", "language",
    "duration", "tuitionFee", "currency", "scholarship", "intakes",
    "requirements", "commissionRate", "applicationFee", "advancedFee",
    "depositFee", "serviceFeeAmount", "discountedFee", "languageFee",
    "feeType", "minGpa", "minLanguageScore", "quota", "isActive", "country",
  ]);

  const docColsByRowIdx = new Map<number, { documentType: string; mandatory: boolean; sortOrder: number }[] | undefined>();
  const rowIdxByParsedIdx: number[] = [];
  let invalidDocCells = 0;
  const skipReasons: { row: number; reason: string }[] = [];
  const parsed = normalizedRows.map((r, rowIdx) => {
    // Excel parsed via XLSX often gives "" for empty cells, which `??` does
    // not treat as missing — coerce blanks to undefined first.
    const rawId = (r.universityId as unknown) === "" || r.universityId === null ? undefined : r.universityId;
    const rawName = typeof r.universityName === "string" && r.universityName.trim() ? r.universityName.trim() : undefined;
    const uid = rawId ?? (rawName ? uniNameMap[rawName.toLowerCase()] : undefined);
    if (!uid) {
      skipReasons.push({
        row: rowIdx + 2,
        reason: rawName
          ? `university not found in system: "${rawName}"`
          : "missing university (fill the University / universityName column)",
      });
      return null;
    }
    if (!r.name) {
      skipReasons.push({ row: rowIdx + 2, reason: "missing program name" });
      return null;
    }
    let docList: { documentType: string; mandatory: boolean; sortOrder: number }[] | undefined;
    let sawAnyDocCol = false;
    // Iterate the row's OWN keys (not the catalog) so we can detect
    // "this column looks like a doc column but isn't in the catalog
    // anymore" — that's the case Task #179 is about. We still validate
    // membership with `docKeySet` so unknown keys never land in the DB.
    for (const colKey of Object.keys(r)) {
      if (NON_DOC_COLUMNS.has(colKey)) continue;
      if (docKeySet.has(colKey)) {
        sawAnyDocCol = true;
        const { value, invalid } = parseDocCellValue((r as Record<string, unknown>)[colKey]);
        if (invalid) invalidDocCells++;
        if (value !== null) {
          if (!docList) docList = [];
          docList.push({
            documentType: colKey,
            mandatory: value === "mandatory",
            sortOrder: docKeyOrder.get(colKey) ?? 9999,
          });
        }
      } else {
        // Looks like a doc-column shape but unknown to the catalog.
        // Only flag it if the cell value PARSES as a doc marker
        // (mandatory/optional/yes/no/etc.). Random extra columns that
        // happen to be in the sheet but contain unrelated text would
        // otherwise spam the warning list with false positives.
        const v = (r as Record<string, unknown>)[colKey];
        const parsed = parseDocCellValue(v);
        if (parsed.value !== null || parsed.invalid) {
          unknownDocCols.add(colKey);
        }
      }
    }
    if (sawAnyDocCol) docColsByRowIdx.set(rowIdx, docList ?? []);
    rowIdxByParsedIdx.push(rowIdx);
    return {
      universityId: uid, name: r.name, description: r.description ?? null, degree: r.degree ?? null,
      field: r.field ?? null, language: r.language ?? null,
      duration: r.duration ?? null,
      tuitionFee: r.tuitionFee ? Number(r.tuitionFee) : null,
      currency: r.currency ?? "USD",
      scholarship: r.scholarship ? Number(r.scholarship) : null,
      intakes: r.intakes ?? null, requirements: r.requirements ?? null,
      commissionRate: r.commissionRate ? Number(r.commissionRate) : null,
      applicationFee: r.applicationFee ? Number(r.applicationFee) : null,
      advancedFee: r.advancedFee ? Number(r.advancedFee) : null,
      depositFee: r.depositFee ? Number(r.depositFee) : null,
      serviceFeeAmount: r.serviceFeeAmount ? Number(r.serviceFeeAmount) : null,
      discountedFee: r.discountedFee ? Number(r.discountedFee) : null,
      languageFee: r.languageFee ? Number(r.languageFee) : null,
      feeType: r.feeType ?? null,
      minGpa: r.minGpa ? Number(r.minGpa) : null,
      minLanguageScore: r.minLanguageScore ? Number(r.minLanguageScore) : null,
      quota: r.quota ? (isNaN(Number(r.quota)) || Math.round(Number(r.quota)) < 1 ? null : Math.round(Number(r.quota))) : null,
      isActive: r.isActive === false || (typeof r.isActive === "string" && ["no", "false", "0"].includes(r.isActive.toLowerCase().trim())) ? false : true,
    };
  }).filter(Boolean) as (typeof programsTable.$inferInsert)[];

  if (parsed.length === 0) {
    const sample = skipReasons.slice(0, 5).map(s => `row ${s.row}: ${s.reason}`).join("; ");
    const more = skipReasons.length > 5 ? ` (+${skipReasons.length - 5} more)` : "";
    res.status(400).json({
      error: `No valid rows imported. ${sample}${more}`,
      skipReasons,
    });
    return;
  }

  const existingPrograms = await db.select().from(programsTable);
  const existingMap = new Map<string, number>();
  for (const p of existingPrograms) {
    const key = `${p.universityId}|${(p.name || "").toLowerCase()}|${(p.degree || "").toLowerCase()}|${(p.language || "").toLowerCase()}`;
    existingMap.set(key, p.id);
  }

  let insertedCount = 0;
  let updatedCount = 0;
  const toInsert: typeof parsed = [];
  const insertRowIdxs: number[] = [];
  const docsToReplace = new Map<number, { documentType: string; mandatory: boolean; sortOrder: number }[]>();

  const seenKeys = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const val = parsed[i];
    const origRowIdx = rowIdxByParsedIdx[i] ?? i;
    const key = `${val.universityId}|${(val.name || "").toLowerCase()}|${(val.degree || "").toLowerCase()}|${(val.language || "").toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const existingId = existingMap.get(key);
    if (existingId) {
      const { universityId: _uid, ...updates } = val;
      await db.update(programsTable).set({ ...updates, updatedAt: new Date() }).where(eq(programsTable.id, existingId));
      updatedCount++;
      if (docColsByRowIdx.has(origRowIdx)) {
        docsToReplace.set(existingId, docColsByRowIdx.get(origRowIdx) || []);
      }
    } else {
      toInsert.push(val);
      insertRowIdxs.push(origRowIdx);
    }
  }

  // Postgres bind-parameter limit is 32767 (16-bit). For 7000+ row imports,
  // a single INSERT...VALUES blows past this, so we chunk all bulk writes.
  // ~22 cols × 500 rows = 11000 params, well under the limit.
  const INSERT_CHUNK = 500;

  if (toInsert.length > 0) {
    const allInserted: { id: number }[] = [];
    for (let off = 0; off < toInsert.length; off += INSERT_CHUNK) {
      const slice = toInsert.slice(off, off + INSERT_CHUNK);
      const inserted = await db.insert(programsTable).values(slice).returning({ id: programsTable.id });
      allInserted.push(...inserted);
    }
    insertedCount = allInserted.length;
    allInserted.forEach((p, idx) => {
      const origRowIdx = insertRowIdxs[idx];
      if (docColsByRowIdx.has(origRowIdx)) {
        docsToReplace.set(p.id, docColsByRowIdx.get(origRowIdx) || []);
      }
    });
  }

  if (docsToReplace.size > 0) {
    const ids = [...docsToReplace.keys()];
    // Chunk DELETE too — inArray with 7000 ids = 7000 bind params, still fine,
    // but be safe for future growth.
    const ID_CHUNK = 5000;
    for (let off = 0; off < ids.length; off += ID_CHUNK) {
      await db.delete(programDocumentRequirementsTable)
        .where(inArray(programDocumentRequirementsTable.programId, ids.slice(off, off + ID_CHUNK)));
    }
    const allDocRows: { programId: number; documentType: string; mandatory: boolean; sortOrder: number }[] = [];
    for (const [pid, docs] of docsToReplace.entries()) {
      for (const d of docs) allDocRows.push({ programId: pid, ...d });
    }
    if (allDocRows.length > 0) {
      // 4 cols × 1000 rows = 4000 params per chunk.
      const DOC_CHUNK = 1000;
      for (let off = 0; off < allDocRows.length; off += DOC_CHUNK) {
        await db.insert(programDocumentRequirementsTable)
          .values(allDocRows.slice(off, off + DOC_CHUNK));
      }
    }
  }

  const unknownDocColumns = [...unknownDocCols].sort();
  await logAudit(req.user!.id, "bulk_import_programs", "program", undefined, {
    inserted: insertedCount, updated: updatedCount, docsTouched: docsToReplace.size,
    invalidDocCells, unknownDocColumns, createdUniversities,
  }, req.ip);
  res.json({
    inserted: insertedCount, updated: updatedCount,
    skipped: rows.length - parsed.length,
    docsTouched: docsToReplace.size, invalidDocCells,
    unknownDocColumns,
    createdUniversities,
    ...(unknownDocColumns.length > 0
      ? { unknownDocColumnsMessage: `Tanımsız belge sütunları (katalogda yok, atlandı): ${unknownDocColumns.join(", ")}` }
      : {}),
  });
  } catch (err: any) {
    console.error("[programs/bulk] failed:", err?.message || err, err?.code, err?.detail, err?.stack?.split("\n").slice(0, 4).join(" | "));
    res.status(500).json({
      error: err?.message || "Bulk import failed",
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
    });
  }
});

/* ─── CATALOG OPTIONS ──────────────────────────────────────── */

const VALID_CATEGORIES = ["degree", "language", "duration", "fee_type", "intake", "field", "university_type", "documents", "currency"];

router.get("/catalog-options", async (_req, res): Promise<void> => {
  const data = await db.select().from(catalogOptionsTable).orderBy(asc(catalogOptionsTable.category), asc(catalogOptionsTable.sortOrder));
  const grouped: Record<string, typeof data> = {};
  for (const row of data) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push(row);
  }
  res.json({ data, grouped });
});

router.post("/catalog-options", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const { category, value, sortOrder = 0, metadata } = req.body;
  if (!category || !value) { res.status(400).json({ error: "category and value are required" }); return; }
  if (!VALID_CATEGORIES.includes(category)) { res.status(400).json({ error: "Invalid category" }); return; }
  const insertValues: Record<string, unknown> = { category, value, sortOrder };
  if (metadata !== undefined) insertValues.metadata = metadata;
  const [opt] = await db.insert(catalogOptionsTable).values(insertValues as never).returning();
  await logAudit(req.user!.id, "create_catalog_option", "catalog_option", opt.id, { category, value }, req.ip);
  if (category === "documents") invalidateDocCatalogCache();
  if (category === "currency") invalidateCurrencyCatalog();
  res.status(201).json(opt);
});

router.patch("/catalog-options/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { value, sortOrder, isActive, metadata } = req.body;
  const updates: Record<string, unknown> = {};
  if (value !== undefined) updates.value = value;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (isActive !== undefined) updates.isActive = isActive;
  if (metadata !== undefined) updates.metadata = metadata;
  const [opt] = await db.update(catalogOptionsTable).set(updates).where(eq(catalogOptionsTable.id, id)).returning();
  if (!opt) { res.status(404).json({ error: "Not found" }); return; }
  if (opt.category === "documents") invalidateDocCatalogCache();
  if (opt.category === "currency") invalidateCurrencyCatalog();
  res.json(opt);
});

/* ─── Usage / orphan tooling for documents & degree catalog options ─────
 *
 * Belge tipi (catalog_options where category='documents') ve akademik
 * derece (category='degree') seçenekleri sistemde başka tablolardan
 * referans alıyor:
 *   - program_document_requirements.document_type (text, FK yok)
 *   - degree_document_requirements.document_type   (text, FK yok)
 *   - degree_document_requirements.catalog_option_id (FK CASCADE — sessiz
 *     veri kaybı riski; bu yüzden silmeden önce burada uyarıyoruz)
 *
 * `RESTRICT` davranışını uygulama katmanında uyguluyoruz: önce referans
 * sayımı, varsa 409 + nerede kullanıldığını söyleyen payload. CASCADE
 * istemiyoruz çünkü 47 programın zorunlu belgesinin sessizce silinmesi
 * domain için kabul edilemez.
 *
 * `getDocumentUsage()` belge anahtarı için, `getDegreeUsage()` derece
 * option id'si için kullanılır; yetim taraması da bu helper'lara dayanır.
 * ─────────────────────────────────────────────────────────────────────── */

type DocumentUsage = {
  programs: { id: number; name: string; universityName: string; mandatory: boolean }[];
  degrees: { id: number; value: string; mandatory: boolean }[];
  totals: { programs: number; degrees: number; total: number };
};

// Accepts an optional drizzle transaction client so the delete handler can
// read usage on the same snapshot/locks as its FOR UPDATE; outside a tx
// (proactive usage, orphan scan) the default `db` client is fine.
type DbOrTx = typeof db;
async function getDocumentUsage(documentType: string, dbx: DbOrTx = db): Promise<DocumentUsage> {
  const programRows = await dbx
    .select({
      id: programsTable.id,
      name: programsTable.name,
      universityName: universitiesTable.name,
      mandatory: programDocumentRequirementsTable.mandatory,
    })
    .from(programDocumentRequirementsTable)
    .innerJoin(programsTable, eq(programDocumentRequirementsTable.programId, programsTable.id))
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(eq(programDocumentRequirementsTable.documentType, documentType))
    .orderBy(asc(universitiesTable.name), asc(programsTable.name));

  const degreeRows = await dbx
    .select({
      id: catalogOptionsTable.id,
      value: catalogOptionsTable.value,
      mandatory: degreeDocumentRequirementsTable.mandatory,
    })
    .from(degreeDocumentRequirementsTable)
    .innerJoin(catalogOptionsTable, eq(degreeDocumentRequirementsTable.catalogOptionId, catalogOptionsTable.id))
    .where(eq(degreeDocumentRequirementsTable.documentType, documentType))
    .orderBy(asc(catalogOptionsTable.value));

  return {
    programs: programRows,
    degrees: degreeRows,
    totals: {
      programs: programRows.length,
      degrees: degreeRows.length,
      total: programRows.length + degreeRows.length,
    },
  };
}

type DegreeUsage = {
  documents: { documentType: string; mandatory: boolean; sortOrder: number }[];
  totals: { documents: number };
};

async function getDegreeUsage(catalogOptionId: number, dbx: DbOrTx = db): Promise<DegreeUsage> {
  const rows = await dbx
    .select({
      documentType: degreeDocumentRequirementsTable.documentType,
      mandatory: degreeDocumentRequirementsTable.mandatory,
      sortOrder: degreeDocumentRequirementsTable.sortOrder,
    })
    .from(degreeDocumentRequirementsTable)
    .where(eq(degreeDocumentRequirementsTable.catalogOptionId, catalogOptionId))
    .orderBy(asc(degreeDocumentRequirementsTable.sortOrder));
  return { documents: rows, totals: { documents: rows.length } };
}

// GET /api/catalog-options/:id/usage — proactive lookup for the UI so
// admins see "kullanılıyor mu?" before they even click delete.
router.get("/catalog-options/:id/usage", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [opt] = await db.select().from(catalogOptionsTable).where(eq(catalogOptionsTable.id, id));
  if (!opt) { res.status(404).json({ error: "Not found" }); return; }
  if (opt.category === "documents") {
    const usage = await getDocumentUsage(opt.value);
    res.json({ category: opt.category, value: opt.value, ...usage });
    return;
  }
  if (opt.category === "degree") {
    const usage = await getDegreeUsage(opt.id);
    res.json({ category: opt.category, value: opt.value, ...usage });
    return;
  }
  res.json({ category: opt.category, value: opt.value, totals: { total: 0 } });
});

// GET /api/catalog-options/orphans?category=documents
// Lists document_type values that are referenced by program / degree
// requirements but no longer exist in catalog_options (any active state).
// Includes a usage breakdown per orphan so the admin can decide whether to
// purge the references or restore the catalog entry.
router.get("/catalog-options/orphans", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const category = String(req.query.category || "documents");
  if (category !== "documents") {
    // Degree orphans don't exist: degree_document_requirements.catalog_option_id
    // is FK ON DELETE CASCADE, so a deleted degree takes its rows with it.
    // We surface an empty list for forward-compat with the UI.
    res.json({ category, orphans: [] });
    return;
  }

  const validValuesRows = await db
    .select({ value: catalogOptionsTable.value })
    .from(catalogOptionsTable)
    .where(eq(catalogOptionsTable.category, "documents"));
  const validValues = validValuesRows.map((r) => r.value);

  const fromPrograms = await db
    .select({ documentType: programDocumentRequirementsTable.documentType })
    .from(programDocumentRequirementsTable)
    .where(validValues.length > 0
      ? notInArray(programDocumentRequirementsTable.documentType, validValues)
      : isNotNull(programDocumentRequirementsTable.documentType));

  const fromDegrees = await db
    .select({ documentType: degreeDocumentRequirementsTable.documentType })
    .from(degreeDocumentRequirementsTable)
    .where(validValues.length > 0
      ? notInArray(degreeDocumentRequirementsTable.documentType, validValues)
      : isNotNull(degreeDocumentRequirementsTable.documentType));

  const orphanKeys = Array.from(new Set([
    ...fromPrograms.map((r) => r.documentType),
    ...fromDegrees.map((r) => r.documentType),
  ])).sort();

  const orphans = await Promise.all(orphanKeys.map(async (key) => {
    const usage = await getDocumentUsage(key);
    return {
      documentType: key,
      programCount: usage.totals.programs,
      degreeCount: usage.totals.degrees,
      total: usage.totals.total,
    };
  }));

  res.json({ category, orphans });
});

// POST /api/catalog-options/orphans/cleanup
// Body: { documentType, action: "delete_refs" | "restore_to_catalog" }
//   delete_refs       → drop the orphan rows from both requirement tables
//   restore_to_catalog → re-insert the document_type as a (humanised) entry
//                        in catalog_options so existing program/degree
//                        config keeps working.
router.post("/catalog-options/orphans/cleanup", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const { documentType, action } = (req.body || {}) as { documentType?: unknown; action?: unknown };
  if (typeof documentType !== "string" || !documentType.trim()) {
    res.status(400).json({ error: "documentType is required" }); return;
  }
  const key = documentType.trim();
  // Reuse the embed-widget key whitelist so we can't pass shady payloads
  // (incl. __proto__) through this endpoint.
  if (!/^[a-z0-9_\-]{1,64}$/i.test(key)
      || /^(?:__proto__|constructor|prototype)$/i.test(key)) {
    res.status(400).json({ error: "Invalid document type key" }); return;
  }
  if (action !== "delete_refs" && action !== "restore_to_catalog") {
    res.status(400).json({ error: "action must be delete_refs or restore_to_catalog" }); return;
  }

  if (action === "delete_refs") {
    // Orphan-only guard: this endpoint exists to clean up references to
    // catalog entries that no longer exist. If the document_type is still
    // a live catalog option, refuse — otherwise a privileged user with
    // direct API access could wipe legitimate program/degree requirements
    // for an in-use document type. UI only exposes orphan keys, but the
    // API contract must be tight too.
    let removed = 0;
    let conflict = false;
    await db.transaction(async (tx) => {
      const [live] = await tx.select({ id: catalogOptionsTable.id })
        .from(catalogOptionsTable)
        .where(and(eq(catalogOptionsTable.category, "documents"), eq(catalogOptionsTable.value, key)))
        .for("update");
      if (live) { conflict = true; return; }
      const p = await tx.delete(programDocumentRequirementsTable)
        .where(eq(programDocumentRequirementsTable.documentType, key))
        .returning({ id: programDocumentRequirementsTable.id });
      const d = await tx.delete(degreeDocumentRequirementsTable)
        .where(eq(degreeDocumentRequirementsTable.documentType, key))
        .returning({ id: degreeDocumentRequirementsTable.id });
      removed = p.length + d.length;
    });
    if (conflict) {
      res.status(409).json({
        error: "not_orphan",
        message: "Bu belge tipi hâlâ katalogda mevcut; önce katalog seçeneğini silin veya pasife alın.",
        documentType: key,
      });
      return;
    }
    await logAudit(req.user!.id, "cleanup_orphan_document_refs", "catalog_option", undefined, { documentType: key, removed }, req.ip);
    res.json({ ok: true, action, documentType: key, removed });
    return;
  }

  // restore_to_catalog: don't clobber an existing entry if one is somehow
  // already there (race with another admin); re-activate it instead.
  const [existing] = await db.select().from(catalogOptionsTable)
    .where(and(eq(catalogOptionsTable.category, "documents"), eq(catalogOptionsTable.value, key)));
  if (existing) {
    if (!existing.isActive) {
      await db.update(catalogOptionsTable).set({ isActive: true }).where(eq(catalogOptionsTable.id, existing.id));
    }
    invalidateDocCatalogCache();
    await logAudit(req.user!.id, "restore_orphan_document_to_catalog", "catalog_option", existing.id, { documentType: key, reactivated: !existing.isActive }, req.ip);
    res.json({ ok: true, action, documentType: key, restoredId: existing.id });
    return;
  }

  const humanised = key
    .replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
  const [opt] = await db.insert(catalogOptionsTable).values({
    category: "documents",
    value: key,
    sortOrder: 9999,
    metadata: { label: humanised, icon: "📎", accept: ".pdf,.jpg,.jpeg,.png" },
  } as never).returning();
  invalidateDocCatalogCache();
  await logAudit(req.user!.id, "restore_orphan_document_to_catalog", "catalog_option", opt.id, { documentType: key, created: true }, req.ip);
  res.json({ ok: true, action, documentType: key, restoredId: opt.id });
});

router.delete("/catalog-options/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Atomic check + delete: a previous version did `select → check → delete`
  // as separate statements, which left a TOCTOU window where a concurrent
  // staff request could insert a new requirement row between the check and
  // the delete. For category='degree', this is particularly bad because
  // degree_document_requirements.catalog_option_id is FK ON DELETE CASCADE,
  // so the racing row would be silently wiped.
  //
  // Fix:
  // 1) Wrap everything in a single transaction.
  // 2) SELECT ... FOR UPDATE on the catalog_options row. For 'degree' this
  //    is the FK parent, so PG blocks concurrent INSERT into
  //    degree_document_requirements (which needs FOR KEY SHARE on the
  //    parent) until we commit. For 'documents' there's no FK; we still
  //    serialise admin-initiated mutations on the same option and accept
  //    the small remaining race against staff inserts of new program
  //    requirements (the orphan scanner is the safety net for that case).
  type CurrencyUsage = {
    programs: number;
    commissions: number;
    serviceFees: number;
    total: number;
  };
  type BlockedReason =
    | { kind: "documents"; usage: DocumentUsage }
    | { kind: "degree"; usage: DegreeUsage }
    | { kind: "currency"; usage: CurrencyUsage };

  let opt: typeof catalogOptionsTable.$inferSelect | undefined;
  let blocked: BlockedReason | null = null;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(catalogOptionsTable)
      .where(eq(catalogOptionsTable.id, id))
      .for("update");
    if (!row) return; // already gone — idempotent
    opt = row;

    if (row.category === "documents") {
      const usage = await getDocumentUsage(row.value, tx as unknown as DbOrTx);
      if (usage.totals.total > 0) { blocked = { kind: "documents", usage }; return; }
    } else if (row.category === "degree") {
      const usage = await getDegreeUsage(row.id, tx as unknown as DbOrTx);
      if (usage.totals.documents > 0) { blocked = { kind: "degree", usage }; return; }
    } else if (row.category === "currency") {
      const code = String(row.value).toUpperCase();
      const { commissionsTable, serviceFeesTable } = await import("@workspace/db");
      const [pRow] = await tx.select({ c: sql<number>`count(*)` }).from(programsTable)
        .where(sql`upper(${programsTable.currency}) = ${code}`);
      const [cRow] = await tx.select({ c: sql<number>`count(*)` }).from(commissionsTable)
        .where(sql`upper(${commissionsTable.currency}) = ${code}`);
      const [sRow] = await tx.select({ c: sql<number>`count(*)` }).from(serviceFeesTable)
        .where(sql`upper(${serviceFeesTable.currency}) = ${code}`);
      const programs = Number(pRow?.c ?? 0);
      const commissions = Number(cRow?.c ?? 0);
      const serviceFees = Number(sRow?.c ?? 0);
      const total = programs + commissions + serviceFees;
      if (total > 0) { blocked = { kind: "currency", usage: { programs, commissions, serviceFees, total } }; return; }
    }

    await tx.delete(catalogOptionsTable).where(eq(catalogOptionsTable.id, id));
  });

  if (!opt) { res.sendStatus(204); return; }

  const b = blocked as (BlockedReason | null);
  if (b) {
    await logAudit(req.user!.id, "delete_catalog_option_blocked", "catalog_option", id, {
      category: opt.category, value: opt.value,
      totals: b.kind === "currency" ? b.usage : b.usage.totals,
    }, req.ip);
    if (b.kind === "documents") {
      res.status(409).json({
        error: "in_use",
        message: "Bu belge tipi şu programlarda veya derecelerde kullanılıyor. Önce buralardan kaldırın, sonra silmeyi tekrar deneyin.",
        category: opt.category,
        value: opt.value,
        ...b.usage,
      });
    } else if (b.kind === "degree") {
      res.status(409).json({
        error: "in_use",
        message: "Bu dereceye bağlı belge gereksinimleri var. Önce bunları temizleyin, sonra silmeyi tekrar deneyin.",
        category: opt.category,
        value: opt.value,
        ...b.usage,
      });
    } else {
      const u = b.usage;
      const parts: string[] = [];
      if (u.programs > 0) parts.push(`${u.programs} program`);
      if (u.commissions > 0) parts.push(`${u.commissions} komisyon`);
      if (u.serviceFees > 0) parts.push(`${u.serviceFees} hizmet bedeli`);
      res.status(409).json({
        error: "in_use",
        message: `Bu para birimi (${opt.value}) ${parts.join(", ")} kaydında kullanılıyor. Önce bu kayıtların para birimini değiştirin, sonra silmeyi tekrar deneyin.`,
        category: opt.category,
        value: opt.value,
        usage: u,
      });
    }
    return;
  }

  await logAudit(req.user!.id, "delete_catalog_option", "catalog_option", id, { category: opt.category, value: opt.value }, req.ip);
  if (opt.category === "documents") invalidateDocCatalogCache();
  if (opt.category === "currency") invalidateCurrencyCatalog();
  res.sendStatus(204);
});

export default router;
