// 序列預覽播放器（M2.11）：純函式 nextBoundaryAction 等的案例，加上用假 <video> 走真的播放器程式的接點行為
//（接點提前 seek、來源連續不 seek、換媒體吞掉 Workspace 的 seek(0)、空白以序列 fps 前進、範圍 / 停止 / 逐幀、playerRef 委派）。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SequenceV2 } from "../project/format";
import { __setScheduler } from "../preview/ticker";
import { placeVideo } from "../sequence/map";
import { FPS2997, FPS30, gap, seqOf, vclip } from "../sequence/testkit";
import { SHUTTLE_STOPPED, usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { frameOfMediaTime } from "../video/frames";
import * as P from "./playerRef";
import * as SP from "./sequencePlayer";

// ---------------------------------------------------------------------------- 純函式

describe("resolveSeqTarget", () => {
  const seq = seqOf([vclip("c1", "m1", 100, 130), gap("g", 10), vclip("c2", "m1", 0, 20, { enabled: false }), vclip("c3", "m2", 5, 15)]);
  it("片段回 (媒體, k)；空白 / 停用 → 黑畫面並帶原因；t ≥ T → end", () => {
    expect(SP.resolveSeqTarget(seq, 0)).toMatchObject({ kind: "clip", mediaId: "m1", k: 100, t0: 0, t1: 30 });
    expect(SP.resolveSeqTarget(seq, 29)).toMatchObject({ kind: "clip", k: 129 });
    expect(SP.resolveSeqTarget(seq, 30)).toMatchObject({ kind: "black", reason: "gap", t0: 30, t1: 40 });
    expect(SP.resolveSeqTarget(seq, 45)).toMatchObject({ kind: "black", reason: "disabled", t0: 40, t1: 60 });
    expect(SP.resolveSeqTarget(seq, 60)).toMatchObject({ kind: "clip", mediaId: "m2", k: 5 });
    expect(SP.resolveSeqTarget(seq, 70)).toEqual({ kind: "end", t: 70 });
    expect(SP.resolveSeqTarget(seqOf([]), 0)).toEqual({ kind: "end", t: 0 });
  });

  it("沒有 proxy（framesOf = null）或 srcOut 超過 proxy 幀數 → 離線（黑畫面，不去播它）", () => {
    expect(SP.resolveSeqTarget(seq, 60, undefined, (id) => (id === "m2" ? null : 1000))).toMatchObject({ kind: "black", reason: "offline" });
    expect(SP.resolveSeqTarget(seq, 0, undefined, () => 120)).toMatchObject({ kind: "black", reason: "offline" });
    expect(SP.resolveSeqTarget(seq, 0, undefined, () => 130)).toMatchObject({ kind: "clip" });
  });
});

describe("nextBoundaryAction（M2.11 驗收的純函式）", () => {
  it("不是項目的最後一幀 → none", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 60, 90)]);
    expect(SP.nextBoundaryAction(seq, 0)).toEqual({ kind: "none" });
    expect(SP.nextBoundaryAction(seq, 28)).toEqual({ kind: "none" });
  });

  it("同媒體不連續 → seek 到下一段 srcIn；倒序片段也一樣", () => {
    const seq = seqOf([vclip("a", "m1", 60, 90), vclip("b", "m1", 0, 30)]);
    const a = SP.nextBoundaryAction(seq, 29);
    expect(a).toMatchObject({ kind: "seek", next: { t: 30, k: 0, mediaId: "m1" } });
  });

  it("B 切一刀的兩段（同媒體、左 srcOut == 右 srcIn）→ continue，不 seek", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 30, 60), vclip("c", "m1", 90, 120)]);
    expect(SP.nextBoundaryAction(seq, 29)).toMatchObject({ kind: "continue", next: { t: 30, k: 30 } });
    expect(SP.nextBoundaryAction(seq, 59)).toMatchObject({ kind: "seek", next: { t: 60, k: 90 } });
  });

  it("換媒體 → switch；已載入的是下一段的媒體（空白之後）→ seek", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m2", 10, 40)]);
    expect(SP.nextBoundaryAction(seq, 29)).toMatchObject({ kind: "switch", next: { mediaId: "m2", k: 10 } });
    const withGap = seqOf([gap("g", 5), vclip("b", "m2", 10, 40)]);
    expect(SP.nextBoundaryAction(withGap, 4, { loadedMediaId: "m2" })).toMatchObject({ kind: "seek", next: { k: 10 } });
    expect(SP.nextBoundaryAction(withGap, 4, { loadedMediaId: "m1" })).toMatchObject({ kind: "switch" });
  });

  it("停用片段不算連續：[0,30) 後面接停用的 [30,60) → black（disabled）", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 30, 60, { enabled: false }), vclip("c", "m1", 60, 90)]);
    expect(SP.nextBoundaryAction(seq, 29)).toMatchObject({ kind: "black", next: { reason: "disabled", t0: 30, t1: 60 } });
    // 停用片段的最後一幀之後是來源連續的片段，但目前項目是黑畫面 → 仍要 seek
    expect(SP.nextBoundaryAction(seq, 59, { loadedMediaId: "m1" })).toMatchObject({ kind: "seek", next: { k: 60 } });
  });

  it("空白 → black；最後一個項目的最後一幀 → end（t = T）；t 超出 → end", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), gap("g", 12)]);
    expect(SP.nextBoundaryAction(seq, 29)).toMatchObject({ kind: "black", next: { reason: "gap", t: 30, t1: 42 } });
    expect(SP.nextBoundaryAction(seq, 41)).toEqual({ kind: "end", t: 42 });
    expect(SP.nextBoundaryAction(seq, 500)).toEqual({ kind: "end", t: 42 });
  });

  it("下一段離線（沒有 proxy）→ black offline", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m9", 0, 30)]);
    expect(SP.nextBoundaryAction(seq, 29, { framesOf: (id) => (id === "m9" ? null : 1000) })).toMatchObject({ kind: "black", next: { reason: "offline" } });
  });
});

