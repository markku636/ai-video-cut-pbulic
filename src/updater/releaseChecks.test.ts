// 發版腳本的小規則（scripts/lib/release-checks.mjs）：金鑰環境變數的分類（不能把私鑰印出來）、公開 repo 的守門、
// 預先發布版號在 wheel 檔名裡的寫法。
import { describe, expect, it } from "vitest";
import { APP_VERSION_RE, classifySigningKey, pep440Version, printableKeyPath, sameRepo, urlPointsAtRepo } from "../../scripts/lib/release-checks.mjs";

/** bytes → base64（測試跑在 node，但 tsconfig 沒有 node 型別：用 btoa）。 */
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/**
 * 假的 tauri 私鑰內容：形狀對（單行 base64、解開是 minisign 框），但不是任何真的金鑰。
 * 尾巴故意放高位元組，讓 base64 裡出現「/」與「+」—— 舊的「有斜線就是路徑」判斷會把這種內容當路徑，
 * 再在「檔案不存在」的訊息裡整串印出來。
 */
const FAKE_KEY = b64([...ascii("untrusted comment: rsign encrypted secret key\nRWRTY0Iy"), 0xff, 0xfe, 0xfb, 0xef, 0xbf, 0xfc, 0x3f, 0xff]);

describe("classifySigningKey：TAURI_SIGNING_PRIVATE_KEY 是內容還是路徑", () => {
  it("單行 base64 的金鑰內容一定認成內容（即使裡面有斜線、比 512 字短）", () => {
    expect(FAKE_KEY).toMatch(/[/+]/);
    expect(FAKE_KEY.length).toBeLessThan(512);
    expect(classifySigningKey(FAKE_KEY)).toEqual({ kind: "content" });
    expect(classifySigningKey(`  ${FAKE_KEY}\n`)).toEqual({ kind: "content" });
    expect(printableKeyPath(FAKE_KEY)).toBeNull();
  });

  it("直接貼上的兩行 minisign 框也是內容", () => {
    expect(classifySigningKey("untrusted comment: rsign encrypted secret key\nRWRTY0Iyabc")).toEqual({ kind: "content" });
    expect(classifySigningKey("untrusted comment: x")).toEqual({ kind: "content" });
  });

  it("路徑：Windows / POSIX 都認；只有 .key 結尾的才准印在錯誤訊息裡", () => {
    const win = "C:\\Users\\me\\.tauri\\ai-video-cut-updater.key";
    expect(classifySigningKey(win)).toEqual({ kind: "path", path: win });
    expect(printableKeyPath(win)).toBe(win);
    expect(classifySigningKey("/home/me/.tauri/updater.key")).toEqual({ kind: "path", path: "/home/me/.tauri/updater.key" });
    // 不是 .key 結尾：當路徑檢查，但訊息裡不印值
    expect(classifySigningKey("D:/keys/updater")).toEqual({ kind: "path", path: "D:/keys/updater" });
    expect(printableKeyPath("D:/keys/updater")).toBeNull();
  });

  it("空的 / 沒設", () => {
    expect(classifySigningKey("")).toEqual({ kind: "empty" });
    expect(classifySigningKey("   ")).toEqual({ kind: "empty" });
    expect(classifySigningKey(undefined)).toEqual({ kind: "empty" });
  });
});

describe("公開 repo 的守門（GitHub 的 owner/name 不分大小寫）", () => {
  const PUB = "markku636/ai-video-cut-pbulic";
  it("sameRepo", () => {
    expect(sameRepo("Markku636/AI-Video-Cut-Pbulic", PUB)).toBe(true);
    expect(sameRepo(" markku636/ai-video-cut-pbulic ", PUB)).toBe(true);
    expect(sameRepo("markku636/ai-video-cut-cards", PUB)).toBe(false);
    expect(sameRepo(null, PUB)).toBe(false);
  });
  it("urlPointsAtRepo：--base-url 指到公開 repo 的 Release 也要擋", () => {
    expect(urlPointsAtRepo("https://github.com/Markku636/AI-Video-Cut-Pbulic/releases/download/v0.0.8/", PUB)).toBe(true);
    expect(urlPointsAtRepo("https://WWW.GitHub.com/markku636/ai-video-cut-pbulic", PUB)).toBe(true);
    expect(urlPointsAtRepo("https://github.com/markku636/ai-video-cut-cards/releases/download/v1/", PUB)).toBe(false);
    expect(urlPointsAtRepo("https://updates.example.com/markku636/ai-video-cut-pbulic/", PUB)).toBe(false);
    expect(urlPointsAtRepo("not a url", PUB)).toBe(false);
  });
});

describe("版號：sync-version 准的格式、wheel 檔名的 PEP 440 寫法", () => {
  it("APP_VERSION_RE 只准 X.Y.Z 與 alpha / beta / rc 預先發布", () => {
    for (const ok of ["0.0.8", "1.2.3", "0.0.8-beta.1", "0.0.8-beta", "0.1.0-alpha.2", "1.0.0-rc.3"]) expect(APP_VERSION_RE.test(ok), ok).toBe(true);
    for (const bad of ["0.0.8-foo.1", "0.0.8-beta.x", "v0.0.8", "0.0", "0.0.8+build.1"]) expect(APP_VERSION_RE.test(bad), bad).toBe(false);
  });
  it("pep440Version：setuptools 怎麼寫 wheel 檔名，這裡就怎麼比（與 Rust pyenv::py_version 同一套）", () => {
    expect(pep440Version("0.0.8")).toBe("0.0.8");
    expect(pep440Version("0.0.8-beta.1")).toBe("0.0.8b1");
    expect(pep440Version("0.0.8-beta")).toBe("0.0.8b0");
    expect(pep440Version("0.1.0-alpha.2")).toBe("0.1.0a2");
    expect(pep440Version("1.0.0-rc.3")).toBe("1.0.0rc3");
    expect(pep440Version("0.0.8b1")).toBe("0.0.8b1");
    expect(pep440Version(pep440Version("0.0.8-beta.1"))).toBe("0.0.8b1");
  });
});
