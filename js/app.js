'use strict';

// ===== 設定の永続化 =====
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
  serif:      "'Hiragino Mincho ProN','Yu Mincho',serif",
  gothic:     "'Hiragino Sans','Yu Gothic',sans-serif",
  rounded:    "'Hiragino Maru Gothic ProN',sans-serif",
};

let cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('noovel_cfg') || '{}') };
let currentFile = null;

function saveCfg() {
  localStorage.setItem('noovel_cfg', JSON.stringify(cfg));
}

// ===== ブックマーク =====
function bookmarkKey() {
  return currentFile ? 'bm_' + currentFile : null;
}
function saveBookmark() {
  const key = bookmarkKey();
  if (!key) return;
  const wrap = document.getElementById('reader-wrap');
  const ratio = wrap.scrollTop / (wrap.scrollHeight - wrap.clientHeight || 1);
  localStorage.setItem(key, ratio);
}
function restoreBookmark() {
  const key = bookmarkKey();
  if (!key) return;
  const ratio = parseFloat(localStorage.getItem(key) || '0');
  if (!ratio) return;
  setTimeout(() => {
    const wrap = document.getElementById('reader-wrap');
    wrap.scrollTop = ratio * (wrap.scrollHeight - wrap.clientHeight);
  }, 100);
}

// ===== スクロールでブックマーク自動保存 & プログレスバー =====
let scrollTimer;
document.getElementById('reader-wrap').addEventListener('scroll', () => {
  const wrap = document.getElementById('reader-wrap');
  const ratio = wrap.scrollTop / (wrap.scrollHeight - wrap.clientHeight || 1);
  document.getElementById('progress-bar').style.width = (ratio * 100) + '%';
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveBookmark, 500);
});

// ===== スタイル適用 =====
function applyStyle() {
  const r = document.documentElement;
  r.style.setProperty('--bg', cfg.bgColor);
  r.style.setProperty('--text', cfg.textColor);
  r.style.setProperty('--font-size', cfg.fontSize + 'px');
  r.style.setProperty('--line-height', cfg.lineHeight);
  r.style.setProperty('--font-family', FONTS[cfg.font] || FONTS.serif);

  const reader = document.getElementById('reader');
  reader.classList.toggle('vertical', cfg.vertical);

  // 設定UIに反映
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

// ===== ファイル読み込み =====
function loadText(text, name) {
  currentFile = name;
  document.getElementById('reader').textContent = text;
  document.getElementById('empty').classList.add('hidden');
  document.getElementById('header').querySelector('h1').textContent = name || 'Noovel';
  restoreBookmark();
}

document.getElementById('btn-open').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => loadText(ev.target.result, file.name);
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
});

// ===== 設定パネル =====
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

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ===== 初期化 =====
applyStyle();
