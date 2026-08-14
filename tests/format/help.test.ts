import { describe, expect, it } from "vitest";

import { displayWidth } from "../../src/format/columns.js";
import { type CommandUsage, formatCommandHelp, formatUsageBlock } from "../../src/format/help.js";

/** オプションの一覧の行だけを取り出す（見出しと空行を除く）。 */
function optionLines(lines: readonly string[]): string[] {
  const start = lines.indexOf("オプション:");

  return lines.slice(start + 1).filter((line) => line.startsWith("  -"));
}

describe("使い方の整形", () => {
  it("使い方とオプションの見出しを出す", () => {
    const lines = formatUsageBlock("today", { options: [] });

    expect(lines).toContain("使い方:");
    expect(lines).toContain("オプション:");
  });

  it("値を取るオプションは値の書き方を添える", () => {
    const usage: CommandUsage = {
      options: [{ name: "--at", argument: "HH:MM", summary: "開始時刻" }],
    };

    expect(formatUsageBlock("start", usage)).toContain("  tock start [--at HH:MM]");
  });

  it("値を取らないフラグは名前だけを出す", () => {
    const usage: CommandUsage = { options: [{ name: "--short", summary: "1行で出す" }] };

    expect(formatUsageBlock("status", usage)).toContain("  tock status [--short]");
  });

  it("位置引数があれば使い方の行に出す", () => {
    const usage: CommandUsage = { positional: "<id>", options: [] };

    expect(formatUsageBlock("rm", usage)).toContain("  tock rm <id>");
  });

  it("位置引数を宣言していなければ使い方の行に出さない", () => {
    expect(formatUsageBlock("today", { options: [] })).toContain("  tock today");
  });

  // どのコマンドでも cli.ts が処理するので、各コマンドは宣言しない
  it("オプションが1つも無くても -h, --help は一覧に出る（境界）", () => {
    const lines = formatUsageBlock("today", { options: [] });

    expect(optionLines(lines)).toEqual(["  -h, --help  この使い方を表示する"]);
  });

  it("例が無ければ「例」の節を出さない（境界）", () => {
    expect(formatUsageBlock("today", { options: [] }).join("\n")).not.toContain("例:");
  });

  it("例があれば列挙する", () => {
    const usage: CommandUsage = { options: [], examples: ["tock today"] };

    expect(formatUsageBlock("today", usage)).toContain("  tock today");
  });

  // `--note テキスト` のように値の書き方が日本語だと、文字数で揃えると列が崩れる
  it("全角を含むラベルでも説明の開始位置が揃う（境界）", () => {
    const usage: CommandUsage = {
      options: [
        { name: "--note", argument: "テキスト", summary: "作業名" },
        { name: "--start", argument: "HH:MM", summary: "開始時刻" },
      ],
    };

    const columns = optionLines(formatUsageBlock("edit", usage)).map((line) =>
      displayWidth(line.slice(0, line.lastIndexOf("  "))),
    );

    expect(new Set(columns).size).toBe(1);
  });

  it("ヘルプの先頭にコマンド名と1行説明を出す", () => {
    const [title] = formatCommandHelp("start", "作業を開始する", { options: [] });

    expect(title).toBe("tock start — 作業を開始する");
  });

  it("ヘルプは使い方の本体をそのまま含む（エラー表示と同じ内容）", () => {
    const usage: CommandUsage = { options: [{ name: "--at", argument: "HH:MM", summary: "時刻" }] };

    expect(formatCommandHelp("start", "作業を開始する", usage)).toEqual([
      "tock start — 作業を開始する",
      "",
      ...formatUsageBlock("start", usage),
    ]);
  });
});
