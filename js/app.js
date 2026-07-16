'use strict';

const DEFAULTS = {
  fontSize: 18,
  lineHeight: 2.0,
  bgColor: '#ffffff',
  textColor: '#333333',
  font: 'serif',
  vertical: false,
  theme: 'simple',
};

// bg はテーマの代表色（UIの明暗判定・グラデの下地色）。bgImage があれば body に敷く
const THEMES = {
  simple: { label: 'simple', bg: '#ffffff', text: '#333333' },
  sky: {
    label: 'sky', bg: '#8ccbee', text: '#173850',
    bgImage:
      'radial-gradient(38% 12% at 22% 78%, rgba(255,255,255,.5), transparent 70%),' +
      'radial-gradient(30% 9% at 68% 88%, rgba(255,255,255,.4), transparent 70%),' +
      'linear-gradient(180deg, #66b5e4 0%, #8ccbee 45%, #b8e1f7 80%, #d8effb 100%)',
  },
  night: {
    label: 'night', bg: '#0e1a3f', text: '#ccd9f2',
    bgImage:
      'radial-gradient(1.2px 1.2px at 12% 18%, rgba(255,255,255,.9), transparent 60%),' +
      'radial-gradient(1px 1px at 68% 8%, rgba(255,255,255,.7), transparent 60%),' +
      'radial-gradient(1.4px 1.4px at 85% 30%, rgba(200,220,255,.8), transparent 60%),' +
      'radial-gradient(1px 1px at 35% 42%, rgba(255,255,255,.5), transparent 60%),' +
      'radial-gradient(1.1px 1.1px at 55% 24%, rgba(255,240,200,.6), transparent 60%),' +
      'radial-gradient(1px 1px at 22% 60%, rgba(255,255,255,.4), transparent 60%),' +
      'radial-gradient(1.3px 1.3px at 78% 55%, rgba(210,225,255,.5), transparent 60%),' +
      'linear-gradient(180deg, #060b22 0%, #0e1a3f 55%, #1c2b57 100%)',
  },
  sf: {
    label: 'SF', bg: '#060f16', text: '#c9eaf2',
    bgImage:
      'repeating-linear-gradient(0deg, transparent 0 27px, rgba(70,200,230,.045) 27px 28px),' +
      'repeating-linear-gradient(90deg, transparent 0 27px, rgba(70,200,230,.045) 27px 28px),' +
      'radial-gradient(90% 55% at 50% 118%, rgba(30,120,150,.22) 0%, transparent 65%),' +
      'linear-gradient(180deg, #04090d 0%, #060f16 55%, #0a1922 100%)',
  },
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

function finishImport(res, name, raw) {
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
  finishImport(res, name, raw);
}

// Safariで保存した .webarchive（Webページの丸ごと保存）の取り込み
async function importWebarchive(file) {
  document.getElementById('header-title').textContent = 'webarchive読み込み中…';
  try {
    const buf = await file.arrayBuffer();
    const { html } = parseWebArchive(buf);
    const res = webArchiveToBook(html, file.name.replace(/\.[^.]+$/, ''));
    if (res.error) { alert('取り込めませんでした：' + res.error); return; }
    finishImport(res, file.name, res.rawText || '');
  } catch (err) {
    console.error(err);
    alert('webarchiveの読み込みに失敗しました：' + err.message);
  } finally {
    if (!book) document.getElementById('header-title').textContent = 'Noovel';
  }
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
  updateSeekBar();
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
      // n = 元の空行数。大きさを反映する（省略時は従来の2.2em＝n:2相当、上限4）
      if (b.n) el.style.height = (Math.min(b.n, 4) * 1.1) + 'em';
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
  updateSeekBar();
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
  document.body.classList.add('reading', 'ui-hidden');   // 開いたら即・全画面（タップでUI呼び出し）
  const left = document.getElementById('btn-left');
  left.innerHTML = SHELF_ICON;
  left.dataset.mode = 'shelf';
  left.setAttribute('aria-label', '本棚へ戻る');
  document.getElementById('header-title').textContent = book.title;
  updateHeaderHeight();   // タイトル反映後のヘッダー実高で、進捗バーの位置を決める

  buildToc();

  const bm = getBookmark();
  renderChapter(bm.chapter || 0, { blk: bm.blk, ratio: bm.ratio });

  record.lastReadAt = Date.now();
  dbPut(record).catch(() => {});
}

// ===== タグ =====
// 本のレコードに tags（文字列の配列）を持たせる。複数設定できる。
// タグ一覧は localStorage に明示的に持つ（空タグや並び順を保てるように）
const SHELF_PAGE = 30;
let currentTag = localStorage.getItem('noovel_shelf_tag') || '';
let shelfLimit = SHELF_PAGE;

function getTags() {
  try { return JSON.parse(localStorage.getItem('noovel_tags') || '[]'); }
  catch (e) { return []; }
}
function saveTags(list) { localStorage.setItem('noovel_tags', JSON.stringify(list)); }

// レコードのタグ（旧folder形式の本にも安全に効く読み口）
function recTags(rec) {
  if (Array.isArray(rec.tags)) return rec.tags;
  return rec.folder ? [rec.folder] : [];
}

// 旧フォルダ形式からの一回きり移行（v29）。復元で旧バックアップが入った後にも呼ぶ
async function migrateFoldersToTags() {
  if (localStorage.getItem('noovel_tags') === null && localStorage.getItem('noovel_folders') !== null) {
    localStorage.setItem('noovel_tags', localStorage.getItem('noovel_folders'));
    const oldSel = localStorage.getItem('noovel_shelf_folder');
    if (oldSel) { currentTag = oldSel; localStorage.setItem('noovel_shelf_tag', oldSel); }
  }
  localStorage.removeItem('noovel_folders');
  localStorage.removeItem('noovel_shelf_folder');
  let books = [];
  try { books = await dbGetAll(); } catch (e) { return; }
  for (const b of books) {
    if (Array.isArray(b.tags)) continue;
    b.tags = b.folder ? [b.folder] : [];
    delete b.folder;
    await dbPut(b).catch(() => {});
  }
}

function selectTag(name) {
  currentTag = name;
  localStorage.setItem('noovel_shelf_tag', name);
  shelfLimit = SHELF_PAGE;
  renderShelf();
}

function promptNewTag() {
  const name = (prompt('新しいタグ名') || '').trim();
  if (!name) return null;
  const tags = getTags();
  if (tags.includes(name)) { alert('同じ名前のタグがあります'); return null; }
  tags.push(name);
  saveTags(tags);
  return name;
}

function createTag() {
  const name = promptNewTag();
  if (name) selectTag(name);
}

// タグ名の変更・削除（チップ長押し／右クリック）
async function manageTag(name) {
  const input = prompt('タグ名を変更（空欄にすると削除。本は消えません）', name);
  if (input === null) return;
  const newName = input.trim();
  if (newName === name) return;
  const tags = getTags();
  if (newName && tags.includes(newName)) { alert('同じ名前のタグがあります'); return; }
  if (!newName && !confirm(`タグ「${name}」を削除しますか？（付いていた本からタグが外れるだけです）`)) return;

  let books = [];
  try { books = await dbGetAll(); } catch (e) {}
  for (const b of books) {
    const cur = recTags(b);
    if (!cur.includes(name)) continue;
    b.tags = cur.filter(t => t !== name);
    if (newName && !b.tags.includes(newName)) b.tags.push(newName);
    delete b.folder;
    await dbPut(b).catch(() => {});
  }
  const i = tags.indexOf(name);
  if (newName) tags.splice(i, 1, newName);
  else tags.splice(i, 1);
  saveTags(tags);
  if (currentTag === name) currentTag = newName;
  localStorage.setItem('noovel_shelf_tag', currentTag);
  renderShelf();
}

function renderTagChips() {
  const wrap = document.getElementById('tag-chips');
  wrap.innerHTML = '';
  const tags = getTags();
  if (currentTag && !tags.includes(currentTag)) currentTag = '';

  const mk = (label, value, manageable) => {
    const b = document.createElement('button');
    b.className = 'tag-chip' + (currentTag === value ? ' active' : '');
    b.textContent = label;
    // 選択中のタグをもう一度タップ＝改名/削除（長押しでも可）
    b.addEventListener('click', () => {
      if (manageable && currentTag === value) manageTag(value);
      else selectTag(value);
    });
    if (manageable) {
      let t = null;
      b.addEventListener('touchstart', () => { t = setTimeout(() => manageTag(value), 550); }, { passive: true });
      b.addEventListener('touchend', () => clearTimeout(t));
      b.addEventListener('touchmove', () => clearTimeout(t), { passive: true });
      b.addEventListener('contextmenu', e => { e.preventDefault(); manageTag(value); });
    }
    wrap.appendChild(b);
  };
  mk('すべて', '', false);
  tags.forEach(t => mk(t, t, true));

  const add = document.createElement('button');
  add.className = 'tag-chip tag-add';
  add.textContent = '＋';
  add.setAttribute('aria-label', 'タグを作成');
  add.addEventListener('click', createTag);
  wrap.appendChild(add);
}

// タグ編集シート（カードの ⋯ から開く）。タップでON/OFF、複数付けられる
let editingRec = null;   // 「本の編集」シートで開いている本

// 情報タブ：タイトル・著者の保存（入力確定＝changeと、シートを閉じる時の両方から呼ばれる）
async function saveBookInfo() {
  const rec = editingRec;
  if (!rec) return;
  const title = document.getElementById('edit-title').value.trim();
  const author = document.getElementById('edit-author').value.trim();
  let dirty = false;
  if (title && title !== rec.title) {   // 空タイトルは無視（事故防止）
    rec.title = title;
    if (rec.noovel) rec.noovel.title = title;   // リーダー側の表示とズレないよう両方更新
    dirty = true;
  }
  if (author !== (rec.author || '')) {
    rec.author = author;
    if (rec.noovel) rec.noovel.author = author;
    dirty = true;
  }
  if (dirty) await dbPut(rec).catch(err => console.error('info save failed', err));
}
document.getElementById('edit-title').addEventListener('change', saveBookInfo);
document.getElementById('edit-author').addEventListener('change', saveBookInfo);

function setEditTab(tab) {
  document.querySelectorAll('#edit-tabs .edit-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tag-list').classList.toggle('hidden', tab !== 'tags');
  document.getElementById('edit-info').classList.toggle('hidden', tab !== 'info');
}
document.querySelectorAll('#edit-tabs .edit-tab').forEach(b =>
  b.addEventListener('click', () => setEditTab(b.dataset.tab)));

function openTagEditor(rec) {
  const isReopen = editingRec === rec;   // タグ付け外しによる再描画では入力値・タブを触らない
  editingRec = rec;
  if (!isReopen) {
    document.getElementById('edit-title').value = rec.title || '';
    document.getElementById('edit-author').value = rec.author || '';
    setEditTab('tags');   // 開いたときはタグタブから
  }
  const list = document.getElementById('tag-list');
  list.innerHTML = '';

  const mkToggle = name => {
    const on = recTags(rec).includes(name);
    const b = document.createElement('button');
    b.className = 'tag-pick-item' + (on ? ' active' : '');
    b.textContent = (on ? '✓ ' : '') + name;
    b.addEventListener('click', async () => {
      const cur = recTags(rec);
      rec.tags = cur.includes(name) ? cur.filter(t => t !== name) : [...cur, name];
      delete rec.folder;
      await dbPut(rec).catch(err => console.error('tag save failed', err));
      openTagEditor(rec); // シートは開いたまま表示を更新（複数付け外しできるように）
    });
    list.appendChild(b);
  };
  getTags().forEach(mkToggle);

  const add = document.createElement('button');
  add.className = 'tag-pick-item';
  add.textContent = '＋ 新しいタグ…';
  add.addEventListener('click', async () => {
    const name = promptNewTag();
    if (!name) return;
    rec.tags = [...recTags(rec), name];
    delete rec.folder;
    await dbPut(rec).catch(err => console.error('tag save failed', err));
    openTagEditor(rec);
  });
  list.appendChild(add);

  document.getElementById('tag-panel').classList.remove('hidden');
}

function closeTagPanel() {
  saveBookInfo();   // 変更イベントを取りこぼしても閉じる時に必ず保存（rec は関数内で捕まえるので下の null 化と競合しない）
  editingRec = null;
  document.getElementById('tag-panel').classList.add('hidden');
  renderShelf();
}
document.getElementById('btn-tag-close').addEventListener('click', closeTagPanel);
document.getElementById('tag-panel').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeTagPanel();
});

