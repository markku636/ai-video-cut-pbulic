import { create } from "zustand";
import { api, decodeJson, type MediaProbe, type ProxyMeta } from "../api";
import { APP_NAME } from "../brand";
import { buildProjectFile, EXPORT_DEFAULTS, INSERT_DEFAULTS, type AudioMediaV2, type AudioRole, type ExportDefaultsV1, type InsertDefaultsV1, type Profile, type ProjectMediaV2 } from "../project/format";
import type { PluginMediaState } from "../plugins/api";
import { migrate } from "../project/migrate";
import { parseProjectFile, type ParsedProject } from "../project/sanitize";
import { addAudioClip, addLane, nextClipId } from "../sequence/ops";
import { SEQ_EDIT_LABEL, useEdits } from "./edits";
import { useMasks } from "./masks";
import { useSolves } from "./solves";
import { useProjectExtras } from "./projectExtras";
import { readProjectExtras, withProjectExtras } from "../project/extras";
import { defaultProfileId } from "../project/profiles";
import { plugins } from "../plugins/registry";

/**
 * 專案層狀態：媒體清單、作用中的媒體、專案檔路徑 / dirty、profile、插入與輸出預設。
 * 向量狀態（鏡頭 / track / 外掛的狀態）在 store/edits.ts（有 undo）；存檔時從那邊收回來。
 *
 * `proxyState`：`none` 還沒建 / `building` 引擎在跑 / `ready` 可播 / `stale` 快取有 proxy.mp4 但中繼資料對不上（重生）
 * / `error`。**引擎未就緒時也照樣 probe + 指紋**（計畫 §9 Start Screen）：清單先出現，SetupBanner 再擋開影片。
 */
export type ProxyState = "none" | "building" | "ready" | "stale" | "error";

/**
 * v2 形狀（多一個可省略的 `audio`，media.audio_info 的結果）：讀檔時 sanitize 留下的 audio 要一路帶到存檔，
 * 不然自動存檔一次就把算好的音訊時間資訊洗掉。
 */
export interface MediaItem extends ProjectMediaV2 {
  proxyState: ProxyState;
  error?: string;
}

/** 純音訊媒體的 id：「a-」＋指紋前 16 碼（format.ts AudioMediaV2.id 的規則；同一支 mp4 當影片與當音樂時 id 不撞）。 */
export function audioMediaIdOf(fingerprint: string): string {
  return `a-${fingerprint.trim().slice(0, 16).toLowerCase()}`;
}

/** probeAudio 的結果：`existing` = 這個檔案（同指紋）已經在音訊清單裡，item 就是清單裡那一份。 */
export interface ProbedAudio {
  item: AudioMediaV2;
  existing: boolean;
}

/** 把音訊媒體放上音軌的規格（M2.14）。 */
export interface AudioPlaceSpec {
  /** 第一段的起點（序列樣本）；多段依序接在前一段後面（Premiere 一次拖多個檔的行為）。 */
  atSample: number;
  /** 指定的音軌；null = 依角色找軌、放不下就開新軌（sequence/audioOps addAudioClip 的規則）。 */
  laneId: string | null;
  /** true = 先開一條新音軌再放（拖到「把音訊檔拖到這裡新增音軌」放置區）。 */
  newLane?: boolean;
  /** 沒有 audio_info 的媒體用的片段長度（序列樣本），key = audioId；兩者都沒有的媒體只進清單、不放上音軌。 */
  lengths?: Readonly<Record<string, number>>;
}

export interface AddAudioResult {
  /** 有沒有留下一筆 undo。 */
  committed: boolean;
  /** 放上音軌的片段 id（依 items 順序；沒放的不列）。 */
  clipIds: string[];
}

interface ProjectStore {
  path: string | null;
  dirty: boolean;
  /**
   * 編輯計數：每個會讓專案 dirty 的變更都 +1（已經 dirty 也照加）。saveTo 記下開始時的 rev，寫完只有 rev 沒變
   * 才標已儲存（存檔途中的編輯留在 dirty）；自動儲存訂閱它才知道「又改了」。只增不減，換專案也不歸零。
   */
  rev: number;
  createdAt: string | null;
  media: MediaItem[];
  activeMediaId: string | null;
  profile: Profile;
  insertDefaults: InsertDefaultsV1;
  exportDefaults: ExportDefaultsV1;
  /** 上次載入時 sanitize 丟掉幾筆（toast 用；null = 沒丟）。 */
  lastReport: ParsedProject["report"] | null;

