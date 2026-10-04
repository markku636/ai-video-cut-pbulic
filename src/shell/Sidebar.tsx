import { AudioLines, BetweenHorizontalStart, FilePlus, Film, FolderOpen, ListEnd, Mic, Music, Plus, Scissors, Trash, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as A from "../commands/appActions";
import { openMediaContextMenu, openShotContextMenu } from "../commands/menuModel";
import { useCommandTick } from "../commands/registry";
import { useT } from "../i18n";
import {
  addMediaToSequence,
  audioClipCount,
  audioMediaSummary,
  describeSidebarDrop,
  dropSidebarPayload,
  ensureAudioMediaInfo,
  importAudioDialog,
  placeAudioMedia,
  useAudioImports,
  type SidebarDragPayload,
} from "../pipeline/audio";
import { detectShots } from "../pipeline/proxy";
import { engineReady, pyenvReady, useEngine } from "../store/engine";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { useProject, type MediaItem } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { fpsLabel } from "../video/frames";
import { PROXY_STATE_LABEL, SHOT_KIND_LABEL } from "../video/labels";
import { timecode } from "../time";
import { uiConfirm } from "../ui";
import Icon from "../ui/Icon";
import { Badge, Button, IconButton, Spinner } from "../ui/index";
import type { AudioMediaV2, AudioRole, ShotV1 } from "../project/format";

const EMPTY_SHOTS: ShotV1[] = [];

/** 每列右側的 proxy 狀態徽章。 */
function proxyBadge(m: MediaItem, t: (s: string) => string) {
  if (m.proxyState === "building") return <Spinner size={12} className="text-info" />;
  const tone = m.proxyState === "ready" ? "success" : m.proxyState === "error" ? "danger" : m.proxyState === "stale" ? "warning" : "neutral";
  return (
    <span title={m.error}>
      <Badge tone={tone}>{t(PROXY_STATE_LABEL[m.proxyState])}</Badge>
    </span>
  );
}

// ---- 拖到序列時間軸（M2.14）----

/** 滑鼠移動超過這麼多 px 才算拖曳（跟時間軸 DRAG_THRESHOLD_PX 同一個手感，點一下選媒體不會變成拖曳）。 */
const DRAG_START_PX = 4;

interface DragGhost {
  x: number;
  y: number;
  text: string;
  ok: boolean;
}

/**
 * Sidebar 的列拖到時間軸：用 pointer 事件自己做，不用 HTML5 draggable ——
 * tauri.conf.json 開了 `dragDropEnabled`（接檔案總管拖進來的檔），Windows 的 WebView2 在這個模式下不送網頁內的 dragover / drop。
 * 放開時才用座標問 pipeline/audio.ts 落在哪（序列時間軸的哪一列、哪一幀），時間軸元件完全不用知道有人在拖。
 * Alt 不吸附（同時間軸的範圍拖曳）、Esc 取消。
 */
function useSidebarDrag() {
  const t = useT();
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const gesture = useRef<{ payload: SidebarDragPayload; x0: number; y0: number; pointerId: number; active: boolean } | null>(null);
  // 拖曳（含 Esc 取消的）放開時瀏覽器還會補送一個 click：不擋的話，拖一支影片到時間軸會順便把它切成作用中媒體
  const swallowClick = useRef(false);
  const dragging = ghost !== null;

  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // capture 階段先攔：不然 Esc 同時會被時間軸當成「取消選取」
      e.stopPropagation();
      gesture.current = null;
      setGhost(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  const bind = (payload: SidebarDragPayload) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      gesture.current = { payload, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId, active: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.pointerId !== e.pointerId) return;
      if (!g.active) {
        if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < DRAG_START_PX) return;
        g.active = true;
        swallowClick.current = true;
        // 捕捉之後游標離開側欄也收得到 move / up；elementFromPoint 不受捕捉影響，照樣問得到底下是誰
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      const hint = describeSidebarDrop(g.payload, e.clientX, e.clientY, { snap: !e.altKey });
      setGhost({ x: e.clientX, y: e.clientY, text: hint ?? t("拖到序列時間軸上放開"), ok: hint !== null });
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      gesture.current = null;
      // click 在 pointerup 之後同一輪事件裡送：下一個 tick 放掉，沒送 click（在視窗外放開）也不會吞掉下一次真的點擊
      if (swallowClick.current) window.setTimeout(() => (swallowClick.current = false), 0);
      if (!g || g.pointerId !== e.pointerId || !g.active) return;
      setGhost(null);
      dropSidebarPayload(g.payload, e.clientX, e.clientY, { snap: !e.altKey });
    },
    onPointerCancel: () => {
      gesture.current = null;
      swallowClick.current = false;
      setGhost(null);
    },
    onClickCapture: (e: ReactMouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  });

  const ghostEl = ghost && (
    // pointer-events-none：放開時 elementFromPoint 才不會打到標籤自己
    <div
      className={`fixed z-50 pointer-events-none rounded border shadow-e2 px-2 py-1 text-[11px] whitespace-nowrap ${ghost.ok ? "bg-elevated border-accent/40 text-fg/90" : "bg-elevated border-fg/10 text-fg/50"}`}
      style={{ left: ghost.x + 14, top: ghost.y + 12 }}
      role="status"
    >
      {ghost.text}
    </div>
  );

  return { bind, ghostEl };
}

