import init, { HwpDocument } from "@rhwp/core";
import wasmUrl from "@rhwp/core/rhwp_bg.wasm?url";
import { createExporter } from "./export.js";

/* ------------------------------------------------------------------ *
 *  한씨 (Hansee) — HWP 5.0 / HWPX 로컬 뷰어
 *  모든 파싱과 렌더링은 브라우저 안에서만 이루어진다.
 * ------------------------------------------------------------------ */

const ENGINE_LABEL = "rhwp 0.9.0";
const A4 = { pxW: 793.7, pxH: 1122.5 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"),
  openBtn: $("openBtn"),
  emptyOpenBtn: $("emptyOpenBtn"),
  fileInput: $("fileInput"),
  docName: $("docName"),
  docMeta: $("docMeta"),
  printBtn: $("printBtn"),
  pdfBtn: $("pdfBtn"),
  helpBtn: $("helpBtn"),
  helpDialog: $("helpDialog"),
  passwordDialog: $("passwordDialog"),
  passwordForm: $("passwordForm"),
  passwordInput: $("passwordInput"),
  passwordError: $("passwordError"),
  passwordConfirm: $("passwordConfirm"),
  prevPage: $("prevPage"),
  nextPage: $("nextPage"),
  pageInput: $("pageInput"),
  pageTotal: $("pageTotal"),
  zoomOut: $("zoomOut"),
  zoomIn: $("zoomIn"),
  zoomLabel: $("zoomLabel"),
  zoomMenu: $("zoomMenu"),
  fitWidth: $("fitWidth"),
  fitPage: $("fitPage"),
  thumbToggle: $("thumbToggle"),
  fullscreenBtn: $("fullscreenBtn"),
  thumbs: $("thumbs"),
  thumbList: $("thumbList"),
  stage: $("stage"),
  pages: $("pages"),
  emptyState: $("emptyState"),
  statusText: $("statusText"),
  statusPage: $("statusPage"),
  statusZoom: $("statusZoom"),
  statusEngine: $("statusEngine"),
  dropOverlay: $("dropOverlay"),
  busy: $("busy"),
  busyText: $("busyText"),
  busyProgress: $("busyProgress"),
  busyBar: $("busyBar"),
  busyCancel: $("busyCancel"),
  toast: $("toast"),
  printRoot: $("printRoot"),
};

const state = {
  doc: null,
  docId: 0,
  fileName: "",
  fileSize: 0,
  fileType: "",
  pages: [],
  thumbs: [],
  rendered: new Set(),
  queued: new Set(),
  pumping: false,
  current: 0,
  zoom: 1,
  fitMode: "width",
  pageObserver: null,
  thumbObserver: null,
  toastTimer: 0,
  busyCancel: null,
  opening: false,
};

/* ------------------------------------------------------------------ *
 *  WASM 엔진 초기화
 * ------------------------------------------------------------------ */

let measureCtx = null;
let measureFont = "";
let wasmPromise = null;

// WASM이 글자 폭을 잴 때 브라우저 Canvas 측정 결과를 사용한다.
globalThis.measureTextWidth = (font, text) => {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (measureFont !== font) {
    measureCtx.font = font;
    measureFont = font;
  }
  return measureCtx.measureText(text).width;
};

function loadEngine() {
  if (!wasmPromise) {
    wasmPromise = init({ module_or_path: wasmUrl }).catch((error) => {
      wasmPromise = null;
      throw error;
    });
  }
  return wasmPromise;
}

// 첫 파일을 열 때 지연이 없도록 백그라운드에서 미리 준비한다.
function preloadEngine() {
  loadEngine().catch(() => {
    /* 파일을 열 때 다시 시도하고 사용자에게 알린다. */
  });
}

/* ------------------------------------------------------------------ *
 *  작은 UI 유틸리티
 * ------------------------------------------------------------------ */

function toast(message, duration = 2600) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), duration);
}

function showBusy(text, options = {}) {
  els.busyText.textContent = text;
  els.busyText.dataset.base = options.progress ? text : "";
  els.busyProgress.hidden = !options.progress;
  els.busyBar.style.width = "0%";
  els.busyCancel.hidden = !options.cancel;
  els.busyCancel.disabled = false;
  state.busyCancel = options.cancel
    ? () => {
        state.busyCancel = null;
        els.busyCancel.disabled = true;
        exporter.cancel();
      }
    : null;
  els.busy.hidden = false;
}

