#!/usr/bin/env node
// README 截圖：用 WebView2 的 CDP 驅動**真的 App**（dev build）擺出固定場景，逐張 Page.captureScreenshot 存成 PNG。
//
// 為什麼用真 App 而不是 Storybook／假資料：截圖裡的找物件結果、遮罩、特效預覽、平面替換都是引擎真的算出來的，
// README 宣稱的東西就是使用者打開範例會看到的東西；每次改 UI 重跑一次即可更新（不必手動截圖）。
//
// 用法（兩個終端機）：
//   1) 先開 App（debug build，開啟遠端除錯埠）。README 要呈現開源版（只有核心）→ 用截圖專用的 Vite 設定把外掛擋掉：
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
//        npm run tauri dev -- --config scripts/screenshots.tauri.json
//      （要拍外掛的場景就照平常 `npm run tauri dev`；外掛沒載入時外掛場景會自己略過。）
//   2) node scripts/make-screenshots.mjs --project D:\path\to\demo.aivc.json [--port 9222] [--out docs/screenshots] [--only start,find]
//
// --project：示範專案。start 在「沒有開檔」時擷取（最近開啟清單在記憶體裡換成只有這個專案，不寫回設定），
// 拍完 start 由腳本自己開這個專案，接著拍其餘場景。App 已經用 AIVC_DEV_OPEN 開了檔的話 start 會略過。
//
// 示範專案（README 用的那一份）：一支短片（有人臉、桌上的蛋糕與碗、牆上有字），專案裡要有
//   - 物件 track「人臉」：馬賽克（橢圓）              → privacy、find
//   - 物件 track「碗」：調色                          → objects（之外的狀態）
//   - 物件 track「蛋糕」：文字標籤（跟著物件走）      → objects
//   - 平面 track（牆面）：replace 一張圖（海報）       → replace
// 找物件那一幕會用 FIND_TEXT 真的跑一次 seg.find（GPU 上約 1–2 分鐘）。
//
// 場景（見 CORE_SCENES）：start／find／objects／privacy／replace。privacy 是在頁面裡用引擎的
// media.frame（原幀）＋ fx.preview（只套人臉那條 track 的特效）組成的前／後對照圖（蓋在 App 上一層再擷取）。
// 截圖固定 1600×1000、deviceScaleFactor 1（README 用 1600 寬、GitHub 會縮圖顯示），並在擷取後清掉 metrics override。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argOf("--port", "9222"));
const OUT = resolve(ROOT, argOf("--out", "docs/screenshots"));
const PROJECT = argOf("--project", "") ? resolve(argOf("--project", "")) : "";
const ONLY = argOf("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const WIDTH = 1600;
const HEIGHT = 1000;
/** 找物件那一幕打的字（英文比較準；結果的名稱照打的字）。 */
const FIND_TEXT = "face, cake, bowl, cap";

const log = (m) => console.log(`[screens] ${m}`);
const die = (m) => {
  console.error(`[screens] ${m}`);
  process.exit(1);
};

// ---------------------------------------------------------------- CDP（零依賴：Node ≥ 22 內建 WebSocket）
async function connect() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  } catch (e) {
    die(`連不到 CDP 127.0.0.1:${PORT}（App 要用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT} 啟動）：${e.message}`);
  }
  const page = targets.find((t) => t.type === "page" && /localhost:1420|tauri\.localhost/.test(t.url)) ?? targets.find((t) => t.type === "page");
  if (!page) die(`找不到 page target：${JSON.stringify(targets)}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`CDP ${method} 逾時`));
      }, 300000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) rej(new Error(`${method}: ${m.error.message}`));
        else res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** 在頁面裡跑一段 async 函式本體（可 await、可 return 可序列化的值）。 */
  const run = async (body) => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { const A = window.__aivc; ${body} })()`, awaitPromise: true, returnByValue: true, timeout: 290000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  return { ws, send, run };
}

