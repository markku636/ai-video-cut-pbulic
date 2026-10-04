// 外掛登記表與「沒有外掛時」核心各處的預設（= 開源版）。這裡刻意不 import src/plugins/index.ts：
// 那支一載入就會用 import.meta.glob 找 plugins/ 並登記，有外掛的 checkout 裡就不是「沒有外掛」了。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AivcPlugin } from "./api";
import { collect, plugins, pluginsVersion, registerPlugin, resetPlugins } from "./registry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

afterEach(() => {
  resetPlugins();
});

describe("登記表", () => {
  it("同 id 再登記一次 = 取代（熱更新冪等）；collect 依登記順序攤平", () => {
    const v0 = pluginsVersion();
    const a: AivcPlugin = { id: "a", toolbar: [{ id: "x.one" }] };
    const b: AivcPlugin = { id: "b", toolbar: [{ id: "y.one" }, { id: "y.two" }] };
    registerPlugin(a);
    registerPlugin(b);
    registerPlugin({ ...a, toolbar: [{ id: "x.again" }] });
    expect(plugins().map((p) => p.id)).toEqual(["a", "b"]);
    expect(collect((p) => p.toolbar).map((x) => x.id)).toEqual(["x.again", "y.one", "y.two"]);
    expect(pluginsVersion()).toBeGreaterThan(v0);
    resetPlugins();
    expect(plugins()).toEqual([]);
  });
});

describe("沒有外掛時的預設", () => {
  it("工作模式只有一般平面替換；不認得但像值的 profile 原樣保留，壞的讀成 generic", async () => {
    const { workProfiles, defaultProfileId, legacyProfileId, sanitizeProfile } = await import("../project/profiles");
    expect(workProfiles().map((p) => p.id)).toEqual(["generic"]);
    expect(defaultProfileId()).toBe("generic");
    expect(legacyProfileId()).toBeNull();
    expect(sanitizeProfile("generic")).toBe("generic");
    expect(sanitizeProfile("cards")).toBe("cards");
    expect(sanitizeProfile(undefined)).toBe("generic");
    expect(sanitizeProfile("<bad>")).toBe("generic");
  });

  it("開始畫面只有核心的四張卡片：追蹤任何東西、螢幕／平面換畫面、隱私打碼、移除物件", async () => {
    const { startCards } = await import("../shell/startCards");
    expect(startCards().map((c) => [c.key, c.profile, c.after ?? null])).toEqual([
      ["track-anything", "generic", null],
      ["generic", "generic", null],
      ["privacy", "generic", "object.findFaces"],
      ["remove-object", "generic", "mask.removeObject"],
    ]);
  });

  it("右側欄：沒有外掛的分頁、預設打開物件；工具列主要按鈕是「找物件」", async () => {
    const { railTabs, defaultRailTab, isRailTab } = await import("../inspector/tabs");
    expect(railTabs().map((t) => t.id)).toEqual(["objects", "track", "mask", "captions", "clip", "jobs", "history", "advice", "assistant"]);
    expect(defaultRailTab()).toBe("objects");
    expect(isRailTab("cards")).toBe(false);
    const { primaryCommandIds } = await import("../shell/Toolbar");
    expect(primaryCommandIds()).toEqual(["file.open", "object.find", "track.new", "export.video", "file.save"]);
  });

  it("區域策略 / 反光鎖定只有核心的值；專案檔沒有外掛的頂層鍵", async () => {
    const { regionPolicies, defaultRegionPolicy, sheenLocks } = await import("../project/vocab");
    expect(regionPolicies().map((v) => v.id)).toEqual(["full", "hold"]);
    expect(defaultRegionPolicy()).toBe("full");
    expect(sheenLocks().map((v) => v.id)).toEqual(["plate"]);
    const { pluginTopLevelKeys, pluginTrackKeys, pluginLevelKeys, initialPluginProject } = await import("../project/format");
    expect(pluginTopLevelKeys()).toEqual([]);
    expect(pluginTrackKeys()).toEqual([]);
    expect(pluginLevelKeys("optionKeys")).toBeNull();
    expect(pluginLevelKeys("insertKeys")).toBeNull();
    expect(initialPluginProject()).toEqual({});
  });

  it("查詢接縫都是空答案", async () => {
    const Q = await import("./queries");
    const track = { id: "t1" } as never;
    expect(Q.trackTarget(undefined, track)).toBeNull();
    expect(Q.trackHasTarget(undefined, track)).toBe(false);
    expect(Q.trackBadges(track)).toEqual([]);
    expect(Q.templateCandidates("m1", track)).toEqual([]);
    expect(Q.renderArgs("m1")).toEqual({});
    expect(Q.stagePreviewBlocked()).toBe(false);
  });
});
