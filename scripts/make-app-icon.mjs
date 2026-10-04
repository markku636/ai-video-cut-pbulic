#!/usr/bin/env node
// 產生 App 圖示：原創向量標誌 → src-tauri/app-icon.svg + app-icon.png（1024²）→ `tauri icon` 生成各平台 icons/
// （icon.png / icon.ico 多尺寸 / icon.icns / Square*.png / android / ios）。Windows NSIS 要真的 .ico，不能只有 PNG。
//
// 標誌：一格膠卷（上下兩排齒孔的深色畫面）裡有一個被「鎖定」的物件：圓形主體外面一圈虛線（＝分割遮罩），
// 四個角括號框住它（＝追蹤框），左下方一串漸淡的圓點是它走過的位置（＝跨幀追蹤），框的右上角一顆四芒星（＝AI 幫忙選）。
// 「在影片裡選一個東西、一路追著它」一句話畫成圖；不畫任何特定物件，因為要追的東西由使用者決定。
// 顏色全取自 src/themes.ts 的預設主題 amethyst：底 #9580FF→#3B2E7A（與 ai-music-cut 同家族）、
// 畫面 #22212C / #2F303B（= tauri.conf.json 視窗底色）、主體 #FF9580（danger 色當暖色主體）、遮罩與追蹤框 #80FFEA（maskPos / info）、
// 星芒 #FFFF80（trackUser / warning）。
// 不用 <text>：librsvg 在 CI 沒有我們的字型，全部用 path 畫。小尺寸（32×32）時只剩「深色畫面＋暖色圓點＋青色框角」，仍認得出來。
//
// 用法：node scripts/make-app-icon.mjs [--no-tauri]   （--no-tauri 只寫 svg/png，不跑 tauri icon）
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPng = join(root, "src-tauri", "app-icon.png");
const outSvg = join(root, "src-tauri", "app-icon.svg");
const iconsDir = join(root, "src-tauri", "icons");
const noTauri = process.argv.includes("--no-tauri");

const C = {
  bgA: "#9580FF",
  bgB: "#3B2E7A",
  frame: "#22212C",
  screen: "#2F303B",
  subject: "#FF9580",
  subjectDeep: "#D9604F",
  subjectLight: "#FFD3C7",
  track: "#80FFEA",
  spark: "#FFFF80",
  hole: "rgba(248,248,242,0.82)",
};

// 膠卷齒孔：畫面上下各一排 8 個
const holeW = 44;
const holeH = 38;
const holeX0 = 200;
const holePitch = (824 - holeX0 - holeW) / 7;
const holes = [258, 734]
  .flatMap((y) => Array.from({ length: 8 }, (_, i) => `<rect x="${(holeX0 + i * holePitch).toFixed(1)}" y="${y}" width="${holeW}" height="${holeH}" rx="9" fill="${C.hole}"/>`))
  .join("\n  ");

// 主體：圓心 (cx, cy)、半徑 r；遮罩虛線圈在主體外 ring；追蹤框是以圓心為中心、半邊長 box 的正方形，只畫四個角
const cx = 566;
const cy = 506;
const r = 104;
const ring = 128;
const box = 156;
const arm = 62;
const bracket = (sx, sy) => {
  const x = cx + sx * box;
  const y = cy + sy * box;
  return `<path d="M${x - sx * arm} ${y} L${x} ${y} L${x} ${y - sy * arm}" fill="none" stroke="${C.track}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`;
};
const brackets = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]
  .map(([sx, sy]) => bracket(sx, sy))
  .join("\n    ");

// 軌跡：從左下往主體靠近，越舊越小越淡
const trail = [
  [258, 664, 13, 0.32],
  [306, 630, 17, 0.5],
  [356, 598, 21, 0.7],
]
  .map(([x, y, rr, op]) => `<circle cx="${x}" cy="${y}" r="${rr}" fill="${C.track}" opacity="${op}"/>`)
  .join("\n    ");

// 四芒星：中心 (sx, sy)、長半徑 R、腰半徑 w
const sparkAt = (x, y, R, w) =>
  `<path d="M${x} ${y - R} Q${x + w * 0.35} ${y - w * 0.35} ${x + R} ${y} Q${x + w * 0.35} ${y + w * 0.35} ${x} ${y + R} ` +
  `Q${x - w * 0.35} ${y + w * 0.35} ${x - R} ${y} Q${x - w * 0.35} ${y - w * 0.35} ${x} ${y - R} Z" fill="${C.spark}"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bgA}"/>
      <stop offset="1" stop-color="${C.bgB}"/>
    </linearGradient>
    <radialGradient id="subject" cx="0.38" cy="0.34" r="0.75">
      <stop offset="0" stop-color="${C.subjectLight}"/>
      <stop offset="0.35" stop-color="${C.subject}"/>
      <stop offset="1" stop-color="${C.subjectDeep}"/>
    </radialGradient>
  </defs>
  <!-- 底：漸層圓角方塊（與 ai-music-cut 同家族） -->
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <!-- 膠卷框 + 齒孔 + 畫面 -->
  <rect x="152" y="216" width="720" height="592" rx="46" fill="${C.frame}"/>
  ${holes}
  <rect x="192" y="316" width="640" height="392" rx="18" fill="${C.screen}"/>
  <!-- 被追蹤的物件：軌跡、主體、遮罩虛線、追蹤框四角、AI 星芒 -->
  <g>
    ${trail}
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#subject)"/>
    <circle cx="${cx}" cy="${cy}" r="${ring}" fill="none" stroke="${C.track}" stroke-width="7" stroke-dasharray="22 16" stroke-linecap="round" opacity="0.9"/>
    ${brackets}
    ${sparkAt(cx + box + 8, cy - box - 8, 54, 18)}
  </g>
</svg>
`;

mkdirSync(dirname(outPng), { recursive: true });
writeFileSync(outSvg, svg);
const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(outPng, png);
console.log(`[app-icon] wrote ${outSvg} (${svg.length} bytes)`);
console.log(`[app-icon] wrote ${outPng} (${png.length} bytes, 1024x1024)`);

if (!noTauri) {
  // tauri icon：從一張 1024² PNG 生成 icons/ 全套（含 Windows 多尺寸 .ico 與 macOS .icns）。
  // shell:true：Node 22+ 直接 spawn npx.cmd 會 EINVAL；整句用單一字串（args 陣列 + shell 會被 DEP0190 警告），
  // 相對路徑 + cwd=root，避開 repo 路徑裡的空白。
  const r = spawnSync("npx tauri icon src-tauri/app-icon.png -o src-tauri/icons", { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`[app-icon] tauri icon 失敗（exit ${r.status}）`);
    process.exit(1);
  }
  for (const f of ["icon.png", "icon.ico", "icon.icns", "32x32.png", "128x128.png", "128x128@2x.png"]) {
    const p = join(iconsDir, f);
    const size = statSync(p).size;
    if (size === 0) {
      console.error(`[app-icon] ${p} 是空的`);
      process.exit(1);
    }
    console.log(`[app-icon] ${f} ${size} bytes`);
  }
}
