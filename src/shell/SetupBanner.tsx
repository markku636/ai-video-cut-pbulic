import { AlertTriangle, Copy, Cpu, Download, Power, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { openSettings } from "../commands/appActions";
import { useT } from "../i18n";
import { openDialog } from "../store/dialogs";
import { errMessage } from "../api";
import { engineState, ffmpegFix, platformFamily, useEngine, type FfmpegFix, type InstallCommand, type Translate } from "../store/engine";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { copyToClipboard, toast } from "../ui";
import Icon from "../ui/Icon";
import { Button } from "../ui/index";

type Tone = "danger" | "warning" | "info";

const TONE: Record<Tone, string> = {
  danger: "bg-danger/10 text-danger border-danger/20",
  warning: "bg-warning/10 text-warning border-warning/20",
  info: "bg-info/10 text-info border-info/20",
};

/**
 * 可複製的安裝指令（一列一個套件管理器）。橫幅與安裝面板共用：
 * 指令要**整行看得到、一鍵複製**，只給「請安裝 ffmpeg」四個字的話，macOS / Linux 使用者還得自己去查 brew / apt 怎麼打。
 */
export function InstallCommandList({ commands, className = "" }: { commands: InstallCommand[]; className?: string }) {
  const t = useT();
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`} data-testid="ffmpeg-install-commands">
      {commands.map((c) => (
        <span key={c.id} className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 opacity-80">{c.label}</span>
          <code className="min-w-0 truncate rounded bg-inset px-1.5 py-0.5 font-mono text-[11px] text-fg/80 select-all" title={c.cmd}>
            {c.cmd}
          </code>
          <Button size="sm" variant="ghost" icon={Copy} className="!h-6 !px-2 shrink-0" onClick={() => void copyToClipboard(c.cmd, t("已複製"))}>
            {t("複製")}
          </Button>
          {c.note && <span className="shrink-0 text-[11px] opacity-70">{c.note}</span>}
        </span>
      ))}
    </div>
  );
}

function ffmpegMissingText(fix: FfmpegFix, t: Translate): string {
  switch (fix.kind) {
    case "reinstall":
      return t("找不到內建的 ffmpeg：安裝目錄不完整（可能被防毒軟體隔離），請重新安裝 AI Video Cut，或指定 ffmpeg 路徑。");
    case "install":
      return t("找不到 ffmpeg：讀影片、建 proxy、輸出都要用到。這個平台的安裝檔不內建，在終端機執行下面的指令，裝好後按「重新檢查」。");
    default:
      return t("找不到 ffmpeg：無法讀取影片資訊、建 proxy 或輸出。");
  }
}

/** Mac 裝的是 PyPI 的 PyTorch（沒有 CUDA runtime），「CUDA、約 6 GB」是 Windows 實測值，放在 Mac 上兩個字都不對。 */
function engineMissingText(hasMedia: boolean, mac: boolean, t: Translate): string {
  if (hasMedia) {
    return mac
      ? t("引擎尚未安裝：影片已在清單裡，但建 proxy / 追蹤 / 輸出都要先裝引擎（一次，數 GB）。")
      : t("引擎尚未安裝：影片已在清單裡，但建 proxy / 追蹤 / 輸出都要先裝引擎（一次，約 6 GB）。");
  }
  return mac ? t("引擎尚未安裝：第一次使用要先裝引擎（Python + PyTorch MPS，數 GB，一次就好）。") : t("引擎尚未安裝：第一次使用要先裝引擎（Python + CUDA，約 6 GB，一次就好）。");
}

/**
 * 設定問題「在咬到人的地方」說清楚：同時只顯示一條，優先序 ffmpeg 缺 → 引擎未安裝 → 引擎故障 → 引擎未啟動。
 * 引擎未就緒時**擋住開影片的後半段**（proxy / 追蹤 / 輸出），但 probe / 指紋照跑讓清單先出現（計畫 §9）。
 * ffmpeg 排第一還有一個原因：macOS / Linux 先裝引擎的話，要下載完數 GB 才會在最後的閘門因為缺 ffmpeg 失敗。
 */
export default function SetupBanner() {
  const t = useT();
  const loaded = useSettings((s) => s.loaded);
  const ffmpeg = useSettings((s) => s.ffmpeg);
  const ffmpegProbing = useSettings((s) => s.probing);
  const info = useEngine((s) => s.info);
  const pyenv = useEngine((s) => s.pyenv);
  const platform = useEngine((s) => s.platform);
  const probing = useEngine((s) => s.probing);
  const hasMedia = useProject((s) => s.media.length > 0);

  if (!loaded) return null;
  const st = engineState({ info });
  const mac = platformFamily(platform, pyenv) === "macos";

  let tone: Tone;
  let icon: LucideIcon;
  let text: string;
  let action: React.ReactNode;
  // 第二列（安裝指令）：只有 ffmpeg 缺、而且這個平台有指令可給時才出現，其他橫幅維持一列
  let detail: React.ReactNode = null;

  if (ffmpeg && !ffmpeg.found) {
    const fix = ffmpegFix(platform, t);
    tone = "danger";
    icon = AlertTriangle;
    text = ffmpegMissingText(fix, t);
    if (fix.kind === "install") detail = <InstallCommandList commands={fix.commands} />;
    action = (
      <>
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={ffmpegProbing} onClick={() => void useSettings.getState().probeAll()}>
          {t("重新檢查")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => openSettings("ffmpeg")}>
          {t("指定 ffmpeg 路徑")}
        </Button>
      </>
    );
  } else if (pyenv && pyenv.state !== "ready" && pyenv.state !== "installing") {
    tone = pyenv.state === "broken" ? "danger" : "warning";
    icon = Download;
    text =
      pyenv.state === "broken"
        ? t("引擎環境有問題：{msg}", { msg: pyenv.message || t("閘門沒過") })
        : pyenv.state === "stale"
          ? t("引擎環境過期（相依套件變了）：重新安裝才能追蹤與輸出。")
          : engineMissingText(hasMedia, mac, t);
    action = (
      <>
        <Button size="sm" variant="ghost" loading={probing} onClick={() => void useEngine.getState().probePyEnv()}>
          {t("重新檢查")}
        </Button>
        <Button size="sm" variant="primary" icon={Download} onClick={() => openDialog("engineSetup", { autoStart: false })}>
          {t("安裝引擎")}
        </Button>
      </>
    );
  } else if (st === "broken") {
    tone = "danger";
    icon = AlertTriangle;
    text = t("引擎故障：{msg}", { msg: info?.last_exc || t("行程結束") });
    action = (
      <Button size="sm" variant="primary" icon={Power} onClick={() => void useEngine.getState().start().catch((e) => toast.error(errMessage(e)))}>
        {t("重新啟動引擎")}
      </Button>
    );
  } else if (st === "down" && hasMedia && pyenv?.state === "ready") {
    tone = "info";
    icon = Cpu;
    text = t("引擎已安裝但尚未啟動：啟動後會自動建 proxy 並偵測鏡頭。");
    action = (
      <Button size="sm" variant="primary" icon={Power} onClick={() => void useEngine.getState().start().catch((e) => toast.error(errMessage(e)))}>
        {t("啟動引擎")}
      </Button>
    );
  } else return null;

  return (
    <div role="status" className={`shrink-0 px-3 py-1.5 text-xs border-b ${TONE[tone]}`} data-testid="setup-banner">
      <div className="flex items-center gap-3">
        <Icon icon={icon} size={14} />
        <span className="flex-1 min-w-0 truncate" title={text}>
          {text}
        </span>
        <span className="flex items-center gap-1 shrink-0">{action}</span>
      </div>
      {/* 對齊文字起點：14 px 圖示 + gap-3 */}
      {detail && <div className="mt-1 pl-[26px]">{detail}</div>}
    </div>
  );
}