function hideBusy() {
  els.busy.hidden = true;
  els.busyProgress.hidden = true;
  els.busyCancel.hidden = true;
  state.busyCancel = null;
}

els.busyCancel.addEventListener("click", () => state.busyCancel?.());

function setProgress(done, total) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  els.busyBar.style.width = `${percent}%`;
  if (els.busyText.dataset.base && total > 0) {
    els.busyText.textContent = `${els.busyText.dataset.base} (${done}/${total})`;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/* ------------------------------------------------------------------ *
 *  SVG 준비: 보안 정리 + 페이지별 ID 고유화 + 반응형 크기
 * ------------------------------------------------------------------ */

function prepareSvg(raw, key) {
  try {
    const parsed = new DOMParser().parseFromString(raw, "image/svg+xml");
    const svg = parsed.documentElement;

    if (!svg || svg.tagName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) {
      throw new Error("invalid svg");
    }

    // 스크립트와 이벤트 핸들러 제거
    svg.querySelectorAll("script").forEach((node) => node.remove());
    const all = [svg, ...svg.querySelectorAll("*")];
    for (const el of all) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        if ((attr.name === "href" || attr.name === "xlink:href") && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }

    // 페이지마다 같은 clipPath/그라디언트 ID를 쓰므로 문서 내에서 고유하게 바꾼다.
    const ids = new Map();
    svg.querySelectorAll("[id]").forEach((el, index) => {
      const oldId = el.getAttribute("id");
      if (!oldId) return;
      const newId = `${key}-${index}`;
      ids.set(oldId, newId);
      el.setAttribute("id", newId);
    });

    if (ids.size) {
      const urlRef = /url\(\s*#([^)\s"']+)\s*\)/g;
      for (const el of all) {
        for (const attr of [...el.attributes]) {
          let value = attr.value;
          if (value.includes("url(#")) {
            value = value.replace(urlRef, (match, id) => (ids.has(id) ? `url(#${ids.get(id)})` : match));
          }
          if ((attr.name === "href" || attr.name === "xlink:href") && value.startsWith("#")) {
            const id = value.slice(1);
            if (ids.has(id)) value = `#${ids.get(id)}`;
          }
          if (value !== attr.value) el.setAttribute(attr.name, value);
        }
      }
    }

    // viewBox가 없으면 원래 크기로 만들어 준다.
    if (!svg.getAttribute("viewBox")) {
      const w = parseFloat(svg.getAttribute("width"));
      const h = parseFloat(svg.getAttribute("height"));
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      }
    }

    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("focusable", "false");

    return svg.outerHTML;
  } catch (error) {
    console.warn("SVG 준비 실패:", error);
    return raw;
  }
}

/* ------------------------------------------------------------------ *
 *  문서 열기
 * ------------------------------------------------------------------ */

function isPasswordError(error) {
  return /password|암호|PASSWORD_REQUIRED/i.test(String(error?.message ?? error));
}

function friendlyError(error) {
  const message = String(error?.message ?? error);
  console.error(error);
  if (isPasswordError(error)) return "문서 암호를 확인해 주세요.";
  if (/unsupported|invalid|corrupt|magic|signature|format|hwp/i.test(message)) {
    return "문서를 읽을 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다.";
  }
  return "문서를 여는 중 문제가 발생했습니다.";
}

function detectFileType(buffer, fileName) {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return "HWPX";
  if (buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return "HWP 5.0";
  }
  return ext === "hwpx" ? "HWPX" : "HWP";
}

function askPassword(invalid) {
  return new Promise((resolve) => {
    els.passwordError.hidden = !invalid;
    els.passwordInput.value = "";
    els.passwordDialog.returnValue = "";

    const onKeyDown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.passwordConfirm.click();
      }
    };
    const onClose = () => {
      els.passwordInput.removeEventListener("keydown", onKeyDown);
      els.passwordDialog.removeEventListener("close", onClose);
      resolve(els.passwordDialog.returnValue === "confirm" ? els.passwordInput.value : null);
    };

    els.passwordInput.addEventListener("keydown", onKeyDown);
    els.passwordDialog.addEventListener("close", onClose);
    els.passwordDialog.showModal();
    requestAnimationFrame(() => els.passwordInput.focus());
  });
}

