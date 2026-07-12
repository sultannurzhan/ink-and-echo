export const MAX_IMAGE_DATA_URL_LENGTH = 1_500_000;
export const MAX_IMAGE_DIMENSION = 8_192;
export const MAX_IMAGE_PIXELS = 16_777_216;

export type ImageDataUrlErrorCode =
  | "invalid_type"
  | "too_large"
  | "invalid_data_url"
  | "invalid_base64"
  | "mime_mismatch"
  | "malformed_image"
  | "invalid_dimensions";

export class ImageDataUrlValidationError extends Error {
  readonly code: ImageDataUrlErrorCode;

  constructor(code: ImageDataUrlErrorCode, message: string) {
    super(message);
    this.name = "ImageDataUrlValidationError";
    this.code = code;
  }
}

type ImageMime = "png" | "jpeg" | "webp";

interface Dimensions {
  width: number;
  height: number;
}

function invalid(code: ImageDataUrlErrorCode, message: string): never {
  throw new ImageDataUrlValidationError(code, message);
}

function base64Value(characterCode: number): number {
  if (characterCode >= 65 && characterCode <= 90) return characterCode - 65;
  if (characterCode >= 97 && characterCode <= 122) return characterCode - 71;
  if (characterCode >= 48 && characterCode <= 57) return characterCode + 4;
  if (characterCode === 43) return 62;
  if (characterCode === 47) return 63;
  return -1;
}

function decodeBase64(payload: string): Uint8Array {
  if (!payload || payload.length % 4 !== 0) {
    invalid("invalid_base64", "The image payload is not valid padded base64.");
  }

  let padding = 0;
  if (payload.endsWith("==")) padding = 2;
  else if (payload.endsWith("=")) padding = 1;

  const byteLength = (payload.length / 4) * 3 - padding;
  const bytes = new Uint8Array(byteLength);
  let output = 0;

  for (let offset = 0; offset < payload.length; offset += 4) {
    const isLast = offset + 4 === payload.length;
    const c0 = payload.charCodeAt(offset);
    const c1 = payload.charCodeAt(offset + 1);
    const c2 = payload.charCodeAt(offset + 2);
    const c3 = payload.charCodeAt(offset + 3);
    const v0 = base64Value(c0);
    const v1 = base64Value(c1);
    const v2 = c2 === 61 ? 0 : base64Value(c2);
    const v3 = c3 === 61 ? 0 : base64Value(c3);

    if (
      v0 < 0 ||
      v1 < 0 ||
      v2 < 0 ||
      v3 < 0 ||
      (c2 === 61 && (!isLast || c3 !== 61)) ||
      (c3 === 61 && !isLast)
    ) {
      invalid("invalid_base64", "The image payload contains invalid base64.");
    }

    if ((c2 === 61 && (v1 & 0x0f) !== 0) || (c3 === 61 && c2 !== 61 && (v2 & 0x03) !== 0)) {
      invalid("invalid_base64", "The image payload is not canonical base64.");
    }

    bytes[output] = (v0 << 2) | (v1 >> 4);
    output += 1;
    if (c2 !== 61) {
      bytes[output] = ((v1 & 0x0f) << 4) | (v2 >> 2);
      output += 1;
    }
    if (c3 !== 61) {
      bytes[output] = ((v2 & 0x03) << 6) | v3;
      output += 1;
    }
  }

  return bytes;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100;
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function isPngChunkType(bytes: Uint8Array, offset: number): boolean {
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[offset + index];
    if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) return false;
  }
  return true;
}

