// M2.14 匯入音訊與加入媒體（docs/editor-m2-design.md §13 M2.14 驗收）：
// 拖入 wav／mp3／m4a／flac／opus 片段出現在放下的幀（吸附）、fps 不符顯示可操作錯誤、一次 Ctrl+Z 移除片段與 audioMedia。
// 真的 project / edits / timeline / settings store；只把 Tauri IPC、引擎 job、檔案對話框換掉。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProbe } from "../api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("not tauri"))), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const probes = new Map<string, MediaProbe>();
vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return {
    ...orig,
    api: {
      ...orig.api,
      mediaProbe: async (path: string) => {
        const p = probes.get(path);
        if (!p) throw new Error(`ffprobe 失敗：${path}`);
        return p;
      },
      // 波形 job 在背景跑：這裡讓它失敗（工作清單記錯誤），不影響放置
      mediaPeaks: async () => {
        throw new Error("no peaks in tests");
      },
      mediaCacheStatus: async () => {
        throw new Error("not tauri");
      },
    },
  };
});

const runEngineJob = vi.fn<(opts: { op: string; args: Record<string, unknown> }) => Promise<unknown>>();
vi.mock("./engineJob", () => ({
  runEngineJob: (opts: { op: string; args: Record<string, unknown> }) => runEngineJob(opts),
  dedupe: <T,>(_key: string, run: () => Promise<T>) => run(),
}));

const { useProject, audioMediaIdOf } = await import("../store/project");
const { useEdits, SEQ_EDIT_LABEL } = await import("../store/edits");
const { useSettings } = await import("../store/settings");
const { useTimeline } = await import("../store/timeline");
const { useEngine } = await import("../store/engine");
const { useUi } = await import("../ui");
const { layoutSequenceRows, TRACK_HEADER_W } = await import("../frametimeline/layoutSequence");
const { M1, M2, M25, MBIG, MNOPROXY, FPS30, seqOf, vclip, lane, aclip, A_MUSIC } = await import("../sequence/testkit");
const { samplesOfFrame } = await import("../sequence/map");
const ops = await import("../sequence/ops");
const { validateSequence } = await import("../sequence/validate");
const { makeSeqCtx } = await import("../sequence/context");
const A = await import("./audio");

const fp = (n: number) => n.toString(16).padStart(4, "0").repeat(16);

function audioProbe(path: string, n: number, codec: string, durationMs: number, sampleRate = 48000, channels = 2): MediaProbe {
  return {
    path,
    size_bytes: 1000,
    duration_ms: durationMs,
    container: codec,
    audio: { codec, sample_rate: sampleRate, channels, bit_rate: null, duration_ms: durationMs },
    video: null,
    fingerprint: fp(n),
  };
}

/** 驗收的五種格式（長度各不同：角色猜測與長度退路一起驗）。 */
const FILES = [
  { path: "D:\\音效\\ding.wav", codec: "pcm_s16le", ms: 1500, sr: 48000 },
  { path: "D:\\music\\bgm song.mp3", codec: "mp3", ms: 95_000, sr: 44100 },
  { path: "D:\\vo\\旁白 01.m4a", codec: "aac", ms: 20_000, sr: 48000 },
  { path: "D:\\sfx\\whoosh.flac", codec: "flac", ms: 800, sr: 96000 },
  { path: "D:\\rec\\take.opus", codec: "opus", ms: 30_000, sr: 48000 },
];

const flush = () => new Promise((r) => setTimeout(r, 0));
/** tsconfig lib 是 ES2020，沒有 Array.prototype.at。 */
const lastOf = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

beforeEach(() => {
  probes.clear();
  FILES.forEach((f, i) => probes.set(f.path, audioProbe(f.path, i + 1, f.codec, f.ms, f.sr)));
  runEngineJob.mockReset();
  useProject.getState().newProject();
  useProject.setState({ media: [M1, M2, M25, MBIG, MNOPROXY].map((m) => ({ ...m, proxyState: m.proxy ? ("ready" as const) : ("none" as const) })), activeMediaId: "m1" });
  useSettings.getState().setExperimental({ sequence: true });
  useTimeline.setState({ space: "sequence", pxPerFrame: 10, scrollFrame: 0, fitPxPerFrame: 1 });
  useEngine.setState({ info: null, pyenv: null, state: "down" });
  useUi.setState({ toasts: [] });
});

