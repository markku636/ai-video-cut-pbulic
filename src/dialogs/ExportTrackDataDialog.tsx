import { useEffect, useState } from "react";
import { Clipboard, FileText, Save } from "lucide-react";
import { errMessage } from "../api";
import { saveTrackDataFile } from "../commands/appActions";
import { exportTrackData, type TrackDataResult } from "../export/trackData";
import { useT } from "../i18n";
import type { TrackDataFlavour, TrackDataFormat } from "../project/format";
import { useEdits } from "../store/edits";
import { engineReady } from "../store/engine";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { TRACK_DATA_FORMAT_LABEL } from "../video/labels";
import { copyToClipboard } from "../ui";
import { Button, Field, Input, Modal, Segmented, Select } from "../ui/index";

const EMPTY: never[] = [];

/**
 * 匯出追蹤資料（計畫 §9 `exportTrackData{format}`；決策 18）：Nuke CornerPin2D `.nk` | After Effects 角釘文字；
 * 口味：僅角釘 / 角釘＋變換（讓 AE 圖層動態模糊生效）；烘焙 / 連結；[複製到剪貼簿] 與 [存成檔案] 並列。
 * 文字由引擎 `export.track` 產生（匯出器只有 Python 一份）；參數一變就重新要一份預覽（防抖 250 ms）。
 */
export default function ExportTrackDataDialog({ mediaId, format: initialFormat, trackId: initialTrack, onClose }: { mediaId: string; format?: TrackDataFormat; trackId?: string; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const defaults = useProject((s) => s.exportDefaults);
  const setExportDefaults = useProject((s) => s.setExportDefaults);
  const tracks = useEdits((s) => s.tracks[mediaId] ?? EMPTY);
  const selected = useTimeline((s) => s.selectedTrackId);

  const [format, setFormat] = useState<TrackDataFormat>(initialFormat ?? defaults.trackData.format);
  const [flavour, setFlavour] = useState<TrackDataFlavour>(defaults.trackData.flavour);
  const [baked, setBaked] = useState(defaults.trackData.baked);
  const [frameOffset, setFrameOffset] = useState<string>(String(defaults.trackData.frameOffset));
  const [trackId, setTrackId] = useState(initialTrack ?? selected ?? tracks[0]?.id ?? "");
  const [preview, setPreview] = useState<TrackDataResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const track = tracks.find((x) => x.id === trackId) ?? null;
  const offset = frameOffset.trim() === "" ? null : Math.round(Number(frameOffset));
  const opts = { format, flavour, baked, frameOffset: offset != null && Number.isFinite(offset) ? offset : null };
  const engineOk = engineReady();

  useEffect(() => {
    if (!trackId || !engineOk) return;
    let alive = true;
    setLoading(true);
    const id = window.setTimeout(() => {
      exportTrackData(mediaId, trackId, opts)
        .then((r) => {
          if (!alive) return;
          setPreview(r);
          setError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setPreview(null);
          setError(errMessage(e));
        })
        .finally(() => alive && setLoading(false));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
    // opts 是每次 render 新物件；用它的欄位當 dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, trackId, format, flavour, baked, opts.frameOffset, engineOk]);

  const remember = () => setExportDefaults({ ...defaults, trackData: { format, flavour, baked, frameOffset: opts.frameOffset ?? defaults.trackData.frameOffset } });
  const text = preview?.text ?? "";
  const lines = text.split("\n").slice(0, 24).join("\n");

  return (
    <Modal
      open
      onClose={onClose}
      title={t("匯出追蹤資料")}
      icon={FileText}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button
            icon={Clipboard}
            disabled={!text}
            onClick={() => {
              remember();
              void copyToClipboard(text, t("已複製到剪貼簿，到 {app} 貼上即可", { app: format === "nuke" ? "Nuke" : "After Effects" }));
            }}
          >
            {t("複製到剪貼簿")}
          </Button>
          <Button
            variant="primary"
            icon={Save}
            disabled={!preview || !engineOk}
            onClick={() => {
              remember();
              void saveTrackDataFile(mediaId, trackId, opts, `${(media?.name ?? "track").replace(/\.[^.]+$/, "")}-${track?.label ?? trackId}`);
            }}
          >
            {t("存成檔案…")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {!engineOk && <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("引擎尚未就緒：追蹤資料由引擎產生，要先安裝並啟動引擎。")}</div>}
        <Segmented
          full
          ariaLabel={t("格式")}
          value={format}
          onChange={setFormat}
          options={(["nuke", "ae"] as TrackDataFormat[]).map((f) => ({ value: f, label: t(TRACK_DATA_FORMAT_LABEL[f]) }))}
        />
        <div className="grid grid-cols-4 gap-3">
          <Field label={t("追蹤")}>
            <Select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
              {tracks.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                  {x.stale ? `（${t("待重解")}）` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("口味")} hint={format === "ae" ? t("「角釘＋變換」多給一組位置，AE 圖層自己的動態模糊才算得出來") : t("Nuke 只有角釘")}>
            <Select value={flavour} disabled={format === "nuke"} onChange={(e) => setFlavour(e.target.value as TrackDataFlavour)}>
              <option value="cornerpin">{t("僅角釘")}</option>
              <option value="cornerpin+transform">{t("角釘＋變換")}</option>
            </Select>
          </Field>
          <Field label={t("關鍵幀")} hint={t("連結 = 多一行註解記 solve.v1.json 的位置（Nuke）")}>
            <Select value={baked ? "baked" : "linked"} onChange={(e) => setBaked(e.target.value === "baked")}>
              <option value="baked">{t("烘焙（內嵌曲線）")}</option>
              <option value="linked">{t("連結 solve.v1.json")}</option>
            </Select>
          </Field>
          <Field label={t("幀號偏移")} hint={t("留空＝引擎預設（Nuke 1、AE 0）")}>
            <Input type="number" value={frameOffset} onChange={(e) => setFrameOffset(e.target.value)} placeholder="—" className="mono" />
          </Field>
        </div>
        <div className="text-[12px] text-fg/55">
          {loading ? t("引擎產生中…") : error ? <span className="text-danger">{error}</span> : preview ? t("可匯出 {n} 幀（lost 的幀略過）· {w}×{h} @ {fps}", { n: preview.keys, w: preview.size[0], h: preview.size[1], fps: `${preview.fps.num}/${preview.fps.den}` }) : t("（沒有內容）")}
          {preview?.linked && <span className="ml-2 mono text-fg/40">{preview.linked}</span>}
        </div>
        <pre className="max-h-56 overflow-auto rounded bg-inset px-2 py-1.5 font-mono text-[10px] leading-4 text-fg/60 whitespace-pre">{lines || t("（沒有內容）")}</pre>
        <div className="text-[11px] text-fg/40">
          {format === "nuke" ? t("Nuke：貼到 Node Graph 會直接長出一個 CornerPin2D；to1..to4 = 左下、右下、右上、左上，y 已翻成 Nuke 座標。") : t("After Effects：選取圖層上的 Corner Pin 效果後 Ctrl+V。角釘欄位對應仍在驗證，貼不上請回報。")}
        </div>
      </div>
    </Modal>
  );
}
