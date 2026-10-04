/**
 * 輸出對話框的「效果 / 替換」摘要（純函式）。兩個來源：
 * 1. 專案本身（store 的 tracks）：哪些 track 有開著的特效、哪些平面 track 有替換 —— 這是使用者「以為會發生」的事。
 * 2. 引擎 `render.plan` 的回報：引擎真的打算做的事。render 端由另一個任務依共用契約實作（effects / replace 掛在 track 上），
 *    回報的鍵名還沒定案，所以這裡讀得**寬鬆**：`tracks[].effects`（字串、{type}、或數量）/ `tracks[].replace`、
 *    頂層 `effects[]` / `objects[]`（{trackId|track|id, effects|types|type}）都認。
 *
 * 兩邊對不上（專案有、引擎沒列）時講一句：多半是引擎版本還不會輸出特效，在輸出前講比輸出完才發現好。
 */
import type { EffectV1, TrackV1 } from "../project/format";
import { activeEffects } from "../fx/effect";
import { stackErrors } from "../fx/validate";

export interface PlanEdit {
  trackId: string;
  /** 特效種類（引擎的 type 名；數量未知時是空陣列但 count > 0）。 */
  effects: string[];
  count: number;
  /** 替換的種類（"image" | "video" | 其他字串）；null = 沒有。 */
  replace: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function trackIdOf(o: Obj): string | null {
  for (const k of ["trackId", "track", "id", "object"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** effects 欄位 → [種類…, 數量]。 */
function effectTypes(v: unknown): { types: string[]; count: number } | null {
  if (typeof v === "number" && Number.isFinite(v)) return { types: [], count: Math.max(0, Math.round(v)) };
  if (typeof v === "string" && v) return { types: [v], count: 1 };
  if (!Array.isArray(v)) return null;
  const types = v.map((x) => (typeof x === "string" ? x : isObj(x) && typeof x.type === "string" ? x.type : "")).filter(Boolean);
  return { types, count: v.length };
}

function replaceKind(v: unknown): string | null {
  if (typeof v === "string" && v) return v;
  if (isObj(v)) return typeof v.kind === "string" ? v.kind : "image";
  return null;
}

function mergeEdit(map: Map<string, PlanEdit>, id: string, fx: { types: string[]; count: number } | null, rep: string | null): void {
  if (!fx?.count && !rep) return;
  const cur = map.get(id) ?? { trackId: id, effects: [], count: 0, replace: null };
  if (fx?.count) {
    cur.effects = [...cur.effects, ...fx.types];
    cur.count += fx.count;
  }
  if (rep) cur.replace = rep;
  map.set(id, cur);
}

/**
 * render.plan → 引擎打算套用的特效 / 替換。null＝引擎完全沒有回報這兩件事的鍵（舊版引擎）；[]＝有回報、但沒有。
 */
export function planEdits(plan: unknown): PlanEdit[] | null {
  if (!isObj(plan)) return null;
  const map = new Map<string, PlanEdit>();
  let reported = false;
  for (const j of Array.isArray(plan.tracks) ? plan.tracks : []) {
    if (!isObj(j)) continue;
    if (!("effects" in j) && !("replace" in j)) continue;
    reported = true;
    const id = trackIdOf(j);
    if (id) mergeEdit(map, id, effectTypes(j.effects), replaceKind(j.replace));
  }
  for (const key of ["effects", "objects", "replace", "replacements"]) {
    const list = plan[key];
    if (!Array.isArray(list)) continue;
    reported = true;
    for (const o of list) {
      if (!isObj(o)) continue;
      const id = trackIdOf(o);
      if (!id) continue;
      const fx = effectTypes(o.effects ?? o.types ?? (key === "effects" ? o.type : undefined));
      const rep = key === "replace" || key === "replacements" ? replaceKind(o) : replaceKind(o.replace);
      mergeEdit(map, id, fx, rep);
    }
  }
  return reported ? [...map.values()] : null;
}

export interface ProjectEdits {
  /** 有開著特效的 track：id、名稱、特效種類。 */
  effects: { trackId: string; label: string; types: string[] }[];
  replace: { trackId: string; label: string; kind: string }[];
  /** 開著的特效裡，引擎會拒收的欄位數。 */
  errors: number;
}

/** 專案這支媒體的特效 / 替換（使用者以為會發生的事）。 */
export function projectEdits(tracks: readonly TrackV1[]): ProjectEdits {
  const effects: ProjectEdits["effects"] = [];
  const replace: ProjectEdits["replace"] = [];
  let errors = 0;
  for (const t of tracks) {
    const on: EffectV1[] = activeEffects(t.effects);
    if (on.length) effects.push({ trackId: t.id, label: t.label, types: on.map((e) => String(e.type)) });
    errors += stackErrors(t.effects);
    if (t.kind !== "object" && t.replace?.path) replace.push({ trackId: t.id, label: t.label, kind: t.replace.kind });
  }
  return { effects, replace, errors };
}

/** 專案有、引擎計畫沒列的 track（引擎有回報時才比；沒回報＝null 由呼叫端另外講）。 */
export function missingFromPlan(project: ProjectEdits, plan: readonly PlanEdit[]): string[] {
  const fx = new Set(plan.filter((p) => p.count > 0).map((p) => p.trackId));
  const rep = new Set(plan.filter((p) => p.replace).map((p) => p.trackId));
  const out = new Set<string>();
  for (const e of project.effects) if (!fx.has(e.trackId)) out.add(e.label);
  for (const r of project.replace) if (!rep.has(r.trackId)) out.add(r.label);
  return [...out];
}
