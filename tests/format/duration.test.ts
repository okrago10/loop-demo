import { describe, expect, it } from "vitest";

import { formatDuration } from "../../src/format/duration.js";

describe("formatDuration", () => {
  it("1時間23分を 1h 23m と表す（Issue の例）", () => {
    expect(formatDuration(83 * 60_000)).toBe("1h 23m");
  });

  it("1時間未満は分だけを表す", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m");
  });

  it("ちょうど何時間かなら分を付けない", () => {
    expect(formatDuration(2 * 60 * 60_000)).toBe("2h");
  });

  it("1分未満は秒で表す（0m にして情報を失わない）", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("0 は 0s（境界）", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("ちょうど1分は 1m（境界）", () => {
    expect(formatDuration(60_000)).toBe("1m");
  });

  it("59秒は 59s（境界）", () => {
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("ちょうど1時間は 1h（境界）", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h");
  });

  it("59分は 59m（境界）", () => {
    expect(formatDuration(59 * 60_000)).toBe("59m");
  });

  it("24時間を超えても時間で表す（日には繰り上げない）", () => {
    expect(formatDuration(25 * 60 * 60_000)).toBe("25h");
  });

  it("端数の秒は切り捨てる（丸めは #7 の担当なので四捨五入しない）", () => {
    expect(formatDuration(89 * 60_000 + 59_000)).toBe("1h 29m");
  });

  it("1分未満の端数ミリ秒も切り捨てる", () => {
    expect(formatDuration(1999)).toBe("1s");
  });

  it("負の値は失敗する（長さとして意味を持たない）", () => {
    expect(() => formatDuration(-1)).toThrow(/負/);
  });

  it("整数でないミリ秒は失敗する", () => {
    expect(() => formatDuration(1.5)).toThrow(/整数/);
  });

  it("NaN は失敗する", () => {
    expect(() => formatDuration(Number.NaN)).toThrow();
  });
});