  /** 開檔加進清單。`activate: false` = 只加進清單、不切 active。 */
  openMedia: (path: string, opts?: { activate?: boolean }) => Promise<string>;
  setActive: (id: string | null) => void;
  updateMedia: (id: string, patch: Partial<MediaItem>) => void;
  /**
   * 從專案移除媒體（連同它的追蹤資料與序列片段）。回傳 `historyCleared`：true = 整個復原歷史被清掉
   * （規則見 store/edits.ts historyAfterRemoval），呼叫端要 toast `t(HISTORY_CLEARED_NOTICE)`。
   */
  removeMedia: (id: string) => { historyCleared: boolean };
  /** 依快取目錄的狀況更新 proxy / proxyState（開檔、引擎跑完 media.proxy 之後）。 */
  refreshProxy: (id: string) => Promise<void>;
  setProfile: (p: Profile) => void;
  setInsertDefaults: (d: InsertDefaultsV1) => void;
  setExportDefaults: (d: ExportDefaultsV1) => void;
  markDirty: () => void;
  newProject: () => void;
  /** migrate → parse（含 sanitize）→ 放進 project + edits。 */
  loadFrom: (path: string) => Promise<ParsedProject>;
  /**
   * 寫專案檔（見 `enqueueWrite`：一次一筆、依呼叫順序）。在別筆寫入進行中呼叫、而前面那筆已經把目前這一版
   * 寫進同一個檔 → 不再重寫（多個呼叫併成一次補存）。寫完 rev 沒變才清 dirty。
   */
  saveTo: (path?: string) => Promise<string>;
  /**
   * 把目前狀態寫到任意路徑但**不**改 path / dirty（給引擎 op 讀的暫存專案檔；`cards.identify` / `render.*` /
   * `export.track` 都吃專案檔路徑）。使用者的專案檔位置與「未儲存」狀態不受影響。跟 saveTo 排同一條隊，
   * 輪到它時才取狀態（拿到的是最新的）。
   */
  writeSnapshot: (path: string) => Promise<void>;

  // ---- 音訊媒體匯入（M2.14；清單本身在 store/edits.ts audioMedia，有 undo）----
  /**
   * probe＋指紋 → AudioMediaV2（**不** commit）。同指紋已在清單裡 → 回清單那一份（existing）。
   * 沒有音軌的檔也照樣回（probe.audio === null），由呼叫端決定怎麼跟使用者講；role 預設 other，呼叫端可以換成猜的角色。
   */
  probeAudio: (path: string, opts?: { role?: AudioRole }) => Promise<ProbedAudio>;
  /**
   * 把音訊媒體加進清單，`place` 給了就在**同一筆 undo** 裡放上音軌（一次 Ctrl+Z 同時拿掉片段與新加入的清單項目，§13 M2.14）。
   * - 已在清單裡的 item 不重複加；只放片段。
   * - 放得上的條件：item.audio（引擎 audio_info）或 place.lengths[id]；都沒有的只進清單。
   * - 序列是 null（隱含）時照 editSequence 的規則先實體化；實體化失敗（沒有作用中媒體 / proxy 還沒好）擲 SequenceError，狀態不變。
   */
  addAudioMedia: (items: readonly AudioMediaV2[], place?: AudioPlaceSpec | null) => AddAudioResult;
}

/**
 * 專案檔寫入一次一筆（saveTo / writeSnapshot 共用）。兩筆 `project_save` 同時在 Rust 跑的話，誰先落地沒有保證：
 * 自動儲存 + Ctrl+S、自動儲存 + projectFileFor（匯出 / 辨識前）都可能讓舊的那份最後蓋上去。
 */
