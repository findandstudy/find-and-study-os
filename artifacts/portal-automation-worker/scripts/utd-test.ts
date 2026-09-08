process.env.PORTAL_DRYRUN = "1";
process.env.SF_DRYRUN = "1";

import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const a: any = adapterByKey("united");
  const creds = await resolvePortalCreds("united", "united");
  const s: any = await a.login({ credentials: creds, headless: true });
  const profile: any = { firstName: "Test", lastName: "Applicant", email: "x@example.com", passportNumber: "U1234567", nationality: "Turkey", level: "Bachelor", programName: "Computer", universityName: "Istanbul", lastSchool: "", gpa: "" };
  const r = await a.submit(s, profile, {});
  console.log("UTDTEST " + JSON.stringify(r));
  await s.close().catch(() => {});
  process.exit(0);
})();
