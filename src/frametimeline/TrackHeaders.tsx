import { AudioLines, ChevronDown, ChevronRight, Film, Headphones, Link2, Lock, LockOpen, Mic, Music, Rows3, Unlink2, Volume2, VolumeX, Zap, type LucideIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { A0_BUS_ID, useAudioMonitor } from "../audio/preview";
import { useT } from "../i18n";
import { GAIN_DB_MAX, type AudioLaneV2, type AudioRole, type SequenceV2 } from "../project/format";
import { setLane, setOriginalBus, type LanePatch } from "../sequence/ops";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { toast } from "../ui";
import Icon from "../ui/Icon";
import { formatGainDb } from "./drawSequence";
import { nextLaneHeight, TRACK_HEADER_W, type SequenceLayout } from "./layoutSequence";

/**
 * 序列空間左側的軌道標頭（docs/editor-m2-design.md §9.2）：DOM 而不是畫在 canvas 上 ——
 * 按鈕要有 focus ring、tooltip、鍵盤可達性，canvas 上的假按鈕三樣都沒有。
 *
 * 列的 y / 高度完全照 layoutSequenceRows（跟 canvas 同一份版面），所以標頭跟右邊的列永遠對齊；
 * 外層容器負責垂直捲動，標頭與 canvas 一起捲。
 *
 * 標頭上的動作（靜音、鎖定、同步鎖、推桿、改名）都走 editSequence：一個動作一筆 undo；
 * 隱含序列時第一次按下會在同一筆 undo 裡實體化（一次 Ctrl+Z 回到 null）。推桿拖曳用 coalesceKey 合併成一筆。
 */

// ---- 序列時間軸的檢視狀態（不進專案、不進 undo）----

interface SequenceViewStore {
  /** 音軌高度（16 / 40 / 72）；key = laneId。 */
  laneHeights: Record<string, number>;
  /** 追蹤群組摺疊。 */
  tracksCollapsed: boolean;
  setLaneHeight: (laneId: string, h: number) => void;
  toggleTracks: () => void;
}

const TRACKS_COLLAPSED_KEY = "aivc:seqTracksCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(TRACKS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 為什麼音軌高度不存進 AudioLaneV2：那是「這台螢幕上想看多細」的檢視偏好，存進專案檔會讓同一個專案在筆電上打開時列高怪怪的，
 * 而且每拉一次高度就多一筆「修改」讓自動存檔寫檔。
 */
export const useSequenceView = create<SequenceViewStore>((set) => ({
  laneHeights: {},
  tracksCollapsed: readCollapsed(),
  setLaneHeight: (laneId, h) => set((s) => (s.laneHeights[laneId] === h ? s : { laneHeights: { ...s.laneHeights, [laneId]: h } })),
  toggleTracks: () =>
    set((s) => {
      try {
        localStorage.setItem(TRACKS_COLLAPSED_KEY, s.tracksCollapsed ? "0" : "1");
      } catch {
        /* ignore */
      }
      return { tracksCollapsed: !s.tracksCollapsed };
    }),
}));

// ---- 動作 ----

/** 音軌鎖定 / 改名的 undo 標籤（SEQ_EDIT_LABEL 沒有這兩個；zh key，歷史面板 t() 它，en.ts 有對應）。 */
const LANE_LOCK_LABEL = "音軌鎖定";
const LANE_RENAME_LABEL = "音軌改名";

/** 推桿的下限：再往下就是聽不到的差別，拉桿行程留給常用的 −48..+12。 */
const FADER_MIN_DB = -48;

function runEdit(label: string, f: (seq: SequenceV2) => SequenceV2 | null, fail: (msg: string) => string, coalesceKey?: string) {
  try {
    useEdits.getState().editSequence(label, (seq) => f(seq), coalesceKey ? { coalesceKey } : undefined);
  } catch (e) {
    // 隱含序列實體化失敗（proxy 還沒好）或軌道被刪：狀態沒變，跟使用者講為什麼沒反應
    toast.error(fail(e instanceof Error ? e.message : String(e)));
  }
}

const ROLE_ICON: Record<AudioRole, LucideIcon> = { music: Music, voiceover: Mic, sfx: Zap, other: AudioLines };
/** 角色圖示的 tooltip（zh key；前綴「角色：」讓它跟選單上的「音樂 / 旁白」等短字串分開，翻譯語境不同）。 */
const ROLE_LABEL: Record<AudioRole, string> = { music: "角色：音樂", voiceover: "角色：旁白", sfx: "角色：音效", other: "角色：其他" };

// ---- 元件 ----

function HeaderButton({ icon, label, active, onClick, danger, small }: { icon: LucideIcon; label: string; active?: boolean; onClick: () => void; danger?: boolean; small?: boolean }) {
  // 靜音亮紅（Resolve / Premiere 的 M 鈕都是警示色：「這條軌現在聽不到」要一眼看得到），其他開關亮強調色
  const onTone = danger ? "bg-danger/20 text-danger" : "bg-accent/15 text-accent";
  const tone = active ? onTone : "text-fg/50 hover:text-fg hover:bg-fg/10";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={
        `${small ? "w-4 h-4" : "w-5 h-5"} grid place-items-center rounded shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-accent/60 ` +
        tone
      }
    >
      <Icon icon={icon} size={small ? 11 : 12} />
    </button>
  );
}

