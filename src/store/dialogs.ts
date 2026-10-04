import { create } from "zustand";
import type { Quad, TrackDataFormat } from "../project/format";
import type { FrameRange } from "./timeline";

/**
 * 對話框開合狀態。不持久化、不進 undo、不進專案檔 —— 關掉 App 就沒了。
 *
 * ai-music-cut 以前是 App.tsx 裡 22 個 useState boolean 加上 Toolbar 的 41 個 props：
 * 每個對話框都要在三個地方登記（state、開啟 callback、JSX）。
 * 這裡是「id + props 的堆疊」，開對話框的人（指令、按鈕、別的對話框）只要 `open("export")`，
 * 掛載交給 DialogHost。id 集合見計畫 §9「對話框」。
 */

/** 開設定時要把焦點 / 高亮放在哪一段。 */
export type SettingsFocus = "ffmpeg" | "engine" | "output" | "cache" | null;

/** 核心的對話框；外掛的對話框由外掛登記（plugins/api.ts dialogs），id 是字串。 */
export type CoreDialogId =
  | "settings"
  | "about"
  | "shortcuts"
  | "palette"
  | "engineSetup"
  // App 自動更新：新版本、這一版的說明、下載進度（src/updater/）
  | "update"
  | "export"
  | "exportTrackData"
  | "newTrack"
  | "trackOptions"
  | "insertOptions"
  | "mediaInfo"
  // M2.17 序列設定（防爆音淡化、限幅器、預設淡化長度）
  | "sequenceSettings"
  // 移除靜音（對標 Descript / CapCut）：套用前先預覽會剪掉幾段
  | "removeSilence"
  // 移除語助詞（文字稿剪輯）：依字幕逐字時間碼剪，逐段勾選
  | "removeFillers"
  // 移除物件：用其他幀真正拍到的畫面補回背景
  | "removeObject"
  // 背景虛化 / 換色（人像模式）：主體留著，背景糊掉
  | "blurBackground"
  // 轉成直幅／方形：對任何一支影片做自動重構圖（不需要專案）
  | "reframeVideo"
  // AI 章節與摘要：從字幕整理出章節標記、摘要與 YouTube 章節文字
  | "chapters"
  // AI 精華片段：從字幕挑出最值得單獨拿出來的幾段（短影音候選）
  | "highlights"
  // AI 配音：文字轉語音（Seal-TTS），放到播放線的音軌
  | "tts"
  // 找物件（通用物件）：文字 → seg.find → 勾選實例 → 物件 track
  | "findObject";

export type DialogId = CoreDialogId | (string & {});

/** 有參數的對話框；沒列在這裡的就是沒有參數。 */
export interface DialogPropMap {
  settings: { focus?: SettingsFocus };
  /** 首次引導：`autoStart` = 開了就直接開始安裝（SetupBanner 的「安裝」按鈕）。 */
  engineSetup: { autoStart?: boolean };
  /** `range` = 只輸出這一段（時間軸 in/out）；null = 整支。 */
  export: { range?: FrameRange | null };
  exportTrackData: { format?: TrackDataFormat; trackId?: string };
  /** 在 frame 新建 track；`quad` 是拖出來的框、`fromMask` = 用遮罩取角（A2）。 */
  newTrack: { frame: number; quad?: Quad; fromMask?: boolean };
  trackOptions: { trackId: string };
  insertOptions: { trackId: string };
  palette: { query?: string };
  /** 要看哪支媒體；省略 = 作用中的（媒體清單右鍵可以看非作用中的那支，不必先切過去）。 */
  mediaInfo: { mediaId?: string };
  /** 預填的文字（助手「幫我唸一段…」）；省略 = 播放線上的字幕那句。 */
  tts: { text?: string };
  /** text = 預填的字；autoRun = 開了就直接找（開始畫面、隱私打碼）；intent = 找完之後要做什麼（objects/actions.ts FindIntent）。 */
  findObject: { text?: string; autoRun?: boolean; intent?: "track" | "privacy" };
}

/** 有參數的核心對話框照 DialogPropMap；沒列的核心對話框沒有參數；外掛的對話框參數由外掛自己定（Record）。 */
export type DialogProps<K extends DialogId> = K extends keyof DialogPropMap ? DialogPropMap[K] : K extends CoreDialogId ? Record<string, never> : Record<string, unknown>;

export interface DialogEntry {
  id: DialogId;
  props: Record<string, unknown>;
  /** 每次 open 都遞增：重開 = 重新掛載（狀態歸零），和以前 `{open && <X/>}` 的行為一樣。 */
  key: number;
}

interface DialogsStore {
  stack: DialogEntry[];
  open: <K extends DialogId>(id: K, props?: DialogProps<K>) => void;
  close: (id: DialogId) => void;
  closeTop: () => void;
  closeAll: () => void;
  isOpen: (id: DialogId) => boolean;
}

let seq = 1;

export const useDialogs = create<DialogsStore>((set, get) => ({
  stack: [],
  open: (id, props) => {
    set((s) => {
      const rest = s.stack.filter((e) => e.id !== id);
      const prev = s.stack.find((e) => e.id === id);
      // 已經開著：同樣的 props → 移到最上層、保留 key（不重掛，使用者填一半的東西不會消失）；
      // props 不同（另一條 track、另一段範圍）→ 換 key 重掛，不然對話框抱著開啟當下定下來的舊參數
      const nextProps = (props ?? {}) as Record<string, unknown>;
      const same = prev != null && JSON.stringify(prev.props) === JSON.stringify(nextProps);
      const entry: DialogEntry = { id, props: nextProps, key: prev && same ? prev.key : seq++ };
      return { stack: [...rest, entry] };
    });
  },
  close: (id) => set((s) => (s.stack.some((e) => e.id === id) ? { stack: s.stack.filter((e) => e.id !== id) } : s)),
  closeTop: () => set((s) => ({ stack: s.stack.slice(0, -1) })),
  closeAll: () => set({ stack: [] }),
  isOpen: (id) => get().stack.some((e) => e.id === id),
}));

/** 給指令 / 非 React 程式碼用的捷徑。 */
export function openDialog<K extends DialogId>(id: K, props?: DialogProps<K>): void {
  useDialogs.getState().open(id, props);
}

export function closeDialog(id: DialogId): void {
  useDialogs.getState().close(id);
}

export function isDialogOpen(id: DialogId): boolean {
  return useDialogs.getState().isOpen(id);
}

/**
 * 開「媒體資訊」（指令 `media.info`、媒體清單右鍵、狀態列點擊共用這一個入口）。
 * 不傳 mediaId 時**不寫進 props**：DialogHost 會把作用中的 mediaId 餵進去；寫成 `{ mediaId: undefined }`
 * 的話展開 props 會把它蓋成 undefined。
 */
export function openMediaInfo(mediaId?: string | null): void {
  openDialog("mediaInfo", mediaId ? { mediaId } : {});
}