async function openFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext !== "hwp" && ext !== "hwpx") {
    toast("HWP 또는 HWPX 파일만 열 수 있습니다.");
    return;
  }
  if (file.size > 300 * 1024 * 1024) {
    toast("파일이 너무 큽니다. 300MB 이하 문서를 열어 주세요.");
    return;
  }
  if (state.opening) return;

  state.opening = true;
  showBusy("뷰어 엔진을 준비하는 중…");
  try {
    await loadEngine();

    showBusy("문서를 분석하는 중…");
    const buffer = new Uint8Array(await file.arrayBuffer());
    let doc = null;

    try {
      doc = new HwpDocument(buffer);
    } catch (error) {
      if (!isPasswordError(error)) throw error;

      for (let attempt = 0; attempt < 3 && !doc; attempt++) {
        hideBusy();
        const password = await askPassword(attempt > 0);
        if (password == null) {
          toast("암호 입력을 취소했습니다.");
          return;
        }
        showBusy("문서를 여는 중…");
        try {
          doc = HwpDocument.openWithPassword(buffer, password);
        } catch (passwordError) {
          if (!isPasswordError(passwordError)) throw passwordError;
        }
      }

      if (!doc) {
        hideBusy();
        toast("비밀번호를 3번 잘못 입력했습니다.");
        return;
      }
    }

    await loadDocument(doc, file, buffer);
  } catch (error) {
    hideBusy();
    toast(friendlyError(error));
  } finally {
    state.opening = false;
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function pageGeometry(info) {
  let w = Number(info?.width);
  let h = Number(info?.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    w = A4.pxW;
    h = A4.pxH;
  }
  return {
    pxW: w,
    pxH: h,
    ptW: w * 0.75,
    ptH: h * 0.75,
  };
}

async function loadDocument(doc, file, buffer) {
  const pageCount = doc.pageCount();
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    doc.free?.();
    throw new Error("문서에 페이지가 없습니다.");
  }

  showBusy(`페이지를 배치하는 중… (${pageCount}쪽)`);
  await nextFrame();

  const info = parseJson(doc.getDocumentInfo(), {});
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const pageInfo = parseJson(doc.getPageInfo(i), {});
    pages.push({ index: i, ...pageGeometry(pageInfo), raw: pageInfo });
  }

  // 이전 문서 정리
  state.pageObserver?.disconnect();
  state.thumbObserver?.disconnect();
  els.pages.replaceChildren();
  els.thumbList.replaceChildren();
  state.rendered.clear();
  state.queued.clear();
  state.thumbs = [];
  document.getElementById("printPageStyle")?.remove();

  const previousDoc = state.doc;
  state.doc = doc;
  state.docId += 1;
  state.fileName = file.name;
  state.fileSize = file.size;
  state.fileType = detectFileType(buffer, file.name);
  state.pages = pages;
  state.current = 0;
  state.fitMode = "width";

  buildPages();
  buildThumbs();
  layoutPages();
  els.emptyState.hidden = true;

  // 첫 페이지는 즉시 렌더링해서 빈 화면을 보여주지 않는다.
  const start = performance.now();
  renderPage(0, true);
  const elapsed = Math.round(performance.now() - start);

  fitWidth(true);
  els.stage.scrollTop = 0;
  updateCurrentPage(true);
  updateDocUi(info, pageCount);
  hideBusy();

  els.statusEngine.textContent = ENGINE_LABEL;
  els.statusEngine.title = `첫 페이지 렌더링 ${elapsed}ms`;

  previousDoc?.free?.();
  requestAnimationFrame(() => els.stage.focus({ preventScroll: true }));
}

