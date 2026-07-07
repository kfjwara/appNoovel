'use strict';

const DEFAULTS = {
  fontSize: 18,
  lineHeight: 2.0,
  bgColor: '#f5f0e8',
  textColor: '#333333',
  font: 'serif',
  vertical: false,
  theme: 'warm',
};

const THEMES = {
  warm:  { bg: '#f5f0e8', text: '#333333' },
  white: { bg: '#ffffff', text: '#333333' },
  dark:  { bg: '#1a1a1a', text: '#dddddd' },
  sepia: { bg: '#fbf0d9', text: '#5c4b2a' },
};

const FONTS = {
  serif:   "'Hiragino Mincho ProN','Yu Mincho',serif",
  gothic:  "'Hiragino Sans','Yu Gothic',sans-serif",
  rounded: "'Hiragino Maru Gothic ProN',sans-serif",
};

let cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('noovel_cfg') || '{}') };
let book = null;           // { title, chapters: [{title, blocks}] }
let currentRecord = null;  // 開いてる本のDBレコード（marks の保存先）
let currentChapter = 0;
let currentFile = null;

function saveCfg() {
  localStorage.setItem('noovel_cfg', JSON.stringify(cfg));
}

// ===== Library (IndexedDB) =====
const DB_NAME = 'noovel';
const STORE = 'books';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ===== Import (parsing lives in convert.js) =====
function decodeBuffer(buf) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), enc: 'utf-8' }; }
  catch (e) { return { text: new TextDecoder('shift_jis').decode(buf), enc: 'shift_jis' }; }
}

function importContent(raw, name, encWarning) {
  const stem = name.replace(/\.[^.]+$/, '');
  const ext = ((name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
  let res;
  if (ext === 'noovel') {
    const r = parseNoovelJSON(raw);
    if (r.error) {
      res = convertText(raw, stem);
      res.warnings.unshift(`.noovel の検証に通らなかったため自動整形で取り込みました（${r.error}）`);
    } else {
      res = r;
    }
  } else {
    res = convertText(raw, stem);
  }
  if (encWarning) res.warnings.unshift(encWarning);
  if (res.warnings.length) alert('取り込みメモ：\n・' + res.warnings.join('\n・'));

  const now = Date.now();
  const record = {
    id: name,
    title: res.book.title,
    author: res.book.author,
    noovel: res.book,
    raw,
    chapterCount: res.book.chapters.length,
    addedAt: now,
    lastReadAt: now,
  };
  dbPut(record).catch(err => console.error('library save failed', err));
  openBook(record);
}

// ===== Scroll axis helpers（縦書き=横スクロールに対応） =====
function isVerticalMode() {
  return document.getElementById('reader-wrap').classList.contains('vertical');
}

// 読書位置を 0〜1 の比率で返す（縦書きは scrollLeft が負に進む実装に対応）
function getScrollRatio() {
  const wrap = document.getElementById('reader-wrap');
  if (isVerticalMode()) {
    const max = wrap.scrollWidth - wrap.clientWidth;
    return max ? Math.min(1, Math.abs(wrap.scrollLeft) / max) : 0;
  }
  const max = wrap.scrollHeight - wrap.clientHeight;
  return max ? Math.min(1, wrap.scrollTop / max) : 0;
}

function setScrollRatio(ratio) {
  const wrap = document.getElementById('reader-wrap');
  if (isVerticalMode()) {
    const max = wrap.scrollWidth - wrap.clientWidth;
    wrap.scrollLeft = -(ratio * max);
  } else {
    wrap.scrollTop = ratio * (wrap.scrollHeight - wrap.clientHeight);
  }
}

// 画面の読み始め位置にあるブロック番号（段落アンカー。文字サイズ・縦横切替でもズレない）
function firstVisibleBlockIndex() {
  const wrap = document.getElementById('reader-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  const els = document.querySelectorAll('#reader [data-blk]');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (isVerticalMode() ? r.left < wrapRect.right - 4 : r.bottom > wrapRect.top + 4) {
      return +el.dataset.blk;
    }
  }
  return 0;
}

function scrollToBlock(blk) {
  const el = document.querySelector(`#reader [data-blk="${blk}"]`);
  if (el) el.scrollIntoView({ block: 'start', inline: 'start' });
}

// ===== Bookmark（自動しおり） =====
function saveBookmark() {
  if (!currentFile) return;
  localStorage.setItem('bm_' + currentFile, JSON.stringify({
    chapter: currentChapter,
    ratio: getScrollRatio(),
    blk: firstVisibleBlockIndex(),
  }));
}

function getBookmark() {
  if (!currentFile) return { chapter: 0, ratio: 0 };
  return JSON.parse(localStorage.getItem('bm_' + currentFile) || '{"chapter":0,"ratio":0}');
}

function restoreScroll(ratio) {
  if (!ratio) return;
  setTimeout(() => setScrollRatio(ratio), 80);
}

// ===== Scroll: progress + debounced bookmark =====
let scrollTimer;
document.getElementById('reader-wrap').addEventListener('scroll', () => {
  document.getElementById('progress-bar').style.width = (getScrollRatio() * 100) + '%';
  hidePressMenu();
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveBookmark, 500);
});

