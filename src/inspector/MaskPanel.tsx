import { ArrowLeft, ArrowLeftRight, ArrowRight, Eraser, Lasso, Minus, MousePointer2, Plus } from "lucide-react";
import { create } from "zustand";
import { useT } from "../i18n";
import { effectiveInsert, INSERT_DEFAULTS } from "../project/format";
import { useActiveMediaId, useActiveTracks, useSelectedTrack } from "../stage/active";
import { usePlayback } from "../store/playback";
import { useTimeline, type TimelineTool } from "../store/timeline";
import { Badge, EmptyState, Field, Input, Segmented } from "../ui/index";
import { useEdits } from "./_contracts";
import { CommandButton } from "./CommandButton";
import { MASK_TOOL_LABEL } from "./labels";

/**
 * 物件遮罩 Object Mask（計畫 §9）：工具 加選 A / 減選 Shift+X（X 讓給「將播放線所在鏡頭設為範圍」，Premiere 的 Mark Clip）；
 * 兩個獨立區塊 ① 排除於追蹤（膨脹）② 合成遮擋（膨脹、羽化，預設值不同）；有序遮擋清單；提示清單；傳播前 / 後 / 雙向。
 *
 * ② 寫進 TrackV1.insert.occlusion（專案檔）；① 目前是 session 設定（引擎 track.solve 的參數，
 * 專案檔還沒有欄位 —— pipeline/track.ts 落地時從 useMaskSettings 讀）。
 */
type MaskTool = Extract<TimelineTool, "select" | "maskPos" | "maskNeg">;

interface MaskSettings {
  /** ① 排除於追蹤：遮罩往外膨脹幾 px 才算「不能追」。 */
  excludeDilate: number;
  setExcludeDilate: (n: number) => void;
}

export const useMaskSettings = create<MaskSettings>((set) => ({
  excludeDilate: 3,
  setExcludeDilate: (n) => set({ excludeDilate: Math.max(0, Math.min(64, Math.round(n))) }),
}));

