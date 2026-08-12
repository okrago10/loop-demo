import { describe, expect, it } from "vitest";

import { createEntry, endedAt, isRunning, startedAt } from "../../src/domain/entry.js";
import { randomId } from "../../src/id.js";

/** 採番を固定する。domain が注入された関数だけを使うことを確かめられる。 */
function fixedId(id = "id-1"): { newId: () => string } {
  return { newId: () => id };
}

/** 呼ばれるたびに連番を返す採番。 */
function sequentialId(): { newId: () => string } {
  let n = 0;
  return {
    newId: () => {
      n += 1;
      return `id-${String(n)}`;
    },
  };
}

describe("createEntry", () => {
  it("start / end / tags / note を持つ Entry を返す", () => {
    const entry = createEntry(
      {
        start: "2026-08-12T01:00:00Z",
        end: "2026-08-12T02:00:00Z",
        tags: ["work", "review"],
        note: "PR を見た",
      },
      fixedId("abc"),
    );

    expect(entry).toEqual({
      id: "abc",
      start: "2026-08-12T01:00:00.000Z",
      end: "2026-08-12T02:00:00.000Z",
      tags: ["work", "review"],
      note: "PR を見た",
    });
  });

  it("Date を渡しても ISO 8601 文字列で保持する", () => {
    const entry = createEntry({ start: new Date("2026-08-12T01:00:00Z") }, fixedId());

    expect(entry.start).toBe("2026-08-12T01:00:00.000Z");
  });

  it("オフセット付きの入力は UTC の正規形に揃える", () => {
    const entry = createEntry({ start: "2026-08-12T10:00:00+09:00" }, fixedId());

    expect(entry.start).toBe("2026-08-12T01:00:00.000Z");
  });

  it("tags を省略すると空配列になる（0件の境界）", () => {
    const entry = createEntry({ start: "2026-08-12T01:00:00Z" }, fixedId());

    expect(entry.tags).toEqual([]);
  });

  it("渡した tags 配列を後から書き換えても Entry は影響を受けない", () => {
    const tags = ["work"];
    const entry = createEntry({ start: "2026-08-12T01:00:00Z", tags }, fixedId());

    tags.push("後から追加");

    expect(entry.tags).toEqual(["work"]);
  });

  it.each([
    ["空文字", ""],
    ["空白のみ", "   "],
  ])("tags に%sが含まれる場合は弾く", (_label, tag) => {
    expect(() => createEntry({ start: "2026-08-12T01:00:00Z", tags: [tag] }, fixedId())).toThrow(
      /タグ/,
    );
  });

  it.each([
    ["空文字", ""],
    ["空白のみ", "   "],
  ])("note が%sの場合はプロパティを持たせない", (_label, note) => {
    const entry = createEntry({ start: "2026-08-12T01:00:00Z", note }, fixedId());

    expect(entry).not.toHaveProperty("note");
  });

  it.each([
    ["2月30日", "2026-02-30T00:00:00Z"],
    ["平年の2月29日", "2026-02-29T00:00:00Z"],
    ["4月31日", "2026-04-31T00:00:00Z"],
    ["月が範囲外", "2026-13-01T00:00:00Z"],
    ["日が範囲外", "2026-08-32T00:00:00Z"],
    ["時が範囲外", "2026-08-12T25:00:00Z"],
    ["時が24（ISO では日末を指し、翌日にずれてしまう）", "2026-08-12T24:00:00Z"],
    ["分が範囲外", "2026-08-12T23:60:00Z"],
    ["秒が範囲外", "2026-08-12T23:59:60Z"],
    ["ISO 8601 でない", "2026/08/12 10:00"],
    ["タイムゾーンがない（ローカル時刻と区別できない）", "2026-08-12T10:00:00"],
    ["オフセットが範囲外", "2026-08-12T10:00:00+25:00"],
    ["オフセットの分が範囲外", "2026-08-12T10:00:00+09:60"],
    ["空文字", ""],
  ])("start が不正（%s）なら弾く", (_label, start) => {
    expect(() => createEntry({ start }, fixedId())).toThrow(/start/);
  });

  it("閏年の2月29日は受け付ける", () => {
    const entry = createEntry({ start: "2028-02-29T00:00:00Z" }, fixedId());

    expect(entry.start).toBe("2028-02-29T00:00:00.000Z");
  });

  it("start が Invalid Date なら弾く", () => {
    expect(() => createEntry({ start: new Date("壊れた") }, fixedId())).toThrow(/start/);
  });

  it("end が不正な形式なら弾く", () => {
    expect(() =>
      createEntry({ start: "2026-08-12T01:00:00Z", end: "2026-08-12T02:00:00" }, fixedId()),
    ).toThrow(/end/);
  });

  it("日を跨ぐエントリはそのまま保持する（分割は #6 の担当）", () => {
    const entry = createEntry(
      { start: "2026-08-12T23:00:00Z", end: "2026-08-13T01:00:00Z" },
      fixedId(),
    );

    expect(entry.start).toBe("2026-08-12T23:00:00.000Z");
    expect(entry.end).toBe("2026-08-13T01:00:00.000Z");
  });
});