// ===== Render chapter =====
// pos: { blk?: number, ratio?: number } — blk（段落アンカー）優先、ratioは旧データ互換
function renderChapter(idx, pos = {}) {
  if (!book) return;
  hidePressMenu();
  currentChapter = Math.max(0, Math.min(idx, book.chapters.length - 1));
  const ch = book.chapters[currentChapter];
  const reader = document.getElementById('reader');

  reader.innerHTML = '';

  if (ch.title && book.chapters.length > 1) {
    const h = document.createElement('h2');
    h.className = 'chapter-title';
    h.textContent = ch.title;
    reader.appendChild(h);
  }

  const body = document.createElement('div');
  body.className = 'chapter-body';
  ch.blocks.forEach((b, i) => {
    let el = null;
    if (b.t === 'p') {
      el = document.createElement('p');
      el.className = 'para' + (/^[「『（(]/.test(b.text) ? ' no-indent' : '');
      const span = document.createElement('span');  // マーカーを行単位で塗るための内側要素
      span.textContent = b.text;
      el.appendChild(span);
    } else if (b.t === 'h') {
      el = document.createElement('h3');
      el.className = 'section-title';
      el.textContent = b.text;
    } else if (b.t === 'gap') {
      el = document.createElement('div');
      el.className = 'scene-gap';
    } else if (b.t === 'table') {
      el = document.createElement('div');
      el.className = 'table-wrap';
      const tbl = document.createElement('table');
      tbl.className = 'n-table';
      b.rows.forEach((row, ri) => {
        const tr = document.createElement('tr');
        row.forEach(cell => {
          const td = document.createElement(ri === 0 ? 'th' : 'td');
          td.textContent = cell;
          tr.appendChild(td);
        });
        tbl.appendChild(tr);
      });
      el.appendChild(tbl);
    }
    if (el) {
      el.dataset.blk = i;
      body.appendChild(el);
    }
  });
  reader.appendChild(body);

  const wrap = document.getElementById('reader-wrap');
  wrap.scrollTop = 0;
  wrap.scrollLeft = 0;
  document.getElementById('progress-bar').style.width = '0%';

  updateChapterNav();
  highlightToc();
  applyMarkClasses();

  if (pos.blk != null && pos.blk > 0) setTimeout(() => scrollToBlock(pos.blk), 80);
  else if (pos.ratio) restoreScroll(pos.ratio);
}

function updateChapterNav() {
  if (!book) return;
  const ch = book.chapters[currentChapter];
  document.getElementById('ch-title-nav').textContent = ch.title;
  document.getElementById('ch-counter').textContent = `${currentChapter + 1} / ${book.chapters.length}`;
  document.getElementById('btn-prev-ch').disabled = currentChapter === 0;
  document.getElementById('btn-next-ch').disabled = currentChapter === book.chapters.length - 1;
}

function highlightToc() {
  document.querySelectorAll('.toc-item').forEach((el, i) => {
    el.classList.toggle('active', i === currentChapter);
  });
}

// ===== Open book =====
function openRecord(rec) {
  if (rec.noovel) { openBook(rec); return; }
  // 旧形式（生テキスト保存）からの移行：一度変換して保存し直す
  const res = convertText(rec.text, rec.id.replace(/\.[^.]+$/, ''));
  rec.noovel = res.book;
  rec.raw = rec.text;
  delete rec.text;
  rec.title = res.book.title;
  rec.chapterCount = res.book.chapters.length;
  openBook(rec);
}

function openBook(record) {
  currentFile = record.id;
  currentRecord = record;
  book = record.noovel;
  localStorage.setItem('noovel_last', record.id);
  applyStyle();  // 縦書きは読書中のみ有効（本棚では効かせない）

  document.getElementById('shelf').classList.add('hidden');
  document.getElementById('reader').classList.remove('hidden');
  document.getElementById('chapter-nav').classList.remove('hidden');
  const left = document.getElementById('btn-left');
  left.innerHTML = SHELF_ICON;
  left.dataset.mode = 'shelf';
  left.setAttribute('aria-label', '本棚へ戻る');
  document.getElementById('header-title').textContent = book.title;

  buildToc();

  const bm = getBookmark();
  renderChapter(bm.chapter || 0, { blk: bm.blk, ratio: bm.ratio });

  record.lastReadAt = Date.now();
  dbPut(record).catch(() => {});
}

// ===== Bookshelf =====
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function bookProgress(rec) {
  const bm = JSON.parse(localStorage.getItem('bm_' + rec.id) || 'null');
  if (!bm || !rec.chapterCount) return 0;
  const p = ((bm.chapter || 0) + (bm.ratio || 0)) / rec.chapterCount;
  return Math.max(0, Math.min(1, p));
}

async function renderShelf() {
  const list = document.getElementById('shelf-list');
  const emptyMsg = document.getElementById('shelf-empty');
  let books = [];
  try {
    books = await dbGetAll();
  } catch (err) {
    console.error('library load failed', err);
  }
  books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));

  list.innerHTML = '';
  emptyMsg.classList.toggle('hidden', books.length > 0);

  // 続きから読む：下部固定ピル（最後に開いた本へ1タップで再開）
  const resume = document.getElementById('resume-bar');
  const lastRec = books.find(b => b.id === localStorage.getItem('noovel_last'));
  resume.classList.toggle('hidden', !lastRec);
  if (lastRec) {
    resume.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'resume-label';
    label.textContent = '▶';
    const t = document.createElement('span');
    t.className = 'resume-title';
    t.textContent = lastRec.title;
    const meta = document.createElement('span');
    meta.className = 'resume-meta';
    meta.textContent = Math.round(bookProgress(lastRec) * 100) + '%';
    resume.append(label, t, meta);
    resume.onclick = () => openRecord(lastRec);
  }

  books.forEach(rec => {
    const card = document.createElement('div');
    card.className = 'book-card';

    const main = document.createElement('button');
    main.className = 'book-main';

    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = rec.title;

    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const pct = Math.round(bookProgress(rec) * 100);
    meta.textContent = `${pct}%読了 ・ ${formatDate(rec.lastReadAt)}`;

    const bar = document.createElement('div');
    bar.className = 'book-progress';
    const fill = document.createElement('div');
    fill.className = 'book-progress-fill';
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    main.append(title, meta, bar);
    main.addEventListener('click', () => openRecord(rec));

    const del = document.createElement('button');
    del.className = 'book-delete';
    del.textContent = '✕';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`「${rec.title}」を本棚から削除しますか？`)) return;
      await dbDelete(rec.id).catch(err => console.error('delete failed', err));
      localStorage.removeItem('bm_' + rec.id);
      if (localStorage.getItem('noovel_last') === rec.id) localStorage.removeItem('noovel_last');
      renderShelf();
    });

    card.append(main, del);
    list.appendChild(card);
  });
}

