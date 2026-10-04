/**
 * COCO 壓縮 RLE（pycocotools `counts` 字串）→ 位元遮罩 → RGBA → ImageBitmap（計畫 §5.4）。
 *
 * 解碼的純函式在這裡（可測），worker 包裝在 rle.worker.ts：一幀 1280×720 的遮罩解出來是 3.7 MB 的 RGBA，
 * 在主執行緒做會吃掉一格 rAF；丟到 worker 用 createImageBitmap 後 transfer 回來，主執行緒只剩 drawImage。
 *
 * 編碼規則（pycocotools rleToString）：每個 run length 用 6 bit 一組的變長編碼，每組加 48 寫成可印字元；
 * 第 3 個 run 起存的是與前前一個 run 的差值。**column-major**（Fortran order）：先走 y 再走 x，
 * 這是最常被弄反的一點 —— 弄反的遮罩看起來像被切成 720 條橫線。
 */

export interface Rle {
  /** [height, width] —— COCO 的順序是 h 先。 */
  size: [number, number];
  counts: string;
}

/** 壓縮字串 → run lengths（交替：先 0 的長度、再 1 的長度…）。 */
export function decodeCounts(s: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    let x = 0;
    let k = 0;
    let more = true;
    while (more) {
      const c = s.charCodeAt(i) - 48;
      x |= (c & 0x1f) << (5 * k);
      more = (c & 0x20) !== 0;
      i++;
      k++;
      if (!more && c & 0x10) x |= -1 << (5 * k);
    }
    if (out.length > 2) x += out[out.length - 2];
    out.push(x);
  }
  return out;
}

/** run lengths → 每像素 0/1（**row-major**，可直接當影像用）。 */
export function rleToMask(rle: Rle): Uint8Array {
  const [h, w] = rle.size;
  const mask = new Uint8Array(w * h);
  const runs = decodeCounts(rle.counts);
  let pos = 0;
  let val = 0;
  for (const n of runs) {
    if (val) {
      for (let j = 0; j < n && pos + j < w * h; j++) {
        const p = pos + j;
        // column-major 位置 p → (x = p / h, y = p % h) → row-major index
        const x = Math.floor(p / h);
        const y = p - x * h;
        mask[y * w + x] = 1;
      }
    }
    pos += n;
    val ^= 1;
  }
  return mask;
}

/**
 * 0/1 遮罩 → RGBA（給 ImageData / createImageBitmap）。顏色 0–255，alpha 給選中 / 未選中兩種。
 * 明確蓋在一個普通 ArrayBuffer 上：`ImageData` 只收 `Uint8ClampedArray<ArrayBuffer>`，
 * `new Uint8ClampedArray(n)` 的型別是 `<ArrayBufferLike>`（可能是 SharedArrayBuffer），會被 lib.dom 拒絕。
 */
export function maskToRgba(mask: Uint8Array, rgb: [number, number, number], alpha: number) {
  const out = new Uint8ClampedArray(new ArrayBuffer(mask.length * 4));
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = a;
  }
  return out;
}

/** 遮罩面積（像素數）；合成器的 vis = area(mask)/area(quad) 就用它。 */
export function maskArea(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

/** 測試 / fixture 用：row-major 0/1 → COCO counts（與 pycocotools 逐位元相同）。 */
export function encodeMask(mask: Uint8Array, w: number, h: number): Rle {
  const runs: number[] = [];
  let cur = 0;
  let n = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const v = mask[y * w + x];
      if (v === cur) n++;
      else {
        runs.push(n);
        cur = v;
        n = 1;
      }
    }
  }
  runs.push(n);
  let s = "";
  for (let i = 0; i < runs.length; i++) {
    let x = runs[i];
    if (i > 2) x -= runs[i - 2];
    let more = true;
    while (more) {
      let c = x & 0x1f;
      x >>= 5;
      more = c & 0x10 ? x !== -1 : x !== 0;
      if (more) c |= 0x20;
      s += String.fromCharCode(c + 48);
    }
  }
  return { size: [h, w], counts: s };
}
