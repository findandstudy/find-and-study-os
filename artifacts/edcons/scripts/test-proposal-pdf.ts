import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import {
  buildProposalPdf,
  getProposalDateTime,
  getProposalFirstYearTotal,
  getProposalFeePeriod,
  getProposalFeeType,
  getProposalServiceFee,
  normalizeProposalLogoUrl,
  proposalPdfText,
  type ProposalProgramData,
} from "../src/lib/generateProposalPdf";
import {
  collectProposalStudyLevels,
  loadProposalDocumentRequirements,
} from "../src/lib/proposalDocumentRequirements";
import { getProposalFeeAdjustmentContext } from "../src/lib/proposalFeeAdjustment";

const sampleProgram: ProposalProgramData = {
  id: 1,
  name: "Bachelor of Business Administration (English)",
  degree: "Bachelor",
  language: "English",
  duration: "48 Months",
  tuitionFee: 6000,
  discountedFee: 5100,
  currency: "USD",
  applicationFee: 100,
  serviceFeeAmount: 250,
  intakes: "Sep",
  universityName: "Altinbas University",
  universityCity: "Istanbul",
  universityCountry: "Turkey",
  universityType: "Private",
  universityStatus: "Open",
};

test("service fee adjustment is PDF-only arithmetic and clamps below zero", () => {
  assert.equal(getProposalServiceFee(sampleProgram, 125, false), 375);
  assert.equal(getProposalServiceFee(sampleProgram, -500, false), null);
});

test("hide service fee always wins over an adjustment", () => {
  assert.equal(getProposalServiceFee(sampleProgram, 10_000, true), null);
});

test("flat PDF fee adjustment is blocked for mixed-currency selections", () => {
  const context = getProposalFeeAdjustmentContext([
    { currency: "gbp", serviceFeeAmount: null },
    { currency: "CAD", serviceFeeAmount: 250 },
    { currency: " cad ", serviceFeeAmount: 500 },
  ]);

  assert.deepEqual(context.currencies, ["GBP", "CAD"]);
  assert.equal(context.hasMultipleCurrencies, true);
  assert.equal(context.sampleFee, 250);
});

test("single-currency PDF fee adjustment uses the normalized selected currency", () => {
  const context = getProposalFeeAdjustmentContext([
    { currency: "usd", serviceFeeAmount: null },
    { currency: " USD ", serviceFeeAmount: 300 },
  ]);

  assert.deepEqual(context.currencies, ["USD"]);
  assert.equal(context.currency, "USD");
  assert.equal(context.hasMultipleCurrencies, false);
  assert.equal(context.sampleFee, 300);
});

test("hidden service fees cannot be inferred from a first-year total", () => {
  assert.equal(getProposalFirstYearTotal(sampleProgram, 100, true), null);
  assert.equal(getProposalFirstYearTotal(sampleProgram, 100, false), 5_550);
});

test("rendered PDF shows the adjusted fee and hide removes it plus the derived total", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  async function extractText(hideServiceFee: boolean): Promise<string> {
    const document = await buildProposalPdf({
      programs: [sampleProgram],
      serviceFeeMarkup: 125,
      hideServiceFee,
      generatedAt: new Date("2026-09-08T08:00:00.000Z"),
    });
    const pdf = await getDocument({
      data: new Uint8Array(document.output("arraybuffer")),
      disableWorker: true,
    }).promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    return content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
  }

  const visibleText = await extractText(false);
  assert.match(visibleText, /Service fee \$375/);
  assert.match(visibleText, /\$5,575 including visible fees/);

  const hiddenText = await extractText(true);
  assert.doesNotMatch(hiddenText, /Service fee/);
  assert.doesNotMatch(hiddenText, /including visible fees/);
});

test("proposal date and time are rendered in Europe/Istanbul", () => {
  const value = getProposalDateTime(new Date("2026-07-28T00:15:00.000Z"));
  assert.deepEqual(value, { date: "28.07.2026", time: "03:15" });
});

test("unsupported PDF glyphs are normalised without changing ASCII data", () => {
  assert.equal(proposalPdfText("İŞ GÜÇ — 2026"), "Is Guc - 2026");
  assert.equal(proposalPdfText("info@example.com"), "info@example.com");
});

test("proposal fee period follows the program instead of defaulting every row to year", () => {
  assert.equal(getProposalFeeType({ feeType: "Per Program" }), "Per Program");
  assert.equal(getProposalFeePeriod({ feeType: "Per Program" }), "/ program");
  assert.equal(getProposalFeePeriod({ feeType: "Per Semester" }), "/ semester");
  assert.equal(getProposalFeePeriod({ feeType: null }), "/ year");
});

