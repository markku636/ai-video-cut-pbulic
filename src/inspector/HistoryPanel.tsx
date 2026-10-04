import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { useT } from "../i18n";
import { Button, EmptyState } from "../ui/index";
import { useEdits } from "./_contracts";
import { currentIndex, historyRows, relativeTimeParts } from "./history";

/**
 * 歷史（沿 ai-music-cut HistoryPanel；計畫 §9）：把 edits 的 past / future 攤成可以點的清單。
 * 已被復原的列**留著**（灰的），那正是「重做」要點的東西；一有新改動它們才會被丟掉。
 * 每一步是整份快照，jumpTo(n) = 連續 undo / redo，跟一步一步按等價。
 * Patch.label 是 zh key（store/edits.ts 在 check-i18n 的 TABLE_SOURCES 裡），顯示時 t() 過。
 */
export default function HistoryPanel() {
  const t = useT();
  const past = useEdits((s) => s.past);
  const future = useEdits((s) => s.future);
  const jumpTo = useEdits((s) => s.jumpTo);
  const [now, setNow] = useState(() => Date.now());

  // 相對時間要會走，否則「剛剛」會一直停在那裡
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const rows = historyRows(past, future);
  const cur = currentIndex(past);

  if (rows.length <= 1) {
    return <EmptyState icon={History} title={t("還沒有任何改動")} hint={t("拖一個角、換一個目標或加一個遮罩提示之後，這裡會列出每一步，點一下就跳回去。")} compact />;
  }

  const rel = (at: number) => {
    const p = relativeTimeParts(at, now);
    return t(p.key, p.n === undefined ? undefined : { n: p.n });
  };

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center gap-2 border-b border-fg/8 px-2 py-1.5 text-[11px] text-fg/45">
        <span>{t("{n} 步", { n: rows.length - 1 })}</span>
        {future.length > 0 && <span className="text-fg/35">{t("（{n} 步可重做）", { n: future.length })}</span>}
        <Button size="sm" variant="ghost" icon={RotateCcw} className="ml-auto" disabled={cur === 0} onClick={() => jumpTo(0)} title={t("回到最初（可以再點回來）")}>
          {t("回到最初")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 最新的排在最上面：想退回的通常是剛剛做的那幾步 */}
        {[...rows].reverse().map((r) => (
          <button
            key={r.index}
            type="button"
            onClick={() => jumpTo(r.index)}
            aria-current={r.current || undefined}
            className={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-[12px] ${
              r.current ? "bg-accent/15 text-accent" : r.undone ? "text-fg/30 hover:bg-fg/5" : "text-fg/75 hover:bg-fg/5"
            }`}
          >
            <span className="w-5 shrink-0 text-right tabular-nums text-[10px] text-fg/30">{r.index || "–"}</span>
            <span className="min-w-0 flex-1 truncate">{r.index === 0 ? t("開啟時的狀態") : t(r.label)}</span>
            {r.at != null && <span className="shrink-0 text-[10px] tabular-nums text-fg/30">{rel(r.at)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
