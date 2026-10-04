import { useMemo, useState } from "react";
import { Bookmark, Flame, Play, Scissors, Sparkles, SquareDashed, Upload } from "lucide-react";
import { errMessage } from "../api";
import { pickProvider } from "../assistant/provider";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { useT } from "../i18n";
import { DEFAULT_HIGHLIGHTS, keepOnlyRanges, runHighlights, type HighlightClip, type HighlightsResult } from "../pipeline/highlights";
import { sourceFrameToSequence } from "../pipeline/chapters";
import { addMarker } from "../sequence/ops";
import { durationFrames } from "../sequence/map";
import { playRange } from "../stage/playerRef";
import { openDialog } from "../store/dialogs";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { selectActiveMedia, useProject } from "../store/project";
import { sequenceEditingEnabled, useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { timecode } from "../time";
import { toast } from "../ui";
import { Badge, Button, Field, IconButton, Input, Modal, Select } from "../ui/index";

/**
 * AI 精華片段（對標 Opus Clip、CapCut 的 AI 精華、Descript 的 Highlights）。
 *
 * 模型從字幕挑「最值得單獨拿出來的幾段」；起訖由引擎吸到字幕段邊界。這裡讓人**先看再決定**：
 * 每段可以播、設為範圍、直接輸出；勾起來的可以加為標記，或「只留這幾段」建成序列（其餘波紋刪除、一筆 undo）。
 */
type LangChoice = "auto" | "zh-TW" | "en" | "ja";

export default function HighlightsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? null;
  const captions = useEdits((s) => (mediaId ? s.captions[mediaId] ?? null : null));
  const stored = useEdits((s) => s.sequence);
  const seq = useMemo(() => viewSequenceOf(stored, media ?? null), [stored, media]);
  const llm = useSettings((s) => pickProvider(s.s));
  const seqOn = useSettings((s) => s.experimental.sequence);
  const fps = media?.proxy?.fps ?? { num: 30, den: 1 };

  const [count, setCount] = useState(DEFAULT_HIGHLIGHTS.count);
  const [minS, setMinS] = useState(DEFAULT_HIGHLIGHTS.minSeconds);
  const [maxS, setMaxS] = useState(DEFAULT_HIGHLIGHTS.maxSeconds);
  const [language, setLanguage] = useState<LangChoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HighlightsResult | null>(null);
  /** 取消勾選的段（預設全勾，記「不要的」比較短）。 */
  const [off, setOff] = useState<Set<number>>(new Set());

  const picked = useMemo(() => (result ? result.clips.filter((_, i) => !off.has(i)) : []), [result, off]);
  const pickedFrames = picked.reduce((n, c) => n + (c.endFrame - c.startFrame), 0);

  const run = async () => {
    if (!mediaId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await runHighlights(mediaId, { count, minSeconds: minS, maxSeconds: Math.max(minS, maxS), language: language === "auto" ? null : language });
      setResult(r);
      setOff(new Set());
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const addMarkers = () => {
    if (!seq || !mediaId || !picked.length) return;
    const placed = picked.map((c) => ({ c, t: sourceFrameToSequence(seq, mediaId, c.startFrame) })).filter((p): p is { c: HighlightClip; t: number } => p.t != null);
    if (!placed.length) {
      toast.error(t("這些段都落在序列上已經剪掉的地方，沒有地方可以加標記"));
      return;
    }
    try {
      useEdits.getState().editSequence(SEQ_EDIT_LABEL.highlights, (s) => placed.reduce((acc, p) => addMarker(acc, p.t, p.c.title || t("精華")), s));
      toast.success(t("已加入 {n} 個精華標記", { n: placed.length }));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: errMessage(e) }));
    }
    onClose();
  };

  const keepOnly = () => {
    if (!seq || !mediaId || !picked.length) return;
    if (!sequenceEditingEnabled()) {
      toast.error(t("序列剪輯關著：到設定開啟「序列剪輯」才能建序列"));
      return;
    }
    try {
      const ok = useEdits.getState().editSequence(SEQ_EDIT_LABEL.keepHighlights, (s, ctx) =>
        keepOnlyRanges(
          s,
          mediaId,
          picked.map((c) => ({ in: c.startFrame, out: c.endFrame })),
          ctx,
        ),
      );
      if (!ok) {
        toast.error(t("這些段都不在序列上，沒有東西可以留"));
        return;
      }
      const after = useEdits.getState().sequence;
      toast.success(t("序列只剩 {n} 段、共 {len}", { n: picked.length, len: after ? timecode(durationFrames(after), fps) : "—" }));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: errMessage(e) }));
    }
    onClose();
  };

  const body = (() => {
    if (!captions?.cues.length) return <div className="text-sm text-fg/60">{t("還沒有字幕：先在「字幕」分頁產生字幕")}</div>;
    if (!llm) {
      return (
        <div className="space-y-3 text-sm">
          <div className="text-fg/60">{t("還沒設定 AI 端點")}</div>
          <Button onClick={() => openDialog("settings", { focus: "engine" })}>{t("去設定")}</Button>
        </div>
      );
    }
    return (
      <div className="space-y-4 text-sm">
        <div className="text-[12px] leading-relaxed text-fg/60">
          {t("模型從字幕挑出最值得單獨拿出來的幾段（開頭有鉤子、講完一個完整的想法），起訖吸到字幕段的邊界。每段可以先播、設為範圍或直接輸出；勾起來的可以加為標記，或只留這幾段建成序列。")}
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Field label={t("最多幾段")}>
            <Input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} disabled={busy} data-testid="highlights-count" />
          </Field>
          <Field label={t("每段至少幾秒")}>
            <Input type="number" min={3} max={600} value={minS} onChange={(e) => setMinS(Math.max(3, Number(e.target.value) || 3))} disabled={busy} data-testid="highlights-min" />
          </Field>
          <Field label={t("每段最多幾秒")}>
            <Input type="number" min={5} max={900} value={maxS} onChange={(e) => setMaxS(Math.max(5, Number(e.target.value) || 5))} disabled={busy} data-testid="highlights-max" />
          </Field>
          <Field label={t("標題與理由的語言")}>
            <Select value={language} onChange={(e) => setLanguage(e.target.value as LangChoice)} disabled={busy} data-testid="highlights-lang">
              <option value="auto">{t("跟字幕一樣")}</option>
              <option value="zh-TW">{t("繁體中文")}</option>
              <option value="en">English</option>
              <option value="ja">{t("日本語")}</option>
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" icon={Sparkles} loading={busy} onClick={() => void run()} data-testid="highlights-run">
            {result ? t("重新產生") : t("產生")}
          </Button>
          {busy && <span className="text-[12px] text-fg/50">{t("想一下…")}</span>}
          {result?.model && !busy && <span className="text-[11px] text-fg/40">{t("模型：{m}", { m: result.model })}</span>}
        </div>

        {error && (
          <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-fg/80" data-testid="highlights-error">
            {error}
          </div>
        )}

        {result && (
          <>
            <Field label={t("精華（{n}）", { n: result.clips.length })} hint={t("依模型給的分數排。勾起來的段才會加標記／留下來。")}>
              <div className="max-h-64 overflow-auto rounded border border-fg/10 divide-y divide-fg/8" data-testid="highlights-list">
                {result.clips.map((c, i) => (
                  <div key={`${c.startFrame}-${i}`} className={`flex items-start gap-2 px-2 py-1.5 ${off.has(i) ? "opacity-55" : ""}`}>
                    <input type="checkbox" checked={!off.has(i)} onChange={() => toggle(i)} className="mt-1 accent-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge tone={c.score >= 8 ? "success" : c.score >= 6 ? "accent" : "neutral"}>{t("{s} 分", { s: Math.round(c.score) })}</Badge>
                        <span className="mono text-[11px] tabular-nums text-fg/50">
                          {timecode(c.startFrame, fps)}–{timecode(c.endFrame, fps)}
                        </span>
                        <span className="text-[11px] text-fg/40">{t("{d} 秒", { d: Math.round(c.end - c.start) })}</span>
                        {c.cps > 0 && (
                          <span className="text-[11px] text-fg/35" title={t("這段每秒講幾個字（從字幕算）")}>
                            {t("{c} 字/秒", { c: c.cps.toFixed(1) })}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-fg/90">{c.title || t("（沒有標題）")}</div>
                      {c.reason && <div className="truncate text-[11px] text-fg/50">{c.reason}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <IconButton icon={Play} label={t("播放這一段")} iconSize={13} box="w-6 h-6" onClick={() => void playRange(c.startFrame, c.endFrame)} />
                      <IconButton icon={SquareDashed} label={t("設為範圍")} iconSize={13} box="w-6 h-6" onClick={() => useTimeline.getState().setRange({ in: c.startFrame, out: c.endFrame })} />
                      <IconButton icon={Upload} label={t("輸出這一段…")} iconSize={13} box="w-6 h-6" onClick={() => openDialog("export", { range: { in: c.startFrame, out: c.endFrame } })} />
                    </div>
                  </div>
                ))}
              </div>
            </Field>

            {result.warnings.length > 0 && (
              <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-fg/75" data-testid="highlights-warnings">
                <div className="mb-0.5 text-fg/50">{t("引擎整理時修掉的：")}</div>
                <ul className="list-disc pl-4">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded border border-fg/10 bg-fg/4 px-3 py-2 text-[12px]" data-testid="highlights-summary">
              {picked.length ? (
                <span className="text-fg/80">{t("勾了 {n} 段、共 {len}", { n: picked.length, len: timecode(pickedFrames, fps) })}</span>
              ) : (
                <span className="text-fg/55">{t("沒有勾任何一段")}</span>
              )}
              {!seqOn && <div className="mt-1 text-fg/45">{t("序列剪輯關著：到設定開啟「序列剪輯」才能建序列")}</div>}
            </div>
          </>
        )}
      </div>
    );
  })();

  return (
    <Modal
      open
      onClose={onClose}
      title={t("AI 精華片段")}
      icon={Flame}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button variant="ghost" icon={Bookmark} disabled={!picked.length || !seq} onClick={addMarkers} data-testid="highlights-add-markers">
            {t("加為標記")}
          </Button>
          <Button variant="primary" icon={Scissors} disabled={!picked.length || !seq || !seqOn} onClick={keepOnly} data-testid="highlights-keep">
            {t("只留勾選的段（建序列）")}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