describe("contiguousEnd / nearestOccurrence / gapFrameAt / boundaryLeadSec", () => {
  it("contiguousEnd 沿著連續來源接到底：中途開始也對（endK 跟著平移）", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 30, 60), vclip("c", "m1", 60, 61), vclip("d", "m1", 200, 230)]);
    const start = SP.resolveSeqTarget(seq, 10) as SP.ClipTarget;
    expect(SP.contiguousEnd(seq, start)).toEqual({ endT: 61, endK: 61 });
    const d = SP.resolveSeqTarget(seq, 70) as SP.ClipTarget;
    expect(SP.contiguousEnd(seq, d)).toEqual({ endT: 91, endK: 230 });
  });

  it("nearestOccurrence：同一來源幀用兩次時挑離 near 最近的那一次；沒用到回 null", () => {
    const seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m2", 0, 30), vclip("c", "m1", 10, 20)]);
    const placed = placeVideo(seq);
    expect(SP.nearestOccurrence(placed, "m1", 15, 0)).toBe(15);
    expect(SP.nearestOccurrence(placed, "m1", 15, 64)).toBe(65);
    expect(SP.nearestOccurrence(placed, "m1", 25, 64)).toBe(25);
    expect(SP.nearestOccurrence(placed, "m1", 40, 0)).toBeNull();
    expect(SP.nearestOccurrence(placed, "m3", 1, 0)).toBeNull();
  });

  it("gapFrameAt 以序列 fps 前進（29.97 的 1001 ms = 30 幀，不會因浮點少一幀）；速度倍率照乘", () => {
    expect(SP.gapFrameAt(100, 0, FPS30)).toBe(100);
    expect(SP.gapFrameAt(100, 999, FPS30)).toBe(129);
    expect(SP.gapFrameAt(100, 1000, FPS30)).toBe(130);
    expect(SP.gapFrameAt(0, 1001, FPS2997)).toBe(30);
    expect(SP.gapFrameAt(0, 500, FPS30, 2)).toBe(30);
    expect(SP.gapFrameAt(7, -50, FPS30)).toBe(7);
  });

  it("boundaryLeadSec：約 1.2 個 tick、夾在 8～25 ms、乘速度、上限半幀", () => {
    expect(SP.boundaryLeadSec(FPS30, 1, 16.7)).toBeCloseTo(0.01667, 4); // 20 ms 超過半幀 16.7 ms → 半幀
    expect(SP.boundaryLeadSec(FPS30, 1, 5)).toBeCloseTo(0.008, 6);
    expect(SP.boundaryLeadSec({ num: 24, den: 1 }, 1, 16.7)).toBeCloseTo(0.02, 4);
    expect(SP.boundaryLeadSec({ num: 60, den: 1 }, 2, 16.7)).toBeCloseTo(1 / 120, 6);
  });
});

// ---------------------------------------------------------------------------- 執行期（假 <video>）

type FrameCb = (now: number, md: { mediaTime: number }) => void;