// ===== 並び替え =====
// 並び順は recent（最終閲覧）/ added（追加）/ title（タイトル）/ custom（手動調整済み）。
// ≡ハンドルのドラッグで並べ替えた時点で custom に遷移し、自動の並びは解除される。
let sortMode = localStorage.getItem('noovel_shelf_sort') || 'recent';
const SORT_LABELS = { recent: '最終閲覧順', added: '追加順', title: 'タイトル順' };

function getCustomOrder() {
  try { return JSON.parse(localStorage.getItem('noovel_custom_order') || '[]'); }
  catch (e) { return []; }
}
function saveCustomOrder(list) { localStorage.setItem('noovel_custom_order', JSON.stringify(list)); }
function setSortMode(m) { sortMode = m; localStorage.setItem('noovel_shelf_sort', m); }

function sortBooks(books) {
  const arr = [...books];
  if (sortMode === 'added') {
    arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  } else if (sortMode === 'title') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja', { numeric: true }));
  } else if (sortMode === 'custom') {
    const order = getCustomOrder();
    // 手動並びに無い本（並べたあとに取り込んだ本）は追加順で一番上に置く
    arr.sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      if (ia === -1 && ib === -1) return (b.addedAt || 0) - (a.addedAt || 0);
      if (ia === -1) return -1;
      if (ib === -1) return 1;
      return ia - ib;
    });
  } else {
    arr.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  }
  return arr;
}

