import { collect } from "../plugins/registry";
import type { Translate } from "../store/engine";

/**
 * 使用的離線模型與元件（使用者要求 2026-09-19：「有用到的離線模型都要顯示在這」「是不是還有用到 OpenCV」）。
 * 「關於」與「安裝／檢查引擎」共用同一份，順序＝管線順序；版本能從 pyenv 拿的就顯示。
 * 引擎沒用到的（例如 HF 快取裡別的專案留下的 OWLv2）不列。外掛自帶的素材／模型（plugins/api.ts offlineComponents）接在最後。
 */
export function offlineComponents(t: Translate, samVariant: string, torchVersion: string | null): { name: string; role: string }[] {
  return [
    { name: t("SAM 2.1 hiera-{v}（Meta，Apache-2.0）", { v: samVariant }), role: t("物件遮罩與手部遮擋，沿整個鏡頭雙向傳播") },
    { name: t("OpenCV 4.x（Apache-2.0）"), role: t("SIFT 特徵、USAC-MAGSAC 單應性、ECC 精修的平面追蹤；邊緣偵測、合成的影像運算") },
    { name: t("PyTorch {v}（BSD-3；CUDA 13）", { v: torchVersion ?? "—" }), role: t("SAM 2.1 推論") },
    { name: t("Transformers（Hugging Face，Apache-2.0）"), role: t("載入 SAM 2.1 權重與影片推論 session") },
    { name: t("faster-whisper／CTranslate2 ＋ Whisper 模型（MIT／Apache-2.0；選用）"), role: t("字幕的語音辨識，只在啟用字幕時下載") },
    { name: t("FFmpeg（LGPL；內建）"), role: t("解碼、代理、NVENC／VP9 編碼") },
    { name: t("NumPy、SciPy、PyAV（BSD）"), role: t("數值運算、幾何擬合、影片讀取") },
    ...collect((p) => p.offlineComponents).map((c) => ({ name: t(c.name), role: t(c.role) })),
  ];
}
