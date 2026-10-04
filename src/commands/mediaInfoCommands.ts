import { Info } from "lucide-react";
import { openMediaInfo } from "../store/dialogs";
import { useProject } from "../store/project";
import { needsMedia } from "./guards";
import type { Command } from "./types";

/**
 * 媒體資訊（計畫 M1 §3）。放在自己的檔：資訊群組與其他群組同時開發，core.ts 是大家都在改的檔。
 *
 * - `media.info` 是正式 id：選單、命令面板、Ctrl+I（Premiere 的 Get Properties / FCP 的 Info inspector 都是 ⌘I 一族）。
 * - `view.mediaInfo` 是別名：右鍵選單與傳輸列的資訊晶片照規格 §2 用這個 id 取指令。別名**不綁快捷鍵、不上選單 / 命令面板**，
 *   否則快捷鍵說明與命令面板會各出現兩次；它只給用 id 取指令的表面（右鍵、工具列晶片）用。
 */
const run = () => openMediaInfo(useProject.getState().activeMediaId);

export const MEDIA_INFO_COMMANDS: Command[] = [
  {
    id: "media.info",
    title: "媒體資訊…",
    group: "file",
    section: "媒體",
    icon: Info,
    shortcuts: ["Ctrl+I"],
    keywords: ["media info", "mediainfo", "properties", "codec", "fps", "vfr", "bitrate", "color", "metadata", "ffprobe"],
    surfaces: ["menu", "palette", "context"],
    enabled: needsMedia,
    run,
  },
  {
    id: "view.mediaInfo",
    title: "媒體資訊…",
    group: "view",
    icon: Info,
    surfaces: ["context", "toolbar"],
    enabled: needsMedia,
    run,
  },
];
