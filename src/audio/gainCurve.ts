// 片段增益曲線的純函式（docs/editor-m2-design.md §7.3 的 volume / afade 鏈、§8.2、§8.3、§9.3）。
//
// 為什麼獨立成檔：同一條曲線有三個消費者 —— 渲染（Python audio_graph 產生 ffmpeg 運算式）、Web Audio 預覽（src/audio/preview.ts
// 把它取樣成 setValueCurveAtTime 的陣列）、時間軸波形包絡（frametimeline/seqGeometry.ts 的 clipGainFactor）。
// 三份各寫一套的話「波形變小的位置」跟「聲音變小的位置」遲早對不上；這裡是 TS 端唯一的定義，
// seqGeometry.clipGainFactor 的語意由 gainCurve.test.ts 逐點比對鎖住（M2.9 先落地的那份之後改成 re-export 這裡）。
//
// 語意（全部跟渲染一致）：
// - dB 域相加：片段增益 + 自動化曲線（envelopeDbAt，dB 域線性內插）+ 匯流排 dB；≤ SILENCE_DB 視為 −∞（倍率 0）。
// - 淡入淡出乘上形狀：linear = afade tri、equalPower = afade qsin（sin(x·π/2)）。
// - 防爆音：渲染每個片段兩端都至少有 D = round(edgeDeclickMs · 48) 個樣本的淡化（使用者淡化比 D 長就用使用者的），
//   曲線種類跟著片段。預覽要聽起來跟輸出一樣，所以 declick 參數照帶；時間軸畫圖傳 0（3 ms 在畫面上看不到，畫出來只是雜訊）。
import { SEQ_SAMPLE_RATE, SILENCE_DB, type ClipGainV2, type FadeCurve, type SequenceV2 } from "../project/format";
import { envelopeDbAt } from "../sequence/envelope";
import { samplesOfFrame, type PlacedItem } from "../sequence/map";

/** A0「原音」匯流排在獨奏清單裡的 id（音軌用自己的 lane id）。 */
export const A0_BUS_ID = "A0";

/** dB → 線性倍率；≤ SILENCE_DB 視為靜音（閃避到 −96 的區段要真的沒聲音，而不是剩 0.00002 倍）。 */
export function dbToGain(db: number): number {
  return db <= SILENCE_DB ? 0 : 10 ** (db / 20);
}

/** 淡化形狀：x ∈ [0, 1]（0 = 靜音端）。linear = afade tri；equalPower = afade qsin。 */
export function fadeShape(x: number, curve: FadeCurve): number {
  const v = Math.max(0, Math.min(1, x));
  return curve === "equalPower" ? Math.sin((v * Math.PI) / 2) : v;
}

/** 序列的防爆音淡化長度（序列樣本）：round(edgeDeclickMs · 48)，渲染的 D。 */
export function declickSamples(seq: Pick<SequenceV2, "audio">): number {
  const ms = Number.isFinite(seq.audio?.edgeDeclickMs) ? Math.max(0, seq.audio.edgeDeclickMs) : 0;
  return Math.round((ms * SEQ_SAMPLE_RATE) / 1000);
}

/**
 * 片段內 at（相對片段起點的序列樣本，可為小數）的線性倍率：片段增益＋自動化（dB）＋busDb，乘淡入淡出形狀。
 * `declick` > 0 時兩端的淡化長度至少是它（渲染的 `afade ns = max(fade, D)`）。
 */
export function clipGainFactor(g: ClipGainV2, at: number, length: number, busDb = 0, declick = 0): number {
  const db = g.gainDb + envelopeDbAt(g.envelope, at) + busDb;
  if (db <= SILENCE_DB) return 0;
  let f = 10 ** (db / 20);
  const fadeIn = Math.max(g.fadeIn, declick);
  const fadeOut = Math.max(g.fadeOut, declick);
  if (fadeIn > 0 && at < fadeIn) f *= fadeShape(at / fadeIn, g.fadeCurve);
  if (fadeOut > 0 && at > length - fadeOut) f *= fadeShape((length - at) / fadeOut, g.fadeCurve);
  return f;
}

/**
 * 把一段曲線取樣成 Float32Array（setValueCurveAtTime 用）：[from, to] 均分成 n 點（含兩端，n ≥ 2），
 * 每點間距不超過 step。Web Audio 在點與點之間線性內插，step 取 5 ms（240 樣本）跟渲染的 `asetnsamples=240` 同一個解析度。
 */
export function sampleCurve(fn: (at: number) => number, from: number, to: number, step: number): Float32Array {
  const span = Math.max(0, to - from);
  const n = Math.max(2, Math.ceil(span / Math.max(1, step)) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(from + (span * i) / (n - 1));
  return out;
}

/** 音軌（或 A0 匯流排）聽不聽得到：靜音一律聽不到（會影響輸出）；有獨奏時只聽獨奏的（監聽，不影響輸出）。 */
export function busAudible(id: string, muted: boolean, solo: readonly string[]): boolean {
  if (muted) return false;
  return solo.length === 0 || solo.includes(id);
}

/** 音軌推桿＋靜音＋獨奏合成的匯流排倍率。 */
export function laneBusGain(lane: { id: string; muted: boolean; gainDb: number }, solo: readonly string[]): number {
  return busAudible(lane.id, lane.muted, solo) ? dbToGain(lane.gainDb) : 0;
}

/**
 * V1 片段原音在序列樣本 seqSample 的倍率（A0 預覽的 GainNode / element.volume 退路共用）：
 * 片段停用、原音停用或已分離、A0 靜音或被別的軌獨奏掉 → 0；否則 clipGainFactor（匯流排 dB = original.gainDb，含防爆音）。
 * `p` 是覆蓋 seqSample 的 V1 項目（placeVideo 的結果）；seqSample 超出片段時夾在兩端。
 */
export function originalGainAt(seq: Pick<SequenceV2, "fps" | "original" | "audio">, p: Pick<PlacedItem, "item" | "t0" | "t1">, seqSample: number, solo: readonly string[] = []): number {
  const clip = p.item;
  if (clip.kind !== "clip" || !clip.enabled || !clip.audio.enabled || clip.audio.detachedTo !== undefined) return 0;
  if (!busAudible(A0_BUS_ID, seq.original.muted, solo)) return 0;
  const s0 = samplesOfFrame(p.t0, seq.fps);
  const len = samplesOfFrame(p.t1, seq.fps) - s0;
  if (len <= 0) return 0;
  const at = Math.max(0, Math.min(len, seqSample - s0));
  return clipGainFactor(clip.audio, at, len, seq.original.gainDb, declickSamples(seq));
}
