import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronDown,
  CirclePlay,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Diamond,
  Ellipsis,
  FastForward,
  ListVideo,
  Pause,
  Play,
  Repeat,
  Rewind,
  SkipBack,
  SkipForward,
  Square,
  SquareDashed,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { Rational } from "../api";
import { commandToMenuItem } from "../commands/menuModel";
import { command, runCommand, useCommandTick, useEnabled } from "../commands/registry";
import { formatShortcut } from "../commands/shortcut";
import { useT } from "../i18n";
import { parseTimecodeInput, shuttleLabel, usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { timecode } from "../time";
import Icon from "../ui/Icon";
import MenuPanel, { type MenuAnchor, type MenuItem } from "../ui/MenuPanel";
import { fpsLabel } from "../video/frames";
import { useActiveMedia } from "./active";

/**
 * 傳輸列（計畫 §8；仿 ai-music-cut preview/TransportBar.tsx 與 Resolve / Premiere 的檢視器按鈕列）：掛在影片正下方。
 *
 * - 每顆按鈕都派發**指令**（commands/core.ts 的 playback.*）：按鈕、快捷鍵、選單、命令面板是同一份實作，
 *   停用原因也是同一句（tooltip 顯示、點下去 toast）。中文輸入法下字母鍵常常沒有 keydown，很多人只點按鈕 ——
 *   兩條路徑行為不同就是 bug（ai-music-cut 的 togglePlaySelectionAware 教訓）。
 * - 按鈕不搶焦點（mousedown preventDefault）：焦點若停在按鈕上，下一次 Space 會同時「按下按鈕」又觸發全域播放，
 *   兩次切換互相抵銷，看起來像按了沒反應。
 * - 停用的按鈕仍點得到（aria-disabled、半透明）：原生 disabled 會吃掉 hover，tooltip 的停用原因就看不到了。
 * - 只有時間碼欄位訂閱 playback.frame（每呈現一幀重繪）；其餘部分不跟著幀跑。
 */

/**
 * 依列寬決定哪些東西直接放在列上、哪些收進「⋯」。門檻是實量的累加寬度（按鈕 30、時間碼 117 / 含總長 217、
 * 範圍晶片約 175…），不是整數好看：預設視窗 1360 扣掉左右欄，影片欄只剩約 760 px，
 * 那個寬度要放得下「播放 / 轉盤 / 逐幀 / 停止 / 頭尾 + 時間碼 + 範圍晶片 / 範圍播放 / 循環 + 速度 + 靜音」而不被裁掉。
 * 優先序：播放與逐幀 > 時間碼 > 範圍 > 速度 > 總長 > 標入出點 > 鏡頭導覽 > ±10 幀 / 關鍵幀 / 音量滑桿 > 媒體晶片。
 */
export interface TransportLayout {
  time: boolean;
  outer: boolean;
  range: boolean;
  total: boolean;
  marks: boolean;
  shots: boolean;
  fine: boolean;
  chip: boolean;
}

export function transportLayout(w: number): TransportLayout {
  return { time: w >= 360, outer: w >= 420, range: w >= 640, total: w >= 880, marks: w >= 940, shots: w >= 1000, fine: w >= 1200, chip: w >= 1360 };
}

function useBarWidth(ref: RefObject<HTMLDivElement>): number {
  const [w, setW] = useState(1400);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const EMPTY_FPS: Rational = { num: 30, den: 1 };
const btnBase = "grid place-items-center rounded shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-accent/60";

function Sep() {
  return <span className="w-px h-4 bg-fg/10 mx-1 shrink-0" aria-hidden />;
}

interface TButtonProps {
  id: string;
  icon?: LucideIcon;
  /** 自訂圖形（◆ 關鍵幀、{ } 入出點）；給了就不畫 icon。 */
  glyph?: ReactNode;
  /** 已翻譯的標籤；沒給就用指令標題。 */
  label?: string;
  /** 顯示用快捷鍵；沒給就取指令的第一個（手寫派發的 J / L 由呼叫端補）。 */
  keys?: string;
  active?: boolean;
  big?: boolean;
}

/** 指令按鈕：tooltip ＝「標籤（快捷鍵）— 停用原因」。 */
function TButton({ id, icon, glyph, label, keys, active = false, big = false }: TButtonProps) {
  const t = useT();
  const c = command(id);
  const en = useEnabled(c);
  const name = label ?? (c ? t(c.title, c.titleParams) : id);
  const k = keys ?? (c?.shortcuts?.[0] ? formatShortcut(c.shortcuts[0]) : "");
  const why = !c ? t("這個指令還沒接上（{id}）", { id }) : en.ok ? "" : t(en.why);
  const tip = `${name}${k ? `（${k}）` : ""}${why ? ` — ${why}` : ""}`;
  return (
    <button
      type="button"
      aria-label={tip}
      title={tip}
      aria-pressed={active}
      aria-disabled={!en.ok || undefined}
      data-cmd={id}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void runCommand(id, "toolbar")}
      className={`${big ? "w-8 h-8" : "w-7 h-7"} ${btnBase} ${active ? "bg-accent/12 text-accent" : "text-fg/60 hover:text-fg hover:bg-fg/10"} ${en.ok ? "" : "opacity-40"}`}
    >
      {glyph ?? (icon ? <Icon icon={icon} size={big ? 18 : 15} /> : null)}
    </button>
  );
}

/** ◀◆ / ◆▶：關鍵幀導覽（lucide 沒有現成的「上一個關鍵幀」）。 */
function KeyframeGlyph({ dir }: { dir: -1 | 1 }) {
  return (
    <span className="inline-flex items-center" aria-hidden>
      {dir < 0 && <Icon icon={ChevronLeft} size={12} className="-mr-0.5" />}
      <Icon icon={Diamond} size={10} />
      {dir > 0 && <Icon icon={ChevronRight} size={12} className="-ml-0.5" />}
    </span>
  );
}

function BracketGlyph({ ch }: { ch: string }) {
  return (
    <span className="mono text-[14px] font-semibold leading-none" aria-hidden>
      {ch}
    </span>
  );
}

// ---- 時間碼欄位 ----

type TcMode = "tc" | "frames";
const TC_MODE_KEY = "aivc:tcMode";

function readTcMode(): TcMode {
  try {
    return localStorage.getItem(TC_MODE_KEY) === "frames" ? "frames" : "tc";
  } catch {
    return "tc";
  }
}

function writeTcMode(m: TcMode): void {
  try {
    localStorage.setItem(TC_MODE_KEY, m);
  } catch {
    /* 私密視窗 / 停用儲存 */
  }
}

/**
 * 「00:00:28:12 / 00:00:59:27」；點一下（或按 =）變輸入框：Enter 跳轉、Esc / 失焦取消。
 * 焦點在輸入框時全域快捷鍵讓路（hotkeys.ts 的 typingTarget），打 Space / 數字不會觸發播放或檢視模式。
 */
function TimecodeField({ fps, frames, total }: { fps: Rational; frames: number; total: boolean }) {
  const t = useT();
  const frame = usePlayback((s) => s.frame);
  const tcFocus = usePlayback((s) => s.tcFocus);
  const [mode, setMode] = useState<TcMode>(readTcMode);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fmt = useCallback((f: number) => (mode === "tc" ? timecode(f, fps) : String(f)), [mode, fps]);

  const begin = useCallback(() => {
    setText(fmt(usePlayback.getState().frame));
    setBad(false);
    setEditing(true);
  }, [fmt]);

  // `=` 指令：tcFocus 遞增一次就進入編輯一次（初值不算）
  const seenFocus = useRef(tcFocus);
  useEffect(() => {
    if (tcFocus === seenFocus.current) return;
    seenFocus.current = tcFocus;
    begin();
  }, [tcFocus, begin]);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, [editing]);

  const commit = () => {
    const f = parseTimecodeInput(text, fps, usePlayback.getState().frame, frames);
    if (f === null) {
      setBad(true);
      return;
    }
    // 走 store 的 seek（和時間軸 scrub 同一條路）：範圍播放中跳出範圍會由 playerRef 結束範圍模式
    usePlayback.getState().seek(f);
    setEditing(false);
  };

  const toggleMode = () => {
    const next: TcMode = mode === "tc" ? "frames" : "tc";
    writeTcMode(next);
    setMode(next);
  };

  return (
    <span className="flex items-center gap-0.5 shrink-0">
      {editing ? (
        <input
          ref={inputRef}
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-label={t("時間碼或幀號")}
          aria-invalid={bad || undefined}
          title={bad ? t("看不懂的時間碼：試試 00:00:12:05、365（幀）、+10、-1.5s") : t("Enter 跳轉、Esc 取消；+10 / -5 相對幀，+1.5s 相對秒")}
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
          onKeyDown={(e) => {
            // 輸入法選字中的 Enter 是確認候選字，不是送出
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
          className={`h-7 w-36 px-2 rounded bg-inset border mono text-xs tabular-nums text-fg outline-none ${bad ? "border-danger/70 ring-2 ring-danger/20" : "border-accent/60"}`}
          data-testid="transport-timecode-input"
        />
      ) : (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={begin}
          title={t("點一下輸入時間碼或幀號（=）")}
          className="h-7 px-2 rounded mono text-xs tabular-nums whitespace-nowrap text-fg/80 hover:bg-fg/5"
          data-testid="transport-timecode"
        >
          {fmt(frame)}
          {total && <span className="text-fg/35"> / {fmt(frames)}</span>}
        </button>
      )}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleMode}
        title={mode === "tc" ? t("顯示幀號") : t("顯示時間碼")}
        className="h-6 px-1 rounded text-[10px] mono text-fg/45 hover:text-fg hover:bg-fg/10"
      >
        {mode === "tc" ? "TC" : "#"}
      </button>
    </span>
  );
}

// ---- 範圍晶片 ----

/** 範圍晶片用的短時間碼：拿掉開頭的 00: 群組（00:00:28:00 → 28:00）。 */
function shortTc(f: number, fps: Rational): string {
  let s = timecode(f, fps);
  while (s.startsWith("00:") && s.split(":").length > 2) s = s.slice(3);
  return s;
}

/**
 * 還沒有範圍時的晶片。**按得動**，不是一行灰字。
 *
 * 原本這裡是靜態的「未設範圍」，於是整個 App 只有快捷鍵（I / O）與「拖範圍列」兩條路能建立範圍，
 * 兩條都要先知道才用得到 —— 使用者回報「我想要有可以選取區間的功能」時，功能其實早就做完了。
 *
 * 一次點擊就是一次 I / O：沒標過就標入點，標了入點就標出點。兩下點完，跟按兩次鍵一樣，
 * 而且晶片自己會說下一步是什麼（「入點 12:00，再點一下標出點」）。
 */
function EmptyRangeChip({ fps, pendingIn, pendingOut }: { fps: Rational; pendingIn: number | null; pendingOut: number | null }) {
  const t = useT();
  const next = pendingIn != null ? "playback.markOut" : "playback.markIn";
  const en = useEnabled(command(next));
  const text =
    pendingIn != null
      ? t("入點 {tc}，再點一下標出點", { tc: shortTc(pendingIn, fps) })
      : pendingOut != null
        ? t("出點 {tc}，再點一下標入點", { tc: shortTc(pendingOut, fps) })
        : t("選取區間");
  const tip = t("在播放線標{side}（{key}）。也可以在時間軸的範圍列上直接拖曳，或在任何地方 Shift+拖曳。", {
    side: next === "playback.markOut" ? t("出點") : t("入點"),
    key: next === "playback.markOut" ? "O" : "I",
  });
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void runCommand(next, "toolbar")}
      aria-disabled={!en.ok || undefined}
      title={en.ok ? tip : t(en.why)}
      className={`h-6 px-2 gap-1 rounded text-[11px] mono whitespace-nowrap inline-flex items-center ${en.ok ? "text-fg/45 hover:text-fg hover:bg-fg/10" : "text-fg/30 opacity-60"}`}
      data-testid="transport-range-empty"
    >
      <Icon icon={SquareDashed} size={12} />
      {text}
    </button>
  );
}

