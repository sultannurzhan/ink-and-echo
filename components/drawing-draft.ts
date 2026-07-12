export type DrawingImageType =
  | "image/png"
  | "image/jpeg"
  | "image/webp";

export interface DrawingCanvasDraft {
  version: 1;
  width: number;
  height: number;
  backgroundColor: string;
  /** A compressed image of only the transparent ink layer. */
  layerDataUrl: string;
  layerBytes: number;
}

export interface DrawingExportOptions {
  type?: "image/webp" | "image/jpeg";
  quality?: number;
  minQuality?: number;
  maxBytes?: number;
  maxDimension?: number;
  allowResize?: boolean;
}

export interface DrawingExportResult {
  dataUrl: string;
  blob: Blob;
  type: DrawingImageType;
  quality: number;
  bytes: number;
  width: number;
  height: number;
  withinLimit: boolean;
}

export interface ImageImportLimits {
  maxBytes: number;
  maxDimension: number;
  maxPixels: number;
}

export interface ValidatedImage {
  blob: Blob;
  type: DrawingImageType;
  width: number;
  height: number;
}

export const DEFAULT_IMAGE_IMPORT_LIMITS: ImageImportLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxDimension: 8192,
  maxPixels: 24_000_000,
};

const SUPPORTED_TYPES = new Set<DrawingImageType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  let value = "";
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function parsePngDimensions(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 24 ||
    signature.some((value, index) => bytes[index] !== value) ||
    readAscii(bytes, 12, 4) !== "IHDR"
  ) {
    throw new Error("The PNG header is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseJpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("The JPEG header is invalid.");
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
    0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) break;
      return {
        width: readUint16BigEndian(bytes, offset + 5),
        height: readUint16BigEndian(bytes, offset + 3),
      };
    }
    offset += segmentLength;
  }
  throw new Error("The JPEG dimensions could not be read safely.");
}

function parseWebpDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 30 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WEBP"
  ) {
    throw new Error("The WebP header is invalid.");
  }

  const chunkType = readAscii(bytes, 12, 4);
  if (chunkType === "VP8X") {
    return {
      width: readUint24LittleEndian(bytes, 24) + 1,
      height: readUint24LittleEndian(bytes, 27) + 1,
    };
  }
  if (chunkType === "VP8 ") {
    if (
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      throw new Error("The WebP frame header is invalid.");
    }
    return {
      width: ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff,
      height: ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff,
    };
  }
  if (chunkType === "VP8L") {
    if (bytes[20] !== 0x2f || bytes.length < 25) {
      throw new Error("The WebP lossless header is invalid.");
    }
    const byte21 = bytes[21] ?? 0;
    const byte22 = bytes[22] ?? 0;
    const byte23 = bytes[23] ?? 0;
    const byte24 = bytes[24] ?? 0;
    return {
      width: 1 + byte21 + ((byte22 & 0x3f) << 8),
      height: 1 + (byte22 >> 6) + (byte23 << 2) + ((byte24 & 0x0f) << 10),
    };
  }
  throw new Error("The WebP dimensions could not be read safely.");
}

function parseImageDimensions(bytes: Uint8Array, type: DrawingImageType) {
  if (type === "image/png") return parsePngDimensions(bytes);
  if (type === "image/jpeg") return parseJpegDimensions(bytes);
  return parseWebpDimensions(bytes);
}

export function estimateDataUrlBytes(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function dataUrlToBlob(
  dataUrl: string,
  maxBytes = DEFAULT_IMAGE_IMPORT_LIMITS.maxBytes,
) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/i.exec(
    dataUrl,
  );
  if (!match) {
    throw new Error("Only PNG, JPEG, or WebP image data URLs are supported.");
  }
  const estimatedBytes = estimateDataUrlBytes(dataUrl);
  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) {
    throw new Error("The image is empty or malformed.");
  }
  if (estimatedBytes > maxBytes) {
    throw new Error(`The image is larger than ${Math.ceil(maxBytes / 1_048_576)} MB.`);
  }

  const binary = window.atob(match[2]);
  if (binary.length > maxBytes) {
    throw new Error(`The image is larger than ${Math.ceil(maxBytes / 1_048_576)} MB.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: match[1].toLowerCase() });
}

export async function validateImageBlob(
  blob: Blob,
  limits: ImageImportLimits = DEFAULT_IMAGE_IMPORT_LIMITS,
): Promise<ValidatedImage> {
  const type = blob.type.toLowerCase() as DrawingImageType;
  if (!SUPPORTED_TYPES.has(type)) {
    throw new Error("Only PNG, JPEG, or WebP images can be opened.");
  }
  if (blob.size <= 0) throw new Error("The image is empty.");
  if (blob.size > limits.maxBytes) {
    throw new Error(`The image is larger than ${Math.ceil(limits.maxBytes / 1_048_576)} MB.`);
  }

  // Header parsing happens before any browser image decoder sees the payload.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { width, height } = parseImageDimensions(bytes, type);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("The image dimensions are invalid.");
  }
  if (width > limits.maxDimension || height > limits.maxDimension) {
    throw new Error(`Images may be at most ${limits.maxDimension}px on either side.`);
  }
  if (width * height > limits.maxPixels) {
    throw new Error("The image has too many pixels to open safely.");
  }
  return { blob, type, width, height };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("The image could not be serialized."));
    reader.onerror = () => reject(new Error("The image could not be serialized."));
    reader.readAsDataURL(blob);
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: DrawingImageType,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("The browser could not encode the drawing."));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
}
