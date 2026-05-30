<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { zipSync } from "fflate";

const MIN_BOX_SIZE = 12;

const fileInput = ref(null);
const stageRef = ref(null);
const imageRef = ref(null);
const sourceImage = ref(null);
const feedback = reactive({ message: "", type: "" });
const busy = ref(false);
const source = reactive({
  file: null,
  url: "",
  name: "",
  width: 0,
  height: 0,
  bytes: 0,
});
const boxes = ref([]);
const selectedIds = ref(new Set());
const activeBoxId = ref("");
const stage = reactive({
  width: 0,
  height: 0,
  imageWidth: 0,
  imageHeight: 0,
  offsetX: 0,
  offsetY: 0,
  scale: 1,
});
const gridOptions = reactive({
  rows: 4,
  cols: 6,
  marginTop: 0,
  marginRight: 0,
  marginBottom: 0,
  marginLeft: 0,
  gapX: 0,
  gapY: 0,
});
const processOptions = reactive({
  trimWhitespace: true,
  square: true,
  transparentWhite: false,
  transparentThreshold: 248,
  padding: 10,
  outputSize: 512,
  fit: "contain",
  format: "png",
  quality: 0.92,
  background: "#ffffff",
  filenamePrefix: "image",
});
const previewToken = ref(0);
let dragState = null;
let resizeObserver = null;

const ready = computed(() => Boolean(source.url && sourceImage.value));
const sortedBoxes = computed(() => [...boxes.value].sort((left, right) => left.y === right.y ? left.x - right.x : left.y - right.y));
const selectedCount = computed(() => selectedIds.value.size);
const exportBoxes = computed(() => sortedBoxes.value.filter((box) => selectedIds.value.has(box.id)));
const stageImageStyle = computed(() => ({
  width: `${stage.imageWidth}px`,
  height: `${stage.imageHeight}px`,
  transform: `translate(${stage.offsetX}px, ${stage.offsetY}px)`,
}));
const cropLayerStyle = computed(() => ({
  width: `${stage.imageWidth}px`,
  height: `${stage.imageHeight}px`,
  transform: `translate(${stage.offsetX}px, ${stage.offsetY}px)`,
}));

function setFeedback(message, type = "") {
  feedback.message = message;
  feedback.type = type;
}

function chooseFile() {
  fileInput.value?.click();
}

function handleFileChange(event) {
  setSourceFile(event.target.files?.[0]);
}

function handleDrop(event) {
  setSourceFile(event.dataTransfer?.files?.[0]);
}

async function setSourceFile(file) {
  if (!file || !file.type?.startsWith("image/")) {
    setFeedback("请选择图片文件。", "warning");
    return;
  }

  clearSource(false);
  source.file = file;
  source.url = URL.createObjectURL(file);
  source.name = file.name;
  source.bytes = file.size;
  setFeedback("正在读取图片...");

  try {
    const image = await loadImage(source.url);
    sourceImage.value = image;
    source.width = image.naturalWidth || image.width;
    source.height = image.naturalHeight || image.height;
    await nextTick();
    measureStage();
    applyGrid();
    setFeedback(`已读取 ${source.width} x ${source.height} 图片，生成 ${boxes.value.length} 个裁剪框。`, "success");
  } catch (error) {
    clearSource(false);
    setFeedback("图片读取失败，请换一张图片。", "error");
  }
}

function clearSource(showFeedback = true) {
  if (source.url) URL.revokeObjectURL(source.url);
  source.file = null;
  source.url = "";
  source.name = "";
  source.width = 0;
  source.height = 0;
  source.bytes = 0;
  sourceImage.value = null;
  boxes.value = [];
  selectedIds.value = new Set();
  activeBoxId.value = "";
  previewToken.value += 1;
  if (fileInput.value) fileInput.value.value = "";
  if (showFeedback) setFeedback("已清空。", "success");
}