function RangeChip({ fps }: { fps: Rational }) {
  const t = useT();
  useCommandTick();
  const range = useTimeline((s) => s.range);
  const pendingIn = useTimeline((s) => s.pendingIn);
  const pendingOut = useTimeline((s) => s.pendingOut);
  if (!range) return <EmptyRangeChip fps={fps} pendingIn={pendingIn} pendingOut={pendingOut} />;
  const len = range.out - range.in;
  // 縮放到範圍（view.zoomToRange）由範圍群組登記；還沒登記時退而求其次跳到入點
  const zoom = command("view.zoomToRange");
  return (
    <span className="h-6 pl-2 pr-0.5 rounded bg-accent/12 text-accent text-[11px] mono tabular-nums whitespace-nowrap inline-flex items-center gap-1" data-testid="transport-range">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (zoom ? void runCommand("view.zoomToRange", "toolbar") : usePlayback.getState().seek(range.in))}
        title={zoom ? t("縮放到範圍（Z）") : t("跳到入點")}
        className="hover:underline"
      >
        {shortTc(range.in, fps)}–{shortTc(range.out, fps)} · {t("{n} 幀", { n: len })}
      </button>
      <TButton id="playback.clearRange" glyph={<Icon icon={X} size={12} />} />
    </span>
  );
}