// ---- 音訊清單（M2.14）----

const ROLE_ICON: Record<AudioRole, LucideIcon> = { music: Music, voiceover: Mic, sfx: Zap, other: AudioLines };
/** 角色 tooltip（zh key，en.ts 已有；跟 TrackHeaders 同一組字串）。 */
const ROLE_LABEL: Record<AudioRole, string> = { music: "角色：音樂", voiceover: "角色：旁白", sfx: "角色：音效", other: "角色：其他" };

function AudioSection({ bind }: { bind: DragBind }) {
  const t = useT();
  const audioMedia = useEdits((s) => s.audioMedia);
  const sequence = useEdits((s) => s.sequence);
  const pending = useAudioImports((s) => s.pending);
  const engineOk = useEngine((s) => s.state === "ready" || pyenvReady(s));

  // 開舊專案（或當初引擎沒裝）時補算 audio_info：波形位置與渲染對齊要用；衍生資料，不記 undo
  useEffect(() => {
    if (!engineOk) return;
    for (const am of audioMedia) if (!am.audio) void ensureAudioMediaInfo(am.id);
  }, [engineOk, audioMedia]);

  const remove = async (am: AudioMediaV2) => {
    const n = audioClipCount(sequence, am.id);
    if (n > 0) {
      const ok = await uiConfirm(t("從專案移除「{name}」？會一併刪除 {n} 個用到它的音訊片段（可以復原）。", { name: am.name, n }), { danger: true, confirmText: t("移除") });
      if (!ok) return;
    }
    useEdits.getState().removeAudioMedia(am.id);
  };

  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-t border-b border-fg/10">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("音訊")}</span>
        <Button size="sm" variant="ghost" icon={FilePlus} className="ml-auto" onClick={() => void importAudioDialog()} data-cmd="audio.import">
          {t("加入音訊檔…")}
        </Button>
      </div>
      <div className="max-h-[30%] min-h-0 overflow-auto" data-testid="sidebar-audio">
        {audioMedia.length === 0 && pending.length === 0 ? (
          <div className="p-3 text-xs text-fg/30 leading-relaxed">{t("把 wav / mp3 / m4a / flac / opus 拖到時間軸或這裡；清單裡的音訊可以再拖到音軌上。")}</div>
        ) : (
          <>
            {audioMedia.map((am) => {
              const n = audioClipCount(sequence, am.id);
              return (
                <div
                  key={am.id}
                  role="button"
                  tabIndex={0}
                  {...bind({ kind: "audio", audioId: am.id })}
                  onDoubleClick={() => void placeAudioMedia(am.id, { kind: "playhead" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void placeAudioMedia(am.id, { kind: "playhead" });
                  }}
                  title={`${am.path}\n${t("拖到音軌上放開，或雙擊加到播放線")}`}
                  className="group flex items-center gap-2 px-3 py-1.5 border-b border-fg/5 cursor-grab hover:bg-fg/5 touch-none"
                  data-audio-media={am.id}
                >
                  <span className="shrink-0 text-fg/50" title={t(ROLE_LABEL[am.role])}>
                    <Icon icon={ROLE_ICON[am.role]} size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-fg/90 text-xs">{am.name}</div>
                    <div className="text-[11px] text-fg/40 mono truncate">
                      {audioMediaSummary(am)}
                      {n ? ` · ${t("{n} 個片段", { n })}` : ""}
                    </div>
                  </div>
                  <IconButton
                    icon={Plus}
                    label={t("加到播放線")}
                    iconSize={14}
                    box="w-6 h-6"
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void placeAudioMedia(am.id, { kind: "playhead" });
                    }}
                  />
                  <IconButton
                    icon={Trash}
                    label={t("移除")}
                    iconSize={14}
                    box="w-6 h-6"
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(am);
                    }}
                  />
                </div>
              );
            })}
            {pending.map((name, i) => (
              <div key={`pending-${i}-${name}`} className="flex items-center gap-2 px-3 py-1.5 border-b border-fg/5 text-xs text-fg/50">
                <Spinner size={12} className="text-info" />
                <span className="truncate">{name}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

type DragBind = ReturnType<typeof useSidebarDrag>["bind"];

/** 媒體清單的一列。序列剪輯開著時多兩顆鈕（接到結尾 / 在播放線插入），整列可以拖到時間軸插入（§9.5）。 */
function MediaRow({ m, active, seqEnabled, bind, onActivate, onRemove }: { m: MediaItem; active: boolean; seqEnabled: boolean; bind: DragBind; onActivate: () => void; onRemove: () => void }) {
  const t = useT();
  const v = m.probe?.video;
  const hoverBtn = "opacity-0 group-hover:opacity-100 focus-visible:opacity-100";
  return (
    <div
      role="button"
      tabIndex={0}
      // 旗標關著時跟 M1 一樣只能點：不掛拖曳，也不加 touch-none
      {...(seqEnabled ? bind({ kind: "media", mediaId: m.id }) : {})}
      onClick={onActivate}
      onContextMenu={(e) => openMediaContextMenu(e, m.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onActivate();
      }}
      title={seqEnabled ? `${m.path}\n${t("拖到序列時間軸上插入")}` : m.path}
      className={`group flex items-center gap-2 px-3 py-2 border-b border-fg/5 cursor-pointer ${seqEnabled ? "touch-none" : ""} ${active ? "bg-accent/12" : "hover:bg-fg/5"}`}
      data-media={m.id}
    >
      <span className={`shrink-0 ${active ? "text-accent" : "text-fg/50"}`}>
        <Icon icon={Film} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-fg/90">{m.name}</div>
        <div className="text-[11px] text-fg/40 mono truncate">
          {v ? `${v.width}×${v.height} · ${fpsLabel(v.r_frame_rate)} fps · ${v.codec}` : "—"}
          {m.proxy ? ` · ${m.proxy.frames} ${t("幀")}` : ""}
        </div>
      </div>
      {proxyBadge(m, t)}
      {seqEnabled && (
        <>
          <IconButton
            icon={ListEnd}
            label={t("接到序列結尾")}
            iconSize={14}
            box="w-6 h-6"
            className={hoverBtn}
            onClick={(e) => {
              e.stopPropagation();
              addMediaToSequence(m.id, "append");
            }}
          />
          <IconButton
            icon={BetweenHorizontalStart}
            label={t("在播放線插入")}
            iconSize={14}
            box="w-6 h-6"
            className={hoverBtn}
            onClick={(e) => {
              e.stopPropagation();
              addMediaToSequence(m.id, "insert");
            }}
          />
        </>
      )}
      <IconButton
        icon={Trash}
        label={t("移除")}
        iconSize={14}
        box="w-6 h-6"
        className="opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      />
    </div>
  );
}

/**
 * 左側欄：媒體清單 + （序列剪輯開著時）音訊清單 + 作用中媒體的鏡頭清單（計畫 §8 Sidebar：媒體+鏡頭；設計 §9.5 拖放）。
 * 工作清單在 Inspector 的 Jobs 分頁；這裡只放「在時間軸上有位置」的東西。
 */
export default function Sidebar({ width }: { width: number }) {
  const t = useT();
  useCommandTick();
  const media = useProject((s) => s.media);
  const activeId = useProject((s) => s.activeMediaId);
  const setActive = useProject((s) => s.setActive);
  const removeMedia = useProject((s) => s.removeMedia);
  const shots = useEdits((s) => (activeId ? s.shots[activeId] ?? EMPTY_SHOTS : EMPTY_SHOTS));
  const tracks = useEdits((s) => (activeId ? s.tracks[activeId] : undefined));
  const seqEnabled = useSettings((s) => s.experimental.sequence);
  const active = media.find((m) => m.id === activeId) ?? null;
  const fps = active?.proxy?.fps ?? active?.probe?.video?.r_frame_rate ?? { num: 30, den: 1 };
  // 只在這裡訂閱 frame：高亮「播放線在哪個鏡頭」要跟著走
  const frame = usePlayback((s) => s.frame);
  const drag = useSidebarDrag();

  return (
    <div className="shrink-0 bg-panel border-r border-fg/10 flex flex-col text-sm min-h-0" style={{ width }} data-testid="sidebar">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("媒體")}</span>
        <Button size="sm" variant="primary" icon={FolderOpen} className="ml-auto" onClick={() => void A.openMedia()} data-cmd="file.open">
          {t("開啟影片…")}
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {media.length === 0 ? (
          <div className="p-4 text-xs text-fg/35 leading-relaxed">{t("把 mp4 / mov / webm 拖進來，或按「開啟影片」。")}</div>
        ) : (
          media.map((m) => <MediaRow key={m.id} m={m} active={m.id === activeId} seqEnabled={seqEnabled} bind={drag.bind} onActivate={() => setActive(m.id)} onRemove={() => removeMedia(m.id)} />)
        )}
      </div>

      {seqEnabled && <AudioSection bind={drag.bind} />}

      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-t border-b border-fg/10">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("鏡頭")}</span>
        {active && (
          <button
            type="button"
            disabled={!engineReady() || active.proxyState !== "ready"}
            onClick={() => void detectShots(active.id).catch(() => {})}
            title={engineReady() ? t("重新偵測鏡頭切點") : t("引擎尚未就緒")}
            className="ml-auto text-[11px] text-fg/40 hover:text-fg/70 disabled:opacity-40"
          >
            {t("偵測鏡頭")}
          </button>
        )}
      </div>
      <div className="max-h-[42%] min-h-0 overflow-auto">
        {!active ? null : shots.length === 0 ? (
          <div className="p-3 text-xs text-fg/30">{t("還沒有鏡頭：引擎就緒後會自動偵測，或按 S 在播放線手動切。")}</div>
        ) : (
          shots.map((s) => {
            const here = s.startFrame <= frame && frame < s.endFrame;
            const n = (tracks ?? []).filter((x) => x.shotId === s.id).length;
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => A.seekTo(s.startFrame)}
                // 雙擊＝把這個鏡頭設為範圍（剪輯軟體「雙擊片段＝選那段」的慣例）。以前是「與下一個鏡頭合併」，
                // 破壞性的動作放在最容易誤觸的手勢上不對；合併移到右鍵選單
                onDoubleClick={() => {
                  useTimeline.getState().setRange({ in: s.startFrame, out: s.endFrame });
                  A.seekTo(s.startFrame);
                }}
                onContextMenu={(e) => openShotContextMenu(e, s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") A.seekTo(s.startFrame);
                }}
                title={`${s.id}\n${t("點一下跳到開頭；雙擊設為範圍；右鍵有合併與更多")}`}
                className={`flex items-center gap-2 px-3 py-1.5 border-b border-fg/5 text-xs cursor-pointer ${here ? "bg-shot/15" : "hover:bg-fg/5"}`}
                data-shot={s.id}
              >
                <Icon icon={Scissors} size={12} className={here ? "text-shot" : "text-fg/35"} />
                <span className="mono text-fg/75">
                  {timecode(s.startFrame, fps)} – {timecode(s.endFrame, fps)}
                </span>
                <span className="text-fg/40 truncate">{t(SHOT_KIND_LABEL[s.kind])}</span>
                <span className="ml-auto text-fg/40 tabular-nums">{n ? t("{n} 條追蹤", { n }) : ""}</span>
              </div>
            );
          })
        )}
      </div>
      {drag.ghostEl}
    </div>
  );
}