function showShelf() {
  saveBookmark();
  hidePressMenu();
  book = null;
  currentFile = null;
  currentRecord = null;
  applyStyle();  // 本棚は常に横書きに戻す
  document.getElementById('reader').classList.add('hidden');
  document.getElementById('chapter-nav').classList.add('hidden');
  document.getElementById('shelf').classList.remove('hidden');
  const left = document.getElementById('btn-left');
  left.textContent = '開く';
  left.dataset.mode = 'open';
  left.removeAttribute('aria-label');
  document.getElementById('header-title').textContent = 'Noovel';
  document.getElementById('progress-bar').style.width = '0%';
  renderShelf();
}

// ===== しおり・マーカー（段落アンカー） =====
function hasMark(kind, ch, blk) {
  return !!(currentRecord && currentRecord[kind] && currentRecord[kind].some(m => m.ch === ch && m.blk === blk));
}

function toggleMark(kind) {
  if (!pressBlockEl || !currentRecord) return;
  const blk = +pressBlockEl.dataset.blk;
  const list = currentRecord[kind] || (currentRecord[kind] = []);
  const i = list.findIndex(m => m.ch === currentChapter && m.blk === blk);
  if (i >= 0) list.splice(i, 1);
  else list.push({ ch: currentChapter, blk, at: Date.now() });
  dbPut(currentRecord).catch(err => console.error('mark save failed', err));
  hidePressMenu();
  applyMarkClasses();
}

