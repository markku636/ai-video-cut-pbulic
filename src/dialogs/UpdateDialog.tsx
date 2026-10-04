import { useEffect } from "react";
import { ArrowUpCircle, CheckCircle2, Download, RefreshCw, ShieldAlert } from "lucide-react";
import { useT } from "../i18n";
import { Button, Modal } from "../ui/index";
import Icon from "../ui/Icon";
import { updaterApi } from "../updater/api";
import { disabledReason, formatBytes, progressPct, releaseDate } from "../updater/policy";
import { checkForUpdatesManually, isBusy, useUpdater } from "../updater/store";

/**
 * 更新對話框：目前版本 → 新版本、發布日期、這一版的說明（純文字）、下載進度，
 * 按鈕「稍後 / 略過這個版本 / 安裝並重新啟動」；下載中「取消下載 / 在背景繼續」。
 *
 * 下載在 Rust 跑：對話框關掉不會中斷，狀態列照樣顯示進度，再點一次回到這裡；下載完如果對話框關著，store 會把它叫回來
 * 停在 ready，等使用者自己按安裝（他可能正在編輯）。正在安裝（停引擎、收 ffmpeg、App 即將關閉）時對話框關不掉。
 * 守門（有工作在跑、專案沒存）在 store 的 install() 裡，這裡只負責呈現。
 *
 * 無障礙：進度條是 role="progressbar"（有百分比才帶 aria-valuenow），階段文字在 aria-live 區、錯誤是 role="alert" ——
 * 用螢幕閱讀器的人也要知道下載到哪、App 即將關閉、或失敗了。
 */
