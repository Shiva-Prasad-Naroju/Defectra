/**
 * HEIC/HEIF → JPEG normalization for browsers.
 * Browsers cannot decode HEIC for <img> or canvas; conversion is required before preview/API upload.
 */

/** Skip conversion above this size (bytes) to avoid freezing very low-memory tabs. */
export const MAX_HEIC_SOURCE_BYTES = 90 * 1024 * 1024;

const HEIC_EXT = /\.(heic|heif)$/i;

/**
 * @param {File | Blob} file
 * @returns {boolean}
 */
export function isHeicLike(file) {
  if (!file) return false;
  const t = String(file.type || "").toLowerCase();
  if (t === "image/heic" || t === "image/heif") return true;
  if (t.includes("heic") || t.includes("heif")) return true;
  const name = "name" in file ? String(file.name || "") : "";
  return HEIC_EXT.test(name);
}

/**
 * Convert HEIC/HEIF blob to a JPEG `File` for FormData + preview.
 * @param {File | Blob} file
 * @param {{ quality?: number }} [opts]
 * @returns {Promise<File>}
 */
export async function heicBlobToJpegFile(file, opts = {}) {
  const size = file.size ?? 0;
  if (size > MAX_HEIC_SOURCE_BYTES) {
    throw new Error(
      `This image is too large to convert here (max ${Math.floor(MAX_HEIC_SOURCE_BYTES / (1024 * 1024))} MB). Try a smaller file or export as JPEG from your phone.`,
    );
  }
  const heic2any = (await import("heic2any")).default;
  const quality = typeof opts.quality === "number" ? opts.quality : 0.88;
  const result = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality,
  });
  const blob = Array.isArray(result) ? result[0] : result;
  if (!blob || !(blob instanceof Blob)) {
    throw new Error("HEIC conversion returned no image.");
  }
  const base =
    "name" in file && file.name
      ? String(file.name).replace(HEIC_EXT, "") || "photo"
      : "photo";
  return new File([blob], `${base}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

/**
 * Ensure a `File` suitable for preview + `/api` upload: HEIC/HEIF → JPEG; other images pass through.
 * @param {File} file
 * @returns {Promise<File | null>}
 */
export async function normalizeImageFileForUpload(file) {
  if (!file) return null;
  if (isHeicLike(file)) {
    try {
      return await heicBlobToJpegFile(file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        msg.includes("too large")
          ? msg
          : `Could not convert HEIC image (${msg}). Try exporting as JPEG from Photos, or use Safari/Chrome with HEIC support.`,
      );
    }
  }
  const t = String(file.type || "").toLowerCase();
  if (t.startsWith("image/")) {
    return file;
  }
  if (HEIC_EXT.test(String(file.name || ""))) {
    return heicBlobToJpegFile(file);
  }
  return null;
}