function applyMarkClasses() {
  document.querySelectorAll('#reader [data-blk]').forEach(el => {
    const blk = +el.dataset.blk;
    el.classList.toggle('marked', hasMark('markers', currentChapter, blk));
    el.classList.toggle('bookmarked', hasMark('bookmarks', currentChapter, blk));
  });
}

// ===== 長押しメニュー =====
let pressTimer = null;
let pressStart = null;
let pressBlockEl = null;

function hidePressMenu() {
  const menu = document.getElementById('press-menu');
  if (menu) menu.classList.add('hidden');
  if (pressBlockEl) { pressBlockEl.classList.remove('pressing'); pressBlockEl = null; }
}

function showPressMenu(el) {
  if (!currentRecord) return;
  pressBlockEl = el;
  el.classList.add('pressing');
  const blk = +el.dataset.blk;
  document.getElementById('pm-marker').textContent = hasMark('markers', currentChapter, blk) ? 'マーカー解除' : 'マーカー';
  document.getElementById('pm-bookmark').textContent = hasMark('bookmarks', currentChapter, blk) ? 'しおりを外す' : 'しおり';

  const menu = document.getElementById('press-menu');
  menu.classList.remove('hidden');
  const wrap = document.getElementById('reader-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = r.top - wrapRect.top + wrap.scrollTop - menu.offsetHeight - 10;
  let left = r.left - wrapRect.left + wrap.scrollLeft + r.width / 2;
  const half = menu.offsetWidth / 2;
  left = Math.max(half + 6, Math.min(left, wrapRect.width - half - 6 + wrap.scrollLeft));
  menu.style.top = Math.max(top, wrap.scrollTop + 6) + 'px';
  menu.style.left = left + 'px';
}

const readerEl = document.getElementById('reader');
readerEl.addEventListener('touchstart', e => {
  const el = e.target.closest('p[data-blk], h3[data-blk]');
  if (!el) return;
  pressStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => showPressMenu(el), 500);
}, { passive: true });
readerEl.addEventListener('touchmove', e => {
  if (!pressStart) return;
  const dx = e.touches[0].clientX - pressStart.x;
  const dy = e.touches[0].clientY - pressStart.y;
  if (dx * dx + dy * dy > 100) { clearTimeout(pressTimer); pressTimer = null; }
}, { passive: true });
readerEl.addEventListener('touchend', () => { clearTimeout(pressTimer); pressTimer = null; pressStart = null; });
// PCでは右クリックで同じメニュー
readerEl.addEventListener('contextmenu', e => {
  const el = e.target.closest('p[data-blk], h3[data-blk]');
  if (!el) return;
  e.preventDefault();
  showPressMenu(el);
});
document.addEventListener('click', e => {
  if (pressBlockEl && !e.target.closest('#press-menu')) hidePressMenu();
});
document.getElementById('pm-marker').addEventListener('click', () => toggleMark('markers'));
document.getElementById('pm-bookmark').addEventListener('click', () => toggleMark('bookmarks'));

// ===== 目次パネル（目次｜しおり｜マーカー） =====
let tocTab = 'toc';

document.querySelectorAll('.toc-tab').forEach(btn => {
  btn.addEventListener('click', () => { tocTab = btn.dataset.tab; renderTocPanel(); });
});

function buildToc() {
  tocTab = 'toc';
  document.getElementById('toc-book-title').textContent = book.title;
  renderTocPanel();
}

