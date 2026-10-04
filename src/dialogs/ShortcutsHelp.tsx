import { Keyboard } from "lucide-react";
import { commandLabel, groupLabel, shortcutHelpGroups } from "../commands/menuModel";
import { commandsWithShortcuts, useCommandTick } from "../commands/registry";
import { formatShortcut } from "../commands/shortcut";
import type { CommandGroup } from "../commands/types";
import { Button, Modal } from "../ui/index";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";

/**
 * 沒有登記成指令、由手寫程式或滑鼠手勢處理的那幾條。
 * 其餘全部從指令註冊表產生 —— ai-music-cut 這張表原本是手抄的，漏了好幾條。
 * 這個檔在 check-i18n.mjs 的 TABLE_SOURCES 裡：每一句都要進 locales/en.ts。
 */
const MANUAL_ROWS: [string, string][] = [
  ["J / L", "轉盤：倒退 / 前進，連按加速 1x → 2x → 4x（J 與 L 互相抵銷；Space 停）"],
  // 慢速轉盤要單獨一列：以前 Shift+L 被 Point Lock 佔走（M1 驗收 L6），說明裡也沒寫，知道的人只剩讀過程式的
  ["Shift+J / Shift+L", "慢速轉盤：0.5x 倒退 / 前進（看清楚一幀一幀的變化）"],
  ["Alt+方向鍵", "微調參考點 1 px（Alt+Shift：0.1 px）；沒有參考點時平移這一幀的表面"],
  ["\\（按住）", "A/B 閃爍：按住看原片、放開看替換結果"],
  ["Ctrl+滾輪 / 滾輪", "時間軸以游標為中心縮放 / 放大後水平捲動"],
  ["拖表面四角", "在這一幀釘一個使用者關鍵幀（硬釘）；拖曳中游標旁有 4× 放大鏡"],
  ["點時間軸菱形", "選取關鍵幀並跳到那一幀；Delete 刪除"],
  // 範圍選取的滑鼠行為（frametimeline/rangeDrag.ts）：沒有對應指令，快捷鍵表產生不出來
  ["拖範圍列", "空白處拉出新範圍；拖兩端調整、拖中間整段平移；按住 Alt 不吸附，Esc 取消"],
  ["Shift+拖曳時間軸", "在時間軸任何地方拉出範圍（不移動播放線、不換選取）"],
  ["Shift+點時間軸", "把比較近的入點 / 出點移到這裡"],
  ["雙擊範圍列", "範圍上：縮放到範圍；空白處：整段設為範圍"],
  ["右鍵", "時間軸、舞台、媒體清單、側欄清單各有自己的右鍵選單；時間軸上按右鍵不會移動播放線"],
  ["點狀態列的 fps", "開媒體資訊（Ctrl+I）"],
];

/**
 * 序列剪輯（預覽）開著才顯示的說明列（docs/editor-m2-design.md §10.1、§10.2）。
 * Delete / Shift+Delete 依焦點派發是「同一顆鍵做不同事」，只看指令表那一列看不出規則；S 與 B 都是「切」，一定要寫清楚哪個會影響輸出。
 */
const SEQUENCE_ROWS: [string, string][] = [
  ["Delete / Backspace", "依最後點到的東西：片段 → 波紋刪除（後面接上）；範圍 → 提取範圍；關鍵幀 → 移除關鍵幀"],
  ["Shift+Delete", "依最後點到的東西：片段 → 刪除留空隙；範圍 → 移除範圍留空隙；追蹤車道或關鍵幀 → 刪除追蹤"],
  ["S 與 B", "S 是切鏡頭（給追蹤用，不影響輸出）；B 是分割片段（剪輯，會改變輸出）"],
  ["B（素材時間軸）", "素材時間軸上 B 仍是分割字幕"],
  ["↑ / ↓", "序列時間軸：上 / 下一個剪輯點；素材時間軸：上 / 下一個鏡頭"],
];

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const t = useT();
  useCommandTick();
  const sequenceOn = useSettings((s) => s.experimental.sequence);
  const byGroup = new Map<CommandGroup, ReturnType<typeof commandsWithShortcuts>>();
  for (const c of commandsWithShortcuts()) {
    // shortcutManual = 鍵不是這個指令自己派發的：J/L、Alt+方向鍵、\ 由 MANUAL_ROWS 講；
    // Delete / B / ↑↓ 的原主人（移除關鍵幀、分割字幕、上一個鏡頭…）交給派發指令，派發指令那一列已經列出同一顆鍵，再列一次只會讓人以為撞鍵
    if (c.shortcutManual) continue;
    const arr = byGroup.get(c.group) ?? [];
    arr.push(c);
    byGroup.set(c.group, arr);
  }
  return (
    <Modal open onClose={onClose} title={t("快捷鍵")} icon={Keyboard} size="md" footer={<Button variant="primary" onClick={onClose}>{t("關閉")}</Button>}>
      <div className="text-[11px] text-fg/45 mb-3">{t("找不到功能在哪？按 Ctrl+K 直接搜。")}</div>
      <table className="w-full text-sm">
        <tbody>
          {shortcutHelpGroups().map((g) => {
            const cmds = byGroup.get(g);
            if (!cmds?.length) return null;
            return [
              <tr key={`g-${g}`}>
                <td colSpan={2} className="pt-3 pb-1 text-[10px] uppercase tracking-wide text-fg/35">
                  {t(groupLabel(g))}
                </td>
              </tr>,
              ...cmds.map((c) => (
                <tr key={c.id} className="border-b border-fg/5">
                  <td className="py-1.5 pr-3 mono text-fg/80 whitespace-nowrap">{(c.shortcuts ?? []).map(formatShortcut).join(" / ")}</td>
                  <td className="py-1.5 text-fg/60">{commandLabel(c)}</td>
                </tr>
              )),
            ];
          })}
          {sequenceOn && [
            <tr key="g-sequence">
              <td colSpan={2} className="pt-3 pb-1 text-[10px] uppercase tracking-wide text-fg/35">
                {t("序列剪輯（預覽）")}
              </td>
            </tr>,
            ...SEQUENCE_ROWS.map(([k, v]) => (
              <tr key={`seq-${k}`} className="border-b border-fg/5">
                <td className="py-1.5 pr-3 mono text-fg/80 whitespace-nowrap">{t(k)}</td>
                <td className="py-1.5 text-fg/60">{t(v)}</td>
              </tr>
            )),
          ]}
          <tr>
            <td colSpan={2} className="pt-3 pb-1 text-[10px] uppercase tracking-wide text-fg/35">
              {t("滑鼠與手勢")}
            </td>
          </tr>
          {MANUAL_ROWS.map(([k, v]) => (
            <tr key={k} className="border-b border-fg/5">
              {/* 左欄也要翻：「Alt+方向鍵」「拖表面四角」這些本身就是中文說明，英文介面以前會直接冒中文 */}
              <td className="py-1.5 pr-3 mono text-fg/80 whitespace-nowrap">{t(k)}</td>
              <td className="py-1.5 text-fg/60">{t(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
