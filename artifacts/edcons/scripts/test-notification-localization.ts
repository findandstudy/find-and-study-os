import assert from "node:assert/strict";
import test from "node:test";
import { localizeNotification } from "../src/lib/notificationLocalization";

const notification = {
  type: "application.offer_letter_expiring",
  title: "Eski Türkçe başlık",
  body: "Eski Türkçe açıklama",
  data: {
    applicationId: 42,
    stage: "offer_letter",
    stageLabel: "Offer Letter",
    validUntil: "2026-08-09T00:00:00.000Z",
    daysLeft: 9,
    studentName: "TEST STUDENT",
    universityName: "Altinbas University",
    programName: "MBA",
  },
};

test("offer expiry follows the active UI language instead of stored Turkish", () => {
  const english = localizeNotification(notification, "en");
  const russian = localizeNotification(notification, "ru");
  assert.match(english.title, /Offer Letter expires in 9 days/);
  assert.doesNotMatch(english.title, /gün|geçerliliğini/);
  assert.match(russian.title, /Письмо о зачислении/);
  assert.match(russian.body || "", /TEST STUDENT/);
});

test("all native notification packs, including the seven new locales, produce localized offer text", () => {
  for (const lang of [
    "en", "tr", "ar", "fa", "fr", "es", "ru", "zh", "hi", "id",
    "bn", "pt", "ne", "vi", "ko", "uk", "it",
  ]) {
    const localized = localizeNotification(notification, lang);
    assert.ok(localized.title.length > 10, lang);
    assert.ok((localized.body || "").includes("TEST STUDENT"), lang);
  }
});

test("unrelated notifications remain untouched", () => {
  assert.deepEqual(
    localizeNotification({ type: "message.new", title: "Hello", body: "World" }, "tr"),
    { title: "Hello", body: "World" },
  );
});
