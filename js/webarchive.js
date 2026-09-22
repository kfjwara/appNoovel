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
  if (len < 40) throw new Error('plistが短すぎます');
  const offsetIntSize = bytes[len - 26];
  const objectRefSize = bytes[len - 25];
  const numObjects = readUInt(len - 24, 8);
  const topObject = readUInt(len - 16, 8);
  const offsetTableOffset = readUInt(len - 8, 8);

  // 途中で切れたファイルは、末尾32バイトのトレーラーが本文の途中を指してしまう。
  // ここで筋の通らない値を弾いておかないと、この先で「中身が空の辞書」に化けて
  // 「Webページが見つかりません」という的外れな案内になる
  if (!(numObjects > 0) || offsetIntSize < 1 || offsetIntSize > 8 ||
      objectRefSize < 1 || objectRefSize > 8 ||
      topObject >= numObjects ||
      offsetTableOffset < 8 ||
      offsetTableOffset + numObjects * offsetIntSize > len - 32) {
    throw new Error('plistのトレーラーが壊れています');
  }

  const cache = new Array(numObjects);

  function parseObj(i) {
    if (i >= numObjects) throw new Error('plistの参照が範囲外です');
    if (cache[i] !== undefined) return cache[i];
    let off = readUInt(offsetTableOffset + i * offsetIntSize, offsetIntSize);
    if (off >= len) throw new Error('plistのオフセットが範囲外です');
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

// --- XML形式の plist（<?xml …><plist><dict>…）---
// Safariは普通バイナリplistで書くが、他のツールが作ったり変換したりしたものはXMLのことがある。
// バイナリ版と同じ形（辞書＝オブジェクト / data＝Uint8Array）に揃えて返す。
function base64ToBytes(s) {
  const bin = atob(String(s).replace(/[\s\r\n]+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function xmlPlistValue(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'dict') {
    const out = {};
    let key = null;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.tagName.toLowerCase() === 'key') { key = c.textContent; continue; }
      if (key === null) continue;
      out[key] = xmlPlistValue(c);
      key = null;
    }
    return out;
  }
  if (tag === 'array') {
    const out = [];
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) out.push(xmlPlistValue(c));
    return out;
  }
  if (tag === 'data') return base64ToBytes(el.textContent);
  if (tag === 'integer') return parseInt(el.textContent, 10);
  if (tag === 'real') return parseFloat(el.textContent);
  if (tag === 'true') return true;
  if (tag === 'false') return false;
  return el.textContent;   // string / date
}

function parseXmlPlist(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.nodeName === 'parsererror') {
    throw new Error('XMLとして読めません');
  }
  const plist = doc.querySelector('plist') || doc.documentElement;
  const root = plist && plist.firstElementChild;
  if (!root) throw new Error('plistの中身がありません');
  return xmlPlistValue(root);
}

// --- 文字コード ---
// WebResourceTextEncodingName を第一候補に、無ければ UTF-8（厳密）→ Shift_JIS の順に試す
function decodeBytes(bytes, encName) {
  const tryDec = (enc, fatal) => {
    try { return new TextDecoder(enc, { fatal: !!fatal }).decode(bytes); }
    catch (e) { return null; }
  };
  if (encName) {
    const t = tryDec(encName, false);
    if (t !== null) return { text: t, enc: String(encName).toLowerCase() };
  }
  const u = tryDec('utf-8', true);
  if (u !== null) return { text: u, enc: 'utf-8' };
  const s = tryDec('shift_jis', false);
  if (s !== null) return { text: s, enc: 'shift_jis' };
  return { text: tryDec('utf-8', false) || '', enc: 'utf-8' };
}

// 文字化けの目安。U+FFFD（置換文字）の割合
function replacementRatio(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xFFFD) n++;
  return n / text.length;
}

// <meta charset="…"> / <meta http-equiv="Content-Type" content="…; charset=…">
function metaCharset(text) {
  const m = String(text).slice(0, 8192)
    .match(/<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-]+)/i);
  return m ? m[1] : null;
}