// ---- 速度 / 溢出選單 ----

/** 下拉選單按鈕要掛的屬性（展開到 <button> 上）。 */
interface MenuTriggerProps {
  onMouseDown: (e: ReactMouseEvent<HTMLElement>) => void;
  onClick: (e: ReactMouseEvent<HTMLElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
}

/**
 * 傳輸列的下拉選單（速度、⋯）。跟右鍵選單（ui/ContextMenu）守同一套鍵盤規矩（M1 驗收 L4）：
 * 1. 開啟時焦點進選單。按鈕為了不搶焦點在 mousedown 擋掉預設，焦點於是留在原處（通常是 body）——
 *    按鍵的目標不是選單：↑↓ 跳鏡頭、Space 切播放，選單自己反而收不到方向鍵。
 * 2. 選單裡的按鍵不往 window 冒泡：沒有這層，沒有反白列時的 Space、字母鍵（K 設關鍵幀）仍會打到全域快捷鍵。
 * 3. 關閉時焦點還給開選單前的元素（沒有就回 body），不停在按鈕上 —— 焦點在按鈕上的話，下一次 Space 會「按下按鈕」。
 * 4. 開著時再點同一顆按鈕是關閉：MenuPanel 在 window capture 的 mousedown 就先關了，
 *    接著同一次點擊的 click 不能把它又開回來（以前看起來像「關不掉、一直重開」）。
 */
function useMenu(): { trigger: (items: () => MenuItem[]) => MenuTriggerProps; element: ReactNode } {
  const [state, setState] = useState<{ anchor: MenuAnchor; items: MenuItem[] } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const openEl = useRef<HTMLElement | null>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const justClosed = useRef<HTMLElement | null>(null);
  const skipClick = useRef(false);

  const close = useCallback(() => {
    const back = prevFocus.current;
    prevFocus.current = null;
    justClosed.current = openEl.current;
    openEl.current = null;
    // 記號只給「同一次 mousedown」後面那個 click 用：下一個 task 就清掉（Esc / 選了項目關的不受影響）
    window.setTimeout(() => {
      justClosed.current = null;
    }, 0);
    const ae = document.activeElement;
    const focusInMenu = ae instanceof HTMLElement && !!wrapRef.current?.contains(ae);
    // 只在焦點還在選單裡（或掉到 body）時還回去：選了「跳到時間碼…」這種項目，輸入框自己要拿焦點
    if (back?.isConnected && (focusInMenu || ae === document.body)) back.focus({ preventScroll: true });
    else if (focusInMenu) ae.blur();
    setState(null);
  }, []);

  useLayoutEffect(() => {
    if (state) wrapRef.current?.querySelector<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true });
  }, [state]);

  const expanded = state !== null;
  const trigger = useCallback(
    (items: () => MenuItem[]): MenuTriggerProps => ({
      onMouseDown: (e) => {
        e.preventDefault();
        skipClick.current = justClosed.current === e.currentTarget;
      },
      onClick: (e) => {
        const el = e.currentTarget;
        // detail 0 ＝ 鍵盤（Enter / Space）觸發的 click，前面沒有 mousedown，不能沿用上一次滑鼠留下的記號
        const skip = skipClick.current && e.detail > 0;
        skipClick.current = false;
        if (skip) return;
        if (openEl.current === el) return close();
        const ae = document.activeElement;
        prevFocus.current = ae instanceof HTMLElement && ae !== document.body ? ae : null;
        openEl.current = el;
        setState({ anchor: { rect: el.getBoundingClientRect(), side: "bottom" }, items: items() });
      },
      "aria-haspopup": "menu",
      "aria-expanded": expanded,
    }),
    [close, expanded],
  );

  const element = state ? (
    // display: contents：包一層接鍵盤事件，但不在 flex 列上多出一格（gap 會讓後面的按鈕位移）
    <div ref={wrapRef} className="contents" onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()} data-testid="transport-menu">
      <MenuPanel anchor={state.anchor} items={state.items} onClose={close} />
    </div>
  ) : null;
  return { trigger, element };
}

