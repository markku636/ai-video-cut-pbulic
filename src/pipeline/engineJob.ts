import { api, errMessage, isCanceled, listenJob, type EngineArtifactEvent, type EngineJobDone, type EngineOp, type EngineProgress } from "../api";
import type { t as translate } from "../i18n";
import { newJobId, useJobs, type Job, type JobKind } from "../store/jobs";
import { JOB_KIND_LABEL, PIPELINE_STEP_LABEL } from "../video/labels";

/**
 * 引擎長工作的共用管線（形狀借自 ai-music-cut pipeline/waveform.ts：inflight Map + job + jobId 過濾 listen + 1.5 s 自動移除）。
 *
 * - 前端 jobId 就是 wire id（決策 7）：`engine_job_start(jobId, op, args)` → 事件 `engine-progress` / `engine-job-done` 都帶 job_id。
 * - **每個監聽器都先比對 job_id**（listenJob 已做）：兩個 job 同時跑時漏掉這一行，A 的進度會畫到 B 的列上。
 * - Rust 先取 GPU permit 才送進引擎（Semaphore(1)）：job 建好時是 `queued`，第一個 progress 才轉 `running`。
 * - `done` 事件恰一次；沒等到就是 Rust 那邊炸了（engine_job_start 本身 reject）。
 */
export interface EngineJobOpts {
  kind: JobKind;
  mediaId: string;
  op: EngineOp;
  args: Record<string, unknown>;
  /** 要不要搶 GPU permit（預設 true；純 CPU 的 media.* 可以不搶）。 */
  gpu?: boolean;
  /** 這個 job 針對哪一條 track（車道進度）。 */
  trackId?: string;
  /** 一開始顯示的步驗文字（zh key）。 */
  step?: string;
  onProgress?: (p: EngineProgress) => void;
  /** 提早可用的檔案（`ctx.artifact`：解 / 遮罩 / 矯正牌面 / 專案檔）。 */
  onArtifact?: (a: EngineArtifactEvent) => void;
}

/**
 * progress → 工作清單上的一行字。`pipeline.run` 用 `stage:"pipeline", step:<name>` 記總進度，
 * 其他 op 的 stage 像 "seg.propagate" / "track.all" / "detect.frames"：取第一段查表，查不到就原樣。
 */
export function stepLabel(p: EngineProgress, fallback = ""): string {
  const key = p.stage === "pipeline" && typeof p.step === "string" && p.step ? p.step : (p.stage || "").split(".")[0];
  return PIPELINE_STEP_LABEL[key] ?? (p.stage || fallback);
}

// ---- B-14：可信的偵測進度（單調總進度 + 第 n/m 步 + 約剩多久）----

/**
 * 多段 op（`pipeline.run`）的總進度狀態。
 *
 * 為什麼要自己記：引擎送兩種 progress —— `stage:"pipeline"` 的大步（i/9）與各 stage 自己的細進度（幀）。
 * 以前 job.pct 直接寫「最後一筆事件的 pct」，所以物件遮罩 209/209 會顯示 100%、下一秒追蹤 3/836 變成 0%。
 * 這裡把大步索引記下來，總進度 = (stageIdx + 細進度/100) / stageCount，而且用 `max(上一次, 這一次)` 保證不倒退。
 */
export interface PipelineProgress {
  /** 目前第幾大步（0 起算，來自 pipeline 事件的 done）；還沒收到過就是 null。 */
  stageIdx: number | null;
  /** 總共幾大步（pipeline 事件的 total，目前是 9）。 */
  stageCount: number | null;
  /** 0–100 的單調總進度；非多段 op 時就是該 op 自己的 pct。 */
  overall: number | null;
  /** 引擎最新一筆的 eta_s（「這一步」還要多久；serve.py 依 stage 起點外推）。 */
  etaS: number | null;
}

