import { useEffect, useRef, useState } from "react";
import { Send, Square, Trash2, Wrench } from "lucide-react";
import type { AgentBackend } from "../api";
import { currentAssistantState } from "../assistant/context";
import { TOOL_TITLE, type ToolName } from "../assistant/labels";
import { cliSystemPrompt } from "../assistant/systemPrompt";
import { useLang, useT } from "../i18n";
import { useAssistantChat, type ChatMsg, type ToolRow } from "../store/assistantChat";
import { Badge, Button, IconButton, Input } from "../ui/index";

/**
 * AI 助手（CLI 後端）：claude / codex 透過 App 的 MCP server **直接呼叫工具**，這裡把串流回來的文字、
 * 用了哪些工具、工具回了什麼長在對話裡。會改東西的工具由 App 另外跳確認卡（shell/McpApprovalHost）。
 *
 * 跟 HTTP 後端的差別只在「誰在跑工具迴圈」：HTTP 是模型給計畫、人按執行；CLI 是模型自己一步一步呼叫。
 * 工具本身、參數檢查、權限都是同一套（assistant/mcpBridge.ts）。
 */
export default function AssistantCliChat({ backend, prompts }: { backend: Exclude<AgentBackend, "http">; prompts: readonly string[] }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const { messages, busy, sessionId, sessionBackend, send, cancel, clear } = useAssistantChat();
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const submit = () => {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    // 狀態在送出這一刻才取：播放線、範圍隨時在變
    void send(backend, q, cliSystemPrompt(currentAssistantState(), lang));
  };

  const name = backend === "codex-cli" ? "Codex" : "Claude Code";
  const resuming = !!sessionId && sessionBackend === backend;

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex items-center gap-1.5 border-b border-fg/8 px-2 py-1">
        <Badge tone="accent">{name}</Badge>
        {resuming && <span className="text-[11px] text-fg/40">{t("接續上一段對話")}</span>}
        <IconButton
          icon={Trash2}
          label={t("清空對話")}
          iconSize={13}
          box="w-6 h-6"
          className="ml-auto"
          disabled={busy || !messages.length}
          onClick={clear}
          data-testid="assistant-cli-clear"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!messages.length && (
          <div className="space-y-2 py-2">
            <div className="text-fg/70">{t("{name} 會直接用 App 的工具做事；會改東西的步驟，App 會先跳出確認讓你按。", { name })}</div>
            <div className="flex flex-wrap gap-1">
              {prompts.map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setText(t(x))}
                  className="rounded-full border border-fg/12 px-2 py-0.5 text-[11px] text-fg/60 hover:border-accent/50 hover:text-fg"
                  data-testid="assistant-cli-example"
                >
                  {t(x)}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={m.id} msg={m} streaming={busy && i === messages.length - 1} />
        ))}
        <div ref={endRef} />
      </div>
      <div className="border-t border-fg/8 p-2">
        <div className="flex gap-1.5">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                submit();
              }
            }}
            placeholder={t("例如：把背景虛化")}
            className="flex-1"
            spellCheck={false}
            data-testid="assistant-cli-input"
          />
          {busy ? (
            <Button icon={Square} variant="secondary" onClick={() => void cancel()} aria-label={t("停止")} data-testid="assistant-cli-cancel" />
          ) : (
            <Button icon={Send} disabled={!text.trim()} onClick={submit} aria-label={t("送出（Enter）")} data-testid="assistant-cli-send" />
          )}
        </div>
      </div>
    </div>
  );
}

function toolTitle(name: string): string {
  return TOOL_TITLE[name as ToolName] ?? name;
}

function ToolLine({ row }: { row: ToolRow }) {
  const t = useT();
  const pending = row.result === undefined;
  return (
    <div className="flex items-start gap-1.5 border-b border-fg/6 px-2 py-1 last:border-b-0">
      <Wrench size={11} className={`mt-0.5 shrink-0 ${row.error ? "text-danger" : pending ? "text-fg/35" : "text-success"}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{t(toolTitle(row.name))}</div>
        {pending ? (
          <div className="text-[10px] text-fg/35">{t("執行中…")}</div>
        ) : row.result ? (
          <div className={`mono line-clamp-2 break-all text-[10px] ${row.error ? "text-danger/80" : "text-fg/40"}`}>{row.result}</div>
        ) : null}
      </div>
    </div>
  );
}

function MessageView({ msg, streaming }: { msg: ChatMsg; streaming: boolean }) {
  const t = useT();
  if (msg.role === "user") {
    return (
      <div className="mb-2 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-accent/15 px-2.5 py-1.5 text-fg/90">{msg.text}</div>
      </div>
    );
  }
  return (
    <div className="mb-3" data-testid="assistant-cli-reply">
      {msg.tools.length > 0 && (
        <div className="mb-1.5 rounded border border-fg/10">
          {msg.tools.map((row, i) => (
            <ToolLine key={i} row={row} />
          ))}
        </div>
      )}
      {msg.text && <div className="whitespace-pre-wrap break-words text-fg/85">{msg.text}</div>}
      {streaming && !msg.text && <div className="text-fg/50">{t("想一下…")}</div>}
      {msg.error && <div className="mt-1 text-[11px] text-danger/80">{t(msg.error)}</div>}
      {msg.durationMs != null && !streaming && <div className="mt-0.5 text-[10px] text-fg/30">{t("{s} 秒", { s: (msg.durationMs / 1000).toFixed(1) })}</div>}
    </div>
  );
}
