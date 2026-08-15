import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createSwitchCommand } from "../../src/commands/switch.js";
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-switch-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(now: Date, override: Store = store) {
  return {
    store: override,
    now: () => now,
    newId: () => {
      idCounter += 1;
      return `id-${String(idCounter)}`;
    },
  };
}

/** ローカルの壁時計で時刻を組み立てる。`--at` の解釈が TZ に依存するため。 */
function local(hours: number, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, 13);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

const allTime = {
  start: new Date("2000-01-01T00:00:00Z"),
  end: new Date("2100-01-01T00:00:00Z"),
};

/**
 * 切り替えの書き込みだけが必ず失敗するストア（#88 で1回の追記になった）。
 *
 * 以前は「追記だけ落とす」「確定だけ落とす」「巻き戻しだけ落とす」の3種類が要った——
 * 書き込みが2回あり、どこで落ちるかによって残る状態が違ったため。**1回の追記に
 * なったので、落ち方は「書けない」の1つしかない。** 巻き戻しも順序の議論も消えた。
 */
function storeWithFailingSwitch(base: Store): Store {
  return {
    transaction: <T>(action: () => Promise<T>) => action(),
    append: (entry) => base.append(entry),
    update: (entry) => base.update(entry),
    stopAndStart: () => Promise.reject(new Error("書き込みに失敗しました")),
    delete: (id) => base.delete(id),
    listAll: () => base.listAll(),
    listByRange: (range) => base.listByRange(range),
    findRunning: () => base.findRunning(),
  };
}

/** 09:00 に開始した実行中エントリを作る。 */
async function startAt9(description = "前の作業 #work"): Promise<void> {
  await createStartCommand(deps(local(9, 0))).run([description], io);
  out = [];
}

describe("switch（実行中があるとき）", () => {
  it("前のエントリが確定し、新しいエントリが実行中になる", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(10, 30))).run(["次の作業 #会議"], io);

    const entries = await store.listByRange(allTime);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.end).toBe(local(10, 30).toISOString());
    expect(entries[1]).not.toHaveProperty("end");
    expect(entries[1]?.note).toBe("次の作業");
  });

  it("実行中は新しいエントリ1件だけになる", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(10, 30))).run(["次の作業"], io);

    const running = await store.findRunning();

    expect(running?.note).toBe("次の作業");
  });

  it("前後の時刻に隙間も重複も生じない", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(10, 30))).run(["次の作業"], io);

    const entries = await store.listByRange(allTime);

    expect(entries[0]?.end).toBe(entries[1]?.start);
  });

  it("前のエントリの作業名とタグは保たれる", async () => {
    await startAt9("前の作業 #work #proj");

    await createSwitchCommand(deps(local(10, 30))).run(["次の作業"], io);

    const entries = await store.listByRange(allTime);

    expect(entries[0]?.note).toBe("前の作業");
    expect(entries[0]?.tags).toEqual(["work", "proj"]);
  });

  it("停止した時間と開始したことを両方 stdout に出す", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(10, 30))).run(["次の作業"], io);

    const text = out.join("\n");

    expect(text).toContain("1h 30m");
    expect(text).toContain("次の作業");
    expect(err).toEqual([]);
  });

  it("--at で切り替え時刻を指定できる", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(12, 0))).run(["次の作業", "--at", "10:30"], io);

    const entries = await store.listByRange(allTime);

    expect(entries[0]?.end).toBe(local(10, 30).toISOString());
    expect(entries[1]?.start).toBe(local(10, 30).toISOString());
  });

  it("引数なしでも切り替えられる（名前なしの新エントリ）", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(10, 30))).run([], io);

    const entries = await store.listByRange(allTime);

    expect(entries).toHaveLength(2);
    expect(entries[1]).not.toHaveProperty("note");
  });

  it("前の開始と同時刻に切り替えても失敗しない（長さ0で確定・境界）", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(9, 0))).run(["次の作業"], io);

    const entries = await store.listByRange(allTime);

    expect(entries[0]?.end).toBe(entries[0]?.start);
    expect(entries[1]?.start).toBe(entries[0]?.end);
  });
});

describe("switch（実行中がないとき）", () => {
  it("単なる start として動作する", async () => {
    await createSwitchCommand(deps(local(9, 0))).run(["最初の作業 #work"], io);

    const entries = await store.listByRange(allTime);

    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("end");
    expect(entries[0]?.note).toBe("最初の作業");
    expect(entries[0]?.tags).toEqual(["work"]);
  });

  it("エラーにしない（start と同じ扱い）", async () => {
    await expect(
      createSwitchCommand(deps(local(9, 0))).run(["最初の作業"], io),
    ).resolves.toBeUndefined();
  });

  it("記録が1件も無い状態でも落ちない（境界）", async () => {
    await createSwitchCommand(deps(local(9, 0))).run([], io);

    expect(await store.findRunning()).toBeDefined();
    expect(err).toEqual([]);
  });
});

