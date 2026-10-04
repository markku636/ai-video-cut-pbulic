import type { Rational } from "./project/format";

/** 毫秒 → "m:ss.mmm"（>1h 則 "h:mm:ss.mmm"）。 */
export function formatMs(ms: number, opts: { millis?: boolean } = {}): string {
  const millis = opts.millis ?? true;
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const base = `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
  return millis ? `${base}.${String(frac).padStart(3, "0")}` : base;
}

/** 毫秒 → 簡短時長（"12:34" / "1:02:03"）。 */
export function formatDuration(ms: number): string {
  return formatMs(ms, { millis: false });
}

/** 秒（小數）→ "1.8 秒" 之類的短字串。 */
export function formatSec(ms: number): string {
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} 秒`;
}

/**
 * 幀號 → SMPTE 風格 timecode "hh:mm:ss:ff"。
 *
 * 時間軸上的單位是**整數 proxy 幀**（計畫決策 3），不是毫秒：VFR 來源用毫秒會漂。
 * 每秒幀數取 ceil(num/den)（29.97 → 30 格），ff 永遠 < 那個值；非 drop-frame，
 * 30000/1001 的 timecode 會比牆鐘慢 0.1%，這裡是給人對齊幀用的，不是給廣播用的。
 */
export function timecode(frame: number, fps: Rational): string {
  const f = Math.max(0, Math.floor(frame));
  const perSec = Math.max(1, Math.ceil(fps.num / fps.den));
  const secs = Math.floor(f / perSec);
  const ff = f - secs * perSec;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(ff)}`;
}