/** 照瀏覽器行為的假元素：seek 期間 seeking = true、下一個 task 才呈現；play 同步把 paused 清掉。 */
class FakeVideo extends EventTarget {
  src: string;
  paused = true;
  ended = false;
  seeking = false;
  volume = 1;
  muted = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  crossOrigin: string | null = null;
  private t = 0;
  private cbs = new Map<number, FrameCb>();
  private n = 0;
  /** 呈現過的幀（k），量「有沒有顯示片段外的幀」。 */
  presented: number[] = [];

  constructor(src: string) {
    super();
    this.src = src;
  }

  get currentTime(): number {
    return this.t;
  }

  set currentTime(v: number) {
    this.t = v;
    this.ended = false;
    this.seeking = true;
    setTimeout(() => {
      this.seeking = false;
      this.present();
      this.dispatchEvent(new Event("seeked"));
    }, 0);
  }

  /** 呈現目前時鐘所在的幀（rVFC + VideoStage 的 onPresentedFrame）。 */
  present(): void {
    const k = frameOfMediaTime(this.t, FPS30);
    this.presented.push(k);
    const list = [...this.cbs.values()];
    this.cbs.clear();
    list.forEach((cb) => cb(0, { mediaTime: this.t }));
    SP.onPresentedFrame(k, { mediaTime: k / 30 });
  }

  requestVideoFrameCallback(cb: FrameCb): number {
    const id = ++this.n;
    this.cbs.set(id, cb);
    return id;
  }

  cancelVideoFrameCallback(id: number): void {
    this.cbs.delete(id);
  }

