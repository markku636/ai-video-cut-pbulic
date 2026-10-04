import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftToLine,
  ArrowRightToLine,
  Captions,
  Check,
  ChevronDown,
  ChevronUp,
  Combine,
  Download,
  Eye,
  EyeOff,
  FileText,
  Flame,
  ImageDown,
  RefreshCw,
  Replace,
  Scissors,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { runCommand } from "../commands/registry";
import { useT } from "../i18n";
import { CAPTIONS_JOB_KIND } from "../pipeline/captions";
import { engineWarningText, fallbackReasonText } from "../pipeline/captionWarnings";
import { CAPTION_PRESET_IDS, type CaptionCueFlag, type CaptionCueV1, type CaptionPresetId, type CaptionTrackV1, type Rational } from "../project/format";
import { useActiveMedia, useActiveMediaId } from "../stage/active";
import {
  ASR_LANGUAGES,
  ASR_MODELS,
  CAPTION_PRESETS,
  LOW_CONFIDENCE_PROB,
  cueAtFrame,
  cueText,
  effectiveStyle,
  findCues,
  findMatchCount,
  frameOfSeconds,
  isFlaggedCue,
  msOfFrame,
  parseHotwords,
  useCaptionsUi,
  type AsrModel,
  type TranscribeOptions,
} from "../store/captions";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { cuesInSequence } from "../sequence/transcript";
import { useEngine } from "../store/engine";
import { useJobs } from "../store/jobs";
import { usePlayback } from "../store/playback";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";
import { Badge, Button, EmptyState, Icon, IconButton, Input, Segmented, Select } from "../ui/index";
import { useVirtual } from "../ui/useVirtual";
import { useEdits } from "./_contracts";
import { CommandButton, CommandIconButton } from "./CommandButton";
import { createPendingCommit } from "./pendingCommit";

/**
 * 字幕分頁（feat/captions；規格 §5.7 Inspector）：
 * - 產生：模型 / 語言 / 裝置 / 範圍 / 熱詞 / 本機 LLM 校對 → 「產生字幕」（派發 captions.generateQuick，選項記在 localStorage）；
 * - 樣式：六個預設（換預設只換樣式、舞台即時預覽；要依新預設重新分段另外按）、位置 / 字級、燒入開關；
 * - 段落清單：點時間碼跳過去、行內改字（打字 800 ms 內合併成一筆 undo）、逐字晶片（低信心虛線底、點字後按 E 切強調）、
 *   分割 / 合併 / 起訖 ±1 幀 / 隱藏 / 刪除；篩選「待檢查」；尋找取代（Ctrl+F）。
 * 所有會改字幕的動作都走 store/edits（一個動作一筆 undo）；面板按鈕派發指令的一律用 CommandButton（不能做會說原因）。
 * 不訂閱 playback.frame 本身：只訂「播放線落在哪一段」（段 id 變了才重繪），播放時面板不會一秒重繪 30 次。
 */

type TFn = ReturnType<typeof useT>;

const NO_CUES: CaptionCueV1[] = [];

export function presetLabel(t: TFn, id: CaptionPresetId): string {
  switch (id) {
    case "subtitle":
      return t("標準字幕");
    case "karaoke":
      return t("卡拉OK");
    case "pop":
      return t("跳字");
    case "bounce":
      return t("彈跳單字");
    case "typewriter":
      return t("打字機");
    case "boxHighlight":
      return t("方框高亮");
  }
}

function presetHint(t: TFn, id: CaptionPresetId): string {
  switch (id) {
    case "subtitle":
      return t("一句一段，底部白字黑邊（Netflix 規則）");
    case "karaoke":
      return t("逐字抹色，跟著唸到哪亮到哪");
    case "pop":
      return t("每次 1–3 個詞，唸到的字彈大變色");
    case "bounce":
      return t("一次一個詞，彈簧進場");
    case "typewriter":
      return t("逐字打出，半透明底框");
    case "boxHighlight":
      return t("唸到的字加色塊底框，框會滑動");
  }
}

function modelHint(t: TFn, m: AsrModel): string {
  switch (m) {
    case "large-v3-turbo":
      return t("推薦：快又準，約 2.6 GB 顯示記憶體");
    case "large-v3":
      return t("最準但較慢，約 4.5 GB 顯示記憶體");
    case "medium":
      return t("中等，約 1.7 GB 顯示記憶體");
    case "small":
      return t("快，約 0.9 GB，準確度較低");
    case "base":
      return t("很快，準確度低");
    case "tiny":
      return t("最快，只適合測試");
  }
}

