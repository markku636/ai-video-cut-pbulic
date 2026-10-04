import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Cpu, Download, Power, RefreshCw } from "lucide-react";
import { api, errMessage, listenJob, type PyEnvInstallEvent } from "../api";
import { useT } from "../i18n";
import { InstallCommandList } from "../shell/SetupBanner";
import { offlineComponents } from "./offlineComponents";
import { engineState, ffmpegFix, gpuName, hardwareRows, platformFamily, useEngine, type FfmpegFix, type Translate } from "../store/engine";
import { newJobId } from "../store/jobs";
import { useSettings } from "../store/settings";
import { copyToClipboard, toast } from "../ui";
import Icon from "../ui/Icon";
import { Button, Modal } from "../ui/index";

/**
 * 引擎安裝 / 檢查（計畫 §9 `engineSetup{autoStart}`；UX 沿用 ai-music-cut LocalAsrSetup 的兩段式安裝）：
 * - **先給人看實際會執行的指令**再按（會動到數 GB 磁碟，不講清楚就按下去是不對的）；
 * - **輸出逐行顯示**（下載 torch 要幾分鐘，只給一顆轉圈分不出是在跑還是掛了）；
 * - **硬體需求用人話、依平台**（store/engine.ts hardwareRows：Windows / Linux 講 NVIDIA / CUDA / sm_XY，
 *   macOS 講 Apple Silicon / MPS / macOS 14，不讓一台可以用的 Mac 亮一排 NVIDIA 警告）；
 * - **ffmpeg 缺就先講**：bootstrap 最後的 doctor 閘門會檢查 ffmpeg，缺了是在數 GB 下載完之後才失敗；
 * - 「順便下載模型」勾選（不先抓的話，第一次偵測時才下載，那時使用者正等著看結果）。
 */
const STEP_LABEL: Record<string, string> = {
  base: "準備",
  uv: "下載 uv",
  venv: "建立 Python 3.12 環境",
  torch: "安裝 PyTorch（CUDA 13）",
  deps: "安裝相依套件",
  wheel: "安裝 aivc 引擎",
  gate: "硬體閘門檢查",
  models: "下載模型",
};

/** macOS 的 bootstrap 從 PyPI 裝 MPS 版 torch（沒有 CUDA 13），同一個 `torch` 步驟換一個標籤。 */
const STEP_LABEL_MACOS: Record<string, string> = {
  torch: "安裝 PyTorch（MPS）",
};

/** 「約 6 GB」是 Windows（cu130 torch 自帶 CUDA runtime）的實測值；Mac 的 PyPI torch 小很多但沒實測，只講數 GB。 */
function installBlurb(ready: boolean, mac: boolean, t: Translate): string {
  if (ready) return mac ? t("重新安裝會重建整個 venv（數 GB、幾分鐘）；相依套件變了才需要。") : t("重新安裝會重建整個 venv（約 6 GB、幾分鐘）；相依套件變了才需要。");
  return mac
    ? t("按下安裝會在引擎資料根建立 Python 3.12 venv、從 PyPI 抓 PyTorch（MPS）與 SAM 2.1，數 GB、需要幾分鐘。下面就是實際會執行的指令。")
    : t("按下安裝會在引擎資料根建立 Python 3.12 venv、抓 CUDA 13 的 PyTorch 與 SAM 2.1，約 6 GB、需要幾分鐘。下面就是實際會執行的指令。");
}

