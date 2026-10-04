import { allCommands, runCommandObject, useCommands } from "./commands/registry";
import { chordKey, chordOf, effectiveKey, parseShortcut, typingTarget } from "./commands/shortcut";
import type { Command } from "./commands/types";

export interface HotkeyHandlers {
  /** J / L 轉盤（K 給了「設關鍵幀」，停用 Space）。 */
  shuttle: (key: "J" | "L", opts: { slow: boolean }) => void;
  /** Alt+方向鍵：微調參考點 / 表面（px）；Shift 再細一級。 */
  nudge: (dx: number, dy: number) => void;
  /** `\` 按住 = A/B 閃爍（看原片），放開恢復。 */
  abFlicker: (down: boolean) => void;
}

/**
 * 全域鍵盤快捷鍵。
 *
 * 絕大多數鍵由指令註冊表派發（commands/*.ts 的 `shortcuts`）：這裡只剩三種手寫的 ——
 * J/L（要忽略 auto-repeat）、Alt+方向鍵（auto-repeat 就是要的：按住連續微調）、`\` 按住放開（要 keyup），
 * 以及 `global` 指令（F1、Ctrl+K）要在「對話框開著就讓路」的檢查**之前**處理。
 *
 * 對話框開啟（body.dataset.modalCount）或焦點在輸入框時讓路。
 */
export function installHotkeys(h: HotkeyHandlers): () => void {
  // chord → 指令。註冊表一變就重建（version 變了才重建，不是每次按鍵）
  let map = new Map<string, Command>();
  let builtAt = -1;
  const ensureMap = () => {
    const v = useCommands.getState().version;
    if (v === builtAt) return;
    builtAt = v;
    map = new Map();
    for (const c of allCommands()) {
      if (c.shortcutManual) continue;
      for (const s of c.shortcuts ?? []) map.set(chordKey(parseShortcut(s)), c);
    }
  };

  let flickering = false;
  const onKeyUp = (e: KeyboardEvent) => {
    if (flickering && effectiveKey(e) === "\\") {
      flickering = false;
      h.abFlicker(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    ensureMap();
    const cmd = map.get(chordKey(chordOf(e)));
    if (cmd?.global) {
      e.preventDefault();
      void runCommandObject(cmd, "hotkey");
      return;
    }
    if (document.body.dataset.modalCount) return;
    if (typingTarget(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = effectiveKey(e);
    // Alt+方向鍵在指令表之前：註冊表不會有 Alt+Arrow（adjust.nudge 是 shortcutManual）
    if (e.altKey && !ctrl && (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown")) {
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 1;
      h.nudge(k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0, k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0);
      return;
    }
    if (cmd) {
      e.preventDefault();
      void runCommandObject(cmd, "hotkey");
      return;
    }
    if (ctrl || e.altKey) return;
    switch (k) {
      // 轉盤：按住不放不會一直加速（剪輯軟體的 JKL 是「點一下走一格」）
      case "j":
      case "J":
      case "l":
      case "L":
        if (e.repeat) return;
        h.shuttle(k.toUpperCase() as "J" | "L", { slow: e.shiftKey });
        return;
      case "\\":
        e.preventDefault();
        if (e.repeat || flickering) return;
        flickering = true;
        h.abFlicker(true);
        return;
      default:
        return;
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  // 失焦時 keyup 收不到，`\` 會永遠卡在「按住」→ 畫面一直停在原片
  const onBlur = () => {
    if (flickering) {
      flickering = false;
      h.abFlicker(false);
    }
  };
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}
