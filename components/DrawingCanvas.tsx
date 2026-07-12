"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  blobToDataUrl,
  canvasToBlob,
  dataUrlToBlob,
  validateImageBlob,
  type DrawingCanvasDraft,
  type DrawingExportOptions,
  type DrawingExportResult,
  type DrawingImageType,
  type ValidatedImage,
} from "./drawing-draft";

export type {
  DrawingCanvasDraft,
  DrawingExportOptions,
  DrawingExportResult,
} from "./drawing-draft";

export type DrawingTool =
  | "pen"
  | "eraser"
  | "fill"
  | "line"
  | "rectangle"
  | "circle"
  | "arrow"
  | "text";

export interface DrawingCanvasHandle {
  exportDataUrl: (
    type?: "image/png" | "image/jpeg" | "image/webp",
    quality?: number,
  ) => string;
  exportCompressed: (
    options?: DrawingExportOptions,
  ) => Promise<DrawingExportResult>;
  saveDraft: () => Promise<DrawingCanvasDraft>;
  loadDraft: (draft: DrawingCanvasDraft | string) => Promise<void>;
  loadDataUrl: (dataUrl: string) => Promise<void>;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  fit: () => void;
  getCanvasElement: () => HTMLCanvasElement | null;
}

export interface DrawingCanvasProps {
  width?: number;
  height?: number;
  initialImageDataUrl?: string | null;
  initialBackgroundColor?: string;
  onChange?: (dataUrl: string) => void;
  onExport?: (dataUrl: string) => void;
  disabled?: boolean;
  showToolbar?: boolean;
  className?: string;
  canvasClassName?: string;
  toolbarClassName?: string;
  ariaLabel?: string;
  maxHistory?: number;
  downloadFileName?: string;
}

interface Point {
  x: number;
  y: number;
}

interface HistoryEntry {
  contentBlob: Blob;
  backgroundColor: string;
}

interface Gesture {
  pointerId: number;
  tool: Exclude<DrawingTool, "fill" | "text">;
  start: Point;
  lastRaw: Point;
  lastDrawn: Point;
  color: string;
  size: number;
  snapshot?: ImageData;
}

interface TextDraft {
  x: number;
  y: number;
  value: string;
  color: string;
  fontSize: number;
}

const QUICK_COLORS = [
  "#171721",
  "#ffffff",
  "#ef476f",
  "#ff8c42",
  "#ffd166",
  "#70d86b",
  "#20b8a6",
  "#32a8e6",
  "#6c63db",
  "#c05ad9",
  "#8b5a3c",
  "#ff9fbd",
] as const;

const TOOL_OPTIONS: ReadonlyArray<{
  tool: DrawingTool;
  label: string;
  icon: string;
  shortcut: string;
}> = [
  { tool: "pen", label: "Pen", icon: "✎", shortcut: "P" },
  { tool: "eraser", label: "Eraser", icon: "⌫", shortcut: "E" },
  { tool: "fill", label: "Fill", icon: "▨", shortcut: "F" },
  { tool: "line", label: "Line", icon: "╱", shortcut: "L" },
  { tool: "rectangle", label: "Rectangle", icon: "□", shortcut: "R" },
  { tool: "circle", label: "Circle", icon: "○", shortcut: "O" },
  { tool: "arrow", label: "Arrow", icon: "↗", shortcut: "A" },
  { tool: "text", label: "Text", icon: "T", shortcut: "T" },
];

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const MIN_BRUSH_SIZE = 1;
const MAX_BRUSH_SIZE = 64;
const HISTORY_WEBP_QUALITY = 0.82;
const CHANGE_WEBP_QUALITY = 0.82;
const DRAFT_WEBP_QUALITY = 0.88;
const MOBILE_HISTORY_BYTES = 12 * 1024 * 1024;
const DESKTOP_HISTORY_BYTES = 24 * 1024 * 1024;

function cx(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function getCanvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): Point {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: clamp(
      ((clientX - bounds.left) / Math.max(bounds.width, 1)) * canvas.width,
      0,
      canvas.width,
    ),
    y: clamp(
      ((clientY - bounds.top) / Math.max(bounds.height, 1)) * canvas.height,
      0,
      canvas.height,
    ),
  };
}

function getContext(canvas: HTMLCanvasElement) {
  return canvas.getContext("2d", { willReadFrequently: true });
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

function decodeImageBlobWithElement(blob: Blob): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () =>
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(objectUrl),
      });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("The image could not be loaded."));
    };
    image.src = objectUrl;
  });
}

async function decodeImageBlob(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // WebKit has shipped createImageBitmap implementations that reject image
      // formats its HTMLImageElement decoder can still display. Falling back
      // also keeps undo and remix loads usable on those releases.
    }
  }

  return decodeImageBlobWithElement(blob);
}

async function decodeValidatedImage(validated: ValidatedImage) {
  const decoded = await decodeImageBlob(validated.blob);
  if (decoded.width !== validated.width || decoded.height !== validated.height) {
    decoded.close();
    throw new Error("The decoded image dimensions do not match its header.");
  }
  return decoded;
}

