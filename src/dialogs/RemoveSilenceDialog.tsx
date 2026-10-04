import { useCallback, useMemo, useState } from "react";
import { Slice } from "lucide-react";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { useT } from "../i18n";
import { peaksOf, peaksSourceOfMedia } from "../pipeline/peaks";
import { durationFrames } from "../sequence/map";
import { addMarker, extractRange } from "../sequence/ops";
import { DEFAULT_SILENCE, silentRangesOfSequence } from "../sequence/silence";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { selectActiveMedia, useProject } from "../store/project";
import { timecode } from "../time";
import { toast } from "../ui";
import { Button, Field, Input, Modal } from "../ui/index";

/**
 * 移除靜音（對標 Descript / CapCut）。三個參數都給調，而且**套用前先算給人看**
 * ——會剪掉幾段、省下多少、剩多長。盲剪一支十分鐘的影片再用 Ctrl+Z 反悔，體驗是不一樣的。
 *
 * 參數的意義寫在 hint 裡：門檻決定「多小聲算安靜」，最短長度讓句間停頓留著（那是節奏），
 * 頭尾保留避免把字頭字尾咬掉。
 */
/**
 * 數字欄位的退路：空字串、亂打的字、Infinity 都退回預設值。
 * 回 NaN 會讓 findSilentRanges 的門檻與長度比較全部變成 false —— 表面上「沒有找到靜音」，
 * 使用者只會以為功能壞了，不會知道是自己多打了一個字。
 */
export const num = (s: string, fallback: number): number => {
  // 空字串一定要先擋掉：Number("") 是 0 不是 NaN，清空門檻欄位會變成「低於 0 dBFS 都算安靜」＝整支都剪掉
  if (!s.trim()) return fallback;
  const v = Number(s);
  return Number.isFinite(v) ? v : fallback;
};

export default function RemoveSilenceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const stored = useEdits((s) => s.sequence);
  const active = useProject(selectActiveMedia);
  const seq = useMemo(() => viewSequenceOf(stored, active ?? null), [stored, active]);
  const [db, setDb] = useState(String(DEFAULT_SILENCE.thresholdDb));
  const [minMs, setMinMs] = useState(String(DEFAULT_SILENCE.minSilenceMs));
  const [padMs, setPadMs] = useState(String(DEFAULT_SILENCE.padMs));

  const media = useProject((s) => s.media);
  // 序列裡每支用到的媒體都要看：只看作用中那一支，接了三支素材時另外兩支的靜音會整段留著
  const peaksFor = useCallback(
    (id: string) => {
      const m = media.find((x) => x.id === id);
      const mip = m ? peaksOf(peaksSourceOfMedia(m).fingerprint) : null;
      return mip ? mip.peaks : null;
    },
    [media],
  );
  const { ranges, missing } = useMemo(() => {
    if (!seq) return { ranges: [], missing: [] };
    const opts = { thresholdDb: num(db, DEFAULT_SILENCE.thresholdDb), minSilenceMs: num(minMs, DEFAULT_SILENCE.minSilenceMs), padMs: num(padMs, DEFAULT_SILENCE.padMs) };
    return silentRangesOfSequence(seq, peaksFor, opts);
  }, [seq, peaksFor, db, minMs, padMs]);

  if (!seq) {
    return (
      <Modal open onClose={onClose} title={t("移除靜音")} icon={Slice}>
        <div className="text-sm text-fg/60">{t("還沒有序列：先開啟影片並等 proxy 建好")}</div>
      </Modal>
    );
  }
  const frames = durationFrames(seq);
  const cut = ranges.reduce((a, r) => a + (r.out - r.in), 0);

  const apply = () => {
    if (!ranges.length) return;
    try {
      // 倒序：先刪後面的範圍，前面那些的序列座標才不會偏
      useEdits.getState().editSequence(SEQ_EDIT_LABEL.removeSilence, (s, ctx) => [...ranges].reverse().reduce((acc, r) => extractRange(acc, r, ctx), s));
      toast.success(t("已移除 {n} 段靜音", { n: ranges.length }));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    }
    onClose();
  };

  /** 只加標記不剪：一按就砍掉十幾段太猛，先標起來用前後跳的鍵一段一段聽過再決定。 */
  const markOnly = () => {
    if (!ranges.length) return;
    try {
      useEdits.getState().editSequence(SEQ_EDIT_LABEL.addMarker, (s) => ranges.reduce((acc, r) => addMarker(acc, r.in, t("靜音段")), s));
      toast.success(t("已加入 {n} 個標記", { n: ranges.length }));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    }
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("移除靜音")}
      icon={Slice}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button variant="ghost" onClick={markOnly} disabled={!ranges.length}>
            {t("只加標記")}
          </Button>
          <Button variant="primary" onClick={apply} disabled={!ranges.length}>
            {t("移除")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <Field label={t("安靜門檻（dBFS）")} hint={t("低於這個音量才算安靜。數字越小越嚴格（只有真正沒聲音才剪），越大剪得越兇。")}>
          <Input type="number" min={-60} max={0} step={1} value={db} onChange={(e) => setDb(e.target.value)} className="mono w-28" />
        </Field>
        <Field label={t("最短長度（ms）")} hint={t("短於這個長度的安靜不動 —— 句與句之間的停頓是節奏，剪掉會讓人聽起來喘不過氣。")}>
          <Input type="number" min={0} step={50} value={minMs} onChange={(e) => setMinMs(e.target.value)} className="mono w-28" />
        </Field>
        <Field label={t("頭尾保留（ms）")} hint={t("每段安靜的前後各留這麼多。切太貼會把字頭字尾咬掉。")}>
          <Input type="number" min={0} step={10} value={padMs} onChange={(e) => setPadMs(e.target.value)} className="mono w-28" />
        </Field>
        {missing.length > 0 && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-fg/80" data-testid="remove-silence-missing">
            {t("有 {n} 支素材的波形還沒算好，這一輪不會動到它們的片段。", { n: missing.length })}
          </div>
        )}
        <div className="rounded border border-fg/10 bg-fg/4 px-3 py-2" data-testid="remove-silence-preview">
          {ranges.length ? (
            <span className="text-fg/80">
              {t("會剪掉 {n} 段、共 {cut}；剩下 {left}", { n: ranges.length, cut: timecode(cut, seq.fps), left: timecode(frames - cut, seq.fps) })}
            </span>
          ) : (
            <span className="text-fg/55">{t("依目前的設定沒有找到可以剪的靜音")}</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