describe("switch（途中で失敗しても中途半端な状態を残さない・#88 で1回の追記に）", () => {
  // 以前ここには「追記だけ失敗」「確定だけ失敗」「巻き戻しも失敗」の3系統のテストがあった。
  // 書き込みが update + append の2回に分かれていて、どこで落ちるかで残る状態が違った
  // ためである。**#88 で切り替えは1回の追記になり、失敗の形は「書けない」の1つだけに
  // なった。** 巻き戻し（rollback）のコードも消えたので、その失敗系も存在しない。
  // これがこの describe が3系統から1系統に減った理由で、DoD の「巻き戻しが不要に
  // なっていることをテストで示す」に当たる
  it("**書き込みが失敗したら、前のエントリは実行中のまま戻る**", async () => {
    await startAt9();

    await expect(
      createSwitchCommand(deps(local(10, 30), storeWithFailingSwitch(store))).run(["次の作業"], io),
    ).rejects.toThrow();

    // 「前を止めただけで新規開始されない」状態になっていないこと
    const running = await store.findRunning();

    expect(running).toBeDefined();
    expect(running?.note).toBe("前の作業");
    expect(running).not.toHaveProperty("end");
  });

  it("書き込みが失敗したら、エントリは1件のまま", async () => {
    await startAt9();

    await Promise.resolve(
      createSwitchCommand(deps(local(10, 30), storeWithFailingSwitch(store))).run(["次の作業"], io),
    ).catch(() => undefined);

    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("書き込みが失敗しても、実行中が2件になることはない", async () => {
    await startAt9();

    await expect(
      createSwitchCommand(deps(local(10, 30), storeWithFailingSwitch(store))).run(["次の作業"], io),
    ).rejects.toThrow();

    const running = (await store.listByRange(allTime)).filter((entry) => entry.end === undefined);

    expect(running).toHaveLength(1);
    expect(running[0]?.note).toBe("前の作業");
  });

  it("利用者起因ではない書き込みの失敗は UserError にしない（終了コード 2 のまま）", async () => {
    await startAt9();

    await expect(
      createSwitchCommand(deps(local(10, 30), storeWithFailingSwitch(store))).run(["次の作業"], io),
    ).rejects.not.toThrow(UserError);
  });

  it("--at が前の開始より前なら UserError で、記録は何も変わらない", async () => {
    await startAt9();

    await expect(
      createSwitchCommand(deps(local(10, 0))).run(["次の作業", "--at", "08:00"], io),
    ).rejects.toThrow(UserError);

    const entries = await store.listByRange(allTime);

    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("end");
  });

  it("--at が不正なら UserError で、記録は何も変わらない", async () => {
    await startAt9();

    await expect(
      createSwitchCommand(deps(local(10, 0))).run(["次の作業", "--at", "25:00"], io),
    ).rejects.toThrow(UserError);

    expect(await store.findRunning()).toBeDefined();
    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("--at が未来なら UserError で、記録は何も変わらない", async () => {
    await startAt9();

    await expect(
      createSwitchCommand(deps(local(10, 0))).run(["次の作業", "--at", "11:00"], io),
    ).rejects.toThrow(UserError);

    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("失敗したときは何も出力しない（成功したように見えない）", async () => {
    await startAt9();

    await Promise.resolve(
      createSwitchCommand(deps(local(10, 0))).run(["次の作業", "--at", "08:00"], io),
    ).catch(() => undefined);

    expect(out).toEqual([]);
  });
});

describe("switch の引数", () => {
  it.each([
    ["サブコマンドのヘルプ", "--help"],
    ["未知のオプション", "--unknown"],
    ["stop 用のオプション", "--note"],
  ])("%s を渡したら UserError で失敗する", async (_label, token) => {
    await startAt9();

    await expect(createSwitchCommand(deps(local(10, 0))).run([token], io)).rejects.toThrow(
      UserError,
    );
  });

  it("未知のオプションで失敗しても記録は変わらない", async () => {
    await startAt9();

    await Promise.resolve(createSwitchCommand(deps(local(10, 0))).run(["--help"], io)).catch(
      () => undefined,
    );

    expect(await store.findRunning()).toBeDefined();
    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("作業名の中の `/` は弾かない", async () => {
    await startAt9();

    await createSwitchCommand(deps(local(10, 0))).run(["a/b の設計"], io);

    expect((await store.listByRange(allTime))[1]?.note).toBe("a/b の設計");
  });
});

describe("switch を続けて使う", () => {
  it("3回切り替えると3件が隙間なく繋がる", async () => {
    await startAt9();
    await createSwitchCommand(deps(local(10, 0))).run(["2番目"], io);
    await createSwitchCommand(deps(local(11, 0))).run(["3番目"], io);

    const entries = await store.listByRange(allTime);

    expect(entries).toHaveLength(3);
    expect(entries[0]?.end).toBe(entries[1]?.start);
    expect(entries[1]?.end).toBe(entries[2]?.start);
    expect(entries[2]).not.toHaveProperty("end");
  });

  it("切り替えを繰り返しても実行中は常に1件", async () => {
    await startAt9();
    await createSwitchCommand(deps(local(10, 0))).run(["2番目"], io);
    await createSwitchCommand(deps(local(11, 0))).run(["3番目"], io);

    const entries = await store.listByRange(allTime);
    const running = entries.filter((entry) => entry.end === undefined);

    expect(running).toHaveLength(1);
    expect(running[0]?.note).toBe("3番目");
  });
});

// 「巻き戻しにも失敗したとき両方の原因を伝える」describe（3件）はここにあったが、
// #88 で巻き戻しという機構そのものが消えたため、検証対象が存在しなくなった。
// 失敗時に UserError にしないことだけは上の describe に引き継いでいる
