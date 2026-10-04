import { create } from "zustand";

/** 工作種類（計畫 §8 store/jobs.ts；feat/captions 加 captions = 語音辨識 + 分段）。標籤在 video/labels.ts 的 JOB_KIND_LABEL。 */
export type JobKind = "proxy" | "thumbs" | "shots" | "mask" | "track" | "recognize" | "preview" | "export" | "pyenv" | "models" | "captions" | "tts" | "objects";
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

export interface Job {
  id: string;
  kind: JobKind;
  mediaId: string;
  /** 目前步驟（顯示用）。 */
  step: string;
  /**
   * 0–100；null = 不確定進度。
   * `pipeline.run` 這種多段 op 放的是**單調不倒退的總進度**（B-14）：以前這裡是「最後一筆事件的百分比」，
   * 所以物件遮罩跑到 209/209 會顯示 100%、下一秒變 0%（換成追蹤的細進度），看起來像做完又重來。
   */
  pct: number | null;
  /** 多段 op 目前在第幾大步（0 起算）／總共幾步；單段 op 是 undefined。 */
  stageIdx?: number;
  stageCount?: number;
  /** 引擎給的「這一步」還要多久（秒）。 */
  etaS?: number | null;
  message: string;
  /** 逐幀 op 目前在第幾幀（FrameTimeline 車道進度用）。 */
  frame?: number | null;
  /** 這個 job 針對哪一條 track（車道進度 / needsIdleTrack）。 */
  trackId?: string;
  status: JobStatus;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** 由建立者掛上；取消時呼叫。 */
  cancel?: () => void;
}

interface JobsStore {
  jobs: Job[];
  upsert: (j: Partial<Job> & { id: string }) => void;
  remove: (id: string) => void;
  cancel: (id: string) => void;
  clearFinished: () => void;
}

export const useJobs = create<JobsStore>((set, get) => ({
  jobs: [],
  upsert: (j) =>
    set((s) => {
      const i = s.jobs.findIndex((x) => x.id === j.id);
      if (i < 0) {
        const full: Job = {
          kind: "proxy",
          mediaId: "",
          step: "",
          pct: null,
          message: "",
          status: "queued",
          startedAt: Date.now(),
          ...j,
        } as Job;
        return { jobs: [...s.jobs, full] };
      }
      const next = s.jobs.slice();
      next[i] = { ...next[i], ...j };
      return { jobs: next };
    }),
  remove: (id) => set((s) => ({ jobs: s.jobs.filter((x) => x.id !== id) })),
  cancel: (id) => {
    const j = get().jobs.find((x) => x.id === id);
    if (!j) return;
    j.cancel?.();
    get().upsert({ id, status: "canceled", endedAt: Date.now() });
  },
  clearFinished: () => set((s) => ({ jobs: s.jobs.filter((x) => x.status === "queued" || x.status === "running") })),
}));

export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 引擎工作佇列（`useJobs`）裡會佔住引擎的種類：這些在排隊 / 跑的時候不送預覽類呼叫（引擎只有一條 worker）。 */
export const ENGINE_JOB_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(["proxy", "shots", "mask", "track", "recognize", "export", "captions", "models"]);

/** 有任何引擎工作在排隊或在跑（舞台預覽、外掛的預覽類呼叫都先問這一句）。 */
export function engineBusy(): boolean {
  return useJobs.getState().jobs.some((j) => ENGINE_JOB_KINDS.has(j.kind) && (j.status === "queued" || j.status === "running"));
}