function languageLabel(t: TFn, lang: string): string {
  switch (lang) {
    case "zh":
      return t("中文（輸出台灣繁體）");
    case "en":
      return t("英文");
    case "ja":
      return t("日文");
    case "ko":
      return t("韓文");
    case "yue":
      return t("粵語");
    case "auto":
      return t("自動偵測");
    default:
      return lang;
  }
}

function flagLabel(t: TFn, f: string): string | null {
  switch (f) {
    case "lowConfidence":
      return t("低信心");
    case "hallucination":
      return t("疑似幻覺");
    case "tooFast":
      return t("太快");
    case "overflow":
      return t("排不下");
    default:
      return null;
  }
}

function tc(k: number, fps: Rational | null): string {
  return fps ? formatMs(msOfFrame(k, fps)) : String(k);
}

export default function CaptionsPanel() {
  const t = useT();
  const mediaId = useActiveMediaId();
  const media = useActiveMedia();
  const track = useEdits((s) => (mediaId ? s.captions[mediaId] ?? null : null));
  const job = useJobs((s) => s.jobs.find((j) => j.kind === CAPTIONS_JOB_KIND && j.mediaId === mediaId && (j.status === "running" || j.status === "queued")) ?? null);
  const fps = media?.proxy?.fps ?? null;

  if (!mediaId) return <EmptyState icon={Captions} title={t("先開啟一支影片")} hint={t("字幕用本機語音辨識模型產生，不會上傳任何東西。")} compact />;

  return (
    <div className="flex h-full flex-col min-h-0 text-[12px]">
      <GenerateForm collapsed={!!track} running={!!job} />
      {job && (
        <div className="border-b border-fg/8 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="truncate text-fg/70">{job.step || t("語音辨識")}</span>
            {job.pct != null && <span className="tabular-nums text-fg/45">{Math.round(job.pct)}%</span>}
            <CommandIconButton id="captions.cancel" label={t("停止")} icon={Square} iconSize={13} className="ml-auto" />
          </div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-accent/15" role="progressbar" aria-valuenow={job.pct == null ? undefined : Math.round(job.pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full bg-accent transition-[width] duration-200 ${job.pct == null ? "w-1/3 animate-pulse" : ""}`} style={job.pct == null ? undefined : { width: `${Math.max(2, Math.min(100, job.pct))}%` }} />
          </div>
        </div>
      )}
      <RunStatus mediaId={mediaId} fps={fps} />
      {track ? (
        <TrackEditor mediaId={mediaId} track={track} fps={fps} frames={media?.proxy?.frames ?? null} />
      ) : (
        !job && <EmptyState icon={Captions} title={t("還沒有字幕")} hint={t("選好語言按「產生字幕」；或在播放線按「插入字幕」手動打。")} compact action={<CommandButton id="captions.insertCue" label={t("插入字幕")} />} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 產生
// ---------------------------------------------------------------------------

function GenerateForm({ collapsed, running }: { collapsed: boolean; running: boolean }) {
  const t = useT();
  const opts = useCaptionsUi((s) => s.opts);
  const setOpts = useCaptionsUi((s) => s.setOpts);
  const range = useTimeline((s) => s.range);
  const endpoint = useSettings((s) => s.s.llm_openai_base_url.trim());
  const gpuName = useEngine((s) => s.gpuName);
  const [open, setOpen] = useState(!collapsed);
  const [hotDraft, setHotDraft] = useState(opts.hotwords.join("、"));
  useEffect(() => setOpen(!collapsed), [collapsed]);

  const set = (p: Partial<TranscribeOptions>) => setOpts(p);
  const body = (
    <div className="grid gap-2 px-3 pb-2.5 pt-1">
      <label className="grid gap-1">
        <span className="text-[11px] text-fg/50">{t("語音模型")}</span>
        <Select value={opts.model} onChange={(e) => set({ model: e.target.value as AsrModel })} disabled={running}>
          {ASR_MODELS.map((m) => (
            <option key={m} value={m}>
              {`${m} — ${modelHint(t, m)}`}
            </option>
          ))}
        </Select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1">
          <span className="text-[11px] text-fg/50">{t("語言")}</span>
          <Select value={opts.language} onChange={(e) => set({ language: e.target.value })} disabled={running}>
            {ASR_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {languageLabel(t, l)}
              </option>
            ))}
          </Select>
        </label>
        <div className="grid gap-1">
          <span className="text-[11px] text-fg/50">{t("裝置")}</span>
          <Segmented
            full
            value={opts.device}
            onChange={(device) => set({ device })}
            options={[
              { value: "auto", label: t("自動"), title: gpuName ?? undefined },
              { value: "cuda", label: "GPU" },
              { value: "cpu", label: "CPU" },
            ]}
          />
        </div>
      </div>
      {opts.language === "auto" && (
        <div className="flex gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          <Icon icon={AlertTriangle} size={13} className="mt-px shrink-0" />
          {t("自動偵測遇到中英混雜的影片，可能整段漏掉其中一種語言；建議明確選語言。")}
        </div>
      )}
      <div className="grid gap-1">
        <span className="text-[11px] text-fg/50">{t("範圍")}</span>
        <Segmented
          full
          value={opts.scope}
          onChange={(scope) => set({ scope })}
          options={[
            { value: "all", label: t("整支影片") },
            { value: "range", label: t("I/O 範圍"), disabled: !range, title: range ? undefined : t("先用 I / O 標一段範圍") },
          ]}
        />
      </div>
      <label className="grid gap-1">
        <span className="text-[11px] text-fg/50">{t("熱詞（人名、專有名詞，用逗號或頓號分隔）")}</span>
        <Input value={hotDraft} placeholder={t("例如：產品名、人名、專有名詞")} onChange={(e) => setHotDraft(e.target.value)} onBlur={() => set({ hotwords: parseHotwords(hotDraft) })} disabled={running} />
      </label>
      <label className="flex items-start gap-2 text-[12px]">
        <input type="checkbox" className="mt-0.5" checked={opts.refine} disabled={!endpoint || running} onChange={(e) => set({ refine: e.target.checked })} />
        <span className="grid">
          <span>{t("產生後用本機 LLM 校對（建議要按套用才會生效）")}</span>
          <span className="text-[11px] text-fg/45 break-all">{endpoint ? t("端點：{url}", { url: endpoint }) : t("先在設定填本機 LLM 端點（OpenAI 相容）")}</span>
        </span>
      </label>
      <div className="grid gap-1">
        <span className="text-[11px] text-fg/50">{t("樣式")}</span>
        <PresetGrid value={opts.preset} onPick={(preset) => set({ preset })} />
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        {running ? <CommandButton id="captions.cancel" label={t("停止")} icon={Square} /> : <CommandButton id="captions.generateQuick" label={collapsed ? t("重新產生字幕") : t("產生字幕")} icon={Captions} variant="primary" />}
        <span className="text-[11px] text-fg/40">{t("本機模型，不上傳；第一次會下載模型")}</span>
      </div>
    </div>
  );

  if (!collapsed) return <div className="border-b border-fg/8 pt-1.5">{body}</div>;
  return (
    <div className="border-b border-fg/8">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-fg/70 hover:bg-fg/5" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon icon={open ? ChevronUp : ChevronDown} size={13} />
        {t("重新產生 / 辨識設定")}
      </button>
      {open && body}
    </div>
  );
}

function RunStatus({ mediaId, fps }: { mediaId: string; fps: Rational | null }) {
  const t = useT();
  const err = useCaptionsUi((s) => (s.lastError?.mediaId === mediaId ? s.lastError : null));
  const run = useCaptionsUi((s) => (s.lastRun?.mediaId === mediaId ? s.lastRun : null));
  const setOpts = useCaptionsUi((s) => s.setOpts);
  if (!err && !run) return null;
  const gaps = run?.gaps ?? [];
  // 引擎給的是中文人話（或代碼）：一律經 captionWarnings 依目前語言組句，英文介面才不會冒出整句中文
  const fallback = run ? fallbackReasonText(run.fallbackReason, t) : null;
  const retranscribe = (g: [number, number]) => {
    if (!fps) return;
    useTimeline.getState().setRange({ in: frameOfSeconds(g[0], fps), out: frameOfSeconds(g[1], fps) });
    setOpts({ scope: "range" });
    void runCommand("captions.generateQuick", "toolbar");
  };
  return (
    <div className="grid gap-1.5 border-b border-fg/8 px-3 py-2 text-[11px]">
      {err && (
        <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-danger">
          <div className="break-words">{err.message}</div>
          {err.kind === "PyEnv" && (
            <Button size="sm" variant="secondary" icon={RefreshCw} className="mt-1.5" onClick={() => void runCommand("captions.installEngine", "toolbar")}>
              {t("安裝 / 修復引擎依賴")}
            </Button>
          )}
        </div>
      )}
      {run && (
        <div className="text-fg/50">
          {[run.device ? `${run.device}${run.computeType ? ` · ${run.computeType}` : ""}` : null, run.seconds != null ? t("{s} 秒", { s: run.seconds.toFixed(1) }) : null].filter(Boolean).join(" · ")}
          {fallback && <div className="text-warning break-words">{fallback}</div>}
          {run.warnings.map((w, i) => (
            <div key={`${i}-${w.code ?? w.message}`} className="text-warning break-words">
              {engineWarningText(w, t)}
            </div>
          ))}
        </div>
      )}
      {gaps.length > 0 && (
        <div className="grid gap-1">
          <div className="text-warning">{t("{n} 段有人聲卻沒有字（可能漏辨識）", { n: gaps.length })}</div>
          {gaps.slice(0, 6).map((g) => (
            <div key={`${g[0]}-${g[1]}`} className="flex items-center gap-2">
              <span className="tabular-nums text-fg/60">
                {formatMs(g[0] * 1000)} – {formatMs(g[1] * 1000)}
              </span>
              <button type="button" className="ml-auto text-accent hover:underline" onClick={() => retranscribe(g)}>
                {t("重新辨識這段")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PresetGrid({ value, onPick }: { value: CaptionPresetId; onPick: (id: CaptionPresetId) => void }) {
  const t = useT();
  return (
    <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t("樣式")}>
      {CAPTION_PRESET_IDS.map((id) => {
        const st = CAPTION_PRESETS[id].style;
        const active = id === value;
        const hi = st.colors.active ?? st.colors.emphasis;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            title={presetHint(t, id)}
            onClick={() => onPick(id)}
            className={`grid gap-1 rounded border p-1 text-left ${active ? "border-accent bg-accent/10" : "border-fg/10 hover:bg-fg/5"}`}
          >
            {/* 縮圖是「影片上的樣子」，固定深底，不跟主題翻 */}
            <span className="grid h-7 place-items-center rounded-sm text-[13px] leading-none" style={{ background: "#16181d", fontWeight: st.font.weight }}>
              <span style={{ color: st.colors.text, textShadow: st.stroke.widthPct > 0 ? `0 0 2px ${st.colors.stroke}, 0 0 2px ${st.colors.stroke}` : undefined, background: st.box.mode === "line" ? st.box.color : undefined, padding: "0 3px", borderRadius: 2 }}>
                {"字"}
                <span style={{ color: hi, background: st.box.mode === "activeWord" ? st.box.color : undefined, borderRadius: 2, padding: "0 1px" }}>{"幕"}</span>
              </span>
            </span>
            <span className="truncate text-[11px]">{presetLabel(t, id)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 編輯
// ---------------------------------------------------------------------------

function TrackEditor({ mediaId, track, fps, frames }: { mediaId: string; track: CaptionTrackV1; fps: Rational | null; frames: number | null }) {
  const t = useT();
  const setPreset = useEdits((s) => s.setCaptionPreset);
  const setStyle = useEdits((s) => s.setCaptionStyle);
  const setEnabled = useEdits((s) => s.setCaptionsEnabled);
  const showOnStage = useCaptionsUi((s) => s.showOnStage);
  const setShowOnStage = useCaptionsUi((s) => s.setShowOnStage);
  const filter = useCaptionsUi((s) => s.filter);
  const setFilter = useCaptionsUi((s) => s.setFilter);
  const findOpen = useCaptionsUi((s) => s.findOpen);
  const setFind = useCaptionsUi((s) => s.setFind);
  const style = useMemo(() => effectiveStyle(track), [track]);
  const flagged = track.cues.filter(isFlaggedCue).length;
  const hasSource = !!track.source?.asrPath;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid gap-2 border-b border-fg/8 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1.5" title={t("輸出影片時把字幕燒進畫面")}>
            <input type="checkbox" checked={track.enabled} onChange={(e) => setEnabled(mediaId, e.target.checked)} />
            <Icon icon={Flame} size={13} className={track.enabled ? "text-warning" : "text-fg/40"} />
            {t("輸出時燒入")}
          </label>
          <label className="flex items-center gap-1.5" title={t("只影響舞台預覽，不影響輸出（Shift+C）")}>
            <input type="checkbox" checked={showOnStage} onChange={(e) => setShowOnStage(e.target.checked)} />
            {t("舞台顯示")}
          </label>
          <span className="ml-auto text-[11px] text-fg/45">{t("{n} 段", { n: track.cues.length })}</span>
        </div>
        <PresetGrid value={track.presetId} onPick={(id) => setPreset(mediaId, id)} />
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
          <span className="text-[11px] text-fg/50">{t("字幕位置")}</span>
          <Segmented
            full
            value={style.layout.anchor}
            onChange={(anchor) => setStyle(mediaId, { layout: { anchor } })}
            options={[
              { value: "top", label: t("上") },
              { value: "middle", label: t("中") },
              { value: "bottom", label: t("下") },
            ]}
          />
          <span className="text-[11px] text-fg/50">{t("字級")}</span>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={2}
              max={16}
              step={0.1}
              value={style.font.sizePctShortSide}
              aria-label={t("字級（畫面短邊 %）")}
              className="flex-1"
              onChange={(e) => setStyle(mediaId, { font: { sizePctShortSide: Number(e.target.value) } })}
            />
            <span className="w-12 text-right tabular-nums text-fg/60">{style.font.sizePctShortSide.toFixed(1)}%</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <CommandButton id="captions.exportSrt" label="SRT" icon={Download} />
          <CommandButton id="captions.exportVtt" label="VTT" icon={FileText} />
          <CommandIconButton id="captions.previewFrame" label={t("引擎預覽此幀字幕")} icon={ImageDown} />
          <CommandIconButton id="captions.refine" label={t("本機 LLM 校對字幕")} icon={Sparkles} />
          {hasSource && <CommandIconButton id="captions.rebuild" label={t("依目前樣式重新分段")} icon={RefreshCw} />}
          <CommandIconButton id="captions.clear" label={t("刪除全部字幕")} icon={Trash2} className="ml-auto" />
        </div>
        <div className="text-[11px] text-fg/40">{t("舞台上是近似預覽；最終長相以輸出（引擎渲染）為準。")}</div>
      </div>

      <ProposalReview mediaId={mediaId} />

      <div className="flex items-center gap-2 border-b border-fg/8 px-3 py-1.5">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("全部") },
            { value: "flagged", label: flagged ? t("待檢查 {n}", { n: flagged }) : t("待檢查") },
          ]}
        />
        <IconButton icon={Search} label={t("尋找 / 取代（Ctrl+F）")} iconSize={14} box="w-7 h-7 ml-auto" active={findOpen} onClick={() => setFind({ findOpen: !findOpen })} />
      </div>
      {findOpen && <FindBar mediaId={mediaId} track={track} />}
      <CueList mediaId={mediaId} track={track} fps={fps} frames={frames} cjkLatinSpace={style.font.cjkLatinSpace} />
    </div>
  );
}

function ProposalReview({ mediaId }: { mediaId: string }) {
  const t = useT();
  const proposal = useCaptionsUi((s) => (s.proposal?.mediaId === mediaId ? s.proposal : null));
  const setProposal = useCaptionsUi((s) => s.setProposal);
  const apply = useEdits((s) => s.applyCaptionProposals);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  if (!proposal) return null;
  const chosen = proposal.items.filter((it) => !skip.has(it.cueId));
  return (
    <div className="grid max-h-56 gap-1.5 overflow-y-auto border-b border-fg/8 bg-accent/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon icon={Sparkles} size={13} className="text-accent" />
        <span className="font-medium">{t("本機 LLM 建議 {n} 處修改", { n: proposal.items.length })}</span>
      </div>
      {proposal.items.map((it) => (
        <label key={it.cueId} className="flex items-start gap-2 rounded bg-panel px-2 py-1">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={!skip.has(it.cueId)}
            onChange={(e) => {
              const next = new Set(skip);
              if (e.target.checked) next.delete(it.cueId);
              else next.add(it.cueId);
              setSkip(next);
            }}
          />
          <span className="grid min-w-0 gap-0.5">
            <span className="text-fg/45 line-through break-words">{it.before}</span>
            <span className="break-words">{it.after}</span>
            {it.emphasis.length > 0 && <span className="text-[11px] text-accent">{t("強調：{words}", { words: it.emphasis.join("、") })}</span>}
          </span>
        </label>
      ))}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="primary"
          icon={Check}
          disabled={!chosen.length}
          onClick={() => {
            apply(
              mediaId,
              chosen.map((it) => ({ cueId: it.cueId, text: it.after, emphasis: it.emphasis })),
            );
            setProposal(null);
            setSkip(new Set());
          }}
        >
          {t("套用 {n} 處", { n: chosen.length })}
        </Button>
        <Button size="sm" variant="ghost" icon={X} onClick={() => setProposal(null)}>
          {t("捨棄")}
        </Button>
      </div>
    </div>
  );
}

function FindBar({ mediaId, track }: { mediaId: string; track: CaptionTrackV1 }) {
  const t = useT();
  const query = useCaptionsUi((s) => s.query);
  const replacement = useCaptionsUi((s) => s.replacement);
  const caseSensitive = useCaptionsUi((s) => s.caseSensitive);
  const setFind = useCaptionsUi((s) => s.setFind);
  const selectCue = useCaptionsUi((s) => s.selectCue);
  const findReplace = useEdits((s) => s.findReplace);
  const inputRef = useRef<HTMLInputElement>(null);
  const cjkLatinSpace = effectiveStyle(track).font.cjkLatinSpace;
  const hits = useMemo(() => findCues(track.cues, query, { caseSensitive, cjkLatinSpace }), [track.cues, query, caseSensitive, cjkLatinSpace]);
  const total = useMemo(() => track.cues.reduce((n, c) => n + findMatchCount(cueText(c, cjkLatinSpace), query, caseSensitive), 0), [track.cues, query, caseSensitive, cjkLatinSpace]);
  useEffect(() => inputRef.current?.focus(), []);

  const jump = (dir: 1 | -1) => {
    if (!hits.length) return;
    const cur = useCaptionsUi.getState().selectedCueId;
    const i = cur ? hits.indexOf(cur) : -1;
    const id = hits[(i + dir + hits.length) % hits.length];
    const cue = track.cues.find((c) => c.id === id);
    selectCue(id);
    if (cue) usePlayback.getState().seek(cue.startFrame);
  };

  return (
    <div className="grid gap-1.5 border-b border-fg/8 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          value={query}
          placeholder={t("尋找")}
          onChange={(e) => setFind({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") jump(e.shiftKey ? -1 : 1);
            if (e.key === "Escape") setFind({ findOpen: false });
          }}
        />
        <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-fg/50">{query ? t("{n} 處", { n: total }) : ""}</span>
        <IconButton icon={ChevronUp} label={t("上一個")} iconSize={14} disabled={!hits.length} onClick={() => jump(-1)} />
        <IconButton icon={ChevronDown} label={t("下一個")} iconSize={14} disabled={!hits.length} onClick={() => jump(1)} />
      </div>
      <div className="flex items-center gap-1.5">
        <Input value={replacement} placeholder={t("取代為")} onChange={(e) => setFind({ replacement: e.target.value })} />
        <Button
          size="sm"
          icon={Replace}
          disabled={!total}
          onClick={() => {
            const n = findReplace(mediaId, query, replacement, { caseSensitive });
            if (n) setFind({ query: replacement });
          }}
        >
          {t("全部取代")}
        </Button>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-fg/60">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setFind({ caseSensitive: e.target.checked })} />
        {t("區分大小寫")}
      </label>
    </div>
  );
}

function CueList({ mediaId, track, fps, frames, cjkLatinSpace }: { mediaId: string; track: CaptionTrackV1; fps: Rational | null; frames: number | null; cjkLatinSpace: boolean }) {
  const t = useT();
  const filter = useCaptionsUi((s) => s.filter);
  const selectedCueId = useCaptionsUi((s) => s.selectedCueId);
  const cues = track.cues ?? NO_CUES;
  const shown = useMemo(() => (filter === "flagged" ? cues.filter(isFlaggedCue) : cues), [cues, filter]);
  // 字幕是**來源**的逐字稿：序列剪掉一段之後那幾句還在這裡，只是不會再播到。
  // 沒有這個標示的話，用「刪掉這句，連影片一起剪」或移除靜音之後看起來像沒剪到。
  const storedSeq = useEdits((s) => s.sequence);
  const activeMedia = useActiveMedia();
  const inEdit = useMemo(() => {
    const seq = viewSequenceOf(storedSeq, activeMedia ?? null);
    return seq ? cuesInSequence(seq, mediaId, cues) : null;
  }, [storedSeq, activeMedia, mediaId, cues]);
  const keys = useMemo(() => shown.map((c) => c.id), [shown]);
  const v = useVirtual(keys, 56);
  // 只訂「播放線在哪一段」：段 id 沒變就不重繪
  const playingCueId = usePlayback((s) => cueAtFrame(cues, s.frame)?.id ?? null);
  const playing = usePlayback((s) => s.playing);
  const { scrollToKey } = v;
  useEffect(() => {
    if (playing && playingCueId) scrollToKey(playingCueId);
  }, [playing, playingCueId, scrollToKey]);
  useEffect(() => {
    if (selectedCueId) scrollToKey(selectedCueId);
  }, [selectedCueId, scrollToKey]);

  // 捲動容器一定要一開始就掛著：useVirtual 只在掛載時綁一次 scroll / resize 監聽，空清單時不掛的話，之後有段也量不到視窗高度
  return (
    <div ref={v.scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {!shown.length && <EmptyState icon={Check} title={filter === "flagged" ? t("沒有需要檢查的段") : t("沒有字幕段")} compact />}
      <div style={{ paddingTop: v.padTop, paddingBottom: v.padBottom }}>
        {shown.slice(v.start, v.end).map((cue) => (
          <div key={cue.id} ref={v.measure(cue.id)}>
            <CueRow mediaId={mediaId} cue={cue} isLast={cues[cues.length - 1]?.id === cue.id} fps={fps} frames={frames} selected={cue.id === selectedCueId} atPlayhead={cue.id === playingCueId} cjkLatinSpace={cjkLatinSpace} cut={!!inEdit && !inEdit.has(cue.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface CueRowProps {
  mediaId: string;
  cue: CaptionCueV1;
  isLast: boolean;
  fps: Rational | null;
  frames: number | null;
  selected: boolean;
  atPlayhead: boolean;
  cjkLatinSpace: boolean;
  /** 序列上已經沒有這一句的畫面了（被剪掉 / 沒放進剪輯）。 */
  cut: boolean;
}

function CueRow({ mediaId, cue, isLast, fps, frames, selected, atPlayhead, cjkLatinSpace, cut }: CueRowProps) {
  const t = useT();
  const selectCue = useCaptionsUi((s) => s.selectCue);
  const selectedWord = useCaptionsUi((s) => (s.selectedWord?.cueId === cue.id ? s.selectedWord.index : null));
  const selectWord = useCaptionsUi((s) => s.selectWord);
  const edits = useEdits.getState;
  const text = cueText(cue, cjkLatinSpace);
  const flags = (cue.flags ?? []).map((f) => ({ f, label: flagLabel(t, f) })).filter((x): x is { f: CaptionCueFlag; label: string } => !!x.label);
  const seek = (k: number) => usePlayback.getState().seek(k);
  const nudge = (d: number, edge: "start" | "end") => edits().nudgeCue(mediaId, cue.id, d, edge, frames);

  return (
    <div
      className={`border-b border-fg/5 px-3 py-1.5 ${selected ? "bg-accent/10" : atPlayhead ? "bg-fg/[0.04]" : "hover:bg-fg/[0.03]"} ${cue.hidden || cut ? "opacity-50" : ""}`}
      onClick={() => {
        if (!selected) selectCue(cue.id);
      }}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={`tabular-nums text-[11px] hover:underline ${atPlayhead ? "text-accent" : "text-fg/50"}`}
          title={t("跳到這段")}
          onClick={(e) => {
            e.stopPropagation();
            selectCue(cue.id);
            seek(cue.startFrame);
          }}
        >
          {tc(cue.startFrame, fps)} → {tc(cue.endFrame, fps)}
        </button>
        {flags.map(({ f, label }) => (
          <Badge key={f} tone={f === "hallucination" ? "danger" : "warning"}>
            {label}
          </Badge>
        ))}
        {cue.flags?.includes("edited") && <span className="text-[10px] text-fg/35">{t("已修改")}</span>}
        {cut && (
          <span className="text-[10px] text-fg/45" title={t("序列上已經沒有這一句的畫面；字幕本身還在，素材再放回去就會出現。")} data-testid="cue-not-in-edit">
            {t("不在剪輯裡")}
          </span>
        )}
        <span className="ml-auto flex items-center">
          <IconButton icon={cue.hidden ? EyeOff : Eye} label={cue.hidden ? t("顯示這段") : t("隱藏這段（不輸出）")} iconSize={13} box="w-6 h-6" onClick={(e) => (e.stopPropagation(), edits().setCueHidden(mediaId, cue.id, !cue.hidden))} />
          <IconButton icon={Trash2} label={t("刪除這段")} iconSize={13} box="w-6 h-6" onClick={(e) => (e.stopPropagation(), edits().deleteCue(mediaId, cue.id))} />
        </span>
      </div>
      {selected ? (
        <div className="mt-1 grid gap-1.5">
          <CueTextInput mediaId={mediaId} cueId={cue.id} text={text} />
          <div className="flex flex-wrap gap-0.5" aria-label={t("逐字（點字選取，E 切換強調）")}>
            {cue.words.map((w, i) => {
              const low = typeof w.prob === "number" && w.prob < LOW_CONFIDENCE_PROB;
              const sel = selectedWord === i;
              return (
                <button
                  key={`${i}-${w.startFrame}`}
                  type="button"
                  title={`${tc(w.startFrame, fps)}${typeof w.prob === "number" ? ` · ${t("信心 {p}%", { p: Math.round(w.prob * 100) })}` : ""}${w.emphasis ? ` · ${t("強調")}` : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectWord({ cueId: cue.id, index: i });
                    seek(w.startFrame);
                  }}
                  className={`rounded-sm px-1 py-px text-[12px] ${sel ? "ring-1 ring-accent" : ""} ${w.emphasis ? "bg-warning/20 text-warning" : "bg-fg/5"} ${low ? "border-b border-dashed border-warning" : ""}`}
                >
                  {w.text.trim() || "·"}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <IconButton icon={Scissors} label={t("在選中的字前面分割")} iconSize={13} box="w-6 h-6" disabled={selectedWord == null || selectedWord < 1} onClick={() => selectedWord != null && edits().splitCue(mediaId, cue.id, selectedWord)} />
            <IconButton icon={Combine} label={t("與下一段合併")} iconSize={13} box="w-6 h-6" disabled={isLast} onClick={() => edits().mergeCueWithNext(mediaId, cue.id)} />
            <span className="mx-1 h-4 w-px bg-fg/10" />
            <span className="text-[11px] text-fg/45">{t("起點")}</span>
            <IconButton icon={ArrowLeftToLine} label={t("起點提早 1 幀（Ctrl+Alt+←）")} iconSize={13} box="w-6 h-6" onClick={() => nudge(-1, "start")} />
            <IconButton icon={ArrowRightToLine} label={t("起點延後 1 幀（Ctrl+Alt+→）")} iconSize={13} box="w-6 h-6" onClick={() => nudge(1, "start")} />
            <span className="text-[11px] text-fg/45">{t("終點")}</span>
            <IconButton icon={ArrowLeftToLine} label={t("終點提早 1 幀（Ctrl+Alt+Shift+←）")} iconSize={13} box="w-6 h-6" onClick={() => nudge(-1, "end")} />
            <IconButton icon={ArrowRightToLine} label={t("終點延後 1 幀（Ctrl+Alt+Shift+→）")} iconSize={13} box="w-6 h-6" onClick={() => nudge(1, "end")} />
          </div>
        </div>
      ) : (
        <div className={`mt-0.5 break-words ${cue.hidden || cut ? "line-through" : ""}`}>{text}</div>
      )}
    </div>
  );
}

/**
 * 行內改字：打字時用本地草稿（不讓 store 的正規化 —— 例如句尾空白被收掉 —— 把游標搶走），
 * 停 300 ms 或離開輸入框才 commit；同一段連續 commit 由 edits 在 800 ms 內合併成一筆 undo。Esc 放棄草稿。
 * 卸載時（播放中自動捲動把這列捲出虛擬清單、換媒體）還沒送出的字要 **flush**，不能跟著計時器一起清掉（驗收 Low）。
 */
function CueTextInput({ mediaId, cueId, text }: { mediaId: string; cueId: string; text: string }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  // 計時器觸發 / 卸載 flush 時要比對的是「那一刻」的段與文字，不是排程當下那次 render 的 props
  const latest = useRef({ mediaId, cueId, text });
  useEffect(() => {
    latest.current = { mediaId, cueId, text };
  }, [mediaId, cueId, text]);
  const [pending] = useState(() =>
    createPendingCommit((value) => {
      const cur = latest.current;
      if (value.trim() && value !== cur.text) useEdits.getState().setCueText(cur.mediaId, cur.cueId, value);
    }, 300),
  );
  useEffect(() => () => pending.flush(), [pending]);
  return (
    <Input
      value={draft ?? text}
      aria-label={t("字幕文字")}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => setDraft(text)}
      onChange={(e) => {
        setDraft(e.target.value);
        pending.schedule(e.target.value);
      }}
      onBlur={() => {
        // 還有沒送出的就立刻送；Esc 已經 cancel 過，這裡 flush 是空操作（不必再用旗標擋那個緊接著的 blur）
        pending.flush();
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          pending.cancel();
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
