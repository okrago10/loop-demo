import { describe, expect, it } from "vitest";

import { createEntry, type Entry } from "../../src/domain/entry.js";
import {
  autoStopAt,
  DEFAULT_MAX_RUNNING_HOURS,
  hoursToMs,
  isOverrun,
  overrunWarning,
} from "../../src/domain/overrun.js";

/**
 * 止め忘れの判定（#24）。
 *
 * **扱う対象はすべて実行中エントリ**（`end` を持たない）なので、`CLAUDE.md` の
 * 「終端のないデータ」の境界がそのまま本題になる。とくに**上限ちょうど**を
 * 取り違えると、上限を守って働いた人に警告が出る。
 *
 * 現在時刻は引数で受け取る。domain から時計を読まない。
 */

let counter = 0;

/** 実行中エントリ（`end` を持たない）。 */
function running(start: string): Entry {
  counter += 1;

  return createEntry({ start, tags: ["work"] }, { newId: () => `e${String(counter)}` });
}

const LIMIT = hoursToMs(8);

/** 開始からの経過を足した時刻。 */
function after(start: string, ms: number): Date {
  return new Date(Date.parse(start) + ms);
}

const START = "2026-08-12T09:00:00.000Z";

describe("上限を超えているか", () => {
  it("上限を超えていれば超過", () => {
    expect(isOverrun(running(START), after(START, LIMIT + 1), LIMIT)).toBe(true);
  });

  it("**上限ちょうどは超過ではない（境界）**", () => {
    // 「以上」と「超過」を取り違えると、上限を守って働いた人に警告が出る
    expect(isOverrun(running(START), after(START, LIMIT), LIMIT)).toBe(false);
  });

  it("1ミリ秒でも超えたら超過（境界）", () => {
    expect(isOverrun(running(START), after(START, LIMIT + 1), LIMIT)).toBe(true);
  });

  it("上限の手前は超過ではない", () => {
    expect(isOverrun(running(START), after(START, LIMIT - 1), LIMIT)).toBe(false);
  });

  it("開始と同時刻なら超過ではない（境界: 経過 0）", () => {
    expect(isOverrun(running(START), after(START, 0), LIMIT)).toBe(false);
  });

  it("**開始が未来でも超過にしない（境界: 経過が負）**", () => {
    // 時計のずれや手編集で作られる。負を「超えた」と扱うと、身に覚えのない警告が出る
    expect(isOverrun(running(START), after(START, -hoursToMs(100)), LIMIT)).toBe(false);
  });

  it("日を跨いで実行中のままでも判定できる（境界: 日跨ぎ）", () => {
    const overnight = running("2026-08-12T23:00:00.000Z");

    expect(isOverrun(overnight, new Date("2026-08-13T08:00:00.000Z"), LIMIT)).toBe(true);
    expect(isOverrun(overnight, new Date("2026-08-13T06:00:00.000Z"), LIMIT)).toBe(false);
  });

  it("上限が 0 なら、経過があれば超過（境界: 上限の下限）", () => {
    expect(isOverrun(running(START), after(START, 1), 0)).toBe(true);
    expect(isOverrun(running(START), after(START, 0), 0)).toBe(false);
  });
});

describe("警告の文言", () => {
  it("超えていれば警告を返す（DoD）", () => {
    expect(overrunWarning(running(START), after(START, LIMIT + 1), LIMIT)).toBeDefined();
  });

  it("**超えていなければ警告を返さない（DoD）**", () => {
    expect(overrunWarning(running(START), after(START, LIMIT - 1), LIMIT)).toBeUndefined();
  });

  it("上限ちょうどでは警告を返さない（境界）", () => {
    expect(overrunWarning(running(START), after(START, LIMIT), LIMIT)).toBeUndefined();
  });

  it("上限の長さが読める", () => {
    expect(overrunWarning(running(START), after(START, LIMIT + 1), LIMIT)).toContain("8時間");
  });

  it("設定を変えれば文言の上限も変わる", () => {
    const short = hoursToMs(2);

    expect(overrunWarning(running(START), after(START, short + 1), short)).toContain("2時間");
  });

  it("どの記録のことかが分かる（開始時刻が入る）", () => {
    expect(overrunWarning(running(START), after(START, LIMIT + 1), LIMIT)).toContain(START);
  });

  it("**何をすればよいかが書いてある**", () => {
    // 「長すぎます」だけでは、止めるのか直すのかが分からない
    expect(overrunWarning(running(START), after(START, LIMIT + 1), LIMIT)).toContain(
      "tock stop --auto",
    );
  });
});

describe("--auto の終了時刻", () => {
  it("**超えていれば上限ちょうどで打ち切る（DoD）**", () => {
    const end = autoStopAt(running(START), after(START, LIMIT + hoursToMs(4)), LIMIT);

    expect(end.getTime()).toBe(after(START, LIMIT).getTime());
  });

  it("上限ちょうどのときも上限で止まる（境界）", () => {
    const end = autoStopAt(running(START), after(START, LIMIT), LIMIT);

    expect(end.getTime()).toBe(after(START, LIMIT).getTime());
  });

  it("**超えていなければ「今」で止まる**", () => {
    // 届いていない記録に上限を当てると未来の終了時刻になり、記録として作れない
    const now = after(START, hoursToMs(1));

    expect(autoStopAt(running(START), now, LIMIT).getTime()).toBe(now.getTime());
  });

  it("開始と同時刻でも作れる時刻を返す（境界: 長さ 0）", () => {
    const now = after(START, 0);

    expect(autoStopAt(running(START), now, LIMIT).getTime()).toBe(now.getTime());
  });

  it("日を跨いで止め忘れた記録を、開始の8時間後で打ち切る（境界: 日跨ぎ）", () => {
    const overnight = running("2026-08-12T23:00:00.000Z");

    expect(autoStopAt(overnight, new Date("2026-08-13T12:00:00.000Z"), LIMIT).toISOString()).toBe(
      "2026-08-13T07:00:00.000Z",
    );
  });

  it("上限が 0 なら開始時刻で打ち切る（境界: 上限の下限）", () => {
    expect(autoStopAt(running(START), after(START, hoursToMs(3)), 0).toISOString()).toBe(START);
  });
});

describe("既定の上限", () => {
  it("止め忘れを疑える長さになっている", () => {
    // 長くしすぎると気づけず、短くしすぎると正常な長時間作業のたびに警告が出て読まれなくなる
    expect(DEFAULT_MAX_RUNNING_HOURS).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_MAX_RUNNING_HOURS).toBeLessThanOrEqual(24);
  });

  it("時間からミリ秒への変換が合っている", () => {
    expect(hoursToMs(1)).toBe(3_600_000);
    expect(hoursToMs(0)).toBe(0);
  });
});