function pngDimensions(bytes: Uint8Array): Dimensions {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  if (!matches(bytes, 0, signature)) invalid("mime_mismatch", "PNG signature does not match its MIME type.");

  let offset: number = signature.length;
  let dimensions: Dimensions | undefined;
  let sawImageData = false;
  let imageDataEnded = false;

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) invalid("malformed_image", "The PNG contains a truncated chunk.");
    const chunkLength = readU32BE(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    if (!isPngChunkType(bytes, typeOffset) || chunkLength > bytes.length - dataOffset - 4) {
      invalid("malformed_image", "The PNG contains an invalid chunk.");
    }

    const type = fourCc(bytes, typeOffset);
    const nextOffset = dataOffset + chunkLength + 4;
    if (!dimensions) {
      if (type !== "IHDR" || chunkLength !== 13) {
        invalid("malformed_image", "The PNG must begin with a complete IHDR chunk.");
      }
      const bitDepth = bytes[dataOffset + 8];
      const colorType = bytes[dataOffset + 9];
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
      if (
        !validDepth ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12] > 1
      ) {
        invalid("malformed_image", "The PNG IHDR fields are invalid.");
      }
      dimensions = {
        width: readU32BE(bytes, dataOffset),
        height: readU32BE(bytes, dataOffset + 4),
      };
    } else if (type === "IHDR") {
      invalid("malformed_image", "The PNG contains more than one IHDR chunk.");
    }

    if (type === "IDAT") {
      if (imageDataEnded) invalid("malformed_image", "The PNG IDAT chunks are not consecutive.");
      if (chunkLength > 0) sawImageData = true;
    } else if (sawImageData && type !== "IEND") {
      imageDataEnded = true;
    }

    if (type === "IEND") {
      if (chunkLength !== 0 || !sawImageData || nextOffset !== bytes.length) {
        invalid("malformed_image", "The PNG has an invalid or misplaced IEND chunk.");
      }
      return dimensions;
    }

    offset = nextOffset;
  }

  invalid("malformed_image", "The PNG is missing its IEND chunk.");
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function jpegDimensions(bytes: Uint8Array): Dimensions {
  if (!matches(bytes, 0, [0xff, 0xd8])) {
    invalid("mime_mismatch", "JPEG signature does not match its MIME type.");
  }

  let offset = 2;
  let dimensions: Dimensions | undefined;
  let inScan = false;
  let sawScan = false;
  let sawEntropyData = false;

  while (offset < bytes.length) {
    let marker = -1;
    let markerFromScan = false;

    if (inScan) {
      while (offset < bytes.length) {
        const value = bytes[offset];
        offset += 1;
        if (value !== 0xff) {
          sawEntropyData = true;
          continue;
        }
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) invalid("malformed_image", "The JPEG scan is truncated.");
        marker = bytes[offset];
        offset += 1;
        if (marker === 0x00) {
          sawEntropyData = true;
          marker = -1;
          continue;
        }
        markerFromScan = true;
        inScan = false;
        break;
      }
    } else {
      if (bytes[offset] !== 0xff) invalid("malformed_image", "The JPEG contains data outside a scan.");
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) invalid("malformed_image", "The JPEG marker is truncated.");
      marker = bytes[offset];
      offset += 1;
    }

    if (marker < 0) continue;
    if (marker === 0xd9) {
      if (!dimensions || !sawScan || !sawEntropyData || offset !== bytes.length) {
        invalid("malformed_image", "The JPEG has an invalid or misplaced end marker.");
      }
      return dimensions;
    }
    if (marker === 0xd8 || marker === 0x00) {
      invalid("malformed_image", "The JPEG contains an unexpected marker.");
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker >= 0xd0 && marker <= 0xd7 && !markerFromScan) {
        invalid("malformed_image", "The JPEG contains a restart marker outside a scan.");
      }
      inScan = markerFromScan;
      continue;
    }
    if (bytes.length - offset < 2) invalid("malformed_image", "The JPEG segment length is truncated.");

    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2 || segmentLength > bytes.length - offset) {
      invalid("malformed_image", "The JPEG contains a truncated segment.");
    }
    const segmentEnd = offset + segmentLength;

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 11) invalid("malformed_image", "The JPEG frame header is incomplete.");
      const components = bytes[offset + 7];
      if (components === 0 || segmentLength !== 8 + components * 3) {
        invalid("malformed_image", "The JPEG frame header has an invalid component table.");
      }
      const frame = {
        height: readU16BE(bytes, offset + 3),
        width: readU16BE(bytes, offset + 5),
      };
      if (dimensions && (dimensions.width !== frame.width || dimensions.height !== frame.height)) {
        invalid("malformed_image", "The JPEG contains conflicting frame dimensions.");
      }
      dimensions = frame;
    }

    if (marker === 0xda) {
      if (!dimensions || segmentLength < 8) {
        invalid("malformed_image", "The JPEG scan header is incomplete or precedes its frame.");
      }
      const components = bytes[offset + 2];
      if (components === 0 || segmentLength !== 6 + components * 2) {
        invalid("malformed_image", "The JPEG scan header has an invalid component table.");
      }
      sawScan = true;
      inScan = true;
    }

    offset = segmentEnd;
  }

  invalid("malformed_image", "The JPEG is missing its end marker.");
}

