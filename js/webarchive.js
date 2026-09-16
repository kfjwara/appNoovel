'use strict';

// ===== Safari .webarchive 取り込み =====
// Safariで保存した .webarchive（バイナリplist）からWebページ本体のHTMLを取り出し、
// 対応する小説ページなら本文構造（段落・章・シリーズ・著者）をそのまま .noovel 構造へ移す。
//   parseWebArchive(arrayBuffer) → { html, url }
//   webArchiveToBook(html, stem) → { book, warnings, rawText } | { error }

// --- バイナリplist（bplist00）の最小パーサ ---
// 使う型だけ対応：null/bool, int, real, data, ASCII文字列, UTF-16文字列, 配列, 辞書
function parseBPlist(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  let magic = '';
  for (let i = 0; i < 6; i++) magic += String.fromCharCode(bytes[i]);
  if (magic !== 'bplist') throw new Error('バイナリplistではありません');

  // 末尾32バイトのトレーラーに全体の索引情報が入っている
  const len = bytes.length;
  const readUInt = (pos, size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[pos + i];
    return v;
  };
  const offsetIntSize = bytes[len - 26];
  const objectRefSize = bytes[len - 25];
  const numObjects = readUInt(len - 24, 8);
  const topObject = readUInt(len - 16, 8);
  const offsetTableOffset = readUInt(len - 8, 8);

  const cache = new Array(numObjects);

  function parseObj(i) {
    if (cache[i] !== undefined) return cache[i];
    let off = readUInt(offsetTableOffset + i * offsetIntSize, offsetIntSize);
    const marker = bytes[off++];
    const type = marker >> 4;
    const info = marker & 0x0f;

    // 長さが15以上のときは直後にintオブジェクトとして長さが続く
    const readLen = () => {
      if (info !== 0x0f) return info;
      const m = bytes[off++];
      const size = 1 << (m & 0x0f);
      const v = readUInt(off, size);
      off += size;
      return v;
    };

    let val;
    switch (type) {
      case 0x0:
        val = info === 8 ? false : info === 9 ? true : null;
        break;
      case 0x1:
        val = readUInt(off, 1 << info);
        break;
      case 0x2:
        val = (1 << info) === 4 ? dv.getFloat32(off) : dv.getFloat64(off);
        break;
      case 0x3:
        val = dv.getFloat64(off);
        break;
      case 0x4: {
        const n = readLen();
        val = bytes.subarray(off, off + n);
        break;
      }
      case 0x5: {
        const n = readLen();
        let s = '';
        for (let k = 0; k < n; k++) s += String.fromCharCode(bytes[off + k]);
        val = s;
        break;
      }
      case 0x6: {
        const n = readLen();
        let s = '';
        for (let k = 0; k < n; k++) s += String.fromCharCode((bytes[off + 2 * k] << 8) | bytes[off + 2 * k + 1]);
        val = s;
        break;
      }
      case 0x8:
        val = readUInt(off, info + 1);
        break;
      case 0xa:
      case 0xc: {
        const n = readLen();
        const arr = [];
        cache[i] = arr;
        for (let k = 0; k < n; k++) arr.push(parseObj(readUInt(off + k * objectRefSize, objectRefSize)));
        return arr;
      }
      case 0xd: {
        const n = readLen();
        const dict = {};
        cache[i] = dict;
        for (let k = 0; k < n; k++) {
          const key = parseObj(readUInt(off + k * objectRefSize, objectRefSize));
          dict[key] = parseObj(readUInt(off + (n + k) * objectRefSize, objectRefSize));
        }
        return dict;
      }
      default:
        throw new Error('未対応のplist型です (0x' + type.toString(16) + ')');
    }
    cache[i] = val;
    return val;
  }

  return parseObj(topObject);
}

function parseWebArchive(arrayBuffer) {
  const root = parseBPlist(arrayBuffer);
  const main = root && root.WebMainResource;
  if (!main || !main.WebResourceData) throw new Error('中にWebページが見つかりません');
  const enc = (main.WebResourceTextEncodingName || 'utf-8').toLowerCase();
  let html;
  try { html = new TextDecoder(enc).decode(main.WebResourceData); }
  catch (e) { html = new TextDecoder('utf-8').decode(main.WebResourceData); }
  return { html, url: main.WebResourceURL || '' };
}

// --- HTML → book ---

// <ruby>漢字<rt>かな</rt></ruby> → 漢字（かな）
function rubyToText(ruby) {
  let base = '';
  let rt = '';
  ruby.childNodes.forEach(ch => {
    if (ch.nodeType === Node.ELEMENT_NODE) {
      const tag = ch.tagName;
      if (tag === 'RT') { rt += ch.textContent; return; }
      if (tag === 'RP') return;
      base += ch.textContent;
      return;
    }
    if (ch.nodeType === Node.TEXT_NODE) base += ch.nodeValue;
  });
  base = base.trim();
  rt = rt.trim();
  return rt ? base + '（' + rt + '）' : base;
}

