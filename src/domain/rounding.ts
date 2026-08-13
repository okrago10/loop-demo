/**
 * 時間の丸め。
 *
 * 工数報告では「15分単位」のような粒度が求められる一方、記録そのものは実測のままで
 * 残しておきたい。そのため**丸めは値を返す純関数として持ち、保存されたデータには
 * 触れない**。集計・表示のときに通す使い方を想定している。
 *
 * どの単位・どのモードを既定にするかは設定の話なので #22 の担当範囲。ここでは
 * 指定された規則どおりに丸めるだけにする。
 */

const MS_PER_MINUTE = 60 * 1000;

/** 丸め方。 */
export type RoundingMode =
  /** 端数があれば次の単位まで上げる。 */
  | "ceil"
  /** 端数を落とす。 */
  | "floor"
  /** 半分以上なら上げ、半分未満なら落とす。 */
  | "nearest";

/** 丸めの規則。 */
export interface RoundingRule {
  /** 丸める単位（分）。正の整数。 */
  readonly unitMinutes: number;
  readonly mode: RoundingMode;
}

/**
 * 長さ（ミリ秒）を規則どおりに丸める。
 *
 * **0 は 0 のまま返す。** `ceil` で 1 単位に上げると、記録していない時間が報告に
 * 載ってしまう。長さ 0 のエントリ（打刻の直後に止めたもの）は実際に存在するため、
 * ここで水増しすると合計が実態と合わなくなる。
 *
 * `nearest` はちょうど半分を**上げる側**に寄せる。どちらに寄せるかを決めておかないと、
 * 同じ入力で結果が変わって見える。
 *
 * 引数を書き換えないので、元のエントリや規則はそのまま残る。
 */
export function roundMs(ms: number, rule: RoundingRule): number {
  assertPositiveInteger(rule.unitMinutes, "丸めの単位");
  assertNonNegativeInteger(ms, "長さ");

  const unit = rule.unitMinutes * MS_PER_MINUTE;
  const remainder = ms % unit;

  if (remainder === 0) {
    return ms;
  }

  const floored = ms - remainder;

  switch (rule.mode) {
    case "floor": {
      return floored;
    }
    case "ceil": {
      return floored + unit;
    }
    case "nearest": {
      return remainder * 2 >= unit ? floored + unit : floored;
    }
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}は正の整数（分）で指定してください: ${String(value)}`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label}はミリ秒の非負整数で指定してください: ${String(value)}`);
  }
}
