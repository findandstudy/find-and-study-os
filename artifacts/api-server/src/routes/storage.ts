import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAuth } from "../lib/auth";
import {
  callerOwnsObject,
  canAccessGenericObject,
  canonicalizeKey,
  recordObjectOwner,
} from "../lib/objectAuthz";
import { checkAndIncrementRateLimit } from "../lib/pgRateLimiter";
import { validateApplicationDocumentFile, validateUploadedFile } from "../lib/fileUploadValidation";
import { processUpload, UploadTooLargeError } from "../lib/uploads/processUpload";
import {
  socialMediaSyntheticFileName,
  validateSocialMediaBuffer,
} from "../lib/socialMediaAssets";
import { agentsTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";

const RequestUploadUrlBody = z.object({
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
  prefix: z.string().regex(/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*\/?$/).max(120).optional(),
});

const RequestUploadUrlResponse = z.object({
  uploadURL: z.string(),
  objectPath: z.string(),
  metadata: z.object({
    name: z.string(),
    size: z.number(),
    contentType: z.string(),
  }),
});

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const UPLOAD_LIMIT = 30;
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const LOCAL_UPLOAD_ABSOLUTE_MAX_BYTES = 25 * 1024 * 1024;

const INBOX_MEDIA_RULES: Record<string, { extensions: Set<string>; maxBytes: number }> = {
  "image/jpeg": { extensions: new Set(["jpg", "jpeg"]), maxBytes: 5 * 1024 * 1024 },
  "image/png": { extensions: new Set(["png"]), maxBytes: 5 * 1024 * 1024 },
  "video/mp4": { extensions: new Set(["mp4"]), maxBytes: 16 * 1024 * 1024 },
  "video/3gpp": { extensions: new Set(["3gp", "3gpp"]), maxBytes: 16 * 1024 * 1024 },
  "audio/mpeg": { extensions: new Set(["mp3"]), maxBytes: 16 * 1024 * 1024 },
  "audio/ogg": { extensions: new Set(["ogg", "opus"]), maxBytes: 16 * 1024 * 1024 },
  "audio/webm": { extensions: new Set(["webm"]), maxBytes: 16 * 1024 * 1024 },
  "audio/amr": { extensions: new Set(["amr"]), maxBytes: 16 * 1024 * 1024 },
  "audio/aac": { extensions: new Set(["aac"]), maxBytes: 16 * 1024 * 1024 },
  "audio/mp4": { extensions: new Set(["m4a"]), maxBytes: 16 * 1024 * 1024 },
};

const EMBED_LOGO_RULES: Record<string, Set<string>> = {
  "image/jpeg": new Set(["jpg", "jpeg"]),
  "image/png": new Set(["png"]),
  "image/webp": new Set(["webp"]),
};
const EMBED_LOGO_MAX_BYTES = 5 * 1024 * 1024;

async function isProvisionalAgentUser(userId: number): Promise<boolean> {
  const [agent] = await db
    .select({ accessTier: agentsTable.accessTier })
    .from(agentsTable)
    .where(eq(agentsTable.userId, userId))
    .limit(1);
  return !!agent && agent.accessTier !== "full";
}

router.post("/storage/uploads/request-url", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const allowed = await checkAndIncrementRateLimit(`upload:${userId}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS);
  if (!allowed) {
    res.status(429).json({ error: "Too many upload requests. Try again later." });
    return;
  }

  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType, prefix } = parsed.data;

    // Provisional applicants only need storage for the contract/onboarding
    // evidence shown in their limited portal. Do not let the generic upload
    // endpoint become a bypass around the provisional API gate.
    if (await isProvisionalAgentUser(userId)) {
      const isAgentOnboardingUpload = prefix === "agent-onboarding"
        || prefix?.startsWith("agent-onboarding/");
      if (!isAgentOnboardingUpload) {
        res.status(403).json({ error: "Only agency onboarding uploads are available before approval" });
        return;
      }
    }

    // Staff document uploads use STAFF_DOC_RULES (PDF/DOC/DOCX/JPG/PNG, up
    // to 25MB) — admin-only, gated by prefix `staff-documents/{userId}/`.
    // Generic uploads still go through the global validateUploadedFile policy.
    const isStaffDoc = !!prefix && /^staff-documents\/\d+\/?$/.test(prefix);
    const isStudentDocument = prefix === "student-documents" || prefix?.startsWith("student-documents/");
    const isInboxUpload = prefix === "inbox" || prefix?.startsWith("inbox/");
    const isEmbedLogo = prefix === "branding/embed-widget";
    if (isStudentDocument) {
      const validationError = validateApplicationDocumentFile(name, contentType, size);
      if (validationError) {
        res.status(validationError.type === "size_exceeded" ? 413 : 400).json({ error: validationError.message });
        return;
      }
    } else if (isStaffDoc) {
      const role = (req.user as { role?: string } | undefined)?.role;
      if (role !== "super_admin" && role !== "admin") {
        res.status(403).json({ error: "Staff document uploads are admin-only" });
        return;
      }
      const STAFF_DOC_MIMES = new Set([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/jpeg",
        "image/png",
      ]);
      const STAFF_DOC_MAX = 25 * 1024 * 1024;
      if (!STAFF_DOC_MIMES.has(contentType)) {
        res.status(400).json({ error: "Unsupported file type for staff documents" });
        return;
      }
      if (size > STAFF_DOC_MAX) {
        res.status(413).json({ error: "Dosya boyutu 25MB sınırını aşıyor." });
        return;
      }
    } else if (isEmbedLogo) {
      const role = (req.user as { role?: string } | undefined)?.role;
      if (role !== "super_admin" && role !== "admin") {
        res.status(403).json({ error: "Embed branding uploads are admin-only" });
        return;
      }
      const normalizedContentType = contentType.toLowerCase();
      const extensions = EMBED_LOGO_RULES[normalizedContentType];
      const extension = nodePath.extname(name).slice(1).toLowerCase();
      if (!extensions || !extension || !extensions.has(extension)) {
        res.status(400).json({ error: "Logo must be a PNG, JPG or WebP image" });
        return;
      }
      if (size <= 0 || size > EMBED_LOGO_MAX_BYTES) {
        res.status(413).json({ error: "Logo must be smaller than 5 MB" });
        return;
      }
    } else if (isInboxUpload && INBOX_MEDIA_RULES[contentType.toLowerCase()]) {
      const normalizedContentType = contentType.toLowerCase();
      const rule = INBOX_MEDIA_RULES[normalizedContentType];
      const extension = nodePath.extname(name).slice(1).toLowerCase();
      if (!extension || !rule.extensions.has(extension)) {
        res.status(400).json({ error: "File extension does not match the selected inbox media type" });
        return;
      }
      if (size <= 0 || size > rule.maxBytes) {
        res.status(413).json({
          error: `Inbox media exceeds the ${Math.round(rule.maxBytes / (1024 * 1024))}MB limit`,
        });
        return;
      }
    } else {
      const validationError = validateUploadedFile(name, contentType, size);
      if (validationError) {
        const httpStatus = validationError.type === "size_exceeded" ? 413 : 400;
        res.status(httpStatus).json({ error: validationError.message });
        return;
      }
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL(prefix);
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    // Bind the object to its uploader so the generic download endpoint can
    // authorize access without trusting self-writable reference fields.
    const ownerRecorded = await recordObjectOwner(objectPath, userId);
    if (!ownerRecorded) {
      res.status(503).json({ error: "Upload authorization could not be established" });
      return;
    }

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    console.error("Error generating upload URL:", error);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// ── Local-driver upload handler ───────────────────────────────────────────────
// Only active when STORAGE_DRIVER=local. The client PUTs file bytes directly
// to this endpoint (same contract as a GCS signed-URL PUT). The :encoded
// segment is the base64url of the relative path inside STORAGE_LOCAL_DIR.

router.put("/storage/local-upload/:encoded", requireAuth, async (req: Request, res: Response) => {
  if ((process.env.STORAGE_DRIVER ?? "replit") !== "local") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const rawEncoded = req.params["encoded"];
  const encoded = Array.isArray(rawEncoded) ? rawEncoded[0] : rawEncoded;
  let relPath: string;
  try {
    relPath = Buffer.from(encoded, "base64url").toString();
  } catch {
    res.status(400).json({ error: "Invalid upload token" });
    return;
  }

  if (relPath.includes("..") || relPath.includes("\\") || relPath.startsWith("/")) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  if (await isProvisionalAgentUser(req.user!.id) && !relPath.startsWith("agent-onboarding/")) {
    res.status(403).json({ error: "Only agency onboarding uploads are available before approval" });
    return;
  }

  const localDir = process.env.STORAGE_LOCAL_DIR ?? "";
  if (!localDir) {
    res.status(500).json({ error: "STORAGE_LOCAL_DIR not configured" });
    return;
  }

  const localPath = nodePath.join(localDir, relPath);

  // Guard against path traversal after join
  if (!localPath.startsWith(localDir + nodePath.sep) && localPath !== localDir) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  // The upload URL is only an encoded storage path, not a secret. Require the
  // authenticated caller to be the user who requested that path so leaked or
  // guessed URLs cannot overwrite another user's private object.
  const userId = req.user!.id;
  if (!(await callerOwnsObject(userId, relPath))) {
    res.status(403).json({ error: "Upload target is not owned by the current user" });
    return;
  }

  const contentLengthHeader = req.headers["content-length"];
  const contentLength = typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : Number.NaN;
  if (Number.isFinite(contentLength) && contentLength > LOCAL_UPLOAD_ABSOLUTE_MAX_BYTES) {
    res.status(413).json({ error: "Upload exceeds the 25MB absolute limit" });
    return;
  }

  try {
    await fsPromises.mkdir(nodePath.dirname(localPath), { recursive: true });

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      receivedBytes += buffer.length;
      if (receivedBytes > LOCAL_UPLOAD_ABSOLUTE_MAX_BYTES) {
        res.status(413).json({ error: "Upload exceeds the 25MB absolute limit" });
        return;
      }
      chunks.push(buffer);
    }
    const rawBody = Buffer.concat(chunks);
    const contentType = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();

    // Single chokepoint: any file above the portal-ready target is
    // compressed here before it ever touches disk, so everything downstream
    // (portal adapters, /api/documents/:id/file) sees an already-small file.
    let body: Buffer = rawBody;
    let finalContentType = contentType;
    const localInboxMediaRule = INBOX_MEDIA_RULES[contentType.toLowerCase()];
    const isSocialMediaUpload = relPath.startsWith("social-media/staging/");
    const isAudioOrVideo = contentType.startsWith("audio/") || contentType.startsWith("video/");
    if (isAudioOrVideo && !localInboxMediaRule && !isSocialMediaUpload) {
      res.status(400).json({ error: "Unsupported inbox media type" });
      return;
    }
    if (!isSocialMediaUpload && localInboxMediaRule && rawBody.length > localInboxMediaRule.maxBytes) {
      res.status(413).json({
        error: `Inbox media exceeds the ${Math.round(localInboxMediaRule.maxBytes / (1024 * 1024))}MB limit`,
      });
      return;
    }

    // Inbox audio/video is already constrained by the exact MIME allowlist
    // above. Passing it through the document compressor would apply the
    // unrelated 15MB document cap and reject otherwise valid WhatsApp media.
    if (isSocialMediaUpload) {
      try {
        await validateSocialMediaBuffer({
          fileName: socialMediaSyntheticFileName(contentType),
          mimeType: contentType,
          buffer: rawBody,
        });
      } catch {
        res.status(400).json({ error: "Social media file content is invalid" });
        return;
      }
    } else if (!isAudioOrVideo) {
      try {
        const processed = await processUpload(rawBody, nodePath.basename(relPath), contentType);
        body = Buffer.from(processed.buffer);
        finalContentType = processed.mime;
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          res.status(413).json({ error: err.message });
          return;
        }
        console.error("[local-upload] processUpload rejected upload:", err);
        res.status(400).json({ error: "Uploaded file could not be processed" });
        return;
      }
    }

    await fsPromises.writeFile(localPath, body);
    await fsPromises.writeFile(`${localPath}.ct`, finalContentType);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[local-upload] write failed:", error);
    res.status(500).json({ error: "Failed to store file" });
  }
});

// Historical inbox rows still reference /storage/public-objects/* even though
// the underlying objects were never public. Keep the route as a compatibility
// alias, but enforce the exact same session and object-level authorization as
// /storage/objects/*. Truly public branding has its own narrow route below.
router.get("/storage/public-objects/*filePath", requireAuth, async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;

    if (filePath.includes("..") || filePath.includes("\\")) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    const objectKey = canonicalizeKey(filePath);
    if (!objectKey) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    const allowed = await canAccessGenericObject(
      { id: req.user!.id, role: (req.user as { role?: string }).role ?? "" },
      objectKey,
    );
    if (!allowed) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(`/objects/${objectKey}`);
    await objectStorageService.streamObjectToResponse(req, res, objectFile);
  } catch (error) {
    console.error("Error serving legacy object URL:", error);
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    res.status(500).json({ error: "Failed to serve object" });
  }
});

// Logos uploaded for public embed widgets must be readable by visitors who do
// not have a CRM session. Keep this route deliberately narrow: it can expose
// only objects written under branding/embed-widget/.
router.get("/storage/public-branding/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;

    if (
      !filePath.startsWith("embed-widget/") ||
      filePath.includes("..") ||
      filePath.includes("\\")
    ) {
      res.status(400).json({ error: "Invalid branding path" });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(
      `/objects/branding/${filePath}`,
    );
    const [metadata] = await objectFile.getMetadata();
    const contentType = metadata.contentType ?? "";
    if (!EMBED_LOGO_RULES[contentType.toLowerCase()]) {
      res.status(415).json({ error: "Branding asset is not a supported image" });
      return;
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    await objectStorageService.streamObjectToResponse(req, res, objectFile, {
      cacheControl: "public, max-age=86400, immutable",
    });
  } catch (error) {
    console.error("Error serving public embed branding:", error);
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.status(500).json({ error: "Failed to serve branding asset" });
  }
});

router.get("/storage/objects/*path", requireAuth, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;

    if (wildcardPath.includes("..") || wildcardPath.includes("\\")) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    // Branding assets (branding/ prefix) are tenant-wide shared objects written
    // only by admins. Any authenticated user may access them without a per-object
    // IDOR check. All other objects still go through the full IDOR guard.
    const isBrandingAsset = wildcardPath.startsWith("branding/") || wildcardPath.startsWith("logo/");
    if (!isBrandingAsset) {
      const allowed = await canAccessGenericObject(
        { id: req.user!.id, role: (req.user as { role?: string }).role ?? "" },
        wildcardPath,
      );
      if (!allowed) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
    }

    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const downloadName = req.query.download as string | undefined;
    if (downloadName) {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadName)}"`);
    }

    await objectStorageService.streamObjectToResponse(req, res, objectFile);
  } catch (error) {
    console.error("Error serving object:", error);
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