/** 指令（含動態子選單）→ 選單項目；沒登記的略過。 */
function menuItemsOf(ids: string[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const id of ids) {
    if (id === "-") {
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
      continue;
    }
    const c = command(id);
    const it = c ? commandToMenuItem(c) : null;
    if (it) out.push(it);
  }
  return out;
}

function speedItems(): MenuItem[] {
  const c = command("playback.speed");
  return (c?.children?.() ?? []).map((k) => commandToMenuItem(k, { noShortcut: true })).filter((x): x is MenuItem => !!x);
}

function SpeedButton() {
  const t = useT();
  const rate = usePlayback((s) => s.rate);
  const menu = useMenu();
  return (
    <>
      <button
        type="button"
        {...menu.trigger(speedItems)}
        title={t("播放速度（轉盤作用中時由轉盤倍率決定）")}
        className={`h-7 px-1.5 rounded text-xs mono tabular-nums inline-flex items-center gap-0.5 whitespace-nowrap hover:bg-fg/10 ${rate !== 1 ? "text-accent" : "text-fg/65"}`}
        data-testid="transport-speed"
      >
        {rate}×
        <Icon icon={ChevronDown} size={12} />
      </button>
      {menu.element}
    </>
  );
}

// ---- 音量 ----

/**
 * 音量彈出框的位置：貼在按鈕正上方、水平置中，左右不超出視窗（「⋯」貼著視窗右緣時要往左收）。
 * 彈出框自己的下緣留了透明的 padding 接住按鈕：滑鼠直直往上移不會經過「兩者之外」而被判定離開。
 */
