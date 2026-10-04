// 剪輯純函式需要的專案事實（docs/editor-m2-design.md §6 `editSequence(label, f(seq, ctx))` 的 ctx）。
//
// 為什麼不直接吃 ProjectMediaV2[]：剪輯函式只需要「幀數、fps、尺寸、音訊時間資訊」四樣東西，
// 測試用一行就能造出來；store 那邊（M2.4）再用 makeSeqCtx 從 project 狀態包一層。
import type { AudioInfoV2, AudioMediaV2, AudioSourceRefV2, ProjectMediaV2, Rational } from "../project/format";

export interface SeqMediaInfo {
  id: string;
  /** 顯示用（實體化時當序列名稱）。 */
  name: string;
  /** proxy 幀數；null = proxy 還沒好（不能實體化、不能往後延長片段）。 */
  frames: number | null;
  fps: Rational | null;
  /** 來源像素尺寸（序列在來源像素空間工作）。 */
  width: number | null;
  height: number | null;
  /** media.audio_info 的結果；null = 還沒跑或沒有音訊（不能分離音訊）。 */
  audio: AudioInfoV2 | null;
}

export interface SeqCtx {
  media(mediaId: string): SeqMediaInfo | undefined;
  audioMedia(audioId: string): AudioMediaV2 | undefined;
}

/** 來源尺寸：probe.video 優先（來源像素）；沒有 probe 時用 proxy 尺寸除以縮放比還原。 */
export function mediaInfoOf(m: ProjectMediaV2): SeqMediaInfo {
  const v = m.probe?.video;
  const px = m.proxy;
  const width = v?.width ?? (px ? Math.round(px.width / (px.scale || 1)) : null);
  const height = v?.height ?? (px ? Math.round(px.height / (px.scale || 1)) : null);
  return { id: m.id, name: m.name, frames: px?.frames ?? null, fps: px ? { num: px.fps.num, den: px.fps.den } : null, width, height, audio: m.audio ?? null };
}

export function makeSeqCtx(media: readonly ProjectMediaV2[], audioMedia: readonly AudioMediaV2[] = []): SeqCtx {
  const byId = new Map(media.map((m) => [m.id, mediaInfoOf(m)]));
  const amById = new Map(audioMedia.map((a) => [a.id, a]));
  return { media: (id) => byId.get(id), audioMedia: (id) => amById.get(id) };
}

/** 音訊片段來源的音訊資訊（分離的原音看 media、音樂看 audioMedia）。 */
export function sourceAudioInfo(ctx: SeqCtx | undefined, src: AudioSourceRefV2): AudioInfoV2 | null {
  if (!ctx) return null;
  return (src.type === "media" ? ctx.media(src.mediaId)?.audio : ctx.audioMedia(src.audioId)?.audio) ?? null;
}
