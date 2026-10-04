import { ArrowUpCircle } from "lucide-react";
import { useT } from "../i18n";
import { openDialog } from "../store/dialogs";
import Icon from "../ui/Icon";
import { progressPct } from "./policy";
import { useUpdater } from "./store";

/**
 * 狀態列上的「有新版本」：只在找到新版之後出現（背景檢查略過的版本、已是最新都不顯示），點了開更新對話框。
 * 下載 / 安裝期間顯示進度，對話框關掉也看得到還在跑。失敗與「已下載、等你安裝」各有自己的字，不只靠顏色分辨。
 */
export default function UpdateIndicator() {
  const t = useT();
  const phase = useUpdater((s) => s.phase);
  const update = useUpdater((s) => s.update);
  const progress = useUpdater((s) => s.progress);
  const error = useUpdater((s) => s.error);
  if (!update) return null;
  const pct = progressPct(progress);
  const label =
    phase === "downloading"
      ? pct == null
        ? t("下載更新中…")
        : t("下載更新 {pct}%", { pct })
      : phase === "verifying"
        ? t("驗證更新檔…")
        : phase === "ready"
          ? t("更新已下載，點此安裝")
          : phase === "installing" || phase === "restarting"
            ? t("正在安裝更新…")
            : phase === "error"
              ? t("更新失敗，點此重試")
              : t("新版本 v{version}", { version: update.version });
  const title =
    phase === "error" && error
      ? t("更新到 v{version} 失敗：{msg}", { version: update.version, msg: error })
      : t("目前 v{current}，可以更新到 v{version}", { current: update.currentVersion, version: update.version });
  return (
    <button
      type="button"
      onClick={() => openDialog("update")}
      className={`flex items-center gap-1.5 shrink-0 hover:text-fg/70 ${phase === "error" ? "text-warning" : "text-accent"}`}
      title={title}
      data-testid="status-update"
    >
      <Icon icon={ArrowUpCircle} size={12} />
      {label}
    </button>
  );
}