function measureStage() {
  if (!stageRef.value || !source.width || !source.height) return;
  const rect = stageRef.value.getBoundingClientRect();
  const availableWidth = Math.max(1, rect.width);
  const availableHeight = Math.max(260, Math.min(window.innerHeight * 0.64, 720));
  const scale = Math.min(availableWidth / source.width, availableHeight / source.height, 1);
  stage.scale = scale;
  stage.width = availableWidth;
  stage.height = availableHeight;
  stage.imageWidth = Math.max(1, Math.round(source.width * scale));
  stage.imageHeight = Math.max(1, Math.round(source.height * scale));
  stage.offsetX = Math.max(0, Math.round((availableWidth - stage.imageWidth) / 2));
  stage.offsetY = Math.max(0, Math.round((availableHeight - stage.imageHeight) / 2));
}

function applyGrid() {
  if (!ready.value) {
    setFeedback("请先上传图片。", "warning");
    return;
  }

  boxes.value = buildGridBoxes();
  selectAll();
  setFeedback(`已生成 ${boxes.value.length} 个网格裁剪框。`, "success");
}

function buildGridBoxes() {
  const rows = clampInteger(gridOptions.rows, 1, 60);
  const cols = clampInteger(gridOptions.cols, 1, 60);
  const left = clampNumber(gridOptions.marginLeft, 0, source.width - MIN_BOX_SIZE);
  const top = clampNumber(gridOptions.marginTop, 0, source.height - MIN_BOX_SIZE);
  const right = clampNumber(gridOptions.marginRight, 0, source.width - left - MIN_BOX_SIZE);
  const bottom = clampNumber(gridOptions.marginBottom, 0, source.height - top - MIN_BOX_SIZE);
  const gapX = Math.max(0, Number(gridOptions.gapX) || 0);
  const gapY = Math.max(0, Number(gridOptions.gapY) || 0);
  const availableWidth = Math.max(cols * MIN_BOX_SIZE, source.width - left - right - (cols - 1) * gapX);
  const availableHeight = Math.max(rows * MIN_BOX_SIZE, source.height - top - bottom - (rows - 1) * gapY);
  const cellWidth = availableWidth / cols;
  const cellHeight = availableHeight / rows;
  const result = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      result.push(createBox({
        x: Math.round(left + col * (cellWidth + gapX)),
        y: Math.round(top + row * (cellHeight + gapY)),
        width: Math.round(cellWidth),
        height: Math.round(cellHeight),
      }));
    }
  }

  return result;
}