export default function MaskPanel() {
  const t = useT();
  const mediaId = useActiveMediaId();
  const track = useSelectedTrack();
  const tracks = useActiveTracks();
  const tool = useTimeline((s) => s.tool);
  const setTool = useTimeline((s) => s.setTool);
  const setTrackInsert = useEdits((s) => s.setTrackInsert);
  const seek = usePlayback((s) => s.seek);
  const excludeDilate = useMaskSettings((s) => s.excludeDilate);
  const setExcludeDilate = useMaskSettings((s) => s.setExcludeDilate);

  const toolValue: MaskTool = tool === "maskPos" || tool === "maskNeg" ? tool : "select";
  const eff = effectiveInsert(INSERT_DEFAULTS, track?.insert ?? null);
  const prompts = track ? [...track.prompts].sort((a, b) => a.frame - b.frame) : [];

  const setOcclusion = (patch: Partial<{ dilate: number; feather: number }>) => {
    if (!mediaId || !track) return;
    setTrackInsert(mediaId, track.id, { occlusion: { ...eff.occlusion, ...patch } });
  };

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4 text-[12px]">
        <Segmented<MaskTool>
          options={[
            { value: "select", label: t(MASK_TOOL_LABEL.select), icon: MousePointer2 },
            { value: "maskPos", label: `${t(MASK_TOOL_LABEL.maskPos)} (A)`, icon: Plus },
            { value: "maskNeg", label: `${t(MASK_TOOL_LABEL.maskNeg)} (Shift+X)`, icon: Minus },
          ]}
          value={toolValue}
          onChange={setTool}
          full
          ariaLabel={t("遮罩工具")}
        />
        <div className="text-[11px] text-fg/45">{t("在舞台上點一下：加選把東西納入遮罩、減選把它排除；修正會立刻傳到鄰近幀。")}</div>

        {!track ? (
          <EmptyState icon={Lasso} title={t("先選一條 track")} hint={t("遮罩掛在 track 上：手或其他東西蓋住哪個平面，就在那條 track 上加選它。")} compact />
        ) : (
          <>
            <section className="space-y-2 rounded border border-fg/10 p-2.5">
              <div className="font-medium">{t("① 排除於追蹤")}</div>
              <Field label={t("膨脹（px）")} hint={t("追蹤器看不到遮罩覆蓋的像素：手蓋住左半時只用右半的特徵解出整個平面。")}>
                <Input type="number" min={0} max={64} value={excludeDilate} onChange={(e) => setExcludeDilate(Number(e.target.value))} />
              </Field>
            </section>

            <section className="space-y-2 rounded border border-fg/10 p-2.5">
              <div className="font-medium">{t("② 合成遮擋")}</div>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("膨脹（px）")}>
                  <Input type="number" min={0} max={32} step={0.5} value={eff.occlusion.dilate} onChange={(e) => setOcclusion({ dilate: Number(e.target.value) })} />
                </Field>
                <Field label={t("羽化（px）")}>
                  <Input type="number" min={0} max={32} step={0.1} value={eff.occlusion.feather} onChange={(e) => setOcclusion({ feather: Number(e.target.value) })} />
                </Field>
              </div>
              <div className="text-[11px] text-fg/45">{t("合成時遮擋物蓋在新表面上；兩個區塊的預設值不同，追蹤要寬、合成要準。")}</div>
            </section>

            <section className="space-y-1.5">
              <div className="text-[11px] text-fg/60">{t("遮擋順序")}</div>
              <ol className="rounded border border-fg/10 divide-y divide-fg/5">
                {tracks.map((tr, i) => (
                  <li key={tr.id} className={`flex items-center gap-2 px-2 py-1 ${tr.id === track.id ? "bg-accent/10 text-accent" : "text-fg/70"}`}>
                    <span className="w-4 text-right tabular-nums text-fg/40">{i + 1}</span>
                    <span className="truncate">{tr.label}</span>
                  </li>
                ))}
              </ol>
              <div className="text-[11px] text-fg/40">{t("由上到下：後面的會被前面的遮住（例如 螢幕 → 拿著它的手 → 桌面）。")}</div>
            </section>

            <section className="space-y-1.5">
              <div className="flex items-center gap-2 text-[11px] text-fg/60">
                <span>{t("提示（{n} 幀）", { n: prompts.length })}</span>
                <CommandButton id="mask.clearPrompts" label={t("清除提示")} icon={Eraser} variant="ghost" className="ml-auto" />
              </div>
              {prompts.length === 0 ? (
                <div className="text-[11px] text-fg/40">{t("還沒有提示點。")}</div>
              ) : (
                <div className="rounded border border-fg/10 divide-y divide-fg/5">
                  {prompts.map((p) => {
                    const pos = p.points.filter((x) => x.label === 1).length;
                    const neg = p.points.length - pos;
                    return (
                      <button key={p.frame} type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-fg/[0.03]" onClick={() => seek(p.frame)}>
                        <span className="mono w-12 text-right tabular-nums">{p.frame}</span>
                        {pos > 0 && <Badge tone="info">+{pos}</Badge>}
                        {neg > 0 && <Badge tone="danger">−{neg}</Badge>}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="space-y-1.5">
              <div className="text-[11px] text-fg/60">{t("傳播")}</div>
              <div className="flex flex-wrap gap-1.5">
                <CommandButton id="mask.propagateBackward" label={t("向前段")} icon={ArrowLeft} />
                <CommandButton id="mask.propagateForward" label={t("向後段")} icon={ArrowRight} />
                <CommandButton id="mask.propagateBoth" label={t("雙向")} icon={ArrowLeftRight} variant="primary" />
              </div>
              <div className="text-[11px] text-fg/40">{t("從目前幀的提示出發，把遮罩傳到整個鏡頭；自動重解開著時鄰近幀會立刻更新。")}</div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
