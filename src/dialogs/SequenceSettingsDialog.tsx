import { useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { AUDIO_EDIT_LABEL, useAudioPrefs } from "../commands/audioClipCommands";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { useT } from "../i18n";
import { DEFAULT_EDGE_DECLICK_MS, SEQ_SAMPLE_RATE } from "../project/format";
import { durationFrames } from "../sequence/map";
import { useEdits } from "../store/edits";
import { selectActiveMedia, useProject } from "../store/project";
import { timecode } from "../time";
import { toast } from "../ui";
import { Button, Field, Input, Modal } from "../ui/index";

/**
 * 序列設定（docs/editor-m2-design.md §12「序列設定對話框」、§13 M2.17；Premiere Sequence Settings）。
 * - fps、尺寸、取樣率唯讀：M2 不做 conform，由 V1 媒體的 proxy 決定（§3.2）；
 * - 防爆音淡化 ms、限幅器：存進專案（sequence.audio），影響輸出的音訊圖；
 * - 預設淡化長度：本機習慣（Ctrl+Shift+D 用），不進專案檔；
 * - 輸出音訊位元率：M2 由引擎依容器固定（Opus / AAC 160 kbps、mkv 用 FLAC），這裡只說明，不給改。
 * 儲存 = 一筆「序列設定」undo；值沒變不留紀錄（隱含序列也不會因為開過這個對話框就被實體化）。
 */

/** 限幅器預設關（§0.1 Q4：alimiter 兩個預設都是坑，只在估計峰值超過 −1 dBFS 時提示）。 */
export const DECLICK_MS_MAX = 50;

export function clampDeclickMs(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(DECLICK_MS_MAX, Math.round(v * 10) / 10)) : DEFAULT_EDGE_DECLICK_MS;
}

export default function SequenceSettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const stored = useEdits((s) => s.sequence);
  const active = useProject(selectActiveMedia);
  const seq = useMemo(() => viewSequenceOf(stored, active ?? null), [stored, active]);
  const defaultFadeSeconds = useAudioPrefs((s) => s.defaultFadeSeconds);
  const [declick, setDeclick] = useState(String(seq?.audio.edgeDeclickMs ?? DEFAULT_EDGE_DECLICK_MS));
  const [limiter, setLimiter] = useState(seq?.audio.limiter ?? false);
  const [fadeS, setFadeS] = useState(String(defaultFadeSeconds));

  if (!seq) {
    return (
      <Modal open onClose={onClose} title={t("序列設定")} icon={Settings2}>
        <div className="text-sm text-fg/60">{t("還沒有序列：先開啟影片並等 proxy 建好")}</div>
      </Modal>
    );
  }

  const save = () => {
    // 清空欄位 = 維持原值，不是設成 0：Number("") 是 0，而 0 在這兩個欄位都是合法值
    // （防爆音 0 = 不加、淡化 0 秒 = 沒有淡化），只用 isFinite 守會讓「清空」變成「關掉功能」
    const edgeDeclickMs = declick.trim() === "" ? seq.audio.edgeDeclickMs : clampDeclickMs(Number(declick));
    const fade = fadeS.trim() === "" ? Number.NaN : Number(fadeS);
    if (Number.isFinite(fade)) useAudioPrefs.getState().setDefaultFadeSeconds(fade);
    if (edgeDeclickMs !== seq.audio.edgeDeclickMs || limiter !== seq.audio.limiter) {
      try {
        useEdits.getState().editSequence(AUDIO_EDIT_LABEL.sequenceSettings, (s) => ({ ...s, audio: { ...s.audio, edgeDeclickMs, limiter } }));
      } catch (e) {
        toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
        return;
      }
    }
    onClose();
  };

  const frames = durationFrames(seq);
  return (
    <Modal
      open
      onClose={onClose}
      title={t("序列設定")}
      icon={Settings2}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={save}>
            {t("儲存")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("幀率")} hint={t("由 V1 媒體決定")}>
            <span className="mono text-fg/80">{`${seq.fps.num}/${seq.fps.den} fps`}</span>
          </Field>
          <Field label={t("尺寸")} hint={t("由 V1 媒體決定")}>
            <span className="mono text-fg/80">{`${seq.width} × ${seq.height}`}</span>
          </Field>
          <Field label={t("取樣率")}>
            <span className="mono text-fg/80">{`${SEQ_SAMPLE_RATE} Hz`}</span>
          </Field>
          <Field label={t("長度")}>
            <span className="mono text-fg/80">{t("{tc}（{n} 幀）", { tc: timecode(frames, seq.fps), n: frames })}</span>
          </Field>
        </div>
        <Field label={t("防爆音淡化（ms）")} hint={t("每個片段兩端自動加的極短淡化，消掉剪在波形中間的爆音；使用者的淡化比它長時不另外加。0 = 不加。")}>
          <Input type="number" min={0} max={DECLICK_MS_MAX} step={0.5} value={declick} onChange={(e) => setDeclick(e.target.value)} className="mono w-28" />
        </Field>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-1" checked={limiter} onChange={(e) => setLimiter(e.target.checked)} data-testid="sequence-limiter" />
          <span>
            {t("輸出時加限幅器（−1 dBFS）")}
            <span className="block text-[11px] text-fg/45">{t("預設關：只有輸出計畫估計會削波時才建議打開。開著時不會自動拉大音量，也不會讓聲音延遲。")}</span>
          </span>
        </label>
        <Field label={t("預設淡化長度（秒）")} hint={t("「套用預設淡入淡出」（Ctrl+Shift+D）用的長度；存在這台電腦，不跟專案走。")}>
          <Input type="number" min={0} max={60} step={0.1} value={fadeS} onChange={(e) => setFadeS(e.target.value)} className="mono w-28" />
        </Field>
        <Field label={t("輸出音訊")}>
          <span className="text-fg/60 text-[12px]">{t("重新混音時依容器編碼：webm → Opus 160 kbps、mp4 / mov → AAC 160 kbps、mkv → FLAC（無損）。")}</span>
        </Field>
      </div>
    </Modal>
  );
}
