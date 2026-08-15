import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import type { LoadConfig, ResolvedConfig } from "../../src/store/config-store.js";

/**
 * テストから設定を渡すための道具（#64）。
 *
 * **既存のテストには実行環境のゾーンを渡す。** それらは `local()` のような壁時計ヘルパで
 * 期待値を組み立てており、実行環境のゾーンで解釈される前提で書かれている。同じゾーンを
 * 渡せば、タイムゾーン注入の前後で振る舞いが変わらないことをそのまま確かめられる。
 *
 * **ゾーンの切り替えを見るテストは、明示的なゾーン名を渡す。** そちらは
 * `tests/commands/timezone.test.ts` と `tests/domain/timezone.test.ts` にある。
 */

/** 実行環境のタイムゾーン。CI は UTC だが、手元では別のゾーンになる。 */
export const RUNTIME_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * 設定を読まない読み取り。**既定値 + 解決済みの `timezone`** を返す。
 *
 * `loadEffectiveConfig` を通さないので、ファイルにも環境変数にも触らない。
 */
export function testLoadConfig(overrides: Partial<ResolvedConfig> = {}): LoadConfig {
  return () =>
    Promise.resolve({
      config: { ...DEFAULT_CONFIG, timezone: RUNTIME_TZ, ...overrides },
      warnings: [],
    });
}

/** 指定したゾーンだけを差し替えた読み取り。 */
export function loadConfigIn(timeZone: string): LoadConfig {
  return testLoadConfig({ timezone: timeZone });
}
