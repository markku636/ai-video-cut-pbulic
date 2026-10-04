import { describe, expect, it } from "vitest";
import { timecode } from "../time";
import {
  nextShuttle,
  parseTimecodeInput,
  parseVolume,
  playRangeAction,
  rangeTick,
  SHUTTLE_STOPPED,
  shuttleLabel,
  SPEEDS,
  toggleAction,
  usePlayback,
  type Shuttle,
} from "./playback";

describe("nextShuttle", () => {
  it("L 連點 1x → 2x → 4x 封頂；J 抵銷回停", () => {
    let s = nextShuttle(SHUTTLE_STOPPED, "L", { slow: false });
    expect(s).toEqual({ dir: 1, speed: 1 });
    s = nextShuttle(s, "L", { slow: false });
    expect(s.speed).toBe(2);
    s = nextShuttle(s, "L", { slow: false });
    s = nextShuttle(s, "L", { slow: false });
    expect(s.speed).toBe(4);
    expect(nextShuttle(s, "J", { slow: false })).toEqual(SHUTTLE_STOPPED);
  });
  it("K 停；按住 K 再點是 0.5x", () => {
    expect(nextShuttle({ dir: 1, speed: 4 }, "K", { slow: false })).toEqual(SHUTTLE_STOPPED);
    expect(nextShuttle(SHUTTLE_STOPPED, "J", { slow: true })).toEqual({ dir: -1, speed: 0.5 });
    // 慢速之後再一般點：回到 1x 起算
    expect(nextShuttle({ dir: -1, speed: 0.5 }, "J", { slow: false }).speed).toBe(1);
  });
  it("倒退也是 1x → 2x → 4x；傳輸列讀數與方向一致", () => {
    const steps: Shuttle[] = [];
    let s = SHUTTLE_STOPPED;
    for (let i = 0; i < 4; i++) steps.push((s = nextShuttle(s, "J", { slow: false })));
    expect(steps.map((x) => x.speed)).toEqual([1, 2, 4, 4]);
    expect(steps.every((x) => x.dir === -1)).toBe(true);
    expect(shuttleLabel(steps[1])).toBe("◀◀ 2×");
    expect(shuttleLabel({ dir: 1, speed: 0.5 })).toBe("▶▶ 0.5×");
    expect(shuttleLabel(SHUTTLE_STOPPED)).toBe("");
  });
});

describe("playback store", () => {
  it("seek 夾 0、取整、nonce 遞增讓同一幀也能重觸發", () => {
    usePlayback.getState().seek(-3.4);
    const a = usePlayback.getState().seekReq!;
    expect(a.frame).toBe(0);
    usePlayback.getState().seek(0);
    expect(usePlayback.getState().seekReq!.nonce).toBe(a.nonce + 1);
  });
  it("setFrame 同值不產生新 state", () => {
    usePlayback.getState().setFrame(7);
    const before = usePlayback.getState();
    usePlayback.getState().setFrame(7);
    expect(usePlayback.getState()).toBe(before);
  });
  it("音量夾在 [0,1]；靜音時拉高音量＝取消靜音；拉到 0 不動靜音旗標", () => {
    const pb = usePlayback.getState();
    pb.setMuted(true);
    pb.setVolume(0);
    expect(usePlayback.getState()).toMatchObject({ volume: 0, muted: true });
    pb.setVolume(1.7);
    expect(usePlayback.getState()).toMatchObject({ volume: 1, muted: false });
    pb.setVolume(-1);
    expect(usePlayback.getState().volume).toBe(0);
    pb.toggleMute();
    expect(usePlayback.getState().muted).toBe(true);
    pb.toggleMute();
    expect(usePlayback.getState().muted).toBe(false);
  });
  it("localStorage 的音量字串：壞值 / 沒存過都是 1", () => {
    expect(parseVolume(null)).toBe(1);
    expect(parseVolume("")).toBe(1);
    expect(parseVolume("abc")).toBe(1);
    expect(parseVolume("0.35")).toBe(0.35);
    expect(parseVolume("7")).toBe(1);
    expect(parseVolume("-2")).toBe(0);
  });
  it("速度：非法值回 1×；選單有 1× 而且由慢到快", () => {
    usePlayback.getState().setRate(0);
    expect(usePlayback.getState().rate).toBe(1);
    usePlayback.getState().setRate(0.5);
    expect(usePlayback.getState().rate).toBe(0.5);
    usePlayback.getState().setRate(1);
    expect(SPEEDS).toContain(1);
    expect([...SPEEDS].sort((a, b) => a - b)).toEqual([...SPEEDS]);
  });
  it("時間碼欄位的聚焦請求每次都是新值", () => {
    const n = usePlayback.getState().tcFocus;
    usePlayback.getState().requestTimecodeFocus();
    expect(usePlayback.getState().tcFocus).toBe(n + 1);
  });
});

