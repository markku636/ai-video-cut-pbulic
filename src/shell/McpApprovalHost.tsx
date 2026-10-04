import { ShieldAlert } from "lucide-react";
import { useT } from "../i18n";
import { useMcpApprovals } from "../store/mcpApprovals";
import { Button } from "../ui/index";

/**
 * 外部 AI 要跑「會改東西」的工具時的確認卡（右下角，一步一張）。
 *
 * 掛在 App 根層而不是助手面板裡：呼叫可能來自使用者自己的 Claude Code / Codex 工作階段，
 * 那時候助手面板不一定開著，卡片還是要看得到。沒人按的話到時間自動拒絕（store/mcpApprovals.ts）。
 */
export default function McpApprovalHost() {
  const t = useT();
  const pending = useMcpApprovals((s) => s.pending);
  const answer = useMcpApprovals((s) => s.answer);
  if (!pending.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-10 right-3 z-50 flex w-80 flex-col gap-2" data-testid="mcp-approvals">
      {pending.map((p) => (
        <div key={p.id} role="alertdialog" aria-label={t("AI 想要執行")} className="pointer-events-auto rounded-md border border-warning/40 bg-elevated p-3 text-[12px] shadow-lg">
          <div className="mb-1 flex items-center gap-1.5 text-warning">
            <ShieldAlert size={14} />
            <span>{t("AI 想要執行")}</span>
          </div>
          <div className="text-fg/90">{t(p.title)}</div>
          {p.detail && <div className="mono mt-0.5 break-all text-[10px] text-fg/45">{p.detail}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => answer(p.id, false)} data-testid="mcp-approval-deny">
              {t("拒絕")}
            </Button>
            <Button variant="primary" onClick={() => answer(p.id, true)} data-testid="mcp-approval-allow">
              {t("允許")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
