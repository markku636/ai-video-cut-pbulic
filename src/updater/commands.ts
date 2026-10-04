import { RefreshCw } from "lucide-react";
import { OK } from "../commands/registry";
import type { Command } from "../commands/types";
import { checkForUpdatesManually } from "./store";

/**
 * 自動更新的指令（說明選單 / 命令面板）。title 是 zh key（registry 會 t() 過）；
 * 這個目錄在 scripts/check-i18n.mjs 的 TABLE_SOURCES 裡，漏翻會擋。
 */
export const UPDATER_COMMANDS: Command[] = [
  {
    id: "help.checkUpdates",
    title: "檢查更新…",
    group: "help",
    section: "說明",
    icon: RefreshCw,
    keywords: ["update", "upgrade", "version", "check for updates"],
    enabled: () => OK,
    run: () => void checkForUpdatesManually(),
  },
];
