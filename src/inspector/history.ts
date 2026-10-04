import { RELATIVE_TIME_LABEL } from "./labels";

/**
 * 歷史面板的攤平算術（沿 ai-music-cut analysis/history.ts）。堆疊怎麼存是 store/edits.ts 的事，
 * 但「第幾列對應第幾步」錯一格就會跳到相鄰的狀態，所以放在純函式裡測。
 */
export interface HistoryStep {
  label: string;
  at: number;
}

export interface HistoryRow {
  /** 0 = 初始狀態；1..N = 第 n 次改動之後的狀態。 */
  index: number;
  label: string;
  at: number | null;
  current: boolean;
  /** 在目前狀態之後（已被復原、可重做）。 */
  undone: boolean;
}

/** future 是反的（復原推到尾巴、重做從尾巴取回），攤平時要反轉。 */
export function historyRows(past: HistoryStep[], future: HistoryStep[]): HistoryRow[] {
  const all = [...past, ...[...future].reverse()];
  const cur = past.length;
  const rows: HistoryRow[] = [{ index: 0, label: "", at: null, current: cur === 0, undone: false }];
  all.forEach((s, i) => {
    const index = i + 1;
    rows.push({ index, label: s.label, at: s.at, current: index === cur, undone: index > cur });
  });
  return rows;
}

export function currentIndex(past: HistoryStep[]): number {
  return past.length;
}

/** 相對時間的 zh key + 參數（呼叫端 t(key, {n})），字串本身在 labels.ts 讓 i18n 稽核看得到。 */
export function relativeTimeParts(at: number, nowMs: number): { key: string; n?: number } {
  const s = Math.max(0, Math.round((nowMs - at) / 1000));
  if (s < 5) return { key: RELATIVE_TIME_LABEL.now };
  if (s < 60) return { key: RELATIVE_TIME_LABEL.seconds, n: s };
  const m = Math.floor(s / 60);
  if (m < 60) return { key: RELATIVE_TIME_LABEL.minutes, n: m };
  return { key: RELATIVE_TIME_LABEL.hours, n: Math.floor(m / 60) };
}
