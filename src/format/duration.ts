const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * 長さを人間が読める形に整える（`1h 23m` など）。
 *
 * 端数は**切り捨てる**。四捨五入や丸め単位の指定は #7 の担当範囲なので、ここで
 * 独自の丸め方を持ち込まない。
 *
 * 1 分未満は秒で表す。`0m` にすると「短すぎて記録されなかった」ように見えるが、
 * 実際には記録されているため、秒を見せて情報を落とさない。
 *
 * 日には繰り上げない（25 時間は `25h`）。日をまたぐ表示は集計側（#18 / #19）が
 * 日単位に分割してから扱う想定なので、ここで日を導入すると二重になる。
 */
export function formatDuration(ms: number): string {
  if (Number.isNaN(ms)) {
    throw new Error("長さが NaN です");
  }
  if (!Number.isInteger(ms)) {
    throw new Error(`長さがミリ秒の整数ではありません: ${String(ms)}`);
  }
  if (ms < 0) {
    throw new Error(`長さが負です: ${String(ms)}`);
  }

  if (ms < MS_PER_MINUTE) {
    return `${String(Math.floor(ms / MS_PER_SECOND))}s`;
  }

  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);

  if (hours === 0) {
    return `${String(minutes)}m`;
  }
  if (minutes === 0) {
    return `${String(hours)}h`;
  }

  return `${String(hours)}h ${String(minutes)}m`;
}
