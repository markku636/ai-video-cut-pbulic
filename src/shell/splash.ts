/**
 * 開場畫面（index.html 的 `#boot-splash`）的退場時機。
 *
 * 以前最短停留是「從**網頁開始載入**算 780 ms」。問題是視窗根本不是那時候出現的：
 * 視窗以 `visible:false` 啟動，index.html 要到 DOMContentLoaded + 2 rAF 才呼叫 `show_main_window`。
 * 實測（RESP-05，真的 WebView2、安裝版 v0.0.6、4 次啟動）：視窗出現在頁面時間 132–237 ms、
 * React 第一次 commit 108–193 ms，而開場畫面要到 780–792 ms 才開始淡出 —— 也就是使用者盯著一張
 * 「已經準備好了」的畫面看了 0.55–0.65 秒。
 *
 * 所以最短停留改成從**視窗出現**起算（B-18），長度降到 {@link SPLASH_MIN_MS}：動畫仍然看得完整
 * （視窗出現的那一刻才是它第一次被看到的時刻），但不再多押一段空等。
 */

/** 視窗出現之後，開場畫面至少再留這麼久（毫秒）。減少動態偏好時是 0。 */
export const SPLASH_MIN_MS = 250;
/** 淡出動畫長度，與 index.html 的 transition 對齊；淡出期間 `.done` 已經把 pointer-events 關掉，UI 可以操作。 */
export const SPLASH_FADE_MS = 300;
/** 等「視窗出現」最多等這麼久；等不到就當場退場（絕不能因為少了一個時刻就永遠蓋著畫面）。 */
export const SHOWN_WAIT_MAX_MS = 2000;

/** index.html 呼叫 `show_main_window` 的那一刻寫在 window 上的頁面時間。 */
export const SHOWN_AT_KEY = "__AIVC_WINDOW_SHOWN_AT";

interface SplashWindow {
  performance: { now: () => number };
  requestAnimationFrame: (cb: () => void) => number;
  setTimeout: (cb: () => void, ms: number) => number;
  matchMedia?: (q: string) => { matches: boolean };
  [SHOWN_AT_KEY]?: unknown;
}

/** 視窗出現的頁面時間；index.html 那段還沒跑到就是 null。 */
export function windowShownAt(w: Pick<SplashWindow, typeof SHOWN_AT_KEY>): number | null {
  const v = w[SHOWN_AT_KEY];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 現在還要再等多久才可以讓開場畫面退場。
 *
 * `shownAt` 是 null（量不到視窗出現的時刻）時退回舊行為的起點（導覽開始，也就是 0），
 * 這樣最壞情況也只是跟以前一樣多等一點點，不會反而卡更久。
 */
export function splashWaitMs(opts: { now: number; shownAt: number | null; reduced?: boolean }): number {
  if (opts.reduced) return 0;
  return Math.max(0, SPLASH_MIN_MS - (opts.now - (opts.shownAt ?? 0)));
}

/**
 * 等到「視窗出現」的時刻可以用為止再回呼。
 *
 * 為什麼需要等：main.tsx 是 module script，會在 DOMContentLoaded **之前**執行，而 index.html 是在
 * DOMContentLoaded + 2 rAF 才記下視窗出現的時刻 —— React 的第一次 commit 有機會比它早。
 * 等不到就用現在的時間當起點（見 {@link SHOWN_WAIT_MAX_MS}）。
 */
export function whenWindowShown(w: SplashWindow, cb: (shownAt: number | null) => void): void {
  const now = windowShownAt(w);
  if (now != null) {
    cb(now);
    return;
  }
  const start = w.performance.now();
  const tick = () => {
    const v = windowShownAt(w);
    if (v != null) return cb(v);
    if (w.performance.now() - start > SHOWN_WAIT_MAX_MS) return cb(null);
    w.requestAnimationFrame(tick);
  };
  w.requestAnimationFrame(tick);
}

/** 撤掉 index.html 的開場畫面：等視窗出現滿 {@link SPLASH_MIN_MS} 後加上 `.done`，淡出跑完再移除節點。 */
export function hideBootSplash(doc: Document = document, w: SplashWindow = window as unknown as SplashWindow): void {
  const el = doc.getElementById("boot-splash");
  if (!el || el.classList.contains("done")) return; // StrictMode 會跑兩次
  const reduced = w.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  whenWindowShown(w, (shownAt) => {
    w.setTimeout(() => {
      el.classList.add("done");
      w.setTimeout(() => el.remove(), SPLASH_FADE_MS);
    }, splashWaitMs({ now: w.performance.now(), shownAt, reduced }));
  });
}