function buildPages() {
  const fragment = document.createDocumentFragment();
  for (const page of state.pages) {
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";

    const label = document.createElement("div");
    label.className = "page-no";
    label.textContent = String(page.index + 1);

    const el = document.createElement("div");
    el.className = "page is-pending";
    el.dataset.page = String(page.index);
    el.style.width = `${page.pxW}px`;
    el.style.height = `${page.pxH}px`;

    wrap.append(label, el);
    fragment.appendChild(wrap);
    page.wrap = wrap;
    page.el = el;
  }
  els.pages.appendChild(fragment);

  state.pageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) scheduleRender(Number(entry.target.dataset.page));
      }
    },
    { root: els.stage, rootMargin: "1600px 0px", threshold: 0 },
  );
  for (const page of state.pages) state.pageObserver.observe(page.el);
}

function buildThumbs() {
  const fragment = document.createDocumentFragment();
  for (const page of state.pages) {
    const item = document.createElement("button");
    item.className = "thumb-item";
    item.type = "button";
    item.dataset.page = String(page.index);
    item.title = `${page.index + 1}쪽으로 이동`;

    const frame = document.createElement("div");
    frame.className = "thumb-frame is-pending";
    frame.style.aspectRatio = `${page.pxW} / ${page.pxH}`;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");

    const no = document.createElement("span");
    no.className = "thumb-no";
    no.textContent = String(page.index + 1);

    frame.appendChild(canvas);
    item.append(frame, no);
    item.addEventListener("click", () => goToPage(page.index));

    fragment.appendChild(item);
    page.thumb = { item, frame, canvas, rendered: false };
    state.thumbs.push(page.thumb);
  }
  els.thumbList.appendChild(fragment);

  state.thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const page = state.pages[Number(entry.target.dataset.page)];
        if (page) renderThumb(page);
      }
    },
    { root: els.thumbList, rootMargin: "300px 0px", threshold: 0 },
  );
  for (const thumb of state.thumbs) state.thumbObserver.observe(thumb.item);
}

function renderThumb(page) {
  const thumb = page.thumb;
  if (!thumb || thumb.rendered || !state.doc) return;
  try {
    const scale = Math.min(0.5, 400 / Math.max(page.pxW, 1));
    state.doc.renderPageToCanvas(page.index, thumb.canvas, scale);
    thumb.rendered = true;
    thumb.frame.classList.remove("is-pending");
  } catch (error) {
    console.warn("미리보기 렌더링 실패:", error);
    thumb.frame.classList.remove("is-pending");
  }
}

function renderPage(index, immediate = false) {
  const page = state.pages[index];
  if (!page || !state.doc || state.rendered.has(index)) return true;

  try {
    const raw = state.doc.renderPageSvg(index);
    const key = `d${state.docId}p${index}`;
    page.el.innerHTML = prepareSvg(raw, key);
    page.el.classList.remove("is-pending");
    state.rendered.add(index);
    return true;
  } catch (error) {
    console.warn(`페이지 ${index + 1} 렌더링 실패:`, error);
    page.el.classList.remove("is-pending");
    if (!immediate) toast(`${index + 1}쪽을 표시하지 못했습니다.`);
    return false;
  }
}

function scheduleRender(index) {
  if (!state.doc || state.rendered.has(index) || state.queued.has(index)) return;
  state.queued.add(index);
  if (!state.pumping) {
    state.pumping = true;
    requestAnimationFrame(pumpRenderQueue);
  }
}

function pumpRenderQueue() {
  if (!state.doc) {
    state.pumping = false;
    state.queued.clear();
    return;
  }

  let best = -1;
  let bestDistance = Infinity;
  for (const index of state.queued) {
    const distance = Math.abs(index - state.current);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  if (best === -1) {
    state.pumping = false;
    return;
  }

  state.queued.delete(best);
  renderPage(best);
  requestAnimationFrame(pumpRenderQueue);
}

/* ------------------------------------------------------------------ *
 *  배율 / 맞춤
 * ------------------------------------------------------------------ */

function layoutPages() {
  for (const page of state.pages) {
    const w = Math.round(page.pxW * state.zoom * 100) / 100;
    const h = Math.round(page.pxH * state.zoom * 100) / 100;
    page.el.style.width = `${w}px`;
    page.el.style.height = `${h}px`;
  }
}

function zoomTo(next, options = {}) {
  if (!state.pages.length) return;
  const zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);

  const stageRect = els.stage.getBoundingClientRect();
  const anchorY = options.anchorY ?? stageRect.top + stageRect.height / 2;
  const anchorPage = findPageAtY(anchorY) ?? state.pages[state.current] ?? state.pages[0];
  const before = anchorPage?.el.getBoundingClientRect();
  const ratio = before && before.height > 0 ? clamp((anchorY - before.top) / before.height, 0, 1) : 0;

  state.zoom = zoom;
  if (!options.keepFit) state.fitMode = null;
  layoutPages();

  const after = anchorPage?.el.getBoundingClientRect();
  if (after && after.height > 0) {
    els.stage.scrollTop += after.top + ratio * after.height - anchorY;
  }

  updateZoomUi();
  if (!options.silent) {
    requestAnimationFrame(() => updateCurrentPage());
  }
}

