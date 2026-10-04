/**
 * 用文字找物件（引擎 `seg.find`；契約 docs/tracking-api.md §6.1）＋把勾選的實例收進專案（`objects.adopt` → 物件 track）。
 *
 * 這個檔分兩半：上半是純函式（範圍、參數、結果解析、片語翻譯 —— 測試直接載），下半才碰引擎與 store。
 *
 * 為什麼 --out 放在媒體快取的 `find/<run>`：find 會寫好幾份檔（每個實例一個 obj<N>/masks.aivm、縮圖、疊色圖），
 * 使用者還沒決定要哪幾個，放進專案資料夾會留下一堆沒人要的東西；勾好之後 objects.adopt 才把遮罩搬進
 * `tracks/<trackId>/masks.aivm`（跟平面 track 同一個位置），find 的資料夾清快取就沒了。
 */
import type { ObjectSourceV1, ShotV1 } from "../project/format";
import type { FrameRange } from "../store/timeline";

// ────────────────────────────────────────────────────────────────────────────
// 建議片語
// ────────────────────────────────────────────────────────────────────────────

/**
 * 建議片語（UI 上的小按鈕）：label 是 zh key（畫面上 t() 過），engine 是送給偵測器的英文 ——
 * 後備路線的 OWLv2 是英文模型，中文幾乎找不到東西（SAM 3 也是英文詞彙表）。
 */
export interface FindSuggestion {
  label: string;
  engine: string;
}

export const FIND_SUGGESTIONS: readonly FindSuggestion[] = [
  { label: "人臉", engine: "face" },
  { label: "人", engine: "person" },
  { label: "車牌", engine: "license plate" },
  { label: "螢幕", engine: "screen" },
  { label: "logo", engine: "logo" },
  { label: "手", engine: "hand" },
];

/** 常見的中文說法 → 英文（建議片語之外，使用者也常打這些）。只做整個片語的對照，不做斷詞翻譯。 */
const PHRASE_EN: Readonly<Record<string, string>> = {
  ...Object.fromEntries(FIND_SUGGESTIONS.map((s) => [s.label, s.engine])),
  臉: "face",
  人物: "person",
  行人: "pedestrian",
  車: "car",
  汽車: "car",
  機車: "motorcycle",
  車子: "car",
  手機: "phone",
  電視: "television",
  招牌: "sign",
  標誌: "logo",
  商標: "logo",
  文字: "text",
  狗: "dog",
  貓: "cat",
  杯子: "cup",
  瓶子: "bottle",
};

