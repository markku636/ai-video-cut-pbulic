// 工作模式（= 專案檔的 profile）。核心只有「一般平面替換」（generic）；外掛可以加（例如 cards）。
// 這個檔在 check-i18n 的 TABLE_SOURCES：title / hint / newTrackLabel 是 zh key。
import type { WorkProfileContribution } from "../plugins/api";
import { collect } from "../plugins/registry";
import type { Profile } from "./format";
import { isForeignValue } from "./vocab";

export const GENERIC_PROFILE: WorkProfileContribution = {
  id: "generic",
  title: "一般平面替換",
  hint: "海報、螢幕、招牌：自己在舞台上框出平面（按 N）",
  newTrackLabel: "平面 {n}",
  order: 100,
};

/** 所有工作模式（外掛的 + 核心的），依 order 排序（同 order 照登記順序）。 */
export function workProfiles(): WorkProfileContribution[] {
  const list = [...collect((p) => p.profiles), GENERIC_PROFILE];
  return list.map((p, i) => ({ p, i })).sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.i - b.i).map((x) => x.p);
}

export function workProfile(id: string): WorkProfileContribution | undefined {
  return workProfiles().find((p) => p.id === id);
}

/** 新專案 / 第一次啟動的工作模式：外掛宣告的預設，沒有就 generic。 */
export function defaultProfileId(): Profile {
  return workProfiles().find((p) => p.default)?.id ?? GENERIC_PROFILE.id;
}

/** 舊檔沒寫 profile、或寫了不認得的值時讀成這個；沒有外掛宣告 → null（不認得的值原樣保留）。 */
export function legacyProfileId(): Profile | null {
  return workProfiles().find((p) => p.legacy)?.id ?? null;
}

/**
 * 專案檔的 profile：認得的照收；不認得 / 沒寫 → 外掛宣告的 legacy（App 早期只有那一種用途）；
 * 沒有 legacy 時，像識別字的值原樣保留（可能屬於沒裝的外掛），其餘當 generic。
 */
export function sanitizeProfile(v: unknown): Profile {
  if (typeof v === "string" && workProfile(v)) return v;
  const legacy = legacyProfileId();
  if (legacy) return legacy;
  return isForeignValue(v) ? v : GENERIC_PROFILE.id;
}
