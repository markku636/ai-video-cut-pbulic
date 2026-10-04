import { useCallback, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api, type ProxyMeta } from "../api";
import { useProject } from "../store/project";
import { THUMB_TILE, tileStartOf } from "./draw";

/**
 * 縮圖列：proxy 每 32 幀一格 tile（Rust `thumb_strip` 命令，回快取 PNG 路徑），快取鍵 = 媒體指紋 / start / count / 高度。
 * 抓的策略是「只抓現在畫得到的那幾格」：整段適配時一格 tile 只用到一張縮圖，抓 56 格是浪費。
 *
 * `thumb_strip` 的第一個參數是**媒體指紋**（Rust `media::media_dir` 取前 16 碼、必須全是 hex），不是 proxy 路徑：
 * 以前傳 `proxy.path`（`C:\Users\...`）→ 每一格都 Invalid，縮圖列整個 session 空白。
 *
 * 快取是模組層的（換媒體不丟，鍵裡含指紋）；LRU 上限 256 張、同時最多 3 個請求在飛，
 * 佇列後進先出 —— 使用者剛捲到的地方先出圖。失敗的格子**不是永久失敗**：記下失敗時間，
 * 退避（2s、4s、8s… 上限 60s）後下一次重畫再要就重送 —— proxy 還在建、引擎剛好忙、檔案被防毒鎖一下都是暫時的。
 */
export const THUMB_CACHE_MAX = 256;
const MAX_INFLIGHT = 3;
export const THUMB_RETRY_BASE_MS = 2_000;
export const THUMB_RETRY_MAX_MS = 60_000;
/** 計時器主動叫醒重畫的次數（2+4+8+16+32 秒）；超過之後只跟著使用者的重畫重試。 */
const AUTO_RETRIES = 5;

type Entry = { kind: "ok"; image: HTMLImageElement } | { kind: "error"; at: number; attempts: number };

/** 抓一格需要的 proxy 欄位（fps 給 Rust 算時間、frames 夾最後一格的張數）。 */
export type ThumbProxy = Pick<ProxyMeta, "fps" | "frames">;

const cache = new Map<string, Entry>();
const inflight = new Set<string>();
const queue: { key: string; fingerprint: string; proxy: ThumbProxy; start: number; h: number }[] = [];

/** 版本號：有新圖就 +1，FrameTimeline 訂閱它重畫。 */
export const useThumbVersion = create<{ version: number }>(() => ({ version: 0 }));

function bump() {
  useThumbVersion.setState((s) => ({ version: s.version + 1 }));
}

/** Rust 只看前 16 碼：統一成 16 碼小寫，快取鍵才不會因為傳了 64 碼 / 16 碼而分裂。不是 hex 回 null（別送出去白白失敗）。 */
export function normalizeFingerprint(fp: string | null | undefined): string | null {
  const head = (fp ?? "").slice(0, 16).toLowerCase();
  return /^[0-9a-f]{16}$/.test(head) ? head : null;
}

export function thumbKey(fingerprint: string, start: number, count: number, h: number): string {
  return `${fingerprint}|${start}|${count}|h${h}`;
}

/** 第 n 次失敗之後要等多久才重送。 */
export function retryDelay(attempts: number): number {
  return Math.min(THUMB_RETRY_MAX_MS, THUMB_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function getThumbTile(fingerprint: string, start: number, h: number): HTMLImageElement | null {
  const k = thumbKey(fingerprint, start, THUMB_TILE, h);
  const e = cache.get(k);
  if (!e) return null;
  cache.delete(k);
  cache.set(k, e);
  return e.kind === "ok" ? e.image : null;
}

function pump() {
  while (inflight.size < MAX_INFLIGHT && queue.length) {
    const job = queue.pop()!;
    if (cache.get(job.key)?.kind === "ok" || inflight.has(job.key)) continue;
    inflight.add(job.key);
    const count = Math.max(1, Math.min(THUMB_TILE, job.proxy.frames - job.start));
    api
      .thumbStrip(job.fingerprint, job.proxy.fps, job.start, count, job.h)
      .then(
        (path) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`thumb decode failed: ${path}`));
            img.src = convertFileSrc(path);
          }),
      )
      .then((image) => put(job.key, { kind: "ok", image }))
      .catch(() => {
        const prev = cache.get(job.key);
        const attempts = prev?.kind === "error" ? prev.attempts + 1 : 1;
        put(job.key, { kind: "error", at: Date.now(), attempts });
        // 閒著不動時沒有重畫、也就沒人再叫 ensure：前幾次失敗由計時器叫醒一次重畫；之後只在使用者捲動 / 播放時順便重試，
        // 不讓一直失敗的格子（ffmpeg 壞了之類）每分鐘在背景自己跑
        if (attempts <= AUTO_RETRIES) setTimeout(bump, retryDelay(attempts));
      })
      .finally(() => {
        inflight.delete(job.key);
        pump();
      });
  }
}

