// 對跑起來的 App 拍一張截圖（App 模式）。
//
// 為什麼要有這支：UI 的問題（跑版、看不見的功能、對比不夠）只有**看**得出來，
// 型別檢查與單元測試都答不了。ui-sweep.mjs 問的是「開了會不會壞」，這支問的是「長什麼樣」。
//
// 用法（先照 README.md 開 App）：
//   node scripts/measure/shot.mjs <輸出.png> [--port 9222] [--wait 1500]
//     [--eval "<在頁面裡先跑的 JS>"]   例如先建範圍、先開對話框
//     [--clip x,y,w,h]                  只截某一塊（量跑版時對著時間軸截比較清楚）
//
// `--eval` 跑在 `__aivc` 橋接可用之後（src/devBridge.ts，只在 DEV 掛）。
import { writeFileSync } from "node:fs";
import { connect, sleep, waitReady } from "./cdp.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const out = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
if (!out) {
  console.error("用法：node scripts/measure/shot.mjs <輸出.png> [--port 9222] [--wait 1500] [--eval JS] [--clip x,y,w,h]");
  process.exit(2);
}

const c = await connect(Number(flag("--port", 9222)));
await waitReady(c, { proxy: true });

const js = flag("--eval", null);
if (js) await c.ev(`(async () => { ${js} })()`);
await sleep(Number(flag("--wait", 1500)));

const clip = flag("--clip", null);
const params = { format: "png", captureBeyondViewport: false };
if (clip) {
  const [x, y, width, height] = clip.split(",").map(Number);
  params.clip = { x, y, width, height, scale: 1 };
}
const r = await c.send("Page.captureScreenshot", params);
writeFileSync(out, Buffer.from(r.data, "base64"));
console.log(`截圖 → ${out}`);
c.close();