describe("rangeTick（範圍播放每幀的收尾判斷）", () => {
  // 30 fps，範圍 [30, 60)：1.0 s 起、2.0 s 止
  const fs = 1 / 30;
  it("範圍內繼續；時鐘到出點（不含）的起點就停", () => {
    expect(rangeTick(1.0, 1, 2, false, fs)).toBe("play");
    expect(rangeTick(1.99, 1, 2, false, fs)).toBe("play");
    expect(rangeTick(2.0, 1, 2, false, fs)).toBe("stop");
    // 浮點誤差：59.9999999/30 也算到了
    expect(rangeTick(2 - 1e-9, 1, 2, false, fs)).toBe("stop");
  });
  it("循環開：到出點回頭，不停", () => {
    expect(rangeTick(2.01, 1, 2, true, fs)).toBe("loop");
  });
  it("往回跳到入點前超過一幀＝使用者離開這段；差不到一幀是 seek 誤差，不算", () => {
    expect(rangeTick(1 - fs * 0.5, 1, 2, false, fs)).toBe("play");
    expect(rangeTick(0.5, 1, 2, false, fs)).toBe("leave");
    expect(rangeTick(0.5, 1, 2, true, fs)).toBe("leave");
  });
  it("範圍從 0 開始：時鐘不會小於 0，不會誤判離開", () => {
    expect(rangeTick(0, 0, 1, false, fs)).toBe("play");
  });
});

describe("toggleAction（Space / 播放鈕）", () => {
  const base = { shuttleDir: 0, rangePlaying: false, playing: false, loopRange: false, range: null, frame: 10 };
  it("優先序：轉盤 > 範圍播放 > 一般播放", () => {
    expect(toggleAction({ ...base, shuttleDir: -1, rangePlaying: true, playing: true })).toBe("stopShuttle");
    expect(toggleAction({ ...base, rangePlaying: true, playing: true })).toBe("stopRange");
    expect(toggleAction({ ...base, playing: true })).toBe("pause");
    expect(toggleAction(base)).toBe("play");
  });
  it("循環開、播放線在範圍內 → 從播放線循環播這段；範圍外或循環關 → 一般播放", () => {
    const range = { in: 5, out: 20 };
    expect(toggleAction({ ...base, loopRange: true, range })).toBe("playRangeFromHere");
    expect(toggleAction({ ...base, loopRange: true, range, frame: 20 })).toBe("play");
    expect(toggleAction({ ...base, loopRange: true, range, frame: 4 })).toBe("play");
    expect(toggleAction({ ...base, loopRange: false, range })).toBe("play");
    expect(toggleAction({ ...base, loopRange: true, range: null })).toBe("play");
  });
});

describe("playRangeAction（Ctrl+Shift+Space）", () => {
  it("沒有範圍不動作；正在播同一段 → 停；其他 → 從入點播", () => {
    const r = { in: 5, out: 20 };
    expect(playRangeAction(null, null)).toBe("none");
    expect(playRangeAction(null, r)).toBe("play");
    expect(playRangeAction({ in: 5, out: 20 }, r)).toBe("stop");
    expect(playRangeAction({ in: 0, out: 20 }, r)).toBe("play");
  });
});

describe("parseTimecodeInput", () => {
  const fps30 = { num: 30, den: 1 };
  const N = 1797;
  const p = (s: string, cur = 100, frames = N, fps = fps30) => parseTimecodeInput(s, fps, cur, frames);

  it("hh:mm:ss:ff / mm:ss:ff / ss:ff", () => {
    expect(p("00:00:28:12")).toBe(852);
    expect(p("00:28:12")).toBe(852);
    expect(p("28:12")).toBe(852);
    expect(p("0:0:1:0")).toBe(30);
    // drop-frame 慣用的分號也收
    expect(p("00:00:01;15")).toBe(45);
  });
  it("純整數是幀號", () => {
    expect(p("0")).toBe(0);
    expect(p("365")).toBe(365);
  });
  it("+N / -N 相對目前幀；+1.5s / -2秒 相對秒數；12.5s 是絕對秒數", () => {
    expect(p("+10", 100)).toBe(110);
    expect(p("-5", 100)).toBe(95);
    expect(p("+1.5s", 100)).toBe(145);
    expect(p("-2秒", 100)).toBe(40);
    expect(p("12.5s")).toBe(375);
    expect(p("+00:00:01:00", 100)).toBe(130);
  });
  it("夾在 [0, frames−1]", () => {
    expect(p("-500", 100)).toBe(0);
    expect(p("99999")).toBe(N - 1);
    expect(p("01:00:00:00")).toBe(N - 1);
    expect(p("5", 0, 0)).toBe(0);
  });
  it("全形數字 / 冒號 / 加減號（中文輸入法）照樣看得懂；空白忽略", () => {
    expect(p("００：２８：１２")).toBe(852);
    expect(p("＋１０", 100)).toBe(110);
    expect(p("−5", 100)).toBe(95);
    expect(p("  28:12 ")).toBe(852);
  });
  it("看不懂 → null（不偷偷進位、不猜）", () => {
    for (const bad of ["", "   ", "+", "-", "abc", "12:30:", ":12", "1.5", "00:00:01:30", "00:61:00:00", "1:2:3:4:5", "12ss", "--3"]) {
      expect(p(bad), bad).toBeNull();
    }
    // 最高位可以超過 59：「90:00」＝ 90 秒
    expect(p("90:00")).toBe(N - 1);
    expect(p("59:00")).toBe(1770);
  });
  it("與 time.ts timecode() 互為反函式（30 / 29.97 / 25 fps）", () => {
    for (const fps of [fps30, { num: 30000, den: 1001 }, { num: 25, den: 1 }]) {
      for (const f of [0, 1, 29, 30, 852, 1796, 107_999]) {
        expect(parseTimecodeInput(timecode(f, fps), fps, 0, 200_000), `${fps.num}/${fps.den} ${f}`).toBe(f);
      }
    }
  });
});
