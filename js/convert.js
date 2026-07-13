'use strict';

// ===== Noovel 変換器 =====
// バラバラ形式のテキストを .noovel 構造に正規化する。
//   convertText(raw, stem)  → { book, warnings }   … .txt/.md 用ヒューリスティック
//   parseNoovelJSON(raw)    → { book, warnings } | { error } … .noovel 検証
// book = { title, subtitle, author, chapters:[{ title, blocks }] }
// block = {t:'p',text} | {t:'h',text} | {t:'table',rows} | {t:'gap',n?}（n=元の空行数、表示の空きに反映）

// 見出しスタイル定義。rank が小さいほど上位（章になりやすい）。
// strong=true のスタイルが1つでも活性なら、素の短行見出し推定(plainShort)は行わない。
const HEADING_STYLES = [
  { key: 'mdH1',       rank: 0, strong: true,  min: 1, md: true,  re: /^#\s+\S/ },
  { key: 'chapterNum', rank: 1, strong: true,  min: 1, md: false, re: /^(第[一二三四五六七八九十百千0-9０-９]+[章話部編幕節]|序章|終章|序幕|終幕|プロローグ|エピローグ)/ },
  { key: 'mdH2',       rank: 2, strong: true,  min: 1, md: true,  re: /^##\s+\S/ },
  { key: 'bracket',    rank: 3, strong: false, min: 2, md: false, re: /^【.+】$/ },
  { key: 'bullet',     rank: 4, strong: false, min: 2, md: false, re: /^[■◆●▲★☆]\s*\S/ },
  { key: 'mdH3',       rank: 5, strong: true,  min: 1, md: true,  re: /^###\s+\S/ },
  { key: 'numbered',   rank: 6, strong: false, min: 2, md: false, re: /^[0-9０-９]{1,2}[.．、]\s*\S/ },
];

// 見出しとして成立する行か（md記法は無条件、それ以外は短く文末記号で終わらない行のみ）
function matchHeadingStyle(t) {
  for (const s of HEADING_STYLES) {
    if (!s.re.test(t)) continue;
    if (!s.md && (t.length > 40 || /[。、．，]$/.test(t))) return null;
    return s;
  }
  return null;
}

// インライン掃除：markdown強調の除去
function cleanInline(t) {
  return t
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#{1,6}\s*/, '');
}

function lastNonBlankIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i;
  return -1;
}

// 素の短行見出し（記号なし）の推定候補
function plainShortCandidates(lines) {
  const cands = [];
  const last = lastNonBlankIndex(lines);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 30) continue;
    if (i === last) continue;                          // 巻末の署名行は見出しにしない
    if (/[。．！？…、，」』）】]$/.test(t)) continue;   // 文末記号で終わる行は本文
    if (/^[「『（(＜<―─＝=]/.test(t)) continue;         // 会話・括弧・罫線は本文
    if (!/[0-9０-９A-Za-zａ-ｚＡ-Ｚぁ-んァ-ヶ一-龠々]/.test(t)) continue; // 記号だけの行（「◇」等の場面区切り）は見出しにしない
    if (t.includes('\t') || /^\|.+\|$/.test(t)) continue; // 表
    if (i > 0 && lines[i - 1].trim()) continue;        // 直前に空行が必要
    if (matchHeadingStyle(t)) continue;                // 記号つきスタイルはそっちで扱う
    cands.push(i);
  }
  return cands;
}

// 本文行の並びをブロック列へ
// gapMin: 空きとして残す最小空行数（.txtは2、空行の意図が明確なWebページ由来は1）
function linesToBlocks(lines, sectionKeys, gapMin = 2) {
  const blocks = [];
  let blankRun = 0;
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { blankRun++; i++; continue; }
    if (blankRun >= gapMin && blocks.length) blocks.push({ t: 'gap', n: blankRun });
    blankRun = 0;

    // 区切り線 → 場面転換
    if (/^(-{3,}|\*{3,}|＿{3,}|＊{3,}|―{3,}|＝{3,})$/.test(t)) {
      if (blocks.length) blocks.push({ t: 'gap' });
      i++; continue;
    }
    // タブ区切りの表（2行以上連続）
    if (t.includes('\t') && i + 1 < lines.length && lines[i + 1].includes('\t')) {
      const rows = [];
      while (i < lines.length && lines[i].includes('\t')) {
        rows.push(lines[i].trim().split('\t').map(c => c.trim()));
        i++;
      }
      blocks.push({ t: 'table', rows });
      continue;
    }
    // markdown の表
    if (/^\|.+\|$/.test(t)) {
      const rows = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        const tt = lines[i].trim();
        if (!/^[\s|:\-]+$/.test(tt)) rows.push(tt.slice(1, -1).split('|').map(c => c.trim()));
        i++;
      }
      if (rows.length) { blocks.push({ t: 'table', rows }); continue; }
    }
    // 節見出し
    const s = matchHeadingStyle(t);
    if (s && sectionKeys.has(s.key)) {
      blocks.push({ t: 'h', text: cleanInline(t) });
      i++; continue;
    }
    blocks.push({ t: 'p', text: cleanInline(t) });
    i++;
  }
  return blocks;
}

