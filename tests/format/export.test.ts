import { describe, expect, it } from "vitest";

import { createEntry, type Entry } from "../../src/domain/entry.js";
import { CSV_HEADER, formatCsvLines, formatJsonLines } from "../../src/format/export.js";

let counter = 0;

function entry(input: {
  start: string;
  end?: string;
  tags?: readonly string[];
  note?: string;
}): Entry {
  counter += 1;
  const id = `id-${String(counter)}`;

  return createEntry(input, { newId: () => id });
}

/** CSV の1行を列に割る。引用符を含まない行にだけ使う。 */
function columns(line: string): string[] {
  return line.split(",");
}

describe("formatCsvLines の見出し行", () => {
  it("列の順序が id, start, end, duration_min, tags, note で固定されている", () => {
    const lines = formatCsvLines([]);

    expect(lines[0]).toBe("id,start,end,duration_min,tags,note");
    expect(CSV_HEADER).toEqual(["id", "start", "end", "duration_min", "tags", "note"]);
  });

  it("記録が0件でも見出し行だけは出す（境界）", () => {
    expect(formatCsvLines([])).toEqual(["id,start,end,duration_min,tags,note"]);
  });
});

describe("formatCsvLines の各列", () => {
  it("時刻は保存されている ISO 8601（UTC）をそのまま出す", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", end: "2026-08-13T10:30:00.000Z" });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[1]).toBe("2026-08-13T09:00:00.000Z");
    expect(columns(line)[2]).toBe("2026-08-13T10:30:00.000Z");
  });

  it("duration_min は分で出す", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", end: "2026-08-13T10:30:00.000Z" });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[3]).toBe("90");
  });

  it("1分に満たない長さは小数で出す", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", end: "2026-08-13T09:00:30.000Z" });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[3]).toBe("0.5");
  });

  it("割り切れない秒でも桁を落とさない（行ごとに丸めない）", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", end: "2026-08-13T09:01:01.000Z" });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[3]).toBe(String(61 / 60));
  });

  it("duration_min を足した合計が、実際の経過時間の合計と一致する", () => {
    // 行ごとに丸めると誤差が同じ向きに積み上がる。1秒の記録40件で
    // 実際の 0.667分 に対し、小数第2位に丸めた列の合計は 0.8分 になっていた
    const rows = Array.from({ length: 40 }, (_index, offset) =>
      entry({
        start: `2026-08-13T09:${String(offset).padStart(2, "0")}:00.000Z`,
        end: `2026-08-13T09:${String(offset).padStart(2, "0")}:01.000Z`,
      }),
    );

    const total = formatCsvLines(rows)
      .slice(1)
      .reduce((sum, line) => sum + Number(columns(line)[3]), 0);

    expect(total).toBeCloseTo((40 * 1000) / 60_000, 10);
  });

  it("長さ 0 の記録は 0 と出す（境界）", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", end: "2026-08-13T09:00:00.000Z" });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[3]).toBe("0");
  });

  it("日をまたぐ記録も分割せず1行で出す", () => {
    const row = entry({ start: "2026-08-13T23:00:00.000Z", end: "2026-08-14T01:00:00.000Z" });

    const lines = formatCsvLines([row]);

    expect(lines).toHaveLength(2);
    expect(columns(lines[1] ?? "")[3]).toBe("120");
  });

  it("タグは空白区切りで出す（# は付けない）", () => {
    const row = entry({
      start: "2026-08-13T09:00:00.000Z",
      end: "2026-08-13T10:00:00.000Z",
      tags: ["work", "proj/tock"],
    });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[4]).toBe("work proj/tock");
  });

  it("タグが無ければ空欄にする（境界）", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", end: "2026-08-13T10:00:00.000Z" });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[4]).toBe("");
  });

  it("作業名が無ければ空欄にする（境界）", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", end: "2026-08-13T10:00:00.000Z" });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)[5]).toBe("");
  });
});

describe("formatCsvLines と終端のない記録", () => {
  it("実行中の記録は end と duration_min を空欄にする", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z", tags: ["work"] });

    const [, line = ""] = formatCsvLines([row]);

    expect(columns(line)).toEqual([row.id, "2026-08-13T09:00:00.000Z", "", "", "work", ""]);
  });

  it("実行中の記録でも列の数は変わらない", () => {
    const running = entry({ start: "2026-08-13T09:00:00.000Z" });
    const done = entry({ start: "2026-08-13T10:00:00.000Z", end: "2026-08-13T11:00:00.000Z" });

    const [, first = "", second = ""] = formatCsvLines([running, done]);

    expect(columns(first)).toHaveLength(CSV_HEADER.length);
    expect(columns(second)).toHaveLength(CSV_HEADER.length);
  });
});

