// M2.14 store 層：probeAudio（不 commit）與 addAudioMedia（清單＋放上音軌同一筆 undo）。真的 project / edits store。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProbe } from "../api";
import type { AudioMediaV2 } from "../project/format";
import { A_MUSIC, M1, MNOPROXY } from "../sequence/testkit";

const probeOf = (path: string, fingerprint: string, audio: boolean): MediaProbe => ({
  path,
  size_bytes: 1,
  duration_ms: 5000,
  container: "wav",
  audio: audio ? { codec: "pcm_s16le", sample_rate: 48000, channels: 1, bit_rate: null } : null,
  video: null,
  fingerprint,
});

vi.mock("../api", () => ({
  api: {
    mediaProbe: async (path: string) => probeOf(path, path.includes("same") ? "ABCDEF0123456789" + "0".repeat(48) : "fedcba9876543210" + "1".repeat(48), !path.includes("mute")),
    mediaCacheStatus: async () => {
      throw new Error("not tauri");
    },
  },
  decodeJson: (b: unknown) => b,
}));

const { useProject, audioMediaIdOf } = await import("./project");
const { useEdits, SEQ_EDIT_LABEL } = await import("./edits");

const VO: AudioMediaV2 = { id: "a-vo1", path: "D:\\vo.wav", name: "vo.wav", fingerprint: "", probe: null, role: "voiceover", audio: null };

beforeEach(() => {
  useProject.getState().newProject();
  useProject.setState({ media: [{ ...M1, proxyState: "ready" }, { ...MNOPROXY, proxyState: "none" }], activeMediaId: "m1" });
});

describe("store/project 音訊媒體匯入", () => {
  it("audioMediaIdOf：a- ＋指紋前 16 碼（小寫），跟影片 mediaId 分開命名", () => {
    expect(audioMediaIdOf("ABCDEF0123456789ffff")).toBe("a-abcdef0123456789");
  });

  it("probeAudio：新檔回 AudioMediaV2（不 commit、角色預設 other 或指定）；同指紋已在清單 → existing", async () => {
    const { item, existing } = await useProject.getState().probeAudio("D:\\x\\same.wav");
    expect(existing).toBe(false);
    expect(item).toMatchObject({ id: "a-abcdef0123456789", name: "same.wav", role: "other", audio: null });
    expect(useEdits.getState().audioMedia).toEqual([]);
    expect(useEdits.getState().past).toHaveLength(0);
    expect((await useProject.getState().probeAudio("D:\\y\\mute.wav", { role: "sfx" })).item).toMatchObject({ role: "sfx", probe: { audio: null } });

    useProject.getState().addAudioMedia([item], null);
    const again = await useProject.getState().probeAudio("E:\\copy\\same.wav");
    expect(again.existing).toBe(true);
    expect(again.item).toBe(useEdits.getState().audioMedia[0]);
  });

  it("addAudioMedia：開新音軌、依序接著放；放不上的（沒有長度）只進清單；清單與片段同一筆 undo", () => {
    const before = useEdits.getState();
    const r = useProject.getState().addAudioMedia([A_MUSIC, VO, { ...VO, id: "a-unknown", name: "?.wav" }], { atSample: 48000, laneId: null, newLane: true, lengths: { "a-vo1": 24000 } });
    expect(r.committed).toBe(true);
    expect(r.clipIds).toEqual(["aclip-1", "aclip-2"]);
    const st = useEdits.getState();
    expect(st.audioMedia.map((a) => a.id)).toEqual(["a-music", "a-vo1", "a-unknown"]);
    // 新軌的角色取第一個（音樂 → 同步鎖關）
    expect(st.sequence!.audioLanes.map((l) => [l.role, l.syncLock, l.clips.map((c) => [c.start, c.length])])).toEqual([
      [
        "music",
        false,
        [
          [48000, Math.floor((A_MUSIC.audio!.nSamples * 48000) / 44100)],
          [48000 + Math.floor((A_MUSIC.audio!.nSamples * 48000) / 44100), 24000],
        ],
      ],
    ]);
    expect(st.past).toHaveLength(before.past.length + 1);
    expect(st.past[st.past.length - 1].label).toBe(SEQ_EDIT_LABEL.addAudio);
    expect(st.tracks).toBe(before.tracks);

    useEdits.getState().undo();
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().audioMedia).toEqual([]);
    useEdits.getState().redo();
    expect(useEdits.getState().sequence!.audioLanes[0].clips).toHaveLength(2);
  });

  it("沒有一個放得上：只動清單、不實體化序列（作用中影片沒有 proxy 也加得進來）；清單已有 → 不留 undo", () => {
    useProject.setState({ activeMediaId: "mnone" });
    const r = useProject.getState().addAudioMedia([VO], { atSample: 0, laneId: null });
    expect(r).toEqual({ committed: true, clipIds: [] });
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().audioMedia.map((a) => a.id)).toEqual(["a-vo1"]);
    expect(useProject.getState().addAudioMedia([VO], null)).toEqual({ committed: false, clipIds: [] });
    expect(useEdits.getState().past).toHaveLength(1);
  });

  it("放得上但序列實體化失敗：擲 SequenceError，清單與序列都不變", () => {
    useProject.setState({ activeMediaId: "mnone" });
    expect(() => useProject.getState().addAudioMedia([A_MUSIC], { atSample: 0, laneId: null })).toThrow(/proxy/);
    expect(useEdits.getState().audioMedia).toEqual([]);
    expect(useEdits.getState().past).toHaveLength(0);
  });
});
