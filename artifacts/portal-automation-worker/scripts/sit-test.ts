process.env.PORTAL_DRYRUN = "1";
process.env.SF_DRYRUN = "1";

import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const a: any = adapterByKey("sit");
  const creds = await resolvePortalCreds("sit", "sit");
  const s: any = await a.login({ credentials: creds, headless: true });
  const profile: any = { firstName: "ADONIYAS SEYDO", lastName: "HASSEN", email: "adoniyasseydo23@gmail.com", passportNumber: "EQ2287796", nationality: "Ethiopia", level: "Bachelor", programName: "Computer Engineering", universityName: "Istanbul", lastSchool: "", gpa: "" };
  const r = await a.submit(s, profile, {});
  console.log("SITTEST " + JSON.stringify(r));
  await s.close().catch(() => {});
  process.exit(0);
})();
