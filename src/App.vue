<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { runTransformTask } from "./lib/transform.js";

const tools = [
  {
    key: "json",
    title: "JSON 格式化",
    icon: "braces",
    group: "开发工具",
    description: "格式化、压缩和校验 JSON。",
  },
  {
    key: "base64",
    title: "Base64 加解密",
    icon: "binary",
    group: "开发工具",
    description: "UTF-8 文本与 Base64 互转。",
  },
];

const groupOrder = ["AI工具", "开发工具"];

const samples = {
  base64: "糖果梦工具箱",
  json: '{"name":"糖果梦工具箱","tools":["Base64","JSON"],"localOnly":true}',
};

const storageKeys = {
  activeTool: "tgmeng-tools.active-tool",
  theme: "tgmeng-tools.theme",
  sidebarCollapsed: "tgmeng-tools.sidebar-collapsed",
  collapsedGroups: "tgmeng-tools.collapsed-groups",
};

const activeTool = ref("base64");
const search = ref("");
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(localStorage.getItem(storageKeys.sidebarCollapsed) === "true");
const collapsedGroups = reactive(loadCollapsedGroups());
const busy = reactive({ base64: false, json: false });
const feedback = reactive({
  base64: { message: "", type: "" },
  json: { message: "", type: "" },
});
const meta = reactive({
  base64Input: 0,
  base64Output: 0,
  jsonInput: 0,
  jsonOutput: 0,
});

const base64Input = ref(null);
const base64Output = ref(null);
const jsonInput = ref(null);
const jsonOutput = ref(null);
const jsonTree = ref(null);
const workspace = ref(null);
const jsonIndent = ref(2);

let worker = null;
let workerSeq = 0;
let metaFrame = 0;
let jsonActionSeq = 0;
const pendingJobs = new Map();

const activeToolConfig = computed(() => {
  return tools.find((tool) => tool.key === activeTool.value) || tools[0];
});

const activeTitle = computed(() => activeToolConfig.value.title);
const activeGroup = computed(() => activeToolConfig.value.group);
const activeDescription = computed(() => activeToolConfig.value.description);

const filteredGroups = computed(() => {
  const term = search.value.trim().toLowerCase();
  const matchedTools = term
    ? tools.filter((tool) => `${tool.title} ${tool.key} ${tool.group}`.toLowerCase().includes(term))
    : tools;

  const groups = groupOrder.map((group) => ({
    group,
    tools: matchedTools.filter((tool) => tool.group === group),
  }));

  return term ? groups.filter((item) => item.tools.length > 0) : groups;
});

onMounted(() => {
  restoreTheme();
  initWorker();
  const initialTool = getInitialTool();
  activateTool(initialTool, false);
  syncPath(initialTool);
  queueMetaUpdate();
  window.addEventListener("popstate", handleRouteChange);
  document.addEventListener("keydown", handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("popstate", handleRouteChange);
  document.removeEventListener("keydown", handleKeydown);

  if (worker) {
    worker.terminate();
  }

  pendingJobs.clear();
  cancelAnimationFrame(metaFrame);
});

function getInitialTool() {
  const fromPath = window.location.pathname.split("/").filter(Boolean).pop();
  const fromStorage = localStorage.getItem(storageKeys.activeTool);
  if (tools.some((tool) => tool.key === fromPath)) return fromPath;
  if (tools.some((tool) => tool.key === fromStorage)) return fromStorage;
  return "base64";
}

function activateTool(tool, updatePath = true) {
  if (!tools.some((item) => item.key === tool)) return;

  activeTool.value = tool;
  localStorage.setItem(storageKeys.activeTool, tool);

  if (updatePath) {
    history.pushState(null, "", getToolPath(tool));
  }

  sidebarOpen.value = false;
}

function handleRouteChange() {
  const tool = window.location.pathname.split("/").filter(Boolean).pop();
  if (tools.some((item) => item.key === tool)) {
    activateTool(tool, false);
  } else {
    activateTool("base64", false);
    syncPath("base64");
  }
}

function syncPath(tool) {
  if (window.location.pathname !== getToolPath(tool)) {
    history.replaceState(null, "", getToolPath(tool));
  }
}

function getToolPath(tool) {
  return `/${tool}`;
}

function loadCollapsedGroups() {
  const defaults = Object.fromEntries(groupOrder.map((group) => [group, false]));

  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(storageKeys.collapsedGroups) || "{}") };
  } catch (error) {
    return defaults;
  }
}