export function volumePopoverPos(anchor: { left: number; top: number; width: number }, size: { width: number; height: number }, viewportWidth: number, margin = 4): { left: number; top: number } {
  const center = anchor.left + anchor.width / 2;
  const left = Math.max(margin, Math.min(center - size.width / 2, viewportWidth - size.width - margin));
  return { left, top: Math.max(margin, anchor.top - size.height) };
}

/** 滑鼠離開後多久收起：斜著移向彈出框、或手抖出界一下，都不該馬上關掉。 */
const VOLUME_POPOVER_CLOSE_MS = 250;

function VolumeSlider({ disabled, onPointerDown }: { disabled: boolean; onPointerDown?: () => void }) {
  const t = useT();
  const volume = usePlayback((s) => s.volume);
  const muted = usePlayback((s) => s.muted);
  const pct = Math.round(volume * 100);
  return (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={muted || volume === 0 ? 0 : pct}
      disabled={disabled}
      aria-label={t("音量")}
      title={`${t("音量")} ${pct}%`}
      onChange={(e) => usePlayback.getState().setVolume(Number(e.target.value) / 100)}
      onPointerDown={onPointerDown}
      // 放開就交還焦點：滑桿是 <input>，焦點留著的話全域快捷鍵（Space、←→）會一直讓路
      onPointerUp={(e) => e.currentTarget.blur()}
      className="w-20 h-1 accent-accent disabled:opacity-40"
      data-testid="transport-volume"
    />
  );
}