function fitWidth(silent = false) {
  if (!state.pages.length) return;
  state.fitMode = "width";
  const widest = Math.max(...state.pages.map((page) => page.pxW));
  const available = els.stage.clientWidth - 56;
  zoomTo(available / widest, { keepFit: true, silent });
}

function fitPage(silent = false) {
  if (!state.pages.length) return;
  state.fitMode = "page";
  const page = state.pages[state.current] ?? state.pages[0];
  const availableW = els.stage.clientWidth - 56;
  const availableH = els.stage.clientHeight - 104;
  zoomTo(Math.min(availableW / page.pxW, availableH / page.pxH), { keepFit: true, silent });
}

function zoomBy(direction) {
  const current = state.zoom;
  let target = current;
  if (direction > 0) {
    target = ZOOM_STEPS.find((step) => step > current + 0.001) ?? MAX_ZOOM;
  } else {
    target = [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? MIN_ZOOM;
  }
  zoomTo(target);
}

function updateZoomUi() {
  const percent = Math.round(state.zoom * 100);
  els.zoomLabel.textContent = `${percent}%`;
  els.statusZoom.textContent = `${percent}%`;
  for (const button of els.zoomMenu.querySelectorAll("[data-zoom]")) {
    const value = Number(button.dataset.zoom);
    button.classList.toggle("is-current", !state.fitMode && Math.abs(value - state.zoom) < 0.005);
  }
  for (const button of els.zoomMenu.querySelectorAll("[data-fit]")) {
    button.classList.toggle("is-current", button.dataset.fit === state.fitMode);
  }
}

function findPageAtY(clientY) {
  for (const page of state.pages) {
    const rect = page.el.getBoundingClientRect();
    if (rect.top <= clientY && rect.bottom >= clientY) return page;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  페이지 이동 / 현재 쪽 추적
 * ------------------------------------------------------------------ */

function goToPage(index, smooth = true) {
  if (!state.pages.length) return;
  const target = clamp(Math.round(index), 0, state.pages.length - 1);
  // 먼 쪽으로 이동할 때 긴 부드러운 스크롤이 이어지지 않도록 가까운 쪽만 애니메이션한다.
  const nearby = Math.abs(target - state.current) <= 3;
  const stageRect = els.stage.getBoundingClientRect();
  const targetRect = state.pages[target].wrap.getBoundingClientRect();
  const top = els.stage.scrollTop + targetRect.top - stageRect.top - 18;
  els.stage.scrollTo({ top: Math.max(0, top), behavior: smooth && nearby ? "smooth" : "auto" });
  state.current = target;
  updatePageUi();
}

function updateCurrentPage(force = false) {
  if (!state.pages.length) return;

  const stageRect = els.stage.getBoundingClientRect();
  const probe = stageRect.top + Math.min(140, els.stage.clientHeight * 0.35);
  let current = 0;

  for (const page of state.pages) {
    const rect = page.el.getBoundingClientRect();
    if (rect.top <= probe) current = page.index;
    else break;
  }

  state.current = current;
  updatePageUi(force);

  // 너무 멀리 떨어진 페이지의 SVG는 메모리에서 내린다.
  if (state.rendered.size > 45) {
    for (const index of [...state.rendered]) {
      if (Math.abs(index - current) > 16) {
        const page = state.pages[index];
        if (page) {
          page.el.replaceChildren();
          page.el.classList.add("is-pending");
          state.rendered.delete(index);
          state.queued.delete(index);
        }
      }
    }
  }
}

function updatePageUi(force = false) {
  if (!state.pages.length) return;
  if (force || document.activeElement !== els.pageInput) {
    els.pageInput.value = String(state.current + 1);
  }
  els.pageTotal.textContent = String(state.pages.length);
  els.statusPage.textContent = `${state.current + 1} / ${state.pages.length}쪽`;

  for (const page of state.pages) {
    const active = page.index === state.current;
    page.thumb?.item.classList.toggle("is-active", active);
    if (active && force) {
      page.thumb?.item.scrollIntoView({ block: "nearest" });
    }
  }
}

function updateDocUi(info, pageCount) {
  els.docName.textContent = state.fileName;
  els.docMeta.textContent = `${state.fileType} · ${pageCount}쪽 · ${formatBytes(state.fileSize)}`;
  els.pageTotal.textContent = String(pageCount);
  els.pageInput.value = "1";
  els.pageInput.disabled = false;
  for (const el of [els.prevPage, els.nextPage, els.printBtn, els.pdfBtn, els.zoomIn, els.zoomOut, els.zoomLabel, els.fitWidth, els.fitPage, els.thumbToggle, els.fullscreenBtn]) {
    el.disabled = false;
  }
  document.title = `${state.fileName} · 한씨`;
  els.statusText.textContent = `${state.fileType} 문서 · 파일이 외부로 전송되지 않았습니다`;
  els.statusEngine.textContent = ENGINE_LABEL;
  if (info?.version) els.docName.title = `${state.fileName}\n한글 ${info.version}`;
}

/* ------------------------------------------------------------------ *
 *  내보내기 (인쇄 / PDF)
 * ------------------------------------------------------------------ */

const exporter = createExporter({
  getDoc: () => state.doc,
  getPages: () => state.pages,
  getFileName: () => state.fileName,
  getPrintRoot: () => els.printRoot,
  prepareSvg,
  showBusy,
  hideBusy,
  setProgress,
  toast,
});

/* ------------------------------------------------------------------ *
 *  이벤트 연결
 * ------------------------------------------------------------------ */

els.openBtn.addEventListener("click", () => els.fileInput.click());
els.emptyOpenBtn.addEventListener("click", () => els.fileInput.click());
els.printBtn.addEventListener("click", () => exporter.print());
els.pdfBtn.addEventListener("click", () => exporter.savePdf());

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = "";
  if (file) openFile(file);
});

els.prevPage.addEventListener("click", () => goToPage(state.current - 1));
els.nextPage.addEventListener("click", () => goToPage(state.current + 1));

els.pageInput.addEventListener("focus", () => els.pageInput.select());
els.pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const value = Number.parseInt(els.pageInput.value, 10);
    if (Number.isFinite(value)) goToPage(value - 1);
    els.pageInput.blur();
  } else if (event.key === "Escape") {
    els.pageInput.value = String(state.current + 1);
    els.pageInput.blur();
  }
});
els.pageInput.addEventListener("blur", () => {
  els.pageInput.value = String(state.current + 1);
});

