import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";
import { toast } from "../ui";
import { Button, Field, Input } from "../ui/index";
import { disabledReason, endpointProblem, releaseDate } from "./policy";
import { checkForUpdatesManually, useUpdater } from "./store";

/**
 * 設定 › 常用 › 「更新」：狀態（啟用 / 停用的原因）、目前版本、上次檢查、自動檢查開關、立即檢查、更新來源覆寫（進階）、
 * 取消略過的版本。外框與 SettingsDialog 的 Section 同一套樣式（那個元件沒有匯出，這裡照抄外觀）。
 */
export default function UpdateSettingsSection() {
  const t = useT();
  const s = useSettings((x) => x.s.updater);
  const save = useSettings((x) => x.save);
  const status = useUpdater((x) => x.status);
  const phase = useUpdater((x) => x.phase);
  const [endpoint, setEndpoint] = useState(s.update_endpoint);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => setEndpoint(s.update_endpoint), [s.update_endpoint]);
  useEffect(() => {
    void useUpdater.getState().loadStatus();
  }, [s.update_endpoint]);

  const commit = (patch: Partial<typeof s>) => save({ updater: { ...useSettings.getState().s.updater, ...patch } });

  const commitEndpoint = async () => {
    const v = endpoint.trim();
    const why = endpointProblem(v, t);
    setProblem(why);
    if (why || v === s.update_endpoint) return;
    await commit({ update_endpoint: v });
    toast.success(v ? t("更新來源已改成 {url}", { url: v }) : t("更新來源已改回內建的"));
  };

  // 私有建置（allowEndpointOverride: false）：填了也不會用，欄位直接鎖住並講原因
  const overrideLocked = status != null && !status.overrideAllowed;
  const last = s.last_update_check > 0 ? new Date(s.last_update_check) : null;
  const lastText = last ? `${releaseDate(last.toISOString())} ${String(last.getHours()).padStart(2, "0")}:${String(last.getMinutes()).padStart(2, "0")}` : null;

  return (
    <div className="space-y-2" data-testid="settings-updates">
      <div className="text-[11px] text-fg/45 uppercase tracking-wide">{t("更新")}</div>
      <div className="min-w-0 overflow-x-hidden rounded-md border border-fg/10 p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className={status?.enabled ? "text-success" : "text-warning"}>
            {status == null ? t("檢查中…") : status.enabled ? t("自動更新：可以使用") : t("自動更新已停用：{reason}", { reason: disabledReason(status, t) })}
          </span>
          <Button size="sm" variant="primary" icon={RefreshCw} className="ml-auto" loading={phase === "checking"} disabled={!status?.enabled} onClick={() => void checkForUpdatesManually()} data-testid="settings-update-check">
            {t("立即檢查")}
          </Button>
        </div>
        <div className="text-[11px] text-fg/45 tabular-nums">
          {t("目前版本 v{version}", { version: status?.currentVersion ?? __APP_VERSION__ })}
          {" · "}
          {lastText ? t("上次檢查：{when}", { when: lastText }) : t("還沒檢查過")}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={s.auto_check_updates} onChange={(e) => void commit({ auto_check_updates: e.target.checked })} data-testid="settings-update-auto" />
          <span>
            {t("自動檢查更新")}
            <span className="block text-[11px] text-fg/45">{t("啟動後在背景檢查，一天最多一次；找到新版只在狀態列提示，不會自己安裝。")}</span>
          </span>
        </label>
        {s.skipped_update_version && (
          <div className="flex items-center gap-2 text-[12px] text-fg/60">
            <span>{t("已略過 v{version}", { version: s.skipped_update_version })}</span>
            <Button size="sm" variant="ghost" onClick={() => void commit({ skipped_update_version: "" })}>
              {t("不再略過")}
            </Button>
          </div>
        )}
        <Field
          label={t("更新來源（進階）")}
          error={problem}
          hint={
            overrideLocked
              ? t("這個版本固定用內建的更新來源，不接受覆寫。")
              : t("留空＝用內建的來源。只接受 https；測試用的本機伺服器可以用 http://localhost 或 http://127.0.0.1。")
          }
        >
          <Input
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              if (problem) setProblem(null);
            }}
            onBlur={() => void commitEndpoint()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitEndpoint();
            }}
            invalid={!!problem}
            disabled={overrideLocked}
            className="mono"
            spellCheck={false}
            placeholder={status?.defaultEndpoint ?? ""}
            data-testid="settings-update-endpoint"
          />
        </Field>
      </div>
    </div>
  );
}