// HTML用のデコード。宣言と中身が食い違っていたら（＝化けていたら）meta の charset で読み直す
function decodeHtmlBytes(bytes, encName) {
  const r = decodeBytes(bytes, encName);
  const cs = metaCharset(r.text);
  if (!cs || cs.toLowerCase() === r.enc) return r;   // 数MBを走査する前に外せるものは外す
  const bad = replacementRatio(r.text);
  if (bad > 0.01) {
    try {
      const t = new TextDecoder(cs).decode(bytes);
      if (replacementRatio(t) < bad) return { text: t, enc: cs.toLowerCase(), refixed: true };
    } catch (e) {}
  }
  return r;
}

// --- 入口の判別 ---
function asciiAt(bytes, off, n) {
  let s = '';
  const end = Math.min(bytes.length, off + n);
  for (let i = off; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// エラーメッセージ用に先頭を見せる（印字できないバイトは \xNN）
function headPreview(bytes, n) {
  let s = '';
  const end = Math.min(bytes.length, n);
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    s += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '\\x' + (b < 16 ? '0' : '') + b.toString(16);
  }
  return s || '(空のファイル)';
}

// 'bplist' | 'xml' | 'html' | 'unknown'。BOMと先頭の空白は読み飛ばす
function sniffArchiveKind(bytes) {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  const head = asciiAt(bytes, i, 64).toLowerCase();
  if (head.indexOf('bplist') === 0) return 'bplist';
  if (head.indexOf('<plist') === 0) return 'xml';
  if (head.indexOf('<?xml') === 0) {
    // plist宣言が後ろにあるか見る。無ければ XHTML 等とみなして HTML 扱い（読める方に倒す）
    return asciiAt(bytes, i, 8192).toLowerCase().indexOf('<plist') >= 0 ? 'xml' : 'html';
  }
  if (head.indexOf('<!doctype') === 0 || head.indexOf('<html') === 0) return 'html';
  return 'unknown';
}

// plistの1リソース辞書 → 扱いやすい形。text は「テキストとして読む価値がある時だけ」入れる
// テキストとして読むMIME。CSSとJavaScriptは本文になり得ないので、わざわざ読まない
// （実物のpixivアーカイブには数十件の付属リソースが入っていて、全部デコードすると無駄が大きい）
const TEXTISH_MIME = /^(text\/(html|plain|xml|markdown|csv)|application\/(xhtml\+xml|json|ld\+json))$/;
const DECODE_LIMIT = 16 * 1024 * 1024;  // これより大きいテキストは読まない（画像・動画の巻き添え防止）

function resourceFrom(dict) {
  if (!dict || typeof dict !== 'object') return null;
  const data = dict.WebResourceData || null;
  const mime = String(dict.WebResourceMIMEType || '').toLowerCase().split(';')[0].trim();
  const encName = dict.WebResourceTextEncodingName || '';
  const url = dict.WebResourceURL || '';
  const r = { data, mime, encName, url, text: '' };
  if (data && data.length && data.length <= DECODE_LIMIT && (!mime || TEXTISH_MIME.test(mime))) {
    const isHtml = !mime || /^(text\/html|application\/xhtml\+xml)$/.test(mime);
    const d = isHtml ? decodeHtmlBytes(data, encName) : decodeBytes(data, encName);
    r.text = d.text;
    r.enc = d.enc;
    r.refixed = !!d.refixed;
  }
  return r;
}

// WebSubframeArchives を再帰で平らにする（深い入れ子・循環はここで止める）
function collectSubframes(archive, out, depth) {
  if (!archive || depth > 4 || out.length >= 30) return;
  const frames = archive.WebSubframeArchives;
  if (!Array.isArray(frames)) return;
  for (const f of frames) {
    const r = resourceFrom(f && f.WebMainResource);
    if (r && r.text) out.push(r);
    collectSubframes(f, out, depth + 1);
  }
}

// .webarchive（や、拡張子だけ webarchive の素のHTML）を読み解く。
//   → { format, html, url, mime, enc, data, subframes[], subresources[] }
// html は主リソースがテキストのときだけ入る。失敗は throw（呼び出し側がそのまま利用者に見せる）
function parseWebArchive(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const kind = sniffArchiveKind(bytes);

  // 拡張子だけ .webarchive の素のHTML（保存し損ね・別ツールの書き出し）
  if (kind === 'html') {
    const d = decodeHtmlBytes(bytes, '');
    return {
      format: 'html', html: d.text, url: '', mime: 'text/html', enc: d.enc,
      data: bytes, subframes: [], subresources: [],
    };
  }

  if (kind === 'unknown') {
    throw new Error('Safariのwebarchive形式ではありません（先頭: 「' + headPreview(bytes, 24) +
      '」）。Safariの共有メニューから「Webアーカイブ」で保存し直してください');
  }

  let root;
  try {
    root = kind === 'bplist' ? parseBPlist(arrayBuffer) : parseXmlPlist(decodeBytes(bytes, '').text);
  } catch (e) {
    throw new Error('webarchiveが壊れているか、途中で切れています（' + (e && e.message ? e.message : '解析できません') +
      '）。Safariで保存し直してください');
  }

  const main = resourceFrom(root && root.WebMainResource);
  if (!main || !main.data || !main.data.length) {
    throw new Error('webarchiveの中にWebページ本体が入っていません。Safariで保存し直してください');
  }

  const subframes = [];
  collectSubframes(root, subframes, 0);

  const subresources = [];
  if (Array.isArray(root.WebSubresources)) {
    for (const s of root.WebSubresources) {
      const r = resourceFrom(s);
      if (r && r.text) subresources.push(r);
      if (subresources.length >= 60) break;
    }
  }

  return {
    format: kind,
    html: main.text,
    url: main.url,
    mime: main.mime,
    enc: main.enc || '',
    refixed: !!main.refixed,
    data: main.data,
    subframes,
    subresources,
  };
}

// --- HTML → book ---

// <ruby>漢字<rt>かな</rt></ruby> → ｜漢字《かな》（青空文庫式のルビ記法。描画は app.js の renderInline）
// pixivの新マークアップは
//   <ruby class="style_novel-ruby__…"><rb><span…>親</span></rb><rp>(</rp><rt><span…>読み</span></rt><rp>)</rp></ruby>
// と rb/rt の中に span がネストするので、タグ構造ではなく textContent で親文字と読みを取る。
// rp（ルビ非対応ブラウザ用のカッコ）は捨てる。
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
  if (!rt) return base;    // 読みが空ならルビにしない
  if (!base) return rt;    // 親文字が無いルビは記法に書けないので読みだけ残す
  // 記法に使う文字が中身に入っていると読み直せなくなる（極めて稀）。その時だけ従来の平文に逃がす
  if (/[｜《》]/.test(base) || /[｜《》]/.test(rt)) return base + '（' + rt + '）';
  return '｜' + base + '《' + rt + '》';
}

