import { AlertTriangle, Crosshair, Diamond, Lock, Plus, RotateCcw, Scissors, Settings2, Shapes, SkipBack, SkipForward, Square, StepBack, StepForward, Trash2, Undo2, Wand2 } from "lucide-react";
import { useT } from "../i18n";
import { MOTION_MODEL_LABEL } from "../video/labels";
import type { MotionModel, ReferencePointV1, TrackV1 } from "../project/format";
import { trackRange, useActiveMedia, useActiveMediaId, useActiveShots, useSelectedTrack } from "../stage/active";
import { stateOfSolveFrame, summarizeSolve } from "../stage/surfaceAt";
import { useStage, type TrackMode } from "../stage/viewMode";
import { usePlayback } from "../store/playback";
import { useSolves, type Solve } from "../store/solves";
import { useTimeline } from "../store/timeline";
import { Badge, Button, EmptyState, Field, Icon, IconButton, Segmented, Select } from "../ui/index";
import { useUi } from "../store/ui";
import { useEdits } from "./_contracts";
import { CommandButton, CommandIconButton } from "./CommandButton";
import EffectsSection from "./EffectsSection";
import ReplaceSection from "./ReplaceSection";
import { KEYFRAME_SOURCE_LABEL, TRACK_MODE_LABEL, TRANSPORT_LABEL } from "./labels";
import { trackBadges } from "../plugins/queries";

/**
 * Track 面板（計畫 §9 Inspector › Track）：參考影格行、傳輸控制列、mode track|adjust、動態模型階梯、
 * 狀態行 + 信心 sparkline、關鍵幀 / 參考點清單、stale 橫幅。
 * 傳輸控制列全部派發指令（track.*），面板不知道 pipeline 長什麼樣。
 * 不訂閱 playback.frame：那會讓面板一秒重繪 30 次；要目前幀的地方用 getState()。
 */
const CORNER_LABEL = ["TL", "TR", "BR", "BL"] as const;