describe("end と start の前後関係", () => {
  it("end が start より前なら不正として弾く", () => {
    expect(() =>
      createEntry({ start: "2026-08-12T02:00:00Z", end: "2026-08-12T01:00:00Z" }, fixedId()),
    ).toThrow(/end/);
  });

  it("1 ミリ秒だけ前でも弾く（境界）", () => {
    expect(() =>
      createEntry(
        { start: "2026-08-12T01:00:00.001Z", end: "2026-08-12T01:00:00.000Z" },
        fixedId(),
      ),
    ).toThrow(/end/);
  });

  it("end と start が同時刻なら許可する（0分エントリ）", () => {
    const entry = createEntry(
      { start: "2026-08-12T01:00:00Z", end: "2026-08-12T01:00:00Z" },
      fixedId(),
    );

    expect(entry.start).toBe(entry.end);
  });

  it("オフセット違いで見た目が逆でも、実時刻で判定する", () => {
    // +09:00 の 10:00 は UTC 01:00 なので、UTC 02:00 より前
    const entry = createEntry(
      { start: "2026-08-12T10:00:00+09:00", end: "2026-08-12T02:00:00Z" },
      fixedId(),
    );

    expect(entry.start).toBe("2026-08-12T01:00:00.000Z");
    expect(entry.end).toBe("2026-08-12T02:00:00.000Z");
  });
});

describe("実行中エントリ", () => {
  it("end を渡さないと end プロパティを持たない", () => {
    const entry = createEntry({ start: "2026-08-12T01:00:00Z" }, fixedId());

    expect(entry).not.toHaveProperty("end");
  });

  it("isRunning は end がなければ true", () => {
    const entry = createEntry({ start: "2026-08-12T01:00:00Z" }, fixedId());

    expect(isRunning(entry)).toBe(true);
  });

  it("isRunning は end があれば false", () => {
    const entry = createEntry(
      { start: "2026-08-12T01:00:00Z", end: "2026-08-12T02:00:00Z" },
      fixedId(),
    );

    expect(isRunning(entry)).toBe(false);
  });

  it("0分エントリは実行中ではない", () => {
    const entry = createEntry(
      { start: "2026-08-12T01:00:00Z", end: "2026-08-12T01:00:00Z" },
      fixedId(),
    );

    expect(isRunning(entry)).toBe(false);
  });
});

describe("Date への変換", () => {
  it("startedAt は start を Date で返す", () => {
    const entry = createEntry({ start: "2026-08-12T01:00:00Z" }, fixedId());

    expect(startedAt(entry)).toEqual(new Date("2026-08-12T01:00:00.000Z"));
  });

  it("endedAt は end を Date で返す", () => {
    const entry = createEntry(
      { start: "2026-08-12T01:00:00Z", end: "2026-08-12T02:00:00Z" },
      fixedId(),
    );

    expect(endedAt(entry)).toEqual(new Date("2026-08-12T02:00:00.000Z"));
  });

  it("実行中エントリの endedAt は undefined", () => {
    const entry = createEntry({ start: "2026-08-12T01:00:00Z" }, fixedId());

    expect(endedAt(entry)).toBeUndefined();
  });
});

describe("id の採番", () => {
  it("注入された採番関数の値をそのまま使う", () => {
    const entry = createEntry({ start: "2026-08-12T01:00:00Z" }, fixedId("injected-id"));

    expect(entry.id).toBe("injected-id");
  });

  it("採番関数は 1 エントリにつき 1 回だけ呼ばれる", () => {
    let called = 0;

    createEntry(
      { start: "2026-08-12T01:00:00Z" },
      {
        newId: () => {
          called += 1;
          return "id-1";
        },
      },
    );

    expect(called).toBe(1);
  });

  it("連番を注入するとエントリごとに異なる id になる", () => {
    const deps = sequentialId();

    const ids = Array.from(
      { length: 100 },
      () => createEntry({ start: "2026-08-12T01:00:00Z" }, deps).id,
    );

    expect(new Set(ids).size).toBe(100);
  });

  it("採番関数が空文字を返したら弾く（不正な id を持つ Entry を作らない）", () => {
    expect(() => createEntry({ start: "2026-08-12T01:00:00Z" }, fixedId(""))).toThrow(/id/);
  });

  it("randomId は繰り返し呼んでも一意である", () => {
    const count = 10_000;

    const ids = new Set(Array.from({ length: count }, () => randomId()));

    expect(ids.size).toBe(count);
  });
});
