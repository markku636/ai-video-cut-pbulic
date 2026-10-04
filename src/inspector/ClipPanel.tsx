import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Clapperboard, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { create } from "zustand";
import { api, decodeJson } from "../api";
import { AUDIO_EDIT_LABEL } from "../commands/audioClipCommands";
import { formatGainDb } from "../frametimeline/drawSequence";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { useT } from "../i18n";
import { peaksOf, usePeaks } from "../pipeline/peaks";
import { SEQ_SAMPLE_RATE, type ClipGainV2, type FadeCurve, type GainPointV2, type SequenceV2 } from "../project/format";
import { setEnvelope, setFades, setGain, setOriginalAudioEnabled } from "../sequence/audioOps";
import { makeSeqCtx } from "../sequence/context";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useSolves } from "../store/solves";
import { useTimeline } from "../store/timeline";
import { trackTarget } from "../plugins/queries";
import { timecode } from "../time";
import { toast } from "../ui";
import { Badge, EmptyState, IconButton, Input, Select } from "../ui/index";
import { audioClipFacts, chainPeakDbfs, formatUsClock, secondsOfSamples, sourcePeakDbfs, v1ClipFacts, vfrFactsInRange, type ChainFacts, type SilentReason, type VfrFacts } from "./clipFacts";

/**
 * Inspector「片段」頁（docs/editor-m2-design.md §12、§13 M2.15）：時間軸選到的序列片段的事實與可編輯的音訊參數。
 * - V1 片段：媒體、來源 / 序列時間碼、時長、proxy、範圍內的 VFR 事實、替換目標、原音（codec、音訊相對視訊的偏移、增益、淡化、自動化）；
 * - 音訊片段：來源檔、來源入點（hh:mm:ss.mmm＋樣本）、序列位置、長度、增益、淡化與曲線、自動化點表（可編輯）、片段峰值、所屬軌。
 * 兩者都列出「輸出混音裡的那一條鏈」（入點 µs、L、delay、補靜音），數字跟輸出計畫逐項相同（clipFacts.ts 的測試綁著引擎的 golden）。
 *
 * 釘住（Resolve Inspector 的鎖）：釘住之後換選取也繼續顯示同一個片段，方便一邊點別的片段一邊對數字。
 * 選到片段時自動切到這頁的規則在 Inspector.tsx；這頁可以關掉自動切換（本機習慣）。
 */

interface ClipPanelPrefs {
  /** 釘住的片段 id；null = 跟著選取。 */
  pinned: string | null;
  setPinned: (id: string | null) => void;
  /** 選到片段時自動切到這頁（Inspector.tsx 讀）。 */
  autoSwitch: boolean;
  setAutoSwitch: (on: boolean) => void;
}

const AUTO_KEY = "aivc:clipTabAuto";

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

export const useClipPanelPrefs = create<ClipPanelPrefs>((set) => ({
  pinned: null,
  setPinned: (pinned) => set({ pinned }),
  autoSwitch: readAuto(),
  setAutoSwitch: (autoSwitch) => {
    try {
      localStorage.setItem(AUTO_KEY, autoSwitch ? "1" : "0");
    } catch {
      /* 沒有 localStorage：只影響這次 session */
    }
    set({ autoSwitch });
  },
}));

const SILENT_TEXT: Record<Exclude<SilentReason, null>, string> = {
  clipDisabled: "片段已停用：不輸出聲音",
  originalMuted: "原音已靜音：不輸出",
  detached: "原音已分離到音軌：在那裡輸出",
  busMuted: "A0 原音軌已靜音：不輸出",
  laneMuted: "音軌已靜音：不輸出",
  noAudio: "沒有音訊時間資訊（還在分析，或來源沒有音軌）",
  gainSilent: "增益或自動化整段 ≤ −90 dB：視為靜音",
  afterEnd: "在序列結尾之後：不輸出",
};

const CURVE_TEXT: Record<FadeCurve, string> = { linear: "線性", equalPower: "等功率" };

// ---- 小元件 ----

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-2 py-0.5" title={title}>
      <span className="text-fg/50 truncate">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-0.5">
      <div className="text-[11px] font-medium text-fg/60 uppercase tracking-wide pb-1">{title}</div>
      {children}
    </section>
  );
}

