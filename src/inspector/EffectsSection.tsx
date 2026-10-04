import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, Eye, Plus, Sparkles, Trash2 } from "lucide-react";
import { useT } from "../i18n";
import type { EffectType, EffectV1, JsonValueLite, TrackV1 } from "../project/format";
import { EFFECT_TYPES } from "../project/format";
import { addEffect, moveEffect, newEffect, removeEffect, setEnabled, setParams } from "../fx/effect";
import { useFxPreview } from "../fx/preview";
import { FX_SPECS, FX_TYPE_LABEL, specOf } from "../fx/schema";
import { stackErrors, validateEffect } from "../fx/validate";
import { CAPTION_PRESETS, effectiveStyle } from "../store/captions";
import { OBJECT_EDIT_LABEL, useEdits } from "../store/edits";
import { pickOpenFile } from "../ui";
import { Badge, Select } from "../ui/index";
import { FxFieldEditor, type FxChange } from "./FxFields";

/**
 * Inspector「效果」區塊（物件 track 與平面 track 共用）：加 / 刪 / 排序 / 開關特效，每種特效一張由 fx/schema.ts 產生的表單。
 * 每個動作一筆 undo（拖數值、打字合併成一筆：coalesceKey）；存進 track.effects（契約：{id, enabled, type, ...params}）。
 *
 * 套用順序＝清單順序（後面的看得到前面的結果）；關掉的特效留在清單裡但不送引擎。
 * 舞台預覽（暫停時）由 fx/preview.ts 管：這裡只放開關。
 */
export default function EffectsSection({ mediaId, track }: { mediaId: string; track: TrackV1 }) {
  const t = useT();
  const effects = useMemo(() => track.effects ?? [], [track.effects]);
  const live = useFxPreview((s) => s.live);
  const setLive = useFxPreview((s) => s.setLive);
  const [open, setOpen] = useState<string | null>(null);
  const captionTrack = useEdits((s) => s.captions[mediaId] ?? null);
  const captionFont = useMemo(() => (captionTrack ? effectiveStyle(captionTrack).font : CAPTION_PRESETS.subtitle.style.font), [captionTrack]);
  const errors = stackErrors(effects);

  const commit = (next: EffectV1[], coalesce?: string) => useEdits.getState().setTrackEffects(mediaId, track.id, next, OBJECT_EDIT_LABEL.effects, coalesce ? { coalesceKey: `fx:${track.id}:${coalesce}` } : {});

  const add = async (type: EffectType) => {
    let image: string | undefined;
    if (type === "sticker") {
      // 貼紙一定要有圖：先選，取消就不加
      const p = await pickOpenFile([{ name: "PNG / WebP / JPEG", extensions: ["png", "webp", "jpg", "jpeg"] }]);
      if (!p) return;
      image = p;
    }
    const e = newEffect(type, { label: track.label, image });
    commit(addEffect(useEdits.getState().tracks[mediaId]?.find((x) => x.id === track.id)?.effects, e));
    setOpen(e.id);
  };

  return (
    <section className="space-y-2" data-testid="effects-section">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-fg/70">{t("效果")}</span>
        {effects.length > 0 && <Badge tone="neutral">{effects.length}</Badge>}
        {errors > 0 && (
          <span title={t("有 {n} 個欄位引擎不會收：修正前這些特效不會預覽，輸出時也會出錯", { n: errors })}>
            <Badge tone="danger">{t("{n} 個錯", { n: errors })}</Badge>
          </span>
        )}
        <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-fg/55" title={t("暫停時在舞台上看套用後的樣子")}>
          <input type="checkbox" checked={live} onChange={(ev) => setLive(ev.target.checked)} />
          <Eye size={12} />
          {t("舞台預覽")}
        </label>
      </div>

      {effects.length === 0 && <div className="text-[11px] text-fg/45">{t("還沒有效果：加一個馬賽克、模糊、調色、描邊、光暈、貼紙或文字，它會跟著這個物件走。")}</div>}

      {effects.length > 0 && (
        <ol className="space-y-1.5">
          {effects.map((e, i) => (
            <EffectCard
              key={e.id}
              e={e}
              index={i}
              count={effects.length}
              open={open === e.id}
              act={{
                toggleOpen: () => setOpen(open === e.id ? null : e.id),
                enabled: (on) => commit(setEnabled(effects, e.id, on)),
                move: (dir) => commit(moveEffect(effects, e.id, dir)),
                remove: () => commit(removeEffect(effects, e.id)),
                change: (patch, opts) => commit(setParams(effects, e.id, patch), opts?.coalesce),
              }}
              captionFont={captionFont}
            />
          ))}
        </ol>
      )}

      <div className="flex items-center gap-1.5">
        <Plus size={13} className="text-fg/45" />
        <Select
          value=""
          aria-label={t("加入效果")}
          onChange={(ev) => {
            const v = ev.target.value as EffectType;
            ev.target.value = "";
            if (v) void add(v);
          }}
        >
          <option value="">{t("加入效果…")}</option>
          {EFFECT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(FX_TYPE_LABEL[type])} — {t(FX_SPECS[type].line)}
            </option>
          ))}
        </Select>
      </div>
    </section>
  );
}

