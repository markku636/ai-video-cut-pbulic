import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { APP_NAME } from "../brand";
import { commandLabel, moreMenuItems } from "../commands/menuModel";
import { command, runCommand, useCommandTick } from "../commands/registry";
import { formatShortcut } from "../commands/shortcut";
import type { Command } from "../commands/types";
import { useT } from "../i18n";
import { collect } from "../plugins/registry";
import { useTimeline, type TimelineTool } from "../store/timeline";
import Icon from "../ui/Icon";
import MenuPanel from "../ui/MenuPanel";

/**
 * 主要動作：開檔 / 找物件 / 新追蹤 / 輸出 / 儲存（核心）；外掛可以插自己的（例如 cards 的「偵測所有牌」接在開檔後面，
 * 這時「找物件」照樣在：兩個都留，牌外掛的使用者也可以找牌以外的東西）。
 */
const CORE_PRIMARY = ["file.open", "object.find", "track.new", "export.video", "file.save"];

export function primaryCommandIds(): string[] {
  const out = [...CORE_PRIMARY];
  for (const x of collect((p) => p.toolbar)) {
    if (out.includes(x.id)) continue;
    const i = x.after ? out.indexOf(x.after) : -1;
    if (i >= 0) out.splice(i + 1, 0, x.id);
    else out.push(x.id);
  }
  return out;
}

/** 工具切換：選取 / 選取物件 / 表面 / 追蹤區域 / 加選 / 減選（對應 timeline.tool；快捷鍵在各指令上）。 */
const TOOLS: { tool: TimelineTool; cmd: string }[] = [
  { tool: "select", cmd: "track.tool.select" },
  { tool: "objSelect", cmd: "object.tool.select" },
  { tool: "corner", cmd: "track.tool.surface" },
  { tool: "region", cmd: "track.tool.trackingRegion" },
  { tool: "maskPos", cmd: "mask.tool.addSelection" },
  { tool: "maskNeg", cmd: "mask.tool.reduceSelection" },
];

/**
 * 上方大圖示工具列。沒有 props：主要按鈕、工具組與「更多」下拉都從指令註冊表長出來。
 * 放不下時收成純圖示（承襲 db-kit：遲滯量測避免震盪）。
 */
export default function Toolbar() {
  const t = useT();
  useCommandTick();
  const tool = useTimeline((s) => s.tool);
  const primary = primaryCommandIds().map(command).filter((c): c is Command => !!c);

  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const barRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const neededRef = useRef(0);
  useLayoutEffect(() => {
    neededRef.current = 0;
    setCompact(false);
  }, [t]);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      if (!compact) {
        if (bar.scrollWidth > bar.clientWidth) {
          neededRef.current = bar.scrollWidth;
          setCompact(true);
        }
      } else if (neededRef.current && bar.clientWidth >= neededRef.current) {
        setCompact(false);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [compact, t]);

  const bigButton = (key: string, icon: ReactNode, label: string, opts: { onClick: () => void; disabled?: boolean; title?: string; active?: boolean; badge?: boolean; dataCmd?: string }) => (
    <button
      type="button"
      key={key}
      onClick={opts.onClick}
      disabled={opts.disabled}
      title={opts.title}
      data-cmd={opts.dataCmd}
      className={`${compact ? "w-11" : "min-w-16 px-2"} relative shrink-0 h-12 flex flex-col items-center justify-center rounded hover:bg-fg/5 disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-accent/60 ${
        opts.active ? "bg-accent/12 text-accent" : ""
      }`}
    >
      <span className="text-lg leading-none inline-flex items-center gap-0.5">{icon}</span>
      {!compact && <span className="text-[11px] text-fg/60 mt-1 whitespace-nowrap">{label}</span>}
      {opts.badge && <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-warning" aria-hidden />}
    </button>
  );

  return (
    <div ref={barRef} className="h-16 bg-bar border-b border-fg/10 flex items-center px-3 gap-1 shadow-e1" data-testid="toolbar">
      <div className="mr-4 pl-1 flex flex-col justify-center shrink-0 leading-tight">
        <div className="font-semibold text-fg/90 flex items-baseline gap-1.5">
          <span>{APP_NAME}</span>
          <button
            type="button"
            onClick={() => void runCommand("help.about", "toolbar")}
            title={t("版本 {version}", { version: __APP_VERSION__ })}
            className="text-[11px] font-normal text-fg/40 tabular-nums hover:text-fg/70 hover:underline focus-visible:outline-2 focus-visible:outline-accent/60 rounded"
          >
            v{__APP_VERSION__}
          </button>
        </div>
      </div>
      {primary.map((c) => {
        const en = c.enabled();
        const label = commandLabel(c);
        const sc = c.shortcuts?.length ? formatShortcut(c.shortcuts[0]) : null;
        return bigButton(c.id, c.icon ? <Icon icon={c.icon} size={20} /> : null, label, {
          // 不灰掉要解釋：停用時 tooltip 就是原因；能用時附快捷鍵
          onClick: () => void runCommand(c.id, "toolbar"),
          disabled: !en.ok,
          title: en.ok ? (sc ? `${label}（${sc}）` : label) : t(en.why),
          badge: c.badge?.(),
          dataCmd: c.id,
        });
      })}

      <span className="w-px h-8 bg-fg/10 mx-1 shrink-0" aria-hidden />
      <div className="flex items-center gap-0.5 shrink-0" role="radiogroup" aria-label={t("工具")}>
        {TOOLS.map((x) => {
          const c = command(x.cmd);
          if (!c) return null;
          const en = c.enabled();
          const label = commandLabel(c).replace(/^工具：/, "");
          const sc = c.shortcuts?.length ? formatShortcut(c.shortcuts[0]) : null;
          return (
            <button
              key={x.tool}
              type="button"
              role="radio"
              aria-checked={tool === x.tool}
              disabled={!en.ok}
              onClick={() => void runCommand(x.cmd, "toolbar")}
              title={en.ok ? (sc ? `${label}（${sc}）` : label) : t(en.why)}
              data-cmd={x.cmd}
              className={`w-9 h-9 grid place-items-center rounded disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent/60 ${tool === x.tool ? "bg-accent text-white shadow-e1" : "text-fg/60 hover:bg-fg/10 hover:text-fg"}`}
            >
              {c.icon && <Icon icon={c.icon} size={18} />}
            </button>
          );
        })}
      </div>

      <div className="ml-auto shrink-0 flex items-center gap-1 pl-3">
        <button
          ref={moreRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={t("更多（檢視 / 輸出 / 說明）")}
          data-cmd="toolbar.more"
          className={`h-8 px-2 flex items-center gap-1 rounded text-xs text-fg/60 hover:bg-fg/5 hover:text-fg/85 focus-visible:outline-2 focus-visible:outline-accent/60 ${open ? "bg-accent/12 text-accent" : ""}`}
        >
          <Icon icon={MoreHorizontal} size={18} />
          {!compact && <span>{t("更多")}</span>}
          <ChevronDown size={12} className="opacity-60" />
        </button>
      </div>

      {open && moreRef.current && <MenuPanel anchor={{ rect: moreRef.current.getBoundingClientRect(), side: "bottom" }} items={moreMenuItems()} onClose={() => setOpen(false)} minWidthClass="min-w-56" />}
    </div>
  );
}
