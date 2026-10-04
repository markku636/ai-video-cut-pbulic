import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Crop, Eye, Film, FolderOpen, Image, Settings2 } from "lucide-react";
import { api, errMessage } from "../api";
import { useT } from "../i18n";
import { engineWarningText, isFontWarning, parseEngineWarnings } from "../pipeline/captionWarnings";
import { exportRunning, exportVideo, planExport, sidecarPathFor, type AudioMode, type CaptionsBurnMode, type CaptionsSidecar, type RenderPlanResult } from "../pipeline/exportVideo";
// M2.17 序列輸出：來源選擇、音訊白話、削波警告、輸出後驗收
import { audioSummaryPhrase, clippingPeak, expectationOf, measureExport, needsVerification, sequenceExportSummary, sourceRangeOfSequenceRange, verificationPhrases, verifyExport, type ExportVerification, type Phrase } from "../pipeline/exportVideo";
import { missingFromPlan, planEdits, projectEdits } from "../pipeline/exportEdits";
import { FX_TYPE_LABEL, isKnownEffectType } from "../fx/schema";
import type { TrackV1 } from "../project/format";
import { cutsFromShots, planReframe, REFRAME_ASPECTS, reframeMismatch, reframeSidecars, reframeSummary, type ReframeAspect, type ReframePlanResult } from "../pipeline/reframe";
import type { AspectGuide } from "../stage/aspectGuide";
import { useStage } from "../stage/viewMode";
import { openDialog } from "../store/dialogs";
import { effectiveSpace, useTimeline } from "../store/timeline";
import { useEdits } from "../store/edits";
import { engineReady } from "../store/engine";
import { useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import type { FrameRange } from "../store/timeline";
import { timecode } from "../time";
import { pickSaveFile, toast, uiConfirm } from "../ui";
import { Button, Field, Input, Modal, Segmented, Select } from "../ui/index";

/**
 * 輸出（計畫 §9 `export{range}`）：① 範圍 K0:K1 綁時間軸 in/out ② 顯示引擎 `render.plan` 與 dropped / notes 人話
 * ③ 一行「重新渲染不限次數、不計費用」④ 輸出後的結果。編碼計畫只有 Python 一份（決策 6），這裡只顯示。
 *
 * 引擎的 `quality` 是 crf / cq 整數；設定裡的 draft / standard / high 只是這裡的預設值對照。
 */
const NO_TRACKS: TrackV1[] = [];
const AUDIO_MODES: AudioMode[] = ["auto", "copy", "encode", "none"];
// high＝引擎 webm 預設 crf 16（2026-09-17 量測：crf 24→16 平均 PSNR +1.5 dB、碼率 1.7×、編碼時間幾乎不變；plugins/cards/docs/measurements.md）
const QUALITY_PRESET: Record<string, number> = { draft: 28, standard: 22, high: 16 };

/**
 * 預設輸出路徑 `<stem>.aivc.<ext>`；單幀預覽是 `<stem>.aivc.f<k>.<ext>`（M1 規格 §1.3）：
 * 單幀跟整支同名的話，先輸出整支、再預覽一幀就會問「要覆蓋嗎」，一不小心就把完整成品蓋成一幀的檔。
 */
export function defaultOutPath(src: string, outDir: string | null, ext: string, range: FrameRange | null = null): string {
  const sep = src.includes("\\") ? "\\" : "/";
  const base = src.split(/[\\/]/).pop() ?? "out";
  const stem = base.replace(/\.[^.]+$/, "");
  const dir = outDir ?? src.slice(0, Math.max(0, src.lastIndexOf(sep)));
  const frameTag = range && range.out - range.in === 1 ? `.f${range.in}` : "";
  return `${dir}${sep}${stem}.aivc${frameTag}.${ext}`;
}

/**
 * 開窗時「只輸出這一段」的預設：帶著範圍開（輸出範圍、輸出這一幀 / 預覽此幀）就預設裁切。
 * Premiere / Resolve 的「輸出入點到出點」都是只輸出那一段；不裁的話引擎會把其餘幀原樣寫出、整支長度照舊 ——
 * 單幀預覽因此會跑完整支影片（M1 驗收 M1 / 規格 B9）。沒有範圍時這個勾選不會顯示、也不會送出。
 */
/**
 * 品質欄位 → CRF / CQ 值；空白 = 沒指定（NaN → 呼叫端送 null＝引擎預設）。
 *
 * 空字串一定要先擋掉：`Number("")` 是 0 而 0 是**合法的品質值**（無損），
 * 只用 isFinite 守的話，清空欄位會變成「無損輸出」，檔案大十幾倍而且沒有任何提示。
 */
/**
 * 品質欄位的開窗初值。**用 ?? 不能用 ||**：0 是合法的品質值（無損），
 * `0 || 預設` 會把使用者存過的無損設定悄悄換成預設值 —— 跟「清空欄位變成 0」正好是鏡像的錯。
 */
export function initialQuality(saved: number | null, preset: number | undefined): number {
  return saved ?? preset ?? 16;
}

export function parseQuality(s: string): number {
  return s.trim() === "" ? Number.NaN : Math.round(Number(s));
}

export function defaultTrim(range: FrameRange | null): boolean {
  return range != null;
}

/**
 * 「顯示檔案」要開哪一個檔（B-16）：**真的輸出的那個**（引擎回的 `r.out`）優先。
 * 以前開的是輸出路徑欄位當下的值 —— 輸出完之後改了欄位、或換了範圍讓預設檔名重算，按下去就會開到別的檔（或開不到）。
 */
export function revealPath(lastOut: string | null, fieldPath: string): string {
  return lastOut || fieldPath;
}

export default function ExportDialog({ mediaId, range = null, onClose }: { mediaId: string; range?: FrameRange | null; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  // 效果 / 替換的摘要（計畫區塊裡跟引擎的回報對照）
  const tracksOfMedia = useEdits((s) => s.tracks[mediaId] ?? NO_TRACKS);
  const defaults = useProject((s) => s.exportDefaults);
  const setExportDefaults = useProject((s) => s.setExportDefaults);
  const settings = useSettings((s) => s.s);
  const ffmpeg = useSettings((s) => s.ffmpeg);
  const jobs = useJobs((s) => s.jobs);
  const job = jobs.find((j) => j.kind === "export" && j.mediaId === mediaId && (j.status === "running" || j.status === "queued")) ?? null;
  const finished = jobs.filter((j) => j.kind === "export" && j.mediaId === mediaId && j.status !== "running" && j.status !== "queued");
  const last = finished.length ? finished[finished.length - 1] : null;

  const srcExt = media?.path.split(".").pop()?.toLowerCase() ?? "mp4";
  const [codec, setCodec] = useState(defaults.codec || "auto");
  const [quality, setQuality] = useState<string>(String(initialQuality(defaults.quality, QUALITY_PRESET[settings.export_defaults.quality])));
  const [audio, setAudio] = useState<AudioMode>(AUDIO_MODES.includes(defaults.audio as AudioMode) ? (defaults.audio as AudioMode) : "copy");
  const [trim, setTrim] = useState(() => defaultTrim(range));
  const [outPath, setOutPath] = useState(media ? defaultOutPath(media.path, settings.output_dir, srcExt, range) : "");
  const [plan, setPlan] = useState<RenderPlanResult | null>(null);
  /** 最後一次真的輸出出去的檔（引擎回的 r.out）；「顯示檔案」開的是它，不是 outPath 欄位。 */
  const [lastOut, setLastOut] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // 字幕（feat/captions）：沒有字幕 track 就不顯示這一列；auto 跟著字幕分頁「輸出時燒入」走，這裡只是單次覆寫、不改專案
  const captionTrack = useEdits((s) => s.captions[mediaId] ?? null);
  const [capBurn, setCapBurn] = useState<CaptionsBurnMode>("auto");
  const [capSidecar, setCapSidecar] = useState<CaptionsSidecar | "none">("none");

  // ---- 自動重構圖：橫幅 → 直幅／方形，鏡頭跟著主體走（引擎 reframe.plan + render --reframe）----
  // 規劃與輸出分開：規劃要跑偵測（數十秒），輸出要跑編碼（數分鐘）。規劃完可以先看預覽圖再決定要不要輸出。
  const [aspect, setAspect] = useState<ReframeAspect>("source");
  const [reframeText, setReframeText] = useState("");
  const [reframePlan, setReframePlan] = useState<ReframePlanResult | null>(null);
  const [reframing, setReframing] = useState(false);
  const guideOn = useStage((s) => s.aspectGuide) === aspect;

  // ---- 序列（M2.17）：專案有實體序列時才有「輸出序列 / 只輸出目前素材」的選擇 ----
  // 隱含序列（null）＝目前媒體整段未剪，輸出本來就是 v0.0.6 的原路徑，不必多一個選項讓人猶豫
  const sequenceFlag = useSettings((s) => s.experimental.sequence);
  const storedSeq = useEdits((s) => s.sequence);
  const projectMedia = useProject((s) => s.media);
  const framesOf = useCallback((id: string) => projectMedia.find((m) => m.id === id)?.proxy?.frames ?? null, [projectMedia]);
  const seq = sequenceFlag ? storedSeq : null;
  const summary = useMemo(() => (seq ? sequenceExportSummary(seq, framesOf) : null), [seq, framesOf]);
  // 範圍是在哪個時間軸空間標的：開窗當下的空間（切空間會清掉範圍，所以開窗時的空間就是範圍的空間）
  const [rangeSpace] = useState(() => effectiveSpace(useTimeline.getState().space, sequenceFlag));
  // 在素材空間標了範圍再開 → 使用者要的是那段來源畫面，預設只輸出素材；其餘預設輸出序列
  const [source, setSource] = useState<"sequence" | "media">(() => (range && rangeSpace === "source" ? "media" : "sequence"));
  const useSeq = !!summary && source === "sequence";
  /** 這次真正送出的範圍（跟 source 對齊空間）與沒辦法換空間時的說明。 */
  const { effRange, rangeNote } = useMemo((): { effRange: FrameRange | null; rangeNote: string | null } => {
    if (!range || !seq) return { effRange: range, rangeNote: null };
    if (useSeq) return rangeSpace === "sequence" ? { effRange: range, rangeNote: null } : { effRange: null, rangeNote: t("範圍是在素材時間軸上標的，輸出序列時改為整條序列") };
    if (rangeSpace === "source") return { effRange: range, rangeNote: null };
    const mapped = sourceRangeOfSequenceRange(seq, mediaId, range);
    return mapped ? { effRange: mapped, rangeNote: null } : { effRange: null, rangeNote: t("範圍跨了剪輯點（或不是這支素材），只輸出素材時改為整支") };
  }, [range, seq, useSeq, rangeSpace, mediaId, t]);
  const tr = (p: Phrase) => t(p.key, p.params);
  const audioLine = audioSummaryPhrase(useSeq ? summary : null, audio, outPath);
  const [verify, setVerify] = useState<{ state: "running" } | { state: "done"; v: ExportVerification } | { state: "error"; msg: string } | null>(null);

  const frames = useSeq ? summary!.frames : media?.proxy?.frames ?? 0;
  const rangeText = useMemo(() => {
    const fps = useSeq && seq ? seq.fps : media?.proxy?.fps ?? media?.probe?.video?.r_frame_rate ?? { num: 30, den: 1 };
    return effRange ? `${timecode(effRange.in, fps)} – ${timecode(effRange.out, fps)}（${effRange.out - effRange.in} ${t("幀")}）` : frames ? t("整支（{n} 幀）", { n: frames }) : t("整支");
  }, [effRange, media, frames, t, useSeq, seq]);
  const encoders = ffmpeg?.usable ?? [];
  const q = parseQuality(quality);

  // 序列渲染寫出的是序列幀，而重構圖路徑是對素材的 proxy 幀規劃的 —— 兩套幀號無關，引擎會擋下來。
  // 在這裡先關掉並說明，比讓人規劃完、按了輸出才看到錯誤好。
  const reframeBlocked = useSeq ? t("序列輸出不走這裡（序列幀與素材幀是兩套幀號）：先正常輸出成一支影片，再用「輸出 → 轉成直幅／方形影片…」") : null;
  const reframeWant = { aspect, text: reframeText, range: effRange, trim: !!effRange && trim, nFrames: media?.proxy?.frames ?? 0 };
  const reframeBad = reframeBlocked ? null : reframeMismatch(reframePlan, reframeWant);
  const reframePath = aspect !== "source" && !reframeBlocked && reframePlan && !reframeBad ? reframePlan.path : null;

  const opts = () => ({
    outPath,
    range: effRange,
    trim: !!effRange && trim,
    codec: codec === "auto" ? null : codec,
    quality: Number.isFinite(q) ? q : null,
    audio,
    captions: captionTrack ? capBurn : null,
    captionsSidecar: captionTrack && capSidecar !== "none" ? capSidecar : null,
    // 引擎預設 auto（有序列就輸出序列）；只有「只輸出目前素材」才送 ignore，v0.0.6 的 args 逐鍵不變
    sequence: summary && source === "media" ? ("ignore" as const) : null,
    reframe: reframePath,
  });

  // 參數變了就把計畫作廢（顯示的計畫一定要對應目前的參數）
  useEffect(() => setPlan(null), [codec, quality, audio, outPath, trim, capBurn, capSidecar, captionTrack, source, effRange, reframePath]);
  // 換了比例就把舊路徑丟掉：留著會讓「已規劃」的綠字配上另一個比例，是最糟的那種不同步
  useEffect(() => setReframePlan(null), [aspect]);

  const doReframe = async () => {
    const video = media?.proxy?.path;
    if (!video || aspect === "source") return;
    setReframing(true);
    try {
      const { path, preview } = reframeSidecars(outPath, aspect);
      // 專案已經偵測過鏡頭了：把邊界送過去，切點就落在真正換鏡頭的那一幀，
      // 而不是引擎自己從「目標中心跳太遠」猜出來的那一幀
      const cuts = cutsFromShots(useEdits.getState().shots[mediaId] ?? []);
      setReframePlan(await planReframe(video, path, reframeWant, { preview, cuts }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setReframing(false);
    }
  };

  const doPlan = async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      setPlan(await planExport(mediaId, opts()));
    } catch (e) {
      setPlanError(errMessage(e));
    } finally {
      setPlanning(false);
    }
  };

  const doExport = async () => {
    if (!media) return;
    try {
      const o = opts();
      const sidecar = o.captionsSidecar ? sidecarPathFor(outPath, o.captionsSidecar) : null;
      const [exists, sidecarExists] = await api.pathsExist(sidecar ? [outPath, sidecar] : [outPath]).catch(() => [false, false]);
      const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
      if (exists && !(await uiConfirm(t("{name} 已經存在，要覆蓋嗎？", { name: base(outPath) }), { danger: true, confirmText: t("覆蓋") }))) return;
      // 引擎預設不覆寫字幕檔、編碼前就報錯（旁邊同名的字幕檔可能是手修過的）：先問，答應才帶 overwriteSidecar
      if (sidecar && sidecarExists && !(await uiConfirm(t("字幕檔 {name} 已經存在（可能是手修過的字幕），要覆蓋嗎？", { name: base(sidecar) }), { danger: true, confirmText: t("覆蓋") }))) return;
      setExportDefaults({ ...defaults, codec: codec === "auto" ? "" : codec, quality: Number.isFinite(q) ? q : defaults.quality, audio });
      setVerify(null);
      void exportVideo(mediaId, { ...o, overwriteSidecar: !!(sidecar && sidecarExists) })
        .then(async (r) => {
          setLastOut(r.out);
          // 輸出完最常做的下一件事就是去看那個檔：toast 直接給一顆按鈕（開的是 r.out，不是欄位現在的值）。
          // ttl 拉長到 8 秒，不然按鈕還沒被看到就消失了。
          toast.success(t("輸出完成：{name}（{n} 幀，{s} 秒）", { name: r.out.split(/[\\/]/).pop() ?? r.out, n: r.frames, s: r.seconds }), {
            action: { label: t("顯示檔案"), onClick: () => void api.openPath(r.out).catch(() => {}) },
            ttlMs: 8000,
          });
          // 輸出後驗收（§12）：序列真的重新渲染時，量輸出檔的幀數與音訊樣本數，確定長度與 A/V 對得上
          if (!r.plan || !needsVerification(r.plan)) return;
          setVerify({ state: "running" });
          try {
            const v = verifyExport(expectationOf(r.plan), await measureExport(mediaId, r.out));
            setVerify({ state: "done", v });
            if (!v.ok) toast.error(t("輸出驗收沒過：{detail}", { detail: verificationPhrases(v).map(tr).join("；") }));
          } catch (e) {
            setVerify({ state: "error", msg: errMessage(e) });
          }
        })
        .catch((e) => toast.error(errMessage(e)));
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  const engineOk = engineReady();
  const lastLine = !job && last ? (last.status === "done" ? t("上次輸出完成") : last.status === "canceled" ? t("上次輸出已取消") : t("上次輸出失敗：{err}", { err: last.error ?? "" })) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("輸出影片")}
      icon={Film}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button onClick={() => void doPlan()} loading={planning} disabled={!engineOk || !media?.proxy}>
            {t("預覽編碼計畫")}
          </Button>
          <Button variant="primary" icon={Film} disabled={!engineOk || !media?.proxy || !outPath || exportRunning(mediaId) || !!reframeBad} onClick={() => void doExport()}>
            {t("輸出")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {!engineOk && <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("引擎尚未就緒：輸出由引擎直接餵內建 ffmpeg，要先安裝並啟動引擎。")}</div>}
        {summary && seq && (
          <Field label={t("來源")}>
            <div className="flex items-center gap-2">
              <Select value={source} onChange={(e) => setSource(e.target.value as "sequence" | "media")} data-testid="export-source" className="flex-1">
                <option value="sequence">
                  {t("序列 {name}（{s} 秒，{clips} 片段、{music} 音樂）", { name: summary.name, s: summary.seconds.toFixed(1), clips: summary.clips, music: summary.musicClips })}
                </option>
                <option value="media">{t("只輸出目前素材（忽略序列）")}</option>
              </Select>
              <Button variant="ghost" icon={Settings2} onClick={() => openDialog("sequenceSettings")}>
                {t("序列設定…")}
              </Button>
            </div>
          </Field>
        )}
        <Field label={t("範圍")} hint={t("用 I / O 在時間軸標一段就只合成那一段；沒標就是整支。")}>
          {rangeNote && <div className="text-[11px] text-warning">{rangeNote}</div>}
          <div className="flex items-center gap-3">
            <span className="mono text-fg/80">{rangeText}</span>
            {effRange && (
              <label className="flex items-center gap-1.5 text-[12px] text-fg/70">
                <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} data-testid="export-trim" />
                {t("只輸出這一段（裁掉其餘幀與音訊）")}
              </label>
            )}
          </div>
          {/* 取消勾選的後果要講出來：檔案仍是整支長度，只是這段以外沒合成 —— 不講的話會以為輸出壞了（怎麼這麼久、這麼大） */}
          {effRange && !trim && <div className="text-[11px] text-warning">{t("只合成這段，其餘幀原樣寫出（完整長度）")}</div>}
        </Field>
        <Field
          label={t("畫面比例")}
          hint={reframeBlocked ?? t("裁成直幅或方形；填了「鏡頭跟著」就讓鏡頭跟著主體走，留空則是靜態置中裁切。")}
        >
          <div className="space-y-2">
            <Segmented
              options={REFRAME_ASPECTS.map((a) => ({ value: a, label: a === "source" ? t("原始") : a, disabled: !!reframeBlocked }))}
              value={reframeBlocked ? "source" : aspect}
              onChange={setAspect}
              ariaLabel={t("畫面比例")}
              className="w-full"
            />
            {aspect !== "source" && !reframeBlocked && (
              <>
                <div className="flex gap-2">
                  <Input
                    value={reframeText}
                    onChange={(e) => setReframeText(e.target.value)}
                    placeholder={t("鏡頭跟著（例如 person, face；留空＝靜態置中）")}
                    className="flex-1"
                    spellCheck={false}
                    data-testid="reframe-text"
                  />
                  {/* 先讓人在畫面上看到這個比例會切掉什麼，再決定要不要花幾十秒規劃鏡頭 */}
                  <Button
                    variant="ghost"
                    icon={Eye}
                    onClick={() => useStage.getState().setAspectGuide(guideOn ? null : (aspect as AspectGuide))}
                    title={t("在畫面上框出這個比例（檢視 → 畫面比例參考線）")}
                    data-testid="reframe-guide"
                  >
                    {guideOn ? t("隱藏參考線") : t("看範圍")}
                  </Button>
                  <Button icon={Crop} loading={reframing} disabled={!engineReady() || !media?.proxy} onClick={() => void doReframe()} data-testid="reframe-plan">
                    {reframePlan ? t("重新規劃") : t("規劃鏡頭")}
                  </Button>
                </div>
                {reframePlan && !reframeBad && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-[12px] text-success">
                      <CheckCircle2 size={14} />
                      <span>{reframeSummary(reframePlan, t)}</span>
                      {reframePlan.preview && (
                        <Button variant="ghost" size="sm" icon={Image} onClick={() => void api.openPath(reframePlan.preview!)}>
                          {t("開啟原圖")}
                        </Button>
                      )}
                    </div>
                    {reframePlan.previewData && (
                      <img src={`data:image/jpeg;base64,${reframePlan.previewData}`} alt={t("預覽")} className="w-full rounded object-cover max-h-24" data-testid="reframe-preview-img" />
                    )}
                  </div>
                )}
                {reframeBad && (
                  <div className="text-[11px] text-warning">
                    {reframeBad === "missing"
                      ? t("還沒規劃鏡頭：按「規劃鏡頭」算一次裁切路徑。")
                      : reframeBad === "aspect"
                        ? t("已規劃的路徑是別的比例，要重新規劃。")
                        : t("輸出範圍超出已規劃的那一段，要重新規劃。")}
                  </div>
                )}
              </>
            )}
          </div>
        </Field>
        <Field label={t("輸出檔案")}>
          <div className="flex gap-2">
            <Input value={outPath} onChange={(e) => setOutPath(e.target.value)} className="flex-1 mono" spellCheck={false} />
            <Button
              variant="ghost"
              icon={FolderOpen}
              onClick={async () => {
                const p = await pickSaveFile(outPath, [{ name: t("影片"), extensions: [srcExt, "mp4", "mkv", "webm", "mov"] }]);
                if (p) setOutPath(p);
              }}
            >
              …
            </Button>
          </div>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t("編碼器")} hint={t("auto = 同來源容器：webm→VP9、mp4→NVENC，不能用就沿 H.264 階梯退（openh264 → VideoToolbox → x264）")}>
            <Select value={codec} onChange={(e) => setCodec(e.target.value)}>
              <option value="auto">auto</option>
              {encoders.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("畫質（crf / cq）")} hint={t("越小越好、檔越大；VP9 預設 16、NVENC 19")}>
            <div className="flex gap-2">
              <Input type="number" min={0} max={63} value={quality} onChange={(e) => setQuality(e.target.value)} className="mono flex-1" />
              <Select value={Object.entries(QUALITY_PRESET).find(([, v]) => v === q)?.[0] ?? "__custom"} onChange={(e) => e.target.value !== "__custom" && setQuality(String(QUALITY_PRESET[e.target.value]))} className="w-28">
                <option value="draft">{t("草稿（快）")}</option>
                <option value="standard">{t("標準")}</option>
                <option value="high">{t("高（預設）")}</option>
                <option value="__custom">{t("自訂")}</option>
              </Select>
            </div>
          </Field>
          <Field label={t("音訊")} hint={t("copy = 原音軌逐位元照搬；encode = 重編 AAC / Opus")}>
            <Select value={audio} onChange={(e) => setAudio(e.target.value as AudioMode)}>
              {AUDIO_MODES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {captionTrack && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("字幕")}>
              <Select value={capBurn} onChange={(e) => setCapBurn(e.target.value as CaptionsBurnMode)}>
                <option value="auto">{t("跟字幕分頁設定（{state}）", { state: captionTrack.enabled ? t("燒入") : t("不燒入") })}</option>
                <option value="on">{t("這次燒入")}</option>
                <option value="off">{t("這次不燒入")}</option>
              </Select>
            </Field>
            <Field label={t("另存字幕檔")} hint={t("存在影片旁、同檔名；只輸出一段時時間跟著平移。")}>
              <Select value={capSidecar} onChange={(e) => setCapSidecar(e.target.value as CaptionsSidecar | "none")}>
                <option value="none">{t("不另存")}</option>
                <option value="srt">SRT</option>
                <option value="vtt">WebVTT</option>
                <option value="ass">ASS</option>
              </Select>
            </Field>
          </div>
        )}

        {audioLine && <AudioSummaryLine line={tr(audioLine.line)} reasons={audioLine.reasons.map(tr)} />}

        {planError && <div className="text-[12px] text-danger break-all">{planError}</div>}
        {plan && <ClippingWarning plan={plan} />}
        {plan && <PlanView plan={plan} tracks={tracksOfMedia} />}

        {job && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[12px] text-fg/70">
              <span>{job.step || t("輸出中")}</span>
              <span className="tabular-nums">{job.pct != null ? `${Math.round(job.pct)}%` : job.status === "queued" ? t("排隊中") : ""}</span>
            </div>
            <div className="h-1.5 rounded-full bg-fg/10 overflow-hidden">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.min(100, job.pct ?? 2))}%` }} />
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => useJobs.getState().cancel(job.id)}>
                {t("取消輸出")}
              </Button>
            </div>
          </div>
        )}
        {verify && <VerifyView verify={verify} />}
        {lastLine && (
          <div className={`text-[12px] ${last?.status === "done" ? "text-success" : last?.status === "canceled" ? "text-fg/50" : "text-danger"}`}>
            {lastLine}
            {last?.status === "done" && (
              <button type="button" className="ml-2 text-accent hover:underline" onClick={() => void api.openPath(revealPath(lastOut, outPath)).catch(() => {})}>
                {t("看檔案")}
              </button>
            )}
          </div>
        )}

        <div className="text-[11px] text-fg/45 space-y-0.5">
          <div>{t("單幀預覽（輸出 › 輸出這一幀）與最終輸出逐位元相同；遮罩外的像素與原片逐位元相同。")}</div>
          <div>{t("重新渲染不限次數、不計費用（本機 GPU）。")}</div>
        </div>
      </div>
    </Modal>
  );
}

/** 音訊一行白話（§12）：「音訊：重新混音 → Opus 160 kbps（原因：分割 / 修剪過片段、加入 1 段音訊）」。 */
function AudioSummaryLine({ line, reasons }: { line: string; reasons: string[] }) {
  const t = useT();
  return (
    <div className="text-[12px] text-fg/70" data-testid="export-audio-line">
      {line}
      {reasons.length > 0 && <span className="text-fg/50">{t("（原因：{reasons}）", { reasons: reasons.join("、") })}</span>}
    </div>
  );
}

/** 計畫估計會削波（> −1 dBFS 且沒開限幅器）：講峰值、給「序列設定…」的捷徑（§0.1 Q4：限幅器預設關，只提示）。 */
function ClippingWarning({ plan }: { plan: RenderPlanResult }) {
  const t = useT();
  const peak = clippingPeak(plan);
  if (peak === null) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning" data-testid="export-clipping">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span className="flex-1">{t("可能削波（估計峰值 {db} dBFS）：建議降低音樂增益，或在序列設定打開限幅器", { db: (peak > 0 ? "+" : "") + peak.toFixed(1) })}</span>
      <button type="button" className="text-accent hover:underline shrink-0" onClick={() => openDialog("sequenceSettings")}>
        {t("序列設定…")}
      </button>
    </div>
  );
}

/** 輸出後驗收的結果（§12）：幀數、樣本數、長度差，一項一行。 */
function VerifyView({ verify }: { verify: { state: "running" } | { state: "done"; v: ExportVerification } | { state: "error"; msg: string } }) {
  const t = useT();
  if (verify.state === "running") return <div className="text-[12px] text-fg/60">{t("驗收輸出檔中…")}</div>;
  if (verify.state === "error") return <div className="text-[12px] text-warning break-all">{t("沒辦法驗收輸出檔：{msg}", { msg: verify.msg })}</div>;
  const ok = verify.v.ok;
  return (
    <div className={`flex items-start gap-2 text-[12px] ${ok ? "text-success" : "text-danger"}`} data-testid="export-verify">
      {ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <span>
        {ok ? t("輸出驗收通過") : t("輸出驗收沒過")}：{verificationPhrases(verify.v).map((p) => t(p.key, p.params)).join("；")}
      </span>
    </div>
  );
}

/** `render.plan` 的人話：編碼器 / 容器 / 音訊、要合成的 track、略過的與被降級的。 */
function PlanView({ plan, tracks }: { plan: RenderPlanResult; tracks: readonly TrackV1[] }) {
  const t = useT();
  const e = plan.encode;
  // captions.warnings 混了兩種：逐段的排不下（{kind: overflow, cueId}）與字型缺字（{kind: fontNoCjk | fontFallback, message}）。
  // 以前整包算成「N 段排不下」；字型缺字（燒出來是方塊）要單獨講、而且經代碼翻譯，英文介面才不會冒出引擎的中文句子
  const capWarnings = parseEngineWarnings(plan.captions?.warnings ?? []);
  const overflowCues = capWarnings.filter((w) => w.code === "overflow").length;
  const fontWarnings = capWarnings.filter(isFontWarning);
  return (
    <div className="rounded-md border border-fg/10 bg-inset p-3 space-y-1 text-[12px]">
      <div className="text-fg/70">
        {t("編碼器")}：<span className="mono">{e.video_codec}</span> · {t("容器")}：<span className="mono">{e.container}</span> · {t("音訊")}：<span className="mono">{e.audio_mode}{e.audio_codec ? ` (${e.audio_codec})` : ""}</span>
        {e.gpu ? ` · GPU` : ""}
      </div>
      <div className="text-fg/60">{t("幀：共 {total}、寫出 {write}、合成 {composite}", { total: plan.frames.total, write: plan.frames.write, composite: plan.frames.composite })}</div>
      {plan.sequence && (
        <div className="text-fg/60">
          {plan.sequence.untouched
            ? t("序列未修改：照原本的方式輸出（音軌直接複製）")
            : t("序列 {duration}（{frames} 幀）· {clips} 片段 · {gaps} 空白 · {audioClips} 段音訊", { duration: plan.sequence.duration, frames: plan.sequence.frames, clips: plan.sequence.clips, gaps: plan.sequence.gaps, audioClips: plan.sequence.audioClips })}
          {plan.audio?.mode === "mix" && plan.audio.samples != null && <span> · {t("音訊 {n} 樣本", { n: plan.audio.samples })}</span>}
        </div>
      )}
      {plan.tracks.length > 0 && (
        <div className="text-fg/60">
          {plan.tracks.map((j) => (
            <div key={j.id} className="mono">
              {/* 牌外掛的插入來源才有 slot / target；一般 track 只列 id、種類與幀數 */}
              {j.slot || j.target ? `${j.id} ${j.slot ?? ""} ${j.original ?? "?"} → ${j.target ?? "?"}` : `${j.id}${j.kind ? ` · ${j.kind}` : ""}`}
              {j.frames != null && ` · ${j.frames} ${t("幀")}`}
              {j.masks === false ? ` · ${t("無遮罩")}` : ""}
            </div>
          ))}
        </div>
      )}
      <PlanEditsView plan={plan} tracks={tracks} />
      {plan.captions && (
        <div className="text-fg/60">
          {t("字幕：{preset} · {cues} 段 · 字型 {font}", { preset: plan.captions.preset, cues: plan.captions.cues, font: plan.captions.font.family ?? plan.captions.font.path ?? "Pillow" })}
          {fontWarnings.length === 0 && !plan.captions.font.path && <span className="text-warning"> · {t("找不到中日韓字型：中文會變方塊")}</span>}
          {overflowCues > 0 && <span className="text-warning"> · {t("{n} 段字幕排不下", { n: overflowCues })}</span>}
          {fontWarnings.map((w, i) => (
            <div key={`${w.code}-${i}`} className="text-warning break-words">
              {engineWarningText(w, t)}
            </div>
          ))}
        </div>
      )}
      {plan.captionsSidecar && (
        <div className="text-fg/60 break-all">
          {t("字幕檔：{path}", { path: plan.captionsSidecar })}
          {plan.captionsSidecarExists && <span className="text-warning"> · {t("已存在，輸出時會先問要不要覆蓋")}</span>}
        </div>
      )}
      {plan.skipped.length > 0 && (
        <div className="text-warning">
          {t("略過的追蹤：")}
          {plan.skipped.map((s) => `${s.trackId}（${s.reason}）`).join("；")}
        </div>
      )}
      {e.dropped.length > 0 && (
        <div className="text-warning">
          {t("會被降級 / 丟掉的：")}
          {e.dropped.join("；")}
        </div>
      )}
      {e.notes.length > 0 && <div className="text-fg/45">{e.notes.join("；")}</div>}
    </div>
  );
}

/** 效果 / 替換：引擎計畫列出的（或專案有、引擎沒列的警告）。專案沒有任何效果 / 替換就不顯示。 */
function PlanEditsView({ plan, tracks }: { plan: RenderPlanResult; tracks: readonly TrackV1[] }) {
  const t = useT();
  const mine = projectEdits(tracks);
  const engine = planEdits(plan);
  if (!mine.effects.length && !mine.replace.length && !engine?.length) return null;
  const fxName = (type: string) => (isKnownEffectType(type) ? t(FX_TYPE_LABEL[type]) : type);
  const label = (id: string) => tracks.find((x) => x.id === id)?.label ?? id;
  const missing = engine ? missingFromPlan(mine, engine) : [];
  return (
    <div className="text-fg/60" data-testid="export-edits">
      {engine?.map((e) => (
        <div key={e.trackId}>
          {label(e.trackId)}：
          {e.count > 0 && t("效果 {list}", { list: e.effects.length ? e.effects.map(fxName).join("、") : String(e.count) })}
          {e.count > 0 && e.replace && " · "}
          {e.replace && t("替換（{kind}）", { kind: e.replace === "video" ? t("影片") : e.replace === "image" ? t("圖片") : e.replace })}
        </div>
      ))}
      {engine === null && (mine.effects.length > 0 || mine.replace.length > 0) && (
        <div className="text-warning">{t("引擎的計畫沒有列出效果／替換（{n} 條 track 有設定）：這個版本的引擎可能還不會輸出它們", { n: new Set([...mine.effects, ...mine.replace].map((x) => x.trackId)).size })}</div>
      )}
      {missing.length > 0 && <div className="text-warning">{t("這些 track 的效果／替換不在引擎的計畫裡：{list}", { list: missing.join("、") })}</div>}
      {mine.errors > 0 && <div className="text-warning">{t("{n} 個效果欄位有錯：引擎會拒收，先在「效果」裡修正", { n: mine.errors })}</div>}
    </div>
  );
}