/**
 * 數字欄草稿 → 要 commit 的值；**清空欄位算放棄這次編輯**（回 NaN），不是「設成 0」。
 * `Number("")` 是 0 而 0 在增益 / 淡化上都是合法值，只用 isFinite 守不住 ——
 * 使用者選取全部再按 Enter 想取消，結果會把值改成 0。全形減號一併正規化。
 */
export function parseNumberDraft(draft: string): number {
  const s = draft.replace(/[−–]/g, "-");
  return s.trim() === "" ? Number.NaN : Number(s);
}

/** 數字欄：打字時不動 store，Enter / 失焦才 commit 一筆（一個欄位改一次 = 一筆 undo）；Esc 還原。 */
function NumberField({ value, onCommit, step = 0.1, suffix, disabled, label }: { value: number; onCommit: (v: number) => void; step?: number; suffix?: string; disabled?: boolean; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = parseNumberDraft(draft);
    setDraft(null);
    if (Number.isFinite(v) && v !== value) onCommit(v);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        type="number"
        step={step}
        aria-label={label}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
          e.stopPropagation();
        }}
        className="mono w-20 h-6 text-[12px]"
      />
      {suffix && <span className="text-fg/45">{suffix}</span>}
    </span>
  );
}

function chainRows(t: ReturnType<typeof useT>, chain: ChainFacts | null, silent: SilentReason) {
  if (!chain) return <Row label={t("輸出")}>{silent ? <span className="text-warning">{t(SILENT_TEXT[silent])}</span> : "—"}</Row>;
  return (
    <>
      <Row label={t("輸出入點")} title={t("輸出混音裡這段聲音從來源的哪個容器時間開始（µs）")}>
        <span className="mono">{`${(chain.inUs / 1e6).toFixed(6)} s`}</span>
      </Row>
      <Row label={t("輸出長度")}>
        <span className="mono">{t("{n} 樣本", { n: chain.length })}</span> · <span className="mono">{t("延遲 {n} 樣本", { n: chain.delay })}</span>
      </Row>
      {chain.leadPad > 0 && <Row label={t("前面補靜音")}>{t("{n} 樣本（來源在這裡還沒有聲音）", { n: chain.leadPad })}</Row>}
      <Row label={t("總增益")}>{formatGainDb(chain.gainDb)}</Row>
    </>
  );
}

/** 片段增益 / 淡化 / 曲線 / 自動化的可編輯列。apply 拿到新的增益參數片段，寫成一筆 undo。 */
function GainEditor({ gain, length, disabled, onEdit }: { gain: ClipGainV2; length: number; disabled?: boolean; onEdit: (label: string, f: (seq: SequenceV2, ids: string[]) => SequenceV2) => void }) {
  const t = useT();
  const sec = (s: number) => Math.round(s * SEQ_SAMPLE_RATE);
  return (
    <>
      <Row label={t("增益")}>
        <NumberField label={t("增益")} value={gain.gainDb} suffix="dB" disabled={disabled} onCommit={(v) => onEdit(SEQ_EDIT_LABEL.gain, (seq, ids) => setGain(seq, ids, v))} />
      </Row>
      <Row label={t("淡入")}>
        <NumberField label={t("淡入")} value={Number(secondsOfSamples(gain.fadeIn))} step={0.05} suffix={t("秒")} disabled={disabled} onCommit={(v) => onEdit(SEQ_EDIT_LABEL.fadeIn, (seq, ids) => setFades(seq, ids, { fadeIn: sec(Math.max(0, v)) }))} />
      </Row>
      <Row label={t("淡出")}>
        <NumberField label={t("淡出")} value={Number(secondsOfSamples(gain.fadeOut))} step={0.05} suffix={t("秒")} disabled={disabled} onCommit={(v) => onEdit(SEQ_EDIT_LABEL.fadeOut, (seq, ids) => setFades(seq, ids, { fadeOut: sec(Math.max(0, v)) }))} />
      </Row>
      <Row label={t("淡化曲線")}>
        <Select value={gain.fadeCurve} disabled={disabled} onChange={(e) => onEdit(SEQ_EDIT_LABEL.fadeCurve, (seq, ids) => setFades(seq, ids, { fadeCurve: e.target.value as FadeCurve }))} className="h-6 text-[12px] w-28">
          {(Object.keys(CURVE_TEXT) as FadeCurve[]).map((c) => (
            <option key={c} value={c}>
              {t(CURVE_TEXT[c])}
            </option>
          ))}
        </Select>
      </Row>
      <EnvelopeTable points={gain.envelope} length={length} disabled={disabled} onChange={(pts) => onEdit(SEQ_EDIT_LABEL.envelope, (seq, ids) => setEnvelope(seq, ids, pts))} />
    </>
  );
}

