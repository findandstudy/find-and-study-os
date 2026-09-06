import {
  validateStudentDocumentFile,
  validateUploadedFileBuffer,
  type BufferValidationError,
} from "@workspace/file-upload-validation";

export {
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  PDF_MAX_SIZE,
  IMAGE_MAX_SIZE,
  OFFICE_MAX_SIZE,
  PDF_MAX_SIZE_MB,
  IMAGE_MAX_SIZE_MB,
  OFFICE_MAX_SIZE_MB,
  FILE_UPLOAD_HELP_TEXT,
  APPLICATION_DOCUMENT_MAX_SIZE,
  APPLICATION_DOCUMENT_MAX_SIZE_MB,
  APPLICATION_DOCUMENT_ACCEPT_ATTRIBUTE,
  APPLICATION_DOCUMENT_HELP_TEXT,
  getExtension,
  isAllowedMimeType,
  isAllowedExtension,
  isPdf,
  isImage,
  isOffice,
  getMaxSizeForType,
  getMaxSizeLabelForType,
  sanitizeFileName,
  validateUploadedFile,
  validateApplicationDocumentFile,
  validateStudentDocumentFile,
  validateUploadedFileBuffer,
  detectUploadedFileType,
  validateFile,
} from "@workspace/file-upload-validation";

export type {
  FileValidationError,
  BufferValidationError,
  FileValidationResult,
} from "@workspace/file-upload-validation";

export type StudentDocumentContentError = BufferValidationError | {
  type: "unreadable_file";
  message: string;
};

/** Validate actual document bytes, not only client-provided metadata. */
export async function validateStudentDocumentBuffer(
  documentType: string,
  fileName: string,
  mimeType: string,
  buffer: Buffer,
): Promise<StudentDocumentContentError | null> {
  const policyError = validateStudentDocumentFile(documentType, fileName, mimeType, buffer.length);
  if (policyError) return policyError;

  const signatureError = await validateUploadedFileBuffer(fileName, mimeType, buffer);
  if (signatureError) return signatureError;

  try {
    if (mimeType === "application/pdf") {
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.load(buffer, { ignoreEncryption: false, updateMetadata: false });
      if (pdf.getPageCount() < 1) throw new Error("PDF has no pages");
    } else {
      const sharp = (await import("sharp")).default;
      const metadata = await sharp(buffer, { failOn: "error" }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("Image has no dimensions");
    }
  } catch {
    return {
      type: "unreadable_file",
      message: mimeType === "application/pdf"
        ? "PDF okunam\u0131yor, bozuk veya \u015fifreli. L\u00fctfen \u015fifresiz ve ge\u00e7erli bir PDF y\u00fcleyin."
        : "G\u00f6rsel okunam\u0131yor veya bozuk. L\u00fctfen ge\u00e7erli bir JPG, JPEG ya da PNG y\u00fcleyin.",
    };
  }

  return null;
}
