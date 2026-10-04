import { useState } from "react";
import { BookOpen, Bug, Copy, ExternalLink, Info, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { APP_NAME, REPO_URL, TOOL_PAGE_URL } from "../brand";
import { useT } from "../i18n";
import { useEngine } from "../store/engine";
import { useSettings } from "../store/settings";
import { copyToClipboard } from "../ui";
import Icon from "../ui/Icon";
import { Modal } from "../ui/index";
import { offlineComponents } from "./offlineComponents";

/**
 * 關於（計畫 §9）。版本旁邊要有複製鈕（回報問題時附上）、連結一律用系統瀏覽器開、檔案位置收起來不要一開場就佔版面。
 * 一行隱私承諾「本機 GPU 運算，影片不上傳，不用於訓練」是這個工具跟雲端服務最大的差別，放在最顯眼的地方。
 */
export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const paths = useSettings((s) => s.paths);
  const samVariant = useSettings((s) => s.s.engine.sam_variant);
  const torchVersion = useEngine((s) => s.pyenv?.torch ?? null);
  const [showPaths, setShowPaths] = useState(false);
  const [showModels, setShowModels] = useState(false);
  // 使用者要求（2026-09-19）：有用到的離線模型／元件都要列出來，含 OpenCV；與「安裝／檢查引擎」共用同一份（offlineComponents.ts）。
  const components = offlineComponents(t, samVariant, torchVersion);

  const open = (url: string) => void api.openExternal(url).catch(() => {});
  const links: { icon: typeof ExternalLink; label: string; url: string }[] = [
    { icon: ExternalLink, label: t("GitHub 專案"), url: REPO_URL },
    { icon: BookOpen, label: t("作者部落格"), url: TOOL_PAGE_URL },
    { icon: Bug, label: t("回報問題"), url: `${REPO_URL}/issues/new` },
  ];

  return (
    <Modal open onClose={onClose} title={t("關於 {app}", { app: APP_NAME })} icon={Info} size="sm">
      <div className="flex flex-col items-center text-center gap-1 py-2">
        <img src="/app-icon.png" alt={APP_NAME} className="w-28 h-28 mb-1" draggable={false} />
        <div className="text-lg font-semibold">{APP_NAME}</div>
        <div className="flex items-center gap-1 text-xs text-fg/40 tabular-nums">
          <span>
            {t("版本")} {__APP_VERSION__}
          </span>
          <button
            type="button"
            onClick={() => void copyToClipboard(`${APP_NAME} v${__APP_VERSION__}`, t("已複製版本資訊"))}
            title={t("複製版本資訊（回報問題時附上）")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg hover:bg-fg/10"
          >
            <Icon icon={Copy} size={12} />
          </button>
        </div>
        <p className="text-sm text-fg/60 mt-1 leading-relaxed">{t("追蹤影片裡的任何東西，再打碼、替換或加特效：SAM 2.1 遮罩、平面追蹤、比值重打光合成；編輯一格，套用整個鏡頭。")}</p>

        <div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-3 py-1.5 text-[13px] text-success">
          <Icon icon={ShieldCheck} size={14} />
          {t("本機 GPU 運算，影片不上傳，不用於訓練")}
        </div>

        <div className="mt-3 flex flex-wrap justify-center items-center gap-1">
          {links.map((l) => (
            <button key={l.label} type="button" onClick={() => open(l.url)} className="inline-flex items-center gap-1.5 text-[13px] text-fg/60 hover:text-fg hover:bg-fg/5 rounded px-2 py-1">
              <Icon icon={l.icon} size={13} />
              {l.label}
            </button>
          ))}
        </div>

        {paths && (
          <div className="mt-2 w-full">
            <button type="button" onClick={() => setShowPaths((v) => !v)} className="text-[11px] text-fg/40 hover:text-fg/70">
              {showPaths ? t("隱藏檔案位置") : t("檔案位置")}
            </button>
            {showPaths && (
              <div className="mt-1 space-y-0.5 text-left text-[11px]">
                {(
                  [
                    [t("設定"), paths.config_dir],
                    [t("快取"), paths.cache_dir],
                    [t("引擎資料"), paths.data_root],
                    [t("日誌"), paths.logs_dir],
                  ] as const
                ).map(([label, p]) => (
                  <button key={label} type="button" className="block w-full text-left text-fg/50 hover:text-accent break-all" onClick={() => void api.openPath(p).catch(() => {})}>
                    {label}：{p}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 w-full">
          <button type="button" onClick={() => setShowModels((v) => !v)} className="text-[11px] text-fg/40 hover:text-fg/70" data-testid="about-models-toggle">
            {showModels ? t("隱藏模型清單") : t("使用的離線模型與元件")}
          </button>
          {showModels && (
            <div className="mt-1 text-left text-[11px]" data-testid="about-models">
              <div className="text-fg/40 mb-1">{t("全部在本機執行；模型只在首次安裝時下載。")}</div>
              <ul className="space-y-1">
                {components.map((c) => (
                  <li key={c.name} className="leading-snug">
                    <span className="text-fg/80">{c.name}</span>
                    <span className="text-fg/45">：{c.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-3 text-[11px] text-fg/35">{t("MIT 授權 · Tauri + React 打造 · 內建 ffmpeg（LGPL）")}</div>
      </div>
    </Modal>
  );
}