function isGroupCollapsed(group) {
  return Boolean(collapsedGroups[group]);
}

function isGroupClosed(group) {
  return !search.value.trim() && isGroupCollapsed(group);
}

function toggleGroup(group) {
  collapsedGroups[group] = !collapsedGroups[group];
  localStorage.setItem(storageKeys.collapsedGroups, JSON.stringify(collapsedGroups));
}

function focusWorkspace() {
  workspace.value?.focus();
}

function toggleSidebarCollapsed() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem(storageKeys.sidebarCollapsed, String(sidebarCollapsed.value));
  sidebarOpen.value = false;
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    sidebarOpen.value = false;
  }
}

function restoreTheme() {
  const saved = localStorage.getItem(storageKeys.theme);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(storageKeys.theme, next);
}

function initWorker() {
  if (!("Worker" in window)) return;

  try {
    worker = new Worker(new URL("./workers/tools.worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", disableWorker);
  } catch (error) {
    worker = null;
  }
}

function handleWorkerMessage(event) {
  const { id, ok, result, error } = event.data;
  const job = pendingJobs.get(id);
  if (!job) return;

  pendingJobs.delete(id);

  if (ok) {
    job.resolve(result);
  } else {
    job.reject(new Error(error || "处理失败。"));
  }
}

function disableWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }

  pendingJobs.forEach((job) => {
    try {
      job.resolve(runTransformTask(job.task, job.payload));
    } catch (error) {
      job.reject(error);
    }
  });
  pendingJobs.clear();
}

function runTask(task, payload) {
  if (!worker) {
    return Promise.resolve(runTransformTask(task, payload));
  }

  const id = ++workerSeq;

  return new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject, task, payload });

    try {
      worker.postMessage({ id, task, payload });
    } catch (error) {
      pendingJobs.delete(id);
      resolve(runTransformTask(task, payload));
    }
  });
}

function queueMetaUpdate() {
  if (metaFrame) return;

  metaFrame = requestAnimationFrame(() => {
    metaFrame = 0;
    meta.base64Input = base64Input.value?.value.length || 0;
    meta.base64Output = base64Output.value?.value.length || 0;
    meta.jsonInput = jsonInput.value?.value.length || 0;
    meta.jsonOutput = jsonOutput.value?.value.length || 0;
  });
}

function setOutput(target, value) {
  target.value = value;
  queueMetaUpdate();
}

function setFeedback(tool, message, type = "") {
  feedback[tool].message = message;
  feedback[tool].type = type;
}

async function encodeBase64() {
  const source = base64Input.value.value;
  if (!source) {
    setFeedback("base64", "输入为空。", "warning");
    return;
  }

  busy.base64 = true;
  setFeedback("base64", "处理中...");

  try {
    const result = await runTask("base64-encode", { source });
    setOutput(base64Output.value, result.output);
    setFeedback("base64", "已编码。", "success");
  } catch (error) {
    setFeedback("base64", error.message || "编码失败。", "error");
  } finally {
    busy.base64 = false;
  }
}

async function decodeBase64() {
  const source = base64Input.value.value.trim();
  if (!source) {
    setFeedback("base64", "输入为空。", "warning");
    return;
  }

  busy.base64 = true;
  setFeedback("base64", "处理中...");

  try {
    const result = await runTask("base64-decode", { source });
    setOutput(base64Output.value, result.output);
    setFeedback("base64", "已解码。", "success");
  } catch (error) {
    setFeedback("base64", error.message || "Base64 内容无效。", "error");
  } finally {
    busy.base64 = false;
  }
}

