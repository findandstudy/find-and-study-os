import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applicationCreationErrorMessage,
  applicationCreationErrorPresentation,
} from "../src/lib/applicationCreationError";

test("portal preflight explains fields, invalid values and documents", () => {
  const error = new Error(JSON.stringify({
    code: "PORTAL_PREFLIGHT_NOT_READY",
    missingFieldLabels: ["Residence city"],
    incompatibleFieldLabels: ["Passport number"],
    missingDocumentLabels: ["Photograph", "Diploma"],
  }));
  assert.equal(
    applicationCreationErrorMessage(error),
    "Complete these items before portal submission: Residence city, Passport number (invalid), Photograph, Diploma.",
  );
});

test("generated-client response body is understood", () => {
  assert.equal(
    applicationCreationErrorMessage({
      data: {
        code: "STUDENT_DOCS_REQUIRED",
        missingDocLabels: ["Passport", "Transcript"],
      },
    }),
    "Missing required documents: Passport, Transcript.",
  );
});

test("plain API errors remain readable", () => {
  assert.equal(
    applicationCreationErrorMessage(new Error("Program quota is full")),
    "Program quota is full",
  );
});

test("missing documents produce a scannable and actionable presentation", () => {
  assert.deepEqual(
    applicationCreationErrorPresentation({
      data: {
        code: "STUDENT_DOCS_REQUIRED",
        missingDocLabels: ["Diploma Certificate", "Passport", "Photograph"],
      },
    }),
    {
      title: "Required documents are missing",
      intro: "Upload the following documents before creating the application:",
      items: ["Diploma Certificate", "Passport", "Photograph"],
      guidance: "Open the Documents tab, upload the files, then try again.",
    },
  );
});

test("missing profile fields are converted to readable labels", () => {
  assert.deepEqual(
    applicationCreationErrorPresentation({
      data: { missingFields: ["firstName", "passportNumber", "custom_field"] },
    }).items,
    ["First name", "Passport number", "Custom field"],
  );
});

test("application warning contract keeps a visible close button and 30 second duration", () => {
  const toastSource = readFileSync(
    new URL("../src/components/ui/toast.tsx", import.meta.url),
    "utf8",
  );
  const applicationToastSource = readFileSync(
    new URL("../src/components/ApplicationCreationErrorToast.tsx", import.meta.url),
    "utf8",
  );
  const toastHookSource = readFileSync(
    new URL("../src/hooks/use-toast.ts", import.meta.url),
    "utf8",
  );
  assert.match(toastSource, /aria-label="Close notification"/);
  assert.match(toastSource, /opacity-100/);
  assert.doesNotMatch(toastSource, /group-hover:opacity-100/);
  assert.match(applicationToastSource, /APPLICATION_CREATION_ERROR_TOAST_DURATION_MS = 30_000/);
  assert.match(applicationToastSource, /disappear automatically in 30 seconds/);
  assert.match(toastHookSource, /setTimeout\(dismiss, props\.duration\)/);
  assert.match(toastHookSource, /clearAutoDismissTimeout\(id\)/);
});
