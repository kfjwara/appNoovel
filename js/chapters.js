'use strict';

// ===== 章の手動編集（純関数） =====
// 章は noovel.chapters = [{title, blocks}] の「配列の位置」がアイデンティティなので、
// 分割・結合をすると しおり/マーカー {ch, blk} と読書位置 bm_<id> {chapter, blk} が全部ズレる。
// そこで「chapters を作り替える純関数」と「アンカーを同じ規則で付け替える純関数」を対で置く。
// 永続化（dbPut・localStorage・再描画）は app.js の applyChapterOp が受け持つ。
//
//   splitChapter(chapters, c, i, opts)  → 新しい chapters（c章を i ブロックで二分）
//   mergeChapter(chapters, c, opts)     → 新しい chapters（c章を c-1章に結合）
//   mergeOffset(chapters, c, opts)      → 結合で c章のブロックがずれる量（op に入れる）
//   renameChapter(chapters, c, title)   → 新しい chapters
//   remapAnchor(anchor, op)             → 付け替えた {ch, blk, ...}
//
// op: { type:'split', c, i, keepBlock } / { type:'merge', c, off }
// 入力の chapters・blocks・ブロックは一切書き換えない（新しい配列を返す）。

function chapterOpError(msg) {
  const e = new Error(msg);
  e.chapterOp = true;
  return e;
}

// c章を i ブロック目で二分し、後半を新しい章にする。
// keepBlock=false（既定）: i番目のブロックを見出しに消費する（title 省略時はその text が見出し）
// keepBlock=true:          i番目のブロックは本文に残し、見出しは opts.title を使う
function splitChapter(chapters, c, i, opts) {
  const o = opts || {};
  if (!Array.isArray(chapters) || !chapters[c]) throw chapterOpError('章番号が範囲外です');
  const blocks = chapters[c].blocks || [];
  // i=0 は「章の先頭で分ける」＝何も起きないので不正。末尾ブロックでの分割は見出しだけの章になるが許す
  if (!Number.isInteger(i) || i < 1 || i > blocks.length - 1) {
    throw chapterOpError('ここでは章を分けられません');
  }
  const head = blocks[i];
  const given = o.title == null ? '' : String(o.title).trim();
  const title = given || (!o.keepBlock && head && head.text ? String(head.text).trim() : '');
  const out = chapters.slice();
  out[c] = { ...chapters[c], blocks: blocks.slice(0, i) };
  out.splice(c + 1, 0, { title, blocks: o.keepBlock ? blocks.slice(i) : blocks.slice(i + 1) });
  return out;
}

// 結合したとき c章のブロック番号に足される量。mergeChapter と必ず同じ opts で呼ぶこと
function mergeOffset(chapters, c, opts) {
  const o = opts || {};
  if (!Array.isArray(chapters) || !chapters[c] || c < 1) throw chapterOpError('章番号が範囲外です');
  const prevLen = (chapters[c - 1].blocks || []).length;
  const title = (chapters[c].title || '').trim();
  return prevLen + (o.restoreTitle && title ? 1 : 0);
}

// c章を c-1章の末尾に結合する。
// restoreTitle=true のとき、消える章の見出しを {t:'p'} の段落として継ぎ目に戻す。
// 節見出し {t:'h'} にしないのは、h は目次に出ず長押しの対象でもあるが「章に戻す」導線が
// 分かりにくいため。p なら長押し →「ここから新しい章」でそのまま章に戻せる。
function mergeChapter(chapters, c, opts) {
  const o = opts || {};
  if (!Array.isArray(chapters) || !chapters[c] || c < 1) throw chapterOpError('章番号が範囲外です');
  const prev = chapters[c - 1];
  const cur = chapters[c];
  const title = (cur.title || '').trim();
  const mid = (o.restoreTitle && title) ? [{ t: 'p', text: title }] : [];
  const out = chapters.slice();
  out[c - 1] = { ...prev, blocks: [...(prev.blocks || []), ...mid, ...(cur.blocks || [])] };
  out.splice(c, 1);
  return out;
}

function renameChapter(chapters, c, title) {
  if (!Array.isArray(chapters) || !chapters[c]) throw chapterOpError('章番号が範囲外です');
  const out = chapters.slice();
  out[c] = { ...chapters[c], title: title == null ? '' : String(title).trim() };
  return out;
}

// {ch, blk} を op で付け替える。at・ratio など他のフィールドはそのまま持ち越す。
// blk を持たない（＝比率だけの旧い読書位置）ときは ch だけ付け替える。
function remapAnchor(anchor, op) {
  if (!anchor || !op) return anchor;
  const out = { ...anchor };
  const ch = typeof out.ch === 'number' ? out.ch : 0;
  const hasBlk = typeof out.blk === 'number';
  const blk = hasBlk ? out.blk : 0;

  if (op.type === 'split') {
    if (ch < op.c) return out;
    if (ch > op.c) { out.ch = ch + 1; return out; }
    out.ch = ch;
    if (!hasBlk) return out;             // 比率だけの位置は前半（c章）に残す
    if (blk < op.i) return out;          // 分割点より前＝そのまま c章
    out.ch = ch + 1;
    if (op.keepBlock) out.blk = blk - op.i;
    // 見出しに昇格したブロック自身（blk===i）は、新しい章の先頭を指すようにする
    else out.blk = blk === op.i ? 0 : blk - op.i - 1;
    return out;
  }

  if (op.type === 'merge') {
    if (ch < op.c) return out;           // c-1章も含めてそのまま
    if (ch > op.c) { out.ch = ch - 1; return out; }
    out.ch = op.c - 1;
    if (hasBlk) out.blk = blk + (op.off || 0);
    return out;
  }

  return out;
}

// 付け替えた結果が実在するブロックを指すように丸める（末尾ブロックでの分割など端の保険）
function clampAnchor(chapters, anchor) {
  if (!anchor || !Array.isArray(chapters) || !chapters.length) return anchor;
  const out = { ...anchor };
  const ch = Math.max(0, Math.min(typeof out.ch === 'number' ? out.ch : 0, chapters.length - 1));
  out.ch = ch;
  if (typeof out.blk === 'number') {
    const len = ((chapters[ch] && chapters[ch].blocks) || []).length;
    out.blk = len ? Math.max(0, Math.min(out.blk, len - 1)) : 0;
  }
  return out;
}

function remapAnchors(list, op, chapters) {
  if (!Array.isArray(list)) return list;
  return list.map(a => clampAnchor(chapters, remapAnchor(a, op)));
}

// その位置が章の実質的な先頭か（前に本文ブロックが無い＝gap しか挟まっていない）。
// ここで分割しても中身が動かないので、UI 側でボタンを無効にするのに使う
function isEffectiveStart(blocks, blk) {
  if (!Array.isArray(blocks) || !(blk > 0)) return true;
  for (let i = 0; i < blk && i < blocks.length; i++) {
    if (blocks[i] && blocks[i].t !== 'gap') return false;
  }
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = {
    splitChapter, mergeChapter, mergeOffset, renameChapter,
    remapAnchor, remapAnchors, clampAnchor, isEffectiveStart,
  };
}