function markQuote(m) {
  const ch = book.chapters[m.ch];
  if (!ch) return '';
  const b = ch.blocks[m.blk];
  const t = (b && b.text) || '';
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

function renderTocPanel() {
  if (!book) return;
  const bms = (currentRecord && currentRecord.bookmarks) || [];
  const mks = (currentRecord && currentRecord.markers) || [];
  document.querySelector('.toc-tab[data-tab="bm"]').textContent = bms.length ? `しおり ${bms.length}` : 'しおり';
  document.querySelector('.toc-tab[data-tab="mk"]').textContent = mks.length ? `マーカー ${mks.length}` : 'マーカー';
  document.querySelectorAll('.toc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tocTab));

  const list = document.getElementById('toc-list');
  list.innerHTML = '';

  if (tocTab === 'toc') {
    book.chapters.forEach((ch, i) => {
      const btn = document.createElement('button');
      btn.className = 'toc-item';
      btn.textContent = ch.title || `第${i + 1}章`;
      btn.addEventListener('click', () => {
        renderChapter(i);
        document.getElementById('toc-panel').classList.add('hidden');
      });
      list.appendChild(btn);
    });
    highlightToc();
    return;
  }

  const kind = tocTab === 'bm' ? 'bookmarks' : 'markers';
  const items = (tocTab === 'bm' ? bms : mks).slice().sort((a, b) => a.ch - b.ch || a.blk - b.blk);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mark-empty';
    empty.textContent = tocTab === 'bm'
      ? '本文の段落を長押し →「しおり」で挟めます'
      : '本文の段落を長押し →「マーカー」で塗れます';
    list.appendChild(empty);
    return;
  }

  items.forEach(m => {
    const item = document.createElement('button');
    item.className = 'mark-item ' + (tocTab === 'bm' ? 'is-bm' : 'is-mk');

    const where = document.createElement('div');
    where.className = 'mark-where';
    const chName = document.createElement('span');
    chName.textContent = (book.chapters[m.ch] && book.chapters[m.ch].title) || `第${m.ch + 1}章`;
    const when = document.createElement('span');
    when.textContent = formatDate(m.at);
    where.append(chName, when);

    const quote = document.createElement('div');
    quote.className = 'mark-quote';
    quote.textContent = markQuote(m);

    item.append(where, quote);
    item.addEventListener('click', () => {
      renderChapter(m.ch, { blk: m.blk });
      document.getElementById('toc-panel').classList.add('hidden');
    });

    // 左スワイプで削除
    let sx = null;
    item.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    item.addEventListener('touchend', e => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (dx < -60) {
        if (!confirm('この' + (tocTab === 'bm' ? 'しおり' : 'マーカー') + 'を削除しますか？')) return;
        const arr = currentRecord[kind];
        const i = arr.findIndex(x => x.ch === m.ch && x.blk === m.blk);
        if (i >= 0) arr.splice(i, 1);
        dbPut(currentRecord).catch(() => {});
        renderTocPanel();
        applyMarkClasses();
      }
    }, { passive: true });

    list.appendChild(item);
  });
}

// ===== Header left button (open / back-to-shelf) =====
// 本棚アイコン（線画SVG。読書中のヘッダー左＝本棚へ戻る）
const SHELF_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 3v15M10 3v15M14.5 4.5L19 18"/><path d="M3 21h18"/></svg>';

document.getElementById('btn-left').addEventListener('click', () => {
  if (document.getElementById('btn-left').dataset.mode === 'shelf') {
    showShelf();
  } else {
    document.getElementById('file-input').click();
  }
});

// 章ナビ中央（いま居る章の表示）タップ = 目次を開く（案A）
document.getElementById('chapter-nav-info').addEventListener('click', () => {
  renderTocPanel();
  document.getElementById('toc-panel').classList.remove('hidden');
});

// PDF: pdf.js（UMD版・scriptタグ読み込み）を必要時のみ遅延ロード → 通常の変換パイプラインへ
// ※ESモジュール版はiOS Safariで「Importing a module script failed」になるため使わない
let pdfjsLoader = null;
function loadPdfjs() {
  if (!pdfjsLoader) {
    pdfjsLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './js/pdfjs/pdf.min.js';
      s.onload = () => resolve(window.pdfjsLib);
      s.onerror = () => reject(new Error('pdf.js を読み込めませんでした'));
      document.head.appendChild(s);
    });
  }
  return pdfjsLoader;
}

