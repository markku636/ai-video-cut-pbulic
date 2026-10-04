// UI 冒煙掃描（App 模式）：把每個對話框與每個檢視器分頁都開一次，看有沒有崩潰、空白或 React 警告。
//
// 這支跟同目錄其他腳本不同 —— 它不量常數，它問的是「打開來會不會壞」。放在這裡是因為
// 它同樣只有在跑起來的 App 裡才答得出來：對話框是 lazy import 的，型別檢查與單元測試都碰不到
// 它們的實際渲染。
//
// 2026-09-19 第一次跑就抓到：命令面板每次開都噴一串「two children with the same key」——
// 有子項的指令（工作模式、畫面比例參考線）的子項同時也註冊成頂層指令，面板展開後同一個 id 進來兩次。
//
// 用法（先照 README.md 開 App）：
//   node scripts/measure/ui-sweep.mjs [--port 9222]
//
// 回報三種狀況，任何一種都非零退出：
//   ⚠ 崩潰 / console.error（含 React 警告）
//   ⚠ 開了卻沒有東西（沒有 modal，或字數少到不可能是正常畫面）
//   ⚠ 畫面上出現 undefined / NaN / [object Object] / 沒代換掉的 {vars}
//     —— 使用者看得到的文字最常見的破綻。要帶參數的對話框一定要把參數補上（見 PROPS），
//     否則它們渲染成空的，這個檢查就掃不到它們。
import { connect, sleep, waitReady } from "./cdp.mjs";

const args = process.argv.slice(2);
const port = Number((args.indexOf("--port") >= 0 && args[args.indexOf("--port") + 1]) || 9222);

/** store/dialogs.ts 的 DialogId。 */
const DIALOGS = [
  "settings", "about", "shortcuts", "palette", "engineSetup", "export", "exportTrackData",
  "vdExport", "deckImport", "newTrack", "trackOptions", "insertOptions", "mediaInfo",
  "sequenceSettings", "removeSilence", "removeFillers", "removeObject", "blurBackground", "reframeVideo",
];

/**
 * 要帶參數才開得起來的對話框。**一定要把參數補上**，不然它們只會渲染成空的，
 * 而「畫面上有沒有 undefined」那個檢查就掃不到它們 —— 那正是最容易出破綻的地方
 *（`t("在第 {frame} 幀", { frame })` 的 frame 沒傳就會印出字面的 undefined）。
 * 回 null = 這次的素材給不出參數（例如沒有任何追蹤），跳過。
 */
const PROPS = {
  newTrack: () => ({ frame: 0 }),
  trackOptions: (trackId) => (trackId ? { trackId } : null),
  insertOptions: (trackId) => (trackId ? { trackId } : null),
};

/** inspector/tabs.ts 的分頁（核心 + 外掛的）。 */
const TABS = ["cards", "track", "mask", "captions", "clip", "jobs", "history", "advice", "assistant"];

/**
 * 外掛（plugins/cards）帶來的對話框與分頁：沒裝外掛的 App 裡根本不存在，開不起來不算壞，跳過。
 * 外掛在不在看開發橋接：cards 外掛會在 window.__aivc 多掛 cardEdits。
 */
const CARDS_ONLY = new Set(["vdExport", "deckImport", "cards"]);

/** 面板至少要有這麼多字，否則當成「開了卻是空的」。空狀態本身也有一兩句話，所以門檻拉到 20。 */
const MIN_CHARS = 20;

/** 使用者不該看到的字樣。`{xxx}` 是沒代換掉的 t() 變數。 */
const JUNK = String.raw`undefined|NaN|\[object Object\]|\{[a-zA-Z]+\}`;

const c = await connect(port);
await waitReady(c);

// React 的錯誤邊界與 key 警告都走 console.error
await c.ev(`
  window.__sweep = window.__sweep || [];
  if (!window.__sweepHooked) {
    window.__sweepHooked = 1;
    const o = console.error;
    console.error = function () { window.__sweep.push(Array.from(arguments).map(String).join(" ").slice(0, 160)); o.apply(console, arguments); };
  }
  1`);

let bad = 0;
const since = async (n) => ((await c.ev(`window.__sweep.length`)) > n ? c.ev(`JSON.stringify(Array.from(new Set(window.__sweep.slice(${n}))))`) : null);
const note = (info, errs) =>
  `${info.junk ? `  ⚠ 畫面上有「${info.junk}」` : ""}${errs ? `  ⚠ ${errs}` : ""}`;

const hasCards = await c.ev(`!!window.__aivc.cardEdits`);
const available = (id) => hasCards || !CARDS_ONLY.has(id);

console.log("=== 對話框 ===");
await c.ev(`window.__aivc.settings.getState().setExperimental({ sequence: true }); 1`);
const trackId = await c.ev(`(function () {
  const mid = window.__aivc.project.getState().activeMediaId;
  return (window.__aivc.edits.getState().tracks[mid] ?? [])[0]?.id ?? null;
})()`);

for (const d of DIALOGS) {
  if (!available(d)) {
    console.log(` ${d.padEnd(18)} 跳過（沒有 cards 外掛）`);
    continue;
  }
  await c.ev(`window.__aivc.dialogs.getState().closeAll(); 1`);
  await sleep(120);
  const props = PROPS[d] ? PROPS[d](trackId) : {};
  if (props === null) {
    console.log(` ${d.padEnd(18)} 跳過（這支素材沒有追蹤，開不起來）`);
    continue;
  }
  const n0 = await c.ev(`window.__sweep.length`);
  await c.ev(`try { window.__aivc.dialogs.getState().open(${JSON.stringify(d)}, ${JSON.stringify(props)}); } catch (e) { window.__sweep.push("open threw: " + e.message); } 1`);
  await sleep(450);
  const info = await c.ev(`(function () {
    const modal = document.querySelector("[role=dialog]") || Array.from(document.querySelectorAll("div")).find(function (e) { return String(e.className || "").includes("z-50") && e.querySelector("button"); });
    const txt = modal ? modal.textContent.replace(/\\s+/g, " ").trim() : "";
    const junk = txt.match(/${JUNK}/);
    return { hasModal: !!modal, chars: txt.length, junk: junk ? junk[0] : null };
  })()`);
  const errs = await since(n0);
  if (errs || !info.hasModal || info.chars < MIN_CHARS || info.junk) bad++;
  console.log(` ${d.padEnd(18)} ${info.hasModal ? `${info.chars} 字` : "沒有 modal"}${note(info, errs)}`);
}
await c.ev(`window.__aivc.dialogs.getState().closeAll(); 1`);

console.log("=== 檢視器分頁 ===");
await c.ev(`window.__aivc.ui.getState().setRailOpen(true); 1`);
for (const tab of TABS) {
  if (!available(tab)) {
    console.log(` ${tab.padEnd(12)} 跳過（沒有 cards 外掛）`);
    continue;
  }
  const n0 = await c.ev(`window.__sweep.length`);
  await c.ev(`window.__aivc.ui.getState().setTab(${JSON.stringify(tab)}); 1`);
  await sleep(400);
  const info = await c.ev(`(function () {
    const txt = (document.querySelector("[data-testid=inspector]")?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const junk = txt.match(/${JUNK}/);
    return { chars: txt.length, junk: junk ? junk[0] : null };
  })()`);
  const errs = await since(n0);
  if (errs || info.chars < MIN_CHARS || info.junk) bad++;
  console.log(` ${tab.padEnd(12)} ${info.chars} 字${note(info, errs)}`);
}

c.close();
console.log(bad ? `\n${bad} 項有問題` : "\n全部正常");
process.exit(bad ? 1 : 0);
