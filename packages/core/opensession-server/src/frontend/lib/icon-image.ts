/**
 * Turn a picked image file into the square PNG a repo tile wants.
 *
 * The conversion happens here rather than on the server because the browser
 * already decodes everything a person is likely to pick — JPEG, WebP, SVG, an
 * HEIC screenshot on a Mac — while the server's icon path is deliberately
 * dependency-free (png-trim.ts decodes PNG and nothing else). So whatever was
 * chosen is drawn onto a canvas and re-encoded, and the upload is always one
 * square PNG the server can trim like any other.
 *
 * Art keeps its aspect ratio and is centred on transparency: a wide logo ends
 * up letterboxed rather than stretched, and the tile's own rounding shows
 * through.
 */

/** Tile art is drawn at 28px at most; 256 leaves room for retina and zoom. */
const ICON_SIZE = 256;

export async function pngFromImageFile(
  file: File,
  size = ICON_SIZE,
): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser wouldn’t give us a canvas");
    // An SVG with no intrinsic size decodes to 0×0 in some browsers; fall
    // back to the square rather than dividing by zero.
    const width = image.naturalWidth || size;
    const height = image.naturalHeight || size;
    const scale = Math.min(size / width, size / height);
    const drawnW = width * scale;
    const drawnH = height * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      image,
      (size - drawnW) / 2,
      (size - drawnH) / 2,
      drawnW,
      drawnH,
    );
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Couldn’t read that image")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The same square PNG, from a URL rather than a picked file.
 *
 * Used for the GitHub organization avatar during onboarding. It goes through
 * `fetch` rather than straight into an `<img>` so a cross-origin host that
 * refuses CORS fails here, cleanly and silently, instead of tainting a canvas
 * and throwing on `toBlob`. Returns null on any failure: an icon we could not
 * fetch is one the operator can still upload by hand.
 */
export async function pngFromImageUrl(url: string): Promise<Blob | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.size) return null;
    return await pngFromImageFile(
      new File([blob], "icon", { type: blob.type || "image/png" }),
    );
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("That file isn’t an image we can read"));
    image.src = src;
  });
}
