import { create } from "zustand";

/**
 * 外部 AI（claude / codex CLI，或使用者自己的 Claude Code / Codex 工作階段）要跑「會改東西」的工具時，先排在這裡等人按。
 *
 * 跟 HTTP 助手「整份計畫按一次執行」同一個原則：會改專案或寫檔案的步驟一定要人按過。
 * 差別只是 CLI 是一步一步呼叫，所以一步問一次。沒人回應就當拒絕（MCP 那邊有逾時，等太久模型會以為工具壞了）。
 */
export interface ApprovalRequest {
  id: string;
  /** 工具的顯示名稱（zh key）。 */
  title: string;
  /** 參數摘要（`k=v  k=v`）。 */
  detail: string;
  /** 到期時間（Date.now() 毫秒）；過了就自動拒絕。 */
  deadline: number;
}

interface ApprovalStore {
  pending: ApprovalRequest[];
  /** 排一個請求；回 true＝允許。`timeoutMs` 到了沒人按＝拒絕。 */
  request: (req: { title: string; detail: string }, timeoutMs?: number) => Promise<boolean>;
  answer: (id: string, allow: boolean) => void;
}

/** 預設等多久：比 App 給「會改東西」工具的 MCP 逾時短一點，讓模型收到的是「使用者沒有允許」而不是逾時。 */
export const APPROVAL_TIMEOUT_MS = 150_000;

const waiters = new Map<string, { resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;

export const useMcpApprovals = create<ApprovalStore>((set) => ({
  pending: [],
  request: ({ title, detail }, timeoutMs = APPROVAL_TIMEOUT_MS) =>
    new Promise<boolean>((resolve) => {
      const id = `ap-${Date.now().toString(36)}-${++seq}`;
      const timer = setTimeout(() => useMcpApprovals.getState().answer(id, false), timeoutMs);
      waiters.set(id, { resolve, timer });
      set((s) => ({ pending: [...s.pending, { id, title, detail, deadline: Date.now() + timeoutMs }] }));
    }),
  answer: (id, allow) => {
    const w = waiters.get(id);
    if (w) {
      clearTimeout(w.timer);
      waiters.delete(id);
      w.resolve(allow);
    }
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },
}));
