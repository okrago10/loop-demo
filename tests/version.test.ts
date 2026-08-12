import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { extractVersion, readVersion } from '../src/version.js';

describe('extractVersion', () => {
  it('version フィールドの文字列を返す', () => {
    expect(extractVersion({ version: '0.1.0' })).toBe('0.1.0');
  });

  it('プレリリース版の表記もそのまま返す', () => {
    expect(extractVersion({ version: '1.0.0-rc.1' })).toBe('1.0.0-rc.1');
  });

  it.each([
    ['version が欠落', {}],
    ['version が空文字', { version: '' }],
    ['version が空白のみ', { version: '   ' }],
    ['version が数値', { version: 1 }],
    ['version が null', { version: null }],
  ])('%s の場合は例外を投げる', (_label, pkg) => {
    expect(() => extractVersion(pkg)).toThrow(/version/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'tock'],
    ['配列', []],
  ])('オブジェクトでない入力（%s）は例外を投げる', (_label, pkg) => {
    expect(() => extractVersion(pkg)).toThrow();
  });
});

describe('readVersion', () => {
  it('同梱の package.json の version と一致する', () => {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const expected = (JSON.parse(raw) as { version: string }).version;

    expect(readVersion()).toBe(expected);
  });

  it('空でないバージョン文字列を返す', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