function convertText(raw, stem, opts) {
  const warnings = [];
  const gapMin = (opts && opts.gapMin) || 2;
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // 文書全体でのスタイル出現数
  const counts = {};
  for (const l of lines) {
    const s = matchHeadingStyle(l.trim());
    if (s) counts[s.key] = (counts[s.key] || 0) + 1;
  }
  let active = HEADING_STYLES.filter(s => (counts[s.key] || 0) >= s.min);

  // mdH1 が1回だけ＝文書タイトル扱い（章スタイルから外す）
  let titleFromH1 = null;
  if ((counts.mdH1 || 0) === 1) {
    const idx = lines.findIndex(l => /^#\s+\S/.test(l.trim()));
    titleFromH1 = cleanInline(lines[idx].trim());
    lines[idx] = '';
    active = active.filter(s => s.key !== 'mdH1');
  }

  // 章スタイルの決定
  let chapterStyle = null;   // HEADING_STYLES の1つ or 'plainShort'
  let marks = [];            // 章見出しの行番号
  const upper = active.filter(s => s.rank <= 3).sort((a, b) => a.rank - b.rank);
  if (upper.length) {
    chapterStyle = upper[0];
  } else {
    const cands = plainShortCandidates(lines);
    if (cands.length >= 2) {
      chapterStyle = 'plainShort';
      marks = cands;
      warnings.push(`章見出しを文脈から推定しました（${cands.length}章）`);
    } else if (active.length) {
      chapterStyle = active.sort((a, b) => a.rank - b.rank)[0];
    }
  }
  if (chapterStyle && chapterStyle !== 'plainShort') {
    marks = [];
    lines.forEach((l, i) => {
      const s = matchHeadingStyle(l.trim());
      if (s && s.key === chapterStyle.key) marks.push(i);
    });
    // 巻末が見出しで終わっている場合は本文行に降格
    const last = lastNonBlankIndex(lines);
    if (marks.length && marks[marks.length - 1] === last) marks.pop();
  }

  // 章スタイル以外の活性スタイルは節見出し
  const sectionKeys = new Set(
    active
      .filter(s => !chapterStyle || chapterStyle === 'plainShort' || s.key !== chapterStyle.key)
      .filter(s => !chapterStyle || chapterStyle === 'plainShort' || s.rank > chapterStyle.rank)
      .map(s => s.key)
  );

  // 前付け（最初の章見出しより前）からメタデータを拾う
  const preEnd = marks.length ? marks[0] : lines.length;
  const pre = lines.slice(0, preEnd);
  let title = titleFromH1 || '';
  let subtitle = '';
  let author = '';
  const preBody = [];
  const preNonBlank = pre.filter(l => l.trim());
  let metaLines = 0;
  for (const l of pre) {
    const t = l.trim();
    if (!t) continue;
    const am = t.match(/^(?:著者|作者|author)[:：]\s*(.+)$/i);
    if (am && !author) { author = am[1].trim(); continue; }
    if (!title && preNonBlank.length <= 3 && t.length <= 40 && !/[。！？]$/.test(t)) {
      title = cleanInline(t); metaLines++; continue;
    }
    if (title && !subtitle && metaLines >= 1 && preNonBlank.length <= 3 &&
        (/^[――─〜~]/.test(t) || t.length <= 30) && !/[。！？]$/.test(t)) {
      subtitle = cleanInline(t); metaLines++; continue;
    }
    preBody.push(l);
  }
  if (!title) title = stem;

  // 章の組み立て
  // 章見出しが1つも無い文書では、前付け＝本文全体なので「まえがき」ではなく書名を章名にする
  const chapters = [];
  const preBlocks = linesToBlocks(preBody, sectionKeys, gapMin);
  if (preBlocks.some(b => b.t !== 'gap')) {
    chapters.push({ title: marks.length ? 'まえがき' : title, blocks: preBlocks });
    if (!marks.length) warnings.push('章見出しを検出できませんでした。全体を1章として取り込みました');
  }

  marks.forEach((m, i) => {
    const end = marks[i + 1] ?? lines.length;
    const chTitle = cleanInline(lines[m].trim()) || `第${i + 1}章`;
    const blocks = linesToBlocks(lines.slice(m + 1, end), sectionKeys, gapMin);
    chapters.push({ title: chTitle, blocks });
  });

  if (!chapters.length) {
    warnings.push('章見出しを検出できませんでした。全体を1章として取り込みました');
    chapters.push({ title, blocks: linesToBlocks(lines, sectionKeys, gapMin) });
  }

  return { book: { title, subtitle, author, chapters }, warnings };
}

// ===== PDF テキスト再構成 =====
// pages: 1ページ = [{str, x, y}] の配列（pdf.js の getTextContent から作る）。
// 行の復元 → 毎ページ繰り返しのヘッダー/フッター・ページ番号の除去 → 行間と字下げから段落復元。
function pdfPagesToText(pages) {
  // 1) y座標のクラスタリングで行を復元（上から下へ）
  const rawPages = pages.map(items => {
    const lines = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      let line = lines.find(l => Math.abs(l.y - it.y) <= 2);
      if (!line) { line = { y: it.y, parts: [] }; lines.push(line); }
      line.parts.push({ x: it.x, str: it.str });
    }
    lines.sort((a, b) => b.y - a.y);
    return lines.map(l => {
      const joined = l.parts.sort((a, b) => a.x - b.x).map(p => p.str).join('');
      return { y: l.y, text: joined.trim(), indent: /^[\s　]/.test(joined) };
    }).filter(l => l.text);
  });

  // 2) 走りヘッダー/フッター（3ページ以上の6割超に出る同一行）とページ番号を除去
  const freq = {};
  rawPages.forEach(lines => {
    new Set(lines.map(l => l.text)).forEach(t => { freq[t] = (freq[t] || 0) + 1; });
  });
  const isRunning = t => rawPages.length >= 3 && freq[t] >= Math.ceil(rawPages.length * 0.6);
  const isPageNum = t => /^[\s\-‐–—・.．〔〕()（）]*[0-9０-９]{1,4}[\s\-‐–—・.．〔〕()（）]*$/.test(t);

  // 3) 段落復元：行間が中央値の1.55倍を超える／字下げで始まる → 新しい段落
  const SENT_END = /[。．！？!?」』】]$/;
  const joinLines = (a, b) =>
    (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) ? a + ' ' + b : a + b;

  const paras = [];
  for (const lines of rawPages) {
    const kept = lines.filter(l => !isRunning(l.text) && !isPageNum(l.text));
    if (!kept.length) continue;
    const gaps = [];
    for (let i = 1; i < kept.length; i++) gaps.push(Math.abs(kept[i - 1].y - kept[i].y));
    const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

    kept.forEach((l, i) => {
      if (i === 0) {
        // ページ先頭：前ページ末尾の段落が文末で終わってなければ続きとして連結
        if (paras.length && !SENT_END.test(paras[paras.length - 1]) && !l.indent) {
          paras[paras.length - 1] = joinLines(paras[paras.length - 1], l.text);
        } else {
          paras.push(l.text);
        }
        return;
      }
      const gap = Math.abs(kept[i - 1].y - l.y);
      if (l.indent || (median && gap > median * 1.55)) {
        paras.push(l.text);
      } else {
        paras[paras.length - 1] = joinLines(paras[paras.length - 1], l.text);
      }
    });
  }

  return paras.join('\n\n');
}