test("generated proposal preserves mixed program fee periods in its visible text", async () => {
  const document = await buildProposalPdf({
    programs: [
      {
        ...sampleProgram,
        id: 101,
        universityName: "Istanbul Kent University",
        tuitionFee: 5_000,
        discountedFee: 2_500,
        feeType: "Per Program",
      },
      {
        ...sampleProgram,
        id: 102,
        universityName: "Annual Fee University",
        tuitionFee: 6_000,
        discountedFee: null,
        feeType: "Per Year",
      },
    ],
    generatedAt: new Date("2026-08-11T18:16:00.000Z"),
  });
  const bytes = new Uint8Array(document.output("arraybuffer"));
  const visualBytes = bytes.slice();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: bytes, disableWorker: true }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ");

  assert.match(text, /Tuition range \(mixed fee periods\)/);
  assert.match(text, /P R O G R A M S\s+S O R T E D\s+B Y\s+L I S T E D\s+T U I T I O N/);
  assert.match(text, /\$2,500\s+\/ program/);
  assert.match(text, /\$6,000\s+\/ year/);

  const visualPath = process.env.PROPOSAL_FEE_TYPE_VISUAL_PATH;
  if (visualPath) {
    await mkdir(dirname(visualPath), { recursive: true });
    await writeFile(visualPath, visualBytes);
  }
});

test("storage logo paths are normalised without changing data URLs", () => {
  assert.equal(
    normalizeProposalLogoUrl("/api/storage/objects/objects/branding/logo-id"),
    "/api/storage/objects/branding/logo-id",
  );
  assert.equal(
    normalizeProposalLogoUrl("data:image/png;base64,AAAA"),
    "data:image/png;base64,AAAA",
  );
  assert.equal(normalizeProposalLogoUrl("  "), null);
});

test("mixed proposals use only the distinct study levels present in selected programs", () => {
  assert.deepEqual(
    collectProposalStudyLevels([
      { degree: "Bachelor" },
      { degree: "Master" },
      { degree: "master" },
      { degree: "PhD" },
    ], ["Associate"]),
    ["Bachelor", "Master", "PhD"],
  );
});

test("an unconfigured selected level does not block a mixed-level proposal", async () => {
  const requirementsByLevel: Record<string, Array<{ documentType: string; mandatory: boolean }>> = {
    Bachelor: [{ documentType: "passport", mandatory: true }],
    Master: [{ documentType: "diploma_transcript", mandatory: true }],
    PhD: [],
  };
  const result = await loadProposalDocumentRequirements({
    studyLevels: ["Bachelor", "Master", "PhD"],
    fetchRequirements: async (studyLevel) => requirementsByLevel[studyLevel] ?? [],
    resolveLabel: (documentType) => documentType.replaceAll("_", " "),
  });

  assert.deepEqual(result.missingStudyLevels, ["PhD"]);
  assert.deepEqual(
    result.documentRequirements.map((item) => item.studyLevel),
    ["Bachelor", "Master"],
  );
});

test("seven-program visual proposal stays on one page and remains lightweight", async () => {
  const programs = Array.from({ length: 7 }, (_, index) => ({
    ...sampleProgram,
    id: index + 1,
    name: `${sampleProgram.name} ${index + 1}`,
  }));
  const document = await buildProposalPdf({
    programs,
    companyName: "Find And Study",
    companyEmail: "info@findandstudy.com",
    companyPhone: "+90 212 000 00 00",
    companyWebsite: "https://findandstudy.com",
    primaryColor: "#102E66",
    secondaryColor: "#2563EB",
    accentColor: "#7C3AED",
    successColor: "#16A34A",
    generatedAt: new Date("2026-07-28T00:15:00.000Z"),
  });
  const bytes = new Uint8Array(document.output("arraybuffer"));
  assert.equal(document.getNumberOfPages(), 1);
  assert.ok(bytes.byteLength > 2_500);
  assert.ok(bytes.byteLength < 300_000, `fixture PDF is unexpectedly large: ${bytes.byteLength} bytes`);

  const visualPath = process.env.PROPOSAL_VISUAL_PATH;
  if (visualPath) {
    await mkdir(dirname(visualPath), { recursive: true });
    await writeFile(visualPath, bytes);
  }
});

