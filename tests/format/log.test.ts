import { describe, expect, it } from "vitest";

import type { LogRow } from "../../src/domain/log.js";
import { displayWidth } from "../../src/format/columns.js";
import { formatLogLines } from "../../src/format/log.js";
import { RUNTIME_TZ } from "../support/config.js";

/** このファイルは整形そのものを見るので、id を切らない桁数を渡す（短縮は #58 の別テスト）。 */
const LONG_ENOUGH = 100;

function local(day: number, hours: number, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

function row(
  entryId: string,
  start: Date,
  end: Date | undefined,
  options: { readonly tags?: readonly string[]; readonly note?: string } = {},
): LogRow {
  const durationMs = (end ?? local(13, 12)).getTime() - start.getTime();

  return {
    entryId,
    start,
    end,
    durationMs,
    tags: options.tags ?? [],
    ...(options.note === undefined ? {} : { note: options.note }),
  };
}

describe("formatLogLines", () => {
  it("該当0件のときは「該当なし」を1行出す（エラーにしない）", () => {
    expect(formatLogLines([], LONG_ENOUGH, RUNTIME_TZ)).toEqual(["該当する記録はありません"]);
  });

  it("各行に編集で使える ID が含まれている", () => {
    const lines = formatLogLines(
      [row("abc123", local(13, 9), local(13, 10), { note: "設計" })],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("abc123");
  });

  it("行に日付・開始・終了・長さ・作業名・タグがすべて出る", () => {
    const lines = formatLogLines(
      [row("abc123", local(13, 9), local(13, 10, 30), { tags: ["work"], note: "設計" })],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    const line = lines[0] ?? "";

    expect(line).toContain("2026-08-13");
    expect(line).toContain("09:00");
    expect(line).toContain("10:30");
    expect(line).toContain("1h 30m");
    expect(line).toContain("設計");
    expect(line).toContain("#work");
  });

  it("複数のタグを並べる", () => {
    const lines = formatLogLines(
      [row("a", local(13, 9), local(13, 10), { tags: ["work", "proj/loop-demo"] })],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    expect(lines[0]).toContain("#work");
    expect(lines[0]).toContain("#proj/loop-demo");
  });

  it("実行中の記録は終了時刻の代わりに「実行中」と出す", () => {
    const lines = formatLogLines(
      [row("a", local(13, 11), undefined, { note: "レビュー" })],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    expect(lines[0]).toContain("実行中");
    expect(lines[0]).toContain("11:00");
  });

  it("作業名が無くても行が壊れない（境界）", () => {
    const lines = formatLogLines(
      [row("a", local(13, 9), local(13, 10), { tags: ["work"] })],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    expect(lines[0]).toContain("#work");
    expect(lines[0]).not.toContain("undefined");
  });

  it("タグも作業名も無くても行が壊れない（境界）", () => {
    const lines = formatLogLines([row("a", local(13, 9), local(13, 10))], LONG_ENOUGH, RUNTIME_TZ);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("a");
    expect(lines[0]).not.toContain("undefined");
  });

  it("長さ 0 の記録も 0s として1行出す（境界）", () => {
    const lines = formatLogLines([row("a", local(13, 9), local(13, 9))], LONG_ENOUGH, RUNTIME_TZ);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0s");
  });

  it("1件につき1行だけ出す", () => {
    const lines = formatLogLines(
      [
        row("a", local(13, 9), local(13, 10)),
        row("b", local(13, 10), local(13, 11)),
        row("c", local(13, 11), undefined),
      ],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    expect(lines).toHaveLength(3);
  });

  it("日を跨ぐ記録は開始日と両端の時刻が読める", () => {
    const lines = formatLogLines([row("a", local(12, 23), local(13, 1))], LONG_ENOUGH, RUNTIME_TZ);

    expect(lines[0]).toContain("2026-08-12");
    expect(lines[0]).toContain("23:00");
    expect(lines[0]).toContain("01:00");
    expect(lines[0]).toContain("2h");
  });

  it("ID の長さが違っても後続の列が揃う", () => {
    const lines = formatLogLines(
      [
        row("short", local(13, 9), local(13, 10)),
        row("very-long-id-1234", local(13, 10), local(13, 11)),
      ],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    const positions = lines.map((line) => line.indexOf("2026-08-13"));

    expect(positions[0]).toBe(positions[1]);
  });

  it("全角の作業名が混ざっても長さの列が揃う", () => {
    const lines = formatLogLines(
      [
        row("a", local(13, 9), local(13, 10), { note: "設計" }),
        row("b", local(13, 10), local(13, 11), { note: "review" }),
      ],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    // 長さの列は作業名より前にあるので、作業名の幅に影響されない
    const positions = lines.map((line) => line.indexOf("1h"));

    expect(positions[0]).toBe(positions[1]);
  });

  // `実行中` は3文字だが端末では6桁を占める。桁が揃っているかは文字数ではなく
  // 表示幅で見る必要がある（`indexOf` の値は UTF-16 の位置なので、揃っていても一致しない）
  it("実行中と完了が混ざっても作業名の開始桁が揃う", () => {
    const lines = formatLogLines(
      [
        row("a", local(13, 9), local(13, 10), { note: "設計" }),
        row("b", local(13, 11), undefined, { note: "レビュー" }),
      ],
      LONG_ENOUGH,
      RUNTIME_TZ,
    );

    const columns = [columnOf(lines[0] ?? "", "設計"), columnOf(lines[1] ?? "", "レビュー")];

    expect(columns[0]).toBe(columns[1]);
  });
});

/** その語が始まる表示桁。見つからなければ -1。 */
function columnOf(line: string, text: string): number {
  const index = line.indexOf(text);

  return index === -1 ? -1 : displayWidth(line.slice(0, index));
}