// ---------------------------------------------------------------- 純函式

describe("副檔名與角色", () => {
  it("isAudioPath：驗收的五種格式（大小寫不拘）認得；影片容器與沒有主檔名的不認", () => {
    for (const f of FILES) expect(A.isAudioPath(f.path)).toBe(true);
    expect(A.isAudioPath("C:/x/SONG.MP3")).toBe(true);
    expect(A.isAudioPath("a.ogg") && A.isAudioPath("a.aiff") && A.isAudioPath("a.aac")).toBe(true);
    expect(A.isAudioPath("clip.mp4")).toBe(false);
    expect(A.isAudioPath("clip.webm")).toBe(false);
    expect(A.isAudioPath("D:\\a.mp3\\folder")).toBe(false);
    expect(A.isAudioPath(".mp3")).toBe(false);
  });

  it("guessAudioRole：檔名像旁白 → voiceover；> 60 s → music；≤ 10 s → sfx；其他或不知道長度 → other", () => {
    expect(A.guessAudioRole("旁白 01.m4a", 300_000)).toBe("voiceover");
    expect(A.guessAudioRole("intro_VO.wav", 5000)).toBe("voiceover");
    expect(A.guessAudioRole("vocal stem.wav", 5000)).toBe("sfx");
    expect(A.guessAudioRole("volume test.mp3", 90_000)).toBe("music");
    expect(A.guessAudioRole("bgm.mp3", 60_001)).toBe("music");
    expect(A.guessAudioRole("bgm.mp3", 60_000)).toBe("other");
    expect(A.guessAudioRole("ding.wav", 10_000)).toBe("sfx");
    expect(A.guessAudioRole("x.wav", null)).toBe("other");
  });

  it("長度退路：probe 音軌時長優先、容器其次；峰值扣掉串流起點之前補的靜音", () => {
    expect(A.probeLengthSamples(audioProbe("a", 1, "mp3", 1500))).toBe(72000);
    expect(A.probeLengthSamples({ ...audioProbe("a", 1, "mp3", 0), duration_ms: 2000 })).toBe(96000);
    expect(A.probeLengthSamples({ ...audioProbe("a", 1, "mp3", 0), duration_ms: 0 })).toBeNull();
    expect(A.probeLengthSamples(null)).toBeNull();
    expect(A.peaksLengthSamples({ totalSamples: 481203, streamStartUs: 25057 })).toBe(481203 - 1203);
    expect(A.peaksLengthSamples({ totalSamples: 1000, streamStartUs: -7000 })).toBe(1000);
    expect(A.peaksLengthSamples({ totalSamples: 10, streamStartUs: 1_000_000 })).toBeNull();
  });

  it("清單顯示：長度格式、摘要（audio_info 優先）、片段數", () => {
    expect(A.formatAudioDuration(205)).toBe("3:25");
    expect(A.formatAudioDuration(3723.4)).toBe("1:02:03");
    expect(A.formatAudioDuration(null)).toBe("—");
    expect(A.audioMediaSummary({ audio: A_MUSIC.audio, probe: null })).toBe("mp3 · 44.1 kHz · 2 ch · 1:00");
    expect(A.audioMediaSummary({ audio: null, probe: audioProbe("a", 1, "flac", 800, 96000, 1) })).toBe("flac · 96 kHz · 1 ch · 0:01");
    const seq = seqOf([vclip("c1", "m1", 0, 100)], [lane("l1", "music", [aclip("a1", "a-music", 0, 100), aclip("a2", "a-music", 200, 100)]), lane("l2", "sfx", [aclip("a3", "a-vo", 0, 10)])]);
    expect(A.audioClipCount(seq, "a-music")).toBe(2);
    expect(A.audioClipCount(null, "a-music")).toBe(0);
  });
});