function swapBase64() {
  const input = base64Input.value.value;
  base64Input.value.value = base64Output.value.value;
  base64Output.value.value = input;
  queueMetaUpdate();
  setFeedback("base64", "已互换输入和输出。", "success");
}

function clearBase64() {
  base64Input.value.value = "";
  base64Output.value.value = "";
  queueMetaUpdate();
  setFeedback("base64", "已清空。", "success");
}

function setBase64Sample() {
  base64Input.value.value = samples.base64;
  base64Output.value.value = "";
  queueMetaUpdate();
  setFeedback("base64", "已填入示例。", "success");
}

async function formatJson() {
  const source = jsonInput.value.value.trim();
  if (!source) {
    setFeedback("json", "JSON 为空。", "warning");
    return;
  }

  const actionSeq = ++jsonActionSeq;
  busy.json = true;
  setFeedback("json", "处理中...");

  try {
    const result = await runTask("json-format", { source, indent: jsonIndent.value });
    if (actionSeq !== jsonActionSeq) return;
    setOutput(jsonOutput.value, result.output);
    renderJsonTree(result.data);
    setFeedback("json", "JSON 已格式化。", "success");
  } catch (error) {
    if (actionSeq !== jsonActionSeq) return;
    setFeedback("json", error.message || "JSON 无效。", "error");
  } finally {
    if (actionSeq === jsonActionSeq) {
      busy.json = false;
    }
  }
}

async function minifyJson() {
  const source = jsonInput.value.value.trim();
  if (!source) {
    setFeedback("json", "JSON 为空。", "warning");
    return;
  }

  const actionSeq = ++jsonActionSeq;
  busy.json = true;
  setFeedback("json", "处理中...");

  try {
    const result = await runTask("json-minify", { source });
    if (actionSeq !== jsonActionSeq) return;
    setOutput(jsonOutput.value, result.output);
    renderJsonTree(result.data);
    setFeedback("json", "JSON 已压缩。", "success");
  } catch (error) {
    if (actionSeq !== jsonActionSeq) return;
    setFeedback("json", error.message || "JSON 无效。", "error");
  } finally {
    if (actionSeq === jsonActionSeq) {
      busy.json = false;
    }
  }
}

async function validateJson() {
  const source = jsonInput.value.value.trim();
  if (!source) {
    setFeedback("json", "JSON 为空。", "warning");
    return;
  }

  const actionSeq = ++jsonActionSeq;
  busy.json = true;
  setFeedback("json", "处理中...");

  try {
    const result = await runTask("json-validate", { source });
    if (actionSeq !== jsonActionSeq) return;
    setOutput(jsonOutput.value, JSON.stringify(result.data, null, jsonIndent.value));
    renderJsonTree(result.data);
    setFeedback("json", "JSON 有效。", "success");
  } catch (error) {
    if (actionSeq !== jsonActionSeq) return;
    setFeedback("json", error.message || "JSON 无效。", "error");
  } finally {
    if (actionSeq === jsonActionSeq) {
      busy.json = false;
    }
  }
}

function setJsonIndent(indent) {
  if (jsonIndent.value === indent) return;

  jsonIndent.value = indent;
  if (!jsonInput.value?.value.trim() || busy.json) return;
  formatJson();
}

function clearJson() {
  jsonInput.value.value = "";
  jsonOutput.value.value = "";
  renderJsonPlaceholder();
  queueMetaUpdate();
  setFeedback("json", "已清空。", "success");
}

function setJsonSample() {
  jsonInput.value.value = samples.json;
  jsonOutput.value.value = "";
  renderJsonPlaceholder();
  queueMetaUpdate();
  setFeedback("json", "已填入示例。", "success");
}