function createBox(rect) {
  return normalizeBox({
    id: `crop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

function normalizeBox(box) {
  const width = clampNumber(box.width, MIN_BOX_SIZE, source.width || box.width);
  const height = clampNumber(box.height, MIN_BOX_SIZE, source.height || box.height);
  const x = clampNumber(box.x, 0, Math.max(0, (source.width || box.x + width) - width));
  const y = clampNumber(box.y, 0, Math.max(0, (source.height || box.y + height) - height));
  return {
    ...box,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function getBoxStyle(box) {
  return {
    left: `${box.x * stage.scale}px`,
    top: `${box.y * stage.scale}px`,
    width: `${box.width * stage.scale}px`,
    height: `${box.height * stage.scale}px`,
  };
}

function selectBox(box, event) {
  const next = new Set(selectedIds.value);
  if (event?.shiftKey || event?.ctrlKey || event?.metaKey) {
    if (next.has(box.id)) next.delete(box.id);
    else next.add(box.id);
  } else {
    next.clear();
    next.add(box.id);
  }
  selectedIds.value = next;
  activeBoxId.value = box.id;
}

function selectAll() {
  selectedIds.value = new Set(boxes.value.map((box) => box.id));
  activeBoxId.value = boxes.value[0]?.id || "";
}

function invertSelection() {
  const next = new Set();
  boxes.value.forEach((box) => {
    if (!selectedIds.value.has(box.id)) next.add(box.id);
  });
  selectedIds.value = next;
  activeBoxId.value = [...next][0] || "";
}

function clearSelection() {
  selectedIds.value = new Set();
  activeBoxId.value = "";
}

function deleteSelected() {
  if (!selectedIds.value.size) return;
  boxes.value = boxes.value.filter((box) => !selectedIds.value.has(box.id));
  clearSelection();
  setFeedback("已删除选中的裁剪框。", "success");
}

function startDrag(box, event) {
  if (!ready.value || event.button !== 0) return;
  selectBox(box, event);
  dragState = {
    type: "move",
    id: box.id,
    startX: event.clientX,
    startY: event.clientY,
    origin: { ...box },
  };
  capturePointer(event);
}

function startResize(box, handle, event) {
  if (!ready.value || event.button !== 0) return;
  selectBox(box, event);
  dragState = {
    type: "resize",
    id: box.id,
    handle,
    startX: event.clientX,
    startY: event.clientY,
    origin: { ...box },
  };
  capturePointer(event);
}

function capturePointer(event) {
  event.preventDefault();
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", stopPointerAction, { once: true });
}

function handlePointerMove(event) {
  if (!dragState) return;
  const dx = (event.clientX - dragState.startX) / stage.scale;
  const dy = (event.clientY - dragState.startY) / stage.scale;

  boxes.value = boxes.value.map((box) => {
    if (box.id !== dragState.id) return box;
    if (dragState.type === "move") {
      return normalizeBox({
        ...box,
        x: dragState.origin.x + dx,
        y: dragState.origin.y + dy,
      });
    }
    return resizeBox(dragState.origin, dragState.handle, dx, dy);
  });
}

function stopPointerAction() {
  window.removeEventListener("pointermove", handlePointerMove);
  dragState = null;
}

function resizeBox(origin, handle, dx, dy) {
  let { x, y, width, height } = origin;
  if (handle.includes("e")) width += dx;
  if (handle.includes("s")) height += dy;
  if (handle.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (handle.includes("n")) {
    y += dy;
    height -= dy;
  }

  if (width < MIN_BOX_SIZE) {
    if (handle.includes("w")) x -= MIN_BOX_SIZE - width;
    width = MIN_BOX_SIZE;
  }
  if (height < MIN_BOX_SIZE) {
    if (handle.includes("n")) y -= MIN_BOX_SIZE - height;
    height = MIN_BOX_SIZE;
  }

  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  if (x + width > source.width) width = source.width - x;
  if (y + height > source.height) height = source.height - y;

  return normalizeBox({ ...origin, x, y, width, height });
}

async function downloadOne(box, index) {
  try {
    const blob = await renderCropBlob(box);
    const url = URL.createObjectURL(blob);
    triggerDownload(url, buildOutputName(index));
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    setFeedback("单张图片已开始下载。", "success");
  } catch (error) {
    setFeedback("生成单张图片失败。", "error");
  }
}

async function downloadZip() {
  if (!exportBoxes.value.length) {
    setFeedback("请至少选择一个裁剪框。", "warning");
    return;
  }

  busy.value = true;
  setFeedback("正在生成裁剪图片并打包...");

  try {
    const files = {};
    const usedNames = new Set();
    const sourceContext = processOptions.trimWhitespace ? getSourceContext() : null;
    for (let index = 0; index < exportBoxes.value.length; index += 1) {
      const blob = await renderCropBlob(exportBoxes.value[index], sourceContext);
      const buffer = await blob.arrayBuffer();
      files[getUniqueZipName(buildOutputName(index + 1), usedNames)] = new Uint8Array(buffer);
    }
    const zipData = zipSync(files, { level: 0 });
    const zipBlob = new Blob([zipData], { type: "application/zip" });
    const url = URL.createObjectURL(zipBlob);
    triggerDownload(url, `${safeBaseName(source.name || "image")}-crop.zip`);
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    setFeedback(`已打包 ${exportBoxes.value.length} 张图片。`, "success");
  } catch (error) {
    setFeedback(error.message || "打包失败。", "error");
  } finally {
    busy.value = false;
  }
}

async function renderCropBlob(box, reusableSourceContext = null) {
  const trimmed = processOptions.trimWhitespace ? trimBoxWhitespace(reusableSourceContext || getSourceContext(), box, 250) : box;
  const sourceCanvas = createCanvas(trimmed.width, trimmed.height);
  const sourceContext = sourceCanvas.getContext("2d");
  sourceContext.drawImage(
    sourceImage.value,
    trimmed.x,
    trimmed.y,
    trimmed.width,
    trimmed.height,
    0,
    0,
    trimmed.width,
    trimmed.height,
  );

  if (processOptions.transparentWhite) {
    makeWhiteTransparent(sourceContext, trimmed.width, trimmed.height, processOptions.transparentThreshold);
  }

  const output = resolveOutputSize(trimmed.width, trimmed.height);
  const canvas = createCanvas(output.width, output.height);
  const context = canvas.getContext("2d");
  if (!(processOptions.format === "png" && processOptions.transparentWhite)) {
    context.fillStyle = processOptions.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  drawFittedImage(context, sourceCanvas, output);

  return canvasToBlob(canvas, getOutputMime(), processOptions.quality);
}

function getSourceContext() {
  const canvas = createCanvas(source.width, source.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(sourceImage.value, 0, 0);
  return context;
}

function resolveOutputSize(width, height) {
  const size = Number(processOptions.outputSize) || 0;
  if (!size) return { width, height, drawX: 0, drawY: 0, drawWidth: width, drawHeight: height };

  if (processOptions.square) {
    const drawScale = processOptions.fit === "cover" ? Math.max(size / width, size / height) : Math.min(size / width, size / height);
    const drawWidth = Math.round(width * drawScale);
    const drawHeight = Math.round(height * drawScale);
    return {
      width: size,
      height: size,
      drawX: Math.round((size - drawWidth) / 2),
      drawY: Math.round((size - drawHeight) / 2),
      drawWidth,
      drawHeight,
    };
  }

  const scale = size / Math.max(width, height);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  return { width: outputWidth, height: outputHeight, drawX: 0, drawY: 0, drawWidth: outputWidth, drawHeight: outputHeight };
}

function drawFittedImage(context, image, output) {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, output.drawX, output.drawY, output.drawWidth, output.drawHeight);
}

function buildOutputName(index) {
  const prefix = String(processOptions.filenamePrefix || "image").replace(/[\\/:*?"<>|]/g, "_") || "image";
  const extension = processOptions.format === "jpeg" ? "jpg" : processOptions.format;
  return `${prefix}_${String(index).padStart(2, "0")}.${extension}`;
}

function getOutputMime() {
  if (processOptions.format === "webp") return "image/webp";
  if (processOptions.format === "jpeg") return "image/jpeg";
  return "image/png";
}

function getPreviewUrl(box, index) {
  previewToken.value;
  if (!ready.value || !box) return "";
  const canvas = createCanvas(96, 96);
  const context = canvas.getContext("2d");
  context.fillStyle = processOptions.background;
  context.fillRect(0, 0, 96, 96);
  const scale = Math.min(96 / box.width, 96 / box.height);
  const drawWidth = Math.round(box.width * scale);
  const drawHeight = Math.round(box.height * scale);
  context.drawImage(sourceImage.value, box.x, box.y, box.width, box.height, Math.round((96 - drawWidth) / 2), Math.round((96 - drawHeight) / 2), drawWidth, drawHeight);
  return canvas.toDataURL("image/png");
}

function trimBoxWhitespace(context, box, threshold) {
  const data = context.getImageData(box.x, box.y, box.width, box.height).data;
  let minX = box.width;
  let minY = box.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const offset = (y * box.width + x) * 4;
      const alpha = data[offset + 3];
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (alpha > 24 && !(red >= threshold && green >= threshold && blue >= threshold)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return box;
  return normalizeBox(addPaddingToRect({
    x: box.x + minX,
    y: box.y + minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }, processOptions.padding));
}

function addPaddingToRect(rect, padding) {
  const pad = Math.max(0, Number(padding) || 0);
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

function makeWhiteTransparent(context, width, height, threshold) {
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset] >= threshold && data[offset + 1] >= threshold && data[offset + 2] >= threshold) {
      data[offset + 3] = 0;
    }
  }
  context.putImageData(imageData, 0, 0);
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片编码失败。"));
    }, mime, quality);
  });
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function triggerDownload(url, name) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
}

function getUniqueZipName(name, usedNames) {
  const rawName = String(name || "image.png").replace(/[\\/:*?"<>|]/g, "_") || "image.png";
  if (!usedNames.has(rawName)) {
    usedNames.add(rawName);
    return rawName;
  }
  const baseName = rawName.replace(/\.[^.]+$/, "") || "image";
  const extension = rawName.match(/(\.[^.]+)$/)?.[1] || "";
  let index = 2;
  let candidate = `${baseName}-${index}${extension}`;
  while (usedNames.has(candidate)) {
    index += 1;
    candidate = `${baseName}-${index}${extension}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function safeBaseName(name) {
  return String(name || "image").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_") || "image";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "--";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function clampInteger(value, min, max) {
  return Math.round(clampNumber(value, min, max));
}

onBeforeUnmount(() => {
  clearSource(false);
  resizeObserver?.disconnect();
  stopPointerAction();
});

onMounted(() => {
  if ("ResizeObserver" in window && stageRef.value) {
    resizeObserver = new ResizeObserver(measureStage);
    resizeObserver.observe(stageRef.value);
  }
});
</script>

<template>
  <section class="tool-view image-crop-view" aria-labelledby="imageCropTitle">
    <h2 id="imageCropTitle" class="sr-only">图片裁切</h2>
    <section class="image-crop-panel" aria-label="图片裁切">
      <button
        class="image-upload-zone image-crop-upload"
        type="button"
        :disabled="busy"
        @click="chooseFile"
        @dragover.prevent
        @drop.prevent="handleDrop"
      >
        <svg class="icon" aria-hidden="true"><use href="#icon-upload"></use></svg>
        <strong>点击选择 或 将图片拖拽到此处</strong>
        <span>支持 JPG、PNG、WebP、AVIF、GIF 图片格式，裁剪和导出都在本地完成</span>
      </button>
      <input ref="fileInput" class="hidden-file-input" type="file" accept="image/*" :disabled="busy" @change="handleFileChange" />

      <div class="image-crop-workspace">
        <section class="work-panel image-crop-controls" aria-label="裁剪设置">
          <div class="panel-head">
            <label>裁剪设置</label>
            <span>{{ ready ? `${source.width}x${source.height}` : "等待图片" }}</span>
          </div>

          <div class="image-crop-control-body">
            <div class="image-crop-field-grid">
              <label class="image-crop-field">
                <span>行数</span>
                <input v-model.number="gridOptions.rows" type="number" min="1" max="60" @change="applyGrid" />
              </label>
              <label class="image-crop-field">
                <span>列数</span>
                <input v-model.number="gridOptions.cols" type="number" min="1" max="60" @change="applyGrid" />
              </label>
              <label class="image-crop-field">
                <span>横向间隔</span>
                <input v-model.number="gridOptions.gapX" type="number" min="0" step="1" @change="applyGrid" />
              </label>
              <label class="image-crop-field">
                <span>纵向间隔</span>
                <input v-model.number="gridOptions.gapY" type="number" min="0" step="1" @change="applyGrid" />
              </label>
              <label class="image-crop-field">
                <span>上边距</span>
                <input v-model.number="gridOptions.marginTop" type="number" min="0" step="1" @change="applyGrid" />
              </label>
              <label class="image-crop-field">
                <span>下边距</span>
                <input v-model.number="gridOptions.marginBottom" type="number" min="0" step="1" @change="applyGrid" />
              </label>
              <label class="image-crop-field">
                <span>左边距</span>
                <input v-model.number="gridOptions.marginLeft" type="number" min="0" step="1" @change="applyGrid" />
              </label>
              <label class="image-crop-field">
                <span>右边距</span>
                <input v-model.number="gridOptions.marginRight" type="number" min="0" step="1" @change="applyGrid" />
              </label>
            </div>

            <div class="image-crop-inline-actions">
              <button class="compact-button" type="button" :disabled="!boxes.length" @click="selectAll">全选</button>
              <button class="compact-button" type="button" :disabled="!boxes.length" @click="invertSelection">反选</button>
              <button class="compact-button" type="button" :disabled="!selectedCount" @click="deleteSelected">删除</button>
              <button class="compact-button" type="button" :disabled="!ready" @click="applyGrid">重生成</button>
            </div>

            <section class="image-crop-subpanel" aria-label="输出设置">
              <div class="image-crop-subhead">
                <strong>输出</strong>
                <span>{{ selectedCount }} / {{ boxes.length }}</span>
              </div>

              <label class="image-crop-check">
                <input v-model="processOptions.trimWhitespace" type="checkbox" />
                <span>导出时自动去白边</span>
              </label>
              <label class="image-crop-check">
                <input v-model="processOptions.square" type="checkbox" />
                <span>补成正方形</span>
              </label>
              <label class="image-crop-check">
                <input v-model="processOptions.transparentWhite" type="checkbox" />
                <span>白底转透明</span>
              </label>
            </section>
          </div>
        </section>

        <section class="work-panel image-crop-editor" aria-label="裁剪编辑区">
          <div class="panel-head">
            <label>{{ source.name || "预览" }}</label>
            <span>{{ boxes.length ? `${boxes.length} 个框` : "无裁剪框" }}</span>
          </div>
          <div ref="stageRef" class="image-crop-stage" :style="{ height: `${stage.height || 420}px` }">
            <img v-if="source.url" ref="imageRef" class="image-crop-source" :src="source.url" alt="裁剪源图" :style="stageImageStyle" @load="measureStage" />
            <div v-if="source.url" class="image-crop-layer" :style="cropLayerStyle">
              <button
                v-for="(box, index) in boxes"
                :key="box.id"
                class="image-crop-box"
                :class="{ 'is-selected': selectedIds.has(box.id), 'is-active': activeBoxId === box.id }"
                type="button"
                :style="getBoxStyle(box)"
                :aria-label="`裁剪框 ${index + 1}`"
                @pointerdown="startDrag(box, $event)"
                @click.stop="selectBox(box, $event)"
              >
                <span class="image-crop-box-label">{{ index + 1 }}</span>
                <span
                  v-for="handle in ['nw','n','ne','e','se','s','sw','w']"
                  :key="handle"
                  class="image-crop-handle"
                  :class="`is-${handle}`"
                  @pointerdown.stop="startResize(box, handle, $event)"
                ></span>
              </button>
            </div>
            <div v-if="!source.url" class="image-crop-empty">
              <svg class="icon" aria-hidden="true"><use href="#icon-crop"></use></svg>
              <strong>上传图片后开始裁剪</strong>
              <span>设置行数、列数、边距和间隔后，按网格生成裁剪框</span>
            </div>
          </div>
        </section>

        <section class="work-panel image-crop-preview-panel" aria-label="裁剪预览">
          <div class="panel-head">
            <label>导出预览</label>
            <span>{{ exportBoxes.length }} 张</span>
          </div>
          <div class="image-crop-preview-grid">
            <div v-if="!exportBoxes.length" class="image-crop-preview-empty">选择裁剪框后显示预览</div>
            <article v-for="(box, index) in exportBoxes" v-else :key="box.id" class="image-crop-preview-card">
              <img :src="getPreviewUrl(box, index)" :alt="`裁剪预览 ${index + 1}`" />
              <div>
                <strong>{{ buildOutputName(index + 1) }}</strong>
                <span>{{ box.width }} x {{ box.height }}</span>
              </div>
              <button class="image-row-download" type="button" :disabled="busy" @click="downloadOne(box, index + 1)">下载</button>
            </article>
          </div>
          <div class="image-list-actions">
            <div class="primary-actions">
              <button class="secondary-button" type="button" :disabled="!source.url || busy" @click="clearSource">
                <svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
                清空图片
              </button>
            </div>
            <div class="image-main-actions">
              <button class="primary-button image-download-all" type="button" :disabled="!exportBoxes.length || busy" @click="downloadZip">
                <span v-if="busy" class="loading-spinner" aria-hidden="true"></span>
                <svg v-else class="icon" aria-hidden="true"><use href="#icon-download"></use></svg>
                {{ busy ? "打包中" : "导出 ZIP" }}
              </button>
            </div>
          </div>
        </section>
      </div>

      <p class="feedback" :class="feedback.type && `is-${feedback.type}`" role="status" aria-live="polite">
        {{ feedback.message }}
      </p>
    </section>
  </section>
</template>