function syncSortState() {
  document.querySelectorAll('.sort-item').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === sortMode));
  document.getElementById('sort-state').textContent =
    sortMode === 'custom'
      ? '現在は手動で調整した並びです。選び直すと並べ替えます'
      : `現在は${SORT_LABELS[sortMode]}です。≡をドラッグすると並びが固定されます`;
}

document.getElementById('sort-btn').addEventListener('click', () => {
  syncSortState();
  document.getElementById('sort-panel').classList.remove('hidden');
});
document.getElementById('btn-sort-close').addEventListener('click', () => {
  document.getElementById('sort-panel').classList.add('hidden');
});
document.getElementById('sort-panel').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});
document.querySelectorAll('.sort-item').forEach(b => {
  b.addEventListener('click', () => {
    setSortMode(b.dataset.sort);
    document.getElementById('sort-panel').classList.add('hidden');
    renderShelf(true);
  });
});

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// タグ絞り込み中は「表示中の本同士の相対順」だけ入れ替え、非表示の本の位置は崩さない
async function commitShelfReorder(rendered, from, to, allBooks) {
  const full = sortBooks(allBooks).map(b => b.id);
  const shownIds = rendered.map(b => b.id);
  const newSeq = [...shownIds];
  const [moved] = newSeq.splice(from, 1);
  newSeq.splice(to, 0, moved);
  const shownSet = new Set(shownIds);
  let k = 0;
  saveCustomOrder(full.map(id => (shownSet.has(id) ? newSeq[k++] : id)));
  setSortMode('custom');
}

