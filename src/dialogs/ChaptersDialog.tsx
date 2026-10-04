import { useMemo, useState } from "react";
import { Bookmark, Copy, ListTree, Sparkles } from "lucide-react";
import { errMessage } from "../api";
import { pickProvider } from "../assistant/provider";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { useT } from "../i18n";
import { DEFAULT_CHAPTERS, formatSummaryText, formatYoutubeChapters, runChapters, sourceFrameToSequence, type ChaptersResult } from "../pipeline/chapters";
import { addMarker } from "../sequence/ops";
import { seekToFrame } from "../stage/playerRef";
import { openDialog } from "../store/dialogs";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { timecode } from "../time";
import { copyToClipboard, toast } from "../ui";
import { Button, Field, Input, Modal, Select, Textarea } from "../ui/index";

/**
 * AI 章節與摘要（對標 Descript 的 Chapters、YouTube Studio 的自動章節、CapCut 的 AI 摘要）。
 *
 * 模型只做語意（哪裡換話題、叫什麼、整支在講什麼）；時間全由引擎決定（吸到字幕段、第一章 0 秒、彼此隔開）。
 * 結果不會自己進專案：列出來讓人改標題、點時間碼看一眼，再決定要「加為標記」還是只複製 YouTube 章節 / 摘要。
 * 這跟助手的「計畫要人按了才執行」是同一條線。
 */
type LangChoice = "auto" | "zh-TW" | "en" | "ja";

