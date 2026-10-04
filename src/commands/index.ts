import { errMessage } from "../api";
import { plugins } from "../plugins/registry";
import { toast } from "../ui";
import { CAPTION_COMMANDS, installCaptionCommandReactivity } from "./captionCommands";
import { coreCommands } from "./core";
import { EXPORT_COMMANDS } from "./exportCommands";
import { installCommandReactivity } from "./guards";
import { MEDIA_INFO_COMMANDS } from "./mediaInfoCommands";
import { installObjectCommandReactivity, objectCommands } from "./objectCommands";
import { registerCommands, setCommandHost } from "./registry";
import { TRACK_COMMANDS } from "./trackCommands";
import type { Command } from "./types";
// M2.12 序列剪輯：獨立一行 import，免得跟同一波其他群組改同一行的 import 清單互相覆蓋
import { handOverDispatchedChords, installSequenceCommandReactivity, sequenceCommands } from "./sequenceCommands";
// M2.15 音訊片段編輯（分離音訊、增益 / 淡化、閃避、音軌右鍵、序列設定）：同樣獨立一行
import { audioClipCommands, installAudioClipCommandReactivity } from "./audioClipCommands";
// App 自動更新（說明 › 檢查更新…）：同樣獨立一行
import { UPDATER_COMMANDS } from "../updater/commands";

/**
 * 核心指令 ＋ 外掛的指令批次，依登記順序排好（選單的分段依「第一次出現」排序，位置決定分段在選單裡的先後）：
 * 沒指定位置的外掛批次接在追蹤指令後面、輸出指令前面；指定 before / after 的插在那個指令旁邊。
 */
function withPluginCommands(head: readonly Command[], tail: readonly Command[]): Command[] {
  const batches = plugins().flatMap((p) => p.commands ?? []);
  const list: Command[] = [...head, ...batches.filter((b) => !b.before && !b.after).flatMap((b) => b.commands), ...tail];
  for (const b of batches) {
    const anchor = b.before ?? b.after;
    if (!anchor) continue;
    const i = list.findIndex((c) => c.id === anchor);
    if (i < 0) list.push(...b.commands);
    else list.splice(b.before ? i : i + 1, 0, ...b.commands);
  }
  return list;
}

/**
 * 登記進註冊表的整張指令表（測試用同一份驗撞鍵 / id 重複）。`sequence` = 序列剪輯旗標（省略 = 目前的設定）。
 * Delete / Shift+Delete / B / ↑↓ 交給序列剪輯的派發指令（sequenceCommands.ts 開頭的說明）：原主人要先過 handOver 改成只顯示鍵，
 * 不然同一顆鍵會同時打到兩個指令。旗標關著時派發指令一律轉回原主人，行為跟 M1 相同。
 */
export function commandList(sequence?: boolean): Command[] {
  const main = withPluginCommands([...coreCommands(), ...objectCommands(), ...TRACK_COMMANDS], [...EXPORT_COMMANDS, ...MEDIA_INFO_COMMANDS, ...CAPTION_COMMANDS]);
  return [...handOverDispatchedChords(main), ...(sequence === undefined ? sequenceCommands() : sequenceCommands(sequence)), ...(sequence === undefined ? audioClipCommands() : audioClipCommands(sequence))];
}

/**
 * 把所有指令登記進註冊表。App 掛載時呼叫一次；熱更新重跑也沒關係（upsert）。
 */
export function installCommands(): () => void {
  setCommandHost({ info: toast.info, error: toast.error, errMessage });
  registerCommands(commandList());
  // 自動更新的指令沒有快捷鍵，不必過 handOver；分開一行登記，免得跟上面那一行的清單互相覆蓋
  registerCommands(UPDATER_COMMANDS);
  const offCore = installCommandReactivity();
  // 序列指令的可用狀態看焦點 / 片段選取 / 序列本身 / 實驗旗標（旗標變了整張序列指令表重新登記）
  const offSequence = installSequenceCommandReactivity();
  const offAudioClip = installAudioClipCommandReactivity();
  // 字幕指令的可用狀態掛在字幕 store 上，跟核心的 guards 分開訂閱；卸載時兩個都要退訂
  const offCaptions = installCaptionCommandReactivity();
  // 物件選取 session（舞台工具「選取物件」）變了：「追蹤這個物件」的可用狀態跟著變
  const offObjects = installObjectCommandReactivity();
  // 外掛的啟用（它自己的 store 的反應性訂閱之類）
  const offPlugins = plugins().map((p) => p.activate?.());
  return () => {
    offCore();
    offCaptions();
    offObjects();
    offSequence();
    offAudioClip();
    for (const off of offPlugins) off?.();
  };
}

export { runCommand, command, commandsIn, useEnabled, useCommandTick } from "./registry";
export type { Command, CommandGroup, Enabled, Surface } from "./types";