interface CardActions {
  toggleOpen: () => void;
  enabled: (on: boolean) => void;
  move: (dir: -1 | 1) => void;
  remove: () => void;
  change: FxChange;
}

function EffectCard({ e, index, count, open, act, captionFont }: { e: EffectV1; index: number; count: number; open: boolean; act: CardActions; captionFont: { families: readonly string[]; weight: number; file?: string | null } }) {
  const t = useT();
  const type = String(e.type ?? "").trim().toLowerCase();
  const spec = specOf(type);
  const issues = useMemo(() => validateEffect(e), [e]);
  const errs = issues.filter((i) => i.level === "error");
  const general = issues.filter((i) => i.key === null);
  const enabled = e.enabled !== false;
  const label = spec ? t(spec.label) : String(e.type);
  const [advanced, setAdvanced] = useState(false);
  return (
    <li className={`rounded border ${errs.length && enabled ? "border-danger/40" : "border-fg/10"} ${enabled ? "" : "opacity-60"}`} data-effect={e.id} data-effect-type={type}>
      <div className="flex items-center gap-1.5 px-2 py-1">
        <input type="checkbox" checked={enabled} aria-label={t("開關「{name}」", { name: label })} onChange={(ev) => act.enabled(ev.target.checked)} />
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left text-[12px] text-fg/85" onClick={act.toggleOpen} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Sparkles size={12} className="text-accent" />
          <span className="truncate">{label}</span>
          {errs.length > 0 && <AlertTriangle size={12} className="shrink-0 text-danger" aria-label={t("有錯")} />}
        </button>
        <CardButton label={t("往前（先套用）")} icon={ChevronUp} disabled={index === 0} onClick={() => act.move(-1)} />
        <CardButton label={t("往後（後套用）")} icon={ChevronDown} disabled={index === count - 1} onClick={() => act.move(1)} />
        <CardButton label={t("刪除效果")} icon={Trash2} onClick={act.remove} />
      </div>
      {general.map((i) => (
        <div key={i.msg} className={`px-2 pb-1 text-[11px] ${i.level === "error" ? "text-danger" : "text-warning"}`}>
          {t(i.msg, i.params)}
        </div>
      ))}
      {open && spec && (
        <div className="space-y-1.5 border-t border-fg/8 px-2 py-2">
          {spec.groups
            .filter((g) => !g.advanced)
            .map((g) => (
              <Group key={g.title ?? "main"} title={g.title}>
                {g.fields.map((f) => (
                  <FxFieldEditor key={f.key} f={f} e={e} onChange={act.change} issues={issues} captionFont={captionFont} />
                ))}
              </Group>
            ))}
          {spec.groups.some((g) => g.advanced) && (
            <button type="button" className="inline-flex items-center gap-1 text-[11px] text-fg/55 hover:text-fg/80" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t("擺放與進階")}
            </button>
          )}
          {advanced &&
            spec.groups
              .filter((g) => g.advanced)
              .map((g) => (
                <Group key={g.title ?? "adv"} title={g.title}>
                  {g.fields.map((f) => (
                    <FxFieldEditor key={f.key} f={f} e={e} onChange={act.change} issues={issues} captionFont={captionFont} />
                  ))}
                </Group>
              ))}
          <button type="button" className="text-[11px] text-fg/45 hover:text-accent" onClick={() => act.change(resetPatch(e))}>
            {t("全部回到預設")}
          </button>
        </div>
      )}
    </li>
  );
}

/** 「全部回到預設」：拿掉表單認得的參數鍵（必填的文字 / 圖片留著，不然特效直接壞掉）。 */
export function resetPatch(e: EffectV1): Record<string, JsonValueLite | undefined> {
  const spec = specOf(String(e.type ?? "").trim().toLowerCase());
  if (!spec) return {};
  const keep = new Set(["type", "text", "image"]);
  const out: Record<string, JsonValueLite | undefined> = {};
  for (const k of spec.keys) if (!keep.has(k) && e[k] !== undefined) out[k] = undefined;
  return out;
}

function Group({ title, children }: { title: string | null; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      {title && <div className="pt-1 text-[10px] uppercase tracking-wide text-fg/40">{t(title)}</div>}
      {children}
    </div>
  );
}

function CardButton({ label, icon: Glyph, disabled, onClick }: { label: string; icon: typeof Trash2; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid h-6 w-6 place-items-center rounded text-fg/50 hover:bg-fg/10 hover:text-fg disabled:opacity-30">
      <Glyph size={13} />
    </button>
  );
}
