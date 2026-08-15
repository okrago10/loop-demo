import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sections } from "./readme.js";

/**
 * `CLAUDE.md` の優先度の定義（#67）。
 *
 * **MVP は達成済みなので、「P1 = MVP に必須」という定義は使い切られている。** それでも
 * 2026-08-14 に #58 を P2 → P1 に上げた——`edit` / `rm` がマージされて 36 桁の UUID を
 * 手で打つ場面が実際に生まれたためで、「MVP に必須」という意味ではない。
 *
 * **ループが読むのは `CLAUDE.md` のほう。** #27（バックログ）側には追記済みだが、
 * そちらだけ直しても、`SKILL.md`「2-3. 優先順位」と `CLAUDE.md`「優先度と依存が
 * 矛盾したとき」が古い定義を指したままになる。後者は実際に停止判断を左右している
 * 規則（#18 が #8 に依存していた実例）なので、P1 の意味が曖昧だと停止の基準も曖昧になる。
 *
 * **文言の一致を機械的に見る。** 同じ定義が2箇所（#27 と `CLAUDE.md`）にある以上、
 * 片方だけ直すと食い違う。#27 は GitHub 上にあってテストから読めないので、
 * **#27 の一文をこのファイルに写して突き合わせる**（写した以上、#27 を変えるときは
 * ここも落ちる）。
 */

const CLAUDE_MD = fileURLToPath(new URL("../../CLAUDE.md", import.meta.url));

/**
 * #27「運用ルール」に書かれている定義の一文（2026-08-15 時点）。
 *
 * ここを変えるときは #27 も一緒に変える。逆も同じ。
 */
const DEFINITION_FROM_27 = "MVP 到達までは `P1` = MVP に必須。到達後は `P1` = 次に必ずやるもの";

/** 使い切られた古い定義。これだけが書かれている状態に戻ってはいけない。 */
const OUTDATED_DEFINITION = "- 優先度はタイトルの `[P1]`〜`[P3]`（P1 = MVP に必須）";

async function sectionOf(heading: string): Promise<string> {
  const found = sections(await readFile(CLAUDE_MD, "utf8")).find(
    (section) => section.heading === heading,
  );

  // 見出しごと消えた場合に「本文が空だから検査対象なし」で通さない
  expect(found, `見出しが見つかりません: ${heading}`).toBeDefined();

  return (found?.lines ?? []).join("\n");
}

describe("MVP 到達の前後で P1 の意味が読み取れる（DoD）", () => {
  it("到達前の意味（MVP に必須）が書かれている", async () => {
    const text = await sectionOf("Issue の運用");

    expect(text).toContain("MVP 到達まで");
    expect(text).toContain("MVP に必須");
  });

  it("到達後の意味（次に必ずやるもの）が書かれている", async () => {
    const text = await sectionOf("Issue の運用");

    expect(text).toContain("到達後");
    expect(text).toContain("次に必ずやるもの");
  });

  it("2つの意味が同じ1文で並んでいる（どちらの時期の話か迷わない）", async () => {
    // 別々の段落に散らすと、読んだ人が「いまはどちらか」を組み立てる必要が残る
    const text = await sectionOf("Issue の運用");

    expect(text).toContain(DEFINITION_FROM_27);
  });

  it("使い切られた古い定義だけが残っている状態ではない（回帰）", async () => {
    const text = await sectionOf("Issue の運用");

    expect(text).not.toContain(OUTDATED_DEFINITION);
  });

  it("いまがどちらの時期かも書いてある（達成済みだと分かる）", async () => {
    // 定義が2つあっても、現在地が書かれていなければどちらを使うか決められない
    const text = await sectionOf("Issue の運用");

    expect(text).toContain("達成済み");
  });
});

describe("#27 の運用ルールと文言が一致している（DoD）", () => {
  it("#27 から写した一文がそのまま入っている", async () => {
    expect(await sectionOf("Issue の運用")).toContain(DEFINITION_FROM_27);
  });

  it("定義の出どころ（#27）が示されている", async () => {
    // 同じ定義が2箇所にある以上、どちらが正かを書いておかないと、
    // 食い違ったときにどちらへ寄せるか決められない
    expect(await sectionOf("Issue の運用")).toContain("#27");
  });
});

describe("停止規則が到達後の P1 にも当てはまると分かる（DoD）", () => {
  it("到達後に付けた P1 も対象だと書かれている", async () => {
    const text = await sectionOf("優先度と依存が矛盾したとき");

    expect(text).toContain("到達後");
  });

  it("停止するという結論は変わっていない（回帰）", async () => {
    const text = await sectionOf("優先度と依存が矛盾したとき");

    expect(text).toContain("停止して報告する");
  });

  it("実例（#18 が #8 に依存していた）が残っている（回帰）", async () => {
    // この節が実際に効いた記録。消すと、規則が机上のものに見える
    const text = await sectionOf("優先度と依存が矛盾したとき");

    expect(text).toContain("#18");
    expect(text).toContain("#8");
  });
});

describe("節の取り出しが骨抜きになっていない", () => {
  it("存在しない見出しを引くと落ちる", async () => {
    // sectionOf が黙って空文字を返すなら、上のテストはすべて無意味になる
    await expect(sectionOf("存在しない見出し")).rejects.toThrow();
  });

  it("コードブロックの中の `#` を見出しとして切らない", async () => {
    // `CLAUDE.md` のコードブロックには `# コメント` や `#work` が出てくる。
    // そこで節を切ると、本文が途中で失われて検査が素通りする
    const headings = sections(await readFile(CLAUDE_MD, "utf8")).map((section) => section.heading);

    expect(headings).toContain("Issue の運用");
    expect(headings).toContain("優先度と依存が矛盾したとき");
    expect(headings).not.toContain("work");
  });
});