// 要素の中身を「ルビ記法つきのテキスト」にする。
// textContent だとルビの親文字と読みが繋がって読めなくなる場所（章見出しなど）で使う
function inlineText(el) {
  let out = '';
  const walk = node => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === Node.TEXT_NODE) { out += ch.nodeValue; return; }
      if (ch.nodeType !== Node.ELEMENT_NODE) return;
      if (ch.tagName === 'RUBY') { out += rubyToText(ch); return; }
      walk(ch);
    });
  };
  walk(el);
  return out;
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
      lines.push({ kind: 'chapter', text: inlineText(el).trim() });   // 見出しのルビも記法で残す
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

// HTML1枚 → book。取り出せなければ null（＝呼び出し側が救済に回る）
function htmlToBook(html, stem) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');

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
  if (!text) return null;
  const pageTitle = (doc.title || '').trim();
  const res = convertText(text, pageTitle || stem);
  res.warnings.unshift(structureMissed
    ? 'pixivの本文構造を認識できなかったため汎用抽出にフォールバックしました（サイト側の仕様変更かもしれません）'
    : '小説ページの形式ではなかったため、本文を推定で取り込みました');
  res.rawText = text;
  if (pageUrl) res.url = pageUrl;
  return res;
}

// ===== 空の殻の救済 =====
// SPAのページを描画前に保存すると、主HTMLに本文が1文字も入っていないことがある。
// そういう時でも、埋め込みフレームや付属データ（JSON）に本文が残っていることが多い。

function bookTextLen(res) {
  return res && !res.error && res.rawText ? res.rawText.trim().length : 0;
}

// 日本語（かな・漢字）の割合。付属データから本文を拾うときの足切りに使う
function jaRatio(s) {
  if (!s) return 0;
  const m = s.match(/[぀-ヿ㐀-鿿]/g);
  return m ? m.length / s.length : 0;
}