/**
 * 靜音鈕 + 音量。列夠寬時滑桿直接放在列上；預設視窗寬度下影片欄只有約 760 px、滑桿放不下（M1 驗收 M3），
 * 改成滑過靜音鈕（或用 Tab 把焦點移到它上面）時在正上方彈出滑桿 —— YouTube / Premiere 檢視器的做法。
 * 點靜音鈕仍然是切換靜音，不改成「點開」：那是所有播放器的肌肉記憶，而且快捷鍵說明、命令面板都是同一個指令。
 */
/**
 * 滑過就彈出的小面板（音量）：開關、定位、離開後延遲收起、拖曳中不收、鍵盤焦點在裡面不收。
 * `enabled` 變 false（列變寬、滑桿回到列上，或沒有音軌了）就收掉。
 */
function useHoverPopover(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const dragging = useRef(false);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  // 拖滑桿拖到框外、或焦點還在滑桿上（鍵盤調音量）時不收
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (hovering.current || dragging.current || popRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, VOLUME_POPOVER_CLOSE_MS);
  }, [cancelClose]);
  const onDragStart = useCallback(() => {
    dragging.current = true;
    // 放開的位置可能在框外（滑桿本身收不到 pointerup），掛在 window 上收尾
    window.addEventListener(
      "pointerup",
      () => {
        dragging.current = false;
        if (!hovering.current) scheduleClose();
      },
      { once: true, capture: true },
    );
  }, [scheduleClose]);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  useEffect(() => cancelClose, [cancelClose]);
  // 先畫再量：寬度跟語言、百分比字寬有關；量到之前不顯示（避免在左上角閃一下）
  useLayoutEffect(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    const p = popRef.current?.getBoundingClientRect();
    setPos(open && a && p ? volumePopoverPos(a, p, window.innerWidth) : null);
  }, [open]);
  // 視窗縮放時位置就不對了：直接收起（跟選單一樣）
  useEffect(() => {
    if (!open) return;
    const off = () => setOpen(false);
    window.addEventListener("resize", off);
    return () => window.removeEventListener("resize", off);
  }, [open]);

  const anchorProps = {
    ref: anchorRef,
    onMouseEnter: () => {
      hovering.current = true;
      cancelClose();
      if (enabled) setOpen(true);
    },
    onMouseLeave: () => {
      hovering.current = false;
      scheduleClose();
    },
    // 鍵盤使用者：Tab 到靜音鈕就彈出，再 Tab 進滑桿；焦點離開整組才收
    onFocus: () => {
      if (enabled) setOpen(true);
    },
    onBlur: (e: React.FocusEvent<HTMLSpanElement>) => {
      if (!anchorRef.current?.contains(e.relatedTarget as Node | null)) scheduleClose();
    },
  };
  const popoverProps = {
    ref: popRef,
    style: pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" as const },
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Escape") return;
      // 不讓全域 Esc（清除選取）順便觸發：使用者只是想關這個小面板
      e.stopPropagation();
      if (e.target instanceof HTMLElement) e.target.blur();
      setOpen(false);
    },
  };
  return { open: open && enabled, anchorProps, popoverProps, onDragStart };
}

/**
 * 靜音鈕 + 音量。列夠寬時滑桿直接放在列上；預設視窗寬度下影片欄只有約 760 px、滑桿放不下（M1 驗收 M3），
 * 改成滑過靜音鈕（或用 Tab 把焦點移到它上面）時在正上方彈出滑桿 —— YouTube / Premiere 檢視器的做法。
 * 點靜音鈕仍然是切換靜音，不改成「點開」：那是所有播放器的肌肉記憶，而且快捷鍵說明、命令面板都是同一個指令。
 */
