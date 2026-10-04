// scripts/lib/updater-manifest.mjs 的型別（src/updater/latestJson.test.ts 從 TS 測它；tsconfig 沒開 allowJs）。

export interface UpdaterAsset {
  /** 上傳後的檔名（決定平台）。 */
  name: string;
  url: string;
  /** .sig 檔的內容。 */
  signature: string;
}

export interface LatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

export function platformKeysForAsset(name: string): string[];
export function githubAssetName(fileName: string): string;
export function releaseAssetUrl(repo: string, tag: string, assetName: string): string;
export function rfc3339(date: Date | string | number): string;
export function isSignatureContent(sig: unknown): boolean;
export function signedVersion(sig: unknown): string | null;
export function buildLatestJson(input: { version: string; notes?: string; pubDate?: Date | string; assets: UpdaterAsset[] }): LatestJson;
export function missingPlatforms(manifest: unknown, required: string[]): string[];