  play(): Promise<void> {
    if (this.paused) {
      this.paused = false;
      this.dispatchEvent(new Event("play"));
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  /** 播放中時鐘往前走到第 f 幀（小數）但還沒呈現。 */
  advanceTo(f: number): void {
    this.t = f / 30;
  }

  loadSrc(src: string): void {
    this.src = src;
    this.paused = true;
    this.t = 0;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const asEl = (v: FakeVideo) => v as unknown as HTMLVideoElement;

let seq: SequenceV2;
let loaded = "m1";
let clock = 0;
let activations: string[] = [];
let loopRange = false;
let range: { in: number; out: number } | null = null;
let video: FakeVideo;

function mountVideo(mediaId: string, frames = 1000): void {
  P.setPlayer(asEl(video), { fps: FPS30, frames });
  loaded = mediaId;
}

beforeAll(() => {
  SP.installSequencePlayer();
});

beforeEach(() => {
  __setScheduler(
    () => 1,
    () => {},
  );
  usePlayback.setState({ frame: 0, seqFrame: null, seqSeekReq: null, seekReq: null, playing: false, playOrigin: null, loop: null, shuttle: SHUTTLE_STOPPED, rate: 1 });
  useTimeline.setState({ range: null, loopRange: false });
  loaded = "m1";
  clock = 0;
  activations = [];
  loopRange = false;
  range = null;
  SP.__setSeqEnv({
    sequence: () => seq,
    loadedMediaId: () => loaded,
    framesOf: () => 1000,
    activate: (id) => {
      activations.push(id);
      loaded = id;
    },
    loopRange: () => loopRange,
    range: () => range,
    now: () => clock,
  });
  video = new FakeVideo("asset://m1.mp4");
  mountVideo("m1");
});

afterEach(async () => {
  // 上一個案例還在飛的 seek（假元素的 setTimeout）要先落地，不然會打到下一個案例的播放器狀態
  await settle();
  SP.__setSeqEnv(null);
  P.setPlayer(null, null);
});

describe("接點（M2.11）", () => {
  it("同媒體不連續：時鐘離出點不到提前量才 seek；片段外的幀從沒上屏；頓挫記一筆", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 60, 90)]);
    SP.sequencePlay();
    expect(video.paused).toBe(false);
    expect(SP.sequencePhase()).toBe("video");
    video.advanceTo(29.4);
    SP.__tickSequencePlayer();
    expect(video.seeking).toBe(false); // 還差 0.6 幀 > 提前量：不動
    video.advanceTo(29.6);
    clock = 1000;
    SP.__tickSequencePlayer();
    expect(video.seeking).toBe(true);
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(60);
    expect(usePlayback.getState().seqFrame).toBe(30);
    clock = 1080;
    await settle();
    expect(video.presented.every((k) => (k >= 0 && k < 30) || (k >= 60 && k < 90))).toBe(true);
    const st = SP.sequencePlayerStats();
    expect(st.boundaries).toBe(1);
    expect(st.stallsMs).toEqual([80]);
    expect(st.outside).toBe(0);
  });

  it("最後一幀一上屏（rVFC）就動手，不等 tick 的提前量：下一幀（片段外）來不及上屏", () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 60, 90)]);
    SP.sequencePlay();
    video.advanceTo(28.2);
    video.present();
    expect(video.seeking).toBe(false);
    video.advanceTo(29.05);
    video.present();
    expect(video.seeking).toBe(true);
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(60);
    expect(usePlayback.getState().seqFrame).toBe(30);
  });

  it("B 切一刀的兩段：切點上不 seek（元素照播），seqFrame 跟著 k 走過去", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 30, 60)]);
    SP.sequencePlay();
    video.advanceTo(29.9);
    SP.__tickSequencePlayer();
    expect(video.seeking).toBe(false);
    video.advanceTo(35.2);
    video.present();
    expect(usePlayback.getState().seqFrame).toBe(35);
    expect(SP.sequencePlayerStats().boundaries).toBe(0);
  });

  it("元素呈現了片段外的幀（接點太晚）→ 記進 outside（量尺的失敗條件）", () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 60, 90)]);
    SP.sequencePlay();
    video.advanceTo(30.2);
    video.present();
    expect(SP.sequencePlayerStats().outside).toBe(1);
  });

  it("換媒體：pause → activate → 綁好新 src 才 seek 到 k 再播；Workspace 的 seek(0) 被吞掉一次", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m2", 10, 40)]);
    SP.sequencePlay();
    video.advanceTo(29.7);
    SP.__tickSequencePlayer();
    expect(activations).toEqual(["m2"]);
    expect(video.paused).toBe(true);
    expect(SP.sequenceSwitching()).toBe(true);
    // Workspace：換片 → seek(0)
    usePlayback.getState().seek(0);
    expect(SP.consumeSeekReq(usePlayback.getState().seekReq)).toBe(true);
    expect(SP.consumeSeekReq({ frame: 0, nonce: 999 })).toBe(false); // 只吞一次
    // React 換了 src、VideoStage 重新 setPlayer
    video.loadSrc("asset://m2.mp4");
    P.setPlayer(asEl(video), { fps: FPS30, frames: 500 });
    expect(SP.sequencePhase()).toBe("video");
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(10);
    expect(video.paused).toBe(false);
    await settle();
    expect(usePlayback.getState().seqFrame).toBe(30);
  });

  it("空白：元素暫停、舞台黑畫面，ticker 以序列 fps 前進；走完 seek 到下一段並接著播", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), gap("g", 15), vclip("b", "m1", 60, 90)]);
    SP.sequencePlay();
    video.advanceTo(29.7);
    SP.__tickSequencePlayer();
    expect(SP.sequencePhase()).toBe("black");
    expect(SP.useSeqStage.getState().black).toBe("gap");
    expect(video.paused).toBe(true);
    expect(SP.sequencePlaying()).toBe(true);
    // 動手時時鐘還差 0.3 幀（10 ms）才到出點：黑畫面從出點那一刻起算，不是從動手那一刻
    clock = 400;
    SP.__tickSequencePlayer();
    expect(usePlayback.getState().seqFrame).toBe(41);
    clock = 505;
    SP.__tickSequencePlayer();
    expect(SP.sequencePhase()).toBe("black");
    clock = 510;
    SP.__tickSequencePlayer();
    expect(SP.sequencePhase()).toBe("video");
    expect(SP.useSeqStage.getState().black).toBeNull();
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(60);
    expect(video.paused).toBe(false);
    expect(SP.sequencePlayerStats().blackMs).toEqual([{ expected: 500, actual: 500 }]);
    await settle();
    expect(usePlayback.getState().seqFrame).toBe(45);
  });

  it("序列尾巴：停在 T−1；循環開、沒有範圍 → 從頭來", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30)]);
    SP.sequencePlay();
    video.advanceTo(29.8);
    SP.__tickSequencePlayer();
    expect(SP.sequencePlaying()).toBe(false);
    expect(video.paused).toBe(true);
    expect(usePlayback.getState().seqFrame).toBe(29);
    loopRange = true;
    SP.sequencePlay();
    await settle();
    video.advanceTo(29.8);
    SP.__tickSequencePlayer();
    expect(SP.sequencePlaying()).toBe(true);
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(0);
  });
});

