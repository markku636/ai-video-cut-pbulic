import { useEffect, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { api, type AgentBackend, type AppSettings, type CliStatus, type McpInfo } from "../api";
import { agentBackendOf } from "../assistant/backend";
import { useT } from "../i18n";
import { copyToClipboard } from "../ui";
import { Badge, Button, Field, IconButton, Input, Segmented } from "../ui/index";
import Section from "./SettingsSection";

/**
 * 設定 →「AI 後端」：助手用哪一個大腦，以及讓使用者自己的 Claude Code / Codex 連進 App 的方法。
 *
 * - **HTTP**：既有的端點設定（下面「AI 助手」那一段），計畫按了才執行。
 * - **Claude Code / Codex（CLI）**：用使用者自己的訂閱登入，透過 App 內建的 MCP server 直接呼叫工具；
 *   會改東西的步驟 App 會跳確認。CLI 有沒有裝、有沒有登入在這裡偵測給人看。
 * - **外部連線**：MCP server 的位址與 token（每次啟動都換）組好的指令，複製到自己的終端機就能讓自己的
 *   Claude Code / Codex 操作 App。固定 port 之後只有 token 會變。
 */
export default function AgentBackendSection({
  draft,
  patch,
  commit,
}: {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  commit: (p: Partial<AppSettings>) => Promise<void>;
}) {
  const t = useT();
  const backend = agentBackendOf(draft.agent_backend);
  const [claude, setClaude] = useState<CliStatus | null>(null);
  const [codex, setCodex] = useState<CliStatus | null>(null);
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [portDraft, setPortDraft] = useState(String(draft.mcp_port || ""));

  const probe = async () => {
    setProbing(true);
    const [a, b, m] = await Promise.all([api.claudeDetect().catch(() => null), api.codexDetect().catch(() => null), api.mcpInfo().catch(() => null)]);
    setClaude(a);
    setCodex(b);
    setMcp(m);
    setProbing(false);
  };
  // 開設定時偵測一次（各跑一次 --version，幾百毫秒）；之後由「重新偵測」按鈕
  useEffect(() => void probe(), []);

  const commitPort = () => {
    const n = Math.round(Number(portDraft.trim() || "0"));
    const port = Number.isFinite(n) && n >= 0 && n <= 65535 ? n : 0;
    setPortDraft(port ? String(port) : "");
    if (port !== draft.mcp_port) void commit({ mcp_port: port });
  };

  const options: { value: AgentBackend; label: string }[] = [
    { value: "http", label: t("端點（本機模型／API）") },
    { value: "claude-cli", label: "Claude Code" },
    { value: "codex-cli", label: "Codex" },
  ];

  return (
    <Section title={t("AI 後端")}>
      <div className="text-[12px] leading-relaxed text-fg/55">
        {t("助手用哪一個模型。Claude Code／Codex 用你自己電腦上已登入的 CLI（你的訂閱），會直接用 App 的工具做事；會改東西的步驟 App 會先跳確認。")}
      </div>
      <Segmented full ariaLabel={t("AI 後端")} value={backend} onChange={(v) => void commit({ agent_backend: v })} options={options} />

      <div className="space-y-1 text-[12px]">
        <CliLine name="Claude Code" st={claude} install="npm i -g @anthropic-ai/claude-code" login="claude" />
        <CliLine name="Codex" st={codex} install="npm i -g @openai/codex" login="codex login" />
        <div className="flex justify-end">
          <Button variant="ghost" icon={RefreshCw} loading={probing} onClick={() => void probe()} data-testid="settings-agent-detect">
            {t("重新偵測")}
          </Button>
        </div>
      </div>

      <Field label={t("Claude 模型（CLI）")} hint={t("例如 sonnet、opus、haiku；留空＝claude 自己的預設。")}>
        <Input
          value={draft.claude_model}
          onChange={(e) => patch({ claude_model: e.target.value })}
          onBlur={() => void commit({ claude_model: draft.claude_model.trim() })}
          className="mono"
          spellCheck={false}
          placeholder={t("（CLI 的預設）")}
          data-testid="settings-claude-cli-model"
        />
      </Field>
      <Field label={t("Codex 模型（CLI）")} hint={t("留空＝照 codex 自己的設定（~/.codex/config.toml）。")}>
        <Input
          value={draft.codex_model}
          onChange={(e) => patch({ codex_model: e.target.value })}
          onBlur={() => void commit({ codex_model: draft.codex_model.trim() })}
          className="mono"
          spellCheck={false}
          placeholder={t("（CLI 的預設）")}
          data-testid="settings-codex-cli-model"
        />
      </Field>

      <Field label={t("MCP 連接埠")} hint={t("App 內建的 MCP server 只聽本機（127.0.0.1）。留空或 0＝每次啟動隨機；固定之後外部登記一次就好。改了要重新啟動 App 才生效。")}>
        <Input
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commitPort}
          className="mono"
          inputMode="numeric"
          spellCheck={false}
          placeholder={t("隨機")}
          data-testid="settings-mcp-port"
        />
      </Field>

      <div className="space-y-1.5">
        <div className="text-[12px] text-fg/70">{t("讓你自己的 Claude Code／Codex 操作 App")}</div>
        {mcp && mcp.port ? (
          <>
            <div className="text-[11px] text-fg/45">{t("目前在 {url}（{n} 個工具）。token 每次啟動 App 都會換，重開之後要重新登記。", { url: mcp.url, n: mcp.tools })}</div>
            {mcp.error && <div className="text-[11px] text-warning">{mcp.error}</div>}
            <CommandRow label="Claude Code" cmd={mcp.commands.claude} />
            <CommandRow label={t("Codex（先設環境變數）")} cmd={mcp.commands.codex_env} />
            <CommandRow label="Codex" cmd={mcp.commands.codex} />
          </>
        ) : (
          <div className="text-[11px] text-danger/80">{mcp?.error ?? t("MCP server 沒有啟動")}</div>
        )}
      </div>
    </Section>
  );
}

function CliLine({ name, st, install, login }: { name: string; st: CliStatus | null; install: string; login: string }) {
  const t = useT();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-24 shrink-0 text-fg/70">{name}</span>
      {!st ? (
        <span className="text-fg/40">{t("偵測中…")}</span>
      ) : !st.installed ? (
        <span className="min-w-0 truncate text-fg/50" title={install}>
          <Badge tone="neutral">{t("沒有安裝")}</Badge> <span className="mono text-[11px]">{install}</span>
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge tone={st.logged_in ? "success" : "warning"} dot>
            {st.logged_in ? t("已登入") : t("沒有登入")}
          </Badge>
          <span className="mono truncate text-[11px] text-fg/45" title={st.path ?? ""}>
            {st.version}
          </span>
          {!st.logged_in && <span className="mono text-[11px] text-fg/45">{login}</span>}
        </span>
      )}
    </div>
  );
}

function CommandRow({ label, cmd }: { label: string; cmd: string }) {
  const t = useT();
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] text-fg/45">{label}</div>
      <div className="flex items-start gap-1">
        <code className="mono min-w-0 flex-1 break-all rounded bg-inset px-2 py-1 text-[11px] text-fg/75">{cmd}</code>
        <IconButton icon={Copy} label={t("複製到剪貼簿")} iconSize={13} box="w-6 h-6" onClick={() => void copyToClipboard(cmd)} />
      </div>
    </div>
  );
}