els.zoomIn.addEventListener("click", () => zoomBy(1));
els.zoomOut.addEventListener("click", () => zoomBy(-1));
els.fitWidth.addEventListener("click", () => fitWidth());
els.fitPage.addEventListener("click", () => fitPage());

els.zoomLabel.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = els.zoomMenu;
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  updateZoomUi();
  menu.hidden = false;
  const rect = els.zoomLabel.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = `${clamp(rect.left, 8, window.innerWidth - menuRect.width - 8)}px`;
  menu.style.top = `${clamp(rect.bottom + 6, 8, window.innerHeight - menuRect.height - 8)}px`;
});

els.zoomMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.zoom) zoomTo(Number(button.dataset.zoom));
  if (button.dataset.fit === "width") fitWidth();
  if (button.dataset.fit === "page") fitPage();
  els.zoomMenu.hidden = true;
});

els.thumbToggle.addEventListener("click", () => {
  const collapsed = els.thumbs.classList.toggle("collapsed");
  els.thumbToggle.setAttribute("aria-pressed", String(!collapsed));
  if (state.fitMode) {
    window.setTimeout(() => {
      if (state.fitMode === "width") fitWidth(true);
      else if (state.fitMode === "page") fitPage(true);
    }, 200);
  }
});

els.fullscreenBtn.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    else await document.exitFullscreen?.();
  } catch {
    toast("전체 화면을 전환할 수 없습니다.");
  }
});

