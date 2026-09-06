import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { detectUploadedFileType } from "./fileUploadValidation";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "./objectStorage";

export const SOCIAL_MEDIA_MAX_ASSETS = 10;
export const SOCIAL_MEDIA_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const SOCIAL_MEDIA_VIDEO_MAX_BYTES = 25 * 1024 * 1024;

type SocialMediaKind = "image" | "video";

type SocialMediaRule = {
  kind: SocialMediaKind;
  extensions: readonly string[];
  maxBytes: number;
  permanentExtension: ".jpg" | ".png" | ".webp" | ".mp4";
};

const RULES: Record<string, SocialMediaRule> = {
  "image/jpeg": {
    kind: "image",
    extensions: [".jpg", ".jpeg"],
    maxBytes: SOCIAL_MEDIA_IMAGE_MAX_BYTES,
    permanentExtension: ".jpg",
  },
  "image/png": {
    kind: "image",
    extensions: [".png"],
    maxBytes: SOCIAL_MEDIA_IMAGE_MAX_BYTES,
    permanentExtension: ".png",
  },
  "image/webp": {
    kind: "image",
    extensions: [".webp"],
    maxBytes: SOCIAL_MEDIA_IMAGE_MAX_BYTES,
    permanentExtension: ".webp",
  },
  "video/mp4": {
    kind: "video",
    extensions: [".mp4"],
    maxBytes: SOCIAL_MEDIA_VIDEO_MAX_BYTES,
    permanentExtension: ".mp4",
  },
};

export type SocialMediaMetadata = {
  kind: SocialMediaKind;
  mimeType: keyof typeof RULES;
  sizeBytes: number;
  permanentExtension: SocialMediaRule["permanentExtension"];
};

export type SocialMediaRef = { kind: SocialMediaKind; ref: string };

export function socialMediaSyntheticFileName(mimeType: string): string {
  const rule = RULES[mimeType.trim().toLowerCase()];
  if (!rule) throw new Error("SOCIAL_MEDIA_TYPE_INVALID");
  return `upload${rule.extensions[0]}`;
}

export function validateSocialMediaMetadata(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): SocialMediaMetadata {
  const mimeType = input.mimeType.trim().toLowerCase();
  const rule = RULES[mimeType];
  const extension = nodePath.extname(input.fileName).toLowerCase();
  if (!rule || !rule.extensions.includes(extension))
    throw new Error("SOCIAL_MEDIA_TYPE_INVALID");
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > rule.maxBytes
  )
    throw new Error("SOCIAL_MEDIA_SIZE_INVALID");
  return {
    kind: rule.kind,
    mimeType,
    sizeBytes: input.sizeBytes,
    permanentExtension: rule.permanentExtension,
  };
}

export async function validateSocialMediaBuffer(input: {
  fileName: string;
  mimeType: string;
  buffer: Buffer | Uint8Array;
}): Promise<SocialMediaMetadata & { sha256: string }> {
  const metadata = validateSocialMediaMetadata({
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.byteLength,
  });
  const detected = await detectUploadedFileType(input.buffer);
  if (!detected || detected.mime !== metadata.mimeType)
    throw new Error("SOCIAL_MEDIA_CONTENT_MISMATCH");
  return {
    ...metadata,
    sha256: createHash("sha256").update(input.buffer).digest("hex"),
  };
}

export function assertSocialContentMedia(
  contentKind: string,
  mediaRefs: SocialMediaRef[],
): void {
  if (mediaRefs.length > SOCIAL_MEDIA_MAX_ASSETS)
    throw new Error("SOCIAL_MEDIA_ASSET_LIMIT_EXCEEDED");
  for (const media of mediaRefs) {
    if (
      (media.kind !== "image" && media.kind !== "video") ||
      !/^\/objects\/social-media\/assets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(?:jpg|png|webp|mp4)$/.test(
        media.ref,
      )
    )
      throw new Error("SOCIAL_MEDIA_REFERENCE_INVALID");
  }
  const videos = mediaRefs.filter((media) => media.kind === "video").length;
  const images = mediaRefs.length - videos;
  if (["REEL", "VIDEO"].includes(contentKind)) {
    if (videos !== 1 || images !== 0)
      throw new Error("SOCIAL_MEDIA_VIDEO_REQUIRED");
    return;
  }
  if (contentKind === "STORY") {
    if (mediaRefs.length === 0 || (videos > 0 && mediaRefs.length !== 1))
      throw new Error("SOCIAL_MEDIA_STORY_ASSET_INVALID");
    return;
  }
  if (contentKind === "AD_CREATIVE" && mediaRefs.length === 0)
    throw new Error("SOCIAL_MEDIA_ASSET_REQUIRED");
}

export async function verifyStoredSocialMediaRefs(
  mediaRefs: SocialMediaRef[],
  storage = new ObjectStorageService(),
): Promise<void> {
  for (const media of mediaRefs) {
    const match = /\/([0-9a-f]{64})\.(jpg|png|webp|mp4)$/.exec(media.ref);
    if (!match) throw new Error("SOCIAL_MEDIA_REFERENCE_INVALID");
    let object;
    try {
      object = await storage.getObjectEntityFile(media.ref);
    } catch (error) {
      if (error instanceof ObjectNotFoundError)
        throw new Error("SOCIAL_MEDIA_OBJECT_MISSING");
      throw error;
    }
    const [metadata] = await object.getMetadata();
    const mimeType = String(metadata.contentType ?? "").toLowerCase();
    const sizeBytes = Number(metadata.size);
    const verifiedMetadata = validateSocialMediaMetadata({
      fileName: `asset.${match[2]}`,
      mimeType,
      sizeBytes,
    });
    if (verifiedMetadata.kind !== media.kind)
      throw new Error("SOCIAL_MEDIA_METADATA_MISMATCH");
    const hash = createHash("sha256");
    let observedBytes = 0;
    for await (const chunk of object.createReadStream()) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observedBytes += bytes.length;
      if (observedBytes > verifiedMetadata.sizeBytes)
        throw new Error("SOCIAL_MEDIA_SIZE_MISMATCH");
      hash.update(bytes);
    }
    if (
      observedBytes !== verifiedMetadata.sizeBytes ||
      hash.digest("hex") !== match[1]
    )
      throw new Error("SOCIAL_MEDIA_CONTENT_MISMATCH");
  }
}
