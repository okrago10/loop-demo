/**
 * サブコマンドの使い方の整形。
 *
 * **オプションの一覧はここで組み立てず、`CommandUsage` から引く。** ヘルプと実装が
 * 二重管理になると、片方だけ更新されて「ヘルプに出ているのに受け取られない」
 * オプションが生まれる。`rejectUnknownArgs`（`commands/args.ts`）も同じ宣言から
 * 受け付ける範囲を決めるので、宣言が1つあれば両者は食い違わない。
 *
 * `-h` / `--help` はどのコマンドでも `cli.ts` が処理するため、各コマンドが宣言する
 * 必要はない。ここで一覧の末尾に足す。
 */

import { pad, widestWidth } from "./columns.js";

/** オプション1つ分の宣言。 */
export interface CommandOption {
  /** `--at` のように `--` 付きで書く。 */
  readonly name: string;
  /**
   * 値の書き方（`HH:MM` など）。値を取らないフラグでは省略する。
   *
   * 表示のためだけでなく、「値を取るかどうか」を読む側に伝える。
   */
  readonly argument?: string;
  /** 一覧に出す1行説明。 */
  readonly summary: string;
}

/** コマンド1つ分の使い方。 */
export interface CommandUsage {
  /**
   * コマンド名の後ろに続く位置引数の書き方（`[作業名]` / `<id>`）。
   *
   * **省略＝位置引数を取らない。** `rejectUnknownArgs` はこれを見て、余った
   * トークンを弾くかどうかを決める。
   */
  readonly positional?: string;
  readonly options: readonly CommandOption[];
  /** 実際に打てる例。空なら「例」の節を出さない。 */
  readonly examples?: readonly string[];
}

/** どのコマンドでも受け付けるヘルプのオプション。 */
const HELP_ENTRY = { label: "-h, --help", summary: "この使い方を表示する" };

/** 一覧と使い方の行に出す表記。値を取るものは `--at HH:MM` の形にする。 */
function optionLabel(option: CommandOption): string {
  return option.argument === undefined ? option.name : `${option.name} ${option.argument}`;
}

/**
 * 使い方の本体（使い方・オプション・例）を組み立てる。
 *
 * 打ち間違いのエラー（`rejectUnknownArgs`）からも使うので、見出し行を含めずに分けてある。
 */
export function formatUsageBlock(name: string, usage: CommandUsage): string[] {
  const invocation = [`tock ${name}`];
  if (usage.positional !== undefined) {
    invocation.push(usage.positional);
  }
  for (const option of usage.options) {
    invocation.push(`[${optionLabel(option)}]`);
  }

  const entries = [
    ...usage.options.map((option) => ({
      label: optionLabel(option),
      summary: option.summary,
    })),
    HELP_ENTRY,
  ];
  // 全角を2桁として数える。`--note テキスト` のように値の書き方が日本語だと、
  // 文字数で揃えると列が崩れる（`summary` / `log` と同じ数え方を使う）
  const width = widestWidth(entries.map((entry) => entry.label));

  const lines = ["使い方:", `  ${invocation.join(" ")}`, "", "オプション:"];
  for (const entry of entries) {
    lines.push(`  ${pad(entry.label, width)}  ${entry.summary}`);
  }

  const examples = usage.examples ?? [];
  if (examples.length > 0) {
    lines.push("", "例:");
    for (const example of examples) {
      lines.push(`  ${example}`);
    }
  }

  return lines;
}

/** `tock <command> --help` の出力。 */
export function formatCommandHelp(name: string, summary: string, usage: CommandUsage): string[] {
  return [`tock ${name} — ${summary}`, "", ...formatUsageBlock(name, usage)];
}