export default function TrackPanel() {
  const t = useT();
  const mediaId = useActiveMediaId();
  const media = useActiveMedia();
  const track = useSelectedTrack();
  const shots = useActiveShots();
  const solve = useSolves((s) => (track ? s.byTrack[track.id] ?? null : null));
  const trackMode = useStage((s) => s.trackMode);
  const setTrackMode = useStage((s) => s.setTrackMode);
  const setTrackOptions = useEdits((s) => s.setTrackOptions);
  const seek = usePlayback((s) => s.seek);

  if (!track) {
    return (
      <EmptyState
        icon={Crosshair}
        title={t("還沒有追蹤")}
        hint={t("按 N 在舞台上框出一個平面新增 track；或先用「找物件」找出要跟著走的東西。")}
        compact
        action={<CommandButton id="track.new" label={t("新增 track")} icon={Plus} />}
      />
    );
  }

  // 物件 track 沒有關鍵幀 / 解算：這一頁的東西對它都不適用，指去「物件」分頁
  if (track.kind === "object") {
    return (
      <EmptyState
        icon={Shapes}
        title={t("選中的是物件「{name}」", { name: track.label })}
        hint={t("物件用逐幀遮罩追蹤，沒有關鍵幀與解算；在「物件」分頁改名、修正或刪除。")}
        compact
        action={
          <Button size="sm" icon={Shapes} onClick={() => useUi.getState().setTab("objects")}>
            {t("打開物件分頁")}
          </Button>
        }
      />
    );
  }

  const range = trackRange(track, shots, media?.proxy?.frames ?? 0);
  const sum = summarizeSolve(solve, range);
  const occludedPct = sum.solved ? Math.round((sum.occluded / sum.solved) * 100) : 0;

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center gap-2 border-b border-fg/8 px-3 py-2 text-[12px]">
        <span className="font-medium truncate">{track.label}</span>
        <Badge tone="neutral">{t("平面")}</Badge>
        {/* 外掛的徽章（例如 cards：連結的格位） */}
        {trackBadges(track).map((b) => (
          <Badge key={b} tone="accent">
            {b}
          </Badge>
        ))}
        <CommandIconButton id="edit.deleteTrack" label={t("刪除 track")} icon={Trash2} className="ml-auto" />
      </div>
      {track.stale && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          <Icon icon={AlertTriangle} size={14} />
          <span className="min-w-0 flex-1">{t("關鍵幀或目標改過了，解算已過期")}</span>
          <CommandButton id="track.retrackFromHere" label={t(TRANSPORT_LABEL.retrackFromHere)} variant="ghost" />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4 text-[12px]">
        {/* 參考影格 */}
        <section className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-fg/60">{t("參考影格")}</span>
            <span className="mono text-[12px]">{track.referenceFrame ?? "—"}</span>
            <CommandButton id="track.setReferenceFrame" label={t("設定")} variant="ghost" />
            <CommandButton id="track.goToReferenceFrame" label={t("前往")} variant="ghost" />
          </div>
          <div className="text-[11px] text-fg/45">
            {track.referenceFrame === null ? t("引擎會自己挑乾淨的靜止幀（conf > 0.9）；找不到時請手動指定。") : t("換參考影格只需重解，不會丟掉任何關鍵幀。")}
          </div>
        </section>

        {/* 傳輸控制列 */}
        <section className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-0.5">
            <CommandIconButton id="track.trackToStart" label={t(TRANSPORT_LABEL.trackToStart)} icon={SkipBack} />
            <CommandIconButton id="track.stepTrackBack" label={t(TRANSPORT_LABEL.stepTrackBack)} icon={StepBack} />
            <CommandIconButton id="track.stopTrack" label={t(TRANSPORT_LABEL.stopTrack)} icon={Square} />
            <CommandIconButton id="track.stepTrackFwd" label={t(TRANSPORT_LABEL.stepTrackFwd)} icon={StepForward} />
            <CommandIconButton id="track.trackToEnd" label={t(TRANSPORT_LABEL.trackToEnd)} icon={SkipForward} />
            <span className="mx-1 h-5 w-px bg-fg/10" />
            <CommandIconButton id="track.clearBackwards" label={t(TRANSPORT_LABEL.clearBackwards)} icon={Scissors} className="-scale-x-100" />
            <CommandIconButton id="track.clearForwards" label={t(TRANSPORT_LABEL.clearForwards)} icon={Scissors} />
            <CommandIconButton id="track.clearAll" label={t(TRANSPORT_LABEL.clearAll)} icon={Trash2} />
          </div>
          <CommandButton id="track.retrackFromHere" label={t(TRANSPORT_LABEL.retrackFromHere)} icon={RotateCcw} full />
          <div className="text-[11px] text-fg/40">{t("只重解需要的區間；重跑追蹤永不覆寫使用者關鍵幀。")}</div>
        </section>

        <Segmented<TrackMode>
          options={[
            { value: "track", label: t(TRACK_MODE_LABEL.track) },
            { value: "adjust", label: t(TRACK_MODE_LABEL.adjust) },
          ]}
          value={trackMode}
          onChange={setTrackMode}
          full
          ariaLabel={t("追蹤模式")}
        />

        <Field label={t("動態模型")} hint={t("預設透視；平面翻轉或變形時降到仿射會更穩。")}>
          <Select value={track.options.motionModel} onChange={(e) => mediaId && setTrackOptions(mediaId, track.id, { motionModel: e.target.value as MotionModel })}>
            {(Object.keys(MOTION_MODEL_LABEL) as MotionModel[]).map((m) => (
              <option key={m} value={m}>
                {t(MOTION_MODEL_LABEL[m])}
              </option>
            ))}
          </Select>
        </Field>

        {/* 狀態行 + sparkline */}
        <section className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="text-fg/70">{t("解算 {n}/{total}", { n: sum.solved, total: sum.total })}</span>
            <span className={sum.lost ? "text-track-lost" : "text-fg/45"}>{t("遺失 {n}", { n: sum.lost })}</span>
            <span className={sum.occluded ? "text-track-occluded" : "text-fg/45"}>{t("遮擋 {pct}%", { pct: occludedPct })}</span>
            {sum.worst && (
              <button type="button" className="ml-auto text-accent hover:underline" onClick={() => seek(sum.worst!.k)}>
                {t("最差幀 {k}", { k: sum.worst.k })}
              </button>
            )}
          </div>
          <Sparkline solve={solve} range={range} onSeek={seek} />
        </section>

        {trackMode === "track" ? <KeyframeList track={track} mediaId={mediaId} /> : <ReferencePoints track={track} />}

        <div className="flex flex-wrap gap-1.5">
          <CommandButton id="track.setKeyframe" label={t("設關鍵幀")} icon={Diamond} />
          <CommandButton id="track.fromMask" label={t("從遮罩取角")} icon={Wand2} />
          <CommandButton id="edit.revertFrameToSolved" label={t("還原為解算值")} icon={Undo2} />
          <CommandButton id="track.options" label={t("追蹤選項…")} icon={Settings2} />
        </div>

        {/* 替換（圖片 / 影片貼進四邊形）與效果（作用範圍＝遮罩檔，沒有就用解出來的四邊形） */}
        {mediaId && (
          <div className="space-y-4 border-t border-fg/8 pt-3">
            <ReplaceSection mediaId={mediaId} track={track} />
            <EffectsSection mediaId={mediaId} track={track} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 信心 sparkline：一條線 + 0.7 / 0.35 兩條門檻；lost 幀畫紅點。點一下跳到那一幀。 */
function Sparkline({ solve, range, onSeek }: { solve: Solve | null; range: [number, number]; onSeek: (f: number) => void }) {
  const t = useT();
  const total = Math.max(1, range[1] - range[0]);
  const frames = solve ? solve.frames.filter((f) => f.k >= range[0] && f.k < range[1]) : [];
  const W = 100;
  const H = 28;
  const x = (k: number) => ((k - range[0]) / total) * W;
  const y = (c: number) => H - 2 - c * (H - 4);
  const pts = frames.map((f) => `${x(f.k).toFixed(2)},${y(f.conf).toFixed(2)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-8 rounded bg-inset border border-fg/10 cursor-crosshair"
      role="img"
      aria-label={t("解算信心曲線")}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(range[0] + Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * total));
      }}
    >
      <line x1={0} x2={W} y1={y(0.7)} y2={y(0.7)} className="stroke-track-solver" strokeOpacity={0.3} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
      <line x1={0} x2={W} y1={y(0.35)} y2={y(0.35)} className="stroke-track-lost" strokeOpacity={0.3} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
      {pts && <polyline points={pts} fill="none" className="stroke-track-solver" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />}
      {frames
        .filter((f) => stateOfSolveFrame(f) === "lost")
        .map((f) => (
          <circle key={f.k} cx={x(f.k)} cy={y(f.conf)} r={1.2} className="fill-track-lost" />
        ))}
    </svg>
  );
}

function KeyframeList({ track, mediaId }: { track: TrackV1; mediaId: string | null }) {
  const t = useT();
  const seek = usePlayback((s) => s.seek);
  const selectKeyframe = useTimeline((s) => s.selectKeyframe);
  const selected = useTimeline((s) => s.selectedKeyframe);
  const removeKeyframe = useEdits((s) => s.removeKeyframe);
  const list = [...track.keyframes].sort((a, b) => a.frame - b.frame);
  return (
    <section className="space-y-1">
      <div className="text-[11px] text-fg/60">{t("關鍵幀（{n}）", { n: list.length })}</div>
      {list.length === 0 && <div className="text-[11px] text-fg/40">{t("還沒有關鍵幀：拖表面的角就會在這一幀釘一個。")}</div>}
      <div className="rounded border border-fg/10 divide-y divide-fg/5">
        {list.map((kf) => {
          const sel = selected?.trackId === track.id && selected.frame === kf.frame;
          const locked = kf.lockedCorners?.some(Boolean) ?? false;
          return (
            <div key={kf.frame} className={`flex items-center gap-2 px-2 py-1 ${sel ? "bg-accent/10" : "hover:bg-fg/[0.03]"}`}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => {
                  selectKeyframe({ trackId: track.id, frame: kf.frame });
                  seek(kf.frame);
                }}
              >
                <span className="mono w-12 text-right tabular-nums">{kf.frame}</span>
                <span className={kf.source === "user" ? "text-track-user" : "text-fg/55"}>{t(KEYFRAME_SOURCE_LABEL[kf.source])}</span>
                {locked && <Icon icon={Lock} size={12} className="text-track-user" title={t("有鎖定的角")} />}
                {track.referenceFrame === kf.frame && <Badge tone="info">{t("參考")}</Badge>}
              </button>
              <IconButton icon={Trash2} label={t("刪除關鍵幀")} iconSize={13} box="w-6 h-6" onClick={() => mediaId && removeKeyframe(mediaId, track.id, kf.frame)} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** AdjustTrack：參考點清單（Mocha AdjustTrack 的對應；計畫 §9）。微調本身在舞台 / 快捷鍵，這裡列出、跳轉、派發指令。 */
function ReferencePoints({ track }: { track: TrackV1 }) {
  const t = useT();
  const seek = usePlayback((s) => s.seek);
  const pts: ReferencePointV1[] = track.adjust.points;
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-fg/60">
        <span>{t("參考點（{n}）", { n: pts.length })}</span>
        {!track.adjust.enabled && <Badge tone="neutral">{t("未啟用")}</Badge>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <CommandButton id="adjust.addReferencePoint" label={t("新增參考點")} icon={Plus} />
        <CommandButton id="adjust.toggleLock" label={t("鎖定 / 解鎖")} icon={Lock} />
        <CommandButton id="adjust.setPrimaryFrame" label={t("設為主要參考影格")} />
        <CommandButton id="adjust.workBackwards" label={t("反向修正")} />
        <CommandButton id="adjust.resolveAround" label={t("重解鄰近")} icon={RotateCcw} />
      </div>
      {pts.length === 0 && <div className="text-[11px] text-fg/40">{t("在任一幀放 1–4 個參考點（吸附表面四角或指定特徵），微調：拖曳或 Alt+方向鍵 1 px（Shift 0.1 px）。")}</div>}
      {pts.length > 0 && (
        <div className="rounded border border-fg/10 divide-y divide-fg/5">
          {pts.map((p) => (
            <button key={p.id} type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-fg/[0.03]" onClick={() => seek(p.frame)}>
              <span className="mono w-12 text-right tabular-nums">{p.frame}</span>
              <span className="text-fg/70">{p.cornerIndex === null ? t("自訂特徵") : CORNER_LABEL[p.cornerIndex]}</span>
              {p.locked && <Icon icon={Lock} size={12} className="text-track-user" title={t("已鎖定")} />}
              <span className="ml-auto text-[10px] text-fg/40 tabular-nums">{t("主要影格 {k}", { k: p.primaryFrame })}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
