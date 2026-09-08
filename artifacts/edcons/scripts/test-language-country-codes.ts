import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LANGUAGE_COUNTRY_CODES,
  SUPPORTED_LANGUAGES,
} from "../src/lib/i18n/index.js";

test("every supported language has its canonical flag country", () => {
  assert.deepEqual(LANGUAGE_COUNTRY_CODES, {
    en: "GB",
    tr: "TR",
    ar: "SA",
    fr: "FR",
    ru: "RU",
    fa: "IR",
    zh: "CN",
    hi: "IN",
    es: "ES",
    id: "ID",
    ur: "PK",
    tk: "TM",
    ky: "KG",
    kk: "KZ",
    uz: "UZ",
    tg: "TJ",
    bn: "BD",
    pt: "PT",
    ne: "NP",
    vi: "VN",
    ko: "KR",
    uk: "UA",
    it: "IT",
  });
  assert.deepEqual(Object.keys(LANGUAGE_COUNTRY_CODES), [...SUPPORTED_LANGUAGES]);
});

test("the public language selector uses the canonical mapping without a GB fallback", () => {
  const layout = readFileSync(
    new URL("../src/components/layout/PublicLayout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(layout, /LANGUAGE_COUNTRY_CODES\[lang\]/);
  assert.match(layout, /LANGUAGE_COUNTRY_CODES\[code\]/);
  assert.doesNotMatch(layout, /\bLANG_COUNTRY\b/);
  assert.doesNotMatch(layout, /\|\|\s*["']GB["']/);
});
