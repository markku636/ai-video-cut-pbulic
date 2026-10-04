// latest.json 產生器（scripts/lib/updater-manifest.mjs）：release-local.mjs 與 release.yml 的 publish-release 共用。
// 形狀要跟 tauri-plugin-updater 2.13 的 RemoteRelease 一致，否則已安裝的 App 永遠檢查不到新版。
import { describe, expect, it } from "vitest";
import { buildLatestJson, githubAssetName, isSignatureContent, missingPlatforms, platformKeysForAsset, releaseAssetUrl, rfc3339, signedVersion } from "../../scripts/lib/updater-manifest.mjs";

/**
 * 假的 .sig 內容：形狀對（base64 的 minisign 簽章框），但不是任何真的金鑰簽出來的。檔名都是 ASCII，btoa 夠用。
 * trusted comment 照 tauri-cli 2.12 的格式帶 version:（App 開了 requireSignedVersion）；`version` 給 null＝2.12 以前的舊簽章。
 */
const fakeSig = (file: string, version: string | null = "0.0.8") =>
  btoa(`untrusted comment: signature from tauri secret key\nRUSfakefakefake\ntrusted comment: timestamp:1790000000\tfile:${file}${version === null ? "" : `\tversion:${version}`}\nZmFrZQ==\n`);

const REPO = "markku636/ai-video-cut-pbulic";
const WIN = githubAssetName("AI Video Cut_0.0.8_x64-setup.exe");

describe("platformKeysForAsset：檔名 → updater 平台鍵", () => {
  it("Windows NSIS 同時給 -nsis 與通用鍵（外掛先找 {os}-{arch}-{bundle} 再找 {os}-{arch}）", () => {
    expect(platformKeysForAsset("AI.Video.Cut_0.0.8_x64-setup.exe")).toEqual(["windows-x86_64-nsis", "windows-x86_64"]);
  });
  it("macOS 要 .app.tar.gz（只出 dmg 就沒有更新檔）、Linux AppImage 是通用鍵、deb 只給 -deb", () => {
    expect(platformKeysForAsset("AI.Video.Cut_aarch64.app.tar.gz")).toEqual(["darwin-aarch64-app", "darwin-aarch64"]);
    expect(platformKeysForAsset("AI.Video.Cut_0.0.8_amd64.AppImage")).toEqual(["linux-x86_64-appimage", "linux-x86_64"]);
    expect(platformKeysForAsset("AI.Video.Cut_0.0.8_amd64.deb")).toEqual(["linux-x86_64-deb"]);
  });
  it("其他檔案（dmg、.sig、latest.json）不是更新檔", () => {
    for (const n of ["AI.Video.Cut_0.0.8_aarch64.dmg", "AI.Video.Cut_0.0.8_x64-setup.exe.sig", "latest.json", "README.txt"]) {
      expect(platformKeysForAsset(n), n).toEqual([]);
    }
  });
});