let writeQueue: Promise<unknown> = Promise.resolve();
let queuedWrites = 0;
/** 換專案（newProject / loadFrom）+1：排在舊專案後面的存檔不可把新專案寫進舊路徑，寫完也不可把 path 改回舊的。 */
let projectEpoch = 0;
/** 上一次成功寫進使用者專案檔的是哪一版（併掉重複的排隊存檔用）。 */
let lastWritten: { epoch: number; path: string; rev: number } | null = null;
function enqueueWrite<T>(job: () => Promise<T>): Promise<T> {
  queuedWrites++;
  const run = writeQueue.then(job).finally(() => {
    queuedWrites--;
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** 快取裡的 proxy.v1.json → ProxyMeta（引擎沒寫 path，這裡用快取目錄補）。壞掉回 null（= stale）。 */
export async function readProxyMeta(fingerprint: string, cacheDir: string): Promise<ProxyMeta | null> {
  try {
    const raw = decodeJson<Record<string, unknown>>(await api.cacheRead(fingerprint, "proxy.v1.json"));
    const fps = raw.fps as { num?: unknown; den?: unknown } | undefined;
    if (!fps || typeof fps.num !== "number" || typeof fps.den !== "number" || typeof raw.frames !== "number" || typeof raw.width !== "number" || typeof raw.height !== "number") return null;
    const sep = cacheDir.includes("\\") ? "\\" : "/";
    return {
      version: 1,
      fps: { num: fps.num, den: fps.den },
      frames: raw.frames,
      width: raw.width,
      height: raw.height,
      scale: typeof raw.scale === "number" && raw.scale > 0 ? raw.scale : 1,
      path: `${cacheDir.replace(/[\\/]+$/, "")}${sep}proxy.mp4`,
    };
  } catch {
    return null;
  }
}

export const useProject = create<ProjectStore>((set, get) => ({
  path: null,
  dirty: false,
  rev: 0,
  createdAt: null,
  media: [],
  activeMediaId: null,
  // 外掛多半還沒登記（外掛 import 核心，核心先建好）：登記之後 plugins/init.ts 會換成外掛宣告的預設工作模式
  profile: defaultProfileId(),
  insertDefaults: INSERT_DEFAULTS,
  exportDefaults: EXPORT_DEFAULTS,
  lastReport: null,

  openMedia: async (path, opts) => {
    const activate = opts?.activate !== false;
    const existing = get().media.find((m) => m.path === path);
    if (existing) {
      if (activate) set({ activeMediaId: existing.id });
      return existing.id;
    }
    const probe: MediaProbe = await api.mediaProbe(path);
    const id = probe.fingerprint.slice(0, 16);
    const dup = get().media.find((m) => m.id === id);
    if (dup) {
      if (activate) set({ activeMediaId: dup.id });
      return dup.id;
    }
    const item: MediaItem = { id, path, name: fileName(path), fingerprint: probe.fingerprint, probe, proxy: null, proxyState: "none" };
    set((s) => ({ media: [...s.media, item], ...(activate ? { activeMediaId: id } : {}), dirty: true, rev: s.rev + 1 }));
    void get().refreshProxy(id);
    return id;
  },
  // activeMediaId 會寫進專案檔：不 +rev 的話，排在後面的存檔會被 saveTo 的 rev 去重當成「這一版已經寫過了」而跳過。
  // 不設 dirty：切換分頁本身不值得觸發自動儲存，下一次存檔會順便帶上。
  setActive: (id) => set((s) => (s.activeMediaId === id ? s : { activeMediaId: id, rev: s.rev + 1 })),
  updateMedia: (id, patch) =>
    set((s) => {
      const media = s.media.map((m) => (m.id === id ? { ...m, ...patch } : m));
      const before = s.media.find((m) => m.id === id);
      const after = media.find((m) => m.id === id);
      // proxyState / error 只在記憶體裡；proxy 等欄位會寫進專案檔 → 真的變了才算一筆編輯（refreshProxy 在載入後
      // 對每個媒體都會跑一次，內容相同時不可以讓剛開的專案變成「未儲存」）
      const persistedChanged = !!before && !!after && JSON.stringify(persistedMedia(before)) !== JSON.stringify(persistedMedia(after));
      return persistedChanged ? { media, dirty: true, rev: s.rev + 1 } : { media };
    }),
  removeMedia: (id) => {
    const s = get();
    const removed = s.media.find((m) => m.id === id);
    // 解算 / 遮罩快取跟著清；edits 的歷史也清掉（不然 undo 會把一條指向不存在媒體的 track 變回來）
    const trackIds = (useEdits.getState().tracks[id] ?? []).map((t) => t.id);
    useSolves.getState().clearMedia(trackIds);
    for (const tid of trackIds) useMasks.getState().clearTrack(tid);
    // 一定要在媒體從清單拿掉**之前**：clear 要用它的音訊資訊波紋切開同步鎖軌上的片段
    const historyCleared = useEdits.getState().clear(id);
    set((st) => {
      const media = st.media.filter((m) => m.id !== id);
      return {
        media,
        activeMediaId: st.activeMediaId === id ? media[0]?.id ?? null : st.activeMediaId,
        dirty: st.dirty || !!removed,
        // 媒體清單寫進專案檔：移除也要 +rev，否則存檔去重會吃掉這一筆
        rev: removed ? st.rev + 1 : st.rev,
      };
    });
    return { historyCleared };
  },
  refreshProxy: async (id) => {
    const m = get().media.find((x) => x.id === id);
    if (!m) return;
    try {
      const st = await api.mediaCacheStatus(m.id);
      if (!st.proxy) {
        if (m.proxyState !== "building") get().updateMedia(id, { proxy: null, proxyState: "none" });
        return;
      }
      const meta = await readProxyMeta(m.id, st.dir);
      get().updateMedia(id, meta ? { proxy: meta, proxyState: "ready" } : { proxy: null, proxyState: "stale" });
    } catch {
      /* 非 Tauri 環境：維持原狀 */
    }
  },
  setProfile: (profile) => set((s) => (s.profile === profile ? s : { profile, dirty: true, rev: s.rev + 1 })),
  setInsertDefaults: (insertDefaults) => set((s) => ({ insertDefaults, dirty: true, rev: s.rev + 1 })),
  setExportDefaults: (exportDefaults) => set((s) => ({ exportDefaults, dirty: true, rev: s.rev + 1 })),
  // 已經 dirty 也要 +rev：存檔途中的編輯靠它留在未儲存，自動儲存靠它重新計時
  markDirty: () => set((s) => ({ dirty: true, rev: s.rev + 1 })),
  newProject: () => {
    useEdits.getState().reset();
    useProjectExtras.getState().reset();
    // 外掛自己的 session 也要清（例如牌外掛的牌局 session，不然「新專案」之後還留在上一個專案的模式）
    for (const p of plugins()) p.lifecycle?.newProject?.();
    useSolves.getState().clearMedia(Object.values(useSolves.getState().byTrack).map((s) => s.trackId));
    useMasks.getState().clearAll();
    projectEpoch++;
    set({ path: null, dirty: false, createdAt: null, media: [], activeMediaId: null, profile: defaultProfileId(), insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS, lastReport: null });
  },

  loadFrom: async (path) => {
    const raw = await api.projectLoad(path);
    // 先升版再驗內容：migrate 只搬形狀、sanitize 才丟壞資料（計畫 §5.6）
    const { doc } = migrate(raw);
    const parsed = parseProjectFile(doc);
    // 外掛先看一眼（例如牌外掛：換專案 = 換牌局，清 session；正規化空白牌的原牌），再收核心的 extras（不標 dirty）
    for (const p of plugins()) p.project?.onLoad?.(doc, parsed);
    useProjectExtras.getState().load(readProjectExtras(doc, parsed.report));
    const f = parsed.file;
    const edits = useEdits.getState();
    edits.reset();
    for (const m of f.media) edits.load(m.id, { shots: f.shots[m.id], tracks: f.tracks[m.id], pluginMedia: f.plugin.media[m.id], captions: f.captions?.[m.id] ?? null });
    edits.loadPluginProject(f.plugin.project);
    // v1 檔（或序列整條壞掉被 sanitize 丟掉）→ null / []：隱含序列，存回去仍寫 schemaVersion 1（§4.3）
    edits.loadSequence(f.sequence, f.audioMedia);
    useMasks.getState().clearAll();
    projectEpoch++;
    set({
      path,
      dirty: false,
      createdAt: f.createdAt,
      media: f.media.map((m) => ({ ...m, proxyState: m.proxy ? "ready" : "none" })),
      activeMediaId: f.activeMediaId,
      profile: f.profile,
      insertDefaults: f.insertDefaults,
      exportDefaults: f.exportDefaults,
      lastReport: parsed.report.total ? parsed.report : null,
    });
    // 專案檔裡的 proxy 中繼資料可能已經跟快取對不上（快取被清 / 換機器）：逐一對一次
    for (const m of f.media) void get().refreshProxy(m.id);
    return parsed;
  },

  saveTo: async (path) => {
    const target = path ?? get().path;
    if (!target) throw new Error("未指定專案檔路徑");
    const epoch = projectEpoch;
    const behindAnother = queuedWrites > 0;
    // **排隊當下就定版**：等輪到自己時才 buildDoc 的話，中途 loadFrom / newProject 會讓這筆變成「把新專案的內容
    // 寫進舊路徑」；為了擋那個而在輪到時 return，又會安靜丟掉最後 2 秒的編輯（B-02 審查）。先定版兩個問題都沒有。
    const rev = get().rev;
    const doc = withProjectExtras(buildDoc(), useProjectExtras.getState().extras);
    return enqueueWrite(async () => {
      // 前面那筆已經把**這一版**寫上去了（連按兩下 Ctrl+S、中間沒有任何編輯）→ 不重寫。
      // 排隊當下的 rev 已經定死，所以這個比較是「我這份內容在不在磁碟上」，不再是「現在的狀態變了沒」。
      const w = lastWritten;
      if (!(behindAnother && w && w.epoch === epoch && w.path === target && w.rev === rev)) {
        await api.projectSave(target, doc);
        lastWritten = { epoch, path: target, rev };
      }
      // 已經換專案：檔案照寫（那是舊專案的內容、舊專案的路徑），但不可以把 path / dirty 改回舊專案的
      if (epoch !== projectEpoch) return target;
      // 存檔途中又改了（rev 變了）→ 那些編輯不在這份檔裡，維持未儲存
      set((s) => ({ path: target, createdAt: doc.createdAt, dirty: s.rev !== rev }));
      return target;
    });
  },

  writeSnapshot: (path) => {
    // 同上：排隊當下定版。輪到時才取狀態的話，排在別筆寫入後面的快照會把**換過之後**那個專案的內容
    // 寫進舊媒體的暫存檔，引擎 op（render.run / cards.identify / captions.layout）就對著另一個專案跑。
    const doc = withProjectExtras(buildDoc(), useProjectExtras.getState().extras);
    return enqueueWrite(async () => {
      await api.projectSave(path, doc);
    });
  },

  probeAudio: async (path, opts) => {
    const probe: MediaProbe = await api.mediaProbe(path);
    const id = audioMediaIdOf(probe.fingerprint);
    // 同指紋 = 同一個檔（可能換了路徑拖進來）：沿用清單那一份，角色與 audio_info 都不重來
    const existing = useEdits.getState().audioMedia.find((a) => a.id === id);
    if (existing) return { item: existing, existing: true };
    return { item: { id, path, name: fileName(path), fingerprint: probe.fingerprint, probe, role: opts?.role ?? "other", audio: null }, existing: false };
  },

  addAudioMedia: (items, place) => {
    const edits = useEdits.getState();
    const cur = edits.audioMedia;
    const fresh: AudioMediaV2[] = [];
    for (const it of items) if (!cur.some((a) => a.id === it.id) && !fresh.some((a) => a.id === it.id)) fresh.push(it);
    const list = fresh.length ? [...cur, ...fresh] : cur;
    // ctx 查得到的那一份（清單裡已有的以清單為準：它可能已經補上 audio_info）
    const byId = new Map(list.map((a) => [a.id, a]));
    const placeable = place ? [...new Set(items.map((it) => it.id))].map((id) => byId.get(id)!).filter((a) => a.audio || (place.lengths?.[a.id] ?? 0) >= 1) : [];
    if (!place || !placeable.length) {
      // 只進清單：不走 editSequence，隱含序列才不會為了「加一個還放不上去的檔」被實體化（proxy 沒好時也加得進來）
      const committed = edits.editAudioMedia(SEQ_EDIT_LABEL.addAudio, () => (list === cur ? null : list));
      return { committed, clipIds: [] };
    }
    const clipIds: string[] = [];
    const committed = edits.editSequence(
      SEQ_EDIT_LABEL.addAudio,
      (seq, ctx) => {
        // f 失敗擲錯時 editSequence 不會 commit：從頭收集，clipIds 只反映真的落地的那一次
        clipIds.length = 0;
        let s = seq;
        let laneId = place.laneId;
        let at = Math.max(0, Math.round(place.atSample));
        if (place.newLane) {
          s = addLane(s, placeable[0].role);
          laneId = s.audioLanes[s.audioLanes.length - 1].id;
        }
        for (const am of placeable) {
          const id = nextClipId(s, "aclip");
          s = addAudioClip(s, laneId, { type: "audio", audioId: am.id }, at, ctx, am.audio ? { id } : { id, length: place.lengths![am.id] });
          const lane = s.audioLanes.find((l) => l.clips.some((c) => c.id === id))!;
          const clip = lane.clips.find((c) => c.id === id)!;
          clipIds.push(id);
          // 下一段接在這一段後面、同一條軌（這一段因為重疊換了軌的話，跟著換過去，一次拖進來的檔才會排在一起）
          laneId = lane.id;
          at = clip.start + clip.length;
        }
        return s;
      },
      { audioMedia: list },
    );
    return { committed, clipIds: committed ? clipIds : [] };
  },
}));

/** MediaItem 之中會寫進專案檔的部分（proxyState / error 只活在記憶體裡）。 */
function persistedMedia(m: MediaItem): ProjectMediaV2 {
  const { proxyState: _s, error: _e, ...rest } = m;
  return rest;
}

/** 目前 project + edits 狀態 → 專案檔 JSON（saveTo / writeSnapshot 共用；schema 見 project/format.ts）。 */
function buildDoc() {
  const s = useProject.getState();
  const e = useEdits.getState();
  const shots: Record<string, typeof e.shots[string]> = {};
  const tracks: Record<string, typeof e.tracks[string]> = {};
  // 外掛的每媒體狀態：只帶清單上還在的媒體（外掛的 serialize 決定沒有值時寫什麼，例如空陣列）
  const pluginMedia: Record<string, PluginMediaState> = {};
  // 字幕：只帶清單上還在的媒體（buildProjectFile 在一條都沒有時不寫 captions 鍵）
  const captions: Record<string, typeof e.captions[string]> = {};
  for (const m of s.media) {
    shots[m.id] = e.shots[m.id] ?? [];
    tracks[m.id] = e.tracks[m.id] ?? [];
    pluginMedia[m.id] = e.pluginMedia[m.id] ?? {};
    captions[m.id] = e.captions[m.id] ?? null;
  }
  return buildProjectFile(
    // sequence / audioMedia：buildProjectFile 依它們決定寫 v1 還是 v2（沒剪輯、沒音訊媒體 → v1，舊版 App 還打得開）
    { media: s.media, activeMediaId: s.activeMediaId, profile: s.profile, shots, tracks, plugin: { media: pluginMedia, project: e.pluginProject }, insertDefaults: s.insertDefaults, exportDefaults: s.exportDefaults, captions, sequence: e.sequence, audioMedia: e.audioMedia },
    { name: APP_NAME, version: __APP_VERSION__ },
    s.createdAt ? { createdAt: s.createdAt } : null,
  );
}

/** 目前作用中的媒體（selector helper）。 */
export function selectActiveMedia(s: ProjectStore): MediaItem | null {
  return s.media.find((m) => m.id === s.activeMediaId) ?? null;
}

/** 作用中媒體的 proxy 幀數（沒有 proxy = 0）。 */
export function activeFrames(): number {
  return selectActiveMedia(useProject.getState())?.proxy?.frames ?? 0;
}
