/**
 * 打字停一下才 commit 的計時器（字幕面板行內改字用）。
 *
 * 為什麼不直接在元件裡 setTimeout / clearTimeout：驗收 Low —— 播放中自動捲動會把正在打字的那一列捲出虛擬清單，
 * 元件卸載時 cleanup 只 clearTimeout，最後 300 ms 內打的字就這樣消失了。卸載要 **flush**（立刻 commit 還沒送出的值），
 * 只有 Esc（使用者明說不要）才 cancel。抽成這個小物件，vitest 用假計時器就能驗「卸載不掉字」，不必開 DOM。
 */
export interface PendingCommit {
  /** 記下最新的值並重新起算延遲（連續打字只會 commit 最後一次）。 */
  schedule: (value: string) => void;
  /** 有還沒送出的值 → 立刻 commit；沒有 → 什麼都不做（所以 blur 之後再卸載不會重複 commit）。 */
  flush: () => void;
  /** 丟掉還沒送出的值（Esc 放棄草稿）。 */
  cancel: () => void;
  isPending: () => boolean;
}

export function createPendingCommit(commit: (value: string) => void, delayMs: number): PendingCommit {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let value: string | null = null;
  const clear = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    clear();
    if (value == null) return;
    const v = value;
    // 先清掉再 commit：commit 裡若又觸發 flush（store 更新 → 重繪 → 卸載），不會把同一個值送兩次
    value = null;
    commit(v);
  };
  return {
    schedule: (v) => {
      clear();
      value = v;
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel: () => {
      clear();
      value = null;
    },
    isPending: () => value != null,
  };
}
