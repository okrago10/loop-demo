/**
 * 利用者が打った値が受け付けられないことを表すエラー。
 *
 * **終了コードの規則を1箇所に置くための型。** これを投げた失敗は、`cli.ts` の `run` が
 * `UserError` / `LockTimeoutError` と並べて終了コード 1（利用者起因）に落とす。
 * 以前は各コマンドが domain の例外を `try` / `catch` で捕まえて `UserError` に翻訳して
 * おり、その3行が10箇所にあった。**書き忘れても画面の文言は変わらず、終了コードだけが
 * 2 に変わる**ため、目視では気づけない（#111）。
 *
 * **不変条件の主張には使わない。** 「実行中のエントリは分割できない」「週のずらしが整数で
 * ない」のような呼び出し側の契約違反は、素の `Error` のまま投げる。そちらは tock の
 * 不具合であり、内部エラー（終了コード 2）として見えなければならない。**この2つを
 * 分けることがこの型の仕事**で、`domain` の例外をまとめて 1 に落とすためのものではない。
 *
 * **domain に置く理由。** `cli.ts` の `UserError` を domain から参照すると依存の向きが
 * 逆になる（`CLAUDE.md`「domain に I/O を置かない」と同じ理由で、domain は上の層を
 * 知らない）。`store/lock.ts` の `LockTimeoutError` と同じ位置づけで、**投げる側が持ち、
 * `cli.ts` が読む。**
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
