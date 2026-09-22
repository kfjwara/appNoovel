'use strict';

// chapters.js のテスト。Node（CI）とブラウザ（test/index.html）の両方で動く。
//   Node:    node test/chapters.test.js
//   ブラウザ: test/index.html を開くと結果が表示される

(function (global) {
  const isNode = typeof module !== 'undefined' && typeof require === 'function';
  const api = isNode ? require('../js/chapters.js') : global;
  const {
    splitChapter, mergeChapter, mergeOffset, renameChapter,
    deleteBlock, insertBlock, deleteRemovesChapter,
    remapAnchor, remapAnchors, clampAnchor, isEffectiveStart,
  } = api;

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
  function throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || '例外が出るべき');
  }

  const P = text => ({ t: 'p', text });
  const G = n => (n ? { t: 'gap', n } : { t: 'gap' });

  // 素材：1章6ブロック（gap 混在）＋2章目
  function sample() {
    return [
      { title: '第一章', blocks: [P('a0'), P('a1'), G(2), P('a3'), P('a4'), P('a5')] },
      { title: '第二章', blocks: [P('b0'), P('b1')] },
    ];
  }

  // ===== splitChapter =====

  t('split: 既定(keepBlock=false)は分割点のブロックが見出しに昇格して消える', () => {
    const out = splitChapter(sample(), 0, 3, { title: '第一章の二' });
    eq(out.length, 3);
    eq(out[0].title, '第一章');
    eq(out[0].blocks, [P('a0'), P('a1'), G(2)]);
    eq(out[1].title, '第一章の二');
    eq(out[1].blocks, [P('a4'), P('a5')], 'a3 は見出しに消費される');
    eq(out[2].title, '第二章', '後ろの章はそのまま1つ後ろへ');
  });

  t('split: title 省略なら分割点ブロックの text が見出しになる', () => {
    eq(splitChapter(sample(), 0, 3, {})[1].title, 'a3');
  });

  t('split: keepBlock=true は分割点のブロックを本文に残す', () => {
    const out = splitChapter(sample(), 0, 3, { title: 'X', keepBlock: true });
    eq(out[0].blocks, [P('a0'), P('a1'), G(2)]);
    eq(out[1].blocks, [P('a3'), P('a4'), P('a5')]);
    eq(out[1].title, 'X');
  });

  t('split: i=1（先頭の次）でも通る', () => {
    const out = splitChapter(sample(), 0, 1, { title: 'X' });
    eq(out[0].blocks, [P('a0')]);
    eq(out[1].blocks, [G(2), P('a3'), P('a4'), P('a5')]);
  });

  t('split: 末尾ブロックで分けると見出しだけの章になる（許容）', () => {
    const out = splitChapter(sample(), 0, 5, { title: 'X' });
    eq(out[0].blocks.length, 5);
    eq(out[1].blocks, []);
  });

  t('split: i=0 / 範囲外 / 非整数 は例外', () => {
    throws(() => splitChapter(sample(), 0, 0, {}), 'i=0');
    throws(() => splitChapter(sample(), 0, 6, {}), 'i=blocks.length');
    throws(() => splitChapter(sample(), 0, 1.5, {}), '非整数');
    throws(() => splitChapter(sample(), 9, 1, {}), '章が範囲外');
  });

  t('split: 入力の chapters / blocks を書き換えない', () => {
    const src = sample();
    const snap = JSON.stringify(src);
    splitChapter(src, 0, 3, { title: 'X' });
    eq(JSON.stringify(src), snap, '入力は不変');
  });

  // ===== mergeChapter / mergeOffset =====

  t('merge: c章が c-1章の末尾にくっつく', () => {
    const out = mergeChapter(sample(), 1, {});
    eq(out.length, 1);
    eq(out[0].title, '第一章');
    eq(out[0].blocks, [P('a0'), P('a1'), G(2), P('a3'), P('a4'), P('a5'), P('b0'), P('b1')]);
    eq(mergeOffset(sample(), 1, {}), 6);
  });

  t('merge: restoreTitle=true は消える見出しを p 段落として継ぎ目に戻す', () => {
    const out = mergeChapter(sample(), 1, { restoreTitle: true });
    eq(out[0].blocks[6], P('第二章'));
    eq(out[0].blocks.length, 9);
    eq(mergeOffset(sample(), 1, { restoreTitle: true }), 7);
  });

  t('merge: 見出しが空なら restoreTitle でも段落は足さない', () => {
    const src = [{ title: 'A', blocks: [P('a')] }, { title: '', blocks: [P('b')] }];
    eq(mergeChapter(src, 1, { restoreTitle: true })[0].blocks, [P('a'), P('b')]);
    eq(mergeOffset(src, 1, { restoreTitle: true }), 1);
  });

  t('merge: c=0 / 範囲外 は例外', () => {
    throws(() => mergeChapter(sample(), 0, {}), 'c=0');
    throws(() => mergeChapter(sample(), 5, {}), '範囲外');
    throws(() => mergeOffset(sample(), 0, {}), 'c=0');
  });

  t('merge: 入力を書き換えない', () => {
    const src = sample();
    const snap = JSON.stringify(src);
    mergeChapter(src, 1, { restoreTitle: true });
    eq(JSON.stringify(src), snap);
  });

  // ===== renameChapter =====

  t('rename: 見出しだけ差し替わり blocks は同一', () => {
    const src = sample();
    const out = renameChapter(src, 1, '  新しい名前  ');
    eq(out[1].title, '新しい名前');
    eq(out[1].blocks, src[1].blocks);
    eq(out[0], src[0]);
    eq(src[1].title, '第二章', '入力は不変');
  });

  t('rename: 範囲外は例外', () => {
    throws(() => renameChapter(sample(), 9, 'x'));
  });

  t('remap/rename: アンカーは一切動かない（no-op）', () => {
    const op = { type: 'rename', c: 1 };
    const anchors = [
      { ch: 0, blk: 0, at: 1 }, { ch: 1, blk: 3, at: 2 },
      { ch: 2, blk: 0, at: 3 }, { ch: 1, ratio: 0.4 },
    ];
    anchors.forEach(a => eq(remapAnchor(a, op), a, JSON.stringify(a)));
    const chapters = sample();
    eq(remapAnchors([{ ch: 1, blk: 1, at: 9 }], op, chapters), [{ ch: 1, blk: 1, at: 9 }]);
  });

  t('remap: 知らない op でもアンカーを壊さない', () => {
    eq(remapAnchor({ ch: 2, blk: 5, at: 1 }, { type: 'nope' }), { ch: 2, blk: 5, at: 1 });
    eq(remapAnchor({ ch: 2, blk: 5 }, null), { ch: 2, blk: 5 });
  });

  // ===== deleteBlock / insertBlock =====

  t('delete: ブロックが1つ消え、残りは詰まる', () => {
    const out = deleteBlock(sample(), 0, 3);
    eq(out.length, 2, '章の数は変わらない');
    eq(out[0].blocks, [P('a0'), P('a1'), G(2), P('a4'), P('a5')]);
    eq(out[1], sample()[1], '他の章はそのまま');
  });

  t('delete: gap も消せる（余白を詰める用途）', () => {
    eq(deleteBlock(sample(), 0, 2)[0].blocks, [P('a0'), P('a1'), P('a3'), P('a4'), P('a5')]);
  });

  t('delete: 空になった章は消える（章が2つ以上あるとき）', () => {
    const src = [{ title: 'A', blocks: [P('a')] }, { title: 'B', blocks: [P('b0'), P('b1')] }];
    ok(deleteRemovesChapter(src, 0), '章ごと消える判定');
    const out = deleteBlock(src, 0, 0);
    eq(out.length, 1);
    eq(out[0].title, 'B');
  });

  t('delete: 章が1つだけなら空 blocks で残す（本を消さない）', () => {
    const src = [{ title: 'A', blocks: [P('a')] }];
    ok(!deleteRemovesChapter(src, 0), '章は消さない判定');
    const out = deleteBlock(src, 0, 0);
    eq(out.length, 1);
    eq(out[0], { title: 'A', blocks: [] });
  });

  t('delete: 範囲外・非整数は例外／入力は不変', () => {
    throws(() => deleteBlock(sample(), 0, -1));
    throws(() => deleteBlock(sample(), 0, 6));
    throws(() => deleteBlock(sample(), 0, 1.5));
    throws(() => deleteBlock(sample(), 9, 0));
    const src = sample();
    const snap = JSON.stringify(src);
    deleteBlock(src, 0, 3);
    eq(JSON.stringify(src), snap);
  });

  t('insert: 指定位置に差し込む／末尾にも入る', () => {
    eq(insertBlock(sample(), 0, 3, P('NEW'))[0].blocks,
      [P('a0'), P('a1'), G(2), P('NEW'), P('a3'), P('a4'), P('a5')]);
    eq(insertBlock(sample(), 1, 2, P('NEW'))[1].blocks, [P('b0'), P('b1'), P('NEW')]);
  });

  t('insert: asNewChapter で章ごと作り直す', () => {
    const src = [{ title: 'B', blocks: [P('b0')] }];
    const out = insertBlock(src, 0, 0, P('a'), { asNewChapter: true, title: 'A' });
    eq(out.map(c => c.title), ['A', 'B']);
    eq(out[0].blocks, [P('a')]);
    // 末尾に章を戻す
    eq(insertBlock(src, 1, 0, P('z'), { asNewChapter: true, title: 'Z' }).map(c => c.title), ['B', 'Z']);
  });

  t('insert: 範囲外は例外／入力は不変', () => {
    throws(() => insertBlock(sample(), 0, 99, P('x')));
    throws(() => insertBlock(sample(), 9, 0, P('x')));
    throws(() => insertBlock(sample(), 0, 0, null));
    throws(() => insertBlock(sample(), 5, 0, P('x'), { asNewChapter: true }));
    const src = sample();
    const snap = JSON.stringify(src);
    insertBlock(src, 0, 3, P('x'));
    eq(JSON.stringify(src), snap);
  });

  t('往復: delete → insert でブロック列が完全に戻る', () => {
    const src = sample();
    for (let i = 0; i < src[0].blocks.length; i++) {
      const removed = src[0].blocks[i];
      const back = insertBlock(deleteBlock(src, 0, i), 0, i, removed);
      eq(back, src, 'i=' + i);
    }
  });

  t('往復: 章ごと消えた場合も asNewChapter で戻る', () => {
    const src = [{ title: 'A', blocks: [P('a')] }, { title: 'B', blocks: [P('b')] }];
    const gone = deleteBlock(src, 0, 0);
    eq(gone.length, 1);
    eq(insertBlock(gone, 0, 0, P('a'), { asNewChapter: true, title: 'A' }), src);
  });

  // ===== remapAnchor: delete / insert =====

  const DEL = { type: 'delete', c: 1, i: 2, chapterRemoved: false };

  t('remap/delete: 他の章は動かない', () => {
    eq(remapAnchor({ ch: 0, blk: 5 }, DEL), { ch: 0, blk: 5 });
    eq(remapAnchor({ ch: 2, blk: 0 }, DEL), { ch: 2, blk: 0 });
  });

  t('remap/delete: 消した位置より前はそのまま、後ろは -1', () => {
    eq(remapAnchor({ ch: 1, blk: 0 }, DEL), { ch: 1, blk: 0 });
    eq(remapAnchor({ ch: 1, blk: 1 }, DEL), { ch: 1, blk: 1 });
    eq(remapAnchor({ ch: 1, blk: 3 }, DEL), { ch: 1, blk: 2 });
    eq(remapAnchor({ ch: 1, blk: 9, at: 7 }, DEL), { ch: 1, blk: 8, at: 7 });
  });

  t('remap/delete: blk===i は同じ番号のまま（＝次の段落を指す）', () => {
    eq(remapAnchor({ ch: 1, blk: 2, at: 1 }, DEL), { ch: 1, blk: 2, at: 1 });
  });

  t('remap/delete: 末尾を消したアンカーは clamp で手前に寄る', () => {
    const chapters = [{ title: 'c0', blocks: [P('x0'), P('x1'), P('x2')] }];
    const op = { type: 'delete', c: 0, i: 2, chapterRemoved: false };
    const next = deleteBlock(chapters, 0, 2);
    eq(remapAnchors([{ ch: 0, blk: 2 }], op, next), [{ ch: 0, blk: 1 }]);
  });

  t('remap/delete: 章ごと消えたら後ろの章は -1、その章のアンカーは前章の末尾へ', () => {
    const op = { type: 'delete', c: 1, i: 0, chapterRemoved: true, prevLen: 4 };
    eq(remapAnchor({ ch: 0, blk: 1 }, op), { ch: 0, blk: 1 });
    eq(remapAnchor({ ch: 1, blk: 0, at: 5 }, op), { ch: 0, blk: 3, at: 5 });
    eq(remapAnchor({ ch: 2, blk: 1 }, op), { ch: 1, blk: 1 });
    eq(remapAnchor({ ch: 1, ratio: 0.5 }, op), { ch: 0, ratio: 0.5 }, 'blk 無しは ch だけ');
  });

  t('remap/delete: 先頭章が丸ごと消えたら新しい先頭へ', () => {
    const op = { type: 'delete', c: 0, i: 0, chapterRemoved: true, prevLen: 0 };
    eq(remapAnchor({ ch: 0, blk: 0, at: 1 }, op), { ch: 0, blk: 0, at: 1 });
    eq(remapAnchor({ ch: 1, blk: 3 }, op), { ch: 0, blk: 3 });
  });

  const INS = { type: 'insert', c: 1, i: 2, newChapter: false };

  t('remap/insert: 差し込み位置以降が +1、それ以外は動かない', () => {
    eq(remapAnchor({ ch: 1, blk: 1 }, INS), { ch: 1, blk: 1 });
    eq(remapAnchor({ ch: 1, blk: 2 }, INS), { ch: 1, blk: 3 });
    eq(remapAnchor({ ch: 1, blk: 5, at: 3 }, INS), { ch: 1, blk: 6, at: 3 });
    eq(remapAnchor({ ch: 0, blk: 5 }, INS), { ch: 0, blk: 5 });
    eq(remapAnchor({ ch: 2, blk: 0 }, INS), { ch: 2, blk: 0 });
  });

  t('remap/insert: 章ごと戻したら c 以降の章は +1', () => {
    const op = { type: 'insert', c: 1, i: 0, newChapter: true };
    eq(remapAnchor({ ch: 0, blk: 2 }, op), { ch: 0, blk: 2 });
    eq(remapAnchor({ ch: 1, blk: 0 }, op), { ch: 2, blk: 0 });
    eq(remapAnchor({ ch: 3, blk: 1 }, op), { ch: 4, blk: 1 });
  });

  t('remap: delete → insert はブロック内の付け替えとして逆写像になる', () => {
    const chapters = [{ title: 'c0', blocks: [P('x0'), P('x1'), P('x2'), P('x3')] }];
    const marks = [
      { ch: 0, blk: 0, at: 1 }, { ch: 0, blk: 1, at: 2 },
      { ch: 0, blk: 2, at: 3 }, { ch: 0, blk: 3, at: 4 },
    ];
    const delOp = { type: 'delete', c: 0, i: 1, chapterRemoved: false };
    const afterDel = deleteBlock(chapters, 0, 1);
    const aDel = remapAnchors(marks, delOp, afterDel);
    eq(aDel, [
      { ch: 0, blk: 0, at: 1 },
      { ch: 0, blk: 1, at: 2 },   // 消えた段落を指していたので「次」を指す
      { ch: 0, blk: 1, at: 3 },
      { ch: 0, blk: 2, at: 4 },
    ]);
    const afterIns = insertBlock(afterDel, 0, 1, P('x1'));
    eq(afterIns, chapters, 'ブロック列は完全に戻る');
    eq(remapAnchors(aDel, { type: 'insert', c: 0, i: 1, newChapter: false }, afterIns), [
      { ch: 0, blk: 0, at: 1 },
      { ch: 0, blk: 2, at: 2 },   // 消えた段落そのものを指していた1件だけは戻らない（既知）
      { ch: 0, blk: 2, at: 3 },
      { ch: 0, blk: 3, at: 4 },
    ]);
  });

  // ===== remapAnchor: split =====

  const SP = { type: 'split', c: 1, i: 3, keepBlock: false };

  t('remap/split: 前の章はそのまま、後ろの章は +1', () => {
    eq(remapAnchor({ ch: 0, blk: 4 }, SP), { ch: 0, blk: 4 });
    eq(remapAnchor({ ch: 2, blk: 4 }, SP), { ch: 3, blk: 4 });
  });

  t('remap/split: 分割点より前のブロックは動かない', () => {
    eq(remapAnchor({ ch: 1, blk: 0 }, SP), { ch: 1, blk: 0 });
    eq(remapAnchor({ ch: 1, blk: 2 }, SP), { ch: 1, blk: 2 });
  });

  t('remap/split: blk===i（見出しに昇格したブロック）は新章の先頭', () => {
    eq(remapAnchor({ ch: 1, blk: 3 }, SP), { ch: 2, blk: 0 });
  });

  t('remap/split: 分割点より後ろは新章で blk-i-1', () => {
    eq(remapAnchor({ ch: 1, blk: 4 }, SP), { ch: 2, blk: 0 });
    eq(remapAnchor({ ch: 1, blk: 5 }, SP), { ch: 2, blk: 1 });
  });

  t('remap/split: keepBlock=true なら blk-i（ブロックは消えない）', () => {
    const op = { type: 'split', c: 1, i: 3, keepBlock: true };
    eq(remapAnchor({ ch: 1, blk: 3 }, op), { ch: 2, blk: 0 });
    eq(remapAnchor({ ch: 1, blk: 5 }, op), { ch: 2, blk: 2 });
    eq(remapAnchor({ ch: 1, blk: 2 }, op), { ch: 1, blk: 2 });
  });

  t('remap/split: blk を持たない位置は ch だけ動く（分割章は前半に残る）', () => {
    eq(remapAnchor({ ch: 1, ratio: 0.5 }, SP), { ch: 1, ratio: 0.5 });
    eq(remapAnchor({ ch: 2, ratio: 0.5 }, SP), { ch: 3, ratio: 0.5 });
  });

  t('remap/split: at など他のフィールドは持ち越す', () => {
    eq(remapAnchor({ ch: 1, blk: 5, at: 123 }, SP), { ch: 2, blk: 1, at: 123 });
  });

  // ===== remapAnchor: merge =====

  const MG = { type: 'merge', c: 1, off: 6 };

  t('remap/merge: 結合先(c-1)とそれ以前はそのまま', () => {
    eq(remapAnchor({ ch: 0, blk: 2 }, MG), { ch: 0, blk: 2 });
  });

  t('remap/merge: 消える章は c-1 へ、blk は +off', () => {
    eq(remapAnchor({ ch: 1, blk: 0 }, MG), { ch: 0, blk: 6 });
    eq(remapAnchor({ ch: 1, blk: 1 }, MG), { ch: 0, blk: 7 });
  });

  t('remap/merge: 後ろの章は -1', () => {
    eq(remapAnchor({ ch: 2, blk: 3 }, MG), { ch: 1, blk: 3 });
  });

  t('remap/merge: blk 無しは ch だけ', () => {
    eq(remapAnchor({ ch: 1, ratio: 0.3 }, MG), { ch: 0, ratio: 0.3 });
  });

  // ===== split → merge の往復 =====

  t('往復: keepBlock=true は chapters もアンカーも完全に元へ戻る', () => {
    const src = sample();
    const anchors = [
      { ch: 0, blk: 0, at: 1 }, { ch: 0, blk: 2, at: 2 }, { ch: 0, blk: 3, at: 3 },
      { ch: 0, blk: 5, at: 4 }, { ch: 1, blk: 0, at: 5 }, { ch: 1, blk: 1, at: 6 },
    ];
    const afterS = splitChapter(src, 0, 3, { title: 'X', keepBlock: true });
    const aS = remapAnchors(anchors, { type: 'split', c: 0, i: 3, keepBlock: true }, afterS);

    const off = mergeOffset(afterS, 1, {});
    eq(off, 3, '戻すときのオフセット＝分割点 i');
    const afterM = mergeChapter(afterS, 1, {});
    const aM = remapAnchors(aS, { type: 'merge', c: 1, off }, afterM);

    eq(afterM.map(c => c.blocks), src.map(c => c.blocks), 'ブロックが元通り');
    eq(aM, anchors, 'アンカーも元通り');
  });

  t('往復: keepBlock=false + restoreTitle でブロックの中身は元へ戻る', () => {
    const src = sample();
    const afterS = splitChapter(src, 0, 3, {});          // a3 が見出しになる
    eq(afterS[1].title, 'a3');
    const afterM = mergeChapter(afterS, 1, { restoreTitle: true });
    eq(afterM.map(c => c.blocks), src.map(c => c.blocks), 'a3 が段落として復元される');
    eq(afterM[0].title, '第一章');
  });

  t('往復: keepBlock=false のアンカーは「見出しになった段落」だけ1つ後ろへずれる（既知の非対称）', () => {
    const afterS = splitChapter(sample(), 0, 3, {});
    const aS = remapAnchors([{ ch: 0, blk: 3 }, { ch: 0, blk: 4 }],
      { type: 'split', c: 0, i: 3, keepBlock: false }, afterS);
    eq(aS, [{ ch: 1, blk: 0 }, { ch: 1, blk: 0 }]);
    const off = mergeOffset(afterS, 1, { restoreTitle: true });
    const afterM = mergeChapter(afterS, 1, { restoreTitle: true });
    eq(remapAnchors(aS, { type: 'merge', c: 1, off }, afterM),
      [{ ch: 0, blk: 4 }, { ch: 0, blk: 4 }], '復元見出しは index 3、本文は 4 に来る');
  });

  // ===== 複数章にまたがる しおり の一括付け替え =====

  t('remapAnchors: 3章ぶんのしおりが split で正しく散る', () => {
    const chapters = [
      { title: 'c0', blocks: [P('x0'), P('x1')] },
      { title: 'c1', blocks: [P('y0'), P('y1'), P('y2'), P('y3')] },
      { title: 'c2', blocks: [P('z0')] },
    ];
    const marks = [
      { ch: 0, blk: 1, at: 1 }, { ch: 1, blk: 0, at: 2 }, { ch: 1, blk: 2, at: 3 },
      { ch: 1, blk: 3, at: 4 }, { ch: 2, blk: 0, at: 5 },
    ];
    const next = splitChapter(chapters, 1, 2, { title: 'NEW' });
    eq(next.map(c => c.title), ['c0', 'c1', 'NEW', 'c2']);
    eq(next[1].blocks, [P('y0'), P('y1')]);
    eq(next[2].blocks, [P('y3')]);
    eq(remapAnchors(marks, { type: 'split', c: 1, i: 2, keepBlock: false }, next), [
      { ch: 0, blk: 1, at: 1 },
      { ch: 1, blk: 0, at: 2 },
      { ch: 2, blk: 0, at: 3 },   // y2 は見出しへ → 新章の先頭
      { ch: 2, blk: 0, at: 4 },   // y3 は新章の 0 番
      { ch: 3, blk: 0, at: 5 },
    ]);
  });

  t('remapAnchors: keepBlock=true の split は 1ブロックも消えない', () => {
    const chapters = [
      { title: 'c0', blocks: [P('x0'), P('x1')] },
      { title: 'c1', blocks: [P('y0'), P('y1'), P('y2'), P('y3')] },
      { title: 'c2', blocks: [P('z0')] },
    ];
    const marks = [
      { ch: 0, blk: 1, at: 1 }, { ch: 1, blk: 0, at: 2 }, { ch: 1, blk: 1, at: 3 },
      { ch: 1, blk: 2, at: 4 }, { ch: 1, blk: 3, at: 5 }, { ch: 2, blk: 0, at: 6 },
    ];
    const next = splitChapter(chapters, 1, 2, { title: 'NEW', keepBlock: true });
    eq(next.map(c => c.title), ['c0', 'c1', 'NEW', 'c2']);
    eq(next[1].blocks, [P('y0'), P('y1')]);
    eq(next[2].blocks, [P('y2'), P('y3')], '分割点のブロックは新章の先頭に残る');
    eq(remapAnchors(marks, { type: 'split', c: 1, i: 2, keepBlock: true }, next), [
      { ch: 0, blk: 1, at: 1 },
      { ch: 1, blk: 0, at: 2 },
      { ch: 1, blk: 1, at: 3 },
      { ch: 2, blk: 0, at: 4 },   // y2 は新章の 0 番（消えない）
      { ch: 2, blk: 1, at: 5 },   // y3 は新章の 1 番
      { ch: 3, blk: 0, at: 6 },
    ]);
    // ブロックの総数が変わらない＝1つも消えていない
    const total = cs => cs.reduce((s, ch) => s + ch.blocks.length, 0);
    eq(total(next), total(chapters));
  });

  t('remapAnchors: 3章ぶんのしおりが merge で正しく寄る', () => {
    const chapters = [
      { title: 'c0', blocks: [P('x0'), P('x1')] },
      { title: 'c1', blocks: [P('y0'), P('y1')] },
      { title: 'c2', blocks: [P('z0')] },
    ];
    const marks = [
      { ch: 0, blk: 1, at: 1 }, { ch: 1, blk: 0, at: 2 },
      { ch: 1, blk: 1, at: 3 }, { ch: 2, blk: 0, at: 4 },
    ];
    const off = mergeOffset(chapters, 1, { restoreTitle: true });
    eq(off, 3, '前章2ブロック + 戻した見出し1');
    const next = mergeChapter(chapters, 1, { restoreTitle: true });
    eq(next.map(c => c.title), ['c0', 'c2']);
    eq(next[0].blocks, [P('x0'), P('x1'), P('c1'), P('y0'), P('y1')]);
    eq(remapAnchors(marks, { type: 'merge', c: 1, off }, next), [
      { ch: 0, blk: 1, at: 1 },
      { ch: 0, blk: 3, at: 2 },
      { ch: 0, blk: 4, at: 3 },
      { ch: 1, blk: 0, at: 4 },
    ]);
  });

  // ===== clampAnchor =====

  t('clamp: 末尾ブロックで分けて空章になっても blk は 0 に丸まる', () => {
    const chapters = [{ title: 'c0', blocks: [P('x0'), P('x1'), P('x2')] }];
    const next = splitChapter(chapters, 0, 2, { title: 'X' });
    eq(next[1].blocks, []);
    eq(remapAnchors([{ ch: 0, blk: 2 }], { type: 'split', c: 0, i: 2, keepBlock: false }, next),
      [{ ch: 1, blk: 0 }]);
  });

  t('clamp: 範囲外の ch / blk は端に丸まる', () => {
    const chapters = [{ title: 'c0', blocks: [P('x0'), P('x1')] }];
    eq(clampAnchor(chapters, { ch: 5, blk: 9 }), { ch: 0, blk: 1 });
    eq(clampAnchor(chapters, { ch: -1, blk: -3 }), { ch: 0, blk: 0 });
  });

  // ===== isEffectiveStart =====

  t('isEffectiveStart: blk=0 と 前が gap だけの位置は先頭扱い', () => {
    const blocks = [G(2), G(), P('a'), P('b')];
    ok(isEffectiveStart(blocks, 0), 'blk=0');
    ok(isEffectiveStart(blocks, 1), 'gap のみ');
    ok(isEffectiveStart(blocks, 2), 'gap 2つのあと＝実質先頭');
    ok(!isEffectiveStart(blocks, 3), '本文のあとは先頭ではない');
  });

  t('isEffectiveStart: 本文が先にあれば先頭ではない', () => {
    const blocks = [P('a'), G(2), P('b')];
    ok(!isEffectiveStart(blocks, 1));
    ok(!isEffectiveStart(blocks, 2));
  });

  // ===== 結果の出力 =====
  const failed = results.filter(r => !r.ok);
  global.CHAPTERS_TEST_RESULTS = results;

  if (isNode && require.main === module) {
    for (const r of results) {
      console.log((r.ok ? 'ok    ' : 'FAIL  ') + r.name + (r.ok ? '' : '\n      ' + r.err));
    }
    console.log('----');
    console.log(results.length + ' tests, ' + failed.length + ' failed');
    process.exit(failed.length ? 1 : 0);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
