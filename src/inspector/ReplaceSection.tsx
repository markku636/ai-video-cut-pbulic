import { ImagePlus, Trash2 } from "lucide-react";
import { useT } from "../i18n";
import { REPLACE_FITS, REPLACE_LOOPS, type ReplaceFit, type ReplaceKind, type ReplaceLoop, type ReplaceV1, type TrackV1 } from "../project/format";
import { IMAGE_EXTS, REPLACE_FIT_LABEL, REPLACE_LOOP_LABEL, replaceWithFile, VIDEO_EXTS } from "../fx/replace";
import { useEdits } from "../store/edits";
import { pickOpenFile } from "../ui";
import { Input, Segmented, Select } from "../ui/index";
import { baseName } from "./FxFields";

/**
 * Inspector「替換」區塊（只有平面 track）：圖片或影片貼進解出來的四邊形。存進 track.replace（契約 §3），每個動作一筆 undo。
 * 舞台預覽（暫停、選中這條 track 時）走 comp.preview_composite：圖片＝這一幀合成；影片＝只看第一幀；
 * fit 在預覽裡一律拉伸貼滿四角，contain / cover 以輸出為準（引擎 render 負責）。
 */
export default function ReplaceSection({ mediaId, track }: { mediaId: string; track: TrackV1 }) {
  const t = useT();
  const rep = track.replace;
  const kind: ReplaceKind = rep?.kind ?? "image";
  const set = (next: ReplaceV1 | null, coalesce?: string) => useEdits.getState().setTrackReplace(mediaId, track.id, next, coalesce ? { coalesceKey: `replace:${track.id}:${coalesce}` } : {});

  const pick = async (k: ReplaceKind) => {
    const p = await pickOpenFile(k === "video" ? [{ name: t("影片"), extensions: VIDEO_EXTS }] : [{ name: t("圖片"), extensions: IMAGE_EXTS }]);
    if (p) set(replaceWithFile(rep, p, k));
  };

  return (
    <section className="space-y-2" data-testid="replace-section">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-fg/70">{t("替換")}</span>
        {rep && (
          <button type="button" className="ml-auto grid h-6 w-6 place-items-center rounded text-fg/50 hover:bg-fg/10 hover:text-fg" title={t("拿掉替換")} aria-label={t("拿掉替換")} onClick={() => set(null)}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {!rep ? (
        <div className="space-y-1.5">
          <div className="text-[11px] text-fg/45">{t("把一張圖或一段影片貼進這個平面（螢幕、海報、招牌），跟著追蹤走。")}</div>
          <div className="flex gap-1.5">
            <button type="button" className="inline-flex items-center gap-1 rounded border border-fg/15 px-2 py-1 text-[12px] text-fg/75 hover:border-accent/50 hover:text-accent" onClick={() => void pick("image")}>
              <ImagePlus size={13} />
              {t("選圖片…")}
            </button>
            <button type="button" className="inline-flex items-center gap-1 rounded border border-fg/15 px-2 py-1 text-[12px] text-fg/75 hover:border-accent/50 hover:text-accent" onClick={() => void pick("video")}>
              <ImagePlus size={13} />
              {t("選影片…")}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-[12px]">
          <Segmented<ReplaceKind>
            options={[
              { value: "image", label: t("圖片") },
              { value: "video", label: t("影片") },
            ]}
            value={kind}
            onChange={(k) => set({ ...rep, kind: k })}
            full
            ariaLabel={t("替換的種類")}
          />
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate rounded border border-fg/10 px-2 py-1 text-fg/80" title={rep.path}>
              {baseName(rep.path)}
            </span>
            <button type="button" className="shrink-0 rounded px-2 py-1 text-fg/60 hover:bg-fg/10" onClick={() => void pick(kind)}>
              {t("換一個…")}
            </button>
          </div>
          <label className="grid grid-cols-[88px_1fr] items-center gap-2">
            <span className="text-[11px] text-fg/55">{t("貼法")}</span>
            <Select value={rep.fit} onChange={(e) => set({ ...rep, fit: e.target.value as ReplaceFit })}>
              {REPLACE_FITS.map((f) => (
                <option key={f} value={f}>
                  {t(REPLACE_FIT_LABEL[f])}
                </option>
              ))}
            </Select>
          </label>
          {kind === "video" && (
            <>
              <label className="grid grid-cols-[88px_1fr] items-center gap-2">
                <span className="text-[11px] text-fg/55">{t("起點偏移")}</span>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    step={1}
                    className="mono"
                    value={rep.offsetFrames}
                    onChange={(e) => {
                      const n = Math.trunc(Number(e.target.value));
                      if (Number.isFinite(n)) set({ ...rep, offsetFrames: n }, "offset");
                    }}
                  />
                  <span className="shrink-0 text-[11px] text-fg/40">{t("幀")}</span>
                </div>
              </label>
              <label className="grid grid-cols-[88px_1fr] items-center gap-2">
                <span className="text-[11px] text-fg/55">{t("播完之後")}</span>
                <Select value={rep.loop} onChange={(e) => set({ ...rep, loop: e.target.value as ReplaceLoop })}>
                  {REPLACE_LOOPS.map((l) => (
                    <option key={l} value={l}>
                      {t(REPLACE_LOOP_LABEL[l])}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="text-[11px] text-fg/45">{t("起點偏移：替換影片的第 0 幀對到這條追蹤的第幾幀之後（可以是負的）。舞台預覽只顯示影片的第一幀。")}</div>
            </>
          )}
          {rep.fit !== "stretch" && <div className="text-[11px] text-fg/45">{t("舞台預覽一律拉伸貼滿四角；{fit}的效果以輸出為準。", { fit: t(REPLACE_FIT_LABEL[rep.fit]) })}</div>}
        </div>
      )}
    </section>
  );
}