describe("放置目標", () => {
  const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m2", 0, 150)], [lane("l1", "music", [aclip("a1", "a-music", 48000, 96000)]), lane("l2", "sfx", [])]);
  const layout = layoutSequenceRows(seq, [], {});

  it("audioDropZone：音軌（含下方間距）→ lane；放置區與更下面 → newLane；尺規 / V1 / A0 → auto", () => {
    const [l1, l2] = layout.lanes;
    expect(A.audioDropZone(layout, l1.y + 1)).toEqual({ kind: "lane", laneId: "l1" });
    expect(A.audioDropZone(layout, l1.y + l1.h)).toEqual({ kind: "lane", laneId: "l1" });
    expect(A.audioDropZone(layout, l2.y + l2.h - 1)).toEqual({ kind: "lane", laneId: "l2" });
    expect(A.audioDropZone(layout, layout.dropY + 3)).toEqual({ kind: "newLane" });
    expect(A.audioDropZone(layout, layout.height + 200)).toEqual({ kind: "newLane" });
    expect(A.audioDropZone(layout, layout.v1Y + 5)).toEqual({ kind: "auto" });
    expect(A.audioDropZone(layout, layout.a0Y + 5)).toEqual({ kind: "auto" });
  });

  it("吸附候選：剪輯點、播放線、音訊片段頭尾；SNAP_PX 內吸最近、外面四捨五入到幀、Alt 不吸", () => {
    expect(A.audioSnapFrames(seq, 77.4)).toEqual([0, 30, 77, 90, 300, 450]);
    // 10 px/幀 → 容忍 0.6 幀
    expect(A.snapDropFrame(299.5, 10, [300])).toEqual({ frame: 300, snapped: true });
    expect(A.snapDropFrame(298.6, 10, [300])).toEqual({ frame: 299, snapped: false });
    expect(A.snapDropFrame(299.5, 10, [300], false)).toEqual({ frame: 300, snapped: false });
    expect(A.snapDropFrame(-5, 10, [])).toEqual({ frame: 0, snapped: false });
    // 放大很多時吸附距離（幀）變小：1 px/幀 → 容忍 6 幀
    expect(A.snapDropFrame(96, 1, [90, 100])).toEqual({ frame: 100, snapped: true });
  });

  it("planAudioDrop / placeSpecOf：x 換成序列幀（含捲動）、吸附、放置區 → 樣本與音軌", () => {
    const view = { scrollFrame: 50, pxPerFrame: 10 };
    const p = { seq, layout, view, playhead: null, x: (123 - 50) * 10 + 3, y: layout.lanes[1].y + 4 };
    const plan = A.planAudioDrop(p);
    expect(plan).toEqual({ frame: 123, snapped: false, zone: { kind: "lane", laneId: "l2" } });
    expect(A.placeSpecOf(plan, FPS30)).toEqual({ atSample: samplesOfFrame(123, FPS30), laneId: "l2", newLane: false });
    const onEdit = A.planAudioDrop({ ...p, x: (300 - 50) * 10 - 4, y: layout.dropY + 2 });
    expect(onEdit).toEqual({ frame: 300, snapped: true, zone: { kind: "newLane" } });
    expect(A.placeSpecOf(onEdit, FPS30)).toMatchObject({ laneId: null, newLane: true });
    expect(A.planAudioDrop({ ...p, x: (300 - 50) * 10 - 4 }, { snap: false }).frame).toBe(300);
  });

  it("planMediaDrop：影片插入吸到最近的剪輯點", () => {
    const view = { scrollFrame: 0, pxPerFrame: 2 };
    expect(A.planMediaDrop({ seq, view, x: 140 * 2 })).toBe(0);
    expect(A.planMediaDrop({ seq, view, x: 160 * 2 })).toBe(300);
    expect(A.planMediaDrop({ seq, view, x: 5000 })).toBe(450);
  });
});