/** 推桿：dB 滑桿，雙擊歸零（§9.2）；拖曳中的每一步合併成一筆 undo。 */
function Fader({ value, label, onChange }: { value: number; label: string; onChange: (db: number, commitKey: string) => void }) {
  const [dragKey] = useState(() => `fader-${Math.random().toString(36).slice(2)}`);
  return (
    <input
      type="range"
      min={FADER_MIN_DB}
      max={GAIN_DB_MAX}
      step={0.5}
      value={Math.max(FADER_MIN_DB, value)}
      aria-label={label}
      title={`${label} ${formatGainDb(value)}`}
      onChange={(e) => onChange(Number(e.target.value), dragKey)}
      onDoubleClick={() => onChange(0, `${dragKey}-reset`)}
      className="w-full h-3 accent-[rgb(var(--c-gain-line))] cursor-ew-resize"
    />
  );
}

function Cell({ y, h, children, className = "" }: { y: number; h: number; children?: ReactNode; className?: string }) {
  return (
    <div className={`absolute left-0 right-0 px-1.5 overflow-hidden ${className}`} style={{ top: y, height: h }}>
      {children}
    </div>
  );
}

function LaneName({ lane }: { lane: AudioLaneV2 }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lane.name);
  // 輸入框收起時瀏覽器可能再送一次 blur（Enter 之後、Esc 之後）：已經收過就不再處理，Esc 也不會被 blur 當成「確定」
  const closedRef = useRef(false);
  const close = (save: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    setEditing(false);
    const name = draft.trim();
    if (save && name && name !== lane.name) runEdit(LANE_RENAME_LABEL, (seq) => setLane(seq, lane.id, { name }), (m) => t("無法修改序列：{msg}", { msg: m }));
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        aria-label={t("音軌改名")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => close(true)}
        // 打字時的 B / Delete 不會變成分割 / 刪除：hotkeys.ts 的 typingTarget 已經擋掉；這裡不 stopPropagation，Ctrl+S 之類的全域鍵照常可用
        onKeyDown={(e) => {
          if (e.key === "Enter") close(true);
          else if (e.key === "Escape") close(false);
        }}
        className="min-w-0 flex-1 h-4 px-1 text-[11px] rounded bg-inset border border-accent/60 text-fg outline-none"
      />
    );
  }
  return (
    <span
      className="min-w-0 flex-1 truncate text-[11px] text-fg/80 cursor-text"
      title={t("雙擊改名")}
      onDoubleClick={() => {
        closedRef.current = false;
        setDraft(lane.name);
        setEditing(true);
      }}
    >
      {lane.name}
    </span>
  );
}