// JSONの中の文字列をぜんぶ集める（本文がどのキーに入っているか分からないため）
function stringsFromJson(v, out, depth) {
  if (out.length >= 4000 || depth > 12) return;
  if (typeof v === 'string') { if (v.length >= 40) out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) stringsFromJson(x, out, depth + 1); return; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) stringsFromJson(v[k], out, depth + 1); }
}

// 文字列の中のHTMLをゆるくテキストへ（<br>・</p> は改行、他のタグは落とす）
function looseHtmlToText(s) {
  return String(s)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n');
}

const SALVAGE_MIN_LEN = 200;    // これ未満は本文と見なさない（UI文言やメタデータの誤爆よけ）
const SALVAGE_MIN_JA = 0.3;     // 日本語がこの割合を切るものも見ない

// 付属リソース（JSON・テキスト）から本文らしい最長の塊を拾う。見つからなければ null
function salvageFromSubresources(list) {
  let best = null;
  for (const r of list || []) {
    const isJson = /json/.test(r.mime) || (!r.mime && /^\s*[{[]/.test(r.text));
    const cands = [];
    if (isJson) {
      let obj = null;
      try { obj = JSON.parse(r.text); } catch (e) { obj = null; }
      if (obj === null) continue;
      stringsFromJson(obj, cands, 0);
    } else if (/^text\//.test(r.mime)) {
      if (/javascript|css/.test(r.mime)) continue;
      cands.push(r.text);
    } else {
      continue;
    }
    for (const c of cands) {
      const t = looseHtmlToText(c).trim();
      if (t.length < SALVAGE_MIN_LEN) continue;
      if (jaRatio(t) < SALVAGE_MIN_JA) continue;
      if (!best || t.length > best.text.length) best = { text: t, kind: isJson ? 'JSON' : 'テキスト', url: r.url };
    }
  }
  return best;
}

// .webarchive → book。archive は parseWebArchive の戻り（省略可・省略時は主HTMLだけで判断）。
// 方針は「文字が一文字でも取れたら必ず取り込む」。本当に何も無い時だけ error を返す
function webArchiveToBook(html, stem, archive) {
  const arc = archive || {};
  const subframes = arc.subframes || [];
  const subresources = arc.subresources || [];

  let best = htmlToBook(html, stem);

  // 主HTMLが空か、極端に短くて埋め込みフレームがあるなら、フレームの中身も見る
  if (!best || (bookTextLen(best) < 40 && subframes.length)) {
    for (const f of subframes) {
      const r = htmlToBook(f.text, stem);
      if (bookTextLen(r) > bookTextLen(best)) {
        r.warnings.unshift('本文は埋め込みフレームから取り出しました');
        if (!r.url && f.url) r.url = f.url;
        best = r;
      }
    }
  }
  if (bookTextLen(best) >= 40) return best;

  // それでも空なら、付属データ（JSON等）に本文が残っていないか探す
  const salvaged = salvageFromSubresources(subresources);
  if (salvaged) {
    const r = convertText(salvaged.text, stem);
    r.warnings.unshift(`本文は付属データ（${salvaged.kind}）から推定で取り出しました`);
    r.rawText = salvaged.text;
    if (salvaged.url) r.url = salvaged.url;
    return r;
  }

  // 短くても取れているならそれを出す（文字が1つでも取れたら取り込む、が方針）。
  // ただし「描画前の空の殻を保存してしまった」可能性が高いので、それが分かる警告を必ず添える
  if (bookTextLen(best) > 0) {
    const n = bookTextLen(best);
    if (n < 40) {
      best.warnings.unshift(`本文がほとんど入っていません（${n}文字だけ取り出せました）。` +
        'JavaScriptで後から本文を描くページを、描かれる前に保存した可能性があります。' +
        '本文が画面に出ている状態で保存し直すと、ちゃんと取り込めます');
    }
    return best;
  }

  // 本当に1文字も無い
  const title = (html || '').match(/<title[^>]*>([^<]*)<\/title>/i);
  const what = title && title[1].trim() ? `（保存されていたページは「${title[1].trim()}」）` : '';
  return { error: '保存時点のHTMLに本文の文字が1つも入っていませんでした' + what +
    '。JavaScriptで後から本文を描くページの可能性があります。' +
    'ページの読み込みが終わって本文が画面に出ている状態で、もう一度保存してください' };
}