/** ffmpeg 缺時放在安裝按鈕上面：bootstrap 最後的 doctor 閘門會因為缺 ffmpeg 失敗，而那是在下載完之後。 */
function FfmpegFirstNotice({ fix }: { fix: FfmpegFix }) {
  const t = useT();
  return (
    <div className="rounded-md border border-warning/30 bg-warning/10 p-2 space-y-1.5 text-[12px] text-warning" data-testid="engine-setup-ffmpeg-missing">
      <div className="flex items-start gap-1.5">
        <Icon icon={AlertTriangle} size={14} className="mt-px shrink-0" />
        <span>
          {fix.kind === "reinstall"
            ? t("先處理 ffmpeg：找不到內建的 ffmpeg（安裝目錄不完整），請先重新安裝 AI Video Cut。安裝引擎最後的檢查需要 ffmpeg，缺了會在下載完之後才失敗。")
            : t("先裝 ffmpeg：安裝引擎最後的檢查需要 ffmpeg，缺了會在數 GB 下載完之後才失敗。")}
        </span>
      </div>
      {fix.kind === "install" && <InstallCommandList commands={fix.commands} className="pl-5" />}
    </div>
  );
}

export default function EngineSetupDialog({ autoStart = false, onClose }: { autoStart?: boolean; onClose: () => void }) {
  const t = useT();
  const pyenv = useEngine((s) => s.pyenv);
  const info = useEngine((s) => s.info);
  const probing = useEngine((s) => s.probing);
  const platform = useEngine((s) => s.platform);
  const ffmpeg = useSettings((s) => s.ffmpeg);
  const samVariant = useSettings((s) => s.s.engine.sam_variant);
  const [withModels, setWithModels] = useState(true);
  const [cmd, setCmd] = useState<string[] | null>(null);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const autoStarted = useRef(false);

  useEffect(() => {
    api
      .pyenvInstallCommand(withModels)
      .then((c) => {
        setCmd(c);
        setCmdError(null);
      })
      .catch((e) => {
        setCmd(null);
        setCmdError(errMessage(e));
      });
  }, [withModels]);

  // 新的一行永遠看得到，否則使用者要一直自己往下捲
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const install = async () => {
    const jobId = newJobId();
    setRunning(true);
    setLog([]);
    setStep("base");
    const un = await listenJob<PyEnvInstallEvent>("pyenv-install", jobId, (p) => {
      if (p.kind === "step") setStep(p.step ?? null);
      // 只留最後 400 行：pip / uv 裝依賴時會吐很長一串，全部留著會把面板拖慢
      else if (p.kind === "line" && p.line != null) setLog((l) => [...l, p.line!].slice(-400));
    });
    try {
      const ok = await api.pyenvInstall(jobId, withModels);
      if (ok) {
        toast.success(t("引擎安裝完成"));
        await useEngine.getState().start().catch(() => {});
      } else toast.error(t("安裝沒有成功，看下面的輸出找原因"));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      un();
      setRunning(false);
      setStep(null);
      void useEngine.getState().probePyEnv();
    }
  };

  // ffmpeg 已確定找不到（null = 還沒探完，不算缺）：安裝最後的 doctor 閘門必定失敗，先講清楚
  const ffmpegMissing = !!ffmpeg && !ffmpeg.found;

  useEffect(() => {
    // 自動開始前也先看 ffmpeg：缺它時自動跑下去只會白下載數 GB，留給使用者看完提示再自己按
    if (autoStart && cmd && !autoStarted.current && !ffmpegMissing && pyenv && pyenv.state !== "ready" && pyenv.state !== "installing") {
      autoStarted.current = true;
      void install();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, cmd, pyenv?.state, ffmpegMissing]);

  const ready = pyenv?.state === "ready";
  const st = engineState({ info });
  const gpu = gpuName({ info, pyenv });
  const cmdLine = cmd?.join(" ") ?? "";
  const mac = platformFamily(platform, pyenv) === "macos";
  const fix = ffmpegMissing ? ffmpegFix(platform, t) : null;
  const stepLabel = (s: string) => t((mac ? STEP_LABEL_MACOS[s] : undefined) ?? STEP_LABEL[s] ?? s);

  // 硬體需求：用人話講閘門的每一條（依平台換列）
  const hw = hardwareRows({ platform, pyenv, gpu }, t);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("安裝 / 檢查引擎")}
      icon={Cpu}
      size="lg"
      footer={
        <>
          {ready && st !== "ready" && (
            <Button icon={Power} onClick={() => void useEngine.getState().start().then(() => toast.success(t("引擎已啟動"))).catch((e) => toast.error(errMessage(e)))}>
              {t("啟動引擎")}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {t("關閉")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-fg/10 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={ready ? "text-success font-medium" : pyenv?.state === "installing" ? "text-info" : "text-warning font-medium"}>
              {!pyenv ? t("檢查中…") : ready ? t("引擎環境：可以使用") : pyenv.state === "installing" ? t("引擎環境：安裝中") : pyenv.state === "stale" ? t("引擎環境：過期") : pyenv.state === "broken" ? t("引擎環境：損壞") : t("引擎環境：尚未安裝")}
            </span>
            <span className="text-fg/45 text-[12px] truncate">{pyenv?.message}</span>
            <Button size="sm" variant="ghost" icon={RefreshCw} className="ml-auto" loading={probing} onClick={() => void useEngine.getState().probePyEnv()}>
              {t("重新檢查")}
            </Button>
          </div>
          <div className="text-[12px] text-fg/60 space-y-0.5">
            <div className="text-[11px] text-fg/45 uppercase tracking-wide">{t("硬體需求")}</div>
            {hw.map((h) => (
              <div key={h.id} data-hw={h.id} className={h.ok === true ? "text-success" : h.ok === false ? "text-warning" : "text-fg/50"}>
                {h.ok === true ? "✓ " : h.ok === false ? "! " : "· "}
                {h.text}
              </div>
            ))}
            {pyenv?.python && <div className="mono text-[11px] text-fg/40 truncate">{pyenv.python}</div>}
          </div>
          <div className="text-[12px] text-fg/60 space-y-0.5" data-testid="engine-components">
            <div className="text-[11px] text-fg/45 uppercase tracking-wide">{t("使用的離線模型與元件")}</div>
            {offlineComponents(t, samVariant, pyenv?.torch ?? null).map((c) => (
              <div key={c.name} className="leading-snug">
                <span className="text-fg/80">{c.name}</span>
                <span className="text-fg/45">：{c.role}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-fg/10 p-3 space-y-2">
          <div className="text-[11px] text-fg/45 uppercase tracking-wide">{t("常駐引擎")}</div>
          <div className="text-[12px] text-fg/60">
            {t("狀態：{state}", { state: st })}
            {info?.pid ? ` · PID ${info.pid}` : ""}
            {info?.restarts ? ` · ${t("10 分鐘內重啟 {n} 次", { n: info.restarts })}` : ""}
          </div>
          {info?.last_exc && <div className="text-[11px] text-danger break-all mono">{info.last_exc}</div>}
        </div>

        <div className="space-y-2">
          <div className="text-fg/60 text-[12px]">{installBlurb(ready, mac, t)}</div>
          {fix && <FfmpegFirstNotice fix={fix} />}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={withModels} disabled={running} onChange={(e) => setWithModels(e.target.checked)} />
            <span className="text-fg/70">{t("順便下載模型（SAM 2.1 hiera-small，建議）")}</span>
          </label>
          {cmdError && <div className="text-[12px] text-warning">{cmdError}</div>}
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-inset px-2 py-1 font-mono text-[11px] select-all" title={cmdLine}>
              {cmdLine || "—"}
            </code>
            <Button size="sm" variant="ghost" disabled={!cmdLine} onClick={() => void copyToClipboard(cmdLine, t("已複製"))}>
              {t("複製")}
            </Button>
            <Button size="sm" variant="primary" icon={Download} loading={running} disabled={running || !cmd} onClick={() => void install()}>
              {ready ? t("重新安裝") : t("開始安裝")}
            </Button>
          </div>
          {(running || log.length > 0) && (
            <div className="space-y-1">
              {step && <div className="text-accent text-[12px]">{stepLabel(step)}…</div>}
              <pre ref={logRef} className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-inset px-2 py-1 font-mono text-[10px] leading-4 text-fg/60">
                {log.join("\n")}
              </pre>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
