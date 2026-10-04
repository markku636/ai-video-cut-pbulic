import { useMemo, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useT } from "../i18n";
import { effectiveInsert, INSERT_KEYS, pluginLevelKeys, type EdgeFalloff, type GrainMode, type InsertDefaultsV1, type InsertMacro, type InsertV1, type ResampleKernel, type SheenLock, type ShutterPhase } from "../project/format";
import { sheenLocks } from "../project/vocab";
import { useEdits } from "../store/edits";
import { useProject } from "../store/project";
import { INSERT_MACRO_LABEL } from "../video/labels";
import { Button, Field, Input, Modal, Segmented, Select } from "../ui/index";

const EMPTY: never[] = [];
const MACROS: InsertMacro[] = ["conservative", "standard", "full", "custom"];
type GroupKey = "edge" | "occlusion" | "motionBlur" | "resample" | "relight" | "grain";
const GROUPS: GroupKey[] = ["edge", "occlusion", "motionBlur", "resample", "relight", "grain"];
const GROUP_LABEL: Record<GroupKey, string> = {
  edge: "羽化 Feather",
  occlusion: "遮擋 Occlusion",
  motionBlur: "動態模糊 Motion Blur",
  resample: "重取樣 Resampling",
  relight: "重打光 Relight",
  grain: "顆粒 Grain",
};

/**
 * 插入參數（計畫 §9 Insert 面板 / `insertOptions{trackId}`；分組依 Mocha Insert Module）。
 * 頂端三段巨集 保守／標準／完整替換；「進階」每一組可勾「覆寫」—— 沒勾 = null = 繼承專案 insertDefaults
 * （Silhouette「Default」哨兵），專案層改預設會跟著動。動態模糊語意採 Nuke / BCC：快門角度 × 取樣數 × 相位（決策 17）。
 */
