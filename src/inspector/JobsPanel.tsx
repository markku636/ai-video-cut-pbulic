import { Activity, Cpu, RotateCcw, X } from "lucide-react";
import type { EngineStateKind } from "../api";
import { useT } from "../i18n";
import { useJobs, type Job } from "../store/jobs";
import { formatDuration } from "../time";
import { Badge, Button, EmptyState, Icon, IconButton, ProgressBar, type BadgeTone } from "../ui/index";
import { useEngine } from "./_contracts";
import { ENGINE_STATE_LABEL, JOB_KIND_LABEL, JOB_STATUS_LABEL } from "./labels";

/**
 * Jobs（計畫 §9）：`useJobs` 清單 + 引擎狀態 / 重啟 + GPU 名；一行「重新渲染不限次數、不計費用（本機 GPU）」。
 * JobKind 的顯示名走 JOB_KIND_LABEL（查不到就顯示原字 —— store/jobs.ts 的表還沒換成計畫 §8 的新集合）。
 */
const ENGINE_TONE: Record<EngineStateKind, BadgeTone> = { down: "neutral", starting: "info", ready: "success", broken: "danger" };
const ENGINE_DOT: Record<EngineStateKind, string> = { down: "bg-fg/30", starting: "bg-info", ready: "bg-success", broken: "bg-danger" };
const STATUS_TONE: Record<Job["status"], BadgeTone> = { queued: "neutral", running: "info", done: "success", error: "danger", canceled: "neutral" };

const isActive = (j: Job) => j.status === "running" || j.status === "queued";

export default function JobsPanel() {
  const t = useT();
  const jobs = useJobs((s) => s.jobs);
  const cancel = useJobs((s) => s.cancel);
  const clearFinished = useJobs((s) => s.clearFinished);
  const engine = useEngine();
  const hasFinished = jobs.some((j) => !isActive(j));

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="border-b border-fg/8 px-3 py-2 text-[12px]">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${ENGINE_DOT[engine.state]}`} aria-hidden />
          <span className="text-fg/70">{t("引擎")}</span>
          <Badge tone={ENGINE_TONE[engine.state]}>{t(ENGINE_STATE_LABEL[engine.state])}</Badge>
          <Button size="sm" variant="ghost" icon={RotateCcw} className="ml-auto" onClick={() => void engine.restart()}>
            {t("重啟")}
          </Button>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg/50">
          <Icon icon={Cpu} size={13} />
          <span className="truncate">{engine.gpuName ?? t("尚未偵測到 GPU")}</span>
        </div>
        {engine.message && <div className="mt-1 break-words text-[11px] text-fg/45">{engine.message}</div>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {jobs.length === 0 ? (
          <EmptyState icon={Activity} title={t("沒有工作")} hint={t("產生 proxy、偵測、追蹤、輸出都會列在這裡，可以隨時取消。")} compact />
        ) : (
          <div className="divide-y divide-fg/5">
            {[...jobs].reverse().map((j) => (
              <JobRow key={j.id} job={j} onCancel={() => cancel(j.id)} />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-fg/8 px-3 py-2 text-[11px] text-fg/45">
        <span>{t("重新渲染不限次數、不計費用（本機 GPU）")}</span>
        {hasFinished && (
          <button type="button" className="ml-auto text-fg/60 hover:text-fg" onClick={clearFinished}>
            {t("清除已完成")}
          </button>
        )}
      </div>
    </div>
  );
}

function JobRow({ job, onCancel }: { job: Job; onCancel: () => void }) {
  const t = useT();
  const kindLabel = JOB_KIND_LABEL[job.kind] ? t(JOB_KIND_LABEL[job.kind]) : job.kind;
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  const active = isActive(job);
  return (
    <div className="px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="font-medium truncate">{kindLabel}</span>
        <Badge tone={STATUS_TONE[job.status]}>{t(JOB_STATUS_LABEL[job.status])}</Badge>
        <span className="ml-auto text-[10px] tabular-nums text-fg/40">{elapsed}</span>
        {active && <IconButton icon={X} label={t("取消")} iconSize={13} box="w-6 h-6" onClick={onCancel} />}
      </div>
      {(job.step || job.message) && <div className="mt-0.5 truncate text-[11px] text-fg/55">{[job.step, job.message].filter(Boolean).join(" · ")}</div>}
      {job.status === "error" && job.error && <div className="mt-0.5 break-words text-[11px] text-danger">{job.error}</div>}
      {active &&
        (job.pct === null ? (
          <div className="mt-1.5">
            <ProgressBar active />
          </div>
        ) : (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-accent/15" role="progressbar" aria-valuenow={Math.round(job.pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, job.pct))}%` }} />
          </div>
        ))}
    </div>
  );
}