// pixivがNext.js（CSS Modules）に移行し、本文のクラス名が
//   novel-paragraph → style_novel-paragraph__eKYp5
// のようにハッシュ付きへ変わった。ハッシュはCSSが変わるたびに変わるので決め打ちできない。
// 「素のクラス名そのもの（旧形式）」か「style_<名前>__ で始まる（新形式）」かで判定する。
function hasCls(el, name) {
  const list = el.classList;
  if (!list) return false;
  const prefix = 'style_' + name + '__';
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === name || c.indexOf(prefix) === 0) return true;
  }
  return false;
}

// 小説ページの本文DOMを「行の並び」へ復元する
// novel-paragraph 内は <br> が改行、novel-newline は空行、novel-chapter は章見出し
function novelPageLines(container) {
  const lines = []; // { kind: 'text'|'chapter'|'blank', text }
  // 部分一致で拾ってから hasCls で厳密に絞る（[class*=] だけだと別名クラスを巻き込むため）
  const els = container.querySelectorAll('[class*="novel-paragraph"], [class*="novel-newline"], [class*="novel-chapter"]');
  els.forEach(el => {
    const isChapter = hasCls(el, 'novel-chapter');
    const isNewline = hasCls(el, 'novel-newline');
    if (!isChapter && !isNewline && !hasCls(el, 'novel-paragraph')) return;
    if (isChapter) {
      lines.push({ kind: 'chapter', text: el.textContent.trim() });
      return;
    }
    if (isNewline) {
      // novel-newline は「場面転換」の意図的な空白。段落境界の空行（下記）に上乗せされて
      // より大きい間になる（通常の段落境界=1、場面転換=2、二重novel-newline=3…）
      lines.push({ kind: 'blank' });
      return;
    }
    // 段落：<br>区切りで行に分ける。
    // pixiv は「空の text-count span + <br>」で意図的な空行（間）を表す。<br>の手前が空なら
    // その空行を保持する（＝場面転換や段落頭の間）。ただし段落末尾に付く空 span はゴミなので無視。
    let cur = '';
    const before = lines.length;
    const pushAtBr = () => { lines.push(cur.trim() ? { kind: 'text', text: cur } : { kind: 'blank' }); cur = ''; };
    const pushAtEnd = () => { if (cur.trim()) lines.push({ kind: 'text', text: cur }); cur = ''; };
    const walk = node => {
      node.childNodes.forEach(ch => {
        if (ch.nodeType === Node.TEXT_NODE) { cur += ch.nodeValue; return; }
        if (ch.nodeType !== Node.ELEMENT_NODE) return;
        if (ch.tagName === 'BR') { pushAtBr(); return; }
        if (ch.tagName === 'RUBY') { cur += rubyToText(ch); return; }
        walk(ch);
      });
    };
    walk(el);
    pushAtEnd();
    // 段落「境界」にも空行を1つ（pixiv が各 novel-paragraph に付ける約1.5emの余白に相当）。
    // 中身を出した段落のときだけ。段落頭の空行（上記）と合わさると場面転換がより大きくなる
    if (lines.length > before) lines.push({ kind: 'blank' });
  });
  return lines;
}

// 行の並び → ブロック列。空行は大きさ(n)つきのgapとして保持
function novelPageLinesToBlocks(lines) {
  const blocks = [];
  let blankRun = 0;
  for (const l of lines) {
    const t = (l.text || '').replace(/ /g, ' ').trim();
    if (l.kind === 'blank' || !t) { blankRun++; continue; }
    // Webページ由来は空行1つでも作者が入れた「間」なので、大きさ(n)ごと保持する
    if (blankRun >= 1 && blocks.length) blocks.push({ t: 'gap', n: blankRun });
    blankRun = 0;
    blocks.push({ t: 'p', text: t });
  }
  return blocks;
}