function renderJsonPlaceholder(message = "格式化结果会出现在这里") {
  if (!jsonTree.value) return;

  const empty = document.createElement("p");
  empty.className = "json-empty";
  empty.textContent = message;
  jsonTree.value.replaceChildren(empty);
}

function renderJsonTree(data) {
  if (!jsonTree.value) return;

  const fragment = document.createDocumentFragment();
  fragment.append(createJsonNode("", data, 0, true));
  jsonTree.value.replaceChildren(fragment);
}

function createJsonNode(key, value, depth, isRoot = false) {
  if (isJsonContainer(value)) {
    return createJsonContainerNode(key, value, depth, isRoot);
  }

  const line = document.createElement("div");
  line.className = "json-line";
  line.style.setProperty("--indent", `${depth * 18}px`);
  line.setAttribute("role", "treeitem");

  if (!isRoot) {
    appendJsonKey(line, key);
  }

  line.append(createValueToken(value));
  return line;
}

function createJsonContainerNode(key, value, depth, isRoot) {
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
  const details = document.createElement("details");
  details.className = "json-node";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "json-summary";
  summary.style.setProperty("--indent", `${depth * 18}px`);
  summary.setAttribute("role", "treeitem");
  summary.setAttribute("aria-expanded", "true");
  summary.addEventListener("click", () => {
    requestAnimationFrame(() => {
      summary.setAttribute("aria-expanded", String(details.open));
    });
  });

  if (!isRoot) {
    appendJsonKey(summary, key);
  }

  const openBrace = document.createElement("span");
  openBrace.className = "json-punctuation";
  openBrace.textContent = isArray ? "[" : "{";

  const metaText = document.createElement("span");
  metaText.className = "json-meta";
  metaText.textContent = `${isArray ? "数组" : "对象"} · ${entries.length} 项`;

  const closeBrace = document.createElement("span");
  closeBrace.className = "json-punctuation";
  closeBrace.textContent = isArray ? "]" : "}";

  summary.append(openBrace, metaText, closeBrace);
  details.append(summary);

  const children = document.createElement("div");
  children.className = "json-children";
  children.style.setProperty("--indent", `${(depth + 1) * 18}px`);
  children.setAttribute("role", "group");

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "json-line is-empty";
    empty.style.setProperty("--indent", `${(depth + 1) * 18}px`);
    empty.textContent = isArray ? "空数组" : "空对象";
    children.append(empty);
  } else {
    for (const [entryKey, entryValue] of entries) {
      children.append(createJsonNode(entryKey, entryValue, depth + 1));
    }
  }

  details.append(children);
  return details;
}

function appendJsonKey(target, key) {
  const keyToken = document.createElement("span");
  keyToken.className = typeof key === "number" ? "json-index" : "json-key";
  keyToken.textContent = typeof key === "number" ? `[${key}]` : JSON.stringify(key);

  const separator = document.createElement("span");
  separator.className = "json-separator";
  separator.textContent = ": ";

  target.append(keyToken, separator);
}

function createValueToken(value) {
  const token = document.createElement("span");

  if (value === null) {
    token.className = "json-null";
    token.textContent = "null";
    return token;
  }

  const type = typeof value;
  token.className = `json-${type}`;
  token.textContent = type === "string" ? JSON.stringify(value) : String(value);
  return token;
}

function isJsonContainer(value) {
  return value !== null && typeof value === "object";
}

async function copyText(textarea, tool) {
  if (!textarea.value) {
    setFeedback(tool, "没有可复制的内容。", "warning");
    return;
  }

  try {
    await navigator.clipboard.writeText(textarea.value);
    setFeedback(tool, "已复制到剪贴板。", "success");
  } catch (error) {
    textarea.select();
    document.execCommand("copy");
    setFeedback(tool, "已复制到剪贴板。", "success");
  }
}
</script>

