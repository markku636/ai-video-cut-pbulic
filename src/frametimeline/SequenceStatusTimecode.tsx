import { useMemo, type ReactNode } from "react";
import { useT } from "../i18n";
import type { Rational, SequenceV2 } from "../project/format";
import { mapFrame } from "../sequence/map";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { effectiveSpace, useTimeline } from "../store/timeline";
import { timecode } from "../time";
import { sequencePlayhead, viewSequenceOf } from "./layoutSequence";

/**
 * 狀態列的雙時間碼（docs/editor-m2-design.md §12「序列 00:00:12:03｜m1 00:00:33:03（k 993）」，§13 M2.15）：
 * 序列空間同時給序列時間與來源時間 —— 剪輯看序列 TC、追蹤與替換看來源 k，兩個都在眼前就不必切空間去對。
 * 素材空間（或旗標關）顯示 fallback（M1 的「timecode · 幀號」原樣）。
 */

export interface DualTimecode {
  /** 序列幀 t。 */
  t: number;
  seqTc: string;
  /** 播放線所在片段的媒體名、來源 TC 與 k；空白上是 null。 */
  source: { name: string; tc: string; k: number; disabled: boolean } | null;
}

/** 純函式：序列、作用中媒體的 k、playback.seqFrame → 兩個時間碼；播放線不在序列裡回 null。 */
export function dualTimecodeOf(seq: SequenceV2, activeMediaId: string | null, k: number, seqFrame: number | null, mediaOf: (id: string) => { name: string; fps: Rational | null } | undefined): DualTimecode | null {
  const t = sequencePlayhead(seq, activeMediaId, k, seqFrame);
  if (t === null) return null;
  const m = mapFrame(seq, t);
  const clip = m.item?.kind === "clip" ? m.item : null;
  const info = clip ? mediaOf(clip.mediaId) : undefined;
  return {
    t,
    seqTc: timecode(t, seq.fps),
    source: clip && m.itemK !== null ? { name: (info?.name ?? clip.mediaId).replace(/\.[^.]+$/, ""), tc: timecode(m.itemK, info?.fps ?? seq.fps), k: m.itemK, disabled: !clip.enabled } : null,
  };
}

/**
 * playback.seqFrame（M2.11 序列播放器寫）：同一個來源幀在序列裡出現兩次時，只有它知道現在是第幾次出現。
 * 整合時 M2.11 已落地，直接用型別化的欄位（原本為了跟同一波平行開發解耦，用字串讀）。
 */
function useSeqFrame(): number | null {
  return usePlayback((s) => (typeof s.seqFrame === "number" && Number.isFinite(s.seqFrame) ? s.seqFrame : null));
}

export default function SequenceStatusTimecode({ fallback }: { fallback: ReactNode }) {
  const t = useT();
  const flag = useSettings((s) => s.experimental.sequence);
  const space = useTimeline((s) => s.space);
  const stored = useEdits((s) => s.sequence);
  const media = useProject((s) => s.media);
  const activeId = useProject((s) => s.activeMediaId);
  const k = usePlayback((s) => s.frame);
  const seqFrame = useSeqFrame();
  const active = useMemo(() => media.find((m) => m.id === activeId) ?? null, [media, activeId]);
  const seq = useMemo(() => (flag ? viewSequenceOf(stored, active) : null), [flag, stored, active]);
  if (!seq || effectiveSpace(space, flag) !== "sequence") return <>{fallback}</>;
  const d = dualTimecodeOf(seq, activeId, k, seqFrame, (id) => {
    const m = media.find((x) => x.id === id);
    return m ? { name: m.name, fps: m.proxy?.fps ?? null } : undefined;
  });
  if (!d) return <>{fallback}</>;
  const src = d.source ? t("{name} {tc}（k {k}）", { name: d.source.name, tc: d.source.tc, k: d.source.k }) : t("空白");
  return <span title={t("序列時間碼｜來源媒體時間碼（proxy 幀 k）")}>{t("序列 {tc}｜{src}", { tc: d.seqTc, src })}</span>;
}
