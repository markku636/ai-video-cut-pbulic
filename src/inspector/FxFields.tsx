import { useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { useT } from "../i18n";
import type { EffectV1, JsonValueLite } from "../project/format";
import { fieldValue } from "../fx/effect";
import { FONT_FILTERS, FONT_WEIGHTS, type ColorField, type EnumField, type FileField, type FxField, type NumberField, type PairField, type TextField } from "../fx/schema";
import { colorToHex6, isAutoValue, type FxIssue } from "../fx/validate";
import { CAPTION_FONT_FAMILIES } from "../store/captions";
import { pickOpenFile } from "../ui";
import { Input, Select, Textarea } from "../ui/index";

/**
 * 特效表單的欄位元件（由 fx/schema.ts 的欄位表產生）。每個欄位只改自己的鍵：
 * onChange(key, value) —— value undefined＝拿掉這個鍵（回到引擎預設）；opts.coalesce＝拖數值 / 打字，合併成一筆 undo。
 */
export type FxChange = (patch: Record<string, JsonValueLite | undefined>, opts?: { coalesce?: string }) => void;

interface FieldProps<F extends FxField> {
  f: F;
  e: EffectV1;
  onChange: FxChange;
  issues: readonly FxIssue[];
}

/** 數值：打字時原樣存（錯的會標紅、不送預覽）；離開欄位時夾回範圍（整數欄位四捨五入）。 */
export function clampNumber(f: Pick<NumberField, "min" | "max" | "int">, n: number): number {
  const v = Math.max(f.min, Math.min(f.max, n));
  return f.int ? Math.round(v) : v;
}

/** 輸入框的文字 → 要存的值（空白＝拿掉；看不懂的照字串存，交給驗證標紅）。 */
export function parseNumberInput(text: string): JsonValueLite | undefined {
  const s = text.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

function Row({ label, unit, children, issues, hint }: { label: string; unit?: string; children: React.ReactNode; issues: readonly FxIssue[]; hint?: string }) {
  const t = useT();
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-x-2 gap-y-0.5">
      <span className="pt-1.5 text-[11px] text-fg/55">{t(label)}</span>
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">{children}</div>
          {unit && <span className="shrink-0 text-[11px] text-fg/40">{t(unit)}</span>}
        </div>
        {issues.map((i) => (
          <div key={i.msg} className="text-[11px] text-danger">
            {t(i.msg, i.params)}
          </div>
        ))}
        {!issues.length && hint && <div className="text-[11px] text-fg/40">{t(hint)}</div>}
      </div>
    </div>
  );
}

function NumberEditor({ f, e, onChange, issues }: FieldProps<NumberField>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  const auto = isAutoValue(f, v);
  const shown = typeof v === "number" ? String(v) : typeof v === "string" && !auto ? v : "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const coalesce = `${e.id}:${f.key}`;
  const slider = !auto && f.max - f.min <= 20;
  const num = typeof v === "number" ? v : Number.isFinite(f.def) ? f.def : f.min;
  return (
    <Row label={f.label} unit={f.unit} issues={issues} hint={f.hint}>
      <div className="flex items-center gap-1.5">
        {f.auto && (
          <label className="inline-flex shrink-0 items-center gap-1 text-[11px] text-fg/60">
            <input type="checkbox" checked={auto} onChange={(ev) => onChange({ [f.key]: ev.target.checked ? undefined : f.start ?? f.min })} />
            {t("自動")}
          </label>
        )}
        {slider && <input type="range" className="min-w-0 flex-1 accent-[rgb(var(--c-accent))]" min={f.min} max={f.max} step={f.step} value={num} aria-label={t(f.label)} onChange={(ev) => onChange({ [f.key]: Number(ev.target.value) }, { coalesce })} />}
        <Input
          type="text"
          inputMode="decimal"
          className={slider ? "w-16 shrink-0 text-right mono" : "w-full mono"}
          value={auto ? "" : draft}
          placeholder={auto ? t("自動") : Number.isFinite(f.def) ? String(f.def) : ""}
          disabled={auto}
          invalid={issues.length > 0}
          aria-label={t(f.label)}
          onChange={(ev) => {
            setDraft(ev.target.value);
            onChange({ [f.key]: parseNumberInput(ev.target.value) }, { coalesce });
          }}
          onBlur={() => {
            const p = parseNumberInput(draft);
            if (typeof p === "number" && clampNumber(f, p) !== p) onChange({ [f.key]: clampNumber(f, p) }, { coalesce });
          }}
        />
      </div>
    </Row>
  );
}

function EnumEditor({ f, e, onChange, issues }: FieldProps<EnumField>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  const cur = typeof v === "string" ? v.trim().toLowerCase() : f.def;
  return (
    <Row label={f.label} issues={issues} hint={f.hint}>
      <Select value={cur} aria-label={t(f.label)} onChange={(ev) => onChange({ [f.key]: ev.target.value === f.def && v === undefined ? undefined : ev.target.value })}>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.label)}
          </option>
        ))}
        {!f.options.some((o) => o.value === cur) && <option value={cur}>{cur}</option>}
      </Select>
    </Row>
  );
}