function VolumeControl({ slider }: { slider: boolean }) {
  const t = useT();
  const volume = usePlayback((s) => s.volume);
  const muted = usePlayback((s) => s.muted);
  const en = useEnabled(command("playback.toggleMute"));
  const silent = muted || volume === 0;
  const pct = Math.round(volume * 100);
  const pop = useHoverPopover(!slider && en.ok);
  return (
    <span className="flex items-center gap-1 shrink-0" {...pop.anchorProps}>
      <TButton id="playback.toggleMute" icon={silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2} label={muted ? t("取消靜音") : t("靜音")} active={muted} />
      {slider && <VolumeSlider disabled={!en.ok} />}
      {pop.open && (
        // 外層的 pb-1.5 是透明的橋：彈出框下緣直接貼著按鈕，滑鼠往上移不會先「離開」再「進入」
        <div role="group" aria-label={t("音量")} className="fixed z-50 pb-1.5" {...pop.popoverProps} data-testid="transport-volume-popover">
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-elevated border border-fg/10 shadow-e3">
            <VolumeSlider disabled={false} onPointerDown={pop.onDragStart} />
            <span className="w-9 text-right mono text-[11px] tabular-nums text-fg/60">{silent ? 0 : pct}%</span>
          </div>
        </div>
      )}
    </span>
  );
}

// ---- 媒體晶片 ----

const CODEC_LABEL: Record<string, string> = { h264: "H.264", hevc: "HEVC", vp9: "VP9", vp8: "VP8", av1: "AV1", prores: "ProRes", mpeg4: "MPEG-4" };

function MediaChip() {
  const t = useT();
  useCommandTick();
  const media = useActiveMedia();
  const v = media?.probe?.video ?? null;
  const px = media?.proxy ?? null;
  if (!v && !px) return null;
  const w = v?.width ?? px?.width ?? 0;
  const h = v?.height ?? px?.height ?? 0;
  const fps = px?.fps ?? v?.r_frame_rate ?? null;
  const parts = [`${w}×${h}`, fps && fps.num > 0 ? `${fpsLabel(fps)}p` : null, v ? CODEC_LABEL[v.codec] ?? v.codec.toUpperCase() : null].filter(Boolean).join(" · ");
  // 媒體資訊分頁（view.mediaInfo）由資訊群組登記；還沒有時晶片只是標籤
  const info = command("view.mediaInfo");
  const cls = "h-6 px-2 rounded text-[11px] mono whitespace-nowrap text-fg/50 inline-flex items-center";
  if (!info) return <span className={cls}>{parts}</span>;
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void runCommand("view.mediaInfo", "toolbar")} title={t("媒體資訊（Ctrl+I）")} className={`${cls} hover:bg-fg/10 hover:text-fg`}>
      {parts}
    </button>
  );
}

// ---- 本體 ----

/** 列上放不下、收進「⋯」的指令（"-" 是分隔線）。 */
function overflowIds(L: TransportLayout): string[] {
  const ids: string[] = [];
  if (!L.outer) ids.push("playback.home", "playback.stop", "playback.end", "-");
  if (!L.shots) ids.push("playback.prevShot", "playback.nextShot");
  if (!L.fine) ids.push("playback.prevKeyframe", "playback.nextKeyframe", "playback.stepBack10", "playback.stepFwd10");
  ids.push("-");
  if (!L.marks) ids.push("playback.markIn", "playback.markOut");
  if (!L.range) ids.push("playback.playSelection", "playback.playRange", "playback.loop", "playback.clearRange");
  ids.push("-", "playback.gotoTimecode");
  return ids;
}

