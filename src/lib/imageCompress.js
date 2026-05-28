import { encode as encodeAvif } from "@jsquash/avif";
import { encode as encodeJpeg } from "@jsquash/jpeg";
import { optimise as optimisePng } from "@jsquash/oxipng";
import { encode as encodeWebp } from "@jsquash/webp";

const MAX_COMPARE_EDGE = 720;
const MAX_ANALYZE_EDGE = 420;
const MAX_CANVAS_PIXELS = 30000000;

const MIME_EXTENSIONS = {
  "image/avif": "avif",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

const MIME_LABELS = {
  "image/avif": "AVIF",
  "image/webp": "WebP",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
};

const MODE_CONFIGS = {
  careful: {
    photoThreshold: 0.996,
    graphicThreshold: 0.998,
    photoMaxAverageDelta: 1.8,
    graphicMaxAverageDelta: 0.9,
    passes: 6,
    minQuality: { "image/avif": 0.44, "image/webp": 0.58, "image/jpeg": 0.58 },
    maxQuality: { "image/avif": 0.92, "image/webp": 0.96, "image/jpeg": 0.96 },
  },
  extreme: {
    photoThreshold: 0.992,
    graphicThreshold: 0.996,
    photoMaxAverageDelta: 3.2,
    graphicMaxAverageDelta: 1.55,
    passes: 7,
    minQuality: { "image/avif": 0.26, "image/webp": 0.38, "image/jpeg": 0.42 },
    maxQuality: { "image/avif": 0.9, "image/webp": 0.94, "image/jpeg": 0.94 },
  },
  ultra: {
    photoThreshold: 0.985,
    graphicThreshold: 0.992,
    photoMaxAverageDelta: 5.4,
    graphicMaxAverageDelta: 2.8,
    passes: 7,
    minQuality: { "image/avif": 0.18, "image/webp": 0.28, "image/jpeg": 0.32 },
    maxQuality: { "image/avif": 0.88, "image/webp": 0.92, "image/jpeg": 0.92 },
  },
};

export async function compressImageFile(file, options = {}) {
  if (!file || !file.type?.startsWith("image/")) {
    throw new Error("请选择图片文件。");
  }

  if (/svg|gif/i.test(file.type)) {
    throw new Error("暂不处理 SVG 或动图，避免把矢量/动画压成静态位图。");
  }

  const mode = MODE_CONFIGS[options.mode] ? options.mode : "extreme";
  const config = MODE_CONFIGS[mode];
  const outputMode = options.outputMode === "smallest" ? "smallest" : "original";
  const startedAt = performance.now();
  const source = await decodeImage(file);
  const originalWidth = source.width;
  const originalHeight = source.height;

  if (!originalWidth || !originalHeight) {
    closeBitmap(source);
    throw new Error("图片尺寸无效。");
  }

  const analyzeCanvas = createFittedCanvas(originalWidth, originalHeight, MAX_ANALYZE_EDGE);
  const analyzeContext = getCanvasContext(analyzeCanvas, true);
  drawImage(analyzeContext, source, analyzeCanvas.width, analyzeCanvas.height);
  const analysis = analyzeImage(analyzeContext.getImageData(0, 0, analyzeCanvas.width, analyzeCanvas.height));
  const targetSize = resolveTargetSize(originalWidth, originalHeight, options.dimensionMode, analysis.kind);
  const sourceCanvas = createCanvas(targetSize.width, targetSize.height);
  const sourceContext = getCanvasContext(sourceCanvas, true);
  drawImage(sourceContext, source, targetSize.width, targetSize.height);
  closeBitmap(source);
  const sourceData = sourceContext.getImageData(0, 0, targetSize.width, targetSize.height);

  const compareSize = fitSize(targetSize.width, targetSize.height, MAX_COMPARE_EDGE);
  const baselineCanvas = createCanvas(compareSize.width, compareSize.height);
  const baselineContext = getCanvasContext(baselineCanvas, true);
  baselineContext.drawImage(sourceCanvas, 0, 0, compareSize.width, compareSize.height);
  const baselineData = baselineContext.getImageData(0, 0, compareSize.width, compareSize.height);
  const targetAnalysis = analyzeImage(baselineData);
  const hasAlpha = targetAnalysis.alphaRatio > 0.0005;
  const threshold = analysis.kind === "graphic" ? config.graphicThreshold : config.photoThreshold;
  const maxAverageDelta = analysis.kind === "graphic" ? config.graphicMaxAverageDelta : config.photoMaxAverageDelta;
  const plans = buildCandidatePlans(file.type, hasAlpha, analysis.kind, outputMode);
  const candidates = [];

  for (const plan of plans) {
    if (plan.mime === "image/png") {
      const candidate = await encodePngCandidate(sourceCanvas);
      if (candidate) {
        candidates.push({
          ...candidate,
          accepted: true,
          reason: "lossless",
          metrics: { ssim: 1, averageDelta: 0, maxDelta: 0 },
        });
      }
      continue;
    }

    const candidate = await optimizeLossyCandidate(sourceCanvas, sourceData, baselineData, plan.mime, {
      threshold,
      maxAverageDelta,
      minQuality: config.minQuality[plan.mime],
      maxQuality: config.maxQuality[plan.mime],
      passes: config.passes,
    });

    if (candidate) {
      candidates.push(candidate);
    }
  }

  const accepted = candidates.filter((candidate) => candidate.accepted);
  const smallerAccepted = accepted.filter((candidate) => candidate.blob.size < file.size);
  const best = (smallerAccepted.length ? smallerAccepted : accepted).sort((left, right) => {
    if (left.blob.size !== right.blob.size) return left.blob.size - right.blob.size;
    return (right.metrics?.ssim || 0) - (left.metrics?.ssim || 0);
  })[0];
  const selected = best && best.blob.size <= file.size ? best : createOriginalCandidate(file);
  const outputName = selected.original
    ? file.name
    : buildOutputName(file.name, selected.mime, {
        outputMode,
        keepOriginalExtension: options.keepOriginalExtension === true,
      });

  return {
    blob: selected.blob,
    name: outputName,
    mime: selected.mime || file.type || "application/octet-stream",
    format: MIME_LABELS[selected.mime] || selected.mime || "原图",
    originalBytes: file.size,
    compressedBytes: selected.blob.size,
    originalWidth,
    originalHeight,
    width: targetSize.width,
    height: targetSize.height,
    score: Math.round((selected.metrics?.ssim ?? 1) * 10000) / 100,
    ssim: selected.metrics?.ssim ?? 1,
    averageDelta: selected.metrics?.averageDelta ?? 0,
    maxDelta: selected.metrics?.maxDelta ?? 0,
    quality: selected.quality ?? null,
    mode,
    outputMode,
    contentKind: analysis.kind,
    hasAlpha,
    noGain: Boolean(selected.original),
    resized: targetSize.width !== originalWidth || targetSize.height !== originalHeight,
    durationMs: Math.round(performance.now() - startedAt),
    candidates: candidates.map((candidate) => ({
      format: MIME_LABELS[candidate.mime] || candidate.mime,
      mime: candidate.mime,
      bytes: candidate.blob?.size || 0,
      quality: candidate.quality ?? null,
      score: Math.round((candidate.metrics?.ssim ?? 0) * 10000) / 100,
      averageDelta: Math.round((candidate.metrics?.averageDelta ?? 0) * 100) / 100,
      accepted: Boolean(candidate.accepted),
      reason: candidate.reason || "",
    })),
  };
}

function buildCandidatePlans(inputMime, hasAlpha, kind, outputMode) {
  if (outputMode === "original") {
    const normalized = normalizeInputMime(inputMime, hasAlpha);
    return normalized ? [{ mime: normalized }] : [{ mime: "image/png" }];
  }

  const plans = [];

  plans.push({ mime: "image/avif" });
  plans.push({ mime: "image/webp" });

  if (!hasAlpha) {
    plans.push({ mime: "image/jpeg" });
  }

  if (hasAlpha || kind === "graphic" || /png/i.test(inputMime)) {
    plans.push({ mime: "image/png" });
  }

  return plans;
}

function normalizeInputMime(inputMime, hasAlpha) {
  const mime = String(inputMime || "").toLowerCase();
  if (mime === "image/jpg" || mime === "image/jpeg") return hasAlpha ? "image/png" : "image/jpeg";
  if (mime === "image/png") return "image/png";
  if (mime === "image/webp") return "image/webp";
  if (mime === "image/avif") return "image/avif";
  return hasAlpha ? "image/png" : "image/jpeg";
}

async function optimizeLossyCandidate(canvas, sourceData, baselineData, mime, options) {
  const maxBlob = await encodeImage(sourceData, canvas, mime, options.maxQuality);
  if (!maxBlob) return null;

  const maxScored = await scoreBlob(maxBlob, mime, options.maxQuality, baselineData, options);
  if (!maxScored.accepted) {
    return { ...maxScored, reason: "quality-threshold" };
  }

  const minBlob = await encodeImage(sourceData, canvas, mime, options.minQuality);
  if (!minBlob) return maxScored;

  const minScored = await scoreBlob(minBlob, mime, options.minQuality, baselineData, options);
  if (minScored.accepted) return minScored;

  let low = options.minQuality;
  let high = options.maxQuality;
  let best = maxScored;

  for (let index = 0; index < options.passes; index += 1) {
    const quality = (low + high) / 2;
    const blob = await encodeImage(sourceData, canvas, mime, quality);
    if (!blob) break;

    const scored = await scoreBlob(blob, mime, quality, baselineData, options);
    if (scored.accepted) {
      best = scored;
      high = quality;
    } else {
      low = quality;
    }
  }

  return best;
}

async function encodePngCandidate(canvas) {
  const blob = await encodePng(canvas);
  if (!blob) return null;

  return {
    blob,
    mime: "image/png",
    quality: null,
  };
}

async function scoreBlob(blob, mime, quality, baselineData, options) {
  const bitmap = await decodeImage(blob);
  const compareCanvas = createCanvas(baselineData.width, baselineData.height);
  const compareContext = getCanvasContext(compareCanvas, true);
  drawImage(compareContext, bitmap, baselineData.width, baselineData.height);
  closeBitmap(bitmap);

  const encodedData = compareContext.getImageData(0, 0, baselineData.width, baselineData.height);
  const metrics = compareImageData(baselineData, encodedData);
  const accepted = metrics.ssim >= options.threshold && metrics.averageDelta <= options.maxAverageDelta;

  return {
    blob,
    mime,
    quality,
    metrics,
    accepted,
  };
}

async function encodeImage(imageData, canvas, mime, quality) {
  const wasmBlob = await encodeWithWasm(imageData, mime, quality);
  if (wasmBlob) return wasmBlob;

  return encodeCanvas(canvas, mime, quality);
}

async function encodeWithWasm(imageData, mime, quality) {
  try {
    if (mime === "image/avif") {
      const buffer = await encodeAvif(imageData, {
        quality: qualityToPercent(quality),
        qualityAlpha: qualityToPercent(Math.max(quality, 0.75)),
        speed: 6,
        subsample: 1,
        bitDepth: 8,
        lossless: false,
      });
      return new Blob([buffer], { type: mime });
    }

    if (mime === "image/webp") {
      const buffer = await encodeWebp(imageData, {
        quality: qualityToPercent(quality),
        method: 5,
        pass: 4,
        sns_strength: 58,
        filter_strength: 45,
        alpha_quality: 100,
        use_sharp_yuv: 1,
      });
      return new Blob([buffer], { type: mime });
    }

    if (mime === "image/jpeg") {
      const buffer = await encodeJpeg(imageData, {
        quality: qualityToPercent(quality),
        progressive: true,
        optimize_coding: true,
        quant_table: 3,
        trellis_multipass: true,
        trellis_opt_zero: true,
        trellis_opt_table: true,
        trellis_loops: 1,
        auto_subsample: true,
        separate_chroma_quality: true,
        chroma_quality: Math.max(qualityToPercent(quality) - 4, 50),
      });
      return new Blob([buffer], { type: mime });
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function encodePng(canvas) {
  const pngBlob = await encodeCanvas(canvas, "image/png");
  if (!pngBlob) return null;

  try {
    const buffer = await optimisePng(await pngBlob.arrayBuffer(), {
      level: 4,
      interlace: false,
      optimiseAlpha: true,
    });
    return new Blob([buffer], { type: "image/png" });
  } catch (error) {
    return pngBlob;
  }
}

function qualityToPercent(value) {
  return Math.max(1, Math.min(100, Math.round(value * 100)));
}

async function encodeCanvas(canvas, mime, quality) {
  const blob = await canvasToBlob(canvas, mime, quality);
  if (!blob || !blob.size) return null;

  const encodedType = (blob.type || "").toLowerCase();
  if (mime !== "image/png" && encodedType && encodedType !== mime) return null;
  if (!encodedType && mime === "image/avif") return null;

  return new Blob([blob], { type: encodedType || mime });
}

async function canvasToBlob(canvas, mime, quality) {
  try {
    if (typeof canvas.convertToBlob === "function") {
      return await canvas.convertToBlob({ type: mime, quality });
    }

    if (typeof canvas.toBlob === "function") {
      return await new Promise((resolve) => {
        canvas.toBlob(resolve, mime, quality);
      });
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (error) {
      return createImageBitmap(blob);
    }
  }

  if (typeof Image !== "undefined" && typeof URL !== "undefined") {
    return loadImageElement(blob);
  }

  throw new Error("当前浏览器无法解码这张图片。");
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败。"));
    };
    image.src = url;
  });
}

function createFittedCanvas(width, height, maxEdge) {
  const size = fitSize(width, height, maxEdge);
  return createCanvas(size.width, size.height);
}

function fitSize(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!maxEdge || longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  throw new Error("当前浏览器不支持 Canvas。");
}

function getCanvasContext(canvas, willReadFrequently = false) {
  const context = canvas.getContext("2d", {
    alpha: true,
    willReadFrequently,
  });

  if (!context) throw new Error("当前浏览器无法创建 Canvas 上下文。");

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

function drawImage(context, image, width, height) {
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
}

function resolveTargetSize(width, height, dimensionMode, kind) {
  const longest = Math.max(width, height);
  let maxEdge = 0;

  if (dimensionMode === "smart" || !dimensionMode) {
    maxEdge = kind === "photo" ? 2560 : 0;
  } else if (dimensionMode !== "original") {
    maxEdge = Number(dimensionMode) || 0;
  }

  const edgeScale = maxEdge && longest > maxEdge ? maxEdge / longest : 1;
  const pixelScale = width * height > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / (width * height)) : 1;
  const scale = Math.min(1, edgeScale, pixelScale);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function analyzeImage(imageData) {
  const { data, width, height } = imageData;
  const total = width * height;
  const unique = new Set();
  let alphaPixels = 0;
  let sampled = 0;
  const sampleStep = Math.max(1, Math.floor(total / 12000));

  for (let pixel = 0; pixel < total; pixel += sampleStep) {
    const offset = pixel * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];

    if (alpha < 250) alphaPixels += 1;
    unique.add(`${red >> 4},${green >> 4},${blue >> 4},${alpha >> 5}`);
    sampled += 1;
  }

  let strongEdges = 0;
  let edgeSamples = 0;
  const xStep = Math.max(1, Math.floor(width / 180));
  const yStep = Math.max(1, Math.floor(height / 180));

  for (let y = yStep; y < height; y += yStep) {
    for (let x = xStep; x < width; x += xStep) {
      const current = lumaAt(data, width, x, y);
      const left = lumaAt(data, width, x - xStep, y);
      const top = lumaAt(data, width, x, y - yStep);
      if (Math.abs(current - left) + Math.abs(current - top) > 74) strongEdges += 1;
      edgeSamples += 1;
    }
  }

  const colorDiversity = sampled ? unique.size / sampled : 1;
  const edgeDensity = edgeSamples ? strongEdges / edgeSamples : 0;
  const kind = colorDiversity < 0.18 || edgeDensity > 0.28 ? "graphic" : "photo";

  return {
    kind,
    colorDiversity,
    edgeDensity,
    alphaRatio: sampled ? alphaPixels / sampled : 0,
  };
}

function lumaAt(data, width, x, y) {
  const offset = (y * width + x) * 4;
  const alpha = data[offset + 3] / 255;
  const red = data[offset] * alpha + 255 * (1 - alpha);
  const green = data[offset + 1] * alpha + 255 * (1 - alpha);
  const blue = data[offset + 2] * alpha + 255 * (1 - alpha);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function compareImageData(left, right) {
  const leftData = left.data;
  const rightData = right.data;
  const count = left.width * left.height;
  let leftSum = 0;
  let rightSum = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  let productSum = 0;
  let deltaSum = 0;
  let maxDelta = 0;

  for (let pixel = 0; pixel < count; pixel += 1) {
    const offset = pixel * 4;
    const leftLuma = visualLuma(leftData, offset);
    const rightLuma = visualLuma(rightData, offset);
    const delta = Math.abs(leftLuma - rightLuma);

    leftSum += leftLuma;
    rightSum += rightLuma;
    leftSquares += leftLuma * leftLuma;
    rightSquares += rightLuma * rightLuma;
    productSum += leftLuma * rightLuma;
    deltaSum += delta;
    if (delta > maxDelta) maxDelta = delta;
  }

  const leftMean = leftSum / count;
  const rightMean = rightSum / count;
  const leftVariance = leftSquares / count - leftMean * leftMean;
  const rightVariance = rightSquares / count - rightMean * rightMean;
  const covariance = productSum / count - leftMean * rightMean;
  const c1 = 6.5025;
  const c2 = 58.5225;
  const ssim = ((2 * leftMean * rightMean + c1) * (2 * covariance + c2)) /
    ((leftMean * leftMean + rightMean * rightMean + c1) * (leftVariance + rightVariance + c2));

  return {
    ssim: clamp(ssim, 0, 1),
    averageDelta: deltaSum / count,
    maxDelta,
  };
}

function visualLuma(data, offset) {
  const alpha = data[offset + 3] / 255;
  const red = data[offset] * alpha + 255 * (1 - alpha);
  const green = data[offset + 1] * alpha + 255 * (1 - alpha);
  const blue = data[offset + 2] * alpha + 255 * (1 - alpha);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function createOriginalCandidate(file) {
  return {
    blob: file,
    mime: file.type,
    original: true,
    metrics: { ssim: 1, averageDelta: 0, maxDelta: 0 },
  };
}

function buildOutputName(name, mime, options = {}) {
  const extension = MIME_EXTENSIONS[mime] || "img";
  const baseName = String(name || "image").replace(/\.[^.]+$/, "") || "image";
  const originalExtension = getOriginalExtension(name);
  const finalExtension = (options.keepOriginalExtension || options.outputMode === "original") && originalExtension ? originalExtension : extension;
  return `${baseName}.min.${finalExtension}`;
}

function getOriginalExtension(name) {
  const match = String(name || "").match(/\.([a-z0-9]+)$/i);
  if (!match) return "";

  const value = match[1].toLowerCase();
  if (value === "jpeg") return "jpg";
  if (["jpg", "png", "webp", "avif"].includes(value)) return value;
  return "";
}

function closeBitmap(bitmap) {
  if (typeof bitmap?.close === "function") {
    bitmap.close();
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
