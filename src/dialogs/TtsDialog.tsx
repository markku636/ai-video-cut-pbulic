import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioLines, Play, Save, Square } from "lucide-react";
import { errMessage } from "../api";
import { useT } from "../i18n";
import { estimateSeconds, listVoices, narrateToPlayhead, synthesize, ttsEndpoint, type TtsVoice } from "../pipeline/tts";
import { cueAtFrame, cueText } from "../store/captions";
import { openDialog } from "../store/dialogs";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { sequenceEditingEnabled, useSettings } from "../store/settings";
import { pickSaveFile, toast } from "../ui";
import { Button, Field, Input, Modal, Select, Textarea } from "../ui/index";

/**
 * AI 配音（文字轉語音；對標 CapCut 的「文字轉語音」、Descript 的 Overdub）。
 *
 * 一段字 → 挑聲音 → 試聽 → 放到播放線（音軌）或存成檔案。合成在自架的 Seal-TTS 伺服器（引擎 `tts.synth`），
 * 回來的檔走「加入音訊檔」那條路放上音軌，所以 probe／波形／同步鎖都跟匯入 mp3 一樣。
 * 文字預設帶播放線上的字幕那一句：最常見的用法是「這句重唸一次」。
 */
export default function TtsDialog({ text: initialText, onClose }: { text?: string; onClose: () => void }) {
  const t = useT();
  const media = useProject(selectActiveMedia);
  const mediaId = media?.id ?? null;
  const endpoint = useSettings((s) => s.s.tts_base_url.trim());
  const seqOn = useSettings((s) => s.experimental.sequence);
  const outDir = useSettings((s) => s.s.output_dir || null);
  const captions = useEdits((s) => (mediaId ? s.captions[mediaId] ?? null : null));
  const playhead = usePlayback((s) => s.frame);

  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voice, setVoice] = useState("");
  const [text, setText] = useState(() => initialText ?? (captions ? cueText(cueAtFrame(captions.cues, playhead) ?? { words: [] }) : ""));
  const [speed, setSpeed] = useState(1);
  const [instruct, setInstruct] = useState("");
  const [busy, setBusy] = useState<"preview" | "place" | "save" | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!endpoint) return;
    let alive = true;
    listVoices()
      .then((v) => {
        if (!alive) return;
        setVoices(v);
        setVoice((cur) => cur || v[0]?.id || "");
      })
      .catch((e) => alive && setVoicesError(errMessage(e)));
    return () => {
      alive = false;
    };
  }, [endpoint]);

  // 關掉對話框時把試聽停掉
  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const chars = text.trim().length;
  const seconds = useMemo(() => estimateSeconds(text, speed), [text, speed]);
  const ready = !!mediaId && !!voice && chars > 0 && busy == null;

  const stopPreview = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  };

  const preview = async () => {
    if (!ready || !mediaId) return;
    stopPreview();
    setBusy("preview");
    try {
      const { out } = await synthesize({ mediaId, text: text.trim(), voice, speed, instruct });
      setPreviewPath(out);
      const el = new Audio(convertFileSrc(out));
      audioRef.current = el;
      el.onended = () => setPlaying(false);
      await el.play();
      setPlaying(true);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const place = async () => {
    if (!ready || !mediaId) return;
    if (!sequenceEditingEnabled()) {
      toast.error(t("序列剪輯關著：到設定開啟「序列剪輯」才能放上音軌"));
      return;
    }
    setBusy("place");
    try {
      // 剛試聽過同一段就直接用那個檔，不再合成一次
      const path = previewPath ?? (await synthesize({ mediaId, text: text.trim(), voice, speed, instruct })).out;
      const ok = await narrateToPlayhead(path);
      if (ok) toast.success(t("旁白已放到播放線"));
      else toast.info(t("音檔已加入清單；影片的 proxy 建好之後才能放上音軌"));
      onClose();
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const saveAs = async () => {
    if (!ready || !mediaId || !media) return;
    const stem = (media.name || "voice").replace(/\.[^.]+$/, "");
    const dir = outDir ?? media.path.slice(0, Math.max(0, media.path.lastIndexOf(media.path.includes("\\") ? "\\" : "/")));
    const sep = dir.includes("\\") ? "\\" : "/";
    const target = await pickSaveFile(`${dir}${sep}${stem}.aivc.vo.wav`, [{ name: "WAV", extensions: ["wav"] }, { name: "MP3", extensions: ["mp3"] }]);
    if (!target) return;
    setBusy("save");
    try {
      const { out } = await synthesize({ mediaId, text: text.trim(), voice, speed, instruct, out: target });
      toast.success(t("已存成 {path}", { path: out }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // 文字或聲音變了，上一次的試聽檔就不算數
  useEffect(() => setPreviewPath(null), [text, voice, speed, instruct]);

  const body = (() => {
    if (!endpoint) {
      return (
        <div className="space-y-3 text-sm">
          <div className="text-fg/60">{t("還沒設定 AI 配音的伺服器")}</div>
          <Button onClick={() => openDialog("settings", { focus: "engine" })}>{t("去設定")}</Button>
        </div>
      );
    }
    return (
      <div className="space-y-4 text-sm">
        <div className="text-[12px] leading-relaxed text-fg/60">{t("打一段字、挑一個聲音，合成的旁白會放到播放線的音軌上（或存成檔案）。文字預設帶播放線上的那句字幕。")}</div>

        <Field label={t("聲音")} error={voicesError}>
          <Select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={!voices?.length || busy != null} data-testid="tts-voice">
            {!voices && <option value="">{t("載入聲音清單…")}</option>}
            {voices && !voices.length && <option value="">{t("伺服器上沒有可用的聲音")}</option>}
            {voices?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.gender ? `（${v.gender}）` : ""}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t("要唸的字")} hint={t("{n} 字，大約 {s} 秒", { n: chars, s: seconds })}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className="w-full" spellCheck={false} disabled={busy != null} data-testid="tts-text" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("語速")} hint={t("1 = 原速；0.5–2")}>
            <Input type="number" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(Math.max(0.5, Math.min(2, Number(e.target.value) || 1)))} disabled={busy != null} data-testid="tts-speed" />
          </Field>
          <Field label={t("語氣（選填）")} hint={t("例如「開心一點」「平穩、像新聞主播」；伺服器支援才有效。")}>
            <Input value={instruct} onChange={(e) => setInstruct(e.target.value)} disabled={busy != null} spellCheck={false} data-testid="tts-instruct" />
          </Field>
        </div>

        {!seqOn && <div className="text-[11px] text-fg/45">{t("序列剪輯關著：到設定開啟「序列剪輯」才能放上音軌")}</div>}
      </div>
    );
  })();

  return (
    <Modal
      open
      onClose={onClose}
      title={t("AI 配音（文字轉語音）")}
      icon={AudioLines}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          {playing ? (
            <Button variant="ghost" icon={Square} onClick={stopPreview} data-testid="tts-stop">
              {t("停止")}
            </Button>
          ) : (
            <Button variant="ghost" icon={Play} loading={busy === "preview"} disabled={!ready} onClick={() => void preview()} data-testid="tts-preview">
              {t("試聽")}
            </Button>
          )}
          <Button variant="ghost" icon={Save} loading={busy === "save"} disabled={!ready} onClick={() => void saveAs()} data-testid="tts-save">
            {t("存成檔案…")}
          </Button>
          <Button variant="primary" icon={AudioLines} loading={busy === "place"} disabled={!ready || !seqOn} onClick={() => void place()} data-testid="tts-place">
            {t("放到播放線")}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

export { ttsEndpoint };