export default function InsertOptionsDialog({ mediaId, trackId, onClose }: { mediaId: string; trackId: string; onClose: () => void }) {
  const t = useT();
  const track = useEdits((s) => (s.tracks[mediaId] ?? EMPTY).find((x) => x.id === trackId) ?? null);
  const defaults = useProject((s) => s.insertDefaults);
  const [macro, setMacro] = useState<InsertMacro>(track?.insert?.macro ?? defaults.macro);
  const [own, setOwn] = useState<InsertV1>(() => ({ ...(track?.insert ?? { macro: defaults.macro }) }));
  const [advanced, setAdvanced] = useState(!!track?.insert && Object.keys(track.insert).length > 1);

  const effective: InsertDefaultsV1 = useMemo(() => effectiveInsert(defaults, { ...own, macro }), [defaults, own, macro]);
  if (!track) return null;

  const has = (k: keyof InsertV1) => own[k] !== undefined;
  const setGroup = <K extends GroupKey>(k: K, v: InsertV1[K] | undefined) => setOwn((o) => ({ ...o, [k]: v }));
  const toggleGroup = (k: GroupKey) => (has(k) ? setGroup(k, undefined) : setGroup(k, effective[k] as never));
  const setScalar = (k: "opacity" | "applyMix", v: number | undefined) => setOwn((o) => ({ ...o, [k]: v }));

  const save = () => {
    // 這個對話框不編的鍵（外掛的設定組，例如牌外掛的 flip / paperRatio / smoothing / print）：下面是整份 replace，
    // 先從原本的 insert 帶過來，不能洗掉。順序照外掛宣告的順序，其餘不認得的接在後面
    const before = (track.insert ?? {}) as unknown as Record<string, unknown>;
    const declared = pluginLevelKeys("insertKeys") ?? [];
    const carried = [...declared, ...Object.keys(before).filter((k) => !declared.includes(k))].filter((k) => !INSERT_KEYS.includes(k) && before[k] !== undefined);
    const out: InsertV1 = { ...Object.fromEntries(carried.map((k) => [k, before[k]])), macro };
    for (const k of Object.keys(own) as (keyof InsertV1)[]) if (k !== "macro" && own[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = own[k];
    const isDefaultOnly = Object.keys(out).length === 1 && macro === defaults.macro;
    // 這個對話框是「整份編輯」：沒勾的群組就是要拿掉，所以 replace 而不是合併
    useEdits.getState().setTrackInsert(mediaId, trackId, isDefaultOnly ? null : out, { replace: true });
    onClose();
  };

  const num = (v: number, set: (n: number) => void, opts: { min?: number; max?: number; step?: number } = {}) => (
    <Input type="number" value={v} min={opts.min} max={opts.max} step={opts.step ?? 0.1} onChange={(e) => set(Number(e.target.value))} className="mono" />
  );

  const group = (k: GroupKey, body: ReactNode) => (
    <div key={k} className="rounded-md border border-fg/10 p-3 space-y-2">
      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" checked={has(k)} onChange={() => toggleGroup(k)} />
        <span className="text-fg/80">{t(GROUP_LABEL[k])}</span>
        <span className="ml-auto text-fg/40">{has(k) ? t("覆寫") : t("繼承專案預設")}</span>
      </label>
      {has(k) && <div className="grid grid-cols-3 gap-3">{body}</div>}
    </div>
  );

  const e = effective;
  return (
    <Modal
      open
      onClose={onClose}
      title={t("插入參數：{name}", { name: track.label })}
      icon={SlidersHorizontal}
      size="lg"
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
      <div className="space-y-4 text-sm">
        <Segmented full ariaLabel={t("巨集")} value={macro} onChange={setMacro} options={MACROS.map((m) => ({ value: m, label: t(INSERT_MACRO_LABEL[m]) }))} />
        <div className="text-[12px] text-fg/55">
          {macro === "conservative" ? t("保守：邊緣多吃 1 px、不透明度 95%，新表面的邊界看起來像原本就在那裡。") : macro === "full" ? t("完整替換：邊緣緊貼、100% 不透明，適合近景、乾淨的平面。") : macro === "standard" ? t("標準：§6.6 表的預設值（720p・30fps・固定機位調出來的）。") : t("自訂：巨集不覆寫任何東西，全部看下面的值。")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("不透明度 {v}%", { v: e.opacity })}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={has("opacity")} onChange={() => setScalar("opacity", has("opacity") ? undefined : e.opacity)} title={t("覆寫")} />
              <input type="range" min={0} max={100} disabled={!has("opacity")} value={e.opacity} onChange={(ev) => setScalar("opacity", Number(ev.target.value))} className="flex-1 accent-[rgb(var(--c-accent))]" />
            </div>
          </Field>
          <Field label={t("Apply Mix {v}%", { v: e.applyMix })}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={has("applyMix")} onChange={() => setScalar("applyMix", has("applyMix") ? undefined : e.applyMix)} title={t("覆寫")} />
              <input type="range" min={0} max={100} disabled={!has("applyMix")} value={e.applyMix} onChange={(ev) => setScalar("applyMix", Number(ev.target.value))} className="flex-1 accent-[rgb(var(--c-accent))]" />
            </div>
          </Field>
        </div>

        <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? t("收起進階") : t("進階…")}
        </button>
        {advanced && (
          <div className="space-y-2">
            {GROUPS.map((k) => {
              switch (k) {
                case "edge":
                  return group(k, (
                    <>
                      <Field label={t("邊緣侵蝕 px")}>{num(e.edge.choke, (v) => setGroup("edge", { ...e.edge, choke: v }))}</Field>
                      <Field label={t("柔邊 px")}>{num(e.edge.softness, (v) => setGroup("edge", { ...e.edge, softness: v }))}</Field>
                      <Field label={t("衰減")}>
                        <Select value={e.edge.falloff} onChange={(ev) => setGroup("edge", { ...e.edge, falloff: ev.target.value as EdgeFalloff })}>
                          <option value="linear">linear</option>
                          <option value="smoothstep">smoothstep</option>
                        </Select>
                      </Field>
                    </>
                  ));
                case "occlusion":
                  return group(k, (
                    <>
                      <Field label={t("膨脹 px")}>{num(e.occlusion.dilate, (v) => setGroup("occlusion", { ...e.occlusion, dilate: v }))}</Field>
                      <Field label={t("羽化 px")}>{num(e.occlusion.feather, (v) => setGroup("occlusion", { ...e.occlusion, feather: v }))}</Field>
                    </>
                  ));
                case "motionBlur":
                  return group(k, (
                    <>
                      <Field label={t("快門角度°")} hint={t("180° = 0.5 幀")}>{num(e.motionBlur.shutterAngle, (v) => setGroup("motionBlur", { ...e.motionBlur, shutterAngle: v }), { min: 0, max: 360, step: 1 })}</Field>
                      <Field label={t("快門相位")}>
                        <Select value={e.motionBlur.shutterPhase} onChange={(ev) => setGroup("motionBlur", { ...e.motionBlur, shutterPhase: ev.target.value as ShutterPhase })}>
                          <option value="centered">centered</option>
                          <option value="start">start</option>
                          <option value="end">end</option>
                        </Select>
                      </Field>
                      <Field label={t("取樣數")}>
                        <Select value={String(e.motionBlur.samples)} onChange={(ev) => setGroup("motionBlur", { ...e.motionBlur, samples: ev.target.value === "auto" ? "auto" : Number(ev.target.value) })}>
                          <option value="auto">auto</option>
                          {[1, 3, 5, 7, 9].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </>
                  ));
                case "resample":
                  return group(k, (
                    <>
                      <Field label={t("核心")}>
                        <Select value={e.resample.kernel} onChange={(ev) => setGroup("resample", { ...e.resample, kernel: ev.target.value as ResampleKernel })}>
                          {["nearest", "bilinear", "bicubic", "lanczos3"].map((x) => (
                            <option key={x} value={x}>
                              {x}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("Clamp")} hint={t("白底黑字這種高對比細節不 clamp 會振鈴")}>
                        <label className="flex items-center gap-2 h-7">
                          <input type="checkbox" checked={e.resample.clamp} onChange={(ev) => setGroup("resample", { ...e.resample, clamp: ev.target.checked })} />
                          {e.resample.clamp ? t("開") : t("關")}
                        </label>
                      </Field>
                    </>
                  ));
                case "relight":
                  return group(k, (
                    <>
                      <Field label={t("保留高光 %")}>{num(e.relight.keepHighlights, (v) => setGroup("relight", { ...e.relight, keepHighlights: v }), { min: 0, max: 100, step: 1 })}</Field>
                      <Field label={t("反光鎖定")}>
                        <Select value={e.relight.sheenLock} onChange={(ev) => setGroup("relight", { ...e.relight, sheenLock: ev.target.value as SheenLock })}>
                          {/* 核心的 plate ＋ 外掛加的值（例如 cards 的 card）；不認得的值（沒裝的外掛的）照樣列出來，選單不能把它弄丟 */}
                          {sheenLocks().map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label ? t(v.label) : v.id}
                            </option>
                          ))}
                          {!sheenLocks().some((v) => v.id === e.relight.sheenLock) && <option value={e.relight.sheenLock}>{e.relight.sheenLock}</option>}
                        </Select>
                      </Field>
                    </>
                  ));
                case "grain":
                  return group(k, (
                    <>
                      <Field label={t("模式")}>
                        <Select value={e.grain.mode} onChange={(ev) => setGroup("grain", { ...e.grain, mode: ev.target.value as GrainMode })}>
                          <option value="measured">measured</option>
                          <option value="synthetic">synthetic</option>
                        </Select>
                      </Field>
                      <Field label={t("強度 %")}>{num(e.grain.amount, (v) => setGroup("grain", { ...e.grain, amount: v }), { min: 0, max: 200, step: 1 })}</Field>
                    </>
                  ));
              }
            })}
          </div>
        )}
        <div className="text-[11px] text-fg/40">{t("插入參數只影響合成，不影響解算；改完預覽會重算，不必重追。")}</div>
      </div>
    </Modal>
  );
}