function parseVp8(bytes: Uint8Array, offset: number, length: number): Dimensions {
  if (length < 10 || !matches(bytes, offset + 3, [0x9d, 0x01, 0x2a])) {
    invalid("malformed_image", "The WebP VP8 frame header is incomplete.");
  }
  const frameTag = readU24LE(bytes, offset);
  if ((frameTag & 1) !== 0 || ((frameTag >> 1) & 7) > 3 || ((frameTag >> 4) & 1) !== 1) {
    invalid("malformed_image", "The WebP VP8 key-frame flags are invalid.");
  }
  if ((frameTag >> 5) > length - 3) {
    invalid("malformed_image", "The WebP VP8 first partition is truncated.");
  }
  return {
    width: readU16LE(bytes, offset + 6) & 0x3fff,
    height: readU16LE(bytes, offset + 8) & 0x3fff,
  };
}

function parseVp8l(bytes: Uint8Array, offset: number, length: number): Dimensions {
  if (length < 5 || bytes[offset] !== 0x2f || (bytes[offset + 4] & 0xe0) !== 0) {
    invalid("malformed_image", "The WebP VP8L frame header is invalid.");
  }
  return {
    width: 1 + bytes[offset + 1] + ((bytes[offset + 2] & 0x3f) << 8),
    height:
      1 +
      (bytes[offset + 2] >> 6) +
      (bytes[offset + 3] << 2) +
      ((bytes[offset + 4] & 0x0f) << 10),
  };
}

function parseVp8x(bytes: Uint8Array, offset: number, length: number): Dimensions {
  if (
    length !== 10 ||
    (bytes[offset] & 0xc1) !== 0 ||
    bytes[offset + 1] !== 0 ||
    bytes[offset + 2] !== 0 ||
    bytes[offset + 3] !== 0
  ) {
    invalid("malformed_image", "The WebP VP8X header is invalid.");
  }
  return {
    width: 1 + readU24LE(bytes, offset + 4),
    height: 1 + readU24LE(bytes, offset + 7),
  };
}