// ===== .noovel（JSON）の検証つき読み込み =====
function parseNoovelJSON(raw) {
  let obj;
  try { obj = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (e) { return { error: 'JSONとして読めません' }; }
  if (typeof obj !== 'object' || obj === null) return { error: 'JSONの中身がオブジェクトではありません' };

  const warnings = [];
  if (obj.noovel !== 1) warnings.push('バージョン宣言（"noovel": 1）がありません');
  if (typeof obj.title !== 'string' || !obj.title.trim()) return { error: 'title がありません' };
  if (!Array.isArray(obj.chapters) || !obj.chapters.length) return { error: 'chapters がありません' };

  const chapters = [];
  for (let i = 0; i < obj.chapters.length; i++) {
    const ch = obj.chapters[i];
    if (typeof ch !== 'object' || ch === null) return { error: `chapters[${i}] が壊れています` };
    const chTitle = typeof ch.title === 'string' && ch.title.trim() ? ch.title.trim() : `第${i + 1}章`;
    let blocks = [];
    if (Array.isArray(ch.blocks)) {
      for (const b of ch.blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.t === 'p' || b.t === 'h') {
          if (typeof b.text === 'string' && b.text.trim()) blocks.push({ t: b.t, text: b.text });
          else warnings.push(`chapters[${i}] にtextの無いブロックがあり、飛ばしました`);
        } else if (b.t === 'gap') {
          const g = { t: 'gap' };
          if (typeof b.n === 'number' && b.n >= 1) g.n = Math.floor(b.n);
          blocks.push(g);
        } else if (b.t === 'table' && Array.isArray(b.rows)) {
          const rows = b.rows.filter(r => Array.isArray(r)).map(r => r.map(c => String(c)));
          if (rows.length) blocks.push({ t: 'table', rows });
        } else {
          warnings.push(`chapters[${i}] に未知のブロック（t:"${b.t}"）があり、飛ばしました`);
        }
      }
    } else if (typeof ch.text === 'string') {
      // 簡易形：本文を文字列で持つのも許容
      blocks = ch.text.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ t: 'p', text: l }));
    } else {
      return { error: `chapters[${i}] に blocks も text もありません` };
    }
    chapters.push({ title: chTitle, blocks });
  }

  return {
    book: {
      title: obj.title.trim(),
      subtitle: typeof obj.subtitle === 'string' ? obj.subtitle.trim() : '',
      author: typeof obj.author === 'string' ? obj.author.trim() : '',
      chapters,
    },
    warnings,
  };
}

if (typeof module !== 'undefined') module.exports = { convertText, parseNoovelJSON, pdfPagesToText };
