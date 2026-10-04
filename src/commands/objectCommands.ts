import { Crosshair, Pencil, ScanFace, SquareMousePointer, TextSearch, Trash2, WandSparkles, X } from "lucide-react";
import { t } from "../i18n";
import * as O from "../objects/actions";
import { privacyStartText } from "../objects/privacy";
import { hasPrompts, useSelection } from "../objects/selection";
import { useObjectsUi } from "../objects/ui";
import { plugins } from "../plugins/registry";
import { openDialog } from "../store/dialogs";
import { useTimeline } from "../store/timeline";
import { useUi } from "../store/ui";
import { activeId, needsEngine, needsMedia, needsObjectTrack, needsProxy, selectedTrackId } from "./guards";
import { bumpCommandTick, OK } from "./registry";
import { chordKey, parseShortcut } from "./shortcut";
import type { Command, Enabled } from "./types";
import { withUndoToast } from "./undoToast";

/**
 * 物件指令（通用「追蹤任何東西」；群組「物件」）：用文字找、選取物件工具、追蹤選取、修正、改名、刪除、跳到最佳幀。
 * 這個檔在 check-i18n 的 commands/ 底下：title / why 都是 zh key。
 *
 * Ctrl+D：核心沒有外掛時給「找物件」。牌外掛把 Ctrl+D 給了「偵測所有牌」（它的使用者習慣這個鍵），
 * 裝了外掛就讓給它，「找物件」改從工具列 / 選單 / 命令面板進（同一個 chord 綁兩個指令會雙擊發，duplicateChords 守門）。
 */

export const FIND_SHORTCUT = "Ctrl+D";

function both(...fs: (() => Enabled)[]): () => Enabled {
  return () => {
    for (const f of fs) {
      const r = f();
      if (!r.ok) return r;
    }
    return OK;
  };
}

/** 有沒有外掛的指令已經用了這個 chord（指令表在組的當下問；外掛先登記、指令後登記）。 */
export function chordClaimedByPlugin(shortcut: string): boolean {
  const want = chordKey(parseShortcut(shortcut));
  return plugins().some((p) => (p.commands ?? []).some((b) => b.commands.some((c) => (c.shortcuts ?? []).some((s) => chordKey(parseShortcut(s)) === want))));
}

/** 選取 session 有提示點、沒在傳播：可以「追蹤這個物件」。 */
export function needsSelection(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  const st = useSelection.getState();
  const s = st.session;
  if (!s || s.mediaId !== activeId() || !hasPrompts(s)) return { ok: false, why: "先用「選取物件」工具在畫面上點一下或拉一個框" };
  if (st.committing) return { ok: false, why: "正在追蹤這個物件" };
  return OK;
}

function needsSession(): Enabled {
  const s = useSelection.getState().session;
  return s ? OK : { ok: false, why: "沒有進行中的選取" };
}

export function objectCommands(): Command[] {
  const findShortcut = chordClaimedByPlugin(FIND_SHORTCUT) ? [] : [FIND_SHORTCUT];
  const selected = () => selectedTrackId();
  return [
    {
      id: "object.find",
      title: "找物件…",
      group: "object",
      section: "找物件",
      icon: TextSearch,
      shortcuts: findShortcut,
      surfaces: ["menu", "palette", "toolbar", "context"],
      keywords: ["find", "detect", "track anything", "segment", "sam", "找", "偵測", "物件"],
      enabled: needsMedia,
      run: () => openDialog("findObject", {}),
    },
    {
      id: "object.findFaces",
      // 隱私打碼預設：找人臉（對話框裡可以再勾「也找車牌」）→ 收進來的物件自動加馬賽克（objects/privacy.ts）
      title: "隱私打碼…",
      group: "object",
      section: "找物件",
      icon: ScanFace,
      surfaces: ["menu", "palette"],
      keywords: ["privacy", "blur faces", "license plate", "mosaic", "打碼", "馬賽克", "人臉", "車牌"],
      enabled: needsMedia,
      run: () => openDialog("findObject", { text: privacyStartText(), intent: "privacy", autoRun: true }),
    },
    {
      id: "object.tool.select",
      title: "工具：選取物件",
      group: "object",
      section: "選取",
      icon: SquareMousePointer,
      shortcuts: ["W"],
      keywords: ["select object", "click", "box", "點選", "框選"],
      checked: () => useTimeline.getState().tool === "objSelect",
      enabled: needsProxy,
      run: () => O.startSelectTool(),
    },
    {
      id: "object.trackSelection",
      title: "追蹤這個物件",
      group: "object",
      section: "選取",
      icon: Crosshair,
      surfaces: ["menu", "palette", "context"],
      keywords: ["propagate", "track selection", "傳播"],
      enabled: both(needsSelection, needsEngine),
      run: () => void O.commitSelection(useSelection.getState().scope),
    },
    {
      id: "object.cancelSelection",
      title: "取消選取",
      group: "object",
      section: "選取",
      icon: X,
      surfaces: ["menu", "palette", "context"],
      enabled: needsSession,
      run: () => O.cancelSelection(),
    },
    {
      id: "object.refine",
      title: "修正物件（從這一幀往後）",
      group: "object",
      section: "物件",
      icon: WandSparkles,
      surfaces: ["menu", "palette", "context"],
      keywords: ["refine", "fix", "correct", "修正"],
      enabled: both(needsObjectTrack, needsProxy),
      run: () => {
        const id = selected();
        if (id) O.startRefine(id);
      },
    },
    {
      id: "object.rename",
      title: "重新命名物件…",
      group: "object",
      section: "物件",
      icon: Pencil,
      surfaces: ["menu", "palette", "context"],
      keywords: ["rename"],
      enabled: needsObjectTrack,
      run: () => {
        const id = selected();
        if (!id) return;
        useUi.getState().setTab(O.OBJECTS_TAB);
        useObjectsUi.getState().setRenaming(id);
      },
    },
    {
      id: "object.jump",
      title: "跳到物件最清楚的一幀",
      group: "object",
      section: "物件",
      icon: Crosshair,
      surfaces: ["menu", "palette", "context"],
      keywords: ["best frame", "reference"],
      enabled: needsObjectTrack,
      run: () => {
        const id = selected();
        if (id) O.jumpToObject(id);
      },
    },
    {
      id: "object.delete",
      title: "刪除物件",
      group: "object",
      section: "物件",
      icon: Trash2,
      surfaces: ["menu", "palette", "context"],
      keywords: ["delete", "remove"],
      enabled: needsObjectTrack,
      run: () => {
        const id = selected();
        if (id) return withUndoToast(t("已刪除物件"), () => O.deleteObjects([id]));
      },
    },
  ];
}

/** 選取 session 一變（點了一下、傳播開始 / 結束）就 bump，「追蹤這個物件」的可用狀態才跟得上。 */
export function installObjectCommandReactivity(): () => void {
  return useSelection.subscribe((s, p) => {
    if (s.session !== p.session || s.committing !== p.committing) bumpCommandTick();
  });
}