describe("加入媒體的錯誤訊息與轉檔指令", () => {
  const nameOf = (id: string) => ({ m25: "clip25.mp4", mbig: "big.mov", mnone: "noproxy.webm" })[id];
  const seq = ops.materialize(M1);
  const errOf = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e;
    }
    throw new Error("沒有擲錯");
  };

  it("fps 不符：說清楚兩邊 fps 與怎麼修，修正是轉檔（不是重建 proxy）", () => {
    const v = A.describeAddMediaError(
      errOf(() => ops.appendMedia(seq, M25)),
      nameOf,
    );
    expect(v).toEqual({ text: "無法加入「clip25.mp4」：它是 25 fps，序列是 30 fps。序列裡的影片要同 fps，請先把它轉成 30 fps 再加入", fix: "conform", mediaId: "m25" });
  });

  it("尺寸不符 / 沒有 proxy / 其他錯誤", () => {
    expect(A.describeAddMediaError(errOf(() => ops.appendMedia(seq, MBIG)), nameOf)).toMatchObject({ fix: "conform", mediaId: "mbig", text: expect.stringContaining("1920×1080 跟序列的 1280×720") });
    expect(A.describeAddMediaError(errOf(() => ops.appendMedia(seq, MNOPROXY)), nameOf)).toEqual({ text: "「noproxy.webm」的 proxy 還沒建好，建好之後才能加入序列", fix: "buildProxy", mediaId: "mnone" });
    expect(A.describeAddMediaError(new Error("爆了"), nameOf)).toEqual({ text: "無法修改序列：爆了", fix: null, mediaId: null });
  });

  it("conformCommand：Windows 是 PowerShell 語法（& + 單引號）、挑第一個能用的 H.264、輸出檔名帶 fps", () => {
    const r = A.conformCommand({
      ffmpegPath: "C:\\Program Files\\AI Video Cut\\ffmpeg\\ffmpeg.exe",
      family: "windows",
      src: "D:\\影片 1\\clip's 25.mp4",
      fps: { num: 30000, den: 1001 },
      size: null,
      usable: ["libvpx-vp9", "libopenh264"],
    });
    expect(r.output).toBe("D:\\影片 1\\clip's 25_29.97fps.mp4");
    expect(r.command).toBe(
      "& 'C:\\Program Files\\AI Video Cut\\ffmpeg\\ffmpeg.exe' -hide_banner -i 'D:\\影片 1\\clip''s 25.mp4' -vf 'fps=30000/1001' -c:v libopenh264 -b:v 20M -pix_fmt yuv420p -c:a aac -b:a 192k 'D:\\影片 1\\clip''s 25_29.97fps.mp4'",
    );
  });

  it("conformCommand：sh 單引號跳脫、尺寸不同時等比縮放＋補邊、沒有 H.264 時退到 VP9 webm、沒有 ffmpeg 路徑用 PATH", () => {
    const r = A.conformCommand({ ffmpegPath: null, family: "macos", src: "/Users/me/it's.mov", fps: { num: 30, den: 1 }, size: [1280, 720], usable: ["libvpx-vp9"] });
    expect(r.output).toBe("/Users/me/it's_30fps_1280x720.webm");
    expect(r.command).toBe(
      "ffmpeg -hide_banner -i '/Users/me/it'\\''s.mov' -vf 'fps=30/1,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1' -c:v libvpx-vp9 -crf 18 -b:v 0 -row-mt 1 -pix_fmt yuv420p -c:a libopus -b:a 160k '/Users/me/it'\\''s_30fps_1280x720.webm'",
    );
    expect(A.conformCommand({ ffmpegPath: "/opt/homebrew/bin/ffmpeg", family: "linux", src: "a.mp4", fps: { num: 25, den: 1 }, size: null, usable: [] }).command).toMatch(/^'\/opt\/homebrew\/bin\/ffmpeg' .* -c:v mpeg4 -q:v 2 .* 'a_25fps\.mp4'$/);
  });
});

// ---------------------------------------------------------------- 動作（真的 store）

const ctxNow = () => makeSeqCtx(useProject.getState().media, useEdits.getState().audioMedia);

