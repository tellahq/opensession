export interface ImagePngOptions {
  /** Paint this colour under the picture first. A diagram is drawn straight
   * on its well, so without one it pastes as ink on a transparent sheet:
   * near-black lines on a dark document, white lines on a light one. */
  background?: string;
}

/** Vector art has no pixel size of its own, so it is drawn at twice its
 * stated size: crisp on a high-density screen, and still a modest file. */
const VECTOR_SCALE = 2;

interface Drawable {
  picture: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** createImageBitmap does not take SVG in Chrome or Firefox, so vector art
 * is decoded through an <img>, which does. It loads from `src` itself, not
 * from the fetched blob: Chrome taints a canvas that draws a blob: SVG with
 * HTML labels in it (mermaid's <foreignObject>), while a data: URL or a
 * same-origin file stays exportable. */
async function drawable(src: string, source: Blob): Promise<Drawable> {
  if (!source.type.startsWith("image/svg")) {
    const bitmap = await createImageBitmap(source);
    return {
      picture: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }
  const img = new Image();
  img.src = src;
  await img.decode();
  return {
    picture: img,
    width: img.naturalWidth * VECTOR_SCALE,
    height: img.naturalHeight * VECTOR_SCALE,
    release: () => {},
  };
}

/** Convert any browser-readable image to PNG for the async Clipboard API.
 * Safari accepts PNG consistently, while JPEG and WebP support varies. */
async function imagePng(
  src: string,
  { background }: ImagePngOptions = {},
): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Image load failed: ${response.status}`);
  const source = await response.blob();
  if (source.type === "image/png" && !background) return source;

  const { picture, width, height, release } = await drawable(src, source);
  try {
    if (!width || !height) throw new Error("Image has no size");
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image canvas is unavailable");
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Image conversion failed")),
        "image/png",
      );
    });
  } finally {
    release();
  }
}

/** Copy an image while preserving Safari's transient user activation. The
 * pending blob is handed to ClipboardItem synchronously, before fetch awaits. */
export function copyImageToClipboard(
  src: string,
  options?: ImagePngOptions,
): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return Promise.reject(new Error("Image copy is unavailable"));
  }
  const png = imagePng(src, options);
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
