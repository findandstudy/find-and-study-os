type ApiErrorShape = {
  error?: string;
  code?: string;
  eligibilityErrors?: string[];
  missingFields?: string[];
  missingFieldLabels?: string[];
  incompatibleFieldLabels?: string[];
  missingDocuments?: string[];
  missingDocumentLabels?: string[];
  missingDocTypes?: string[];
  missingDocLabels?: string[];
};

export type ApplicationCreationErrorPresentation = {
  title: string;
  intro: string;
  items: string[];
  guidance?: string;
};

const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email address",
  phone: "Phone number",
  nationality: "Nationality",
  passportNumber: "Passport number",
};

function parseBody(value: unknown): ApiErrorShape | null {
  if (value && typeof value === "object") return value as ApiErrorShape;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as ApiErrorShape : null;
  } catch {
    return null;
  }
}

function list(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

function fieldLabel(value: string): string {
  return FIELD_LABELS[value]
    ?? value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/^\w/, (letter) => letter.toUpperCase());
}

function errorBody(error: unknown): { body: ApiErrorShape | null; rawMessage: string } {
  const candidate = error as {
    data?: unknown;
    body?: unknown;
    message?: unknown;
  } | null;
  const rawMessage = typeof candidate?.message === "string"
    ? candidate.message
    : "";
  return {
    body: parseBody(candidate?.data)
      ?? parseBody(candidate?.body)
      ?? parseBody(rawMessage),
    rawMessage,
  };
}

export function applicationCreationErrorPresentation(
  error: unknown,
  fallback = "Failed to create application.",
): ApplicationCreationErrorPresentation {
  const { body, rawMessage } = errorBody(error);
  if (!body) {
    return {
      title: "Application could not be created",
      intro: rawMessage || fallback,
      items: [],
      guidance: "Review the application details and try again.",
    };
  }

  if (body.code === "PORTAL_PREFLIGHT_NOT_READY") {
    const items = [
      ...list(body.missingFieldLabels),
      ...list(body.incompatibleFieldLabels).map((label) => `${label} (invalid)`),
      ...list(body.missingDocumentLabels),
    ];
    if (items.length > 0) {
      return {
        title: "Application is not ready",
        intro: "Complete or correct the following items before submitting:",
        items,
        guidance: "Save the changes, then try creating the application again.",
      };
    }
  }

  const documentLabels = list(body.missingDocLabels);
  if (documentLabels.length > 0) {
    return {
      title: "Required documents are missing",
      intro: "Upload the following documents before creating the application:",
      items: documentLabels,
      guidance: "Open the Documents tab, upload the files, then try again.",
    };
  }

  const missingFields = list(body.missingFields).map(fieldLabel);
  if (missingFields.length > 0) {
    return {
      title: "Student profile is incomplete",
      intro: "Complete the following student information:",
      items: missingFields,
      guidance: "Update the student profile, save it, then try again.",
    };
  }

  const eligibilityErrors = list(body.eligibilityErrors);
  if (body.code === "ELIGIBILITY_FAILED" && eligibilityErrors.length > 0) {
    return {
      title: "Eligibility requirements are not met",
      intro: "Review the following requirements:",
      items: eligibilityErrors,
      guidance: "Correct the application data or select another suitable program.",
    };
  }

  if (body.code === "QUOTA_FULL") {
    return {
      title: "Program quota is full",
      intro: body.error || "This program is not accepting more applications for the selected intake.",
      items: [],
      guidance: "Choose another intake or program and try again.",
    };
  }

  return {
    title: "Application could not be created",
    intro: body.error || rawMessage || fallback,
    items: [],
    guidance: "Review the application details and try again.",
  };
}

/**
 * Normalizes fetch, generated-client and plain Error responses so every
 * application entry point explains exactly what staff must complete.
 */
export function applicationCreationErrorMessage(
  error: unknown,
  fallback = "Failed to create application.",
): string {
  const { body, rawMessage } = errorBody(error);
  if (!body) return rawMessage || fallback;

  if (body.code === "PORTAL_PREFLIGHT_NOT_READY") {
    const unresolved = [
      ...list(body.missingFieldLabels),
      ...list(body.incompatibleFieldLabels).map((label) => `${label} (invalid)`),
      ...list(body.missingDocumentLabels),
    ];
    if (unresolved.length > 0) {
      return `Complete these items before portal submission: ${unresolved.join(", ")}.`;
    }
  }

  const docLabels = list(body.missingDocLabels);
  if (docLabels.length > 0) {
    return `Missing required documents: ${docLabels.join(", ")}.`;
  }
  const missingFields = list(body.missingFields);
  if (missingFields.length > 0) {
    return `Student is missing required fields: ${missingFields.join(", ")}.`;
  }
  return body.error || rawMessage || fallback;
}