describe("importAudioFiles：驗收", () => {
  it("wav／mp3／m4a／flac／opus 各拖到不同的幀：片段出現在放下的幀、長度用 probe 退路；每個一次 Ctrl+Z 移除片段與 audioMedia", async () => {
    const frames = [0, 45, 300, 777, 1200];
    for (const [i, f] of FILES.entries()) {
      const before = useEdits.getState();
      const plan = { frame: frames[i], snapped: false, zone: { kind: "auto" } as const };
      const ids = await A.importAudioFiles([f.path], { kind: "drop", plan, fps: FPS30 });
      expect(ids).toHaveLength(1);
      const st = useEdits.getState();
      const id = audioMediaIdOf(fp(i + 1));
      expect(st.audioMedia.map((a) => a.id)).toContain(id);
      const clip = st.sequence!.audioLanes.flatMap((l) => l.clips).find((c) => c.id === ids[0])!;
      expect(clip.start).toBe(samplesOfFrame(frames[i], FPS30));
      expect(clip.length).toBe(Math.floor(f.ms * 48));
      expect(clip.source).toEqual({ type: "audio", audioId: id });
      expect(validateSequence(st.sequence!, ctxNow())).toEqual([]);
      expect(st.past.length).toBe(before.past.length + 1);
      expect(st.past[st.past.length - 1].label).toBe(SEQ_EDIT_LABEL.addAudio);
      // I1：追蹤資料連參照都不動
      expect(st.tracks).toBe(before.tracks);
      expect(st.shots).toBe(before.shots);

      useEdits.getState().undo();
      expect(useEdits.getState().audioMedia).toBe(before.audioMedia);
      expect(useEdits.getState().sequence).toBe(before.sequence);
      // 下一個檔從乾淨的狀態開始（每個格式各自驗一次「一次 undo」）
    }
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().audioMedia).toEqual([]);
  });

  it("角色依檔名 / 長度猜：mp3 95 s → music 軌（同步鎖關）、旁白 → voiceover 軌、1.5 s wav → sfx", async () => {
    await A.importAudioFiles([FILES[1].path], { kind: "playhead" });
    await A.importAudioFiles([FILES[2].path], { kind: "playhead" });
    await A.importAudioFiles([FILES[0].path], { kind: "playhead" });
    const seq = useEdits.getState().sequence!;
    expect(seq.audioLanes.map((l) => [l.role, l.syncLock])).toEqual([
      ["music", false],
      ["voiceover", true],
      ["sfx", true],
    ]);
    expect(useEdits.getState().audioMedia.map((a) => a.role)).toEqual(["music", "voiceover", "sfx"]);
  });

  it("引擎就緒：先跑 media.audio_info（gpu 不搶），片段長度 = 來源樣本數換成 48 kHz，audio 資訊存進 audioMedia", async () => {
    useEngine.setState({ info: { state: "ready", pid: 1, hello: null, last_exc: null, restarts: 0, queued: [], running: [] }, state: "ready" });
    runEngineJob.mockResolvedValue({ audio: { codec: "mp3", sampleRate: 44100, channels: 2, channelLayout: "stereo", startUs: 25057, videoStartUs: null, nSamples: 4_189_500, gaps: [] } });
    const ids = await A.importAudioFiles([FILES[1].path], { kind: "playhead" });
    expect(runEngineJob).toHaveBeenCalledTimes(1);
    expect(runEngineJob.mock.calls[0][0]).toMatchObject({ op: "media.audio_info", args: { video: FILES[1].path }, gpu: false });
    const am = useEdits.getState().audioMedia[0];
    expect(am.audio).toMatchObject({ sampleRate: 44100, startUs: 25057, nSamples: 4_189_500 });
    const clip = useEdits.getState().sequence!.audioLanes[0].clips.find((c) => c.id === ids[0])!;
    expect(clip.length).toBe(Math.floor((4_189_500 * 48000) / 44100));
  });

  it("引擎還沒起來（pyenv 裝好）：不等引擎開機，先用 probe 長度放上去；audio_info 在背景補進清單、不多留 undo、片段長度不動", async () => {
    useEngine.setState({ pyenv: { state: "ready" } as never });
    let finish!: (v: unknown) => void;
    runEngineJob.mockImplementation(() => new Promise((r) => (finish = r)));
    const ids = await A.importAudioFiles([FILES[4].path], { kind: "playhead" });
    expect(ids).toHaveLength(1);
    const clip = () => useEdits.getState().sequence!.audioLanes[0].clips[0];
    expect(clip().length).toBe(30_000 * 48);
    expect(useEdits.getState().audioMedia[0].audio).toBeNull();
    await vi.waitFor(() => expect(runEngineJob).toHaveBeenCalledTimes(1));
    finish({ audio: { codec: "opus", sampleRate: 48000, channels: 2, channelLayout: "stereo", startUs: 0, videoStartUs: null, nSamples: 1_440_312, gaps: [] } });
    await vi.waitFor(() => expect(useEdits.getState().audioMedia[0].audio?.nSamples).toBe(1_440_312));
    expect(useEdits.getState().past).toHaveLength(1);
    expect(clip().length).toBe(30_000 * 48);
    // undo（清單項目整個拿掉）再 redo：快照裡是補算之前的 null，衍生資訊當缺快取重算（Sidebar 的 effect 會叫這支；引擎有 audio.v1.json 快取）
    useEdits.getState().undo();
    useEdits.getState().redo();
    expect(useEdits.getState().audioMedia[0].audio).toBeNull();
    runEngineJob.mockResolvedValue({ audio: { codec: "opus", sampleRate: 48000, channels: 2, channelLayout: "stereo", startUs: 0, videoStartUs: null, nSamples: 1_440_312, gaps: [] } });
    await A.ensureAudioMediaInfo(useEdits.getState().audioMedia[0].id);
    expect(useEdits.getState().audioMedia[0].audio?.nSamples).toBe(1_440_312);
    expect(clip().length).toBe(30_000 * 48);
  });

  it("一次拖多個檔：接在一起放同一條軌、整批一筆 undo", async () => {
    const plan = { frame: 30, snapped: false, zone: { kind: "newLane" } as const };
    const before = useEdits.getState().past.length;
    const ids = await A.importAudioFiles([FILES[0].path, FILES[3].path, "D:\\notes.txt"], { kind: "drop", plan, fps: FPS30 });
    const seq = useEdits.getState().sequence!;
    expect(seq.audioLanes).toHaveLength(1);
    const clips = seq.audioLanes[0].clips;
    expect(clips.map((c) => c.id)).toEqual(ids);
    expect(clips[0].start).toBe(samplesOfFrame(30, FPS30));
    expect(clips[1].start).toBe(clips[0].start + clips[0].length);
    expect(useEdits.getState().past.length).toBe(before + 1);
    useEdits.getState().undo();
    expect(useEdits.getState().audioMedia).toEqual([]);
    expect(useEdits.getState().sequence).toBeNull();
  });

  it("同一個檔再拖一次：清單不重複，只多一個片段；undo 只拿掉片段", async () => {
    await A.importAudioFiles([FILES[4].path], { kind: "playhead" });
    const listed = useEdits.getState().audioMedia;
    // 換個路徑（同指紋）也認得
    probes.set("E:\\copy\\take.opus", { ...probes.get(FILES[4].path)!, path: "E:\\copy\\take.opus" });
    await A.importAudioFiles(["E:\\copy\\take.opus"], { kind: "drop", plan: { frame: 900, snapped: false, zone: { kind: "auto" } }, fps: FPS30 });
    expect(useEdits.getState().audioMedia).toBe(listed);
    expect(A.audioClipCount(useEdits.getState().sequence, listed[0].id)).toBe(2);
    useEdits.getState().undo();
    expect(useEdits.getState().audioMedia).toBe(listed);
    expect(A.audioClipCount(useEdits.getState().sequence, listed[0].id)).toBe(1);
  });

  it("沒有音軌 / probe 失敗：toast 說明並略過，不留 undo", async () => {
    probes.set("D:\\x\\silent.wav", { ...audioProbe("D:\\x\\silent.wav", 99, "pcm", 1000), audio: null, video: null });
    const ids = await A.importAudioFiles(["D:\\x\\silent.wav", "D:\\x\\missing.mp3"], { kind: "playhead" });
    expect(ids).toEqual([]);
    expect(useEdits.getState().past).toHaveLength(0);
    expect(useUi.getState().toasts.map((x) => x.text)).toEqual(["「silent.wav」沒有音軌，無法當成音訊加入", "無法匯入「missing.mp3」：ffprobe 失敗：D:\\x\\missing.mp3"]);
  });

  it("序列放不上去（作用中影片沒有 proxy）：只進清單、說明原因，一筆 undo 只有清單", async () => {
    useProject.setState({ activeMediaId: "mnone" });
    const ids = await A.importAudioFiles([FILES[1].path], { kind: "playhead" });
    expect(ids).toEqual([]);
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().audioMedia).toHaveLength(1);
    expect(useUi.getState().toasts.map((x) => x.text)).toContain("音訊已加入清單；影片的 proxy 建好之後才能放上音軌");
    useEdits.getState().undo();
    expect(useEdits.getState().audioMedia).toEqual([]);
  });

  it("拖到側欄（list）只進清單、不實體化序列", async () => {
    await A.importAudioFiles([FILES[2].path], { kind: "list" });
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().audioMedia).toHaveLength(1);
    // 之後從清單放上播放線：一筆 undo 只有片段
    const id = useEdits.getState().audioMedia[0].id;
    const ids = await A.placeAudioMedia(id, { kind: "playhead" });
    expect(ids).toHaveLength(1);
    useEdits.getState().undo();
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().audioMedia).toHaveLength(1);
  });

  it("OS 拖放：旗標關著回 false 什麼都不做；非音訊檔忽略", async () => {
    useSettings.getState().setExperimental({ sequence: false });
    expect(A.importDroppedAudio([FILES[0].path], { x: 10, y: 10 })).toBe(false);
    useSettings.getState().setExperimental({ sequence: true });
    expect(A.importDroppedAudio(["D:\\a.mp4", "D:\\b.aivc.json"], null)).toBe(false);
    expect(A.importDroppedAudio([FILES[0].path], null)).toBe(true);
    await vi.waitFor(() => expect(useEdits.getState().audioMedia).toHaveLength(1));
  });
});

