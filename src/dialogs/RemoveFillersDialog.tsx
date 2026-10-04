import { useEffect, useMemo, useState } from "react";
import { Eraser } from "lucide-react";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { useT } from "../i18n";
import { durationFrames } from "../sequence/map";
import { addMarker, extractRange } from "../sequence/ops";
import { DEFAULT_FILLER, fillerCutOfSequence, totalFrames, type FillerKind, type FillerSpan } from "../sequence/transcript";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { selectActiveMedia, useProject } from "../store/project";
import { timecode } from "../time";
import { toast } from "../ui";
import { Button, Field, Modal } from "../ui/index";

/**
 * 移除語助詞（對標 Descript 的 Remove Filler Words / CapCut 的智慧剪輯）。
 *
 * 跟「移除靜音」同一條路（找範圍 → 預覽 → 一筆 undo 的波紋刪除），差別在判準是**文字**不是音量，
 * 材料是 ASR 已經給的逐字時間碼。
 *
 * **為什麼要逐段勾選而不是一鍵剪完**：遲疑音（呃、uh）沒有語意，剪了一定對；
 * 但「那個、就是說」同時是真的詞，「我我」也可能是刻意的重複。字典分不出上下文，
 * 看得到畫面的人分得出來 —— 所以清單把每一段連同時間碼列出來，預設全勾，要留的自己取消。
 */
const KIND_ORDER: FillerKind[] = ["hesitation", "repeat", "discourse"];

function kindLabel(t: (zh: string) => string, k: FillerKind): string {
  if (k === "hesitation") return t("遲疑音");
  if (k === "repeat") return t("重複的字");
  return t("口頭禪");
}

/** 段的識別：同一支媒體、同一句、同一個字的位置。 */
const keyOf = (s: FillerSpan) => `${s.mediaId}|${s.cueId}|${s.i0}`;