// ドラッグで並べ替え（≡ハンドルのみ反応。カード本体のタップ・縦スクロールは今まで通り）
function attachDragHandle(handle, card, index, rendered, allBooks) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const cards = [...document.getElementById('shelf-list').children]
      .filter(c => c.classList.contains('book-card'));
    const rects = cards.map(c => c.getBoundingClientRect());
    const from = index;
    const myH = rects[from].height + 12;   // 12 = #shelf-list の gap
    let to = from;
    card.classList.add('dragging');

    const onMove = ev => {
      const dy = ev.clientY - e.clientY;
      card.style.transform = `translateY(${dy}px) scale(1.02)`;
      const centerY = rects[from].top + rects[from].height / 2 + dy;
      to = from;
      for (let i = 0; i < rects.length; i++) {
        if (i === from) continue;
        const mid = rects[i].top + rects[i].height / 2;
        if (i < from && centerY < mid) to = Math.min(to, i);
        if (i > from && centerY > mid) to = Math.max(to, i);
      }
      cards.forEach((c, i) => {
        if (c === card) return;
        c.classList.add('anim');
        if (i > from && i <= to) c.style.transform = `translateY(${-myH}px)`;
        else if (i < from && i >= to) c.style.transform = `translateY(${myH}px)`;
        else c.style.transform = '';
      });
    };

    const onUp = async () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      card.classList.remove('dragging');
      cards.forEach(c => { c.style.transform = ''; c.classList.remove('anim'); });
      if (to !== from) {
        const wasAuto = sortMode !== 'custom';
        await commitShelfReorder(rendered, from, to, allBooks);
        showToast(wasAuto ? '並び順を固定しました（自動の並びは解除）' : '並び順を保存しました');
      }
      renderShelf();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