describe("範圍、停止、逐幀、seek", () => {
  it("範圍播放以序列幀為準：跨片段到出點停在 out−1；loop 時回入點", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 100, 130)]);
    SP.sequencePlayRange(20, 40, { loop: false });
    expect(usePlayback.getState().loop).toEqual({ in: 20, out: 40 });
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(20);
    await settle();
    video.advanceTo(29.7);
    SP.__tickSequencePlayer();
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(100);
    await settle();
    video.advanceTo(109.7);
    SP.__tickSequencePlayer();
    expect(SP.sequencePlaying()).toBe(false);
    expect(usePlayback.getState().loop).toBeNull();
    expect(usePlayback.getState().seqFrame).toBe(39);
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(109);

    await settle();
    SP.sequencePlayRange(20, 40, { loop: true });
    await settle();
    video.advanceTo(29.7);
    SP.__tickSequencePlayer();
    await settle();
    video.advanceTo(109.8);
    SP.__tickSequencePlayer();
    expect(SP.sequencePlaying()).toBe(true);
    expect(usePlayback.getState().seqFrame).toBe(20);
  });

  it("停止：播放中才回到開播點；逐幀跨片段與空白", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), gap("g", 2), vclip("b", "m1", 100, 130)]);
    usePlayback.getState().setSeqFrame(10);
    SP.sequencePlay();
    await settle();
    video.advanceTo(15);
    video.present();
    SP.sequenceStop();
    expect(usePlayback.getState().seqFrame).toBe(10);
    SP.sequenceStop();
    expect(usePlayback.getState().seqFrame).toBe(10);
    await settle();

    usePlayback.getState().setSeqFrame(29);
    void SP.sequenceStep(1);
    expect(SP.useSeqStage.getState().black).toBe("gap");
    expect(usePlayback.getState().seqFrame).toBe(30);
    void SP.sequenceStep(2);
    expect(SP.useSeqStage.getState().black).toBeNull();
    expect(usePlayback.getState().seqFrame).toBe(32);
    expect(frameOfMediaTime(video.currentTime, FPS30)).toBe(100);
  });

  it("別人用 k 做了 seek（素材空間的指令）→ seqFrame 對到離目前最近的出現位置", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m1", 0, 30)]);
    SP.seekSequenceFrame(40);
    await settle();
    expect(usePlayback.getState().seqFrame).toBe(40);
    void P.seekToFrame(12);
    await settle();
    expect(usePlayback.getState().seqFrame).toBe(42);
  });
});

describe("playerRef 委派", () => {
  it("序列模式：Space / 停止 / 逐幀轉給序列播放器；不在序列模式（sequence() = null）一律走 M1", async () => {
    seq = seqOf([vclip("a", "m1", 0, 30), gap("g", 30)]);
    usePlayback.getState().setSeqFrame(35);
    P.togglePlay();
    expect(SP.sequencePlaying()).toBe(true);
    expect(SP.useSeqStage.getState().black).toBe("gap");
    expect(video.paused).toBe(true); // 空白上：元素不播，序列在播
    P.togglePlay();
    expect(SP.sequencePlaying()).toBe(false);

    SP.__setSeqEnv({ sequence: () => null, loadedMediaId: () => "m1", now: () => clock });
    P.togglePlay();
    expect(SP.sequencePlaying()).toBe(false);
    expect(video.paused).toBe(false); // M1：直接播元素
    P.pause();
    expect(video.paused).toBe(true);
    await settle();
  });

  it("換媒體中的 setPlayer 不重置轉盤讀數與開播點（那是序列的狀態）", () => {
    seq = seqOf([vclip("a", "m1", 0, 30), vclip("b", "m2", 0, 30)]);
    SP.sequencePlay();
    usePlayback.setState({ shuttle: { dir: 1, speed: 2 }, playOrigin: 3 });
    video.advanceTo(29.8);
    SP.__tickSequencePlayer();
    expect(SP.sequenceSwitching()).toBe(true);
    video.loadSrc("asset://m2.mp4");
    P.setPlayer(asEl(video), { fps: FPS30, frames: 30 });
    expect(usePlayback.getState().shuttle).toEqual({ dir: 1, speed: 2 });
    expect(usePlayback.getState().playOrigin).toBe(3);
  });
});

describe("seekSeq（playback store）", () => {
  it("先寫 seqFrame（播放線立刻到位）再發一次性請求；同一幀可重複觸發", () => {
    usePlayback.getState().seekSeq(12.4);
    const a = usePlayback.getState().seqSeekReq;
    expect(usePlayback.getState().seqFrame).toBe(12);
    usePlayback.getState().seekSeq(12);
    expect(usePlayback.getState().seqSeekReq?.nonce).toBe((a?.nonce ?? 0) + 1);
    usePlayback.getState().seekSeq(-5);
    expect(usePlayback.getState().seqFrame).toBe(0);
  });
});