function webpDimensions(bytes: Uint8Array): Dimensions {
  if (!matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) || !matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    invalid("mime_mismatch", "WebP signature does not match its MIME type.");
  }
  if (bytes.length < 20 || readU32LE(bytes, 4) + 8 !== bytes.length) {
    invalid("malformed_image", "The WebP RIFF container length is invalid.");
  }

  let offset = 12;
  let dimensions: Dimensions | undefined;
  let format: "VP8 " | "VP8L" | "VP8X" | undefined;
  let extendedFlags = 0;
  let sawStillFrame = false;
  let sawAnimationHeader = false;
  let sawAnimationFrame = false;

  while (offset < bytes.length) {
    if (bytes.length - offset < 8) invalid("malformed_image", "The WebP contains a truncated chunk header.");
    const type = fourCc(bytes, offset);
    const chunkLength = readU32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (chunkLength > bytes.length - dataOffset) {
      invalid("malformed_image", "The WebP contains a truncated chunk.");
    }
    const dataEnd = dataOffset + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (paddedEnd > bytes.length || (paddedEnd !== dataEnd && bytes[dataEnd] !== 0)) {
      invalid("malformed_image", "The WebP chunk padding is invalid.");
    }

    if (!format) {
      if (type === "VP8 ") dimensions = parseVp8(bytes, dataOffset, chunkLength);
      else if (type === "VP8L") dimensions = parseVp8l(bytes, dataOffset, chunkLength);
      else if (type === "VP8X") {
        dimensions = parseVp8x(bytes, dataOffset, chunkLength);
        extendedFlags = bytes[dataOffset];
      } else {
        invalid("malformed_image", "The WebP image header must be its first chunk.");
      }
      format = type;
      sawStillFrame = type !== "VP8X";
    } else if (type === "VP8 " || type === "VP8L" || type === "VP8X") {
      if (format !== "VP8X" || type === "VP8X" || sawStillFrame || sawAnimationFrame) {
        invalid("malformed_image", "The WebP contains conflicting image chunks.");
      }
      const frame = type === "VP8 " ? parseVp8(bytes, dataOffset, chunkLength) : parseVp8l(bytes, dataOffset, chunkLength);
      if (!dimensions || frame.width > dimensions.width || frame.height > dimensions.height) {
        invalid("malformed_image", "The WebP frame exceeds its VP8X canvas.");
      }
      sawStillFrame = true;
    } else if (type === "ANIM") {
      if (format !== "VP8X" || chunkLength !== 6 || sawAnimationHeader || sawStillFrame) {
        invalid("malformed_image", "The WebP animation header is invalid.");
      }
      sawAnimationHeader = true;
    } else if (type === "ANMF") {
      if (format !== "VP8X" || !dimensions || !sawAnimationHeader || chunkLength <= 16) {
        invalid("malformed_image", "The WebP animation frame is invalid.");
      }
      const x = readU24LE(bytes, dataOffset) * 2;
      const y = readU24LE(bytes, dataOffset + 3) * 2;
      const width = 1 + readU24LE(bytes, dataOffset + 6);
      const height = 1 + readU24LE(bytes, dataOffset + 9);
      if (x + width > dimensions.width || y + height > dimensions.height) {
        invalid("malformed_image", "The WebP animation frame exceeds its canvas.");
      }
      sawAnimationFrame = true;
    }

    offset = paddedEnd;
  }

  if (!dimensions || !format) invalid("malformed_image", "The WebP has no image header.");
  if (format === "VP8X") {
    const declaresAnimation = (extendedFlags & 0x02) !== 0;
    if (declaresAnimation) {
      invalid("malformed_image", "Animated WebP drawings are not accepted.");
    }
    if (
      (declaresAnimation && (!sawAnimationHeader || !sawAnimationFrame || sawStillFrame)) ||
      (!declaresAnimation && (!sawStillFrame || sawAnimationHeader || sawAnimationFrame))
    ) {
      invalid("malformed_image", "The WebP content does not match its VP8X feature flags.");
    }
  }
  return dimensions;
}

function validateDimensions(dimensions: Dimensions): void {
  const { width, height } = dimensions;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    invalid(
      "invalid_dimensions",
      `Image dimensions must be non-zero, at most ${MAX_IMAGE_DIMENSION}px per side, and at most ${MAX_IMAGE_PIXELS} pixels total.`,
    );
  }
}

/**
 * Validates an image data URL and returns it with a canonical MIME/base64 prefix.
 * The base64 payload itself is already required to be canonical and is not rewritten.
 */
export function validateImageDataUrl(value: unknown): string {
  if (typeof value !== "string" || !value) {
    invalid("invalid_type", "Image data must be a non-empty string.");
  }
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) {
    invalid("too_large", `Image data must not exceed ${MAX_IMAGE_DATA_URL_LENGTH} characters.`);
  }

  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) {
    invalid("invalid_data_url", "Image data must be a base64 PNG, JPEG, or WebP data URL.");
  }

  const mime = match[1].toLowerCase() as ImageMime;
  const payload = match[2];
  const bytes = decodeBase64(payload);
  const dimensions =
    mime === "png" ? pngDimensions(bytes) : mime === "jpeg" ? jpegDimensions(bytes) : webpDimensions(bytes);
  validateDimensions(dimensions);

  return `data:image/${mime};base64,${payload}`;
}