// ===== スワイプ削除（カードを左にスライドすると削除ボタンが出る。iOSミュージック風） =====
const SWIPE_DEL_W = 76;   // 削除ボタンの幅＝スライド量
let openSwipe = null;     // 開いているカード { card, slider }（同時に開くのは1枚だけ）
let lastSwipeAt = 0;      // スワイプ直後の click 誤発火よけ

function closeSwipe() {
  if (!openSwipe) return;
  openSwipe.slider.classList.add('snap');
  openSwipe.slider.style.transform = '';
  openSwipe = null;
}

// スワイプ直後・開いた状態でのタップは「本を開く」等の操作を止める（開いていたら閉じるだけ）
function swipeGuard() {
  if (Date.now() - lastSwipeAt < 400) return true;
  if (openSwipe) { closeSwipe(); return true; }
  return false;
}

// 開いたままカードの外を触ったら閉じる（その1タップは閉じる動作に使い、本は開かない）
document.addEventListener('pointerdown', e => {
  if (openSwipe && !openSwipe.card.contains(e.target)) {
    closeSwipe();
    lastSwipeAt = Date.now();
  }
});

function attachSwipeDelete(card, slider) {
  let startX = 0, startY = 0, base = 0, pid = null, mode = null; // 'pending' → 'swipe'
  slider.addEventListener('pointerdown', e => {
    // ハンドル・ボタン類から始まった操作はスワイプにしない
    if (e.target.closest('.drag-handle, .book-menu, .book-delete')) return;
    startX = e.clientX; startY = e.clientY;
    base = (openSwipe && openSwipe.card === card) ? -SWIPE_DEL_W : 0;
    pid = e.pointerId; mode = 'pending';
  });
  slider.addEventListener('pointermove', e => {
    if (!mode || e.pointerId !== pid) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (mode === 'pending') {
      // 縦優勢なら縦スクロールに譲る（touch-action: pan-y とセット）
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { mode = null; return; }
      if (Math.abs(dx) < 8) return;
      mode = 'swipe';
      slider.setPointerCapture(pid);
      slider.classList.remove('snap');
      if (openSwipe && openSwipe.card !== card) closeSwipe();
    }
    const x = Math.max(-SWIPE_DEL_W, Math.min(0, base + dx));
    slider.style.transform = x ? `translateX(${x}px)` : '';
  });
  const finish = e => {
    if (e.pointerId !== pid) return;
    if (mode === 'swipe') {
      const open = base + (e.clientX - startX) < -SWIPE_DEL_W / 2;
      slider.classList.add('snap');
      slider.style.transform = open ? `translateX(${-SWIPE_DEL_W}px)` : '';
      openSwipe = open ? { card, slider } : null;
      lastSwipeAt = Date.now();
    }
    mode = null; pid = null;
  };
  slider.addEventListener('pointerup', finish);
  slider.addEventListener('pointercancel', finish);
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

async function renderShelf(animate) {
  const list = document.getElementById('shelf-list');
  const emptyMsg = document.getElementById('shelf-empty');
  let books = [];
  try {
    books = await dbGetAll();
  } catch (err) {
    console.error('library load failed', err);
  }
  books = sortBooks(books);

  renderTagChips();
  const shown = currentTag ? books.filter(b => recTags(b).includes(currentTag)) : books;

  // 並び替え切替をFLIPで滑らかに（切替前の位置を覚えておく）
  const firstTop = {};
  if (animate) {
    [...list.children].forEach(el => {
      if (el.dataset && el.dataset.id) firstTop[el.dataset.id] = el.getBoundingClientRect().top;
    });
  }

  list.innerHTML = '';
  openSwipe = null;   // カードを作り直すので開いていたスワイプの参照を捨てる
  emptyMsg.classList.toggle('hidden', shown.length > 0);
  if (emptyMsg.children[1]) {
    emptyMsg.children[1].innerHTML = books.length
      ? 'このタグの本はありません'
      : '「開く」からテキストファイルを<br>読み込んでください';
  }

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

  const rendered = shown.slice(0, shelfLimit);
  rendered.forEach((rec, idx) => {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.dataset.id = rec.id;

    // スライド面。左スワイプで translateX して、右外に隠した削除ボタンが現れる
    const slider = document.createElement('div');
    slider.className = 'book-slide';

    const handle = document.createElement('button');
    handle.className = 'drag-handle';
    handle.textContent = '≡';
    handle.setAttribute('aria-label', 'ドラッグで並べ替え');
    attachDragHandle(handle, card, idx, rendered, books);

    const main = document.createElement('button');
    main.className = 'book-main';

    const title = document.createElement('div');
    title.className = 'book-title';
    title.textContent = rec.title;

    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const pct = Math.round(bookProgress(rec) * 100);
    meta.textContent = `${pct}%読了`;

    const bar = document.createElement('div');
    bar.className = 'book-progress';
    const fill = document.createElement('div');
    fill.className = 'book-progress-fill';
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    // タグ行＝読了%の下（タグが無い本は行ごと出さない）
    const tags = recTags(rec);
    if (tags.length) {
      const tagsRow = document.createElement('div');
      tagsRow.className = 'book-tags';
      tags.forEach(tg => {
        const chip = document.createElement('span');
        chip.className = 'book-tag';
        chip.textContent = tg;
        tagsRow.appendChild(chip);
      });
      main.append(title, meta, tagsRow, bar);
    } else {
      main.append(title, meta, bar);
    }
    main.addEventListener('click', () => { if (swipeGuard()) return; openRecord(rec); });

    const menu = document.createElement('button');
    menu.className = 'book-menu';
    menu.textContent = '⋯';
    menu.setAttribute('aria-label', '本を編集');
    menu.addEventListener('click', e => {
      e.stopPropagation();
      if (swipeGuard()) return;
      openTagEditor(rec);
    });

    const del = document.createElement('button');
    del.className = 'book-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', '削除');
    del.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`「${rec.title}」を本棚から削除しますか？`)) return;
      await dbDelete(rec.id).catch(err => console.error('delete failed', err));
      localStorage.removeItem('bm_' + rec.id);
      if (localStorage.getItem('noovel_last') === rec.id) localStorage.removeItem('noovel_last');
      renderShelf();
    });

    slider.append(handle, main, menu, del);
    card.appendChild(slider);
    attachSwipeDelete(card, slider);
    list.appendChild(card);
  });

  // 30冊ずつの追加表示
  if (shown.length > shelfLimit) {
    const more = document.createElement('button');
    more.id = 'btn-more-books';
    more.textContent = `もっと見る（残り${shown.length - shelfLimit}冊）`;
    more.addEventListener('click', () => { shelfLimit += SHELF_PAGE; renderShelf(); });
    list.appendChild(more);
  }

  if (animate) {
    [...list.children].forEach(el => {
      const prev = el.dataset ? firstTop[el.dataset.id] : undefined;
      if (prev === undefined) return;
      const dy = prev - el.getBoundingClientRect().top;
      if (!dy) return;
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.classList.add('anim');
        el.style.transform = '';
        el.addEventListener('transitionend', () => el.classList.remove('anim'), { once: true });
      });
    });
  }
}