describe("formatCsvLines のエスケープ", () => {
  it("カンマを含む作業名を1つの列に収める", () => {
    const row = entry({
      start: "2026-08-13T09:00:00.000Z",
      end: "2026-08-13T10:00:00.000Z",
      note: "設計, 実装",
    });

    const [, line = ""] = formatCsvLines([row]);

    expect(line.endsWith(',"設計, 実装"')).toBe(true);
  });

  it("引用符を含む作業名は引用符を2つ重ねる", () => {
    const row = entry({
      start: "2026-08-13T09:00:00.000Z",
      end: "2026-08-13T10:00:00.000Z",
      note: '"至急"の対応',
    });

    const [, line = ""] = formatCsvLines([row]);

    expect(line.endsWith(',"""至急""の対応"')).toBe(true);
  });

  it("カンマを含むタグも1つの列に収める", () => {
    // normalizeTag は空白を弾くがカンマは通す（`#a,b` は妥当なタグ）。
    // タグ列の引用を外すと、この行だけ列がずれる
    const row = entry({
      start: "2026-08-13T09:00:00.000Z",
      end: "2026-08-13T10:00:00.000Z",
      tags: ["a,b", "work"],
      note: "設計",
    });

    const [, line = ""] = formatCsvLines([row]);

    expect(line).toBe(`${row.id},${row.start},${row.end ?? ""},60,"a,b work",設計`);
  });

  it("改行を含む作業名は引用符で囲む（行数は増える）", () => {
    const row = entry({
      start: "2026-08-13T09:00:00.000Z",
      end: "2026-08-13T10:00:00.000Z",
      note: "1行目\n2行目",
    });

    const [, line = ""] = formatCsvLines([row]);

    expect(line.endsWith(',"1行目\n2行目"')).toBe(true);
  });
});

describe("formatJsonLines", () => {
  it("記録の配列をそのまま JSON にする", () => {
    const row = entry({
      start: "2026-08-13T09:00:00.000Z",
      end: "2026-08-13T10:00:00.000Z",
      tags: ["work"],
      note: "設計",
    });

    const parsed: unknown = JSON.parse(formatJsonLines([row]).join("\n"));

    expect(parsed).toEqual([row]);
  });

  it("記録が0件なら空の配列にする（境界）", () => {
    const parsed: unknown = JSON.parse(formatJsonLines([]).join("\n"));

    expect(parsed).toEqual([]);
  });

  it("実行中の記録では end の欄を持たない（実行中のまま読み戻せる）", () => {
    const row = entry({ start: "2026-08-13T09:00:00.000Z" });

    const [parsed] = JSON.parse(formatJsonLines([row]).join("\n")) as Record<string, unknown>[];

    expect(parsed).not.toHaveProperty("end");
    expect(parsed?.["start"]).toBe("2026-08-13T09:00:00.000Z");
  });

  it("エスケープが必要な文字を含む作業名も読み戻せる", () => {
    const row = entry({
      start: "2026-08-13T09:00:00.000Z",
      end: "2026-08-13T10:00:00.000Z",
      note: '"至急", 1行目\n2行目',
    });

    const parsed: unknown = JSON.parse(formatJsonLines([row]).join("\n"));

    expect(parsed).toEqual([row]);
  });

  it("そのまま Entry として作り直せる（再取り込み可能）", () => {
    const rows = [
      entry({
        start: "2026-08-13T09:00:00.000Z",
        end: "2026-08-13T10:00:00.000Z",
        tags: ["work", "proj/tock"],
        note: '"至急", 対応\n続き',
      }),
      entry({ start: "2026-08-13T23:00:00.000Z", end: "2026-08-14T01:00:00.000Z" }),
      entry({ start: "2026-08-14T09:00:00.000Z", tags: ["work"] }),
    ];

    const parsed = JSON.parse(formatJsonLines(rows).join("\n")) as Entry[];
    const rebuilt = parsed.map((row) => createEntry(row, { newId: () => row.id }));

    expect(rebuilt).toEqual(rows);
  });
});