test("long comparison repeats cleanly across pages without inflating the file", async () => {
  const universities = [
    ["Altinbas University", "Istanbul", "Turkey"],
    ["Ankara Bilim University", "Ankara", "Turkey"],
    ["Riga Technical University", "Riga", "Latvia"],
  ] as const;
  const programs = Array.from({ length: 24 }, (_, index) => {
    const university = universities[index % universities.length];
    return {
      ...sampleProgram,
      id: index + 1,
      name:
        index % 3 === 0
          ? `Bachelor of International Business Administration and Digital Management ${index + 1}`
          : `${sampleProgram.name} ${index + 1}`,
      degree: index % 5 === 0 ? "Associate" : "Bachelor",
      language: index % 4 === 0 ? "Turkish" : "English",
      intakes: index % 2 === 0 ? "February, September" : "September",
      universityName: university[0],
      universityCity: university[1],
      universityCountry: university[2],
      serviceFeeAmount: index % 4 === 0 ? 0 : 250,
    };
  });
  const document = await buildProposalPdf({
    programs,
    companyName: "Find And Study",
    companyEmail: "info@findandstudy.com",
    companyPhone: "+90 212 000 00 00",
    companyWebsite: "https://findandstudy.com",
    generatedAt: new Date("2026-07-30T09:15:00.000Z"),
  });
  const bytes = new Uint8Array(document.output("arraybuffer"));
  assert.ok(document.getNumberOfPages() >= 3);
  assert.ok(bytes.byteLength < 450_000, `comparison PDF is unexpectedly large: ${bytes.byteLength} bytes`);

  const previewPath = process.env.PROPOSAL_PREVIEW_PATH;
  if (previewPath) {
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, bytes);
  }
});

test("eleven selected programs use the adaptive one-page comparison layout", async () => {
  const programs = Array.from({ length: 11 }, (_, index) => ({
    ...sampleProgram,
    id: index + 1,
    name: `${sampleProgram.name} ${index + 1}`,
    universityName: `University ${index + 1}`,
    applicationFee: index % 3 === 0 ? 100 : 0,
    serviceFeeAmount: index % 4 === 0 ? 250 : 0,
  }));
  const document = await buildProposalPdf({
    programs,
    companyName: "Find And Study",
    companyPhone: "+90 552 689 85 15",
    companyWebsite: "https://findandstudy.com",
    primaryColor: "#143591",
    secondaryColor: "#143591",
    generatedAt: new Date("2026-07-30T04:24:00.000Z"),
  });
  assert.equal(document.getNumberOfPages(), 1);

  const visualPath = process.env.PROPOSAL_ELEVEN_VISUAL_PATH;
  if (visualPath) {
    await mkdir(dirname(visualPath), { recursive: true });
    await writeFile(visualPath, new Uint8Array(document.output("arraybuffer")));
  }
});

test("selected-level documents are appended after every program page", async () => {
  const programs = Array.from({ length: 7 }, (_, index) => ({
    ...sampleProgram,
    id: index + 1,
    name: `${sampleProgram.name} ${index + 1}`,
  }));
  const document = await buildProposalPdf({
    programs,
    documentRequirements: [{
      studyLevel: "Bachelor",
      requirements: [
        { documentType: "diploma_certificate", label: "Diploma Certificate", mandatory: true },
        { documentType: "diploma_transcript", label: "Diploma Transcript", mandatory: true },
        { documentType: "passport", label: "Passport", mandatory: true },
        { documentType: "photo", label: "Photograph", mandatory: true },
        { documentType: "language_proof", label: "Language/Test Score", mandatory: false },
      ],
    }],
    companyName: "Find And Study",
    companyPhone: "+90 552 689 85 15",
    generatedAt: new Date("2026-08-08T00:15:00.000Z"),
  });

  assert.equal(document.getNumberOfPages(), 2);

  const visualPath = process.env.PROPOSAL_DOCUMENTS_VISUAL_PATH;
  if (visualPath) {
    await mkdir(dirname(visualPath), { recursive: true });
    await writeFile(visualPath, new Uint8Array(document.output("arraybuffer")));
  }
});

test("long document checklists paginate without changing program-page capacity", async () => {
  const requirements = Array.from({ length: 29 }, (_, index) => ({
    documentType: `document_${index + 1}`,
    label: `Document ${index + 1}`,
    mandatory: index < 17,
  }));
  const document = await buildProposalPdf({
    programs: [sampleProgram],
    documentRequirements: [{ studyLevel: "Master", requirements }],
    generatedAt: new Date("2026-08-08T00:15:00.000Z"),
  });

  assert.equal(document.getNumberOfPages(), 3);
});
