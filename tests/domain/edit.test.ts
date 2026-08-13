import { describe, expect, it } from "vitest";

import { applyEdit, findOverlapping } from "../../src/domain/edit.js";
import type { Entry } from "../../src/domain/entry.js";

function local(day: number, hours: number, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

function entry(
  id: string,
  start: Date,
  end: Date | undefined,
  tags: readonly string[] = [],
  note?: string,
): Entry {
  return {
    id,
    start: start.toISOString(),
    ...(end === undefined ? {} : { end: end.toISOString() }),
    tags,
    ...(note === undefined ? {} : { note }),
  };
}

/** 8/13 09:00〜10:00、#work、「設計」。 */
const BASE = entry("target", local(13, 9), local(13, 10), ["work"], "設計");

describe("applyEdit の各フィールドの編集", () => {
  it("開始時刻を変えられる", () => {
    const edited = applyEdit(BASE, { start: local(13, 8) });

    expect(edited.start).toBe(local(13, 8).toISOString());
    expect(edited.end).toBe(local(13, 10).toISOString());
  });

  it("終了時刻を変えられる", () => {
    const edited = applyEdit(BASE, { end: local(13, 11) });

    expect(edited.end).toBe(local(13, 11).toISOString());
    expect(edited.start).toBe(local(13, 9).toISOString());
  });

  it("タグを変えられる", () => {
    const edited = applyEdit(BASE, { tags: ["会議", "proj/tock"] });

    expect(edited.tags).toEqual(["会議", "proj/tock"]);
  });

  it("作業名を変えられる", () => {
    expect(applyEdit(BASE, { note: "実装" }).note).toBe("実装");
  });

  it("複数のフィールドを同時に変えられる", () => {
    const edited = applyEdit(BASE, {
      start: local(13, 8),
      end: local(13, 12),
      tags: ["会議"],
      note: "打ち合わせ",
    });

    expect(edited.start).toBe(local(13, 8).toISOString());
    expect(edited.end).toBe(local(13, 12).toISOString());
    expect(edited.tags).toEqual(["会議"]);
    expect(edited.note).toBe("打ち合わせ");
  });

  it("指定しなかったフィールドは変わらない", () => {
    const edited = applyEdit(BASE, { note: "実装" });

    expect(edited.start).toBe(BASE.start);
    expect(edited.end).toBe(BASE.end);
    expect(edited.tags).toEqual(BASE.tags);
  });

  it("**id は変わらない**（編集は同じ記録の書き換えなので）", () => {
    expect(applyEdit(BASE, { note: "実装" }).id).toBe("target");
  });

  it("何も変えなければ同じ内容になる（境界）", () => {
    expect(applyEdit(BASE, {})).toEqual(BASE);
  });

  it("元のエントリを書き換えない", () => {
    applyEdit(BASE, { note: "実装", tags: ["会議"] });

    expect(BASE.note).toBe("設計");
    expect(BASE.tags).toEqual(["work"]);
  });
});

describe("applyEdit の空にする編集", () => {
  it("空文字の作業名で作業名を消せる（境界）", () => {
    expect(applyEdit(BASE, { note: "" })).not.toHaveProperty("note");
  });

  it("空の配列でタグを消せる（境界）", () => {
    expect(applyEdit(BASE, { tags: [] }).tags).toEqual([]);
  });

  it("作業名を消してもタグは残る", () => {
    expect(applyEdit(BASE, { note: "" }).tags).toEqual(["work"]);
  });
});

describe("applyEdit の不正な編集", () => {
  it("終了が開始より前になる編集は Error（DoD）", () => {
    expect(() => applyEdit(BASE, { end: local(13, 8) })).toThrow();
  });

  it("開始が終了より後になる編集も Error（DoD。開始側を動かした場合）", () => {
    expect(() => applyEdit(BASE, { start: local(13, 11) })).toThrow();
  });

  it("開始と終了が同時刻になる編集は通る（境界: 長さ 0 は作れる）", () => {
    const edited = applyEdit(BASE, { end: local(13, 9) });

    expect(edited.start).toBe(edited.end);
  });

  it("両方を同時に動かして前後が保たれていれば通る", () => {
    const edited = applyEdit(BASE, { start: local(13, 14), end: local(13, 15) });

    expect(edited.start).toBe(local(13, 14).toISOString());
    expect(edited.end).toBe(local(13, 15).toISOString());
  });

  it("空のタグは Error", () => {
    expect(() => applyEdit(BASE, { tags: [""] })).toThrow();
  });

  it("不正な Date は Error", () => {
    expect(() => applyEdit(BASE, { start: new Date(Number.NaN) })).toThrow();
  });
});

// CLAUDE.md の境界値チェックリスト「終端のないデータ」
describe("applyEdit と実行中エントリ（終端がない）", () => {
  const RUNNING = entry("running", local(13, 9), undefined, ["work"], "作業中");

  it("実行中のまま開始時刻を変えられる", () => {
    const edited = applyEdit(RUNNING, { start: local(13, 8) });

    expect(edited.start).toBe(local(13, 8).toISOString());
    expect(edited).not.toHaveProperty("end");
  });

  it("実行中のままタグを変えられる", () => {
    const edited = applyEdit(RUNNING, { tags: ["会議"] });

    expect(edited.tags).toEqual(["会議"]);
    expect(edited).not.toHaveProperty("end");
  });

  it("終了時刻を与えると実行中でなくなる", () => {
    expect(applyEdit(RUNNING, { end: local(13, 10) }).end).toBe(local(13, 10).toISOString());
  });

  it("与えた終了時刻が開始より前なら Error（境界）", () => {
    expect(() => applyEdit(RUNNING, { end: local(13, 8) })).toThrow();
  });

  it("実行中に開始と同時刻の終了を与えても通る（境界: 長さ 0）", () => {
    expect(applyEdit(RUNNING, { end: local(13, 9) }).end).toBe(local(13, 9).toISOString());
  });
});

describe("findOverlapping", () => {
  const others = [
    entry("before", local(13, 7), local(13, 8), ["work"]),
    entry("after", local(13, 12), local(13, 13), ["work"]),
  ];

  it("重なる記録が無ければ undefined", () => {
    expect(findOverlapping(BASE, [BASE, ...others])).toBeUndefined();
  });

  it("他の記録と重なると、その記録を返す", () => {
    const moved = applyEdit(BASE, { start: local(13, 7, 30) });

    expect(findOverlapping(moved, [BASE, ...others])?.id).toBe("before");
  });

  it("自分自身とは重ならない（同じ id は除く）", () => {
    // 自分と比べると必ず重なるため、id で除外していないとここで落ちる
    expect(findOverlapping(BASE, [BASE])).toBeUndefined();
  });

  it("端点が接するだけなら重ならない（境界: 半開区間）", () => {
    const touching = applyEdit(BASE, { start: local(13, 8) });

    expect(findOverlapping(touching, [BASE, ...others])).toBeUndefined();
  });

  it("1ミリ秒でも食い込めば重なる（境界）", () => {
    const overlapping = applyEdit(BASE, { start: new Date(local(13, 8).getTime() - 1) });

    expect(findOverlapping(overlapping, [BASE, ...others])?.id).toBe("before");
  });

  it("長さ 0 の記録はどれとも重ならない（境界）", () => {
    const zero = applyEdit(BASE, { start: local(13, 7, 30), end: local(13, 7, 30) });

    expect(findOverlapping(zero, [BASE, ...others])).toBeUndefined();
  });

  it("記録が自分1件だけなら undefined（境界）", () => {
    expect(findOverlapping(BASE, [BASE])).toBeUndefined();
  });

  it("空の一覧でも落ちない（境界）", () => {
    expect(findOverlapping(BASE, [])).toBeUndefined();
  });

  it("実行中の記録は開始以降ずっと続くものとして重なりを見る（終端なし）", () => {
    const running = entry("running", local(13, 11), undefined, ["work"]);
    const moved = applyEdit(BASE, { start: local(13, 11, 30), end: local(13, 11, 45) });

    expect(findOverlapping(moved, [BASE, running])?.id).toBe("running");
  });

  it("実行中の記録を編集したとき、後続の記録と重なることを検出する（終端なし）", () => {
    const running = entry("running", local(13, 9), undefined, ["work"]);
    const moved = applyEdit(running, { start: local(13, 6) });

    // 実行中は開始以降ずっと続くので、after（12:00〜13:00）と重なる
    expect(findOverlapping(moved, [running, ...others])).toBeDefined();
  });
});
