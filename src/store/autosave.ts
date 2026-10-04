import { errMessage } from "../api";
import { t } from "../i18n";
import { toast } from "../ui";
import { useProject } from "./project";

/** 最後一次編輯後等多久存。 */
export const AUTOSAVE_DEBOUNCE_MS = 2000;
/** 一直在改（拖角點、連按 Alt+方向鍵）時，從第一筆沒存的編輯起最晚多久一定存一次。 */
export const AUTOSAVE_MAX_WAIT_MS = 10_000;
/** 存失敗後重試的間隔（每次加倍，到上限為止）。檔案被防毒／同步軟體短暫鎖住是幾秒就好的事。 */
export const AUTOSAVE_RETRY_MS = 5_000;
export const AUTOSAVE_RETRY_MAX_MS = 60_000;

/**
 * 自動儲存：專案有路徑、有未存的變更 → 最後一次編輯後 2 秒存；持續編輯最晚 10 秒存一次。
 *
 * 訂閱 `rev` 而不是 dirty 翻面：存檔途中的編輯讓 dirty 一直是 true，只看翻面的話那筆編輯永遠等不到下一次自動儲存。
 * 失敗提示一次就好（直到下次存成功才會再提示），不每 2 秒洗一次版。
 *
 * **失敗要自己再排一次**：訂閱只在 rev / dirty / path 變了才重新計時，失敗的 saveTo 不會改動任何一個，
 * 所以不重新排程的話「使用者停手 → 存一次 → 失敗 → 從此再也不存」，而且提示只出現過那一次
 * （檔案被防毒鎖住、隨身碟拔掉、雲端同步資料夾正在鎖檔都會這樣）。間隔加倍最多到 60 秒。回傳解除函式。
 */
export function installAutosave(onError: (msg: string) => void = (msg) => toast.error(t("自動儲存失敗：{msg}。變更還沒寫進專案檔。", { msg }))): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 這一輪第一筆沒存的變更是什麼時候（max wait 從這裡算）；null = 沒有排定中的自動儲存。 */
  let pendingSince: number | null = null;
  let errorShown = false;
  /** 下一次失敗重試要等多久；0 = 上一次是成功的。 */
  let retryMs = 0;
  let stopped = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pendingSince = null;
  };

  const fire = () => {
    timer = undefined;
    pendingSince = null;
    const st = useProject.getState();
    if (!st.dirty || !st.path) return;
    st.saveTo(st.path).then(
      () => {
        errorShown = false;
        retryMs = 0;
      },
      (e: unknown) => {
        if (!errorShown) {
          errorShown = true;
          onError(errMessage(e));
        }
        // 沒人會替我們重新計時（rev / dirty / path 都沒變）：自己排下一次，間隔加倍
        retryMs = Math.min(retryMs ? retryMs * 2 : AUTOSAVE_RETRY_MS, AUTOSAVE_RETRY_MAX_MS);
        const st2 = useProject.getState();
        if (stopped || !st2.dirty || !st2.path || timer) return;
        pendingSince ??= Date.now();
        timer = setTimeout(fire, retryMs);
      },
    );
  };

  const un = useProject.subscribe((s, prev) => {
    if (!s.dirty || !s.path) {
      cancel();
      return;
    }
    if (s.rev === prev.rev && s.dirty === prev.dirty && s.path === prev.path) return;
    const now = Date.now();
    pendingSince ??= now;
    clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(AUTOSAVE_DEBOUNCE_MS, pendingSince + AUTOSAVE_MAX_WAIT_MS - now)));
  });

  return () => {
    stopped = true;
    un();
    cancel();
  };
}