export default function RemoveFillersDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const stored = useEdits((s) => s.sequence);
  const active = useProject(selectActiveMedia);
  const captions = useEdits((s) => s.captions);
  const seq = useMemo(() => viewSequenceOf(stored, active ?? null), [stored, active]);

  const [discourse, setDiscourse] = useState(DEFAULT_FILLER.includeDiscourseMarkers);
  const [repeats, setRepeats] = useState(DEFAULT_FILLER.includeRepeats);
  /** 取消勾選的段；預設全勾，所以記「不要的」比記「要的」短。 */
  const [off, setOff] = useState<Set<string>>(new Set());

  const opts = useMemo(() => ({ includeDiscourseMarkers: discourse, includeRepeats: repeats }), [discourse, repeats]);
  const trackFor = useMemo(() => (id: string) => captions[id] ?? null, [captions]);
  const found = useMemo(() => (seq ? fillerCutOfSequence(seq, trackFor, opts) : null), [seq, trackFor, opts]);
  const result = useMemo(
    () => (seq ? fillerCutOfSequence(seq, trackFor, opts, (s) => !off.has(keyOf(s))) : null),
    [seq, trackFor, opts, off],
  );

  // 換了選項之後找到的段不一樣了，舊的取消記錄留著會莫名其妙地讓新的段是灰的
  useEffect(() => setOff(new Set()), [discourse, repeats]);

  if (!seq || !found || !result) {
    return (
      <Modal open onClose={onClose} title={t("移除語助詞")} icon={Eraser}>
        <div className="text-sm text-fg/60">{t("還沒有序列：先開啟影片並等 proxy 建好")}</div>
      </Modal>
    );
  }

  const spans = [...found.spans].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.k0 - b.k0);
  const frames = durationFrames(seq);
  const cut = totalFrames(result.ranges);
  const picked = spans.filter((s) => !off.has(keyOf(s))).length;

  const toggle = (k: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const apply = () => {
    if (!result.ranges.length) return;
    try {
      // 倒序：先刪後面的範圍，前面那些的序列座標才不會偏（同 RemoveSilenceDialog）
      useEdits.getState().editSequence(SEQ_EDIT_LABEL.removeFillers, (s, ctx) => [...result.ranges].reverse().reduce((acc, r) => extractRange(acc, r, ctx), s));
      toast.success(t("已移除 {n} 段語助詞", { n: result.ranges.length }));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    }
    onClose();
  };

  /** 只加標記不剪：先一段一段聽過再決定，跟移除靜音同一個理由。 */
  const markOnly = () => {
    if (!result.ranges.length) return;
    try {
      useEdits.getState().editSequence(SEQ_EDIT_LABEL.addMarker, (s) => result.ranges.reduce((acc, r) => addMarker(acc, r.in, t("語助詞")), s));
      toast.success(t("已加入 {n} 個標記", { n: result.ranges.length }));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    }
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("移除語助詞")}
      icon={Eraser}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button variant="ghost" onClick={markOnly} disabled={!result.ranges.length}>
            {t("只加標記")}
          </Button>
          <Button variant="primary" onClick={apply} disabled={!result.ranges.length} data-testid="remove-fillers-apply">
            {t("移除")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="text-[12px] leading-relaxed text-fg/60">
          {t("依字幕的逐字時間碼剪。遲疑音（呃、uh）沒有語意，剪了一定對；口頭禪與重複的字同時也是真的詞，所以每一段都列出來讓你確認 —— 要留的取消勾選。")}
        </div>

        <Field label={t("要找什麼")}>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-fg/55">
              <input type="checkbox" checked disabled readOnly />
              <span>{t("遲疑音（呃、嗯、uh、um…）一定找")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} data-testid="remove-fillers-repeats" />
              <span>{t("重複講的同一個字（我我我 → 只留最後一個）")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={discourse} onChange={(e) => setDiscourse(e.target.checked)} data-testid="remove-fillers-discourse" />
              <span>{t("口頭禪（那個、就是說…）")}</span>
            </label>
            <div className="pl-6 text-[11px] text-fg/55">{t("口頭禪同時是真的詞：「那個紅色的」的「那個」剪掉句子就壞了。開了請逐段看過再套用。")}</div>
          </div>
        </Field>

        {found.missing.length > 0 && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-fg/80" data-testid="remove-fillers-missing">
            {t("有 {n} 支素材還沒有字幕，這一輪不會動到它們的片段。先在「字幕」分頁產生字幕。", { n: found.missing.length })}
          </div>
        )}

        {spans.length > 0 && (
          <Field label={t("找到 {n} 段（勾起來的會剪掉）", { n: spans.length })}>
            <div className="max-h-56 overflow-auto rounded border border-fg/10 divide-y divide-fg/8" data-testid="remove-fillers-list">
              {spans.map((s) => {
                const k = keyOf(s);
                return (
                  <label key={k} className="flex items-center gap-2 px-2 py-1 hover:bg-fg/5 cursor-pointer">
                    <input type="checkbox" checked={!off.has(k)} onChange={() => toggle(k)} className="accent-accent" />
                    <span className="mono text-[11px] text-fg/45 tabular-nums w-20 shrink-0">{timecode(s.k0, seq.fps)}</span>
                    <span className="text-[11px] text-fg/45 w-16 shrink-0">{kindLabel(t, s.kind)}</span>
                    <span className="truncate">{s.text}</span>
                  </label>
                );
              })}
            </div>
          </Field>
        )}

        <div className="rounded border border-fg/10 bg-fg/4 px-3 py-2" data-testid="remove-fillers-preview">
          {result.ranges.length ? (
            <span className="text-fg/80">
              {t("勾了 {p} 段、實際剪 {n} 處共 {cut}；剩下 {left}", {
                p: picked,
                n: result.ranges.length,
                cut: timecode(cut, seq.fps),
                left: timecode(frames - cut, seq.fps),
              })}
            </span>
          ) : (
            <span className="text-fg/55">{spans.length ? t("一段都沒勾") : t("沒有找到語助詞")}</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
