import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCommands, buildRuntime, type Command } from "../../src/cli.js";
import { PLAIN_TERMINAL } from "../../src/format/terminal.js";
import { createJsonConfigStore, loadEffectiveConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import { resolveConfigPath, resolveStorePath } from "../../src/store/store.js";

/**
 * **実際に配られるコマンド一覧を見張る（#106）。**
 *
 * #102 で、`readme.test.ts` の突き合わせをソースの文字列読みから外して `buildCommands` を
 * 呼ぶ形にした。そのとき残った穴が、`buildRuntime` が `buildCommands` の結果に手を加えても
 * 誰も気づかないこと——**`--help` に同じコマンドが2回出る状態で 1953 件すべてが通った。**
 *
 * 削除の側は e2e（`--help` に名前が並ぶか）が拾うが、**追加の側は素通りする。**
 * ここでは `buildRuntime` そのものを呼んで、配られる一覧を直接比べる。
 *
 * **実ユーザーの `~/.tock` に触らない。** `buildRuntime` は保存先を
 * `resolveStorePath(env, home)` で決めるので、`env` と `home` を引数で受け取る形にして
 * 一時ディレクトリを渡す（`CLAUDE.md`「テストがユーザーの実際の `~/.tock` を
 * 読み書きしないこと」）。
 */

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-runtime-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 一時ディレクトリだけを見る実行環境。 */
function environmentIn(home: string) {
  return {
    env: { TOCK_DIR: home },
    home,
    terminal: PLAIN_TERMINAL,
    confirm: () => Promise.resolve(false),
    now: () => new Date("2026-08-16T00:00:00Z"),
    newId: () => "runtime-test",
    err: () => undefined,
  };
}

/** `buildCommands` を同じ行き先で直接呼ぶ（比較の相手）。 */
function directCommandsIn(home: string): readonly Command[] {
  const configStore = createJsonConfigStore(resolveConfigPath({ TOCK_DIR: home }, home));

  return buildCommands({
    deps: {
      store: createJsonlStore(resolveStorePath({ TOCK_DIR: home }, home)),
      now: () => new Date("2026-08-16T00:00:00Z"),
      newId: () => "runtime-test",
    },
    configStore,
    loadConfig: () => loadEffectiveConfig(configStore, {}),
    env: {},
    terminal: PLAIN_TERMINAL,
    confirm: () => Promise.resolve(false),
  });
}

function names(commands: readonly Command[]): string[] {
  return commands.map((command) => command.name).toSorted();
}

describe("buildRuntime が配る一覧を見張る（DoD）", () => {
  it("**`buildRuntime` の一覧が `buildCommands` の一覧と一致する**", () => {
    const runtime = buildRuntime(environmentIn(dir));

    expect(names(runtime.commands)).toEqual(names(directCommandsIn(dir)));
  });

  it("一覧が空でない（検査対象ゼロで合格しない）", () => {
    expect(names(buildRuntime(environmentIn(dir)).commands)).not.toEqual([]);
  });

  it("**同じ名前が2回現れない**（重複を足しても気づけるように）", () => {
    const found = names(buildRuntime(environmentIn(dir)).commands);

    expect(found).toEqual([...new Set(found)]);
  });

  it("実行前の警告も組み立てられている（配線の抜けを見つける）", () => {
    expect(buildRuntime(environmentIn(dir)).noticesBeforeRun).toBeTypeOf("function");
  });
});

describe("実ユーザーの ~/.tock に触らない（DoD）", () => {
  it("**`buildRuntime` を呼んでも一時ディレクトリの外にファイルを作らない**", async () => {
    const before = await readdir(dir);

    buildRuntime(environmentIn(dir));

    // 組み立てただけでは何も書かない（読み書きはコマンドを走らせたとき）
    expect(await readdir(dir)).toEqual(before);
  });

  it("保存先が渡した home の下に決まる", () => {
    expect(resolveStorePath({ TOCK_DIR: dir }, dir).startsWith(dir)).toBe(true);
    expect(resolveConfigPath({ TOCK_DIR: dir }, dir).startsWith(dir)).toBe(true);
  });

  it("`TOCK_DIR` が無くても、渡した home の下に決まる（境界: 環境変数なし）", () => {
    expect(resolveStorePath({}, dir).startsWith(dir)).toBe(true);
  });
});

/** 名前だけを持つコマンド。増減・重複・並び替えを作るために使う。 */
function fake(name: string): Command {
  return {
    name,
    summary: `${name} のダミー`,
    usage: { options: [] },
    run: () => undefined,
  };
}

/** 検査の本体。`buildRuntime` の一覧と比較相手を突き合わせる。 */
function problems(runtime: readonly Command[], direct: readonly Command[]): string[] {
  const found: string[] = [];

  if (names(runtime).length === 0) {
    found.push("一覧が空（検査対象ゼロ）");
  }
  if (names(runtime).length !== new Set(names(runtime)).size) {
    found.push("同じ名前が2回ある");
  }
  if (JSON.stringify(names(runtime)) !== JSON.stringify(names(direct))) {
    found.push("一覧が食い違っている");
  }

  return found;
}

describe("突き合わせの向き（境界）", () => {
  it("一致していれば問題なし", () => {
    expect(problems([fake("start"), fake("stop")], [fake("stop"), fake("start")])).toEqual([]);
  });

  it("**1つ多いと落ちる**（この Issue の主対象）", () => {
    const direct = [fake("start"), fake("stop")];

    expect(problems([...direct, fake("switch")], direct)).toContain("一覧が食い違っている");
  });

  it("**1つ足りないと落ちる**", () => {
    const direct = [fake("start"), fake("stop"), fake("switch")];

    expect(problems([fake("start"), fake("stop")], direct)).toContain("一覧が食い違っている");
  });

  it("**同じコマンドが2回登録されていると落ちる**（`--help` に2行出る形）", () => {
    const direct = [fake("start"), fake("stop")];

    expect(problems([...direct, fake("start")], direct)).toContain("同じ名前が2回ある");
  });

  it("両方が空でも素通しせずに落ちる（境界: 0個）", () => {
    expect(problems([], [])).toContain("一覧が空（検査対象ゼロ）");
  });

  it("並び順だけが違う場合は一致とみなす", () => {
    const shuffled = [fake("stop"), fake("switch"), fake("start")];
    const direct = [fake("start"), fake("stop"), fake("switch")];

    expect(problems(shuffled, direct)).toEqual([]);
  });
});
