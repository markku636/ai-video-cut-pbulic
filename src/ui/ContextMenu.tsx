import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "zustand";
import { useCommandTick } from "../commands/registry";
import MenuPanel, { type MenuItem } from "./MenuPanel";

/**
 * 右鍵選單的單一宿主（任何元件一行 `openContextMenu(e, () => items)` 就能開）。
 *
 * 為什麼是「命令式 + 自己掛 React root」而不是每個元件各自 `useContextMenu()` 再 render 一個元素：
 * - 同一時間只該有一個右鍵選單。各自 render 的話，右鍵時間軸時舞台那個還開著，要靠 mousedown 互相關。
 * - 掛點（時間軸 canvas、舞台 canvas、側欄列、外掛的表格列）分散在四個由不同人維護的檔案；
 *   命令式 API 讓每個掛點只多一行，不必在各自的 JSX 裡再塞一個浮層元素。
 * - 宿主掛在 body 底下獨立的 root：選單是 `position: fixed`，不受任何 overflow / transform 容器裁切。
 *   i18n 與主題都是 store / CSS 變數，不依賴 React context，所以分開的 root 看得到同樣的語言與配色。
 *
 * 行為（MenuPanel 已做的：子選單、↑↓ Home End 首字、→ ← 進出子選單、Esc / 點外面 / 捲輪 / 視窗縮放關閉、
 * 超出視窗往內收）之外，這裡補三件事：
 * 1. 開啟時把焦點放進選單（不預選任何一列），鍵盤馬上能用；關閉時把焦點還給開選單前的元素。
 * 2. 選單開著時鍵盤事件不往 window 冒泡：不然按 K 會一邊在選單裡找首字、一邊觸發「設關鍵幀」。
 * 3. `items` 可以是函式：指令的 enabled() 一變（引擎就緒、job 跑完）就重算，停用原因不會停在開選單那一刻。
 */

export type MenuSource = MenuItem[] | (() => MenuItem[]);

interface MenuRequest {
  x: number;
  y: number;
  source: MenuSource;
  /** 同一個位置再開一次也要重建 anchor（MenuPanel 依 anchor 物件重新定位）。 */
  nonce: number;
}

interface HostState {
  req: MenuRequest | null;
}

const useMenuHost = create<HostState>(() => ({ req: null }));

let hostEl: HTMLElement | null = null;
let hostRoot: Root | null = null;
let prevFocus: HTMLElement | null = null;
let nonce = 0;

function resolve(source: MenuSource): MenuItem[] {
  return typeof source === "function" ? source() : source;
}

/** 頭尾 / 連續分隔線與「只剩分隔線」的清單不算有內容。 */
function hasContent(items: MenuItem[]): boolean {
  return items.some((it) => !it.separator);
}

function ensureHost(): boolean {
  if (typeof document === "undefined") return false;
  if (hostRoot && hostEl?.isConnected) return true;
  hostEl = document.createElement("div");
  hostEl.dataset.aivcContextMenu = "";
  document.body.appendChild(hostEl);
  hostRoot = createRoot(hostEl);
  hostRoot.render(<ContextMenuHost />);
  return true;
}

export type MenuPoint = { clientX: number; clientY: number } | { x: number; y: number };

/**
 * 在滑鼠位置開右鍵選單。傳入 React / DOM 的 MouseEvent 時會順手 preventDefault（擋掉 WebView 的原生選單）。
 * 內容是空的（全部被隱藏）就不開 —— 一個空框比沒反應更像壞掉。
 */
export function openContextMenu(at: MenuPoint & { preventDefault?: () => void; stopPropagation?: () => void }, source: MenuSource): void {
  at.preventDefault?.();
  at.stopPropagation?.();
  const items = resolve(source);
  if (!hasContent(items)) {
    closeContextMenu();
    return;
  }
  if (!ensureHost()) return;
  const x = "clientX" in at ? at.clientX : at.x;
  const y = "clientY" in at ? at.clientY : at.y;
  if (!useMenuHost.getState().req) {
    const ae = document.activeElement;
    prevFocus = ae instanceof HTMLElement && ae !== document.body && !hostEl?.contains(ae) ? ae : null;
  }
  useMenuHost.setState({ req: { x, y, source, nonce: ++nonce } });
}

export function closeContextMenu(): void {
  if (!useMenuHost.getState().req) return;
  const back = prevFocus;
  prevFocus = null;
  useMenuHost.setState({ req: null });
  // 只在焦點還在選單裡（或已經掉到 body）時還回去：點了會開對話框的項目，
  // 對話框自己的輸入框要拿焦點，這裡不能搶回來
  if (typeof document === "undefined" || !back?.isConnected) return;
  const ae = document.activeElement;
  if (!ae || ae === document.body || hostEl?.contains(ae)) back.focus({ preventScroll: true });
}

export function isContextMenuOpen(): boolean {
  return useMenuHost.getState().req !== null;
}

function ContextMenuHost() {
  const req = useMenuHost((s) => s.req);
  if (!req) return null;
  return <OpenMenu key={req.nonce} req={req} />;
}

function OpenMenu({ req }: { req: MenuRequest }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // 指令守門有變（guards.ts bump）→ 重算內容；靜態陣列就原樣用
  const tick = useCommandTick();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => resolve(req.source), [req, tick]);
  const anchor = useMemo(() => ({ x: req.x, y: req.y }), [req]);

  useLayoutEffect(() => {
    wrapRef.current?.querySelector<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true });
  }, []);

  // 內容重算後變空（例如右鍵的那條追蹤被刪了）：關掉，不留空框
  useEffect(() => {
    if (!hasContent(items)) closeContextMenu();
  }, [items]);

  // 切到別的視窗（Alt+Tab、原生存檔對話框）：原生選單也會收起
  useEffect(() => {
    window.addEventListener("blur", closeContextMenu);
    return () => window.removeEventListener("blur", closeContextMenu);
  }, []);

  return (
    <div ref={wrapRef} onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()} data-testid="context-menu">
      <MenuPanel items={items} anchor={anchor} onClose={closeContextMenu} minWidthClass="min-w-[220px] max-w-[420px]" />
    </div>
  );
}
