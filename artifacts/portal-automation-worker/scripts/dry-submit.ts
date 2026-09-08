// This legacy diagnostic must never inherit a live mutation mode from the
// surrounding shell. Real submissions go through the version-bound queue.
process.env.PORTAL_DRYRUN = "1";
process.env.SF_DRYRUN = "1";

import { adapterForUniversity } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const name = process.argv[2] || "Üsküdar Üniversitesi";
  const adapter: any = adapterForUniversity(name);
  if (!adapter) { console.log("NO ADAPTER for " + name); process.exit(1); }
  const creds = await resolvePortalCreds(adapter.key, adapter.key);
  const session: any = await adapter.login({ credentials: creds, headless: true });
  const profile: any = { firstName: "Mehmet", lastName: "Yilmaz", email: "fas.dry." + String(Date.now()).slice(-7) + "@example.com", passportNumber: "FAS" + String(Date.now()).slice(-7), dateOfBirth: "1995-01-01", gender: "Male", nationality: "Turkey", phone: "5551112233", address: "Istanbul", programName: "", programId: "", level: "" };
  const files: any = { passport: "/tmp/dummy.pdf", transcript: "/tmp/dummy.pdf", diploma: "/tmp/dummy.pdf", photo: "/tmp/dummy.jpg" };
  let res: any;
  try { res = await adapter.submit(session, profile, files); } catch (e: any) { res = { error: e.message }; }
  try { await session.close(); } catch (e) {}
  console.log("DRYRESULT " + JSON.stringify(res));
  process.exit(0);
})();