// 小説ページとして取り込む。構造を認識できなかったときは null を返し、
// 呼び出し側（webArchiveToBook）が汎用抽出へフォールバックする
function novelPageToBook(doc, container) {
  const warnings = [];
  const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const qText = sel => { const el = doc.querySelector(sel); return el ? clean(el.textContent) : ''; };

  // タイトルはページ内のh1（作品名そのもの）を正とする。
  // 旧pixivのタブ題は「#N 作品名 - ◯◯の小説 - pixiv」だったが、新pixiv（Next.js）では
  // 「#N 作品名 | シリーズ名（途中で切れる） - pixiv」や「#タグ #タグ 作品名 - ◯◯の - pixiv」に
  // なり、そのまま使うとタグや千切れたシリーズ名が混ざる。ただしh1には話数#Nが入らないので、
  // シリーズバッジの「#N」か、タブ題の先頭の「#N 」から補って従来と同じ見え方に戻す。
  let title = qText('h1[class*="work-title"]');
  if (title) {
    let order = qText('[class*="series-badge"] [class*="series-order"]');
    if (!order) {
      const mo = (doc.title || '').match(/^\s*(#\d+)\s/); // 先頭が #数字 のときだけ話数とみなす（#タグは拾わない）
      if (mo) order = mo[1];
    }
    if (order && title.indexOf(order) !== 0) title = clean(order + ' ' + title);
  }
  if (!title) title = clean(doc.title || '');

  // シリーズ名。新形式のバッジは「シリーズ名 + #N」なので内側のシリーズ名だけを取り、
  // 取れなければ（＝旧形式）バッジ全体のテキストを使う
  let subtitle = qText('[class*="series-badge"] [class*="series-title"]');
  if (!subtitle) subtitle = qText('[class*="series-badge"]');

  let author = qText('a[href^="/users/"] [class*="value"]');
  if (!author) {
    // ページタイトル末尾の「 - ◯◯の小説(シリーズ) - pixiv」「 - ◯◯の - pixiv」から著者名を拾う
    const m = (doc.title || '').match(/-\s*([^\-]+?)の(?:小説(?:シリーズ)?)?\s*-\s*pixiv\s*$/)
           || (doc.title || '').match(/-\s*([^\-]+?)の小説(?:シリーズ)?\s*-/);
    if (m) author = m[1].trim();
  }

  const lines = novelPageLines(container);

  // 元テキストの控え（バックアップ用）
  const rawText = lines
    .map(l => l.kind === 'blank' ? '' : l.kind === 'chapter' ? '【' + l.text + '】' : (l.text || '').replace(/ /g, ' '))
    .join('\n');

  // 章タグ（novel-chapter）が無い作品：作者が「一」「二」等の素の行で章を書いている
  // ことが多いので、テキスト用ヒューリスティック（convertText）で章見出しを推定する
  if (!lines.some(l => l.kind === 'chapter')) {
    if (!rawText.trim()) return null; // 構造を認識できず → 呼び出し側で汎用抽出にフォールバック
    const res = convertText(rawText, title, { gapMin: 1 });
    if (title) res.book.title = title;
    if (subtitle) res.book.subtitle = subtitle;
    if (author) res.book.author = author;
    res.warnings.unshift('小説ページとして取り込みました（章タグが無いため章見出しは本文から推定）');
    res.rawText = rawText;
    return res;
  }

  // novel-chapter（章タグ）で章に分割
  const chapters = [];
  let curTitle = '';
  let buf = [];
  const flush = () => {
    const blocks = novelPageLinesToBlocks(buf);
    if (blocks.some(b => b.t !== 'gap')) chapters.push({ title: curTitle || title, blocks });
    buf = [];
  };
  for (const l of lines) {
    if (l.kind === 'chapter') { flush(); curTitle = l.text; }
    else buf.push(l);
  }
  flush();

  if (!chapters.length) return null; // 同上

  warnings.push('小説ページとして構造ごと取り込みました');
  return { book: { title, subtitle, author, chapters }, warnings, rawText };
}

// 一般のWebページ用：本文らしきテキストをブロック要素の区切りを改行にして抜き出す
// root を渡すとその要素配下だけを対象にする（本文コンテナは分かるが中身の構造が読めないとき用）
function htmlBodyToText(doc, root) {
  const body = root || doc.body;
  if (!body) return '';
  body.querySelectorAll('script, style, noscript, svg, iframe, template').forEach(el => el.remove());
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|NAV|ASIDE|H[1-6]|LI|UL|OL|TABLE|TR|BLOCKQUOTE|PRE|FIGURE|BR|HR|DT|DD)$/;
  let out = '';
  const walk = node => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === Node.TEXT_NODE) { out += ch.nodeValue; return; }
      if (ch.nodeType !== Node.ELEMENT_NODE) return;
      if (ch.tagName === 'RUBY') { out += rubyToText(ch); return; }
      const isBlock = BLOCK.test(ch.tagName);
      if (isBlock) out += '\n';
      walk(ch);
      if (isBlock) out += '\n';
    });
  };
  walk(body);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function webArchiveToBook(html, stem) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 新pixivはSPAなので WebResourceURL が最初に開いたページのURLになることがある。
  // canonical のほうが実際に表示していた作品を正しく指す
  const canonical = doc.querySelector('link[rel="canonical"]');
  const pageUrl = canonical ? (canonical.getAttribute('href') || '') : '';

  const container = doc.getElementById('novel-text-container')
    || doc.querySelector('[class*="novel-text-container"]');

  let structureMissed = false;
  if (container) {
    const res = novelPageToBook(doc, container);
    if (res) {
      if (pageUrl) res.url = pageUrl;
      return res;
    }
    // 本文コンテナはあるのに段落・章が1つも読めない＝サイト側の構造変更の可能性
    structureMissed = true;
  }

  // 小説ページの構造が見つからない → テキストを抜いて自動整形（convert.js）へ
  // 構造だけ読めなかった場合は本文コンテナ配下に絞って抜く（ナビや広告を巻き込まないため）
  const text = htmlBodyToText(doc, structureMissed ? container : null);
  if (!text) return { error: 'このwebarchiveから本文を取り出せませんでした' };
  const pageTitle = (doc.title || '').trim();
  const res = convertText(text, pageTitle || stem);
  res.warnings.unshift(structureMissed
    ? 'pixivの本文構造を認識できなかったため汎用抽出にフォールバックしました（サイト側の仕様変更かもしれません）'
    : '小説ページの形式ではなかったため、本文を推定で取り込みました');
  res.rawText = text;
  if (pageUrl) res.url = pageUrl;
  return res;
}
