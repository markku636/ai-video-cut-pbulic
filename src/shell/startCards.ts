import { Eraser, ScanFace, Shapes, SquareDashed } from "lucide-react";
import type { StartCardContribution } from "../plugins/api";
import { collect } from "../plugins/registry";

/**
 * 開始畫面「你想做什麼？」的卡片（計畫 §9 Start Screen）。點卡片 = 設 profile → 開檔 → （可選）跑一個指令。
 * 核心四張：追蹤任何東西（卡片上直接打字）、螢幕／平面換畫面、隱私打碼、移除物件；
 * 外掛的卡片（plugins/api.ts startCards，例如牌外掛的兩張）**接在核心的後面**，依外掛自己的 order 排。
 * 這個檔在 check-i18n.mjs 的 TABLE_SOURCES 裡：title / line / 連結文字都是 zh key。
 */
export type StartCard = StartCardContribution;

/** 「追蹤任何東西」卡片的 key：開始畫面把它畫成有輸入框的那一張（StartScreen.tsx）。 */
export const TRACK_ANYTHING_KEY = "track-anything";

export const TRACK_ANYTHING_CARD: StartCard = {
  key: TRACK_ANYTHING_KEY,
  profile: "generic",
  title: "追蹤任何東西",
  line: "打一個詞（人臉、車牌、logo…），開影片後自動找出來、逐幀追蹤；之後打碼、換色、貼字都跟著它走",
  icon: Shapes,
  order: 100,
};

export const GENERIC_START_CARD: StartCard = {
  key: "generic",
  profile: "generic",
  title: "螢幕／平面換畫面",
  line: "海報、螢幕、招牌：拖出四角、釘幾幀關鍵幀，其餘由平面追蹤補完，再貼上圖片或影片",
  icon: SquareDashed,
  order: 110,
};

/** 隱私打碼：開影片後用「人臉」找（可再勾車牌），收進來的物件自動加馬賽克（objects/privacy.ts、指令 object.findFaces）。 */
export const PRIVACY_START_CARD: StartCard = {
  key: "privacy",
  profile: "generic",
  title: "隱私打碼",
  line: "自動找出畫面裡的人臉並逐幀追蹤，勾掉不用打的，其餘打上馬賽克",
  icon: ScanFace,
  after: "object.findFaces",
  order: 120,
};

export const REMOVE_OBJECT_START_CARD: StartCard = {
  key: "remove-object",
  profile: "generic",
  title: "移除物件",
  line: "把畫面上不要的東西拿掉，用其他幀真正拍到的背景補回來（固定機位效果最好）",
  icon: Eraser,
  after: "mask.removeObject",
  order: 130,
};

export const CORE_START_CARDS: readonly StartCard[] = [TRACK_ANYTHING_CARD, GENERIC_START_CARD, PRIVACY_START_CARD, REMOVE_OBJECT_START_CARD];

/** 「追蹤任何東西」卡片底下的兩個次要連結（zh key）。 */
export const TRACK_ANYTHING_LINKS = {
  select: "改用手動選取",
  ai: "讓 AI 挑",
  go: "開啟影片並尋找",
  goEmpty: "開啟影片",
  placeholder: "例如 人臉、車牌、logo、red car",
} as const;

function byOrder(list: readonly StartCard[]): StartCard[] {
  return list.map((c, i) => ({ c, i })).sort((a, b) => (a.c.order ?? 0) - (b.c.order ?? 0) || a.i - b.i).map((x) => x.c);
}

/** 所有卡片：核心的（依 order）在前，外掛的（依 order、同 order 照登記順序）接在後面。 */
export function startCards(): StartCard[] {
  return [...byOrder(CORE_START_CARDS), ...byOrder(collect((p) => p.startCards))];
}

/**
 * 卡片格線：1 張一欄、2 張兩欄、3 張三欄、4 張 2×2（三欄會剩一張孤零零的掛在第二列）、5 張以上三欄。
 * 窄視窗一律一欄。
 */
export function startGridClass(n: number): string {
  if (n <= 1) return "grid-cols-1";
  if (n === 2 || n === 4) return "grid-cols-1 sm:grid-cols-2";
  return "grid-cols-1 sm:grid-cols-3";
}

/** 開檔成功之後「追蹤任何東西」要做什麼（純函式；StartScreen 依它接線）。 */
export type TrackAnythingAction = { kind: "find"; text: string } | { kind: "findEmpty" } | { kind: "select" } | { kind: "ai"; text: string };

export function trackAnythingAction(mode: "go" | "select" | "ai", text: string): TrackAnythingAction {
  const q = text.trim();
  if (mode === "select") return { kind: "select" };
  if (mode === "ai") return { kind: "ai", text: q };
  return q ? { kind: "find", text: q } : { kind: "findEmpty" };
}