/** 獨奏按鈕：不存檔、不進 undo（監聽狀態，§3.2）—— 邏輯早就在 gainCurve / preview 裡，一直缺的只是這顆按鈕。 */
function SoloButton({ id, small }: { id: string; small?: boolean }) {
  const t = useT();
  const on = useAudioMonitor((s) => s.solo.includes(id));
  const toggleSolo = useAudioMonitor((s) => s.toggleSolo);
  return <HeaderButton icon={Headphones} label={on ? t("取消獨奏") : t("獨奏（只聽這一軌）")} active={on} small={small} onClick={() => toggleSolo(id)} />;
}

function LaneHeader({ lane, y, h }: { lane: AudioLaneV2; y: number; h: number }) {
  const t = useT();
  const setLaneHeight = useSequenceView((s) => s.setLaneHeight);
  const fail = (m: string) => t("無法修改序列：{msg}", { msg: m });
  const patch = (label: string, p: LanePatch, key?: string) => runEdit(label, (seq) => setLane(seq, lane.id, p), fail, key);
  // 16 px 的矮軌只放得下一列：名字、靜音、高度切換。其餘的軌分兩列 —— 132 px 寬塞五個按鈕在同一列，名字只剩一個字
  const compact = h < 30;
  const heightButton = <HeaderButton icon={Rows3} label={t("軌道高度")} small={!compact} onClick={() => setLaneHeight(lane.id, nextLaneHeight(h))} />;
  return (
    <Cell y={y} h={h} className={`border-b border-fg/5 flex flex-col justify-center gap-0.5 ${lane.muted ? "bg-fg/[0.02]" : ""}`}>
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-clip-audio shrink-0" title={t(ROLE_LABEL[lane.role])}>
          <Icon icon={ROLE_ICON[lane.role]} size={12} />
        </span>
        <LaneName lane={lane} />
        <SoloButton id={lane.id} />
        <HeaderButton icon={lane.muted ? VolumeX : Volume2} label={lane.muted ? t("取消音軌靜音") : t("音軌靜音")} active={lane.muted} danger onClick={() => patch(SEQ_EDIT_LABEL.laneMute, { muted: !lane.muted })} />
        {compact && heightButton}
      </div>
      {!compact && (
        <div className="flex items-center gap-1 min-w-0">
          <HeaderButton icon={lane.locked ? Lock : LockOpen} label={t("音軌鎖定")} active={lane.locked} small onClick={() => patch(LANE_LOCK_LABEL, { locked: !lane.locked })} />
          <HeaderButton
            icon={lane.syncLock ? Link2 : Unlink2}
            label={lane.syncLock ? t("同步鎖：開（跟著 V1 波紋移動）") : t("同步鎖：關（釘在成品時間）")}
            active={lane.syncLock}
            small
            onClick={() => patch(SEQ_EDIT_LABEL.syncLock, { syncLock: !lane.syncLock })}
          />
          {heightButton}
          <div className="min-w-0 flex-1">
            <Fader value={lane.gainDb} label={t("音軌推桿")} onChange={(db, key) => patch(SEQ_EDIT_LABEL.laneGain, { gainDb: db }, key)} />
          </div>
        </div>
      )}
    </Cell>
  );
}

export interface TrackHeaderTrack {
  id: string;
  /** 「m1 · Player1」：序列裡可能有好幾支媒體，標籤帶媒體名才分得出是哪一支的 track（§9.2）。 */
  label: string;
  selected: boolean;
}

export interface TrackHeadersProps {
  layout: SequenceLayout;
  seq: SequenceV2;
  tracks: readonly TrackHeaderTrack[];
  /** 隱含序列（還沒剪過）：標頭照樣可以按，第一次按下會實體化。 */
  implicit: boolean;
  onSelectTrack?: (trackId: string) => void;
}

