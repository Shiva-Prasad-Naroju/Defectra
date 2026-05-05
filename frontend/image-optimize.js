/**
 * Client-side resize + JPEG re-encode for inspection uploads.
 * Large originals (e.g. 25MB+ phone photos) are scaled and compressed before POST
 * so proxies and servers see a predictable payload while keeping defect detail.
 */

/** Hard cap on reading a file into canvas (avoids tab OOM). */
export const MAX_SOURCE_FILE_BYTES = 100 * 1024 * 1024;

/** Longest edge after scaling (inspection-grade; ~32MP at 4:3). */
export const MAX_LONG_EDGE_PX = 8192;

/** Target upper bound for the encoded JPEG sent to `/api/defects/upload`. */
export const TARGET_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const START_JPEG_QUALITY = 0.92;
export const MIN_JPEG_QUALITY = 0.72;
const MIN_SCALE = 0.38;

function sanitizeBaseName(name) {
  const base = (name || "inspection").replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[^\w.\-]+/g, "_").slice(0, 96);
  return cleaned || "inspection";
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} quality
 * @returns {Promise<Blob|null>}
 */
function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(
      (b) => resolve(b),
      "image/jpeg",
      quality,
    );
  });
}

/**
 * @param {ImageBitmap} bitmap
 * @param {number} scale
 * @param {number} quality
 */
async function encodeScaledJpeg(bitmap, scale, quality) {
  const sw = Math.max(1, Math.round(bitmap.width * scale));
  const sh = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare image canvas.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, sw, sh);
  const blob = await canvasToJpegBlob(canvas, quality);
  if (!blob) throw new Error("Could not encode image.");
  return blob;
}

/**
 * @param {File} file
 * @returns {Promise<ImageBitmap>}
 */
async function decodeToBitmap(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const bmp = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          try {
            resolve(createImageBitmap(img));
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = () => reject(new Error("Could not decode image."));
        img.crossOrigin = "anonymous";
        img.src = url;
      });
      return bmp;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Produce a JPEG `File` suitable for upload: caps resolution, targets size under TARGET_UPLOAD_MAX_BYTES.
 * @param {File} file Normalized image file (e.g. after HEIC → JPEG).
 * @param {{ status?: (msg: string) => void }} [hooks]
 * @returns {Promise<File>}
 */
export async function optimizeImageForInspection(file, hooks = {}) {
  if (!(file instanceof File) && !(file instanceof Blob)) {
    throw new Error("Invalid file.");
  }
  const size = file.size ?? 0;
  if (size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(
      `This image is too large to process in the browser (max ${Math.round(MAX_SOURCE_FILE_BYTES / (1024 * 1024))} MB).`,
    );
  }

  const status = hooks.status || (() => {});

  status("Preparing image…");
  const bitmap = await decodeToBitmap(file);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    const longEdge = Math.max(w, h);
    const fitScale = longEdge > MAX_LONG_EDGE_PX ? MAX_LONG_EDGE_PX / longEdge : 1;

    const isJpeg = String(file.type || "").toLowerCase() === "image/jpeg";
    if (fitScale >= 0.999 && isJpeg && size <= TARGET_UPLOAD_MAX_BYTES) {
      status("Image ready.");
      return file instanceof File
        ? file
        : new File([file], "inspection.jpg", { type: "image/jpeg", lastModified: Date.now() });
    }

    status("Optimizing resolution & quality…");
    let scale = fitScale;
    let quality = START_JPEG_QUALITY;
    let blob = await encodeScaledJpeg(bitmap, scale, quality);

    while (blob.size > TARGET_UPLOAD_MAX_BYTES && quality > MIN_JPEG_QUALITY + 0.02) {
      quality -= 0.06;
      blob = await encodeScaledJpeg(bitmap, scale, quality);
    }

    while (blob.size > TARGET_UPLOAD_MAX_BYTES && scale > MIN_SCALE) {
      scale *= 0.9;
      quality = Math.min(START_JPEG_QUALITY, quality + 0.04);
      blob = await encodeScaledJpeg(bitmap, scale, quality);
      while (blob.size > TARGET_UPLOAD_MAX_BYTES && quality > MIN_JPEG_QUALITY + 0.02) {
        quality -= 0.05;
        blob = await encodeScaledJpeg(bitmap, scale, quality);
      }
    }

    if (blob.size > TARGET_UPLOAD_MAX_BYTES * 1.1) {
      throw new Error(
        "Could not reduce this image enough for upload. Try a slightly smaller photo.",
      );
    }

    const base = sanitizeBaseName(file.name);
    status("Image ready.");
    return new File([blob], `${base}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } finally {
    try {
      bitmap.close();
    } catch {
      /* ignore */
    }
  }
}
