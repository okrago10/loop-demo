import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";

let dir = "";
let store: Store;
let out: string[];
let err: string[];
let idCounter = 0;

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

/** 固定した現在時刻。テストが実行時刻に依存しないようにする。 */
const NOW = new Date("2026-08-12T10:00:00Z");

/**
 * ローカルの壁時計で `HH:MM:SS` を指す Date を作る。
 *
 * `--at` はローカルタイムゾーンで解釈されるため、現在時刻を UTC 文字列で固定すると
 * 「`--at` が未来か過去か」が実行環境の TZ によって変わってしまう。壁時計から
 * 組み立てて、TZ に依存しないテストにする。
 */
function localTime(hours: number, minutes: number, seconds = 0): Date {
  const at = new Date(NOW);
  at.setHours(hours, minutes, seconds, 0);

  return at;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-start-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(now: Date = NOW) {
  return {
    store,
    now: () => now,
    newId: () => {
      idCounter += 1;
      return `id-${String(idCounter)}`;
    },
  };
}

const allTime = {
  start: new Date("2000-01-01T00:00:00Z"),
  end: new Date("2100-01-01T00:00:00Z"),
};

describe("start", () => {
  it("実行中のエントリを1件作る", async () => {
    await createStartCommand(deps()).run(["設計"], io);

    const entries = await store.listByRange(allTime);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.start).toBe("2026-08-12T10:00:00.000Z");
    expect(entries[0]).not.toHaveProperty("end");
  });

  it("作業名を note として保存する", async () => {
    await createStartCommand(deps()).run(["設計"], io);

    expect((await store.listByRange(allTime))[0]?.note).toBe("設計");
  });

  it("#つきの語をタグとして取り出す", async () => {
    await createStartCommand(deps()).run(["設計 #proj/loop-demo #会議"], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.tags).toEqual(["proj/loop-demo", "会議"]);
    expect(entry?.note).toBe("設計");
  });

  it("引数が複数に分かれていても1つの文字列として扱う", async () => {
    await createStartCommand(deps()).run(["設計", "#work"], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.note).toBe("設計");
    expect(entry?.tags).toEqual(["work"]);
  });

  it("タグだけを渡しても開始できる（note なし）", async () => {
    await createStartCommand(deps()).run(["#work"], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.tags).toEqual(["work"]);
    expect(entry).not.toHaveProperty("note");
  });

  it("引数なしでも開始できる（境界）", async () => {
    await createStartCommand(deps()).run([], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.tags).toEqual([]);
    expect(entry).not.toHaveProperty("note");
  });

  it("同じタグを2回書いても1つになる", async () => {
    await createStartCommand(deps()).run(["#work #work"], io);

    expect((await store.listByRange(allTime))[0]?.tags).toEqual(["work"]);
  });

  // #13 では `#` だけの語を作業名の一部として扱っていたが、タグの意味は #8 の担当。
  // 黙って作業名に混ぜると、タグを付けたつもりの記録が集計に出てこないまま気づけない
  it("`#` だけの語は不正なタグとして UserError で失敗する", async () => {
    await expect(createStartCommand(deps()).run(["設計 #"], io)).rejects.toThrow(UserError);
  });

  it("不正なタグで失敗したときは何も保存しない", async () => {
    await Promise.resolve(createStartCommand(deps()).run(["設計 #"], io)).catch(() => undefined);

    expect(await store.listByRange(allTime)).toHaveLength(0);
  });

  it("タグの表記は正規化される（大文字は小文字に統一）", async () => {
    await createStartCommand(deps()).run(["設計 #Work #WORK"], io);

    expect((await store.listByRange(allTime))[0]?.tags).toEqual(["work"]);
  });

  it("開始したことと時刻を stdout に出す", async () => {
    await createStartCommand(deps()).run(["設計"], io);

    expect(out.join("\n")).toContain("設計");
    expect(err).toEqual([]);
  });

  it("すでに実行中なら UserError で失敗する（終了コード 1 になる）", async () => {
    await createStartCommand(deps()).run(["1本目"], io);

    await expect(createStartCommand(deps()).run(["2本目"], io)).rejects.toThrow(UserError);
  });

  it("二重 start でも1件しか保存されない", async () => {
    await createStartCommand(deps()).run(["1本目"], io);
    // 失敗することは別のテストで確認済み。ここでは保存件数だけを見る
    await Promise.resolve(createStartCommand(deps()).run(["2本目"], io)).catch(() => undefined);

    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("停止したあとなら再度 start できる", async () => {
    const d = deps();
    await createStartCommand(d).run(["1本目"], io);
    await createStopCommand(d).run([], io);

    await createStartCommand(d).run(["2本目"], io);

    expect(await store.listByRange(allTime)).toHaveLength(2);
  });
});

describe("start --at", () => {
  /** ローカルの 23:00。`--at` に渡す時刻が必ず過去になるようにする。 */
  const lateNow = localTime(23, 0);

  it("指定した時刻を開始時刻として記録する", async () => {
    await createStartCommand(deps(lateNow)).run(["設計", "--at", "09:30"], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.start).toBe(localTime(9, 30).toISOString());
  });

  it("秒まで指定できる", async () => {
    await createStartCommand(deps(lateNow)).run(["--at", "09:30:15"], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.start).toBe(localTime(9, 30, 15).toISOString());
  });

  it("--at はタグや作業名に混ざらない", async () => {
    await createStartCommand(deps(lateNow)).run(["設計 #work", "--at", "09:30"], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.note).toBe("設計");
    expect(entry?.tags).toEqual(["work"]);
  });

  it.each([
    ["時が範囲外", "24:00"],
    ["分が範囲外", "09:60"],
    ["形式が違う", "9時30分"],
    ["空文字", ""],
    ["区切りがない", "0930"],
  ])("--at が不正（%s）なら UserError で失敗する", async (_label, at) => {
    await expect(createStartCommand(deps(lateNow)).run(["--at", at], io)).rejects.toThrow(
      UserError,
    );
  });

  it("--at の値が無い場合は UserError で失敗する", async () => {
    await expect(createStartCommand(deps(lateNow)).run(["--at"], io)).rejects.toThrow(UserError);
  });

  it("--at の次が別のオプションなら値が無いものとして失敗する", async () => {
    await expect(createStartCommand(deps(lateNow)).run(["--at", "--note"], io)).rejects.toThrow(
      UserError,
    );
  });
});

describe("start --at が未来のとき", () => {
  it("UserError で失敗する", async () => {
    await expect(
      createStartCommand(deps(localTime(9, 0))).run(["--at", "09:30"], io),
    ).rejects.toThrow(UserError);
  });

  it("何も保存しない（実行中エントリを作らない）", async () => {
    await Promise.resolve(
      createStartCommand(deps(localTime(9, 0))).run(["--at", "09:30"], io),
    ).catch(() => undefined);

    expect(await store.listByRange(allTime)).toHaveLength(0);
    expect(await store.findRunning()).toBeUndefined();
  });

  it("1秒でも未来なら失敗する（境界）", async () => {
    await expect(
      createStartCommand(deps(localTime(9, 29, 59))).run(["--at", "09:30"], io),
    ).rejects.toThrow(UserError);
  });

  it("現在時刻と同じ時刻なら成功する（境界）", async () => {
    await createStartCommand(deps(localTime(9, 30))).run(["--at", "09:30"], io);

    expect(await store.listByRange(allTime)).toHaveLength(1);
  });
});

describe("start の未知のオプション", () => {
  it.each([["--help"], ["--version"], ["--unknown"]])(
    "%s は作業名にせず UserError で失敗する",
    async (token) => {
      await expect(createStartCommand(deps()).run([token], io)).rejects.toThrow(UserError);
    },
  );

  it("失敗したときは何も保存しない", async () => {
    await Promise.resolve(createStartCommand(deps()).run(["--help"], io)).catch(() => undefined);

    expect(await store.listByRange(allTime)).toHaveLength(0);
  });

  it("作業名の中に含まれる `--` は弾かない", async () => {
    await createStartCommand(deps()).run(["設計 -- 前半だけ"], io);

    expect((await store.listByRange(allTime))[0]?.note).toBe("設計 -- 前半だけ");
  });

  it("`-` 始まりの1文字ハイフンは作業名として扱う", async () => {
    await createStartCommand(deps()).run(["-5分の中断あり"], io);

    expect((await store.listByRange(allTime))[0]?.note).toBe("-5分の中断あり");
  });
});