export default function UpdateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const status = useUpdater((s) => s.status);
  const phase = useUpdater((s) => s.phase);
  const update = useUpdater((s) => s.update);
  const error = useUpdater((s) => s.error);

  useEffect(() => {
    if (!useUpdater.getState().status) void useUpdater.getState().loadStatus();
  }, []);

  const busy = isBusy(phase);
  const downloading = phase === "downloading" || phase === "verifying";
  // 安裝階段已經在停引擎、App 馬上要關：不讓對話框被關掉，免得使用者以為還能繼續編輯
  const closable = phase !== "installing";
  const close = closable ? onClose : () => {};
  const date = releaseDate(update?.date);
  const current = update?.currentVersion ?? status?.currentVersion ?? __APP_VERSION__;

  const footer = update ? (
    busy ? (
      <>
        {phase === "restarting" && error && (
          <Button variant="primary" onClick={() => void updaterApi.relaunch().catch(() => {})}>
            {t("重新啟動")}
          </Button>
        )}
        {downloading && (
          <Button variant="ghost" className="mr-auto" onClick={() => void useUpdater.getState().cancelDownload()} data-testid="update-cancel">
            {t("取消下載")}
          </Button>
        )}
        {closable && <Button onClick={onClose}>{t("在背景繼續")}</Button>}
      </>
    ) : (
      <>
        <Button variant="ghost" className="mr-auto" onClick={() => void useUpdater.getState().skip()} data-testid="update-skip">
          {t("略過這個版本")}
        </Button>
        <Button onClick={onClose} data-testid="update-later">
          {t("稍後")}
        </Button>
        <Button variant="primary" icon={Download} disabled={!status?.enabled || status.devBuild} onClick={() => void useUpdater.getState().install()} data-testid="update-install">
          {phase === "error" ? t("重試安裝") : t("安裝並重新啟動")}
        </Button>
      </>
    )
  ) : (
    <>
      <Button onClick={onClose}>{t("關閉")}</Button>
      <Button variant="primary" icon={RefreshCw} loading={phase === "checking"} disabled={status ? !status.enabled : false} onClick={() => void checkForUpdatesManually()}>
        {t("檢查更新")}
      </Button>
    </>
  );

  return (
    <Modal open onClose={close} dismissOnBackdrop={closable} title={t("軟體更新")} icon={ArrowUpCircle} size="md" footer={footer}>
      <div className="space-y-4" data-testid="update-dialog">
        {status && !status.enabled && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
            <Icon icon={ShieldAlert} size={14} className="mt-0.5 shrink-0" />
            <span>{t("自動更新已停用：{reason}", { reason: disabledReason(status, t) })}</span>
          </div>
        )}

        {update ? (
          <>
            <div>
              <div className="text-base font-semibold tabular-nums">{t("新版本 v{version}", { version: update.version })}</div>
              <div className="text-[12px] text-fg/50 tabular-nums">
                {date ? t("目前 v{current} · 發布於 {date}", { current, date }) : t("目前 v{current}", { current })}
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] text-fg/45 uppercase tracking-wide">{t("這一版的變更")}</div>
              {update.notes ? (
                <div className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-fg/10 bg-inset px-3 py-2 text-[12px] leading-relaxed text-fg/80" data-testid="update-notes">
                  {update.notes}
                </div>
              ) : (
                <div className="text-[12px] text-fg/40">{t("（這一版沒有附上說明）")}</div>
              )}
            </div>
            {status?.devBuild && <div className="text-[12px] text-warning">{t("開發版不能安裝更新：請用安裝檔版本測試")}</div>}
            {phase === "ready" ? (
              <div className="text-[12px] text-fg/70" data-testid="update-ready">
                {t("更新檔已下載並驗過簽章。安裝會先停止引擎、關閉 App，裝好後自動重新開啟；專案有未儲存的變更會先問你要不要儲存。")}
              </div>
            ) : (
              !busy && phase !== "error" && <div className="text-[12px] text-fg/50">{t("安裝前會先停止引擎；App 會關閉，裝好後自動重新開啟。專案有未儲存的變更會先問你要不要儲存。")}</div>
            )}
          </>
        ) : phase === "checking" ? (
          <div className="text-sm text-fg/60">{t("正在檢查更新…")}</div>
        ) : phase === "upToDate" ? (
          <div className="flex items-center gap-2 text-sm text-success">
            <Icon icon={CheckCircle2} size={16} />
            {t("已是最新版本（v{version}）", { version: current })}
          </div>
        ) : (
          !error && <div className="text-sm text-fg/60">{t("目前版本 v{version}", { version: current })}</div>
        )}

        <UpdateProgress />

        {error && (
          <div role="alert" className="text-[12px] text-danger break-words whitespace-pre-wrap">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 下載 / 驗簽 / 安裝的進度（aria-live：階段變了螢幕閱讀器會念）。 */
function UpdateProgress() {
  const t = useT();
  const phase = useUpdater((s) => s.phase);
  const progress = useUpdater((s) => s.progress);
  const pct = progressPct(progress);
  const line =
    phase === "downloading"
      ? progress?.total
        ? t("下載中 {got} / {total}", { got: formatBytes(progress.downloaded), total: formatBytes(progress.total) })
        : t("下載中 {got}", { got: formatBytes(progress?.downloaded ?? 0) })
      : phase === "verifying"
        ? t("驗證簽章…")
        : phase === "installing"
          ? t("正在安裝：App 會關閉，裝好後自動重新開啟")
          : phase === "restarting"
            ? t("已安裝，正在重新啟動…")
            : null;
  return (
    <div aria-live="polite">
      {line && (
        <div className="space-y-1" data-testid="update-progress">
          <div className="flex items-center justify-between text-[12px] text-fg/70">
            <span>{line}</span>
            {phase === "downloading" && pct != null && <span className="tabular-nums">{pct}%</span>}
          </div>
          <div
            className="h-1.5 rounded-full bg-fg/10 overflow-hidden"
            role="progressbar"
            aria-label={line}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase === "downloading" ? (pct ?? undefined) : 100}
          >
            <div
              className={`h-full bg-accent transition-[width] ${phase === "downloading" && pct == null ? "animate-pulse" : ""}`}
              style={{ width: `${phase === "downloading" ? Math.max(2, pct ?? 100) : 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
