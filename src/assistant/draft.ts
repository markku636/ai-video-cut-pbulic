import { create } from "zustand";

/**
 * 從別的地方「帶一句話進助手」：開始畫面的「讓 AI 挑」、物件分頁的「讓 AI 選」把預填的句子放這裡、打開助手分頁，
 * 助手面板掛著（或之後掛上）時把它搬進輸入框、清掉這一格。不直接送出：讓人看一眼、改一改再按。
 *
 * AI 自己看圖選物件（media.frame --grid → seg.select --coords norm1000）由之後的任務接上；現在只是預填一句話。
 */
interface DraftStore {
  draft: string | null;
  setDraft: (text: string | null) => void;
}

export const useAssistantDraft = create<DraftStore>((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
}));

/** 拿走預填的句子（拿一次就清掉）。 */
export function takeAssistantDraft(): string | null {
  const d = useAssistantDraft.getState().draft;
  if (d !== null) useAssistantDraft.getState().setDraft(null);
  return d;
}
