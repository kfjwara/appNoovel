'use strict';

// convert.js のテスト。Node（CI）とブラウザ（test/index.html）の両方で動く。
//   Node:    node test/convert.test.js
//   ブラウザ: test/index.html を開くと結果が表示される

(function (global) {
  const isNode = typeof module !== 'undefined' && typeof require === 'function';
  const api = isNode
    ? require('../js/convert.js')
    : { convertText: global.convertText, parseNoovelJSON: global.parseNoovelJSON, pdfPagesToText: global.pdfPagesToText };
  const { convertText, parseNoovelJSON, pdfPagesToText } = api;

  const results = [];
  function t(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: String((e && e.message) || e) }); }
  }
  function eq(got, want, msg) {
    const jg = JSON.stringify(got);
    const jw = JSON.stringify(want);
    if (jg !== jw) throw new Error((msg || '値が違う') + ' expected=' + jw + ' got=' + jg);
  }
  function ok(v, msg) { if (!v) throw new Error(msg || '真であるべき値がfalsy'); }

  // ===== convertText =====

  t('第◯章スタイルで章分割される', () => {
    const { book } = convertText('第一章　始まり\n本文一。\n\n第二章　終わり\n本文二。', 'stem');
    eq(book.chapters.length, 2);
    eq(book.chapters[0].title, '第一章　始まり');
    eq(book.chapters[1].title, '第二章　終わり');
    eq(book.chapters[0].blocks, [{ t: 'p', text: '本文一。' }]);
    eq(book.title, 'stem', '章より前に短行がなければタイトルはファイル名');
  });

  t('前付けからタイトルと著者を拾う', () => {
    const { book } = convertText('マイ小説\n著者: 太郎\n\n第一章　A\n本文。', 'stem');
    eq(book.title, 'マイ小説');
    eq(book.author, '太郎');
    eq(book.chapters.length, 1);
  });

  t('話数表記（#1等・#の直後に空白なし）はタイトルから削らない', () => {
    const { book } = convertText('#1 タイトル名\n\n第一章　A\n本文。', 'stem');
    eq(book.title, '#1 タイトル名');
  });

  t('mdの#一つはタイトル、##が章になる', () => {
    const { book } = convertText('# タイトル\n\n## 章A\n本文a\n\n## 章B\n本文b', 'stem');
    eq(book.title, 'タイトル');
    eq(book.chapters.map(c => c.title), ['章A', '章B']);
    eq(book.chapters[1].blocks, [{ t: 'p', text: '本文b' }]);
  });

  t('記号なしの短行から章を推定して警告を出す', () => {
    const { book, warnings } = convertText(
      'ある日\n\n朝の話。これは本文です。\n\n夜\n\n夜の話。これも本文です。\nおわり。', 'stem');
    eq(book.chapters.length, 2);
    eq(book.chapters[0].title, 'ある日');
    eq(book.chapters[1].title, '夜');
    ok(warnings.some(w => w.includes('推定')), '推定の警告が出ること');
  });

  t('タブ区切りは表になる', () => {
    const { book } = convertText('第一章　表\n名前\t値\nA\t1', 'stem');
    eq(book.chapters[0].blocks, [{ t: 'table', rows: [['名前', '値'], ['A', '1']] }]);
  });

  t('markdownの表になる（区切り行は無視）', () => {
    const { book } = convertText('第一章　表\n| a | b |\n|---|---|\n| 1 | 2 |', 'stem');
    eq(book.chapters[0].blocks, [{ t: 'table', rows: [['a', 'b'], ['1', '2']] }]);
  });

  t('空行2つと区切り線は場面転換、**強調**は除去', () => {
    const { book } = convertText('第一章　A\n本文**強調**あり。\n\n\n次の段。\n---\n最後。', 'stem');
    eq(book.chapters[0].blocks, [
      { t: 'p', text: '本文強調あり。' },
      { t: 'gap', n: 2 },
      { t: 'p', text: '次の段。' },
      { t: 'gap' },
      { t: 'p', text: '最後。' },
    ]);
  });

  t('gapMin:1なら空行1つも大きさ(n)つきで残る', () => {
    const { book } = convertText('第一章　A\n一段目。\n二行目。\n\n二段目。\n\n\n\n三段目。', 'stem', { gapMin: 1 });
    eq(book.chapters[0].blocks, [
      { t: 'p', text: '一段目。' },
      { t: 'p', text: '二行目。' },
      { t: 'gap', n: 1 },
      { t: 'p', text: '二段目。' },
      { t: 'gap', n: 3 },
      { t: 'p', text: '三段目。' },
    ]);
  });

  t('既定(gapMin:2)では空行1つは空きにならない', () => {
    const { book } = convertText('第一章　A\n一段目。\n\n二段目。', 'stem');
    eq(book.chapters[0].blocks, [
      { t: 'p', text: '一段目。' },
      { t: 'p', text: '二段目。' },
    ]);
  });

  t('句読点入りの【】（筆談・メッセージ会話）は章見出しにしない', () => {
    const { book } = convertText(
      '一\n\n本文です。\n【やあ、元気ですか】\n【はい！】\n\n二\n\n本文。おわり。', 'stem');
    eq(book.chapters.map(c => c.title), ['一', '二'], '【】の会話は章にならず数字だけが章になる');
    ok(book.chapters[0].blocks.some(b => b.text === '【はい！】'), '会話行は本文として残ること');
  });

  t('記号だけの短行（場面区切り）は章見出しに推定しない', () => {
    const { book } = convertText(
      '一\n\n一章の本文。これは本文です。\n\n◇\n\n続きの本文。これも本文です。\n\n二\n\n二章の本文。おわり。', 'stem', { gapMin: 1 });
    eq(book.chapters.map(c => c.title), ['一', '二'], '「◇」は章にならず数字だけが章になる');
  });

  t('見出しが無ければ全体を1章にして警告', () => {
    const { book, warnings } = convertText('ただの文です。\nもう一行。', 'テスト');
    eq(book.chapters.length, 1);
    eq(book.chapters[0].blocks.length, 2);
    ok(warnings.length >= 1, '警告が出ること');
  });

  t('巻末の見出し行は章にせず本文に降格', () => {
    const { book } = convertText('第一章　A\n本文。\n第二章', 'stem');
    eq(book.chapters.length, 1);
    eq(book.chapters[0].blocks.map(b => b.text), ['本文。', '第二章']);
  });

  // ===== parseNoovelJSON =====

  t('正しい.noovelを読み込める', () => {
    const raw = JSON.stringify({
      noovel: 1, title: 'T', subtitle: 'S', author: 'A',
      chapters: [{ title: 'C', blocks: [{ t: 'p', text: 'x' }, { t: 'gap' }, { t: 'table', rows: [['a'], ['b']] }] }],
    });
    const r = parseNoovelJSON(raw);
    ok(!r.error, 'エラーにならないこと');
    eq(r.book.title, 'T');
    eq(r.book.author, 'A');
    eq(r.book.chapters[0].blocks.length, 3);
    eq(r.warnings.length, 0);
  });

  t('gapのn（空きの大きさ）は検証を通っても保持される', () => {
    const r = parseNoovelJSON(JSON.stringify({
      noovel: 1, title: 'T',
      chapters: [{ title: 'C', blocks: [{ t: 'p', text: 'a' }, { t: 'gap', n: 3 }, { t: 'p', text: 'b' }] }],
    }));
    ok(!r.error);
    eq(r.book.chapters[0].blocks[1], { t: 'gap', n: 3 });
  });

  t('簡易形（textを改行区切りで持つ）も読める', () => {
    const r = parseNoovelJSON(JSON.stringify({ noovel: 1, title: 'T', chapters: [{ title: 'C', text: 'a\nb' }] }));
    eq(r.book.chapters[0].blocks, [{ t: 'p', text: 'a' }, { t: 'p', text: 'b' }]);
  });

  t('titleが無ければエラー', () => {
    const r = parseNoovelJSON(JSON.stringify({ noovel: 1, chapters: [{ title: 'C', text: 'a' }] }));
    ok(r.error, 'エラーになること');
  });

  t('chaptersが無ければエラー', () => {
    const r = parseNoovelJSON(JSON.stringify({ noovel: 1, title: 'T' }));
    ok(r.error, 'エラーになること');
  });

  t('JSONでなければエラー', () => {
    const r = parseNoovelJSON('これはJSONではない');
    ok(r.error, 'エラーになること');
  });

  t('未知のブロックは飛ばして警告', () => {
    const r = parseNoovelJSON(JSON.stringify({
      noovel: 1, title: 'T',
      chapters: [{ title: 'C', blocks: [{ t: 'x', text: 'a' }, { t: 'p', text: 'b' }] }],
    }));
    ok(!r.error);
    eq(r.book.chapters[0].blocks, [{ t: 'p', text: 'b' }]);
    ok(r.warnings.some(w => w.includes('未知')), '警告が出ること');
  });

  t('バージョン宣言が無ければ警告（エラーにはしない）', () => {
    const r = parseNoovelJSON(JSON.stringify({ title: 'T', chapters: [{ title: 'C', text: 'a' }] }));
    ok(!r.error);
    ok(r.warnings.length >= 1);
  });

  // ===== pdfPagesToText =====

  t('PDF: 同じy座標の断片は1行に結合、字下げで新しい段落', () => {
    const text = pdfPagesToText([[
      { str: '一行目です', x: 10, y: 700 },
      { str: 'つづき', x: 80, y: 700 },
      { str: '　字下げ段落', x: 10, y: 660 },
    ]]);
    eq(text, '一行目ですつづき\n\n字下げ段落');
  });

  // ===== 結果の出力 =====
  const failed = results.filter(r => !r.ok);
  global.CONVERT_TEST_RESULTS = results;

  if (isNode && require.main === module) {
    for (const r of results) {
      console.log((r.ok ? 'ok    ' : 'FAIL  ') + r.name + (r.ok ? '' : '\n      ' + r.err));
    }
    console.log('----');
    console.log(results.length + ' tests, ' + failed.length + ' failed');
    process.exit(failed.length ? 1 : 0);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