/** 使用者打的字 → 片語清單（跟引擎 text_box.parse_phrases 同一套分隔符：半形 / 全形逗號、頓號、換行；去重保序）。 */
export function parsePhrases(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.replace(/，/g, ",").replace(/、/g, ",").replace(/\n/g, ",").split(",")) {
    const p = chunk.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** 一個片語送給引擎的樣子：認得的中文換成英文，其他原樣（英文、或使用者知道自己在幹嘛）。 */
export function enginePhrase(p: string): string {
  return PHRASE_EN[p.trim()] ?? PHRASE_EN[p.trim().toLowerCase()] ?? p.trim();
}

/** 整句 → 引擎的 --text，以及「引擎片語 → 使用者打的字」對照（實例的 phrase 是引擎片語，物件名用使用者打的）。 */
export function engineText(text: string): { text: string; display: Map<string, string> } {
  const display = new Map<string, string>();
  const parts: string[] = [];
  for (const p of parsePhrases(text)) {
    const e = enginePhrase(p);
    if (!parts.includes(e)) parts.push(e);
    if (!display.has(e)) display.set(e, p);
  }
  return { text: parts.join(", "), display };
}

/** 把建議片語加進輸入框（已經有就不重複加）。 */
export function addSuggestion(text: string, label: string): string {
  const list = parsePhrases(text);
  if (list.includes(label)) return text;
  return [...list, label].join(", ");
}

// ────────────────────────────────────────────────────────────────────────────
// 範圍
// ────────────────────────────────────────────────────────────────────────────

/** 在哪一段找：播放線所在鏡頭 / 整支 / I-O 範圍。 */
export type FindScope = "shot" | "clip" | "range";
export const FIND_SCOPES: readonly FindScope[] = ["shot", "clip", "range"];

export interface ScopeContext {
  /** 播放線（proxy 幀）。 */
  frame: number;
  /** proxy 總幀數。 */
  frames: number;
  shots: readonly ShotV1[];
  range: FrameRange | null;
}

/** 範圍 → [k0, k1)（半開）；做不到（沒有 I/O 範圍、沒有幀）→ null。播放線不在任何鏡頭裡（還沒偵測）→ 整支。 */
export function scopeFrames(scope: FindScope, ctx: ScopeContext): [number, number] | null {
  const n = Math.max(0, Math.floor(ctx.frames));
  if (n <= 0) return null;
  if (scope === "range") {
    if (!ctx.range) return null;
    const a = Math.max(0, Math.min(n - 1, ctx.range.in));
    const b = Math.max(a + 1, Math.min(n, ctx.range.out));
    return [a, b];
  }
  if (scope === "shot") {
    const s = ctx.shots.find((x) => x.startFrame <= ctx.frame && ctx.frame < x.endFrame);
    if (s) return [Math.max(0, s.startFrame), Math.min(n, s.endFrame)];
  }
  return [0, n];
}

/** 範圍能不能用（UI 灰掉的理由；zh key）。 */
export function scopeUnavailable(scope: FindScope, ctx: ScopeContext): string | null {
  if (ctx.frames <= 0) return "還沒有 proxy（引擎就緒後會自動建）";
  if (scope === "range" && !ctx.range) return "先用 I / O 標一段範圍";
  return null;
}

/** 「找」按鈕為什麼不能按（zh key）；null = 可以。順序 = 使用者要先解決的順序。 */
export function findBlocker(o: { text: string; engineReady: boolean; scope: FindScope; ctx: ScopeContext; busy: boolean }): string | null {
  if (o.busy) return "正在找";
  if (!o.engineReady) return "引擎尚未就緒";
  const s = scopeUnavailable(o.scope, o.ctx);
  if (s) return s;
  if (!parsePhrases(o.text).length) return "先打要找的東西（例如 人臉、車牌、logo）";
  return null;
}

/** 預設範圍：有 I/O 範圍就用它（使用者剛標過），否則播放線所在鏡頭（後備路線跨鏡頭會追丟）。 */
export function defaultScope(ctx: Pick<ScopeContext, "range">): FindScope {
  return ctx.range ? "range" : "shot";
}

/**
 * 錨定幀（後備路線在這一幀找框）：播放線在範圍內就用它（使用者正看著目標），否則範圍中點 ——
 * 開頭常常是淡入、還沒入鏡，中間找到東西的機率高得多。
 */
export function findAnchor(k: [number, number], frame: number): number {
  if (frame >= k[0] && frame < k[1]) return frame;
  return Math.max(k[0], Math.min(k[1] - 1, Math.floor((k[0] + k[1]) / 2)));
}

// ────────────────────────────────────────────────────────────────────────────
// 引擎參數與結果
// ────────────────────────────────────────────────────────────────────────────

export interface FindRequest {
  video: string;
  /** 使用者打的字（會翻成引擎片語）。 */
  text: string;
  frames: [number, number];
  anchor: number;
  /** 輸出資料夾（媒體快取的 find/<run>）。 */
  out: string;
  max?: number;
  /** SAM 2.1 變體（設定 engine.sam_variant）。 */
  sam?: string;
}

/** `seg.find` 的 args（鍵 = CLI dest 名；docs/tracking-api.md §6.2 最後一段）。 */
export function findArgs(req: FindRequest): Record<string, unknown> {
  return {
    video: req.video,
    text: engineText(req.text).text,
    frames: `${req.frames[0]}:${req.frames[1]}`,
    anchor: req.anchor,
    out: req.out,
    ...(req.max != null ? { max_instances: req.max } : {}),
    ...(req.sam ? { sam: req.sam } : {}),
  };
}

export interface FindBackend {
  name: string;
  label: string;
  fallback: boolean;
  reason: string;
}

export interface FindInstance {
  /** 1..n ＝ 輸出資料夾的 obj<N>。 */
  id: number;
  phrase: string;
  score: number;
  firstFrame: number;
  lastFrame: number;
  bestFrame: number;
  box: [number, number, number, number] | null;
  area: number;
  framesPresent: number;
  framesAbsent: number;
  /** obj<N>/masks.aivm 的絕對路徑。 */
  masks: string;
  thumb: string | null;
}

export interface FindResult {
  text: string;
  phrases: string[];
  backend: FindBackend;
  frames: { k0: number; k1: number; anchor: number };
  frameSize: [number, number] | null;
  outDir: string;
  overlay: { path: string; frame: number } | null;
  instances: FindInstance[];
  dropped: number;
  notes: string[];
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const int = (v: unknown, d = 0): number => (typeof v === "number" && Number.isInteger(v) ? v : d);
const strOr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function box4(v: unknown): [number, number, number, number] | null {
  return Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as [number, number, number, number]) : null;
}

/** find.v1.json（= seg.find 的回傳值）→ 防禦式解析：壞掉的實例丟掉（沒有 masks 路徑的收不進專案）。 */
export function parseFindResult(raw: unknown): FindResult {
  const o = rec(raw) ?? {};
  const b = rec(o.backend) ?? {};
  const fr = rec(o.frames) ?? {};
  const ov = rec(o.overlay);
  const fs = Array.isArray(o.frameSize) && o.frameSize.length === 2 ? ([num(o.frameSize[0]), num(o.frameSize[1])] as [number, number]) : null;
  const instances: FindInstance[] = [];
  for (const x of Array.isArray(o.instances) ? o.instances : []) {
    const i = rec(x);
    if (!i || typeof i.masks !== "string" || !i.masks || !Number.isInteger(i.id)) continue;
    const first = int(i.firstFrame, -1);
    const last = int(i.lastFrame, -1);
    instances.push({
      id: i.id as number,
      phrase: strOr(i.phrase),
      score: num(i.score),
      firstFrame: first,
      lastFrame: last,
      bestFrame: int(i.bestFrame, first),
      box: box4(i.box),
      area: num(i.area),
      framesPresent: int(i.framesPresent),
      framesAbsent: int(i.framesAbsent),
      masks: i.masks,
      thumb: typeof i.thumb === "string" && i.thumb ? i.thumb : null,
    });
  }
  return {
    text: strOr(o.text),
    phrases: Array.isArray(o.phrases) ? o.phrases.filter((p): p is string => typeof p === "string") : [],
    backend: { name: strOr(b.name), label: strOr(b.label, strOr(b.name)), fallback: b.fallback === true, reason: strOr(b.reason) },
    frames: { k0: int(fr.k0), k1: int(fr.k1), anchor: int(fr.anchor) },
    frameSize: fs,
    outDir: strOr(o.outDir),
    overlay: ov && typeof ov.path === "string" ? { path: ov.path, frame: int(ov.frame) } : null,
    instances,
    dropped: int(o.dropped),
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string") : [],
  };
}

/** 實例看得到的範圍 → 物件 track 的 range [k0, k1)（半開）。看不到（firstFrame < 0）→ 用 find 的範圍。 */
export function instanceRange(inst: Pick<FindInstance, "firstFrame" | "lastFrame">, scope: { k0: number; k1: number }): [number, number] {
  if (inst.firstFrame >= 0 && inst.lastFrame >= inst.firstFrame) return [inst.firstFrame, inst.lastFrame + 1];
  return [scope.k0, Math.max(scope.k0 + 1, scope.k1)];
}

/** 預設勾哪些：全部（find 已經依分數排、去重、丟掉太短的；使用者通常要的就是全部）。 */
export function defaultTicked(r: FindResult): Set<number> {
  return new Set(r.instances.map((i) => i.id));
}

/** 物件名：使用者打的片語（「人臉」而不是 face），同名的加編號（人臉、人臉 2…）。 */
export function instanceLabels(r: FindResult, userText: string, existing: readonly string[] = []): Map<number, string> {
  const { display } = engineText(userText);
  const taken = new Set(existing);
  const out = new Map<number, string>();
  for (const inst of r.instances) {
    const base = display.get(inst.phrase) ?? (inst.phrase || "物件");
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    taken.add(name);
    out.set(inst.id, name);
  }
  return out;
}

/** 物件 track 的 source（寫進專案檔）。 */
export function instanceSource(r: FindResult, inst: FindInstance, userText: string): ObjectSourceV1 {
  return { type: "text", text: userText.trim(), phrase: inst.phrase, backend: r.backend.name || undefined, score: Math.round(inst.score * 10000) / 10000 };
}

/** 後備路線的提示（不擋流程；zh key + 參數）。null = 用的是 SAM 3，或沒退。 */
export function fallbackNote(b: FindBackend): { key: string; params: Record<string, string> } | null {
  if (!b.fallback) return null;
  return {
    key: "沒有用 SAM 3（{reason}），改用 OWLv2 + SAM 2.1：只找得到錨定幀看得見的東西，跨鏡頭可能追丟",
    params: { reason: b.reason || "—" },
  };
}

/** 實例清單上的一行數字：「幀 12–340 · 分數 0.62」。 */
export function instanceFrames(inst: FindInstance): string {
  return inst.firstFrame >= 0 ? `${inst.firstFrame}–${inst.lastFrame}` : "—";
}

/** find 輸出資料夾的名字（每次一個新的，結果不會被下一次覆蓋；舊的留在快取裡，清快取就沒了）。 */
export function findRunId(now = Date.now()): string {
  return `f${now.toString(36)}`;
}

/** 絕對路徑在 cacheDir 底下的相對路徑（`/` 分隔，給 api.cacheRead）；不在底下 → null。 */
export function relToCache(cacheDir: string, abs: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(cacheDir);
  const p = norm(abs);
  const lower = (s: string) => s.toLowerCase();
  if (!lower(p).startsWith(lower(base) + "/")) return null;
  return p.slice(base.length + 1);
}