export default function TrackHeaders({ layout: L, seq, tracks, implicit, onSelectTrack }: TrackHeadersProps) {
  const t = useT();
  const toggleTracks = useSequenceView((s) => s.toggleTracks);
  const fail = (m: string) => t("無法修改序列：{msg}", { msg: m });
  const trackById = new Map(tracks.map((x) => [x.id, x]));
  return (
    <div className="relative shrink-0 bg-panel border-r border-fg/10 select-none" style={{ width: TRACK_HEADER_W, height: L.height }} data-testid="track-headers">
      <Cell y={L.rulerY} h={L.rulerH + L.rangeH} className="flex items-center border-b border-fg/10">
        <span className="truncate text-[11px] text-fg/60" title={implicit ? t("序列還沒剪過：第一次剪輯時才建立") : seq.name}>
          {seq.name}
        </span>
      </Cell>

      <Cell y={L.v1Y} h={L.v1H} className="flex items-center gap-1.5 border-b border-fg/5">
        <span className="text-clip-video">
          <Icon icon={Film} size={13} />
        </span>
        <span className="text-[11px] font-medium text-fg/85">{t("V1 影像")}</span>
      </Cell>

      <Cell y={L.a0Y} h={L.a0H} className="flex flex-col justify-center gap-0.5 border-b border-fg/5">
        <div className="flex items-center gap-1">
          <span className="text-clip-audio">
            <Icon icon={AudioLines} size={12} />
          </span>
          <span className="flex-1 text-[11px] font-medium text-fg/85">{t("A0 原音")}</span>
          <SoloButton id={A0_BUS_ID} />
          <HeaderButton
            icon={seq.original.muted ? VolumeX : Volume2}
            label={seq.original.muted ? t("取消原音靜音") : t("原音靜音")}
            active={seq.original.muted}
            danger
            onClick={() => runEdit(SEQ_EDIT_LABEL.laneMute, (s) => setOriginalBus(s, { muted: !s.original.muted }), fail)}
          />
        </div>
        <Fader value={seq.original.gainDb} label={t("原音推桿")} onChange={(db, key) => runEdit(SEQ_EDIT_LABEL.laneGain, (s) => setOriginalBus(s, { gainDb: db }), fail, key)} />
      </Cell>

      {L.tracksHeaderH > 0 && (
        <Cell y={L.tracksHeaderY} h={L.tracksHeaderH} className="px-0">
          <button
            type="button"
            onClick={toggleTracks}
            aria-expanded={!L.tracksCollapsed}
            className="w-full h-full flex items-center gap-1 px-1 text-[11px] text-fg/70 hover:text-fg hover:bg-fg/5 focus-visible:outline-2 focus-visible:outline-accent/60"
          >
            <Icon icon={L.tracksCollapsed ? ChevronRight : ChevronDown} size={12} />
            {t("追蹤（{n}）", { n: tracks.length })}
          </button>
        </Cell>
      )}

      {L.rows.map((row) => {
        const tr = trackById.get(row.trackId);
        if (!tr) return null;
        return (
          <Cell key={row.trackId} y={row.y} h={row.h} className="px-0">
            <button
              type="button"
              onClick={() => onSelectTrack?.(row.trackId)}
              title={tr.label}
              className={`w-full h-full text-left pl-4 pr-1 truncate text-[11px] focus-visible:outline-2 focus-visible:outline-accent/60 ${tr.selected ? "text-accent bg-accent/10" : "text-fg/65 hover:bg-fg/5"}`}
            >
              {tr.label}
            </button>
          </Cell>
        );
      })}

      {L.lanes.map((row) => {
        const lane = seq.audioLanes.find((l) => l.id === row.laneId);
        return lane ? <LaneHeader key={row.laneId} lane={lane} y={row.y} h={row.h} /> : null;
      })}
    </div>
  );
}
