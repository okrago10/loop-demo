#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readVersion } from './version.js';

/**
 * CLI が外の世界に触る部分。テストから差し替えられるよう引数で受け取る。
 */
export interface CliDeps {
  /** 1行を出力する。改行の付与は呼び出し側の責務にしない。 */
  readonly out: (line: string) => void;
  /** 自身のバージョンを返す。 */
  readonly version: () => string;
}

/**
 * CLI の雛形。現時点では `--version` のみを扱う。
 *
 * 本格的な引数パース・ヘルプ・終了コードの体系は #12 で入れるため、
 * ここでは意図的に最小限に留めている。
 */
export function run(argv: readonly string[], deps: CliDeps): number {
  if (argv.includes('--version') || argv.includes('-v')) {
    deps.out(deps.version());
    return 0;
  }

  deps.out('tock — 作業時間トラッカー');
  return 0;
}

/**
 * このファイルがプロセスのエントリポイントとして起動されたかを判定する。
 *
 * `npx tock` はシンボリックリンク経由で起動されるため、実体のパスに解決してから
 * 比較する。テストから import した場合は false になり、副作用が走らない。
 */
function invokedAsEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsEntryPoint()) {
  process.exitCode = run(process.argv.slice(2), {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    version: readVersion,
  });
}
