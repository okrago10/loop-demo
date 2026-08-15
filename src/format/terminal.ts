/**
 * 出力先の端末の性質（#20）。
 *
 * **注入する。** 幅も TTY かどうかも実行環境で変わるため、直接読むと出力を固定できない
 * （`CLAUDE.md`「環境に依存する値は注入可能にする」）。実際の値を `process.stdout` から
 * 取るのは `cli.ts` の役目。
 */
export interface Terminal {
  /** 出力に使える桁数。 */
  readonly width: number;
  /** 出力先が対話端末か。パイプ・リダイレクトのときは `false`。 */
  readonly isTty: boolean;
}

/**
 * 端末幅が分からないときに使う桁数。
 *
 * パイプやリダイレクトでは `columns` が取れない。**80 にするのは、そこへ書き出した結果を
 * 後から端末で見る可能性が高いため。** 無制限にすると、折り返して読めない行ができる。
 */
export const DEFAULT_WIDTH = 80;

/**
 * バーが潰れないための最小の桁数。
 *
 * これを下回る幅しか残らない場合はバーを描かない。1桁だけのバーは、値の大小を
 * 表せないうえに「0 なのか描けなかったのか」が読み取れない。
 */
export const MIN_BAR_WIDTH = 4;

/** 非 TTY の既定。テストと、書き出し先が端末でない場合に使う。 */
export const PLAIN_TERMINAL: Terminal = { width: DEFAULT_WIDTH, isTty: false };
