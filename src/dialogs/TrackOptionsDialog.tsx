import { useState } from "react";
import { Settings2 } from "lucide-react";
import { useT } from "../i18n";
import type { TrackOptionField } from "../plugins/api";
import { collect } from "../plugins/registry";
import { type MotionModel, type RegionPolicy, type TrackOptionsV1 } from "../project/format";
import { defaultRegionPolicy, regionPolicies, vocabLabel } from "../project/vocab";
import { useEdits } from "../store/edits";
import { toast } from "../ui";
import { MOTION_MODEL_LABEL } from "../video/labels";
import { Button, Field, Input, Modal, Select } from "../ui/index";

const MOTION_MODELS: MotionModel[] = ["translation", "similarity", "affine", "perspective"];
const EMPTY: never[] = [];

/**
 * 追蹤選項（計畫 §9 `trackOptions{trackId}`）：名稱、動態模型階梯、平滑、區域策略、參考影格，
 * 外掛的選項欄位（例如 cards 的模板牌碼；plugins/api.ts TrackContribution.optionFields）。
 * 選項變動會標 stale（要重解）；名稱 / 區域策略不會。
 */
export default function TrackOptionsDialog({ mediaId, trackId, onClose }: { mediaId: string; trackId: string; onClose: () => void }) {
  const t = useT();
  const track = useEdits((s) => (s.tracks[mediaId] ?? EMPTY).find((x) => x.id === trackId) ?? null);
  const optionFields: TrackOptionField[] = collect((p) => p.tracks?.optionFields);
  const [label, setLabel] = useState(track?.label ?? "");
  const [motionModel, setMotionModel] = useState<MotionModel>(track?.options.motionModel ?? "perspective");
  const [smoothing, setSmoothing] = useState(track?.options.smoothing ?? 0.4);
  const [extra, setExtra] = useState<Record<string, string>>(() => {
    const opts = (track?.options ?? {}) as unknown as Record<string, unknown>;
    return Object.fromEntries(optionFields.map((f) => [f.key, typeof opts[f.key] === "string" ? (opts[f.key] as string) : ""]));
  });
  const [regionPolicy, setRegionPolicy] = useState<RegionPolicy>(track?.regionPolicy ?? defaultRegionPolicy());
  const [referenceFrame, setReferenceFrame] = useState<string>(track?.referenceFrame == null ? "" : String(track.referenceFrame));

  if (!track) return null;

  const policies = regionPolicies();

  const save = () => {
    // 外掛的欄位：先全部驗過（不合法就整份不存，跟以前模板牌碼不合法時一樣）
    const own = track.options as unknown as Record<string, unknown>;
    const parsed: Record<string, string | undefined> = {};
    for (const f of optionFields) {
      const r = f.parse(extra[f.key] ?? "");
      if ("error" in r) return toast.error(t(r.error, r.params));
      parsed[f.key] = r.value;
    }
    const e = useEdits.getState();
    const optPatch = {
      motionModel,
      smoothing: Math.max(0, Math.min(1, smoothing)),
    };
    const extraChanged = optionFields.some((f) => parsed[f.key] !== own[f.key]);
    const optChanged = optPatch.motionModel !== track.options.motionModel || optPatch.smoothing !== track.options.smoothing || extraChanged;
    if (optChanged) {
      // 外掛的欄位清空 = 拿掉那個鍵（setTrackOptions 是 merge，這裡直接組完整 options）
      const rest: Record<string, unknown> = { ...own };
      for (const f of optionFields) delete rest[f.key];
      const next: Record<string, unknown> = { ...rest, ...optPatch };
      // 清空的欄位明確寫成 undefined：merge 進 options 時才蓋得掉舊值（存檔時 undefined 的鍵不寫）
      for (const f of optionFields) next[f.key] = parsed[f.key];
      e.setTrackOptions(mediaId, trackId, next as unknown as TrackOptionsV1);
    }
    const rf = referenceFrame.trim() === "" ? null : Math.max(0, Math.round(Number(referenceFrame)));
    const fields: Partial<Pick<typeof track, "label" | "referenceFrame" | "regionPolicy">> = {};
    if (label.trim() && label.trim() !== track.label) fields.label = label.trim();
    if (regionPolicy !== track.regionPolicy) fields.regionPolicy = regionPolicy;
    if ((rf ?? null) !== (track.referenceFrame ?? null) && (rf == null || Number.isFinite(rf))) fields.referenceFrame = rf;
    if (Object.keys(fields).length) e.setTrackFields(mediaId, trackId, fields, "追蹤選項");
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("追蹤選項：{name}", { name: track.label })}
      icon={Settings2}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={save}>
            {t("套用")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label={t("名稱")}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("動態模型")} hint={t("階梯：平移 → +旋轉縮放 → 仿射 → 透視。越自由越吃特徵點。")}>
            <Select value={motionModel} onChange={(e) => setMotionModel(e.target.value as MotionModel)}>
              {MOTION_MODELS.map((m) => (
                <option key={m} value={m}>
                  {t(MOTION_MODEL_LABEL[m])}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("平滑 {pct}%", { pct: Math.round(smoothing * 100) })} hint={t("Savitzky-Golay 只平滑移動段；靜止段用中位數鎖死。使用者關鍵幀永遠是硬釘。")}>
            <input type="range" min={0} max={100} value={Math.round(smoothing * 100)} onChange={(e) => setSmoothing(Number(e.target.value) / 100)} className="w-full accent-[rgb(var(--c-accent))]" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {optionFields.map((f) => (
            <Field key={f.key} label={t(f.label)} hint={f.hint ? t(f.hint) : undefined}>
              <Input value={extra[f.key] ?? ""} onChange={(e) => setExtra((x) => ({ ...x, [f.key]: e.target.value }))} placeholder={f.placeholder} spellCheck={false} className="mono" />
            </Field>
          ))}
          <Field label={t("參考影格")} hint={t("留空＝引擎自己挑（conf>0.9 的靜止幀）")}>
            <Input type="number" value={referenceFrame} onChange={(e) => setReferenceFrame(e.target.value)} placeholder="—" className="mono" />
          </Field>
        </div>
        <Field label={t("區域策略")} hint={t("整面替換＝整個平面都換掉；保持不動＝這條只追不換。")}>
          <Select value={regionPolicy} onChange={(e) => setRegionPolicy(e.target.value as RegionPolicy)}>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {t(vocabLabel(policies, p.id))}
              </option>
            ))}
            {/* 不認得的值（沒裝的外掛加的）照樣列出來：選單不能把現在的值弄丟 */}
            {!policies.some((p) => p.id === regionPolicy) && <option value={regionPolicy}>{regionPolicy}</option>}
          </Select>
        </Field>
        {track.stale && <div className="text-[11px] text-warning">{t("這條追蹤有未重解的變更")}</div>}
      </div>
    </Modal>
  );
}