function showShelf() {
  saveBookmark();
  hidePressMenu();
  book = null;
  currentFile = null;
  currentRecord = null;
  applyStyle();  // 本棚は常に横書きに戻す
  document.body.classList.remove('reading', 'ui-hidden');
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

// ===== 全画面読書：画面タップでヘッダー・章ナビを出し入れ =====
// 進捗バーを「ヘッダーの真下」に固定するため、ヘッダーの実高を CSS 変数に流す
function updateHeaderHeight() {
  document.documentElement.style.setProperty('--header-h',
    document.getElementById('header').offsetHeight + 'px');
}
window.addEventListener('resize', updateHeaderHeight);

// 「タップ」＝指がほぼ動かず・短時間で・スクロールも起きずに離れたときだけ。
// スクロール／長押し（マーカー）／長押しメニュー表示中のタップ（＝閉じる操作）ではトグルしない。
(() => {
  const wrap = document.getElementById('reader-wrap');
  let pid = null, t0 = 0, x0 = 0, y0 = 0, sT = 0, sL = 0;
  wrap.addEventListener('pointerdown', e => {
    pid = e.pointerId; t0 = Date.now();
    x0 = e.clientX; y0 = e.clientY;
    sT = wrap.scrollTop; sL = wrap.scrollLeft;
  });
  wrap.addEventListener('pointerup', e => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (!document.body.classList.contains('reading')) return;
    if (Date.now() - t0 > 350) return;                              // 長押しはマーカー操作
    if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) return;    // 指が動いた＝スクロール
    if (wrap.scrollTop !== sT || wrap.scrollLeft !== sL) return;    // 慣性スクロールの停止タップ
    if (e.target.closest('#press-menu')) return;                    // メニュー操作
    if (pressBlockEl) return;                                       // メニュー表示中＝このタップは閉じる係
    document.body.classList.toggle('ui-hidden');
  });
})();

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
  if (/\.webarchive$/i.test(file.name)) {
    importWebarchive(file);
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
// ===== シークバー（本全体の読書位置） =====
// 物差しは (章番号 + 章内スクロール割合) ÷ 章数。上の進捗バーやカードの読了%と同じ換算。
// ドラッグ中はプレビュー（飛び先の章タイトル＋全体%）だけ出して、指を離した瞬間にジャンプする。
let seeking = false;   // ドラッグ中はスクロール由来の値の巻き戻しを止める

function updateSeekBar() {
  if (!book || seeking) return;
  const v = (currentChapter + getScrollRatio()) / book.chapters.length;
  const seek = document.getElementById('seek-bar');
  seek.value = Math.round(v * 1000);
  document.getElementById('seek-pct').textContent = Math.round(v * 100) + '%';
  seek.style.setProperty('--fill', (v * 100) + '%');
}

// スライダー値 → 飛び先（章番号と章内割合）
function seekTarget() {
  const v = document.getElementById('seek-bar').value / 1000;
  const n = book.chapters.length;
  const ch = Math.max(0, Math.min(n - 1, Math.floor(v * n)));
  return { ch, ratio: Math.max(0, Math.min(1, v * n - ch)), v };
}

(() => {
  const seek = document.getElementById('seek-bar');
  const preview = document.getElementById('seek-preview');
  seek.addEventListener('input', () => {
    if (!book) return;
    seeking = true;
    const t = seekTarget();
    document.getElementById('seek-preview-ch').textContent =
      book.chapters[t.ch].title || `${t.ch + 1} / ${book.chapters.length}`;
    document.getElementById('seek-preview-pct').textContent = '全体 ' + Math.round(t.v * 100) + '%';
    document.getElementById('seek-pct').textContent = Math.round(t.v * 100) + '%';
    seek.style.setProperty('--fill', (t.v * 100) + '%');
    preview.classList.remove('hidden');
  });
  const commit = () => {
    if (!seeking || !book) return;
    seeking = false;
    preview.classList.add('hidden');
    const t = seekTarget();
    if (t.ch === currentChapter) setScrollRatio(t.ratio);
    else renderChapter(t.ch, { ratio: t.ratio });
    saveBookmark();
  };
  seek.addEventListener('change', commit);    // 通常のドラッグ終了・トラックのタップ
  seek.addEventListener('pointerup', commit); // iOSで change が落ちるケースの保険
})();

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
// テーマボタンは THEMES から生成し、ボタン自体をそのテーマの配色で見せる
function renderThemeButtons() {
  const wrap = document.querySelector('.themes');
  wrap.innerHTML = '';
  for (const key of Object.keys(THEMES)) {
    const t = THEMES[key];
    const btn = document.createElement('button');
    btn.className = 'theme-btn';
    btn.dataset.theme = key;
    btn.textContent = t.label;
    btn.style.background = t.bg;
    if (t.bgImage) btn.style.backgroundImage = t.bgImage;
    btn.style.color = t.text;
    btn.addEventListener('click', () => {
      cfg.theme = key;
      cfg.bgColor = t.bg;
      cfg.textColor = t.text;
      applyStyle(); saveCfg();
    });
    wrap.appendChild(btn);
  }
}
renderThemeButtons();

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
  // グラデーション背景とテーマ装飾（SFのHUDブラケットなど）はテーマ名で切り替える
  const th = THEMES[cfg.theme];
  document.body.dataset.theme = cfg.theme;
  r.style.setProperty('--bg-image', th && th.bgImage ? th.bgImage : 'none');
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
    tags: getTags(),
    sort: { mode: sortMode, order: getCustomOrder() },
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
  // タグ一覧をマージ（旧バックアップの folders もタグとして受ける）
  const importedTags = [
    ...(Array.isArray(data.tags) ? data.tags : []),
    ...(Array.isArray(data.folders) ? data.folders : []),
  ].filter(t => typeof t === 'string' && t);
  if (importedTags.length) saveTags([...new Set([...getTags(), ...importedTags])]);
  if (data.sort && typeof data.sort === 'object') {
    if (typeof data.sort.mode === 'string' && (data.sort.mode in SORT_LABELS || data.sort.mode === 'custom')) {
      setSortMode(data.sort.mode);
    }
    if (Array.isArray(data.sort.order)) {
      saveCustomOrder(data.sort.order.filter(x => typeof x === 'string'));
    }
  }
  if (data.cfg) { cfg = { ...DEFAULTS, ...data.cfg }; saveCfg(); applyStyle(); }

  // 旧バックアップの本（folder持ち）をtagsへ変換
  await migrateFoldersToTags();

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

// ストレージの永続化を要求（iOS等が容量逼迫時に本棚のデータを自動削除するのを防ぐ）
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

// バージョン表示（js/version.js が単一正本）
document.getElementById('app-version').textContent = 'Noovel v' + NOOVEL_VERSION;
document.getElementById('shelf-version').textContent = 'v' + NOOVEL_VERSION;

applyStyle();
migrateFoldersToTags().then(renderShelf);
