import { createRequire } from "node:module";

/**
 * package.json 相当のオブジェクトから version を取り出す。
 *
 * ファイル読み込みを含めないことで、欠落・空文字・型違いといった境界値を
 * テストで固定できるようにしている。
 */
export function extractVersion(pkg: unknown): string {
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    throw new Error("package.json の内容がオブジェクトではありません");
  }

  const { version } = pkg as { version?: unknown };
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json に version が定義されていません");
  }

  return version;
}

/**
 * 同梱の package.json から version を読む。
 *
 * `src/` から実行した場合も `dist/` から実行した場合も、どちらもパッケージ
 * ルートの直下1階層に位置するため、相対パスは同じ `../package.json` になる。
 */
export function readVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg: unknown = require("../package.json");

  return extractVersion(pkg);
}