document.addEventListener("fullscreenchange", () => {
  const isFullscreen = Boolean(document.fullscreenElement);
  els.fullscreenBtn.title = isFullscreen ? "전체 화면 종료 (F11)" : "전체 화면 (F11)";
  els.fullscreenBtn.setAttribute("aria-label", isFullscreen ? "전체 화면 종료" : "전체 화면");
});

els.helpBtn.addEventListener("click", () => els.helpDialog.showModal());
els.helpDialog.addEventListener("click", (event) => {
  if (event.target === els.helpDialog) els.helpDialog.close();
});

// 현재 쪽 추적
let scrollTicking = false;
els.stage.addEventListener(
  "scroll",
  () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      updateCurrentPage();
    });
  },
  { passive: true },
);

// Ctrl + 휠 확대/축소
els.stage.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey || !state.doc) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomTo(state.zoom * factor, { anchorY: event.clientY });
  },
  { passive: false },
);

// 툴바/메뉴 바깥 클릭 시 닫기
document.addEventListener("click", (event) => {
  if (!els.zoomMenu.hidden && !els.zoomMenu.contains(event.target) && event.target !== els.zoomLabel) {
    els.zoomMenu.hidden = true;
  }
});
els.stage.addEventListener("scroll", () => {
  if (!els.zoomMenu.hidden) els.zoomMenu.hidden = true;
});

// 창 크기 변경 시 맞춤 배율 유지
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!state.pages.length) return;
    if (state.fitMode === "width") fitWidth(true);
    else if (state.fitMode === "page") fitPage(true);
  }, 130);
});

// 키보드 단축키
document.addEventListener("keydown", (event) => {
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (ctrl && key === "o") {
    event.preventDefault();
    els.fileInput.click();
    return;
  }
  if (ctrl && key === "p") {
    if (!state.doc) return;
    event.preventDefault();
    exporter.print();
    return;
  }
  if (ctrl && key === "s") {
    if (!state.doc) return;
    event.preventDefault();
    exporter.savePdf();
    return;
  }
  if (ctrl && (key === "+" || key === "=")) {
    if (!state.doc) return;
    event.preventDefault();
    zoomBy(1);
    return;
  }
  if (ctrl && key === "-") {
    if (!state.doc) return;
    event.preventDefault();
    zoomBy(-1);
    return;
  }
  if (ctrl && key === "0") {
    if (!state.doc) return;
    event.preventDefault();
    fitWidth();
    return;
  }

  if (event.altKey && event.key === "ArrowLeft") {
    if (!state.doc) return;
    event.preventDefault();
    goToPage(state.current - 1);
  } else if (event.altKey && event.key === "ArrowRight") {
    if (!state.doc) return;
    event.preventDefault();
    goToPage(state.current + 1);
  } else if (event.key === "PageDown" && state.doc && !ctrl) {
    // 기본 동작 유지
  } else if (event.key === "Escape" && !els.zoomMenu.hidden) {
    els.zoomMenu.hidden = true;
  }
});

// 끌어다 놓기
let dragDepth = 0;
const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

window.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});

window.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  const files = Array.from(event.dataTransfer?.files ?? []);
  const supported = files.find((file) => /\.(hwp|hwpx)$/i.test(file.name));
  if (!supported) {
    if (files.length) toast("HWP 또는 HWPX 파일만 열 수 있습니다.");
    return;
  }
  if (files.length > 1) toast("여러 파일 중 첫 번째 한글 문서를 엽니다.");
  openFile(supported);
});

window.addEventListener("beforeunload", () => {
  try {
    state.doc?.free?.();
  } catch {
    /* noop */
  }
});

/* ------------------------------------------------------------------ *
 *  시작
 * ------------------------------------------------------------------ */

// 작은 화면에서는 쪽 목록을 접어 둔다.
if (window.matchMedia("(max-width: 820px)").matches) {
  els.thumbs.classList.add("collapsed");
  els.thumbToggle.setAttribute("aria-pressed", "false");
}

els.statusEngine.textContent = ENGINE_LABEL;
setTimeout(preloadEngine, 700);
