import { create } from "zustand";

/**
 * 物件分頁的介面狀態（不進 undo、不存檔）：指令要求「重新命名這個物件」時，分頁把那一列換成輸入框。
 * 放 store 而不是面板的 useState：指令（F 鍵、選單、右鍵）不在 React 裡，也要能叫面板做事。
 */
interface ObjectsUi {
  /** 正在改名的物件 track id。 */
  renamingId: string | null;
  setRenaming: (id: string | null) => void;
  /** 舞台上要不要為選中的物件解這一幀的遮罩（暫停時；關掉只畫框）。 */
  showMask: boolean;
  setShowMask: (v: boolean) => void;
}

export const useObjectsUi = create<ObjectsUi>((set) => ({
  renamingId: null,
  setRenaming: (renamingId) => set({ renamingId }),
  showMask: true,
  setShowMask: (showMask) => set({ showMask }),
}));
