/**
 * 「隱私打碼」預設：用「人臉」（可選再加「車牌」）找 → 勾選 → 收進來的每個物件自動掛一個馬賽克
 * （fx/effect.ts privacyMosaic；跟新增物件同一筆 undo，見 objects/actions.ts adoptFindInstances）。
 * 開始畫面的「隱私打碼」卡片、指令 object.findFaces 都走這裡。這個檔在 check-i18n 的 "objects/" 裡：字串是 zh key。
 */
import { parsePhrases } from "./find";

export const PRIVACY_FACES = "人臉";
export const PRIVACY_PLATES = "車牌";

/** 隱私打碼的起始文字。 */
export function privacyStartText(withPlates = false): string {
  return withPlates ? `${PRIVACY_FACES}, ${PRIVACY_PLATES}` : PRIVACY_FACES;
}

/** 輸入框裡加上 / 拿掉「車牌」（其他片語原樣保留、順序不變）。 */
export function privacyText(text: string, plates: boolean): string {
  const list = parsePhrases(text);
  const has = list.includes(PRIVACY_PLATES);
  if (plates === has) return text;
  return (plates ? [...list, PRIVACY_PLATES] : list.filter((p) => p !== PRIVACY_PLATES)).join(", ");
}
