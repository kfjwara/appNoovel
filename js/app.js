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
let book = null;        // { title, chapters: [{title, content}] }
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

// ===== Bookmark =====
function saveBookmark() {
  if (!currentFile) return;
  const wrap = document.getElementById('reader-wrap');
  const ratio = wrap.scrollTop / (wrap.scrollHeight - wrap.clientHeight || 1);
  localStorage.setItem('bm_' + currentFile, JSON.stringify({ chapter: currentChapter, ratio }));
}

function getBookmark() {
  if (!currentFile) return { chapter: 0, ratio: 0 };
  return JSON.parse(localStorage.getItem('bm_' + currentFile) || '{"chapter":0,"ratio":0}');
}

function restoreScroll(ratio) {
  if (!ratio) return;
  setTimeout(() => {
    const wrap = document.getElementById('reader-wrap');
    wrap.scrollTop = ratio * (wrap.scrollHeight - wrap.clientHeight);
  }, 80);
}

// ===== Scroll: progress + debounced bookmark =====
let scrollTimer;
document.getElementById('reader-wrap').addEventListener('scroll', () => {
  const wrap = document.getElementById('reader-wrap');
  const ratio = wrap.scrollTop / (wrap.scrollHeight - wrap.clientHeight || 1);
  document.getElementById('progress-bar').style.width = (ratio * 100) + '%';
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveBookmark, 500);
});

// ===== Render chapter =====
function renderChapter(idx, scrollRatio) {
  if (!book) return;
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
  ch.blocks.forEach(b => {
    if (b.t === 'p') {
      const p = document.createElement('p');
      p.className = 'para' + (/^[「『（(]/.test(b.text) ? ' no-indent' : '');
      p.textContent = b.text;
      body.appendChild(p);
    } else if (b.t === 'h') {
      const h = document.createElement('h3');
      h.className = 'section-title';
      h.textContent = b.text;
      body.appendChild(h);
    } else if (b.t === 'gap') {
      const g = document.createElement('div');
      g.className = 'scene-gap';
      body.appendChild(g);
    } else if (b.t === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
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
      wrap.appendChild(tbl);
      body.appendChild(wrap);
    }
  });
  reader.appendChild(body);

  const wrap = document.getElementById('reader-wrap');
  wrap.scrollTop = 0;
  document.getElementById('progress-bar').style.width = '0%';

  updateChapterNav();
  highlightToc();

  if (scrollRatio) restoreScroll(scrollRatio);
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
  book = record.noovel;
  localStorage.setItem('noovel_last', record.id);

  document.getElementById('shelf').classList.add('hidden');
  document.getElementById('reader').classList.remove('hidden');
  document.getElementById('chapter-nav').classList.remove('hidden');
  document.getElementById('btn-left').textContent = '目次';
  document.getElementById('btn-left').dataset.mode = 'toc';
  document.getElementById('header-title').textContent = book.title;

  buildToc();

  const bm = getBookmark();
  renderChapter(bm.chapter || 0, bm.ratio || 0);

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

  // 続きから読むバー（最後に開いた本へ1タップで再開）
  const resume = document.getElementById('resume-bar');
  const lastRec = books.find(b => b.id === localStorage.getItem('noovel_last'));
  resume.classList.toggle('hidden', !lastRec);
  if (lastRec) {
    resume.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'resume-label';
    label.textContent = '▶ 続きから読む';
    const t = document.createElement('div');
    t.className = 'resume-title';
    t.textContent = lastRec.title;
    const meta = document.createElement('div');
    meta.className = 'resume-meta';
    const bm = JSON.parse(localStorage.getItem('bm_' + lastRec.id) || 'null');
    const chTitle = (lastRec.noovel && bm && lastRec.noovel.chapters[bm.chapter]) ? lastRec.noovel.chapters[bm.chapter].title : '';
    meta.textContent = [chTitle, Math.round(bookProgress(lastRec) * 100) + '%'].filter(Boolean).join(' ・ ');
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
  book = null;
  currentFile = null;
  document.getElementById('reader').classList.add('hidden');
  document.getElementById('chapter-nav').classList.add('hidden');
  document.getElementById('shelf').classList.remove('hidden');
  document.getElementById('btn-left').textContent = '開く';
  document.getElementById('btn-left').dataset.mode = 'open';
  document.getElementById('header-title').textContent = 'Noovel';
  document.getElementById('progress-bar').style.width = '0%';
  renderShelf();
}

function buildToc() {
  const list = document.getElementById('toc-list');
  list.innerHTML = '';
  document.getElementById('toc-book-title').textContent = book.title;
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
}

// ===== Header left button (open / toc) =====
document.getElementById('btn-left').addEventListener('click', () => {
  if (document.getElementById('btn-left').dataset.mode === 'toc') {
    highlightToc();
    document.getElementById('toc-panel').classList.remove('hidden');
  } else {
    document.getElementById('file-input').click();
  }
});

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
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
  cfg.vertical = e.target.checked; applyStyle(); saveCfg();
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

  document.getElementById('reader').classList.toggle('vertical', cfg.vertical);

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

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

applyStyle();
renderShelf();