async function importPdf(file) {
  document.getElementById('header-title').textContent = 'PDF読み込み中…';
  try {
    const pdfjs = await loadPdfjs();
    pdfjs.GlobalWorkerOptions.workerSrc = './js/pdfjs/pdf.worker.min.js';
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const numPages = doc.numPages;
    const pages = [];
    for (let p = 1; p <= numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] })));
      page.cleanup();
    }
    doc.destroy();
    const text = pdfPagesToText(pages);
    if (!text.trim()) {
      alert('このPDFからテキストを取り出せませんでした（スキャン画像PDFの可能性があります）');
      return;
    }
    importContent(text, file.name, `PDFから抽出しました（${numPages}ページ）。段落・章立ては推定です`);
  } catch (err) {
    console.error(err);
    alert('PDFの読み込みに失敗しました：' + err.message);
  } finally {
    if (!book) document.getElementById('header-title').textContent = 'Noovel';
  }
}

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (/\.pdf$/i.test(file.name)) {
    importPdf(file);
    e.target.value = '';
    return;
  }
  const fr = new FileReader();
  fr.onload = ev => {
    const { text, enc } = decodeBuffer(ev.target.result);
    importContent(text, file.name, enc === 'shift_jis' ? '文字コードをShift_JISとして読み込みました' : '');
  };
  fr.readAsArrayBuffer(file);
  e.target.value = '';
});

// ===== Paste import =====
document.getElementById('btn-paste-open').addEventListener('click', () => {
  document.getElementById('paste-panel').classList.remove('hidden');
});
document.getElementById('btn-paste-cancel').addEventListener('click', () => {
  document.getElementById('paste-panel').classList.add('hidden');
});
document.getElementById('paste-panel').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});
document.getElementById('btn-paste-import').addEventListener('click', () => {
  let text = document.getElementById('paste-text').value.trim();
  if (!text) { alert('本文が空です'); return; }
  // AI出力のコードフェンスを除去
  text = text.replace(/^```[a-z]*\s*\n/i, '').replace(/\n```\s*$/, '');
  let title = document.getElementById('paste-title').value.trim();

  // JSONが貼られたら .noovel として検証取り込み
  const isNoovel = text.startsWith('{');
  let name;
  if (isNoovel) {
    if (!title) { try { title = (JSON.parse(text).title || '').trim(); } catch (err) { title = ''; } }
    name = (title || '無題') + '.noovel';
  } else {
    if (!title) title = (text.split('\n')[0] || '無題').trim().slice(0, 30);
    name = title + '.txt';
  }

  document.getElementById('paste-panel').classList.add('hidden');
  document.getElementById('paste-text').value = '';
  document.getElementById('paste-title').value = '';
  importContent(text, name, '');
});

// ===== Chapter navigation =====
document.getElementById('btn-prev-ch').addEventListener('click', () => {
  if (currentChapter > 0) renderChapter(currentChapter - 1);
});
document.getElementById('btn-next-ch').addEventListener('click', () => {
  if (book && currentChapter < book.chapters.length - 1) renderChapter(currentChapter + 1);
});

// ===== TOC panel =====
document.getElementById('btn-close-toc').addEventListener('click', () => {
  document.getElementById('toc-panel').classList.add('hidden');
});
document.getElementById('btn-to-shelf').addEventListener('click', () => {
  document.getElementById('toc-panel').classList.add('hidden');
  showShelf();
});
document.getElementById('toc-panel').addEventListener('click', e => {
  if (e.target === e.currentTarget)
    document.getElementById('toc-panel').classList.add('hidden');
});

// ===== Settings panel =====
document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('hidden');
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.add('hidden');
});
document.getElementById('settings-panel').addEventListener('click', e => {
  if (e.target === e.currentTarget)
    document.getElementById('settings-panel').classList.add('hidden');
});

document.getElementById('range-font-size').addEventListener('input', e => {
  cfg.fontSize = +e.target.value;
  document.getElementById('val-font-size').textContent = cfg.fontSize;
  applyStyle(); saveCfg();
});
document.getElementById('range-line-height').addEventListener('input', e => {
  cfg.lineHeight = +e.target.value;
  document.getElementById('val-line-height').textContent = cfg.lineHeight;
  applyStyle(); saveCfg();
});
document.getElementById('pick-bg').addEventListener('input', e => {
  cfg.bgColor = e.target.value; cfg.theme = 'custom';
  applyStyle(); saveCfg();
});
document.getElementById('pick-text').addEventListener('input', e => {
  cfg.textColor = e.target.value; cfg.theme = 'custom';
  applyStyle(); saveCfg();
});
document.getElementById('sel-font').addEventListener('change', e => {
  cfg.font = e.target.value; applyStyle(); saveCfg();
});
document.getElementById('tog-vertical').addEventListener('change', e => {
  const ratio = getScrollRatio();  // 切替前の読書位置を引き継ぐ
  cfg.vertical = e.target.checked; applyStyle(); saveCfg();
  requestAnimationFrame(() => setScrollRatio(ratio));
});
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.theme;
    if (!THEMES[t]) return;
    cfg.theme = t;
    cfg.bgColor = THEMES[t].bg;
    cfg.textColor = THEMES[t].text;
    applyStyle(); saveCfg();
  });
});