export default function ChaptersDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? null;
  const captions = useEdits((s) => (mediaId ? s.captions[mediaId] ?? null : null));
  const stored = useEdits((s) => s.sequence);
  const seq = useMemo(() => viewSequenceOf(stored, media ?? null), [stored, media]);
  const llm = useSettings((s) => pickProvider(s.s));
  const fps = media?.proxy?.fps ?? { num: 30, den: 1 };

  const [maxChapters, setMaxChapters] = useState(DEFAULT_CHAPTERS.maxChapters);
  const [minGap, setMinGap] = useState(DEFAULT_CHAPTERS.minGapSeconds);
  const [language, setLanguage] = useState<LangChoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChaptersResult | null>(null);
  /** 標題可以直接改：這裡是改過的版本（跟 result.chapters 同索引）。 */
  const [titles, setTitles] = useState<string[]>([]);

  const chapters = useMemo(() => (result ? result.chapters.map((c, i) => ({ ...c, title: (titles[i] ?? c.title).trim() })) : []), [result, titles]);

  const run = async () => {
    if (!mediaId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await runChapters(mediaId, { maxChapters, minGapSeconds: minGap, language: language === "auto" ? null : language });
      setResult(r);
      setTitles(r.chapters.map((c) => c.title));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addMarkers = () => {
    if (!seq || !mediaId || !chapters.length) return;
    const placed = chapters.map((c) => ({ c, t: sourceFrameToSequence(seq, mediaId, c.frame) }));
    const ok = placed.filter((p): p is { c: (typeof chapters)[number]; t: number } => p.t != null);
    const skipped = placed.length - ok.length;
    if (!ok.length) {
      toast.error(t("這些章節都落在序列上已經剪掉的地方，沒有地方可以加標記"));
      return;
    }
    try {
      useEdits.getState().editSequence(SEQ_EDIT_LABEL.chapters, (s) => ok.reduce((acc, p) => addMarker(acc, p.t, p.c.title), s));
      toast.success(t("已加入 {n} 個章節標記", { n: ok.length }));
      if (skipped) toast.info(t("有 {n} 章落在序列上已經剪掉的地方，沒有加標記", { n: skipped }));
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
          {t("模型看的是字幕：哪裡換了話題、這一段該叫什麼、整支在講什麼。時間永遠由 App 決定 —— 章節起點吸到最近的字幕段、第一章從 0 秒開始。結果不會自己進專案，看過再加為標記。")}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label={t("最多幾章")}>
            <Input type="number" min={1} max={40} value={maxChapters} onChange={(e) => setMaxChapters(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} disabled={busy} data-testid="chapters-max" />
          </Field>
          <Field label={t("章節至少隔幾秒")}>
            <Input type="number" min={5} max={600} value={minGap} onChange={(e) => setMinGap(Math.max(5, Number(e.target.value) || 5))} disabled={busy} data-testid="chapters-gap" />
          </Field>
          <Field label={t("標題與摘要的語言")}>
            <Select value={language} onChange={(e) => setLanguage(e.target.value as LangChoice)} disabled={busy} data-testid="chapters-lang">
              <option value="auto">{t("跟字幕一樣")}</option>
              <option value="zh-TW">{t("繁體中文")}</option>
              <option value="en">English</option>
              <option value="ja">{t("日本語")}</option>
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="primary" icon={Sparkles} loading={busy} onClick={() => void run()} data-testid="chapters-run">
            {result ? t("重新產生") : t("產生")}
          </Button>
          {busy && <span className="text-[12px] text-fg/50">{t("想一下…")}</span>}
          {result?.model && !busy && <span className="text-[11px] text-fg/40">{t("模型：{m}", { m: result.model })}</span>}
        </div>

        {error && (
          <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-fg/80" data-testid="chapters-error">
            {error}
          </div>
        )}

        {result && (
          <>
            <Field label={t("章節（{n}）", { n: chapters.length })} hint={t("標題可以直接改；點時間碼跳過去看。")}>
              <div className="max-h-56 overflow-auto rounded border border-fg/10 divide-y divide-fg/8" data-testid="chapters-list">
                {result.chapters.map((c, i) => (
                  <div key={`${c.frame}-${i}`} className="flex items-center gap-2 px-2 py-1">
                    <button
                      type="button"
                      className="mono w-20 shrink-0 text-left text-[11px] tabular-nums text-accent hover:underline"
                      onClick={() => void seekToFrame(c.frame)}
                      title={t("跳到這裡")}
                    >
                      {timecode(c.frame, fps)}
                    </button>
                    <Input
                      value={titles[i] ?? ""}
                      onChange={(e) => setTitles((prev) => prev.map((x, k) => (k === i ? e.target.value : x)))}
                      placeholder={c.title ? "" : t("（開場，請自己填標題）")}
                      className="flex-1"
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>
            </Field>

            {(result.title || result.summary || result.keywords.length > 0) && (
              <Field label={t("摘要")}>
                <div className="space-y-1.5 rounded border border-fg/10 bg-fg/4 px-3 py-2 text-[12px]" data-testid="chapters-summary">
                  {result.title && <div className="font-medium text-fg/90">{result.title}</div>}
                  {result.summary && <Textarea readOnly value={result.summary} rows={3} className="w-full resize-none bg-transparent" />}
                  {result.keywords.length > 0 && <div className="text-fg/55">{result.keywords.map((k) => `#${k}`).join("  ")}</div>}
                </div>
              </Field>
            )}

            {result.warnings.length > 0 && (
              <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-fg/75" data-testid="chapters-warnings">
                <div className="mb-0.5 text-fg/50">{t("引擎整理時修掉的：")}</div>
                <ul className="list-disc pl-4">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {chapters.length < 3 && <div className="text-[11px] text-fg/50">{t("YouTube 要至少三章才會顯示章節；不夠的話可以把「最多幾章」調高再產生一次。")}</div>}
          </>
        )}
      </div>
    );
  })();

  return (
    <Modal
      open
      onClose={onClose}
      title={t("AI 章節與摘要")}
      icon={ListTree}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button variant="ghost" icon={Copy} disabled={!result} onClick={() => result && void copyToClipboard(formatSummaryText({ ...result }), t("已複製摘要"))} data-testid="chapters-copy-summary">
            {t("複製摘要")}
          </Button>
          <Button variant="ghost" icon={Copy} disabled={!chapters.length} onClick={() => void copyToClipboard(formatYoutubeChapters(chapters, fps), t("已複製 YouTube 章節"))} data-testid="chapters-copy-youtube">
            {t("複製 YouTube 章節")}
          </Button>
          <Button variant="primary" icon={Bookmark} disabled={!chapters.length || !seq} onClick={addMarkers} data-testid="chapters-add-markers">
            {t("加為標記")}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