/** 自動化點表：at 以秒（片段內）、dB；可改、可刪、可加（加在片段中間，值取 0 dB）。 */
function EnvelopeTable({ points, length, disabled, onChange }: { points: readonly GainPointV2[]; length: number; disabled?: boolean; onChange: (pts: GainPointV2[]) => void }) {
  const t = useT();
  const replace = (i: number, p: GainPointV2) => onChange(points.map((q, j) => (j === i ? p : q)));
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <span className="text-fg/50">{t("音量自動化（{n} 點）", { n: points.length })}</span>
        <IconButton icon={Plus} label={t("新增自動化點")} iconSize={13} box="w-6 h-6" disabled={disabled} onClick={() => onChange([...points, { at: Math.floor(length / 2), db: 0 }])} />
      </div>
      {points.length > 0 && (
        <table className="w-full text-[11px] mt-1">
          <thead>
            <tr className="text-fg/40">
              <th className="text-left font-normal">{t("片段內（秒）")}</th>
              <th className="text-left font-normal">dB</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={`${i}-${p.at}`}>
                <td>
                  <NumberField label={t("位置")} value={Number((p.at / SEQ_SAMPLE_RATE).toFixed(3))} step={0.01} disabled={disabled} onCommit={(v) => replace(i, { at: Math.round(Math.max(0, v) * SEQ_SAMPLE_RATE), db: p.db })} />
                </td>
                <td>
                  <NumberField label="dB" value={p.db} disabled={disabled} onCommit={(v) => replace(i, { at: p.at, db: v })} />
                </td>
                <td className="text-right">
                  <IconButton icon={Trash2} label={t("刪除自動化點")} iconSize={12} box="w-6 h-6" disabled={disabled} onClick={() => onChange(points.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- VFR 事實（index.v1.json，每支媒體讀一次）----

const indexCache = new Map<string, Promise<unknown>>();

function loadIndex(fingerprint: string): Promise<unknown> {
  let p = indexCache.get(fingerprint);
  if (!p) {
    p = api
      .cacheRead(fingerprint, "index.v1.json")
      .then((buf) => decodeJson(buf))
      .catch(() => {
        // 還沒建索引（proxy 還在建）：下次打開再讀
        indexCache.delete(fingerprint);
        return null;
      });
    indexCache.set(fingerprint, p);
  }
  return p;
}

function useVfrFacts(fingerprint: string | null, srcIn: number, srcOut: number): VfrFacts | null {
  const [raw, setRaw] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    setRaw(null);
    if (fingerprint) void loadIndex(fingerprint).then((r) => alive && setRaw(r));
    return () => {
      alive = false;
    };
  }, [fingerprint]);
  return useMemo(() => (raw ? vfrFactsInRange(raw, srcIn, srcOut) : null), [raw, srcIn, srcOut]);
}

// ---- 主元件 ----

export default function ClipPanel() {
  const t = useT();
  const flag = useSettings((s) => s.experimental.sequence);
  const stored = useEdits((s) => s.sequence);
  const audioMedia = useEdits((s) => s.audioMedia);
  const media = useProject((s) => s.media);
  const activeId = useProject((s) => s.activeMediaId);
  const selected = useTimeline((s) => s.selectedClipIds);
  const pinned = useClipPanelPrefs((s) => s.pinned);
  const setPinned = useClipPanelPrefs((s) => s.setPinned);
  const autoSwitch = useClipPanelPrefs((s) => s.autoSwitch);
  const setAutoSwitch = useClipPanelPrefs((s) => s.setAutoSwitch);
  usePeaks((s) => s.byKey);

  const active = useMemo(() => media.find((m) => m.id === activeId) ?? null, [media, activeId]);
  const seq = useMemo(() => (flag ? viewSequenceOf(stored, active) : null), [flag, stored, active]);
  const ctx = useMemo(() => makeSeqCtx(media, audioMedia), [media, audioMedia]);
  const exists = (id: string | null) => !!id && !!seq && (seq.video.some((v) => v.id === id) || seq.audioLanes.some((l) => l.clips.some((c) => c.id === id)));
  const clipId = exists(pinned) ? pinned : [...selected].reverse().find((id) => exists(id)) ?? null;

  if (!flag) return <EmptyState icon={Clapperboard} title={t("序列剪輯還沒開啟")} hint={t("先在設定開啟「序列剪輯（預覽）」")} compact />;
  if (!seq || !clipId) return <EmptyState icon={Clapperboard} title={t("沒有選取片段")} hint={t("在時間軸上方選「序列」，再點選一個片段；雙擊音訊片段也會打開這頁。")} compact />;

  /** 對這個片段做一筆序列編輯（隱含序列在同一筆裡實體化）。 */
  const edit = (label: string, f: (s: SequenceV2, ids: string[]) => SequenceV2) => {
    try {
      useEdits.getState().editSequence(label, (s) => f(s, [clipId]));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const header = (title: string, badges: ReactNode) => (
    <div className="flex items-center gap-2 border-b border-fg/8 px-3 py-2 text-[12px]">
      <span className="font-medium truncate min-w-0">{title}</span>
      {badges}
      <IconButton
        icon={pinned ? PinOff : Pin}
        label={pinned ? t("取消釘住（跟著選取）") : t("釘住這個片段")}
        iconSize={13}
        box="w-6 h-6"
        className="ml-auto"
        aria-pressed={!!pinned}
        onClick={() => setPinned(pinned ? null : clipId)}
      />
    </div>
  );

  const footer = (
    <label className="flex items-center gap-1.5 border-t border-fg/8 px-3 py-1.5 text-[11px] text-fg/50">
      <input type="checkbox" checked={autoSwitch} onChange={(e) => setAutoSwitch(e.target.checked)} />
      {t("選片段時自動切到這頁")}
    </label>
  );

  const gap = seq.video.find((v) => v.id === clipId && v.kind === "gap");
  if (gap && gap.kind === "gap") {
    return (
      <div className="flex h-full flex-col min-h-0">
        {header(t("空白"), null)}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 text-[12px]">
          <Row label={t("時長")}>{t("{n} 幀（{tc}）", { n: gap.length, tc: timecode(gap.length, seq.fps) })}</Row>
        </div>
        {footer}
      </div>
    );
  }

  const v1 = v1ClipFacts(seq, clipId, ctx);
  if (v1) return <V1ClipView facts={v1} seq={seq} header={header} footer={footer} edit={edit} />;
  const a = audioClipFacts(seq, clipId, ctx);
  if (!a) return <EmptyState icon={Clapperboard} title={t("沒有選取片段")} compact />;
  const src = a.clip.source;
  const am = src.type === "audio" ? audioMedia.find((x) => x.id === src.audioId) : undefined;
  const vm = src.type === "media" ? media.find((x) => x.id === src.mediaId) : undefined;
  const name = a.clip.label || am?.name || vm?.name || "—";
  const probeAudio = am?.probe?.audio ?? vm?.probe?.audio ?? null;
  const fingerprint = am?.fingerprint ?? vm?.fingerprint ?? null;
  const srcPeak = a.chain && fingerprint ? sourcePeakDbfs(peaksOf(fingerprint), a.chain.inUs, a.chain.outUs) : null;
  const peak = chainPeakDbfs(srcPeak, a.chain);
  return (
    <div className="flex h-full flex-col min-h-0">
      {header(
        name,
        <>
          {a.clip.detachedFrom && <Badge tone="accent">{t("原音")}</Badge>}
          {!a.clip.enabled && <Badge tone="neutral">{t("已靜音")}</Badge>}
          {a.lane.locked && <Badge tone="warning">{t("已鎖定")}</Badge>}
        </>,
      )}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4 text-[12px]">
        <Section title={t("來源")}>
          <Row label={t("檔案")} title={am?.path ?? vm?.path}>
            {am?.name ?? vm?.name ?? "—"}
          </Row>
          <Row label={t("格式")}>
            <span className="mono">
              {a.info ? `${a.info.codec} · ${a.info.sampleRate} Hz · ${a.info.channels} ch` : probeAudio ? `${probeAudio.codec} · ${probeAudio.sample_rate} Hz · ${probeAudio.channels} ch` : "—"}
              {probeAudio?.bit_rate ? ` · ${Math.round(probeAudio.bit_rate / 1000)} kbps` : ""}
            </span>
          </Row>
          <Row label={t("來源入點")}>
            <span className="mono">{a.srcInUs !== null ? formatUsClock(a.srcInUs) : "—"}</span> · <span className="mono">{t("{n} 樣本", { n: a.clip.srcIn })}</span>
          </Row>
          {a.info && a.info.startUs !== 0 && src.type === "audio" && <Row label={t("編碼延遲")}>{t("{ms} ms（容器起點）", { ms: (a.info.startUs / 1000).toFixed(3) })}</Row>}
        </Section>
        <Section title={t("序列")}>
          <Row label={t("所屬軌")}>
            {a.lane.name}
            {a.lane.muted ? ` · ${t("已靜音")}` : ""}
          </Row>
          <Row label={t("位置")}>
            <span className="mono">
              {timecode(a.startFrame, seq.fps)} – {timecode(a.endFrame, seq.fps)}
            </span>
          </Row>
          <Row label={t("長度")}>
            {t("{s} 秒", { s: secondsOfSamples(a.clip.length) })} · <span className="mono">{t("{n} 樣本", { n: a.clip.length })}</span>
          </Row>
          {chainRows(t, a.chain, a.silent)}
          <Row label={t("片段峰值")} title={t("由波形峰值估計：來源峰值＋增益＋自動化最大值（保守上界）")}>
            {srcPeak === null ? t("波形還沒算好") : `${srcPeak.toFixed(1)} dBFS → ${peak === null ? "—" : `${peak.toFixed(1)} dBFS`}`}
            {peak !== null && peak > -1 && <span className="text-warning"> · {t("可能削波")}</span>}
          </Row>
        </Section>
        <Section title={t("音量")}>
          <GainEditor gain={a.clip} length={a.clip.length} disabled={a.lane.locked} onEdit={edit} />
        </Section>
      </div>
      {footer}
    </div>
  );
}

function V1ClipView({
  facts,
  seq,
  header,
  footer,
  edit,
}: {
  facts: NonNullable<ReturnType<typeof v1ClipFacts>>;
  seq: SequenceV2;
  header: (title: string, badges: ReactNode) => ReactNode;
  footer: ReactNode;
  edit: (label: string, f: (s: SequenceV2, ids: string[]) => SequenceV2) => void;
}) {
  const t = useT();
  const c = facts.clip;
  const m = useProject((s) => s.media.find((x) => x.id === c.mediaId) ?? null);
  const tracks = useEdits((s) => s.tracks[c.mediaId]);
  const shots = useEdits((s) => s.shots[c.mediaId]);
  const pluginMedia = useEdits((s) => s.pluginMedia[c.mediaId]);
  const solves = useSolves((s) => s.byTrack);
  const vfr = useVfrFacts(m?.fingerprint ?? null, c.srcIn, c.srcOut);
  const proxyFps = m?.proxy?.fps ?? seq.fps;

  // 此範圍內有替換目標的 track（外掛說的：「<格位> <原本> → <目標>，解算 297/300 幀，hold 3」）
  const targets = useMemo(() => {
    const out: { id: string; text: string }[] = [];
    for (const tr of tracks ?? []) {
      const target = trackTarget(pluginMedia, tr);
      if (!target) continue;
      const shot = (shots ?? []).find((s) => s.id === tr.shotId);
      const lo = Math.max(c.srcIn, shot?.startFrame ?? 0);
      const hi = Math.min(c.srcOut, shot?.endFrame ?? c.srcOut);
      if (hi <= lo) continue;
      let solved = 0;
      let hold = 0;
      for (const f of solves[tr.id]?.frames ?? []) {
        if (f.k < lo || f.k >= hi) continue;
        if (f.state === 1 || f.state === 2) solved++;
        else if (f.state === 3) hold++;
      }
      out.push({ id: tr.id, text: t("{slot} {from} → {to}，解算 {solved}/{total} 幀，hold {hold}", { slot: target.name, from: target.from, to: target.to, solved, total: hi - lo, hold }) });
    }
    return out;
  }, [tracks, shots, pluginMedia, solves, c.srcIn, c.srcOut, t]);

  const info = facts.info;
  const peak = facts.chain && m ? chainPeakDbfs(sourcePeakDbfs(peaksOf(m.fingerprint), facts.chain.inUs, facts.chain.outUs), facts.chain) : null;
  const detached = c.audio.detachedTo !== undefined;
  const detachedLane = detached ? seq.audioLanes.find((l) => l.clips.some((x) => x.id === c.audio.detachedTo)) : undefined;

  return (
    <div className="flex h-full flex-col min-h-0">
      {header(
        c.label || m?.name || c.mediaId,
        <>
          {!c.enabled && <Badge tone="neutral">{t("已停用")}</Badge>}
          {!m && <Badge tone="danger">{t("媒體離線")}</Badge>}
        </>,
      )}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4 text-[12px]">
        <Section title={t("來源")}>
          <Row label={t("媒體")} title={m?.path}>
            {m?.name ?? c.mediaId}
          </Row>
          <Row label={t("來源入點")}>
            <span className="mono">{timecode(c.srcIn, proxyFps)}</span> · k {c.srcIn}
          </Row>
          <Row label={t("來源出點")}>
            <span className="mono">{timecode(c.srcOut, proxyFps)}</span> · k {c.srcOut}
          </Row>
          {m?.proxy && <Row label="proxy">{t("{fps} fps · 縮放 {scale}", { fps: `${m.proxy.fps.num}/${m.proxy.fps.den}`, scale: m.proxy.scale })}</Row>}
          {vfr && (vfr.duplicates > 0 || vfr.gaps.length > 0) && (
            <Row label="VFR">
              {vfr.duplicates > 0 && <div>{t("含 {n} 個定格重複幀", { n: vfr.duplicates })}</div>}
              {vfr.gaps.slice(0, 5).map((g) => (
                <div key={g.k}>{t("來源斷層 {s} 秒 @ {tc}", { s: (g.gapMs / 1000).toFixed(2), tc: timecode(g.k, proxyFps) })}</div>
              ))}
            </Row>
          )}
        </Section>
        <Section title={t("序列")}>
          <Row label={t("序列入點")}>
            <span className="mono">{timecode(facts.t0, seq.fps)}</span>
          </Row>
          <Row label={t("序列出點")}>
            <span className="mono">{timecode(facts.t1, seq.fps)}</span>
          </Row>
          <Row label={t("時長")}>{t("{n} 幀（{tc}）", { n: facts.frames, tc: timecode(facts.frames, seq.fps) })}</Row>
        </Section>
        {targets.length > 0 && (
          <Section title={t("替換目標")}>
            {targets.map((x) => (
              <div key={x.id} className="py-0.5">
                {x.text}
              </div>
            ))}
          </Section>
        )}
        <Section title={t("原音")}>
          <Row label={t("格式")}>
            <span className="mono">{info ? `${info.codec} · ${info.sampleRate} Hz · ${info.channels} ch` : m?.probe?.audio ? `${m.probe.audio.codec} · ${m.probe.audio.sample_rate} Hz · ${m.probe.audio.channels} ch` : "—"}</span>
          </Row>
          {facts.audioOffsetUs !== null && (
            <Row label={t("音訊相對視訊")} title={t("音訊串流起點 − 影片第一幀（容器時間）；輸出時已經對齊")}>
              <span className="mono">{`${facts.audioOffsetUs > 0 ? "+" : facts.audioOffsetUs < 0 ? "−" : ""}${(Math.abs(facts.audioOffsetUs) / 1000).toFixed(1)} ms`}</span>
            </Row>
          )}
          {detached && <Row label={t("狀態")}>{t("已分離 → {lane}", { lane: detachedLane?.name ?? "?" })}</Row>}
          {chainRows(t, facts.chain, facts.silent)}
          {peak !== null && (
            <Row label={t("片段峰值")}>
              {peak.toFixed(1)} dBFS{peak > -1 && <span className="text-warning"> · {t("可能削波")}</span>}
            </Row>
          )}
          {!detached && <GainEditor gain={c.audio} length={facts.lengthSamples} onEdit={edit} />}
          {!detached && (
            <Row label={t("原音")}>
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={!c.audio.enabled} onChange={(e) => edit(e.target.checked ? AUDIO_EDIT_LABEL.muteOriginal : AUDIO_EDIT_LABEL.unmuteOriginal, (s, ids) => setOriginalAudioEnabled(s, ids, !e.target.checked))} />
                {t("靜音原音")}
              </label>
            </Row>
          )}
        </Section>
      </div>
      {footer}
    </div>
  );
}

