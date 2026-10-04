import { beforeEach, describe, expect, it } from "vitest";
import { __setScheduler } from "../preview/ticker";
import { SHUTTLE_STOPPED, usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { frameOfMediaTime, mediaTimeOfFrame } from "../video/frames";
import * as P from "./playerRef";

/**
 * playerRef 的播放語意（M1 驗收的 L1 / L2 / L3）。vitest 是 node 環境、沒有 <video>：
 * 用一個照瀏覽器事件順序行為的假元素（seek 後非同步呈現新幀、片尾先 pause 再 ended、換 src 停下卻不發 pause），
 * 走的是真的 playerRef 程式，不是另寫一份純函式來測。
 */

const FPS = { num: 30, den: 1 };
const META = { fps: FPS, frames: 100 };

type FrameCb = (now: number, md: { mediaTime: number }) => void;

class FakeVideo extends EventTarget {
  src: string;
  paused = true;
  ended = false;
  volume = 1;
  muted = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  private t = 0;
  private cbs = new Map<number, FrameCb>();
  private n = 0;

  constructor(src = "asset://a.mp4") {
    super();
    this.src = src;
  }

  get currentTime(): number {
    return this.t;
  }

  set currentTime(v: number) {
    this.t = v;
    this.ended = false;
    // 瀏覽器在之後的某個 task 才把那一幀呈現出來（rVFC）
    setTimeout(() => {
      const list = [...this.cbs.values()];
      this.cbs.clear();
      list.forEach((cb) => cb(0, { mediaTime: v }));
    }, 0);
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
      this.dispatchEvent(new Event("playing"));
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  /** 播放中時鐘往前走（不是 seek：不呈現、不發事件）。 */
  advanceTo(frame: number): void {
    this.t = mediaTimeOfFrame(frame, FPS);
  }

  /** 播到片尾但事件還沒派發（ticker 可能先看到）。 */
  endSilently(): void {
    this.t = META.frames / 30;
    this.ended = true;
    this.paused = true;
  }

  /** 播到片尾：瀏覽器的順序是先 pause 再 ended。 */
  reachEnd(): void {
    this.endSilently();
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }

  /** 換 src：載入流程把元素停下、時鐘歸零，但**不發 pause**。 */
  loadSrc(src: string): void {
    this.src = src;
    this.paused = true;
    this.ended = false;
    this.t = 0;
  }
}

const asEl = (v: FakeVideo) => v as unknown as HTMLVideoElement;
/** 等 seek 的呈現回呼與 play 的 promise 都落地。 */
const settle = () => new Promise((r) => setTimeout(r, 10));
const frameOf = (v: FakeVideo) => frameOfMediaTime(v.currentTime, FPS);

beforeEach(() => {
  // node 沒有 rAF：ticker 換成永遠不跑的排程器（這裡測的是事件路徑，不靠每幀收尾）
  __setScheduler(
    () => 1,
    () => {},
  );
  usePlayback.setState({ frame: 0, playing: false, playOrigin: null, loop: null, shuttle: SHUTTLE_STOPPED, rate: 1 });
  useTimeline.setState({ range: null, loopRange: false });
});

describe("停止（L1）", () => {
  it("停著的時候按停止不會跳回舊的開播點；播放中按停止才回到開播點", async () => {
    const v = new FakeVideo();
    P.setPlayer(asEl(v), META);
    await P.seekToFrame(10);
    P.play();
    expect(usePlayback.getState().playOrigin).toBe(10);
    v.advanceTo(20);
    P.pause();
    // 暫停後手動 scrub 到別處，再按停止：留在原地
    await P.seekToFrame(50);
    P.stop();
    await settle();
    expect(frameOf(v)).toBe(50);
    expect(usePlayback.getState().frame).toBe(50);

    // 播放中按停止：停下並回到這次的開播點
    P.play();
    expect(usePlayback.getState().playOrigin).toBe(50);
    v.advanceTo(70);
    P.stop();
    await settle();
    expect(v.paused).toBe(true);
    expect(frameOf(v)).toBe(50);
  });

  it("範圍播放中按停止也算「正在動」：回到範圍的開播點", async () => {
    const v = new FakeVideo();
    P.setPlayer(asEl(v), META);
    P.playRange(30, 60, { loop: false, from: 35 });
    await settle();
    expect(P.isRangePlaying()).toBe(true);
    v.advanceTo(45);
    P.stop();
    await settle();
    expect(P.isRangePlaying()).toBe(false);
    expect(frameOf(v)).toBe(35);
  });
});

describe("播放此鏡頭播到片尾（L2）", () => {
  it("循環開著、沒有範圍：範圍播到片尾就停在那裡，不從第 0 幀把整支再播一遍", async () => {
    useTimeline.setState({ loopRange: true, range: null });
    const v = new FakeVideo();
    P.setPlayer(asEl(v), META);
    P.playRange(90, 100, { loop: false });
    await settle();
    expect(P.isRangePlaying()).toBe(true);
    expect(v.paused).toBe(false);

    v.reachEnd();
    await settle();
    expect(P.isRangePlaying()).toBe(false);
    expect(v.paused).toBe(true);
    expect(frameOf(v)).toBe(100);
  });

  it("ticker 先看到片尾（監聽已拆、ended 事件還在後面）也一樣不從頭播", async () => {
    useTimeline.setState({ loopRange: true, range: null });
    const v = new FakeVideo();
    P.setPlayer(asEl(v), META);
    P.playRange(90, 100, { loop: false });
    await settle();
    v.endSilently();
    P.stopRange();
    v.dispatchEvent(new Event("pause"));
    v.dispatchEvent(new Event("ended"));
    await settle();
    expect(v.paused).toBe(true);
    expect(frameOf(v)).toBe(100);
  });

  it("記號不會殘留：之後一般播放播到片尾，循環照常從頭來", async () => {
    useTimeline.setState({ loopRange: true, range: null });
    const v = new FakeVideo();
    P.setPlayer(asEl(v), META);
    P.playRange(90, 100, { loop: false });
    await settle();
    v.reachEnd();
    await settle();

    P.play();
    await settle();
    v.reachEnd();
    await settle();
    expect(v.paused).toBe(false);
    expect(frameOf(v)).toBe(0);
  });
});

describe("換媒體（L3）", () => {
  it("同一個 <video> 換 src：範圍播放、開播點一起收掉；proxy 物件換新（src 不變）不打斷", async () => {
    const v = new FakeVideo("asset://a.mp4");
    P.setPlayer(asEl(v), META);
    P.playRange(0, 30, { loop: true });
    await settle();
    expect(P.isRangePlaying()).toBe(true);

    // proxy 物件換新：VideoStage 先卸再綁回同一個元素、src 沒變
    P.setPlayer(null, null);
    P.setPlayer(asEl(v), { ...META });
    expect(P.isRangePlaying()).toBe(true);
    expect(usePlayback.getState().loop).toEqual({ in: 0, out: 30 });

    // 換到另一支：元素被載入流程停下但沒有 pause 事件
    v.loadSrc("asset://b.mp4");
    P.setPlayer(null, null);
    P.setPlayer(asEl(v), { fps: FPS, frames: 50 });
    expect(P.isRangePlaying()).toBe(false);
    expect(usePlayback.getState().loop).toBeNull();
    expect(usePlayback.getState().playOrigin).toBeNull();
  });

  it("換媒體時前進轉盤停下、倍率還原、傳輸列讀數歸零", async () => {
    const v = new FakeVideo("asset://a.mp4");
    P.setPlayer(asEl(v), META);
    const sh = { dir: 1 as const, speed: 2 };
    usePlayback.getState().setShuttle(sh);
    P.applyShuttle(sh);
    expect(v.playbackRate).toBe(2);

    v.loadSrc("asset://b.mp4");
    P.setPlayer(asEl(v), { fps: FPS, frames: 50 });
    expect(usePlayback.getState().shuttle.dir).toBe(0);
    expect(v.playbackRate).toBe(1);
  });
});
