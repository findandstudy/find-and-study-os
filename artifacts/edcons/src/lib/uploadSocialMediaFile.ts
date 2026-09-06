import { apiFetch } from "./apiFetch";

const BASE_URL = import.meta.env?.BASE_URL?.replace(/\/$/, "") || "";

export type SocialMediaAsset = {
  id: string;
  object_path: string;
  media_kind: "image" | "video";
  mime_type: string;
  size_bytes: number;
  original_file_name: string;
  created_at: string;
};

const RULES: Record<string, { extensions: string[]; maxBytes: number }> = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], maxBytes: 15 * 1024 * 1024 },
  "image/png": { extensions: [".png"], maxBytes: 15 * 1024 * 1024 },
  "image/webp": { extensions: [".webp"], maxBytes: 15 * 1024 * 1024 },
  "video/mp4": { extensions: [".mp4"], maxBytes: 25 * 1024 * 1024 },
};

function validate(file: File): void {
  const rule = RULES[file.type.toLowerCase()];
  const name = file.name.toLowerCase();
  if (!rule || !rule.extensions.some((extension) => name.endsWith(extension)))
    throw new Error("Only JPG, PNG, WebP or MP4 files are supported");
  if (file.size <= 0 || file.size > rule.maxBytes)
    throw new Error(
      file.type.startsWith("video/")
        ? "Videos must be 25 MB or smaller"
        : "Images must be 15 MB or smaller",
    );
}

async function errorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error || fallback;
}

export async function uploadSocialMediaFile(
  file: File,
  requestKey: string,
): Promise<SocialMediaAsset> {
  validate(file);
  const request = await apiFetch(
    `${BASE_URL}/api/social/media/uploads/request-url`,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type,
      }),
    },
  );
  if (!request.ok)
    throw new Error(
      await errorMessage(request, "Social media upload could not be prepared"),
    );
  const prepared = (await request.json()) as {
    uploadURL?: string;
    objectPath?: string;
  };
  if (!prepared.uploadURL || !prepared.objectPath)
    throw new Error(
      "Social media upload preparation returned an invalid response",
    );

  const upload = await fetch(prepared.uploadURL, {
    method: "PUT",
    redirect: "error",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!upload.ok)
    throw new Error(await errorMessage(upload, "Social media upload failed"));

  const registration = await apiFetch(`${BASE_URL}/api/social/media`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestKey,
      objectPath: prepared.objectPath,
      originalFileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    }),
  });
  if (!registration.ok)
    throw new Error(
      await errorMessage(
        registration,
        "Social media asset could not be registered",
      ),
    );
  return (await registration.json()) as SocialMediaAsset;
}