export default function Transport() {
  const t = useT();
  const media = useActiveMedia();
  const proxy = media?.proxy ?? null;
  const fps = proxy?.fps ?? EMPTY_FPS;
  const frames = proxy?.frames ?? 0;
  const barRef = useRef<HTMLDivElement>(null);
  const L = transportLayout(useBarWidth(barRef));
  const playing = usePlayback((s) => s.playing);
  const shuttle = usePlayback((s) => s.shuttle);
  const rangePlaying = usePlayback((s) => s.loop !== null);
  const loopOn = useTimeline((s) => s.loopRange);
  const more = useMenu();
  const moving = playing || shuttle.dir !== 0;
  const overflow = !(L.time && L.outer && L.range && L.marks && L.shots && L.fine);

  return (
    <div ref={barRef} role="toolbar" aria-label={t("播放控制")} className="h-9 shrink-0 flex items-center gap-0.5 px-1.5 bg-panel border-t border-fg/10 min-w-0 overflow-hidden" data-testid="transport">
      {L.outer && <TButton id="playback.home" icon={SkipBack} />}
      {L.shots && <TButton id="playback.prevShot" icon={ChevronFirst} />}
      {L.fine && <TButton id="playback.prevKeyframe" glyph={<KeyframeGlyph dir={-1} />} />}
      {L.fine && <TButton id="playback.stepBack10" icon={ChevronsLeft} />}
      <TButton id="playback.stepBack" icon={ChevronLeft} />
      <TButton id="playback.shuttleBack" icon={Rewind} label={t("倒退轉盤（再按加速；倒退沒有聲音）")} keys="J" active={shuttle.dir < 0} />
      <TButton id="playback.toggle" icon={moving ? Pause : Play} label={moving ? t("暫停") : t("開始播放")} big />
      <TButton id="playback.shuttleFwd" icon={FastForward} label={t("前進轉盤（再按加速 1× / 2× / 4×）")} keys="L" active={shuttle.dir > 0} />
      {L.outer && <TButton id="playback.stop" icon={Square} />}
      <TButton id="playback.stepFwd" icon={ChevronRight} />
      {L.fine && <TButton id="playback.stepFwd10" icon={ChevronsRight} />}
      {L.fine && <TButton id="playback.nextKeyframe" glyph={<KeyframeGlyph dir={1} />} />}
      {L.shots && <TButton id="playback.nextShot" icon={ChevronLast} />}
      {L.outer && <TButton id="playback.end" icon={SkipForward} />}
      {shuttle.dir !== 0 && (
        <span
          className={`h-6 px-1.5 ml-1 rounded text-[11px] mono tabular-nums inline-flex items-center whitespace-nowrap shrink-0 ${shuttle.dir < 0 ? "bg-warning/15 text-warning" : "bg-accent/15 text-accent"}`}
          title={shuttle.dir < 0 ? t("倒退轉盤：只移動播放線，沒有聲音") : t("前進轉盤")}
          data-testid="transport-shuttle"
        >
          {/* 倒退沒有聲音要寫在看得到的地方：只放 tooltip 的話，一直往回找位置的人第一個念頭是「壞了」（ai-music-cut） */}
          {shuttleLabel(shuttle)}
          {shuttle.dir < 0 && <span className="ml-1 opacity-70">{t("（靜音）")}</span>}
        </span>
      )}
      {L.time && (
        <>
          <Sep />
          <TimecodeField fps={fps} frames={frames} total={L.total} />
        </>
      )}
      {L.range && (
        <>
          <Sep />
          {L.marks && <TButton id="playback.markIn" glyph={<BracketGlyph ch="{" />} />}
          {L.marks && <TButton id="playback.markOut" glyph={<BracketGlyph ch="}" />} />}
          <RangeChip fps={fps} />
          {/* 播放選取（/）：選了片段就播那一段，沒選就照範圍／整條。暫態播放，所以不會點亮右邊的「播放範圍」 */}
          <TButton id="playback.playSelection" icon={CirclePlay} />
          <TButton id="playback.playRange" icon={ListVideo} active={rangePlaying} />
          <TButton id="playback.loop" icon={Repeat} active={loopOn} />
          <SpeedButton />
        </>
      )}
      <span className="flex-1 min-w-1" />
      <VolumeControl slider={L.fine} />
      {L.chip && <MediaChip />}
      {overflow && (
        <>
          <button
            type="button"
            {...more.trigger(() => [...menuItemsOf(overflowIds(L)), ...(L.range ? [] : [{ separator: true }, { label: t("播放速度"), children: speedItems }])])}
            title={t("更多播放控制")}
            aria-label={t("更多播放控制")}
            className={`w-7 h-7 ${btnBase} text-fg/60 hover:text-fg hover:bg-fg/10`}
            data-testid="transport-more"
          >
            <Icon icon={Ellipsis} size={15} />
          </button>
          {more.element}
        </>
      )}
    </div>
  );
}