export const NO_PIPELINE_PROGRESS: PipelineProgress = { stageIdx: null, stageCount: null, overall: null, etaS: null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 收到一筆 progress → 新的總進度狀態（純函式，狀態全部來自 prev）。 */
export function nextPipelineProgress(prev: PipelineProgress, p: EngineProgress): PipelineProgress {
  const isPipeline = p.stage === "pipeline";
  let { stageIdx, stageCount } = prev;
  if (isPipeline) {
    const done = num(p.done);
    const total = num(p.total);
    if (done != null) stageIdx = Math.max(0, done);
    if (total != null && total > 0) stageCount = total;
  }
  const sub = num(p.pct);
  let overall: number | null;
  if (stageIdx != null && stageCount != null && stageCount > 0) {
    // 大步事件本身代表「這一步剛開始」（細進度 0）；細進度事件才把 0–100 填進這一格
    const within = isPipeline ? 0 : Math.min(100, Math.max(0, sub ?? 0)) / 100;
    overall = ((Math.min(stageIdx, stageCount) + within) / stageCount) * 100;
  } else {
    overall = sub; // 單段 op（media.proxy / seg.propagate…）：照舊用它自己的百分比
  }
  overall = overall == null ? prev.overall : Math.min(100, Math.max(prev.overall ?? 0, overall));
  const eta = num(p.eta_s);
  // 換大步時把上一段的剩餘時間丟掉（不然物件遮罩結束的「剩 2 秒」會掛在追蹤開頭）
  const keep = isPipeline && stageIdx !== prev.stageIdx ? null : prev.etaS;
  return { stageIdx, stageCount, overall, etaS: eta ?? keep };
}

/** 總進度低於這個百分比、或工作還沒跑滿這麼久，就不推估剩餘時間（分母太小會噴出離譜的數字）。 */
const ETA_MIN_PCT = 3;
const ETA_MIN_ELAPSED_MS = 3000;
/** 推估超過這麼久就不顯示（寧可不講，也不要講一個沒人信的數字）。 */
const ETA_MAX_S = 2 * 60 * 60;

/**
 * 還要多久（秒）；估不出來回 null。
 *
 * 取「引擎說這一步還要多久」與「照總進度線性外推」的**大值**：九個大步長短差很多（probe / index / shots 是瞬間，
 * seg 與 track 佔九成），任一個單獨看都會低估，取大值至少不會比「目前這一步」還短。
 */
export function jobRemainingS(job: Pick<Job, "pct" | "etaS" | "startedAt">, now = Date.now()): number | null {
  const stage = job.etaS != null && Number.isFinite(job.etaS) && job.etaS >= 0 ? job.etaS : null;
  const elapsed = (now - job.startedAt) / 1000;
  const pct = job.pct;
  const byOverall = pct != null && pct >= ETA_MIN_PCT && pct < 100 && now - job.startedAt >= ETA_MIN_ELAPSED_MS ? (elapsed * (100 - pct)) / pct : null;
  if (stage == null && byOverall == null) return null;
  const s = Math.max(stage ?? 0, byOverall ?? 0);
  return s > ETA_MAX_S ? null : s;
}

/** 剩餘秒數 → 「約剩 40 秒」／「約剩 2 分 05 秒」。 */
export function etaText(seconds: number, tr: typeof translate): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return tr("約剩 {s} 秒", { s });
  return tr("約剩 {m} 分 {s} 秒", { m: Math.floor(s / 60), s: String(s % 60).padStart(2, "0") });
}

/** 狀態列 / 工作清單的那一行：「物件遮罩（第 4/9 步）· 43% · 約剩 40 秒」。 */
export function jobProgressText(job: Pick<Job, "kind" | "step" | "pct" | "stageIdx" | "stageCount" | "etaS" | "status" | "startedAt">, tr: typeof translate, now = Date.now()): string {
  const head = job.step ? tr(job.step) : tr(JOB_KIND_LABEL[job.kind]);
  const stage = job.stageIdx != null && job.stageCount ? tr("（第 {i}/{n} 步）", { i: Math.min(job.stageIdx + 1, job.stageCount), n: job.stageCount }) : "";
  const bits: string[] = [];
  if (job.pct != null) bits.push(`${Math.round(job.pct)}%`);
  else if (job.status === "queued") bits.push(tr("排隊中"));
  const remain = job.status === "running" ? jobRemainingS(job, now) : null;
  if (remain != null) bits.push(etaText(remain, tr));
  if (!bits.length) return head + stage;
  // 全形「）」自帶視覺留白，所以有步數時分隔號前面不再補空白（「…步）· 43%」）
  return `${head}${stage}${stage ? "" : " "}· ${bits.join(" · ")}`;
}

