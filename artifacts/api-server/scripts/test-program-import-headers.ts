/**
 * programImportHeaders — unit tests (program bulk-import round-trip fix).
 *
 * PI-1  Export-format headers (Program/University/Fee Type/…) remap to
 *       internal keys — the system's own export must import unchanged.
 * PI-2  Template-format headers (already-internal camelCase) pass through.
 * PI-3  Header matching is case-insensitive + trimmed.
 * PI-4  Doc columns and unknown headers pass through verbatim.
 * PI-5  Internal key wins when both alias and internal key are present.
 * PI-6  Country column maps to `country` (used for university auto-create).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeProgramImportRow,
  normalizeProgramImportRows,
  collectUniversitiesToCreate,
} from "../src/lib/programImportHeaders.js";

describe("normalizeProgramImportRow — export round-trip (PI-1)", () => {
  it("maps every header written by the program-list exporter", () => {
    // EXACT header list produced by runExport() in admin/Catalog.tsx
    const exportRow = {
      Program: "Computer Engineering",
      Description: "English canonical programme description",
      University: "Avrasya University",
      Degree: "Bachelor",
      Field: "Engineering",
      Language: "English",
      Duration: "4 Years",
      "Fee Type": "Per Year",
      "Tuition Fee": "3500",
      Currency: "USD",
      "Commission %": "10",
      Scholarship: "500",
      Intakes: "Sep",
      "Application Fee": "0",
      "Advance Fee": "0",
      "Deposit Fee": "1000",
      "Service Fee": "0",
      "Discounted Fee": "3000",
      "Language Fee": "0",
      "Min GPA": "2.5",
      "Min Language Score": "6",
      Quota: "50",
      Active: "Yes",
      Requirements: "High school diploma",
    };
    const out = normalizeProgramImportRow(exportRow);
    assert.equal(out.name, "Computer Engineering");
    assert.equal(out.description, "English canonical programme description");
    assert.equal(out.universityName, "Avrasya University");
    assert.equal(out.degree, "Bachelor");
    assert.equal(out.field, "Engineering");
    assert.equal(out.language, "English");
    assert.equal(out.duration, "4 Years");
    assert.equal(out.feeType, "Per Year");
    assert.equal(out.tuitionFee, "3500");
    assert.equal(out.currency, "USD");
    assert.equal(out.commissionRate, "10");
    assert.equal(out.scholarship, "500");
    assert.equal(out.intakes, "Sep");
    assert.equal(out.applicationFee, "0");
    assert.equal(out.advancedFee, "0");
    assert.equal(out.depositFee, "1000");
    assert.equal(out.serviceFeeAmount, "0");
    assert.equal(out.discountedFee, "3000");
    assert.equal(out.languageFee, "0");
    assert.equal(out.minGpa, "2.5");
    assert.equal(out.minLanguageScore, "6");
    assert.equal(out.quota, "50");
    assert.equal(out.isActive, "Yes");
    assert.equal(out.requirements, "High school diploma");
    // no leftover friendly headers
    assert.equal(out["Program"], undefined);
    assert.equal(out["University"], undefined);
    assert.equal(out["Fee Type"], undefined);
  });
});

describe("normalizeProgramImportRow — internal keys (PI-2)", () => {
  it("template-format camelCase rows pass through unchanged", () => {
    const row = {
      universityName: "Antalya Bilim University",
      name: "MBA",
      degree: "Master",
      tuitionFee: "5400",
      isActive: "Yes",
    };
    const out = normalizeProgramImportRow(row);
    assert.deepEqual(out, row);
  });
});

describe("normalizeProgramImportRow — case/trim (PI-3)", () => {
  it("matches case-insensitively and trims header whitespace", () => {
    const out = normalizeProgramImportRow({
      " PROGRAM ": "X",
      "university name": "Y Uni",
      "MIN gpa": "3",
    });
    assert.equal(out.name, "X");
    assert.equal(out.universityName, "Y Uni");
    assert.equal(out.minGpa, "3");
  });
});

describe("normalizeProgramImportRow — passthrough (PI-4)", () => {
  it("doc columns and unknown headers survive verbatim", () => {
    const out = normalizeProgramImportRow({
      Program: "X",
      University: "Y",
      passport: "mandatory",
      high_school_diploma_translation: "optional",
      some_random_note: "hello",
    });
    assert.equal(out.passport, "mandatory");
    assert.equal(out.high_school_diploma_translation, "optional");
    assert.equal(out.some_random_note, "hello");
  });
});

describe("normalizeProgramImportRow — precedence (PI-5)", () => {
  it("explicit internal key beats aliased duplicate", () => {
    const out = normalizeProgramImportRow({
      University: "Friendly Name",
      universityName: "Internal Name",
    });
    assert.equal(out.universityName, "Internal Name");
    const out2 = normalizeProgramImportRow({
      universityName: "Internal Name",
      University: "Friendly Name",
    });
    assert.equal(out2.universityName, "Internal Name");
  });
  it("alias fills the slot when internal key is blank", () => {
    const out = normalizeProgramImportRow({
      universityName: "",
      University: "Friendly Name",
    });
    assert.equal(out.universityName, "Friendly Name");
  });
});

describe("normalizeProgramImportRows — Country column (PI-6)", () => {
  it("Country → country and arrays map row-by-row", () => {
    const out = normalizeProgramImportRows([
      { Program: "A", University: "U1", Country: "Turkey" },
      { Program: "B", University: "U2" },
    ]);
    assert.equal(out[0].country, "Turkey");
    assert.equal(out[0].name, "A");
    assert.equal(out[1].universityName, "U2");
    assert.equal(out[1].country, undefined);
  });
});

describe("collectUniversitiesToCreate — auto-create gating (PI-7)", () => {
  const existing = { "known university": 1 };

  it("collects unknown universities only from rows with a program name", () => {
    const out = collectUniversitiesToCreate(
      [
        { universityName: "New Uni", name: "Program A", country: "Turkey" },
        { universityName: "Ghost Uni", name: "" }, // invalid row → no create
        { universityName: "Ghost Uni 2" }, // missing name → no create
        { universityName: "Known University", name: "Program B" }, // exists
      ],
      existing,
    );
    assert.deepEqual(out, [{ name: "New Uni", country: "Turkey" }]);
  });

  it("dedups case-insensitive + trim: 50 rows of one uni → 1 create", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      universityName: i % 2 ? "  avrasya university " : "Avrasya University",
      name: `Program ${i}`,
    }));
    const out = collectUniversitiesToCreate(rows, existing);
    assert.equal(out.length, 1);
    assert.equal(out[0].country, "Unknown"); // Country column absent → optional
  });

  it("rows with explicit universityId never trigger creation", () => {
    const out = collectUniversitiesToCreate(
      [{ universityId: 7, universityName: "Some New Name", name: "P" }],
      existing,
    );
    assert.deepEqual(out, []);
  });

  it("fully-invalid import (all rows missing program name) creates nothing", () => {
    const out = collectUniversitiesToCreate(
      [
        { universityName: "New Uni A" },
        { universityName: "New Uni B", name: "" },
      ],
      existing,
    );
    assert.deepEqual(out, []);
  });
});
