import { convertFileSrc } from "@tauri-apps/api/core";
import type { Rational } from "../api";
import { t } from "../i18n";
import { mediaTimeOfFrame } from "../video/frames";

/**
 * 把 proxy 的某一幀擷取成 PNG（舞台右鍵「複製此幀畫面」「另存此幀為 PNG」）。
 *
 * 為什麼另開一個隱藏的 <video>，不直接畫舞台上那一個：
 * 舞台的 <video> 從 asset 協定載入、沒有 crossOrigin —— 對 App 頁面來說是跨來源媒體，畫進 canvas 後
 * canvas 會被「污染」，toBlob 直接丟 SecurityError。Tauri 的 asset 協定有回 Access-Control-Allow-Origin，
 * 所以另開一個 `crossOrigin="anonymous"` 的元素就能合法讀像素；改舞台那一個的 crossOrigin 風險太大
 * （標頭一旦不對，整個播放器就載不起來）。
 *
 * 擷取的是 proxy（CFR、最高 1080p）上的那一幀 —— 時間軸上的幀號本來就是 proxy 幀，所見即所得。
 */

const LOAD_TIMEOUT_MS = 8000;

function waitEvent(v: HTMLVideoElement, name: "loadedmetadata" | "seeked" | "loadeddata", ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      v.removeEventListener(name, onOk);
      v.removeEventListener("error", onErr);
      fn();
    };
    const onOk = () => done(resolve);
    const onErr = () => done(() => reject(new Error(t("讀不到 proxy 影片：{msg}", { msg: v.error?.message || String(v.error?.code ?? "?") }))));
    const timer = setTimeout(() => done(() => reject(new Error(t("擷取此幀逾時")))), ms);
    v.addEventListener(name, onOk);
    v.addEventListener("error", onErr);
  });
}

export interface GrabbedFrame {
  blob: Blob;
  width: number;
  height: number;
}

/** 擷取 proxy 第 `frame` 幀（seek 落在幀中央，與 playerRef 同一套換算）。 */
export async function grabProxyFrame(proxyPath: string, frame: number, fps: Rational): Promise<GrabbedFrame> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  try {
    const meta = waitEvent(v, "loadedmetadata", LOAD_TIMEOUT_MS);
    v.src = convertFileSrc(proxyPath);
    await meta;
    const seeked = waitEvent(v, "seeked", LOAD_TIMEOUT_MS);
    v.currentTime = mediaTimeOfFrame(frame, fps);
    await seeked;
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitEvent(v, "loadeddata", LOAD_TIMEOUT_MS);
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) throw new Error(t("這一幀沒有畫面可以擷取"));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error(t("這一幀沒有畫面可以擷取"));
    ctx.drawImage(v, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => {
      try {
        cv.toBlob((b) => (b ? resolve(b) : reject(new Error(t("PNG 編碼失敗")))), "image/png");
      } catch (e) {
        // 污染的 canvas 會在這裡丟 SecurityError：講人話
        reject(new Error(t("WebView 不允許讀取這支影片的像素（{msg}）", { msg: e instanceof Error ? e.message : String(e) })));
      }
    });
    return { blob, width: w, height: h };
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

type WritableLike = { write: (data: Blob) => Promise<void>; close: () => Promise<void> };
type SavePicker = (opts: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable: () => Promise<WritableLike> }>;

function savePicker(): SavePicker | null {
  if (typeof window === "undefined") return null;
  const p = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return typeof p === "function" ? p.bind(window) : null;
}

/** 這個 WebView 能不能把圖片放進系統剪貼簿（Chromium / WebView2 可以；不行的話選單不列這一項）。 */
export function canCopyImage(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined";
}

/**
 * 這個 WebView 有沒有原生存檔對話框可以寫二進位檔（File System Access API：WebView2 有、WKWebView / WebKitGTK 沒有）。
 * Rust 端只有寫純文字檔的指令，沒有這個 API 的平台就不列「另存此幀為 PNG」，不給一個按了沒用的項目。
 */
export function canSaveBinaryFile(): boolean {
  return savePicker() !== null;
}

/**
 * 放進剪貼簿。先把「還在擷取中」的 Promise 交給 ClipboardItem：Chromium 要求寫剪貼簿時仍在使用者手勢內，
 * 等擷取完才呼叫 write 可能已經過了那個時間窗；不支援 Promise 的實作再退回等完再寫。
 */
export async function copyFrameToClipboard(proxyPath: string, frame: number, fps: Rational): Promise<GrabbedFrame> {
  const grab = grabProxyFrame(proxyPath, frame, fps);
  const blob = grab.then((g) => g.blob);
  // 失敗會在下面 await grab 時接住；這條分支先掛 catch，免得 write 提早失敗時留下「未處理的 rejection」
  blob.catch(() => {});
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return await grab;
  } catch {
    const g = await grab;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": g.blob })]);
    return g;
  }
}

/**
 * 另存 PNG：**先**開存檔對話框（要在使用者手勢內），選好路徑才擷取。取消回 null。
 */
export async function saveFrameAsPng(proxyPath: string, frame: number, fps: Rational, suggestedName: string): Promise<GrabbedFrame | null> {
  const picker = savePicker();
  if (!picker) throw new Error(t("這個平台的 WebView 不支援另存圖片"));
  let handle: Awaited<ReturnType<SavePicker>>;
  try {
    handle = await picker({ suggestedName, types: [{ description: "PNG", accept: { "image/png": [".png"] } }] });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
  const g = await grabProxyFrame(proxyPath, frame, fps);
  const w = await handle.createWritable();
  await w.write(g.blob);
  await w.close();
  return g;
}
