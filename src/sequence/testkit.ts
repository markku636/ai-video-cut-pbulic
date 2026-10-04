// 序列剪輯測試共用的小工具與假媒體（只給 *.test.ts 用；App 程式不 import）。
import { expect } from "vitest";
import { defaultClipAudio, type AudioClipV2, type AudioInfoV2, type AudioLaneV2, type AudioMediaV2, type AudioRole, type GapV2, type ProjectMediaV2, type Rational, type SequenceV2, type VideoClipV2, type VideoItemV2 } from "../project/format";
import { makeSeqCtx } from "./context";
import { validateSequence } from "./validate";

export const FPS30: Rational = { num: 30, den: 1 };
export const FPS2997: Rational = { num: 30000, den: 1001 };

function proxy(frames: number, fps: Rational = FPS30, width = 1280, height = 720) {
  return { version: 1 as const, fps, frames, width, height, scale: 1, path: "C:\\cache\\proxy.mp4" };
}

export function audio48(nSamples: number, startUs = 0, videoStartUs: number | null = 0): AudioInfoV2 {
  return { codec: "opus", sampleRate: 48000, channels: 2, channelLayout: "stereo", startUs, videoStartUs, nSamples, gaps: [] };
}

const media = (id: string, p: ReturnType<typeof proxy> | null, a: AudioInfoV2 | null = null): ProjectMediaV2 => ({ id, path: `D:\\v\\${id}.webm`, name: `${id}.webm`, fingerprint: "", probe: null, proxy: p, audio: a });

/** m1：範例影片（30 fps、1797 幀、1280×720），音訊比畫面晚 6.5 ms 開始（設計 M2.15 驗收的數字）。 */
export const M1 = media("m1", proxy(1797), audio48(2875200, 6500, 0));
export const M2 = media("m2", proxy(600), audio48(960000));
export const M25 = media("m25", proxy(500, { num: 25, den: 1 }));
export const MBIG = media("mbig", proxy(300, FPS30, 1920, 1080));
export const MNOPROXY = media("mnone", null);
export const M2997 = media("m2997", proxy(3000, FPS2997, 1280, 720), audio48(4804800));

export const A_MUSIC: AudioMediaV2 = { id: "a-music", path: "D:\\music\\bgm.mp3", name: "bgm.mp3", fingerprint: "", probe: null, role: "music", audio: { codec: "mp3", sampleRate: 44100, channels: 2, channelLayout: "stereo", startUs: 25057, videoStartUs: null, nSamples: 2646000, gaps: [] } };
export const A_VO: AudioMediaV2 = { id: "a-vo", path: "D:\\vo\\vo.wav", name: "vo.wav", fingerprint: "", probe: null, role: "voiceover", audio: { ...audio48(4800000, 0, null), codec: "pcm_s16le", channels: 1, channelLayout: "mono" } };

export const CTX = makeSeqCtx([M1, M2, M25, MBIG, MNOPROXY, M2997], [A_MUSIC, A_VO]);

export function vclip(id: string, mediaId: string, srcIn: number, srcOut: number, over: Partial<VideoClipV2> = {}): VideoClipV2 {
  return { kind: "clip", id, mediaId, srcIn, srcOut, enabled: true, audio: defaultClipAudio(), ...over };
}

export function gap(id: string, length: number): GapV2 {
  return { kind: "gap", id, length };
}

export function aclip(id: string, audioId: string, start: number, length: number, over: Partial<AudioClipV2> = {}): AudioClipV2 {
  return { id, source: { type: "audio", audioId }, start, length, srcIn: 0, enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], ...over };
}

export function lane(id: string, role: AudioRole, clips: AudioClipV2[], over: Partial<AudioLaneV2> = {}): AudioLaneV2 {
  return { id, name: id, role, muted: false, locked: false, syncLock: role !== "music", gainDb: 0, clips, ...over };
}

export function seqOf(video: VideoItemV2[], audioLanes: AudioLaneV2[] = [], fps: Rational = FPS30): SequenceV2 {
  return { id: "seq-1", name: "t", fps, width: 1280, height: 720, sampleRate: 48000, video, original: { muted: false, gainDb: 0 }, audioLanes, audio: { edgeDeclickMs: 3, limiter: false } };
}

/** 每個案例的收尾（§13 M2.3 驗收：每個案例都跑 validateSequence）。回傳同一個序列方便串接。 */
export function ok(seq: SequenceV2): SequenceV2 {
  expect(validateSequence(seq, CTX)).toEqual([]);
  return seq;
}

/** 深凍結：剪輯函式若偷偷改了輸入，嚴格模式下會當場擲 TypeError。 */
export function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
}

export const clipsOf = (seq: SequenceV2, laneId: string) => seq.audioLanes.find((l) => l.id === laneId)!.clips;
export const spans = (clips: readonly AudioClipV2[]) => clips.map((c) => [c.start, c.length, c.srcIn]);