<template>
  <svg class="sprite" aria-hidden="true" focusable="false">
    <symbol id="icon-align-left" viewBox="0 0 24 24">
      <path d="M21 6H3M15 12H3M17 18H3" />
    </symbol>
    <symbol id="icon-arrow-left-right" viewBox="0 0 24 24">
      <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
    </symbol>
    <symbol id="icon-arrow-left-from-line" viewBox="0 0 24 24">
      <path d="m9 6-6 6 6 6M3 12h14M21 19V5" />
    </symbol>
    <symbol id="icon-arrow-right-to-line" viewBox="0 0 24 24">
      <path d="m15 6 6 6-6 6M21 12H7M3 5v14" />
    </symbol>
    <symbol id="icon-binary" viewBox="0 0 24 24">
      <path d="M6 20h4M14 10h4M6 14h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6v-6ZM14 4h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2V4ZM6 4h4M8 4v6M14 14h4M16 14v6" />
    </symbol>
    <symbol id="icon-braces" viewBox="0 0 24 24">
      <path d="M8 3H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v7a2 2 0 0 0 2 2h1M16 21h1a2 2 0 0 0 2-2v-7a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </symbol>
    <symbol id="icon-check" viewBox="0 0 24 24">
      <path d="M20 6 9 17l-5-5" />
    </symbol>
    <symbol id="icon-chevron-right" viewBox="0 0 24 24">
      <path d="m9 18 6-6-6-6" />
    </symbol>
    <symbol id="icon-copy" viewBox="0 0 24 24">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </symbol>
    <symbol id="icon-menu" viewBox="0 0 24 24">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </symbol>
    <symbol id="icon-minimize" viewBox="0 0 24 24">
      <path d="m8 3-5 5h5V3ZM16 3v5h5l-5-5ZM8 21v-5H3l5 5ZM21 16h-5v5l5-5Z" />
    </symbol>
    <symbol id="icon-moon" viewBox="0 0 24 24">
      <path d="M12 3a6 6 0 0 0 9 7.4A9 9 0 1 1 12 3Z" />
    </symbol>
    <symbol id="icon-search" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </symbol>
    <symbol id="icon-sparkles" viewBox="0 0 24 24">
      <path d="m12 3-1.9 5.7L4 11l6.1 2.3L12 19l1.9-5.7L20 11l-6.1-2.3L12 3ZM5 3v4M3 5h4M19 17v4M17 19h4" />
    </symbol>
    <symbol id="icon-trash" viewBox="0 0 24 24">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </symbol>
    <symbol id="icon-wrench" viewBox="0 0 24 24">
      <path d="M14.7 6.3a5 5 0 0 0 6.6 6.6L12 22 2 12l9.1-9.3a5 5 0 0 0 3.6 3.6Z" />
    </symbol>
  </svg>

  <button class="skip-link" type="button" @click="focusWorkspace">跳到工具区</button>

  <div class="app-shell" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
    <aside class="sidebar" :class="{ 'is-open': sidebarOpen, 'is-collapsed': sidebarCollapsed }" aria-label="工具导航">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <img class="brand-logo" src="/assets/logo.png" alt="" />
        </span>
        <span class="brand-text">
          <strong>TGMENG TOOLS</strong>
        </span>
        <button
          class="sidebar-toggle"
          type="button"
          :aria-label="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
          :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
          @click="toggleSidebarCollapsed"
        >
          <svg class="icon"><use href="#icon-menu"></use></svg>
        </button>
      </div>

      <label class="search-field" for="toolSearch">
        <svg class="icon" aria-hidden="true"><use href="#icon-search"></use></svg>
        <span class="sr-only">搜索工具</span>
        <input id="toolSearch" v-model="search" type="search" autocomplete="off" placeholder="搜索工具" />
      </label>

      <nav class="tool-nav" aria-label="工具列表">
        <template v-for="group in filteredGroups" :key="group.group">
          <button
            class="nav-section-toggle"
            type="button"
            :aria-expanded="!isGroupClosed(group.group)"
            :title="group.group"
            @click="toggleGroup(group.group)"
          >
            <span>{{ group.group }}</span>
            <svg class="icon" aria-hidden="true"><use href="#icon-chevron-right"></use></svg>
          </button>
          <div class="nav-section-tools" :class="{ 'is-collapsed': isGroupClosed(group.group) }">
            <button
              v-for="tool in group.tools"
              :key="tool.key"
              class="tool-link"
              :class="{ 'is-active': activeTool === tool.key }"
              type="button"
              :title="tool.title"
              :tabindex="isGroupClosed(group.group) ? -1 : 0"
              :aria-current="activeTool === tool.key ? 'page' : undefined"
              @click="activateTool(tool.key)"
            >
              <span>{{ tool.title }}</span>
            </button>
          </div>
        </template>
        <p v-if="filteredGroups.length === 0" class="nav-empty">没有匹配的工具</p>
      </nav>

      <p class="sidebar-footer">
        <span class="status-dot" aria-hidden="true"></span>
        <span>纯前端处理</span>
      </p>
    </aside>

    <button
      v-show="sidebarOpen"
      class="scrim"
      type="button"
      aria-label="关闭工具导航"
      @click="sidebarOpen = false"
    ></button>

    <main id="workspace" ref="workspace" class="workspace" tabindex="-1">
      <header class="topbar">
        <div class="tool-heading">
          <h1 class="sr-only">{{ activeTitle }}</h1>
          <p class="workspace-note">
            <span>{{ activeGroup }}</span>
            {{ activeDescription }}
          </p>
        </div>
        <button class="icon-button topbar-action" type="button" aria-label="切换深浅色" @click="toggleTheme">
          <svg class="icon"><use href="#icon-moon"></use></svg>
        </button>
      </header>

      <section v-show="activeTool === 'base64'" class="tool-view" aria-labelledby="base64Title">
        <h2 id="base64Title" class="sr-only">Base64 加解密</h2>
        <div class="tool-grid">
          <section class="work-panel" aria-labelledby="base64InputLabel">
            <div class="panel-head">
              <label id="base64InputLabel" for="base64Input">输入</label>
              <span>{{ meta.base64Input }} 字符</span>
            </div>
            <textarea id="base64Input" ref="base64Input" spellcheck="false" placeholder="输入文本或 Base64" @input="queueMetaUpdate"></textarea>
          </section>

          <section class="work-panel" aria-labelledby="base64OutputLabel">
            <div class="panel-head">
              <label id="base64OutputLabel" for="base64Output">输出</label>
              <span>{{ meta.base64Output }} 字符</span>
            </div>
            <textarea id="base64Output" ref="base64Output" spellcheck="false" readonly placeholder="结果会出现在这里"></textarea>
          </section>
        </div>

        <div class="command-bar" aria-label="Base64 操作">
          <div class="primary-actions">
            <button class="primary-button" type="button" :disabled="busy.base64" @click="encodeBase64">
              <svg class="icon" aria-hidden="true"><use href="#icon-arrow-right-to-line"></use></svg>
              编码
            </button>
            <button class="secondary-button" type="button" :disabled="busy.base64" @click="decodeBase64">
              <svg class="icon" aria-hidden="true"><use href="#icon-arrow-left-from-line"></use></svg>
              解码
            </button>
            <div class="compact-actions" aria-label="Base64 高频操作">
              <button class="compact-button" type="button" :disabled="busy.base64" @click="setBase64Sample">
                示例
              </button>
              <button class="compact-button" type="button" :disabled="busy.base64" @click="clearBase64">
                清空
              </button>
            </div>
          </div>
          <div class="utility-actions">
            <button class="icon-text-button" type="button" :disabled="busy.base64" @click="swapBase64">
              <svg class="icon" aria-hidden="true"><use href="#icon-arrow-left-right"></use></svg>
              互换
            </button>
            <button class="icon-text-button" type="button" :disabled="busy.base64" @click="copyText(base64Output, 'base64')">
              <svg class="icon" aria-hidden="true"><use href="#icon-copy"></use></svg>
              复制
            </button>
          </div>
        </div>

        <p class="feedback" :class="feedback.base64.type && `is-${feedback.base64.type}`" role="status" aria-live="polite">
          {{ feedback.base64.message }}
        </p>
      </section>

      <section v-show="activeTool === 'json'" class="tool-view" aria-labelledby="jsonTitle">
        <h2 id="jsonTitle" class="sr-only">JSON 格式化</h2>
        <div class="tool-grid">
          <section class="work-panel" aria-labelledby="jsonInputLabel">
            <div class="panel-head">
              <label id="jsonInputLabel" for="jsonInput">输入</label>
              <span>{{ meta.jsonInput }} 字符</span>
            </div>
            <textarea id="jsonInput" ref="jsonInput" spellcheck="false" placeholder='{"name":"糖果梦"}' @input="queueMetaUpdate"></textarea>
          </section>

          <section class="work-panel" aria-labelledby="jsonOutputLabel">
            <div class="panel-head">
              <label id="jsonOutputLabel" for="jsonOutput">输出</label>
              <span>{{ meta.jsonOutput }} 字符</span>
            </div>
            <div ref="jsonTree" class="json-tree" role="tree" aria-label="JSON 树视图">
              <p class="json-empty">格式化结果会出现在这里</p>
            </div>
            <textarea id="jsonOutput" ref="jsonOutput" class="output-buffer" tabindex="-1" aria-hidden="true" spellcheck="false" readonly></textarea>
          </section>
        </div>

        <div class="command-bar" aria-label="JSON 操作">
          <div class="primary-actions">
            <button class="primary-button" type="button" :disabled="busy.json" @click="formatJson">
              <svg class="icon" aria-hidden="true"><use href="#icon-align-left"></use></svg>
              格式化
            </button>
            <button class="secondary-button" type="button" :disabled="busy.json" @click="minifyJson">
              <svg class="icon" aria-hidden="true"><use href="#icon-minimize"></use></svg>
              压缩
            </button>
            <div class="compact-actions" aria-label="JSON 高频操作">
              <button class="compact-button" type="button" :disabled="busy.json" @click="setJsonSample">
                示例
              </button>
              <button class="compact-button" type="button" :disabled="busy.json" @click="clearJson">
                清空
              </button>
            </div>
          </div>
          <div class="utility-actions">
            <div class="segmented-control" role="radiogroup" aria-label="缩进">
              <button
                class="segmented-option"
                :class="{ 'is-active': jsonIndent === 2 }"
                type="button"
                role="radio"
                :aria-checked="jsonIndent === 2"
                :disabled="busy.json"
                @click="setJsonIndent(2)"
              >
                2
              </button>
              <button
                class="segmented-option"
                :class="{ 'is-active': jsonIndent === 4 }"
                type="button"
                role="radio"
                :aria-checked="jsonIndent === 4"
                :disabled="busy.json"
                @click="setJsonIndent(4)"
              >
                4
              </button>
            </div>
            <button class="icon-text-button" type="button" :disabled="busy.json" @click="validateJson">
              <svg class="icon" aria-hidden="true"><use href="#icon-check"></use></svg>
              校验
            </button>
            <button class="icon-text-button" type="button" :disabled="busy.json" @click="copyText(jsonOutput, 'json')">
              <svg class="icon" aria-hidden="true"><use href="#icon-copy"></use></svg>
              复制
            </button>
          </div>
        </div>

        <p class="feedback" :class="feedback.json.type && `is-${feedback.json.type}`" role="status" aria-live="polite">
          {{ feedback.json.message }}
        </p>
      </section>
    </main>
  </div>
</template>