describe("screenTargetAt：OS / Sidebar 拖放的座標換算", () => {
  it("落在時間軸 canvas：扣掉 canvas 左上角（軌道標頭之後）、帶目前的捲動與縮放；側欄與其他地方分開", () => {
    useEdits.getState().loadSequence(seqOf([vclip("c1", "m1", 0, 1797)], [lane("l1", "music", [])]), []);
    useTimeline.setState({ space: "sequence", pxPerFrame: 4, scrollFrame: 100 });
    const rect = { left: 200 + TRACK_HEADER_W, top: 500, width: 800, height: 300 };
    const canvas = { getBoundingClientRect: () => rect };
    const timelineEl = { closest: (sel: string) => (sel.includes("frame-timeline") ? { querySelector: () => canvas } : null) };
    const sidebarEl = { closest: (sel: string) => (sel.includes("sidebar") ? {} : null) };
    let under: unknown = timelineEl;
    vi.stubGlobal("document", { elementFromPoint: () => under });
    try {
      const layout = layoutSequenceRows(useEdits.getState().sequence, [], {});
      const hit = A.screenTargetAt(rect.left + 40, rect.top + layout.lanes[0].y + 2);
      expect(hit.kind).toBe("timeline");
      if (hit.kind !== "timeline") return;
      expect(hit.point.x).toBe(40);
      const plan = A.planAudioDrop(hit.point);
      expect(plan).toEqual({ frame: 110, snapped: false, zone: { kind: "lane", laneId: "l1" } });
      // 落在左側軌道標頭上：x 夾到 0 = 可視區左緣
      const onHeader = A.screenTargetAt(rect.left - 60, rect.top + 30);
      expect(onHeader.kind === "timeline" && onHeader.point.x).toBe(0);
      // 素材空間不收
      useTimeline.setState({ space: "source" });
      expect(A.screenTargetAt(rect.left + 40, rect.top + 30).kind).toBe("other");
      under = sidebarEl;
      expect(A.screenTargetAt(5, 5).kind).toBe("sidebar");
      under = null;
      expect(A.screenTargetAt(5, 5).kind).toBe("other");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("addMediaToSequence / addAudioLane / moveAudioClipTo", () => {
  it("接到結尾：隱含序列在同一筆 undo 裡實體化，一次 Ctrl+Z 回到 null", () => {
    expect(A.addMediaToSequence("m2", "append")).toBe(true);
    const seq = useEdits.getState().sequence!;
    expect(seq.video.map((it) => (it.kind === "clip" ? it.mediaId : "gap"))).toEqual(["m1", "m2"]);
    expect(lastOf(useEdits.getState().past)?.label).toBe(SEQ_EDIT_LABEL.addMedia);
    useEdits.getState().undo();
    expect(useEdits.getState().sequence).toBeNull();
  });

  it("插入：指定幀吸到最近的剪輯點；沒指定且播放線不在序列裡 → 接在結尾", () => {
    useEdits.getState().loadSequence(seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)]), []);
    expect(A.addMediaToSequence("m2", "insert", 280)).toBe(true);
    expect(useEdits.getState().sequence!.video.map((it) => it.id)).toEqual(["c1", "clip-1", "c2"]);
  });

  it("fps 不符：可操作的錯誤 toast（帶「複製轉檔指令」鈕），序列不變、不留 undo", () => {
    expect(A.addMediaToSequence("m25", "append")).toBe(false);
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().past).toHaveLength(0);
    const toast = lastOf(useUi.getState().toasts)!;
    expect(toast.kind).toBe("error");
    expect(toast.text).toContain("它是 25 fps，序列是 30 fps");
    expect(toast.action?.label).toBe("複製轉檔指令");
  });

  it("proxy 還沒好：錯誤 toast 帶「建 proxy」鈕", () => {
    expect(A.addMediaToSequence("mnone", "append")).toBe(false);
    expect(lastOf(useUi.getState().toasts)?.action?.label).toBe("建 proxy");
  });

  it("新增音軌一筆 undo；移動音訊片段重疊時回報最近放得下的起點、不擲錯", () => {
    expect(A.addAudioLane("music")).toBe(true);
    expect(useEdits.getState().sequence!.audioLanes.map((l) => [l.role, l.syncLock])).toEqual([["music", false]]);
    useEdits.getState().loadSequence(seqOf([vclip("c1", "m1", 0, 1797)], [lane("l1", "music", [aclip("a1", "a-music", 0, 48000), aclip("a2", "a-music", 96000, 48000)])]), [A_MUSIC]);
    expect(A.moveAudioClipTo("a2", "l1", 24000)).toEqual({ ok: false, code: "overlap", nearest: 48000 });
    expect(A.moveAudioClipTo("a2", "l1", 200000)).toEqual({ ok: true, changed: true });
    expect(useEdits.getState().sequence!.audioLanes[0].clips.map((c) => c.start)).toEqual([0, 200000]);
    expect(A.moveAudioClipTo("a2", "l1", 200000)).toEqual({ ok: true, changed: false });
  });
});

describe("ensureAudioMediaInfo：舊專案補算", () => {
  it("引擎沒就緒不送；就緒後補上 audio（不記 undo）；沒有音訊的結果不再重試", async () => {
    const am = { ...A_MUSIC, id: "a-old", audio: null };
    useEdits.getState().loadSequence(null, [am]);
    await A.ensureAudioMediaInfo("a-old");
    expect(runEngineJob).not.toHaveBeenCalled();
    useEngine.setState({ info: { state: "ready", pid: 1, hello: null, last_exc: null, restarts: 0, queued: [], running: [] }, state: "ready" });
    runEngineJob.mockResolvedValue({ audio: A_MUSIC.audio });
    await A.ensureAudioMediaInfo("a-old");
    expect(useEdits.getState().audioMedia[0].audio).toEqual(A_MUSIC.audio);
    expect(useEdits.getState().past).toHaveLength(0);

    useEdits.getState().loadSequence(null, [{ ...am, id: "a-nosound" }]);
    runEngineJob.mockResolvedValue({ audio: null });
    await A.ensureAudioMediaInfo("a-nosound");
    await A.ensureAudioMediaInfo("a-nosound");
    await flush();
    expect(runEngineJob).toHaveBeenCalledTimes(2);
  });
});