describe("buildLatestJson", () => {
  it("產生外掛吃得下的靜態格式：版本去掉 v、pub_date 是 RFC 3339、signature 是 .sig 的內容、url 是固定 tag 的下載網址", () => {
    const url = releaseAssetUrl(REPO, "v0.0.8", WIN);
    const json = buildLatestJson({ version: "v0.0.8", notes: "修好了很多東西", pubDate: new Date(Date.UTC(2026, 9, 3, 12, 0, 0, 456)), assets: [{ name: WIN, url, signature: `${fakeSig(WIN)}\n` }] });
    expect(json).toEqual({
      version: "0.0.8",
      notes: "修好了很多東西",
      pub_date: "2026-10-03T12:00:00Z",
      platforms: {
        "windows-x86_64-nsis": { signature: fakeSig(WIN), url },
        "windows-x86_64": { signature: fakeSig(WIN), url },
      },
    });
    expect(url).toBe("https://github.com/markku636/ai-video-cut-pbulic/releases/download/v0.0.8/AI.Video.Cut_0.0.8_x64-setup.exe");
    // 能被 JSON 來回（寫檔 / 上傳的就是這一份）
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("三個平台齊全的 latest.json（CI 的 publish-release 轉正前要驗這個）", () => {
    const names = ["AI.Video.Cut_0.0.8_x64-setup.exe", "AI.Video.Cut_aarch64.app.tar.gz", "AI.Video.Cut_0.0.8_amd64.AppImage", "AI.Video.Cut_0.0.8_amd64.deb"];
    const json = buildLatestJson({ version: "0.0.8", assets: names.map((name) => ({ name, url: releaseAssetUrl(REPO, "v0.0.8", name), signature: fakeSig(name) })) });
    expect(Object.keys(json.platforms).sort()).toEqual(
      ["darwin-aarch64", "darwin-aarch64-app", "linux-x86_64", "linux-x86_64-appimage", "linux-x86_64-deb", "windows-x86_64", "windows-x86_64-nsis"].sort(),
    );
    expect(missingPlatforms(json, ["windows-x86_64", "darwin-aarch64", "linux-x86_64"])).toEqual([]);
    expect(json.notes).toBe("");
  });

  it("只有 Windows（本機發版）：其他平台列為缺少 —— 那些平台檢查更新會得到「沒有這個平台的更新檔」", () => {
    const json = buildLatestJson({ version: "0.0.8", assets: [{ name: WIN, url: releaseAssetUrl(REPO, "v0.0.8", WIN), signature: fakeSig(WIN) }] });
    expect(missingPlatforms(json, ["windows-x86_64", "darwin-aarch64", "linux-x86_64"])).toEqual(["darwin-aarch64", "linux-x86_64"]);
    expect(missingPlatforms(null, ["windows-x86_64"])).toEqual(["windows-x86_64"]);
  });

  it("寧可不發，也不要發一份裝不起來的", () => {
    const ok = { name: WIN, url: releaseAssetUrl(REPO, "v0.0.8", WIN), signature: fakeSig(WIN) };
    expect(() => buildLatestJson({ version: "0.0.8", assets: [] })).toThrow(/沒有任何更新檔/);
    expect(() => buildLatestJson({ version: "latest", assets: [ok] })).toThrow(/semver/);
    expect(() => buildLatestJson({ version: "0.0.8", assets: [{ ...ok, signature: "D:/keys/AI Video Cut_0.0.8_x64-setup.exe.sig" }] })).toThrow(/簽章/);
    expect(() => buildLatestJson({ version: "0.0.8", assets: [{ ...ok, signature: "https://example.com/x.sig" }] })).toThrow(/簽章/);
    expect(() => buildLatestJson({ version: "0.0.8", assets: [{ ...ok, url: "http://example.com/x.exe" }] })).toThrow(/https/);
    expect(() => buildLatestJson({ version: "0.0.8", assets: [{ ...ok, name: "setup.zip" }] })).toThrow(/認不得/);
    expect(() => buildLatestJson({ version: "0.0.8", assets: [ok, ok] })).toThrow(/重複/);
    expect(() => buildLatestJson({ version: "0.0.8", pubDate: "not a date", assets: [ok] })).toThrow(/時間/);
    // 簽章要綁版本，而且要等於 latest.json 的版本（App 的 requireSignedVersion 會在下載完拒裝）
    expect(() => buildLatestJson({ version: "0.0.8", assets: [{ ...ok, signature: fakeSig(WIN, null) }] })).toThrow(/沒有綁版本/);
    expect(() => buildLatestJson({ version: "0.0.9", assets: [ok] })).toThrow(/0\.0\.8.*0\.0\.9/);
    expect(buildLatestJson({ version: "v0.0.8", assets: [ok] }).version).toBe("0.0.8");
    // 本機測試伺服器（docs/updater.md 的端到端測試）可以用 http://127.0.0.1
    expect(buildLatestJson({ version: "0.0.8", assets: [{ ...ok, url: "http://127.0.0.1:8000/AI.Video.Cut_0.0.8_x64-setup.exe" }] }).platforms["windows-x86_64"].url).toContain("127.0.0.1");
  });
});

describe("小工具", () => {
  it("githubAssetName：空白換成「.」（跟 GitHub 上傳時做的一樣）", () => {
    expect(githubAssetName("AI Video Cut_0.0.8_x64-setup.exe")).toBe("AI.Video.Cut_0.0.8_x64-setup.exe");
    expect(githubAssetName("AI Video Cut_0.0.8_x64-setup.exe.sig")).toBe("AI.Video.Cut_0.0.8_x64-setup.exe.sig");
  });
  it("releaseAssetUrl：repo 一定要是 owner/name", () => {
    expect(() => releaseAssetUrl("not a repo", "v1", "x")).toThrow(/owner\/name/);
    expect(releaseAssetUrl(REPO, "v0.0.8-beta.1", "a b.exe")).toBe("https://github.com/markku636/ai-video-cut-pbulic/releases/download/v0.0.8-beta.1/a%20b.exe");
  });
  it("rfc3339：秒精度、UTC 的 Z 結尾", () => {
    expect(rfc3339(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 999)))).toBe("2026-01-02T03:04:05Z");
    expect(rfc3339("2026-10-03T20:00:00+08:00")).toBe("2026-10-03T12:00:00Z");
  });
  it("signedVersion：讀 trusted comment 的 version: 欄位（不是 file: 裡長得像版號的字）", () => {
    expect(signedVersion(fakeSig(WIN))).toBe("0.0.8");
    expect(signedVersion(fakeSig(WIN, "0.0.8-beta.1"))).toBe("0.0.8-beta.1");
    expect(signedVersion(fakeSig("app-version:2.zip", null))).toBeNull();
    expect(signedVersion(fakeSig(WIN, null))).toBeNull();
    expect(signedVersion("C:\\keys\\x.sig")).toBeNull();
  });
  it("isSignatureContent：只認 .sig 檔的內容", () => {
    expect(isSignatureContent(fakeSig(WIN))).toBe(true);
    expect(isSignatureContent("")).toBe(false);
    expect(isSignatureContent(btoa("hello world"))).toBe(false);
    expect(isSignatureContent("C:\\keys\\x.sig")).toBe(false);
    expect(isSignatureContent(undefined)).toBe(false);
  });
});
