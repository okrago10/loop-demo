import { describe, expect, it } from "vitest";

import { isUserCaused } from "../../src/cli.js";
import { parseArgs } from "../../src/commands/args.js";
import type { CommandUsage } from "../../src/format/help.js";

/**
 * **宣言（`CommandUsage`）をそのまま解析の規則にする（#110）。**
 *
 * 以前は各コマンドが `takeOption` / `takeFlag` を手で並べ、その結果の `rest` を次へ渡し、
 * 最後に `rejectUnknownArgs` を呼んでいた。受け付ける範囲を決めていたのはその並びのほうで、
 * 宣言はそれと独立に書かれていた。**一致しているかは、12コマンド × 宣言されたオプション名を
 * 実際に CLI として起動して確かめるテスト2本で埋めていた**（`help.test.ts`）。
 *
 * 宣言が入力になったので、その2本が見ていた食い違いは起こらない。代わりに、境界を
 * **コマンドを起動せずに**ここで見る。
 */

/** 値を取るオプション・フラグ・位置引数をすべて持つ宣言。 */
const USAGE: CommandUsage = {
  positional: "[作業名]",
  options: [
    { name: "--at", argument: "HH:MM", summary: "時刻" },
    { name: "--note", argument: "テキスト", summary: "メモ" },
    { name: "--auto", summary: "自動で打ち切る" },
  ],
};

/** 位置引数を取らない宣言。 */
const NO_POSITIONAL: CommandUsage = {
  options: [
    { name: "--limit", argument: "件数", summary: "件数" },
    { name: "--short", summary: "1行で出す" },
  ],
};

function parse(argv: readonly string[], usage: CommandUsage = USAGE) {
  return parseArgs(argv, { name: "test", usage });
}

/** 投げられた例外そのものを取り出す。型を見るには値が要る（関数を渡すと必ず素通りする）。 */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error("例外が投げられませんでした");
}

describe("宣言に従って読む（DoD）", () => {
  it("値を取るオプションの値を読める", () => {
    expect(parse(["--at", "09:30"]).option("--at")).toBe("09:30");
  });

  it("省略されたオプションは undefined", () => {
    expect(parse([]).option("--at")).toBeUndefined();
  });

  it("フラグの有無を読める", () => {
    expect(parse(["--auto"]).flag("--auto")).toBe(true);
    expect(parse([]).flag("--auto")).toBe(false);
  });

  it("残りは位置引数になる（順序を保つ）", () => {
    expect(parse(["設計", "--at", "09:30", "レビュー"]).positional).toEqual(["設計", "レビュー"]);
  });

  it("オプションの値は位置引数に混ざらない", () => {
    expect(parse(["--note", "設計", "会議"]).positional).toEqual(["会議"]);
  });

  it("引数が空なら、すべて未指定（境界）", () => {
    const args = parse([]);

    expect(args.option("--at")).toBeUndefined();
    expect(args.flag("--auto")).toBe(false);
    expect(args.positional).toEqual([]);
  });
});

describe("値の扱い（境界）", () => {
  it("値が続いていなければ打ち間違いとして弾く", () => {
    expect(() => parse(["--at"])).toThrow(/--at には値が必要です/);
    expect(isUserCaused(thrownBy(() => parse(["--at"])))).toBe(true);
  });

  it("**次が `--` 始まりなら「値が無い」とみなす**（値が黙って別のオプション名にならない）", () => {
    expect(() => parse(["--note", "--at", "10:00"])).toThrow(/--note には値が必要です/);
    expect(() => parse(["--note", "--at", "10:00"])).toThrow(/--at が続いています/);
  });

  it('`-` 始まりの値は通る（`--note "-5分の中断あり"`）', () => {
    expect(parse(["--note", "-5分の中断あり"]).option("--note")).toBe("-5分の中断あり");
  });

  it("負の数も値として通る（`--offset -1` の形）", () => {
    expect(parse(["--limit", "-1"], NO_POSITIONAL).option("--limit")).toBe("-1");
  });

  it("空文字も値として受け取る（値の妥当性は読む側が決める）", () => {
    expect(parse(["--note", ""]).option("--note")).toBe("");
  });
});

describe("重なり（境界）", () => {
  it("同じフラグを複数回書いても有効（打ち間違いだが意図は明らか）", () => {
    expect(parse(["--auto", "--auto"]).flag("--auto")).toBe(true);
  });

  it("**同じ値付きオプションの2回目は弾く**（どちらが効くのかを決める理由がない）", () => {
    expect(() => parse(["--at", "09:30", "--at", "10:00"])).toThrow(/解釈できない引数です/);
  });
});

describe("解釈できない引数（DoD）", () => {
  it("宣言にない `--` 始まりのトークンを弾く", () => {
    expect(() => parse(["--unknown"])).toThrow(/解釈できない引数です: --unknown/);
  });

  it("位置引数を取らないコマンドでは、余ったトークンをすべて弾く", () => {
    expect(() => parse(["設計"], NO_POSITIONAL)).toThrow(/解釈できない引数です: 設計/);
  });

  it("**位置引数を取るコマンドでは、`--` 始まりでないトークンは弾かない**", () => {
    expect(parse(["設計 -- 前半"]).positional).toEqual(["設計 -- 前半"]);
  });

  it("エラーには使い方をそのまま添える", () => {
    expect(() => parse(["--unknown"])).toThrow(/使い方:/);
    expect(() => parse(["--unknown"])).toThrow(/--at HH:MM/);
  });

  it("打ち間違いは利用者起因として扱う（終了コード 1 になる）", () => {
    expect(isUserCaused(thrownBy(() => parse(["--unknown"])))).toBe(true);
  });
});

describe("読む側と宣言のずれは内部エラー（DoD）", () => {
  it("**宣言にない名前を読むと落ちる**（打ち間違いではないので利用者起因にしない）", () => {
    expect(() => parse([]).option("--nope")).toThrow(/--nope を宣言していません/);
    expect(isUserCaused(thrownBy(() => parse([]).option("--nope")))).toBe(false);
  });

  it("フラグを値付きとして読むと落ちる", () => {
    expect(() => parse([]).option("--auto")).toThrow(/--auto は値を取りません/);
  });

  it("値付きをフラグとして読むと落ちる", () => {
    expect(() => parse([]).flag("--at")).toThrow(/--at は値を取ります/);
  });
});