/** 完成的 job 留在清單上這麼久再自動移除（讓人看得到「完成」一下）。 */
const AUTO_REMOVE_MS = 1500;

export function runEngineJob<T = unknown>(opts: EngineJobOpts): Promise<T> {
  const jobId = newJobId();
  const jobs = useJobs.getState();
  jobs.upsert({
    id: jobId,
    kind: opts.kind,
    mediaId: opts.mediaId,
    trackId: opts.trackId,
    step: opts.step ?? "",
    pct: null,
    message: "",
    status: "queued",
    startedAt: Date.now(),
    cancel: () => void api.engineJobCancel(jobId).catch(() => {}),
  });

  return new Promise<T>((resolve, reject) => {
    let unProgress: (() => void) | null = null;
    let unArtifact: (() => void) | null = null;
    let unDone: (() => void) | null = null;
    let settled = false;
    const finish = (status: "done" | "error" | "canceled", extra: { error?: string } = {}) => {
      if (settled) return;
      settled = true;
      unProgress?.();
      unArtifact?.();
      unDone?.();
      useJobs.getState().upsert({ id: jobId, status, pct: status === "done" ? 100 : undefined, endedAt: Date.now(), ...extra });
      if (status === "done") window.setTimeout(() => useJobs.getState().remove(jobId), AUTO_REMOVE_MS);
    };

    let prog = NO_PIPELINE_PROGRESS;
    void (async () => {
      try {
        unProgress = await listenJob<EngineProgress>("engine-progress", jobId, (p) => {
          // pipeline 總進度（stage:"pipeline"）記第幾大步；各 stage 自己的細進度另外送。
          // 兩種都收：文字顯示目前 stage，百分比是**合起來算的單調總進度**（B-14；以前直接寫最後一筆的 pct，
          // 所以遮罩 209/209 顯示 100% 之後、追蹤 3/836 又掉回 0%）
          prog = nextPipelineProgress(prog, p);
          useJobs.getState().upsert({
            id: jobId,
            status: "running",
            step: stepLabel(p, opts.step),
            pct: prog.overall,
            stageIdx: prog.stageIdx ?? undefined,
            stageCount: prog.stageCount ?? undefined,
            etaS: prog.etaS,
            frame: typeof p.frame === "number" ? p.frame : undefined,
            message: typeof p.message === "string" ? p.message : p.stage === "pipeline" ? "" : p.stage,
          });
          opts.onProgress?.(p);
        });
        if (opts.onArtifact) unArtifact = await listenJob<EngineArtifactEvent>("engine-artifact", jobId, (a) => opts.onArtifact?.(a));
        unDone = await listenJob<EngineJobDone>("engine-job-done", jobId, (d) => {
          if (d.ok) {
            finish("done");
            resolve(d.result as T);
          } else {
            const canceled = d.error?.kind === "Canceled";
            finish(canceled ? "canceled" : "error", canceled ? {} : { error: d.error ? errMessage(d.error) : "引擎沒有回覆" });
            reject(d.error ?? new Error("引擎沒有回覆"));
          }
        });
        await api.engineJobStart(jobId, opts.op, opts.args, opts.gpu ?? true);
      } catch (e) {
        // engine_job_start 自己 reject（引擎起不來 / pyenv 缺）：不會有 done 事件，這裡收尾
        finish(isCanceled(e) ? "canceled" : "error", isCanceled(e) ? {} : { error: errMessage(e) });
        reject(e);
      }
    })();
  });
}

/** 同一把 key 的工作只跑一份：重複呼叫拿同一個 promise（開檔連點兩下不會建兩個 proxy）。 */
const inflight = new Map<string, Promise<unknown>>();

export function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const cur = inflight.get(key);
  if (cur) return cur as Promise<T>;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function isInflight(key: string): boolean {
  return inflight.has(key);
}

/** 目前有沒有這種 job 還在跑（queued / running）。 */
export function runningJob(kind: JobKind, mediaId?: string, trackId?: string) {
  return useJobs.getState().jobs.find((j) => j.kind === kind && (j.status === "queued" || j.status === "running") && (!mediaId || j.mediaId === mediaId) && (!trackId || j.trackId === trackId)) ?? null;
}