function drawImageContained(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
) {
  const context = getContext(canvas);
  if (!context) return;

  context.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(
    canvas.width / Math.max(imageWidth, 1),
    canvas.height / Math.max(imageHeight, 1),
  );
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  context.drawImage(
    image,
    (canvas.width - drawWidth) / 2,
    (canvas.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function getHistoryByteLimit() {
  const memory = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  const looksMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return looksMobile || (memory !== undefined && memory <= 4)
    ? MOBILE_HISTORY_BYTES
    : DESKTOP_HISTORY_BYTES;
}

function snapshotCanvasLayer(canvas: HTMLCanvasElement) {
  let encoded = canvas.toDataURL("image/webp", HISTORY_WEBP_QUALITY);
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(encoded)) {
    encoded = canvas.toDataURL("image/png");
  }
  return dataUrlToBlob(encoded, DESKTOP_HISTORY_BYTES);
}

async function encodeCanvasWithFallback(
  canvas: HTMLCanvasElement,
  preferredType: DrawingImageType,
  quality?: number,
) {
  const fallbackTypes: DrawingImageType[] = [
    preferredType,
    ...(preferredType === "image/jpeg" ? [] : ["image/jpeg" as const]),
    ...(preferredType === "image/png" ? [] : ["image/png" as const]),
  ];
  let lastError: unknown;

  for (const type of fallbackTypes) {
    try {
      const blob = await canvasToBlob(canvas, type, quality);
      if (
        blob.size > 0 &&
        (blob.type === "image/png" ||
          blob.type === "image/jpeg" ||
          blob.type === "image/webp")
      ) {
        return blob;
      }
      lastError = new Error("The browser returned an unsupported drawing format.");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("The browser could not encode the drawing.");
}

function createCompositeCanvas(
  layer: HTMLCanvasElement,
  backgroundColor: string,
  maxDimension?: number,
) {
  const requestedMax = maxDimension
    ? clamp(Math.floor(maxDimension), 320, 8192)
    : Math.max(layer.width, layer.height);
  const scale = Math.min(1, requestedMax / Math.max(layer.width, layer.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(layer.width * scale));
  canvas.height = Math.max(1, Math.round(layer.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The drawing could not be exported.");
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(layer, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function hexToRgba(hex: string): [number, number, number, number] {
  const clean = hex.replace("#", "");
  const normalized =
    clean.length === 3
      ? clean
          .split("")
          .map((character) => character + character)
          .join("")
      : clean.padEnd(6, "0").slice(0, 6);

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    255,
  ];
}

function floodFill(
  canvas: HTMLCanvasElement,
  point: Point,
  fillColor: string,
) {
  const context = getContext(canvas);
  if (!context) return false;

  const { width, height } = canvas;
  const startX = clamp(Math.floor(point.x), 0, width - 1);
  const startY = clamp(Math.floor(point.y), 0, height - 1);
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  const startPixel = (startY * width + startX) * 4;
  const target: [number, number, number, number] = [
    pixels[startPixel],
    pixels[startPixel + 1],
    pixels[startPixel + 2],
    pixels[startPixel + 3],
  ];
  const replacement = hexToRgba(fillColor);

  if (target.every((channel, index) => channel === replacement[index])) {
    return false;
  }

  // A small tolerance includes antialiased edge pixels while retaining boundaries.
  const tolerance = 24;
  const matchesTarget = (pixelIndex: number) => {
    if (target[3] === 0) return pixels[pixelIndex + 3] === 0;
    return (
      Math.abs(pixels[pixelIndex] - target[0]) <= tolerance &&
      Math.abs(pixels[pixelIndex + 1] - target[1]) <= tolerance &&
      Math.abs(pixels[pixelIndex + 2] - target[2]) <= tolerance &&
      Math.abs(pixels[pixelIndex + 3] - target[3]) <= tolerance
    );
  };

  const totalPixels = width * height;
  const queue = new Int32Array(totalPixels);
  const visited = new Uint8Array(totalPixels);
  let head = 0;
  let tail = 0;
  const startIndex = startY * width + startX;
  queue[tail++] = startIndex;
  visited[startIndex] = 1;

  while (head < tail) {
    const pixel = queue[head++];
    const offset = pixel * 4;
    if (!matchesTarget(offset)) continue;

    pixels[offset] = replacement[0];
    pixels[offset + 1] = replacement[1];
    pixels[offset + 2] = replacement[2];
    pixels[offset + 3] = replacement[3];

    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const neighbors = [
      x > 0 ? pixel - 1 : -1,
      x < width - 1 ? pixel + 1 : -1,
      y > 0 ? pixel - width : -1,
      y < height - 1 ? pixel + width : -1,
    ];

    for (const neighbor of neighbors) {
      if (neighbor >= 0 && visited[neighbor] === 0) {
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
  }

  context.putImageData(image, 0, 0);
  return true;
}

function configureStroke(
  context: CanvasRenderingContext2D,
  tool: Gesture["tool"],
  color: string,
  size: number,
  pressure = 0.5,
) {
  const pressureScale = pressure > 0 ? 0.72 + pressure * 0.56 : 1;
  context.globalCompositeOperation =
    tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = tool === "eraser" ? "rgba(0,0,0,1)" : color;
  context.fillStyle = tool === "eraser" ? "rgba(0,0,0,1)" : color;
  context.lineWidth = Math.max(1, size * pressureScale);
  context.lineCap = "round";
  context.lineJoin = "round";
}

function drawShape(
  context: CanvasRenderingContext2D,
  tool: "line" | "rectangle" | "circle" | "arrow",
  start: Point,
  end: Point,
  color: string,
  size: number,
) {
  context.save();
  configureStroke(context, tool, color, size);
  context.beginPath();

  if (tool === "line") {
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
  } else if (tool === "rectangle") {
    context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else if (tool === "circle") {
    const center = midpoint(start, end);
    context.ellipse(
      center.x,
      center.y,
      Math.max(Math.abs(end.x - start.x) / 2, 0.5),
      Math.max(Math.abs(end.y - start.y) / 2, 0.5),
      0,
      0,
      Math.PI * 2,
    );
  } else {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const head = Math.min(
      Math.max(12, size * 3),
      Math.max(6, length * 0.42),
    );
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - head * Math.cos(angle - Math.PI / 6),
      end.y - head * Math.sin(angle - Math.PI / 6),
    );
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - head * Math.cos(angle + Math.PI / 6),
      end.y - head * Math.sin(angle + Math.PI / 6),
    );
  }

  context.stroke();
  context.restore();
}

/**
 * A dependency-free bitmap drawing surface. The bitmap is kept transparent and
 * composited over the selected background when exported, so the eraser remains
 * useful even after the background color changes.
 */
export const DrawingCanvas = forwardRef<
  DrawingCanvasHandle,
  DrawingCanvasProps
>(function DrawingCanvas(
  {
    width = 960,
    height = 640,
    initialImageDataUrl = null,
    initialBackgroundColor = "#fffaf0",
    onChange,
    onExport,
    disabled = false,
    showToolbar = true,
    className,
    canvasClassName,
    toolbarClassName,
    ariaLabel = "Drawing canvas",
    maxHistory = 32,
    downloadFileName = "duet-doodle.png",
  },
  forwardedRef,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const historyIndexRef = useRef(-1);
  const restoreGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const changeGenerationRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onExportRef = useRef(onExport);
  const textDraftRef = useRef<TextDraft | null>(null);

  const [tool, setTool] = useState<DrawingTool>("pen");
  const [color, setColor] = useState("#171721");
  const [brushSize, setBrushSize] = useState(6);
  const [backgroundColor, setBackgroundColor] = useState(
    initialBackgroundColor,
  );
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [historyState, setHistoryState] = useState({ index: -1, length: 0 });
  const [confirmClear, setConfirmClear] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [status, setStatus] = useState("Canvas ready");
  const brushSizeId = useId();
  const clearTitleId = useId();
  const clearDescriptionId = useId();

  const backgroundRef = useRef(backgroundColor);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const brushSizeRef = useRef(brushSize);

  onChangeRef.current = onChange;
  onExportRef.current = onExport;
  backgroundRef.current = backgroundColor;
  toolRef.current = tool;
  colorRef.current = color;
  brushSizeRef.current = brushSize;

  const exportDataUrl = useCallback(
    (
      type: "image/png" | "image/jpeg" | "image/webp" = "image/png",
      quality?: number,
      backgroundOverride?: string,
    ) => {
      const canvas = canvasRef.current;
      if (!canvas) return "";

      try {
        const exportCanvas = createCompositeCanvas(
          canvas,
          backgroundOverride ?? backgroundRef.current,
        );
        const encoded = exportCanvas.toDataURL(type, quality);
        if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(encoded)) {
          return encoded;
        }
        return exportCanvas.toDataURL("image/png");
      } catch {
        return "";
      }
    },
    [],
  );

  const emitChangeDataUrl = useCallback(
    (nextBackground: string) => {
      if (!onChangeRef.current) return;
      const generation = ++changeGenerationRef.current;

      // Keep pointer-up responsive. History already performs one synchronous
      // layer snapshot, so the composited callback image is encoded off the
      // event stack and stale results are discarded.
      void Promise.resolve().then(async () => {
        if (generation !== changeGenerationRef.current) return;
        const layer = canvasRef.current;
        if (!layer) return;

        try {
          const composite = createCompositeCanvas(layer, nextBackground);
          const blob = await encodeCanvasWithFallback(
            composite,
            "image/webp",
            CHANGE_WEBP_QUALITY,
          );
          const dataUrl = await blobToDataUrl(blob);
          if (generation === changeGenerationRef.current) {
            onChangeRef.current?.(dataUrl);
          }
        } catch {
          if (generation !== changeGenerationRef.current) return;
          const fallback = exportDataUrl(
            "image/png",
            undefined,
            nextBackground,
          );
          if (fallback) onChangeRef.current?.(fallback);
        }
      });
    },
    [exportDataUrl],
  );

  const exportCompressed = useCallback(
    async (
      options: DrawingExportOptions = {},
    ): Promise<DrawingExportResult> => {
      const layer = canvasRef.current;
      if (!layer) throw new Error("The drawing canvas is not ready.");

      const requestedType = options.type ?? "image/webp";
      const initialQuality = clamp(options.quality ?? 0.86, 0.1, 1);
      const minQuality = clamp(
        options.minQuality ?? 0.42,
        0.1,
        initialQuality,
      );
      const maxBytes = options.maxBytes
        ? Math.max(1024, Math.floor(options.maxBytes))
        : undefined;
      let workingCanvas = createCompositeCanvas(
        layer,
        backgroundRef.current,
        options.maxDimension,
      );
      let quality = initialQuality;
      let blob = await encodeCanvasWithFallback(
        workingCanvas,
        requestedType,
        quality,
      );
      let actualType = blob.type as DrawingImageType;

      // Some older browsers silently return PNG when WebP is requested. PNG has
      // no useful quality control, so JPEG is the predictable compressed fallback.
      if (actualType !== requestedType) {
        blob = await encodeCanvasWithFallback(
          workingCanvas,
          "image/jpeg",
          quality,
        );
        actualType = blob.type as DrawingImageType;
      }

      if (maxBytes && blob.size > maxBytes) {
        let low = minQuality;
        let high = initialQuality;
        let smallest = blob;
        let smallestQuality = quality;
        let bestWithinLimit: Blob | null = null;
        let bestWithinQuality = minQuality;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          quality = attempt === 0 ? minQuality : (low + high) / 2;
          const candidate = await encodeCanvasWithFallback(
            workingCanvas,
            actualType === "image/webp" ? "image/webp" : "image/jpeg",
            quality,
          );
          if (candidate.size < smallest.size) {
            smallest = candidate;
            smallestQuality = quality;
          }
          if (candidate.size <= maxBytes) {
            bestWithinLimit = candidate;
            bestWithinQuality = quality;
            low = quality;
          } else {
            high = quality;
          }
        }
        if (bestWithinLimit) {
          blob = bestWithinLimit;
          quality = bestWithinQuality;
        } else {
          blob = smallest;
          quality = smallestQuality;
        }
      }

      if (
        maxBytes &&
        blob.size > maxBytes &&
        options.allowResize !== false
      ) {
        while (
          blob.size > maxBytes &&
          Math.max(workingCanvas.width, workingCanvas.height) > 480
        ) {
          const next = document.createElement("canvas");
          next.width = Math.max(1, Math.round(workingCanvas.width * 0.82));
          next.height = Math.max(1, Math.round(workingCanvas.height * 0.82));
          const context = next.getContext("2d");
          if (!context) break;
          context.drawImage(workingCanvas, 0, 0, next.width, next.height);
          workingCanvas = next;
          quality = minQuality;
          blob = await encodeCanvasWithFallback(
            workingCanvas,
            actualType === "image/webp" ? "image/webp" : "image/jpeg",
            quality,
          );
        }
      }

      actualType = blob.type as DrawingImageType;
      return {
        dataUrl: await blobToDataUrl(blob),
        blob,
        type: actualType,
        quality,
        bytes: blob.size,
        width: workingCanvas.width,
        height: workingCanvas.height,
        withinLimit: maxBytes === undefined || blob.size <= maxBytes,
      };
    },
    [],
  );

  const pushHistory = useCallback(
    (nextBackground = backgroundRef.current, emitChange = true) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // A new local edit wins over an older asynchronous restore/import.
      ++restoreGenerationRef.current;
      ++loadGenerationRef.current;

      const entry: HistoryEntry = {
        contentBlob: snapshotCanvasLayer(canvas),
        backgroundColor: nextBackground,
      };
      const historyLimit = clamp(Math.floor(maxHistory), 2, 100);
      let nextHistory = historyRef.current.slice(
        0,
        historyIndexRef.current + 1,
      );
      nextHistory.push(entry);
      if (nextHistory.length > historyLimit) {
        nextHistory = nextHistory.slice(nextHistory.length - historyLimit);
      }
      const historyByteLimit = getHistoryByteLimit();
      let retainedBytes = nextHistory.reduce(
        (total, item) => total + item.contentBlob.size,
        0,
      );
      while (nextHistory.length > 2 && retainedBytes > historyByteLimit) {
        retainedBytes -= nextHistory[0].contentBlob.size;
        nextHistory.shift();
      }

      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length - 1;
      setHistoryState({
        index: historyIndexRef.current,
        length: nextHistory.length,
      });

      if (emitChange) {
        emitChangeDataUrl(nextBackground);
      }
    },
    [emitChangeDataUrl, maxHistory],
  );

  const restoreHistory = useCallback(
    (nextIndex: number) => {
      const entry = historyRef.current[nextIndex];
      const canvas = canvasRef.current;
      if (!entry || !canvas) return;

      const generation = ++restoreGenerationRef.current;
      void decodeImageBlob(entry.contentBlob)
        .then((image) => {
          try {
            if (generation !== restoreGenerationRef.current) return;
            const currentCanvas = canvasRef.current;
            if (!currentCanvas) return;
            const currentContext = getContext(currentCanvas);
            if (!currentContext) {
              throw new Error("The drawing context is unavailable.");
            }

            // Do not clear the visible layer until the snapshot has decoded.
            // A failed WebP/createImageBitmap decode must leave the user's
            // current drawing intact.
            const restoredLayer = document.createElement("canvas");
            restoredLayer.width = currentCanvas.width;
            restoredLayer.height = currentCanvas.height;
            const restoredContext = restoredLayer.getContext("2d");
            if (!restoredContext) {
              throw new Error("The restored drawing context is unavailable.");
            }
            restoredContext.drawImage(image.source, 0, 0);

            currentContext.save();
            try {
              currentContext.globalCompositeOperation = "source-over";
              currentContext.clearRect(
                0,
                0,
                currentCanvas.width,
                currentCanvas.height,
              );
              currentContext.drawImage(restoredLayer, 0, 0);
            } finally {
              currentContext.restore();
            }

            historyIndexRef.current = nextIndex;
            setHistoryState({
              index: nextIndex,
              length: historyRef.current.length,
            });
            backgroundRef.current = entry.backgroundColor;
            setBackgroundColor(entry.backgroundColor);
            emitChangeDataUrl(entry.backgroundColor);
          } finally {
            image.close();
          }
        })
        .catch(() => {
          if (generation === restoreGenerationRef.current) {
            setStatus("That undo snapshot could not be restored");
          }
        });
    },
    [emitChangeDataUrl],
  );

  const undo = useCallback(() => {
    if (disabled || historyIndexRef.current <= 0) return;
    restoreHistory(historyIndexRef.current - 1);
    setStatus("Undid the last change");
  }, [disabled, restoreHistory]);

  const redo = useCallback(() => {
    if (
      disabled ||
      historyIndexRef.current >= historyRef.current.length - 1
    ) {
      return;
    }
    restoreHistory(historyIndexRef.current + 1);
    setStatus("Redid the change");
  }, [disabled, restoreHistory]);

  const clearCanvas = useCallback(() => {
    if (disabled) return;
    const canvas = canvasRef.current;
    const context = canvas ? getContext(canvas) : null;
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    pushHistory();
    setConfirmClear(false);
    setStatus("Canvas cleared");
  }, [disabled, pushHistory]);

  const loadBlob = useCallback(
    async (blob: Blob) => {
      const generation = ++loadGenerationRef.current;
      ++restoreGenerationRef.current;
      const validated = await validateImageBlob(blob);
      if (generation !== loadGenerationRef.current) return;
      const image = await decodeValidatedImage(validated);
      if (generation !== loadGenerationRef.current) {
        image.close();
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        image.close();
        return;
      }
      drawImageContained(canvas, image.source, image.width, image.height);
      image.close();
      pushHistory();
      setStatus("Image loaded");
    },
    [pushHistory],
  );

  const loadDataUrl = useCallback(
    async (dataUrl: string) => {
      // The encoded length is rejected before base64 bytes are allocated.
      await loadBlob(dataUrlToBlob(dataUrl));
    },
    [loadBlob],
  );

  const saveDraft = useCallback(async (): Promise<DrawingCanvasDraft> => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("The drawing canvas is not ready.");
    const blob = await encodeCanvasWithFallback(
      canvas,
      "image/webp",
      DRAFT_WEBP_QUALITY,
    );
    return {
      version: 1,
      width: canvas.width,
      height: canvas.height,
      backgroundColor: backgroundRef.current,
      layerDataUrl: await blobToDataUrl(blob),
      layerBytes: blob.size,
    };
  }, []);

  const loadDraft = useCallback(
    async (draftValue: DrawingCanvasDraft | string) => {
      let draft: DrawingCanvasDraft;
      try {
        draft =
          typeof draftValue === "string"
            ? (JSON.parse(draftValue) as DrawingCanvasDraft)
            : draftValue;
      } catch {
        throw new Error("The saved drawing draft is malformed.");
      }
      if (
        !draft ||
        draft.version !== 1 ||
        !Number.isInteger(draft.width) ||
        !Number.isInteger(draft.height) ||
        draft.width <= 0 ||
        draft.height <= 0 ||
        !/^#[0-9a-f]{6}$/i.test(draft.backgroundColor) ||
        typeof draft.layerDataUrl !== "string"
      ) {
        throw new Error("The saved drawing draft is invalid.");
      }

      const generation = ++loadGenerationRef.current;
      ++restoreGenerationRef.current;
      const blob = dataUrlToBlob(draft.layerDataUrl);
      if (
        Number.isFinite(draft.layerBytes) &&
        draft.layerBytes > 0 &&
        draft.layerBytes !== blob.size
      ) {
        throw new Error("The saved drawing draft is incomplete.");
      }
      const validated = await validateImageBlob(blob);
      if (
        validated.width !== draft.width ||
        validated.height !== draft.height
      ) {
        throw new Error("The saved drawing draft dimensions do not match.");
      }
      if (generation !== loadGenerationRef.current) return;
      const image = await decodeValidatedImage(validated);
      if (generation !== loadGenerationRef.current) {
        image.close();
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        image.close();
        return;
      }

      drawImageContained(canvas, image.source, image.width, image.height);
      image.close();
      historyRef.current = [];
      historyIndexRef.current = -1;
      backgroundRef.current = draft.backgroundColor;
      setBackgroundColor(draft.backgroundColor);
      setHistoryState({ index: -1, length: 0 });
      pushHistory(draft.backgroundColor);
      setStatus("Drawing draft restored");
    },
    [pushHistory],
  );

  const calculateFitZoom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return 1;
    const availableWidth = Math.max(1, viewport.clientWidth - 8);
    return clamp(availableWidth / Math.max(width, 1), MIN_ZOOM, MAX_ZOOM);
  }, [width]);

  const fit = useCallback(() => {
    setFitMode(true);
    setZoom(calculateFitZoom());
    setStatus("Canvas fitted to the window");
  }, [calculateFitZoom]);

  const changeZoom = useCallback((multiplier: number) => {
    setFitMode(false);
    setZoom((current) => clamp(current * multiplier, MIN_ZOOM, MAX_ZOOM));
  }, []);

  useImperativeHandle(
    forwardedRef,
    () => ({
      exportDataUrl: (type, quality) => exportDataUrl(type, quality),
      exportCompressed,
      saveDraft,
      loadDraft,
      loadDataUrl,
      clear: clearCanvas,
      undo,
      redo,
      fit,
      getCanvasElement: () => canvasRef.current,
    }),
    [
      clearCanvas,
      exportCompressed,
      exportDataUrl,
      fit,
      loadDataUrl,
      loadDraft,
      redo,
      saveDraft,
      undo,
    ],
  );

  useEffect(() => {
    const changeGeneration = changeGenerationRef;
    const restoreGeneration = restoreGenerationRef;
    const loadGeneration = loadGenerationRef;
    return () => {
      ++changeGeneration.current;
      ++restoreGeneration.current;
      ++loadGeneration.current;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const generation = ++loadGenerationRef.current;
    ++restoreGenerationRef.current;
    const context = getContext(canvas);
    context?.clearRect(0, 0, canvas.width, canvas.height);
    historyRef.current = [];
    historyIndexRef.current = -1;
    setHistoryState({ index: -1, length: 0 });
    backgroundRef.current = initialBackgroundColor;
    setBackgroundColor(initialBackgroundColor);

    if (!initialImageDataUrl) {
      pushHistory(initialBackgroundColor, false);
      return;
    }

    let decodedImage: DecodedImage | null = null;
    void Promise.resolve()
      .then(() => dataUrlToBlob(initialImageDataUrl))
      .then((blob) => validateImageBlob(blob))
      .then((validated) => decodeValidatedImage(validated))
      .then((image) => {
        decodedImage = image;
        if (generation !== loadGenerationRef.current || !canvasRef.current) {
          image.close();
          decodedImage = null;
          return;
        }
        drawImageContained(
          canvasRef.current,
          image.source,
          image.width,
          image.height,
        );
        image.close();
        decodedImage = null;
        pushHistory(initialBackgroundColor, false);
      })
      .catch(() => {
        decodedImage?.close();
        if (generation !== loadGenerationRef.current) return;
        setStatus("The starting image could not be loaded");
        pushHistory(initialBackgroundColor, false);
      });
  }, [
    height,
    initialBackgroundColor,
    initialImageDataUrl,
    pushHistory,
    width,
  ]);

  useEffect(() => {
    if (!fitMode) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateFit = () => setZoom(calculateFitZoom());
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [calculateFitZoom, fitMode]);

  const chooseTool = useCallback((nextTool: DrawingTool) => {
    setTool(nextTool);
    setStatus(`${TOOL_OPTIONS.find(({ tool }) => tool === nextTool)?.label} selected`);
    window.requestAnimationFrame(() => canvasRef.current?.focus());
  }, []);

  const drawBrushDot = useCallback(
    (
      context: CanvasRenderingContext2D,
      point: Point,
      gesture: Gesture,
      pressure: number,
    ) => {
      context.save();
      configureStroke(
        context,
        gesture.tool,
        gesture.color,
        gesture.size,
        pressure,
      );
      context.beginPath();
      context.arc(
        point.x,
        point.y,
        context.lineWidth / 2,
        0,
        Math.PI * 2,
      );
      context.fill();
      context.restore();
    },
    [],
  );

  const drawBrushSegment = useCallback(
    (
      context: CanvasRenderingContext2D,
      gesture: Gesture,
      nextPoint: Point,
      pressure: number,
    ) => {
      const nextMidpoint = midpoint(gesture.lastRaw, nextPoint);
      context.save();
      configureStroke(
        context,
        gesture.tool,
        gesture.color,
        gesture.size,
        pressure,
      );
      context.beginPath();
      context.moveTo(gesture.lastDrawn.x, gesture.lastDrawn.y);
      context.quadraticCurveTo(
        gesture.lastRaw.x,
        gesture.lastRaw.y,
        nextMidpoint.x,
        nextMidpoint.y,
      );
      context.stroke();
      context.restore();
      gesture.lastDrawn = nextMidpoint;
      gesture.lastRaw = nextPoint;
    },
    [],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (
        disabled ||
        !event.isPrimary ||
        gestureRef.current !== null ||
        (event.pointerType === "mouse" && event.button !== 0)
      ) {
        return;
      }

      event.preventDefault();
      const canvas = event.currentTarget;
      canvas.focus({ preventScroll: true });
      const point = getCanvasPoint(canvas, event.clientX, event.clientY);
      const selectedTool = toolRef.current;

      if (selectedTool === "fill") {
        if (floodFill(canvas, point, colorRef.current)) {
          pushHistory();
          setStatus("Area filled");
        }
        return;
      }

      if (selectedTool === "text") {
        const draft: TextDraft = {
          x: point.x,
          y: point.y,
          value: "",
          color: colorRef.current,
          fontSize: Math.max(16, brushSizeRef.current * 3),
        };
        textDraftRef.current = draft;
        setTextDraft(draft);
        setStatus("Type a label, then press Enter");
        return;
      }

      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; drawing still works without it.
      }

      const context = getContext(canvas);
      if (!context) return;
      const gesture: Gesture = {
        pointerId: event.pointerId,
        tool: selectedTool,
        start: point,
        lastRaw: point,
        lastDrawn: point,
        color: colorRef.current,
        size: brushSizeRef.current,
      };

      if (
        selectedTool === "line" ||
        selectedTool === "rectangle" ||
        selectedTool === "circle" ||
        selectedTool === "arrow"
      ) {
        gesture.snapshot = context.getImageData(0, 0, canvas.width, canvas.height);
      } else {
        drawBrushDot(context, point, gesture, event.pressure);
      }
      gestureRef.current = gesture;
    },
    [disabled, drawBrushDot, pushHistory],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault();

      const canvas = event.currentTarget;
      const context = getContext(canvas);
      if (!context) return;

      if (gesture.tool === "pen" || gesture.tool === "eraser") {
        const coalescedEvents = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
        for (const coalescedEvent of coalescedEvents) {
          drawBrushSegment(
            context,
            gesture,
            getCanvasPoint(
              canvas,
              coalescedEvent.clientX,
              coalescedEvent.clientY,
            ),
            coalescedEvent.pressure,
          );
        }
        return;
      }

      if (gesture.snapshot) {
        context.putImageData(gesture.snapshot, 0, 0);
      }
      const end = getCanvasPoint(canvas, event.clientX, event.clientY);
      drawShape(
        context,
        gesture.tool,
        gesture.start,
        end,
        gesture.color,
        gesture.size,
      );
      gesture.lastRaw = end;
    },
    [drawBrushSegment],
  );

  const finishGesture = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>, cancelled = false) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const canvas = event.currentTarget;
      const context = getContext(canvas);

      if (context && cancelled && gesture.snapshot) {
        context.putImageData(gesture.snapshot, 0, 0);
      } else if (context && gesture.snapshot) {
        context.putImageData(gesture.snapshot, 0, 0);
        drawShape(
          context,
          gesture.tool as "line" | "rectangle" | "circle" | "arrow",
          gesture.start,
          getCanvasPoint(canvas, event.clientX, event.clientY),
          gesture.color,
          gesture.size,
        );
      } else if (context && (gesture.tool === "pen" || gesture.tool === "eraser")) {
        const end = getCanvasPoint(canvas, event.clientX, event.clientY);
        if (
          Math.abs(end.x - gesture.lastRaw.x) > 0.01 ||
          Math.abs(end.y - gesture.lastRaw.y) > 0.01
        ) {
          drawBrushSegment(context, gesture, end, event.pressure);
        }
        // Complete the final half of the smoothed curve.
        context.save();
        configureStroke(
          context,
          gesture.tool,
          gesture.color,
          gesture.size,
          event.pressure,
        );
        context.beginPath();
        context.moveTo(gesture.lastDrawn.x, gesture.lastDrawn.y);
        context.quadraticCurveTo(
          gesture.lastRaw.x,
          gesture.lastRaw.y,
          gesture.lastRaw.x,
          gesture.lastRaw.y,
        );
        context.stroke();
        context.restore();
      }

      gestureRef.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (!cancelled || !gesture.snapshot) {
        pushHistory();
        setStatus("Drawing saved");
      }
    },
    [drawBrushSegment, pushHistory],
  );

  const commitText = useCallback(() => {
    const draft = textDraftRef.current;
    textDraftRef.current = null;
    setTextDraft(null);
    if (!draft?.value.trim()) {
      setStatus("Text cancelled");
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas ? getContext(canvas) : null;
    if (!canvas || !context) return;
    context.save();
    context.globalCompositeOperation = "source-over";
    context.fillStyle = draft.color;
    context.textBaseline = "top";
    context.font = `700 ${draft.fontSize}px "Comic Sans MS", "Trebuchet MS", sans-serif`;
    context.fillText(draft.value.trim(), draft.x, draft.y);
    context.restore();
    pushHistory();
    setStatus("Text added");
    window.requestAnimationFrame(() => canvas.focus());
  }, [pushHistory]);

  const cancelText = useCallback(() => {
    textDraftRef.current = null;
    setTextDraft(null);
    setStatus("Text cancelled");
    window.requestAnimationFrame(() => canvasRef.current?.focus());
  }, []);

  const handleBackgroundChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextBackground = event.target.value;
      backgroundRef.current = nextBackground;
      setBackgroundColor(nextBackground);
      pushHistory(nextBackground);
      setStatus("Background color changed");
    },
    [pushHistory],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      // Size, MIME signature, dimensions, and pixel count are checked before
      // createImageBitmap/Image is allowed to decode the file.
      void loadBlob(file).catch((error: unknown) => {
        setStatus(
          error instanceof Error
            ? error.message
            : "That image could not be opened",
        );
      });
    },
    [loadBlob],
  );

  const handleExport = useCallback(() => {
    const dataUrl = exportDataUrl();
    if (!dataUrl) return;
    onExportRef.current?.(dataUrl);
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = downloadFileName;
    link.click();
    setStatus("PNG downloaded");
  }, [downloadFileName, exportDataUrl]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (commandKey && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (commandKey && key === "s") {
        event.preventDefault();
        handleExport();
        return;
      }
      if (commandKey && key === "o") {
        event.preventDefault();
        fileInputRef.current?.click();
        return;
      }
      if (disabled) return;

      const shortcutTool = TOOL_OPTIONS.find(
        ({ shortcut }) => shortcut.toLowerCase() === key,
      )?.tool;
      if (shortcutTool) {
        event.preventDefault();
        chooseTool(shortcutTool);
      } else if (event.key === "[") {
        event.preventDefault();
        setBrushSize((current) =>
          clamp(current - 2, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE),
        );
      } else if (event.key === "]") {
        event.preventDefault();
        setBrushSize((current) =>
          clamp(current + 2, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE),
        );
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeZoom(1.2);
      } else if (event.key === "-") {
        event.preventDefault();
        changeZoom(1 / 1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        fit();
      }
    },
    [
      changeZoom,
      chooseTool,
      disabled,
      fit,
      handleExport,
      redo,
      undo,
    ],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      changeZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    [changeZoom],
  );

  const cursor =
    tool === "text" ? "text" : tool === "fill" ? "cell" : "crosshair";
  const canUndo = historyState.index > 0;
  const canRedo =
    historyState.index >= 0 && historyState.index < historyState.length - 1;

  return (
    <div
      className={cx(
        "drawing-canvas",
        "drawing-canvas-shell",
        disabled && "is-disabled",
        className,
      )}
      data-tool={tool}
      data-disabled={disabled || undefined}
      onKeyDown={handleKeyDown}
    >
      {showToolbar && (
        <div
          className={cx(
            "drawing-canvas__toolbar",
            "drawing-toolbar-row",
            toolbarClassName,
          )}
          role="toolbar"
          aria-label="Drawing tools"
        >
          <div className="drawing-canvas__tool-group" aria-label="Tools">
            {TOOL_OPTIONS.map((option) => (
              <button
                key={option.tool}
                type="button"
                className={cx(
                  "drawing-canvas__tool-button",
                  tool === option.tool && "is-active",
                )}
                data-tool={option.tool}
                aria-label={`${option.label} tool`}
                aria-pressed={tool === option.tool}
                title={`${option.label} (${option.shortcut})`}
                disabled={disabled}
                onClick={() => chooseTool(option.tool)}
              >
                <span className="drawing-canvas__tool-icon" aria-hidden="true">
                  {option.icon}
                </span>
                <span className="drawing-canvas__tool-label">{option.label}</span>
              </button>
            ))}
          </div>

          <div className="drawing-canvas__size-group">
            <label className="drawing-canvas__size-label" htmlFor={brushSizeId}>
              Size
            </label>
            <input
              id={brushSizeId}
              className="drawing-canvas__size-slider"
              type="range"
              min={MIN_BRUSH_SIZE}
              max={MAX_BRUSH_SIZE}
              value={brushSize}
              disabled={disabled}
              aria-label="Brush and eraser size"
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
            <output className="drawing-canvas__size-value" aria-live="off">
              {brushSize}px
            </output>
          </div>

          <div className="drawing-canvas__color-group" aria-label="Drawing color">
            <div className="drawing-canvas__palette drawing-palette">
              {QUICK_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  className={cx(
                    "drawing-canvas__swatch",
                    color.toLowerCase() === swatch.toLowerCase() && "is-active",
                  )}
                  style={{ backgroundColor: swatch }}
                  title={`Use ${swatch}`}
                  aria-label={`Use color ${swatch}`}
                  aria-pressed={color.toLowerCase() === swatch.toLowerCase()}
                  disabled={disabled}
                  onClick={() => setColor(swatch)}
                />
              ))}
            </div>
            <label className="drawing-canvas__color-picker-label">
              <span>Ink</span>
              <input
                className="drawing-canvas__color-picker"
                type="color"
                value={color}
                disabled={disabled}
                aria-label="Custom drawing color"
                onChange={(event) => setColor(event.target.value)}
              />
            </label>
            <label className="drawing-canvas__background-picker-label">
              <span>Paper</span>
              <input
                className="drawing-canvas__background-picker"
                type="color"
                value={backgroundColor}
                disabled={disabled}
                aria-label="Canvas background color"
                onChange={handleBackgroundChange}
              />
            </label>
          </div>

          <div className="drawing-canvas__history-group" aria-label="History">
            <button
              type="button"
              className="drawing-canvas__action-button"
              disabled={disabled || !canUndo}
              onClick={undo}
              title="Undo (Ctrl/⌘ Z)"
              aria-label="Undo"
            >
              ↶ <span>Undo</span>
            </button>
            <button
              type="button"
              className="drawing-canvas__action-button"
              disabled={disabled || !canRedo}
              onClick={redo}
              title="Redo (Ctrl/⌘ Shift Z)"
              aria-label="Redo"
            >
              ↷ <span>Redo</span>
            </button>
          </div>

          <div className="drawing-canvas__zoom-group" aria-label="Canvas zoom">
            <button
              type="button"
              className="drawing-canvas__action-button"
              onClick={() => changeZoom(1 / 1.2)}
              disabled={zoom <= MIN_ZOOM}
              title="Zoom out (-)"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="drawing-canvas__zoom-value"
              onClick={fit}
              title="Fit canvas (0)"
              aria-label={`Zoom ${Math.round(zoom * 100)} percent; fit canvas`}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="drawing-canvas__action-button"
              onClick={() => changeZoom(1.2)}
              disabled={zoom >= MAX_ZOOM}
              title="Zoom in (+)"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>

          <div className="drawing-canvas__file-group" aria-label="Canvas file actions">
            <input
              ref={fileInputRef}
              className="drawing-canvas__file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              tabIndex={-1}
              aria-hidden="true"
              disabled={disabled}
              onChange={handleFileChange}
              style={{ display: "none" }}
            />
            <button
              type="button"
              className="drawing-canvas__action-button"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              title="Open an image (Ctrl/⌘ O)"
            >
              Open
            </button>
            <button
              type="button"
              className="drawing-canvas__action-button drawing-canvas__clear-button"
              disabled={disabled}
              onClick={() => setConfirmClear(true)}
            >
              Clear
            </button>
            <button
              type="button"
              className="drawing-canvas__action-button drawing-canvas__export-button"
              onClick={handleExport}
              title="Download PNG (Ctrl/⌘ S)"
            >
              Download
            </button>
          </div>
        </div>
      )}

      <div
        ref={viewportRef}
        className="drawing-canvas__viewport drawing-canvas-viewport"
        onWheel={handleWheel}
        style={{ display: "block", overflow: "auto" }}
      >
        <div
          className="drawing-canvas__stage"
          style={{
            position: "relative",
            width: `${width * zoom}px`,
            height: `${height * zoom}px`,
            margin: "0 auto",
          }}
        >
          <canvas
            ref={canvasRef}
            className={cx("drawing-canvas__element", canvasClassName)}
            width={width}
            height={height}
            tabIndex={disabled ? -1 : 0}
            aria-label={ariaLabel}
            aria-disabled={disabled}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => finishGesture(event)}
            onPointerCancel={(event) => finishGesture(event, true)}
            onLostPointerCapture={(event) => finishGesture(event, true)}
            onContextMenu={(event) => event.preventDefault()}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              touchAction: "none",
              userSelect: "none",
              backgroundColor,
              cursor: disabled ? "not-allowed" : cursor,
            }}
          >
            Your browser does not support the drawing canvas.
          </canvas>

          {textDraft && (
            <input
              className="drawing-canvas__text-entry"
              type="text"
              value={textDraft.value}
              autoFocus
              aria-label="Text to place on the canvas"
              placeholder="Type, then Enter…"
              style={{
                position: "absolute",
                left: `${textDraft.x * zoom}px`,
                top: `${textDraft.y * zoom}px`,
                maxWidth: `${Math.max(120, (width - textDraft.x) * zoom)}px`,
                color: textDraft.color,
                // Mobile browsers zoom the whole page when a focused input is
                // rendered below 16 CSS pixels. Keep the editor readable; the
                // committed canvas text still uses the selected logical size.
                fontSize: `${Math.max(16, textDraft.fontSize * zoom)}px`,
              }}
              onChange={(event) => {
                const nextDraft = { ...textDraft, value: event.target.value };
                textDraftRef.current = nextDraft;
                setTextDraft(nextDraft);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitText();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelText();
                }
              }}
              onBlur={commitText}
            />
          )}
        </div>
      </div>

      {confirmClear && (
        <div className="drawing-canvas__confirm-backdrop">
          <div
            className="drawing-canvas__confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={clearTitleId}
            aria-describedby={clearDescriptionId}
          >
            <h3 id={clearTitleId}>Clear the whole canvas?</h3>
            <p id={clearDescriptionId}>
              Your current drawing will be removed. You can still undo afterward.
            </p>
            <div className="drawing-canvas__confirm-actions">
              <button
                type="button"
                className="drawing-canvas__action-button"
                autoFocus
                onClick={() => setConfirmClear(false)}
              >
                Keep drawing
              </button>
              <button
                type="button"
                className="drawing-canvas__action-button drawing-canvas__danger-button"
                onClick={clearCanvas}
              >
                Yes, clear it
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="drawing-canvas__status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
});

DrawingCanvas.displayName = "DrawingCanvas";

export default DrawingCanvas;
