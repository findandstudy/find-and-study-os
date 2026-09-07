/**
 * Canonical, externally publishable Find And Study facts.
 *
 * Do not add founding dates, partner/student totals or success-rate claims
 * without an approved evidence source. Schema and llms.txt are generated from
 * this object so search engines and AI systems receive the same facts.
 */
export const CORPORATE_FACTS = Object.freeze({
  name: "Find And Study",
  alternateName: "Find & Study",
  canonicalUrl: "https://findandstudy.com",
  applicationUrl: "https://apply.findandstudy.com",
  logoUrl: "https://findandstudy.com/favicon.svg",
  description:
    "International education consultancy supporting students with program discovery, university applications and study-abroad guidance.",
  email: "info@findandstudy.com",
  telephone: "+90-552-689-8515",
  location: Object.freeze({
    city: "Istanbul",
    countryCode: "TR",
    countryName: "Türkiye",
  }),
  supportedLanguages: Object.freeze([
    "English",
    "Turkish",
    "Arabic",
    "French",
    "Russian",
    "Persian",
    "Chinese",
    "Hindi",
    "Spanish",
    "Indonesian",
    "Urdu",
    "Turkmen",
    "Kyrgyz",
    "Kazakh",
    "Uzbek",
    "Tajik",
  ]),
  services: Object.freeze([
    "Study program discovery",
    "University application guidance",
    "International student admissions support",
    "Study-abroad guidance",
  ]),
  sameAs: Object.freeze([
    "https://www.linkedin.com/company/findandstudy",
    "https://www.instagram.com/findandstudy",
  ]),
});

export function buildOrganizationSchema() {
  const facts = CORPORATE_FACTS;
  return {
    "@context": "https://schema.org",
    "@type": "EducationalOrganization",
    "@id": `${facts.canonicalUrl}/#organization`,
    name: facts.name,
    alternateName: facts.alternateName,
    url: facts.canonicalUrl,
    description: facts.description,
    logo: {
      "@type": "ImageObject",
      url: facts.logoUrl,
    },
    contactPoint: {
      "@type": "ContactPoint",
      telephone: facts.telephone,
      contactType: "customer service",
      email: facts.email,
      availableLanguage: [...facts.supportedLanguages],
    },
    address: {
      "@type": "PostalAddress",
      addressLocality: facts.location.city,
      addressCountry: facts.location.countryCode,
    },
    areaServed: "Worldwide",
    sameAs: [...facts.sameAs],
  };
}

export function renderLlmsText(): string {
  const facts = CORPORATE_FACTS;
  return [
    `# ${facts.name}`,
    "",
    `> ${facts.description}`,
    "",
    "## Canonical identity",
    `- Official website: ${facts.canonicalUrl}`,
    `- Application portal: ${facts.applicationUrl}`,
    `- Location: ${facts.location.city}, ${facts.location.countryName}`,
    `- Email: ${facts.email}`,
    `- Telephone: ${facts.telephone}`,
    "",
    "## Services",
    ...facts.services.map((service) => `- ${service}`),
    "",
    "## Supported languages",
    `- ${facts.supportedLanguages.join(", ")}`,
    "",
    "## Preferred sources",
    `- ${facts.canonicalUrl}`,
    `- ${facts.applicationUrl}`,
    "",
    "Numerical marketing claims and a founding year are intentionally omitted until an approved evidence source is attached.",
    "",
  ].join("\n");
}