async function waitFor(cdp, what, predicateBody, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cdp.run(predicateBody).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等不到：${what}`);
}

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 場景
// 每個場景：prepare（頁面內 JS）→ 等待條件 → 擷取。場景之間先關掉所有對話框、拿掉 privacy 的蓋版、回到一致的起點。
const COMMON_RESET = `
  A.dialogs.getState().closeAll();
  // 有人在跑的時候點了舞台（選取物件工具）：收掉選取工作階段、工具回到指標，不然物件分頁頂端會多一塊「選取新物件」
  if (A.timeline.getState().tool === "objSelect") await A.runCommand("object.cancelSelection", "bridge");
  if (A.timeline.getState().tool !== "select") A.timeline.getState().setTool("select");
  A.stage.getState().setViewMode("normal");
  if (!A.stage.getState().showGrid) A.stage.getState().toggle("showGrid");
  document.getElementById("aivc-shot-overlay")?.remove();
`;
// start 換掉的「最近開啟」放回去（只動記憶體；見 start 場景）
const RESTORE_RECENT = `
  if (window.__aivcShotRecent) {
    const keep = window.__aivcShotRecent;
    delete window.__aivcShotRecent;
    A.settings.setState((st) => ({ s: { ...st.s, recent_projects: keep } }));
  }
`;

const media = `const m = A.project.getState().media.find((x) => x.id === A.project.getState().activeMediaId); if (!m) throw new Error("沒有作用中的媒體（--project 沒開起來？）");`;
// 這支媒體的 track（物件與平面）；挑 track 的小工具
const tracks = `const tracksOf = () => A.edits.getState().tracks[m.id] ?? [];
  const fxOn = (t, type) => (t.effects ?? []).some((e) => e.enabled !== false && (!type || e.type === type));`;
// 物件分頁：暫停時疊遮罩的勾勾（關掉才看得清楚特效）。它是物件清單下面第一個 label 裡的 checkbox。
const maskOverlay = (on) => `{ const cb = document.querySelector('[data-testid="objects-panel"] label input[type="checkbox"]'); if (cb && cb.checked !== ${on}) cb.click(); }`;
// 把「效果」區第一個收起來的特效展開（看得到欄位）
const expandFirstEffect = `document.querySelector('[data-testid="effects-section"] button[aria-expanded="false"]')?.click();`;

const CORE_SCENES = [
  {
    name: "start",
    file: "start.png",
    note: "開始畫面（沒有開檔時）：四張通用卡片、拖放區、最近開啟",
    needsMedia: false,
    prepare: `${COMMON_RESET}
      const recent = ${JSON.stringify(PROJECT ? [PROJECT] : null)};
      // 只換記憶體裡的清單（不呼叫 save）：截圖不該露出開發機最近開過的檔。原本的清單先收起來，
      // 開專案之前（openProject）與收尾時放回去 —— 不然 openMedia 記「最近開啟」時會把換過的清單寫回使用者的設定
      if (recent) {
        window.__aivcShotRecent ??= A.settings.getState().s.recent_projects;
        A.settings.setState((st) => ({ s: { ...st.s, recent_projects: recent } }));
      }
      return A.project.getState().media.length === 0;`,
    ready: `return !!document.querySelector('[data-testid="start-screen"]');`,
  },
  {
    name: "find",
    file: "find.png",
    note: `找物件：「${FIND_TEXT}」→ 引擎 seg.find 的結果（縮圖、出現幀數、分數、編號疊色圖），重複的候選先勾掉`,
    needsMedia: true,
    prepare: `${COMMON_RESET} ${media}
      A.timeline.getState().selectTrack(null);
      A.playback.getState().seek(0);
      A.dialogs.getState().open("findObject", { text: ${JSON.stringify(FIND_TEXT)}, autoRun: true });
      return true;`,
    // seg.find 在 GPU 上要 1–2 分鐘；結果出來後把「cake 2」「bowl 2」這種重複候選勾掉（示範「勾掉不要的」）
    ready: `const rows = [...document.querySelectorAll('[data-testid="find-object-instances"] [data-instance]')];
      if (!rows.length || !document.querySelector('[data-testid="find-object-overlay"]')) return false;
      for (const r of rows) {
        const name = r.querySelector("span span")?.textContent ?? "";
        const box = r.querySelector('input[type="checkbox"]');
        if (/ \\d+$/.test(name) && box?.checked) box.click();
      }
      return true;`,
    readyTimeoutMs: 300000,
    waitMs: 2500,
  },
  {
    name: "objects",
    file: "objects.png",
    note: "物件分頁：選中「蛋糕」，效果區展開文字標籤的欄位，舞台是引擎算的特效預覽（標籤跟著物件走）",
    needsMedia: true,
    prepare: `${COMMON_RESET} ${media} ${tracks}
      const objs = tracksOf().filter((t) => t.kind === "object");
      const tr = objs.find((t) => fxOn(t, "text")) ?? objs.find((t) => fxOn(t)) ?? objs[0];
      if (!tr) throw new Error("示範專案沒有物件 track");
      A.ui.getState().setRailOpen(true);
      A.ui.getState().setTab("objects");
      A.timeline.getState().selectTrack(tr.id);
      A.playback.getState().seek(40);
      await new Promise((r) => setTimeout(r, 400));
      ${maskOverlay(false)}
      ${expandFirstEffect}
      return true;`,
    ready: `return A.playback.getState().frame === 40 && !!document.querySelector('[data-testid="effects-section"]');`,
    waitMs: 6000,
  },
  {
    name: "privacy",
    file: "privacy.png",
    note: "隱私打碼前／後：同一幀的原片與引擎 fx.preview（只套人臉 track 的馬賽克），裁成兩張直幅並排",
    needsMedia: true,
    prepare: `${COMMON_RESET} ${media} ${tracks}
      const objs = tracksOf().filter((t) => t.kind === "object");
      const tr = objs.find((t) => fxOn(t, "mosaic")) ?? objs.find((t) => fxOn(t, "blur"));
      if (!tr) throw new Error("示範專案沒有打碼（mosaic／blur）的物件 track");
      const inv = window.__TAURI__.core.invoke;
      const fileSrc = window.__TAURI__.core.convertFileSrc;
      const { dir } = await inv("media_cache_status", { fingerprint: m.id });
      const sep = dir.includes("\\\\") ? "\\\\" : "/";
      const at = (...p) => [dir.replace(/[\\\\/]+$/, ""), ...p].join(sep);
      const k = tr.referenceFrame ?? tr.range?.[0] ?? 0;
      const before = at("fx", "shot-privacy-before.png"), after = at("fx", "shot-privacy-after.png");
      const effects = (tr.effects ?? []).filter((e) => e.enabled !== false).map(({ id, enabled, ...rest }) => rest);
      await inv("engine_call", { op: "media.frame", args: { video: m.path, at: k, out: before }, timeoutMs: 120000 });
      await inv("engine_call", { op: "fx.preview", args: { video: m.path, masks: [at("tracks", tr.id, "masks.aivm")], effects: JSON.stringify(effects), frame: k, out: after, max_width: 0 }, timeoutMs: 120000 });
      const load = async (p) => createImageBitmap(await (await fetch(fileSrc(p) + "?v=" + Date.now(), { cache: "no-store" })).blob());
      const [a, b] = await Promise.all([load(before), load(after)]);
      // 打碼的位置＝兩張不一樣的像素：裁切以它的水平中心為準
      const diffBox = () => {
        const c = new OffscreenCanvas(a.width, a.height), g = c.getContext("2d");
        g.drawImage(a, 0, 0); const pa = g.getImageData(0, 0, a.width, a.height).data;
        g.drawImage(b, 0, 0); const pb = g.getImageData(0, 0, a.width, a.height).data;
        let x0 = a.width, x1 = -1;
        for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 24) { const x = (i / 4) % a.width; if (x < x0) x0 = x; if (x > x1) x1 = x; }
        return x1 < 0 ? a.width / 2 : (x0 + x1) / 2;
      };
      const W = ${WIDTH}, H = ${HEIGHT}, PAD = 28, GAP = 20;
      const pw = (W - 2 * PAD - GAP) / 2, ph = H - 2 * PAD;
      const ch = a.height, cw = Math.min(a.width, Math.round(ch * pw / ph));
      const cx = Math.max(0, Math.min(a.width - cw, Math.round(diffBox() - cw / 2)));
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const g = cv.getContext("2d");
      const css = getComputedStyle(document.body);
      g.fillStyle = css.backgroundColor || "#202129"; g.fillRect(0, 0, W, H);
      g.imageSmoothingQuality = "high";
      const font = css.fontFamily;
      [[a, "前"], [b, "後"]].forEach(([img, label], i) => {
        const x = PAD + i * (pw + GAP), y = PAD;
        g.save(); g.beginPath(); g.roundRect(x, y, pw, ph, 12); g.clip();
        g.drawImage(img, cx, 0, cw, ch, x, y, pw, ph); g.restore();
        g.font = "600 20px " + font;
        const tw = g.measureText(label).width;
        g.fillStyle = "rgba(20, 20, 28, 0.72)"; g.beginPath(); g.roundRect(x + 18, y + 18, tw + 28, 38, 19); g.fill();
        g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(label, x + 32, y + 18 + 19 + 1);
      });
      const ov = document.createElement("div");
      ov.id = "aivc-shot-overlay";
      ov.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000";
      cv.style.cssText = "display:block;width:" + W + "px;height:" + H + "px";
      ov.appendChild(cv); document.body.appendChild(ov);
      return true;`,
    waitMs: 800,
  },
  {
    name: "replace",
    file: "replace.png",
    note: "平面替換：牆面 track 換成一張海報，舞台是引擎合成的替換預覽；右側追蹤分頁的「替換」區",
    needsMedia: true,
    prepare: `${COMMON_RESET} ${media} ${tracks}
      const tr = tracksOf().find((t) => t.kind !== "object" && t.replace?.path);
      if (!tr) throw new Error("示範專案沒有帶 replace 的平面 track");
      A.ui.getState().setRailOpen(true);
      A.ui.getState().setTab("track");
      A.timeline.getState().selectTrack(tr.id);
      // 表面網格會畫在換上去的圖上面：關掉才看得清楚替換結果（下一幕的 COMMON_RESET 會打開回來）
      if (A.stage.getState().showGrid) A.stage.getState().toggle("showGrid");
      A.playback.getState().seek(60);
      await new Promise((r) => setTimeout(r, 400));
      document.querySelector('[data-testid="replace-section"]')?.scrollIntoView({ block: "center" });
      return true;`,
    ready: `return A.playback.getState().frame === 60 && !!document.querySelector('[data-testid="replace-section"]');`,
    waitMs: 6000,
  },
];

// 外掛的場景（plugins/<id>/scripts/screenshots.mjs 的 scenes()）：依 `after` 插在核心場景後面（找不到就接在最後）；
// 開源版沒有 plugins/ 就只有核心這幾幕。外掛的場景失敗（例如 App 是用截圖專用的設定開的、外掛沒載入）只略過、不中斷。
async function pluginScenes() {
  const dir = join(ROOT, "plugins");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir).sort()) {
    const file = join(dir, id, "scripts", "screenshots.mjs");
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    out.push(...mod.scenes({ COMMON_RESET, media }).map((s) => ({ ...s, plugin: id })));
  }
  return out;
}

const SCENES = [...CORE_SCENES];
for (const s of await pluginScenes()) {
  const i = SCENES.findIndex((x) => x.name === s.after);
  SCENES.splice(i >= 0 ? i + 1 : SCENES.length, 0, s);
}

// ---------------------------------------------------------------- main
const cdp = await connect();
await waitFor(cdp, "window.__aivc（dev build 才有）", "return !!A;", 120000);
mkdirSync(OUT, { recursive: true });
await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
const mediaCount = () => cdp.run("return A.project.getState().media.length;");
let hasMedia = (await mediaCount()) > 0;

/** start 拍完、還沒開檔：開 --project，等 proxy 能播、引擎就緒。 */
async function openProject() {
  if (!PROJECT) die("沒有開檔：用 --project <demo.aivc.json> 指定示範專案（或用 AIVC_DEV_OPEN 開 App）");
  if (!existsSync(PROJECT)) die(`找不到示範專案 ${PROJECT}`);
  log(`開示範專案 ${PROJECT}`);
  await cdp.run(`${RESTORE_RECENT} await A.actions.openMedia(${JSON.stringify(PROJECT)}); return true;`);
  await waitFor(cdp, "proxy 可播、引擎就緒", `const m = A.project.getState().media[0]; return !!m && m.proxyState === "ready" && A.engine.getState().state === "ready";`, 300000);
  hasMedia = true;
}

const wrote = [];
try {
  for (const s of SCENES) {
    if (ONLY.length && !ONLY.includes(s.name)) continue;
    if (s.name === "start" && hasMedia) {
      log(`略過 ${s.name}：已有開檔（start 要用沒有 AIVC_DEV_OPEN 的 App 擷取）`);
      continue;
    }
    if (s.needsMedia && !hasMedia) await openProject();
    log(`場景 ${s.name}：${s.note}`);
    try {
      await cdp.run(s.prepare);
      if (s.ready) await waitFor(cdp, `${s.name} ready`, s.ready, s.readyTimeoutMs ?? 30000);
    } catch (e) {
      if (!s.plugin) throw e;
      log(`略過 ${s.name}（外掛 ${s.plugin}）：${e.message.split("\n")[0]}`);
      continue;
    }
    await settle(s.waitMs ?? 1500);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const path = join(OUT, s.file);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    wrote.push(`${s.file} ${(Buffer.byteLength(shot.data, "base64") / 1024).toFixed(0)} KB`);
  }
} finally {
  await cdp.run(`${COMMON_RESET} ${RESTORE_RECENT} return true;`).catch(() => {});
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  cdp.ws.close();
}
log(`完成：${wrote.join("、") || "（沒有擷取任何場景）"} → ${OUT}`);
