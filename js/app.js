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

// ===== Chapter parsing =====
function parseChapters(text, filename) {
  const lines = text.split('\n');

  // Explicit heading patterns
  const EXPLICIT = /^(第[一二三四五六七八九十百千\d]+[章話節部編幕序終]|#{1,3}\s+\S|【.+】|[■◆●▲]\s*\S)/;

  let headings = lines.reduce((acc, line, i) => {
    if (EXPLICIT.test(line.trim())) acc.push(i);
    return acc;
  }, []);

  // Fallback: short lines surrounded by blank lines
  if (headings.length < 2) {
    headings = lines.reduce((acc, line, i) => {
      const t = line.trim();
      if (!t || t.length > 40) return acc;
      if (/[。、！？…」』）】]$/.test(t)) return acc;
      const prevBlank = i === 0 || !lines[i - 1].trim();
      const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
      if (prevBlank && nextBlank) acc.push(i);
      return acc;
    }, []);
  }

  const stem = filename.replace(/\.[^.]+$/, '');

  if (headings.length < 2) {
    return { title: stem, chapters: [{ title: stem, content: text.trim() }] };
  }

  const chapters = [];

  // Content before first heading
  const pre = lines.slice(0, headings[0]).join('\n').trim();
  if (pre) chapters.push({ title: 'まえがき', content: pre });

  headings.forEach((hIdx, i) => {
    const nextHIdx = headings[i + 1] ?? lines.length;
    const chTitle = lines[hIdx].trim().replace(/^#+\s*/, '');
    const content = lines.slice(hIdx + 1, nextHIdx).join('\n').trim();
    chapters.push({ title: chTitle, content });
  });

  return { title: stem, chapters };
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
  body.textContent = ch.content;
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

// ===== Load book =====
function loadBook(text, filename) {
  currentFile = filename;
  book = parseChapters(text, filename);

  document.getElementById('empty').classList.add('hidden');
  document.getElementById('chapter-nav').classList.remove('hidden');
  document.getElementById('btn-left').textContent = '目次';
  document.getElementById('btn-left').dataset.mode = 'toc';
  document.getElementById('header-title').textContent = book.title;

  buildToc();

  const bm = getBookmark();
  renderChapter(bm.chapter || 0, bm.ratio || 0);
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
  fr.onload = ev => loadBook(ev.target.result, file.name);
  fr.readAsText(file, 'UTF-8');
  e.target.value = '';
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
function applyStyle() {
  const r = document.documentElement;
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