function BoolEditor({ f, e, onChange, issues }: FieldProps<Extract<FxField, { kind: "bool" }>>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  return (
    <Row label={f.label} issues={issues} hint={f.hint}>
      <input type="checkbox" className="mt-1.5" checked={typeof v === "boolean" ? v : f.def} aria-label={t(f.label)} onChange={(ev) => onChange({ [f.key]: ev.target.checked })} />
    </Row>
  );
}

/** 顏色：原本有 alpha（#RRGGBBAA）就保留 alpha，只換 RGB。 */
export function withAlphaOf(prev: JsonValueLite | undefined, hex6: string): string {
  const s = typeof prev === "string" ? prev.trim() : "";
  return /^#[0-9a-fA-F]{8}$/.test(s) ? `${hex6.toUpperCase()}${s.slice(7)}` : hex6.toUpperCase();
}

export function ColorInput({ value, onPick, label, disabled }: { value: JsonValueLite | undefined; onPick: (hex: string) => void; label: string; disabled?: boolean }) {
  const hex = colorToHex6(value) ?? "#FFFFFF";
  return (
    <span className="relative inline-flex h-7 w-10 shrink-0 overflow-hidden rounded border border-fg/15" style={{ background: disabled ? undefined : hex }}>
      <input type="color" value={hex} disabled={disabled} aria-label={label} onChange={(ev) => onPick(ev.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
    </span>
  );
}

function ColorEditor({ f, e, onChange, issues }: FieldProps<ColorField>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  const on = v !== undefined && v !== null ? true : f.def !== null;
  const cur = v ?? f.def ?? "#000000";
  return (
    <Row label={f.label} issues={issues} hint={f.hint}>
      <div className="flex items-center gap-2">
        {f.nullable && (
          <input type="checkbox" checked={on} aria-label={t(f.label)} onChange={(ev) => onChange({ [f.key]: ev.target.checked ? (f.key === "background" ? "#000000A0" : "#FFC800") : undefined })} />
        )}
        <ColorInput value={cur} label={t(f.label)} disabled={!on} onPick={(hex) => onChange({ [f.key]: withAlphaOf(v, hex) }, { coalesce: `${e.id}:${f.key}` })} />
        <span className="mono text-[11px] text-fg/50">{on ? String(colorToHex6(cur) ?? cur) : t("不用")}</span>
      </div>
    </Row>
  );
}

function TextEditor({ f, e, onChange, issues }: FieldProps<TextField>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  const s = typeof v === "string" ? v : "";
  const change = (text: string) => onChange({ [f.key]: text }, { coalesce: `${e.id}:${f.key}` });
  return (
    <Row label={f.label} issues={issues} hint={f.hint}>
      {f.multiline ? <Textarea rows={2} value={s} invalid={issues.length > 0} aria-label={t(f.label)} onChange={(ev) => change(ev.target.value)} className="w-full text-[12px]" /> : <Input value={s} invalid={issues.length > 0} aria-label={t(f.label)} onChange={(ev) => change(ev.target.value)} />}
    </Row>
  );
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function FilePick({ path, onPick, onClear, filters, label, invalid }: { path: string; onPick: (p: string) => void; onClear?: () => void; filters: FileField["filters"]; label: string; invalid?: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1">
      <span className={`min-w-0 flex-1 truncate rounded border px-2 py-1 text-[12px] ${invalid ? "border-danger/50 text-danger" : "border-fg/10 text-fg/75"}`} title={path || undefined}>
        {path ? baseName(path) : t("還沒選")}
      </span>
      <button type="button" className="grid h-7 w-7 shrink-0 place-items-center rounded text-fg/60 hover:bg-fg/10" title={t("選擇檔案…")} aria-label={label} onClick={() => void pickOpenFile([...filters]).then((p) => p && onPick(p))}>
        <FolderOpen size={14} />
      </button>
      {onClear && path && (
        <button type="button" className="grid h-7 w-7 shrink-0 place-items-center rounded text-fg/45 hover:bg-fg/10" title={t("清除")} aria-label={t("清除")} onClick={onClear}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function FileEditor({ f, e, onChange, issues }: FieldProps<FileField>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  return (
    <Row label={f.label} issues={issues} hint={f.hint}>
      <FilePick path={typeof v === "string" ? v : ""} filters={f.filters} label={t(f.label)} invalid={issues.length > 0} onPick={(p) => onChange({ [f.key]: p })} />
    </Row>
  );
}

function PairEditor({ f, e, onChange, issues }: FieldProps<PairField>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  const cur: [number, number] = Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number") ? [v[0] as number, v[1] as number] : f.def;
  const set = (i: 0 | 1, text: string) => {
    const n = Number(text);
    if (!Number.isFinite(n)) return;
    const next: [number, number] = [cur[0], cur[1]];
    next[i] = n;
    onChange({ [f.key]: next }, { coalesce: `${e.id}:${f.key}` });
  };
  return (
    <Row label={f.label} issues={issues} hint={f.hint}>
      <div className="flex gap-1.5">
        <Input type="number" step={f.step} className="mono" value={cur[0]} aria-label={`${t(f.label)} x`} onChange={(ev) => set(0, ev.target.value)} />
        <Input type="number" step={f.step} className="mono" value={cur[1]} aria-label={`${t(f.label)} y`} onChange={(ev) => set(1, ev.target.value)} />
      </div>
    </Row>
  );
}

/** 文字特效的字型：跟字幕同一組字型清單與粗細；也可以指一個字型檔。「跟字幕一樣」＝把字幕樣式的三個值抄過來。 */
function FontEditor({ e, onChange, issues, captionFont }: FieldProps<Extract<FxField, { kind: "font" }>> & { captionFont: { families: readonly string[]; weight: number; file?: string | null } }) {
  const t = useT();
  const fams = Array.isArray(e.fontFamilies) ? (e.fontFamilies as string[]) : null;
  const first = fams?.[0] ?? "";
  const weight = typeof e.fontWeight === "number" ? e.fontWeight : 700;
  const file = typeof e.fontFile === "string" ? e.fontFile : "";
  const mine = (k: string) => issues.filter((i) => i.key === k);
  return (
    <>
      <Row label="字型" issues={mine("fontFamilies")}>
        <Select value={first} aria-label={t("字型")} onChange={(ev) => onChange({ fontFamilies: ev.target.value ? [ev.target.value, ...CAPTION_FONT_FAMILIES.filter((x) => x !== ev.target.value)] : undefined })}>
          <option value="">{t("預設（跟字幕同一組）")}</option>
          {CAPTION_FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          {first && !CAPTION_FONT_FAMILIES.includes(first) && <option value={first}>{first}</option>}
        </Select>
      </Row>
      <Row label="粗細" issues={mine("fontWeight")}>
        <Select value={String(weight)} aria-label={t("粗細")} onChange={(ev) => onChange({ fontWeight: Number(ev.target.value) === 700 && e.fontWeight === undefined ? undefined : Number(ev.target.value) })}>
          {[...new Set([...FONT_WEIGHTS, weight])].sort((a, b) => a - b).map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="字型檔" issues={mine("fontFile")} hint="選用：指定一個 .ttf / .otf，優先於字型清單">
        <FilePick path={file} filters={FONT_FILTERS} label={t("字型檔")} onPick={(p) => onChange({ fontFile: p })} onClear={() => onChange({ fontFile: undefined })} />
      </Row>
      <div className="pl-[96px]">
        <button
          type="button"
          className="text-[11px] text-accent hover:underline"
          onClick={() => onChange({ fontFamilies: [...captionFont.families], fontWeight: captionFont.weight, fontFile: captionFont.file || undefined })}
        >
          {t("跟字幕的字型一樣")}
        </button>
      </div>
    </>
  );
}

/** 換色：開關＋原本的顏色 → 新的顏色＋容差、柔邊。 */
function ReplaceColorEditor({ f, e, onChange, issues }: FieldProps<Extract<FxField, { kind: "replaceColor" }>>) {
  const t = useT();
  const v = fieldValue(e, f.key);
  const r = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValueLite>) : null;
  const set = (patch: Record<string, JsonValueLite>) => onChange({ [f.key]: { ...(r ?? {}), ...patch } }, { coalesce: `${e.id}:${f.key}` });
  const num = (k: string, def: number) => (typeof r?.[k] === "number" ? (r[k] as number) : def);
  return (
    <Row label={f.label} issues={issues} hint="把接近某個顏色的地方換成另一個顏色，保留原本的明暗">
      <div className="space-y-1.5">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-fg/60">
          <input type="checkbox" checked={!!r} onChange={(ev) => onChange({ [f.key]: ev.target.checked ? { source: "#FF0000", target: "#0080FF" } : undefined })} />
          {t("開")}
        </label>
        {r && (
          <>
            <div className="flex items-center gap-1.5 text-[11px] text-fg/55">
              <ColorInput value={r.source ?? r.from} label={t("原本的顏色")} onPick={(hex) => set({ source: hex.toUpperCase() })} />
              <span>→</span>
              <ColorInput value={r.target ?? r.to} label={t("新的顏色")} onPick={(hex) => set({ target: hex.toUpperCase() })} />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-fg/55">
              <span>{t("容差")}</span>
              <input type="range" min={0} max={1} step={0.01} value={num("tolerance", 0.12)} aria-label={t("容差")} onChange={(ev) => set({ tolerance: Number(ev.target.value) })} className="min-w-0 flex-1 accent-[rgb(var(--c-accent))]" />
              <span className="mono w-9 text-right">{num("tolerance", 0.12).toFixed(2)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-fg/55">
              <span>{t("柔邊")}</span>
              <input type="range" min={0} max={1} step={0.01} value={num("softness", 0.08)} aria-label={t("柔邊")} onChange={(ev) => set({ softness: Number(ev.target.value) })} className="min-w-0 flex-1 accent-[rgb(var(--c-accent))]" />
              <span className="mono w-9 text-right">{num("softness", 0.08).toFixed(2)}</span>
            </div>
          </>
        )}
      </div>
    </Row>
  );
}

/** 一個欄位（依 kind 分派）。 */
export function FxFieldEditor(props: FieldProps<FxField> & { captionFont: { families: readonly string[]; weight: number; file?: string | null } }) {
  const { f, issues } = props;
  const mine = issues.filter((i) => i.key === f.key);
  switch (f.kind) {
    case "number":
      return <NumberEditor {...props} f={f} issues={mine} />;
    case "enum":
      return <EnumEditor {...props} f={f} issues={mine} />;
    case "bool":
      return <BoolEditor {...props} f={f} issues={mine} />;
    case "color":
      return <ColorEditor {...props} f={f} issues={mine} />;
    case "text":
      return <TextEditor {...props} f={f} issues={mine} />;
    case "file":
      return <FileEditor {...props} f={f} issues={mine} />;
    case "pair":
      return <PairEditor {...props} f={f} issues={mine} />;
    case "font":
      return <FontEditor {...props} f={f} issues={issues} />;
    case "replaceColor":
      return <ReplaceColorEditor {...props} f={f} issues={mine} />;
  }
}