function put(key: string, e: Entry) {
  cache.delete(key);
  cache.set(key, e);
  while (cache.size > THUMB_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  bump();
}

/** 這一格現在要不要送：沒抓過、或上次失敗且退避時間到了。 */
function wanted(key: string, now: number): boolean {
  const e = cache.get(key);
  if (!e) return true;
  return e.kind === "error" && now - e.at >= retryDelay(e.attempts);
}

/**
 * 確保這些幀所在的 tile 都在抓 / 已抓；已有的不重送，失敗的退避過了才重送。呼叫端每次重畫都可以叫，成本是幾個 Set 查詢。
 * `fingerprint` = 媒體指紋（64 碼或 16 碼都行）。
 */
export function ensureThumbTiles(fingerprint: string, proxy: ThumbProxy, frames: number[], h: number, now: number = Date.now()): void {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp || h <= 0) return;
  const starts = new Set(frames.map(tileStartOf));
  for (const start of starts) {
    if (start >= proxy.frames) continue;
    const key = thumbKey(fp, start, THUMB_TILE, h);
    if (inflight.has(key) || queue.some((q) => q.key === key) || !wanted(key, now)) continue;
    queue.push({ key, fingerprint: fp, proxy, start, h });
  }
  pump();
}

/** 測試 / 換媒體時釋放。 */
export function clearThumbCache(): void {
  cache.clear();
  queue.length = 0;
  bump();
}

export interface ThumbStrip {
  tileAt: (start: number) => HTMLImageElement | null;
  ensure: (frames: number[]) => void;
}

/**
 * 這個 proxy 屬於哪個媒體的指紋：FrameTimeline 手上只有 `media.proxy`，所以用物件同一性在媒體清單裡找回它的媒體
 * （指紋缺就用 id —— id 就是指紋前 16 碼）。找不到（剛換媒體的一瞬間）回 null，這一輪不抓。
 */
export function fingerprintOfProxy(proxy: ProxyMeta | null, media: readonly { id: string; fingerprint: string; proxy: ProxyMeta | null }[]): string | null {
  if (!proxy) return null;
  const m = media.find((x) => x.proxy === proxy);
  return m ? normalizeFingerprint(m.fingerprint) ?? normalizeFingerprint(m.id) : null;
}

/**
 * hook 形式：回傳給 draw() 用的兩個函式；有新圖時 onUpdate 會被叫（FrameTimeline 拿它 schedule 重畫）。
 */
export function useThumbStrip(proxy: ProxyMeta | null, tileH: number, onUpdate: () => void): ThumbStrip {
  useEffect(() => useThumbVersion.subscribe(onUpdate), [onUpdate]);
  const fingerprint = useProject((s) => fingerprintOfProxy(proxy, s.media));
  const tileAt = useCallback((start: number) => (fingerprint ? getThumbTile(fingerprint, start, tileH) : null), [fingerprint, tileH]);
  const ensure = useCallback(
    (frames: number[]) => {
      if (proxy && fingerprint) ensureThumbTiles(fingerprint, proxy, frames, tileH);
    },
    [proxy, fingerprint, tileH],
  );
  return { tileAt, ensure };
}
