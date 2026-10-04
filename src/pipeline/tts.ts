import { api } from "../api";
import { t } from "../i18n";
import { isRecord } from "../project/format";
import { useSettings } from "../store/settings";
import { importAudioFiles } from "./audio";
import { runEngineJob } from "./engineJob";
import { cacheDirOf, joinPath } from "./project";

/**
 * AI 配音（文字轉語音；對標 CapCut 的「文字轉語音」、Descript 的 Overdub）。
 *
 * 後端是自架的 Seal-TTS（引擎 `tts.speakers` / `tts.synth`，金鑰走 keychain）。合成回來的是檔案：
 * 放進媒體快取的 `tts/` 資料夾，再走既有的「加入音訊檔」那條路放上音軌（probe、audio_info、波形都跟匯入 mp3 一樣）。
 */

export interface TtsVoice {
  id: string;
  name: string;
  gender: string | null;
  engine: string | null;
}

/** 設定裡的伺服器位址；空 = 功能關著。 */
export function ttsEndpoint(): string | null {
  const v = useSettings.getState().s.tts_base_url.trim();
  return v || null;
}

/** 引擎 `tts.speakers` 的回覆 → 型別（引擎已經只留 ready 的）。 */
export function parseVoices(raw: unknown): TtsVoice[] {
  const o = isRecord(raw) ? raw : {};
  const out: TtsVoice[] = [];
  for (const x of Array.isArray(o.speakers) ? o.speakers : []) {
    if (!isRecord(x) || typeof x.id !== "string" || !x.id) continue;
    out.push({ id: x.id, name: typeof x.name === "string" && x.name ? x.name : x.id, gender: typeof x.gender === "string" ? x.gender : null, engine: typeof x.engine === "string" ? x.engine : null });
  }
  return out;
}

export async function listVoices(): Promise<TtsVoice[]> {
  const endpoint = ttsEndpoint();
  if (!endpoint) throw new Error(t("還沒設定 AI 配音的伺服器"));
  return parseVoices(await api.engineCall<unknown>("tts.speakers", { endpoint }, 30_000));
}

export function ttsFileName(stamp: number, ext: "wav" | "mp3" = "wav"): string {
  return `vo-${stamp}.${ext}`;
}

/**
 * 大概會唸多久（秒）：中日韓約 4.5 字／秒、拉丁文字約 2.5 個詞／秒（一般旁白語速），除以語速倍率。
 * 只是給人一個「這段大概多長」的感覺，真的長度以合成回來的檔為準。
 */
export function estimateSeconds(text: string, speed = 1): number {
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const words = (text.replace(/[぀-ヿ㐀-鿿가-힯]/g, " ").match(/[A-Za-z0-9]+/g) ?? []).length;
  const s = cjk / 4.5 + words / 2.5;
  return Math.round((s / Math.max(0.25, speed)) * 10) / 10;
}

export interface SynthOptions {
  mediaId: string;
  text: string;
  voice: string;
  /** 語速倍率；1 = 不送。 */
  speed: number;
  instruct?: string;
  /** 指定輸出路徑（存成檔案…）；省略 = 媒體快取的 tts/ 資料夾。 */
  out?: string;
}

/** 合成一段 → 音檔路徑。長工作走 job（有進度、可取消）。 */
export async function synthesize(o: SynthOptions): Promise<{ out: string; bytes: number }> {
  const endpoint = ttsEndpoint();
  if (!endpoint) throw new Error(t("還沒設定 AI 配音的伺服器"));
  const out = o.out ?? joinPath(await cacheDirOf(o.mediaId), "tts", ttsFileName(Date.now()));
  const r = await runEngineJob<{ out?: string; bytes?: number }>({
    kind: "tts",
    mediaId: o.mediaId,
    op: "tts.synth",
    args: {
      endpoint,
      voice: o.voice,
      text: o.text,
      out,
      ...(Math.abs(o.speed - 1) > 1e-6 ? { speed: o.speed } : {}),
      ...(o.instruct?.trim() ? { instruct: o.instruct.trim() } : {}),
    },
    gpu: false,
    step: t("AI 配音"),
  });
  return { out: r.out ?? out, bytes: r.bytes ?? 0 };
}

/** 合成好的檔放上音軌（播放線）：跟「加入音訊檔…」同一條路。回 true = 真的放上去了。 */
export async function narrateToPlayhead(path: string): Promise<boolean> {
  const ids = await importAudioFiles([path], { kind: "playhead" });
  return ids.length > 0;
}
