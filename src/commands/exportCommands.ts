import { Clipboard, Crop, Film, Image, Wand2, X } from "lucide-react";
import { errMessage } from "../api";
import { t } from "../i18n";
import { cancelExport, exportVideo } from "../pipeline/exportVideo";
import { plugins } from "../plugins/registry";
import { openDialog } from "../store/dialogs";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { pickDirectory, toast } from "../ui";
import * as A from "./appActions";
import { activeId, needsEngine, needsExportRunning, needsMedia, needsProxy, needsRange, needsTrack } from "./guards";
import { OK } from "./registry";
import type { Command, Enabled } from "./types";

/**
 * 輸出指令（計畫 §9）。以前跟牌的指令放在同一個檔；牌搬進外掛之後留在核心。
 * 外掛可以接手輸出（plugins/api.ts exportRoute：例如牌外掛的某一類專案一律走它自己的輸出檢查對話框）。
 */

function both(...fs: (() => Enabled)[]): () => Enabled {
  return () => {
    for (const f of fs) {
      const r = f();
      if (!r.ok) return r;
    }
    return OK;
  };
}

/** 外掛接手了這一次輸出（開了它自己的對話框）→ true，核心就不開一般輸出對話框。 */
function routedToPlugin(kind: "video" | "range"): boolean {
  return plugins().some((p) => p.exportRoute?.(kind) === true);
}

export const EXPORT_COMMANDS: Command[] = [
  { id: "export.video", title: "輸出影片…", group: "export", section: "輸出", icon: Film, shortcuts: ["Ctrl+E"], surfaces: ["menu", "palette", "toolbar"], keywords: ["export", "render"], enabled: needsMedia, run: () => (routedToPlugin("video") ? undefined : A.openExport(null)) },
  { id: "export.range", title: "只輸出範圍（in / out）…", group: "export", section: "輸出", icon: Film, enabled: needsRange, run: () => (routedToPlugin("range") ? undefined : A.openExport(useTimeline.getState().range)) },
  {
    id: "export.frame",
    title: "輸出這一幀（單幀預覽）…",
    group: "export",
    section: "輸出",
    icon: Image,
    enabled: needsProxy,
    run: () => {
      const f = usePlayback.getState().frame;
      A.openExport({ in: f, out: f + 1 });
    },
  },
  { id: "export.cancel", title: "取消輸出", group: "export", section: "輸出", icon: X, enabled: needsExportRunning, run: () => cancelExport() },
  // 吃任何一支影片檔（不需要專案）：剪過的序列要轉直幅也走這裡 —— 先輸出成一支影片，再拿那支進來
  { id: "export.reframeVideo", title: "轉成直幅／方形影片…", group: "export", section: "輸出", icon: Crop, keywords: ["reframe", "vertical", "9:16", "shorts", "直式", "短片"], enabled: () => OK, run: () => openDialog("reframeVideo") },
  { id: "export.copyNukeCornerPin", title: "複製 Nuke CornerPin2D", group: "export", section: "追蹤資料", icon: Clipboard, keywords: ["nuke", "corner pin"], enabled: both(needsTrack, needsEngine), run: () => A.copyTrackData("nuke") },
  { id: "export.copyAeCornerPin", title: "複製 After Effects 角釘", group: "export", section: "追蹤資料", icon: Clipboard, keywords: ["after effects", "ae", "corner pin"], enabled: both(needsTrack, needsEngine), run: () => A.copyTrackData("ae") },
  {
    id: "export.mattesAndPasses",
    title: "遮罩 alpha PNG 序列 / 矯正後表面…",
    group: "export",
    section: "追蹤資料",
    icon: Wand2,
    keywords: ["matte", "alpha", "png", "faces"],
    enabled: both(needsProxy, needsEngine),
    // render.run 的 emit_matte / emit_faces：附帶交付（計畫 §6.7）。影片照常輸出到同一個資料夾。
    run: async () => {
      const m = selectActiveMedia(useProject.getState());
      const id = activeId();
      if (!m || !id) return;
      const dir = await pickDirectory();
      if (!dir) return;
      const sep = dir.includes("\\") ? "\\" : "/";
      const stem = m.name.replace(/\.[^.]+$/, "");
      const ext = m.path.split(".").pop() || "mp4";
      const d = useProject.getState().exportDefaults;
      void exportVideo(id, {
        outPath: `${dir}${sep}${stem}.aivc.${ext}`,
        range: useTimeline.getState().range,
        codec: d.codec || null,
        quality: d.quality,
        audio: (d.audio as "auto" | "copy" | "encode" | "none") || null,
        emitMatte: `${dir}${sep}mattes`,
        emitFaces: `${dir}${sep}faces`,
      })
        .then((r) => toast.success(t("已輸出影片與遮罩序列：{n} 幀 → {dir}", { n: r.frames, dir })))
        .catch((e) => toast.error(errMessage(e)));
    },
  },
];
