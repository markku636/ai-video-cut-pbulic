// Sidebar（M2.14）：序列剪輯旗標關著時跟 M1 一樣（沒有音訊區、沒有序列按鈕）；開著時多音訊清單、加入 / 插入鈕。
// 靜態渲染（renderToStaticMarkup），不需要 DOM。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("not tauri"))), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
// zustand 在伺服器端渲染讀的是 getServerState ?? getInitialState（建立時的初始狀態），不是 setState 之後的現況；
// 靜態渲染要看到測試設好的 store，就讓每個 store 的伺服器快照等於現況（只影響這個測試檔）
vi.mock("zustand", async (importOriginal) => {
  const z = await importOriginal<typeof import("zustand")>();
  const create = (init: import("zustand").StateCreator<unknown>) => {
    const api: import("zustand").StoreApi<unknown> & { getServerState?: () => unknown } = z.createStore(init);
    api.getServerState = api.getState;
    const hook = (selector?: (s: unknown) => unknown) => z.useStore(api, selector ?? ((s: unknown) => s));
    return Object.assign(hook, api);
  };
  return { ...z, create, default: create };
});

const { default: Sidebar } = await import("./Sidebar");
const { useProject } = await import("../store/project");
const { useEdits } = await import("../store/edits");
const { useSettings } = await import("../store/settings");
const { useAudioImports } = await import("../pipeline/audio");
const { A_MUSIC, M1, aclip, lane, seqOf, vclip } = await import("../sequence/testkit");

const render = () => renderToStaticMarkup(createElement(Sidebar, { width: 260 }));

beforeEach(() => {
  useProject.getState().newProject();
  useProject.setState({ media: [{ ...M1, proxyState: "ready" }], activeMediaId: "m1" });
  useAudioImports.setState({ pending: [] });
});

describe("shell/Sidebar", () => {
  it("旗標關：沒有音訊區、沒有接到結尾 / 插入鈕（M1 不變）", () => {
    useSettings.getState().setExperimental({ sequence: false });
    useEdits.getState().loadSequence(null, [A_MUSIC]);
    const html = render();
    expect(html).toContain('data-testid="sidebar"');
    expect(html).toContain('data-media="m1"');
    expect(html).not.toContain("sidebar-audio");
    expect(html).not.toContain("接到序列結尾");
    expect(html).not.toContain("bgm.mp3");
  });

  it("旗標開：音訊清單列出名稱、摘要、片段數與匯入中的檔；影片列有接到結尾 / 插入鈕", () => {
    useSettings.getState().setExperimental({ sequence: true });
    useEdits.getState().loadSequence(seqOf([vclip("c1", "m1", 0, 1797)], [lane("l1", "music", [aclip("a1", "a-music", 0, 48000), aclip("a2", "a-music", 96000, 48000)])]), [A_MUSIC]);
    useAudioImports.setState({ pending: ["旁白 01.m4a"] });
    const html = render();
    expect(html).toContain('data-testid="sidebar-audio"');
    expect(html).toContain('data-audio-media="a-music"');
    expect(html).toContain("mp3 · 44.1 kHz · 2 ch · 1:00 · 2 個片段");
    expect(html).toContain("旁白 01.m4a");
    expect(html).toContain('aria-label="接到序列結尾"');
    expect(html).toContain('aria-label="在播放線插入"');
    expect(html).toContain('data-cmd="audio.import"');
  });

  it("旗標開、沒有音訊：提示可以拖檔進來", () => {
    useSettings.getState().setExperimental({ sequence: true });
    useEdits.getState().loadSequence(null, []);
    expect(render()).toContain("把 wav / mp3 / m4a / flac / opus 拖到時間軸或這裡");
  });
});