// ===== Apply style =====
// 本文背景の輝度からUI（ヘッダー・パネル）の明暗を決める
function uiModeFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'light';
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum < 128 ? 'dark' : 'light';
}

function applyStyle() {
  const r = document.documentElement;
  document.body.dataset.ui = uiModeFor(cfg.bgColor);
  r.style.setProperty('--bg', cfg.bgColor);
  r.style.setProperty('--text', cfg.textColor);
  r.style.setProperty('--font-size', cfg.fontSize + 'px');
  r.style.setProperty('--line-height', cfg.lineHeight);
  r.style.setProperty('--font-family', FONTS[cfg.font] || FONTS.serif);

  // writing-mode はスクロール容器側にかける（横スクロールの開始位置・可到達性のため）
  // ただし本棚表示中は常に横書き
  document.getElementById('reader-wrap').classList.toggle('vertical', cfg.vertical && !!book);

  document.getElementById('range-font-size').value = cfg.fontSize;
  document.getElementById('val-font-size').textContent = cfg.fontSize;
  document.getElementById('range-line-height').value = cfg.lineHeight;
  document.getElementById('val-line-height').textContent = cfg.lineHeight;
  document.getElementById('pick-bg').value = cfg.bgColor;
  document.getElementById('pick-text').value = cfg.textColor;
  document.getElementById('sel-font').value = cfg.font;
  document.getElementById('tog-vertical').checked = cfg.vertical;

  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === cfg.theme);
  });
}

// ===== Backup / Restore =====
// 本棚まるごと（本文・しおり・マーカー・読書位置・設定）を1つのJSONに書き出す／復元する
async function exportBackup() {
  let books = [];
  try { books = await dbGetAll(); }
  catch (err) { alert('本棚の読み出しに失敗しました：' + err.message); return; }
  if (!books.length) { alert('本棚が空です'); return; }

  const positions = {};
  for (const b of books) {
    const bm = localStorage.getItem('bm_' + b.id);
    if (bm) { try { positions[b.id] = JSON.parse(bm); } catch (e) {} }
  }
  const data = {
    noovelBackup: 1,
    exportedAt: Date.now(),
    cfg,
    last: localStorage.getItem('noovel_last') || '',
    books,
    positions,
  };

  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.download = `noovel_backup_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  a.href = URL.createObjectURL(blob);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importBackup(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { alert('バックアップファイルとして読めませんでした'); return; }
  if (data.noovelBackup !== 1 || !Array.isArray(data.books)) {
    alert('Noovelのバックアップファイルではありません');
    return;
  }
  const valid = data.books.filter(r => r && r.id);
  if (!valid.length) { alert('復元できる本が入っていません'); return; }
  if (!confirm(`${valid.length}冊を復元します。同じ本があれば上書きされます。よろしいですか？`)) return;

  let ok = 0;
  for (const rec of valid) {
    try { await dbPut(rec); ok++; }
    catch (err) { console.error('restore failed', rec.id, err); }
  }
  if (data.positions) {
    for (const id of Object.keys(data.positions)) {
      localStorage.setItem('bm_' + id, JSON.stringify(data.positions[id]));
    }
  }
  if (data.last) localStorage.setItem('noovel_last', data.last);
  if (data.cfg) { cfg = { ...DEFAULTS, ...data.cfg }; saveCfg(); applyStyle(); }

  alert(ok === valid.length ? `${ok}冊を復元しました` : `${ok}冊を復元（${valid.length - ok}冊は失敗）`);
  document.getElementById('settings-panel').classList.add('hidden');
  renderShelf();
}

document.getElementById('btn-backup-export').addEventListener('click', exportBackup);
document.getElementById('btn-backup-import').addEventListener('click', () => {
  document.getElementById('backup-input').click();
});
document.getElementById('backup-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = ev => importBackup(ev.target.result);
  fr.readAsText(file, 'UTF-8');
  e.target.value = '';
});

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// バージョン表示（js/version.js が単一正本）
document.getElementById('app-version').textContent = 'Noovel v' + NOOVEL_VERSION;
document.getElementById('shelf-version').textContent = 'v' + NOOVEL_VERSION;

applyStyle();
renderShelf();
