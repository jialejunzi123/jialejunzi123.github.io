/* 日记查看器 · 纯静态、无构建、无依赖（marked 本地内置）
 *
 * 读取顺序（契约 §三）：data/diaries.enc.json 优先 → 密码页 → WebCrypto 解密；
 * 解密页面里的图片同理（media/*.enc：iv(12B) || AES-256-GCM 密文）；两者都没有 → 空态。
 * 明文回退：data/diaries.json 存在就直接渲染（本机调试 / 以后不用密码的场合）。
 * 调试开关：?mode=plain 强制走明文，?mode=enc 只走密文。
 */
(function(){
'use strict';

var DATA_URL = 'data/diaries.json';
var ENC_URL  = 'data/diaries.enc.json';
var WEEKDAYS = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];

var MODE = (function(){
  var m = /[?&]mode=(plain|enc)(&|$)/.exec(location.search);
  return m ? m[1] : '';
})();

var ICON = {
  mood: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M5.6 9.5c.7.8 1.5 1.2 2.4 1.2s1.7-.4 2.4-1.2" stroke-linecap="round"/><path d="M6 6.3h.01M10 6.3h.01" stroke-linecap="round"/></svg>',
  weather: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"/></svg>',
  place: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 14.2s4.5-4.3 4.5-7A4.5 4.5 0 0 0 3.5 7.2c0 2.7 4.5 7 4.5 7Z"/><circle cx="8" cy="7.2" r="1.6"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 9.6l2.8-2.6 2.4 2.3 1.9-1.7 3.9 3.4" stroke-linecap="round"/><path d="M9.8 6.2l1.6-1.6" stroke-linecap="round"/></svg>',
  lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7"/></svg>'
};

var S = {
  meta: null,
  entries: [],
  byId: Object.create(null),
  filtered: [],
  key: null,
  encMode: false,
  q: '', tag: '', year: '', month: ''
};
var ready = false;

var imgCache = Object.create(null);     // 图片 URL → objectURL（同一 URL 只解密一次）
var imgInflight = Object.create(null);

var viewEl, statEl, toolbarEl, qEl, resetEl, yearSel, monthSel, tagsEl, footNoteEl,
    lightboxEl, lbImgEl, lbCapEl, randomLink;

function $(id){ return document.getElementById(id); }

/* ---------- 工具 ---------- */

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function decodeEntities(s){
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function basename(p){
  return String(p || '').split(/[\\/]/).pop().split('?')[0];
}

// 占位块里不显示 64 位 sha256 全名（375px 下会折行），也不显示 .enc 后缀
function displayFile(p){
  var base = basename(p).replace(/\.enc$/i, '');
  if (base.length > 22) base = base.slice(0, 8) + '…' + base.slice(-8);
  return 'media/' + base;
}

function weekdayOf(dateStr){
  var p = String(dateStr || '').split('-');
  if (p.length !== 3) return '';
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return isNaN(d.getTime()) ? '' : WEEKDAYS[d.getUTCDay()];
}

function slashDate(dateStr){ return String(dateStr || '').replace(/-/g, '/'); }

function plainText(s){
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLine(md){
  var lines = String(md || '').split('\n');
  for (var i = 0; i < lines.length; i++){
    var t = plainText(lines[i]);
    if (t) return t;
  }
  return '';
}

function stamp(iso){ return String(iso || '').replace('T', ' ').slice(0, 16); }

function pill(kind, value, icon){
  if (!value) return '';
  return '<span class="pill">' + icon + esc(kind + ' ' + value) + '</span>';
}

function stateBlock(big, small){
  return '<div class="state"><div class="big">' + esc(big) + '</div>'
    + (small ? '<div class="small">' + small + '</div>' : '') + '</div>';
}

function fileBlockHtml(msg, file){
  return '<div class="missing-media">' + ICON.file
    + '<div>' + esc(msg) + ' · <span class="f">' + esc(displayFile(file)) + '</span></div></div>';
}

function fileBlockNode(msg, file){
  var box = document.createElement('div');
  box.innerHTML = fileBlockHtml(msg, file);
  return box.firstChild;
}

/* ---------- 数据加载 ---------- */

function fetchJson(url){
  return fetch(url, {cache:'no-cache'}).then(function(r){
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.json();
  });
}

function loadData(){
  var wantEnc = MODE !== 'plain';
  var wantPlain = MODE !== 'enc';

  var encTry = wantEnc
    ? fetchJson(ENC_URL).then(function(enc){
        if (!enc || !enc.ciphertext || !enc.salt || !enc.iv){
          throw new Error('加密数据格式不对：' + ENC_URL);
        }
        return enc;
      })
    : Promise.reject(new Error('skip enc'));

  encTry.then(function(enc){
    showGate(enc);
  }).catch(function(){
    if (!wantPlain){ showEmpty(); return; }
    fetchJson(DATA_URL).then(function(d){
      if (!d || !d.entries) throw new Error('schema mismatch');
      readyWith(d);
    }).catch(showEmpty);
  });
}

function readyWith(d){
  S.meta = d;
  S.entries = (d.entries || []).slice().sort(function(a, b){
    return String(b.createTime || '').localeCompare(String(a.createTime || ''));
  });
  S.byId = Object.create(null);
  S.entries.forEach(function(e){ S.byId[e.id] = e; });

  buildFilters();

  var note = [];
  if (d.source) note.push(d.source);
  if (d.generatedAt) note.push('数据 ' + stamp(d.generatedAt));
  if (S.encMode) note.push('文本与图片均为密文');
  footNoteEl.textContent = note.join(' · ');

  ready = true;
  viewEl.className = 'view';
  toolbarEl.hidden = false;
  route();
}

function showEmpty(){
  ready = false;
  toolbarEl.hidden = true;
  statEl.textContent = '// 暂无数据';
  viewEl.className = 'view';
  viewEl.innerHTML = stateBlock('暂无日记',
    '还没找到 <code>diary/data/diaries.enc.json</code> 或 <code>diary/data/diaries.json</code>。<br>'
    + '把 SwashbucklerDiary 的 WebDAV 备份同步一次，这里就会出现内容。');
}

/* ---------- 解密（文本 + 图片共用一次密码派生的密钥） ---------- */

function b64ToBytes(s){
  var bin = atob(String(s || ''));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function deriveKey(password, enc){
  var subtle = window.crypto && window.crypto.subtle;
  if (!subtle) return Promise.reject(new Error('当前环境没有 WebCrypto'));
  return subtle.importKey('raw', new TextEncoder().encode(password), {name:'PBKDF2'}, false, ['deriveKey'])
    .then(function(km){
      return subtle.deriveKey(
        {name:'PBKDF2', salt:b64ToBytes(enc.salt), iterations:enc.iterations || 200000, hash:'SHA-256'},
        km, {name:'AES-GCM', length:256}, false, ['decrypt']);
    });
}

function decryptJsonWith(key, enc){
  return window.crypto.subtle
    .decrypt({name:'AES-GCM', iv:b64ToBytes(enc.iv)}, key, b64ToBytes(enc.ciphertext))
    .then(function(buf){ return JSON.parse(new TextDecoder().decode(buf)); });
}

function decryptBytes(key, bytes){
  if (!bytes || bytes.byteLength < 29) return Promise.reject(new Error('密文太短'));
  return window.crypto.subtle.decrypt(
    {name:'AES-GCM', iv:bytes.subarray(0, 12)}, key, bytes.subarray(12));
}

function decryptedImageUrl(url){
  if (imgCache[url]) return Promise.resolve(imgCache[url]);
  if (imgInflight[url]) return imgInflight[url];
  if (!S.key) return Promise.reject(new Error('没有密钥'));
  // no-cache：每次向服务器校验（304 走缓存），避免同步后拿到上一版密文（iv/salt 变了就解不开）
  var p = fetch(url, {cache:'no-cache'})
    .then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then(function(buf){ return decryptBytes(S.key, new Uint8Array(buf)); })
    .then(function(plain){ return URL.createObjectURL(new Blob([plain])); })
    .then(function(objUrl){
      imgCache[url] = objUrl;
      return objUrl;
    })
    .catch(function(err){
      delete imgInflight[url];
      throw err;
    });
  imgInflight[url] = p;
  return p;
}

function showGate(enc){
  ready = false;
  toolbarEl.hidden = true;
  statEl.textContent = '// 已加密';
  var hint = enc && enc.hint ? enc.hint : {};
  viewEl.className = 'view gated';
  viewEl.innerHTML =
    '<form class="gate" id="gate-form" autocomplete="off">'
    + '<h2>' + ICON.lock + ' 日记已加密</h2>'
    + '<p class="hint">输入密码后查看'
    + (hint.count != null ? '（共 ' + esc(hint.count) + ' 篇' : '')
    + (hint.count != null ? '，含图片）' : '') + '。<br>'
    + '密码只在本机浏览器里派生密钥（PBKDF2-SHA256）、本机解密，不会发往任何服务器。</p>'
    + '<input id="gate-pw" type="password" placeholder="密码" autocomplete="current-password" aria-label="密码">'
    + '<button class="btn" id="gate-btn" type="submit">解锁</button>'
    + '<div class="err" id="gate-err" role="status"></div>'
    + '</form>';

  var form = $('gate-form'), pw = $('gate-pw'), btn = $('gate-btn'), err = $('gate-err');
  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var val = pw.value;
    if (!val){ err.textContent = '请输入密码'; pw.focus(); return; }
    if (!(window.crypto && window.crypto.subtle)){
      err.textContent = '当前环境没有 WebCrypto，请用 https 或 localhost 打开。';
      return;
    }
    btn.disabled = true;
    btn.textContent = '正在解密…';
    err.textContent = '';
    var derived;
    deriveKey(val, enc).then(function(key){
      derived = key;
      return decryptJsonWith(key, enc);
    }).then(function(data){
      if (!data || !data.entries) throw new Error('解密结果不是日记数据');
      S.key = derived;
      S.encMode = true;
      viewEl.className = 'view';
      readyWith(data);
    }).catch(function(e){
      S.key = null;
      btn.disabled = false;
      btn.textContent = '解锁';
      err.textContent = (e && e.name === 'OperationError')
        ? '密码不对。'
        : '解密失败：' + ((e && e.message) || e);
      pw.select();
    });
  });
  pw.focus();
}

/* ---------- 筛选栏 ---------- */

function buildFilters(){
  var years = [], months = {}, counts = {}, declared = S.meta.tags || {};

  S.entries.forEach(function(e){
    if (e.year && years.indexOf(String(e.year)) < 0) years.push(String(e.year));
    var mm = String(e.month || '').slice(5, 7);
    if (mm) months[mm] = (months[mm] || 0) + 1;
    (e.tags || []).forEach(function(t){ counts[t] = (counts[t] || 0) + 1; });
  });
  if (!Object.keys(counts).length) counts = declared;

  years.sort(function(a, b){ return b.localeCompare(a); });
  yearSel.innerHTML = '<option value="">全部</option>'
    + years.map(function(y){ return '<option value="' + esc(y) + '">' + esc(y) + '</option>'; }).join('');

  var mkeys = Object.keys(months).sort();
  monthSel.innerHTML = '<option value="">全部</option>'
    + mkeys.map(function(m){ return '<option value="' + esc(m) + '">' + Number(m) + ' 月</option>'; }).join('');

  var names = Object.keys(counts).sort(function(a, b){ return counts[b] - counts[a]; });
  tagsEl.innerHTML = names.map(function(t){
    return '<button class="chip" type="button" data-tag="' + esc(t) + '" aria-pressed="false">'
      + esc(t) + '<span class="n">' + counts[t] + '</span></button>';
  }).join('');
}

function syncFilters(){
  yearSel.value = S.year;
  monthSel.value = S.month;
  var chips = tagsEl.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++){
    chips[i].setAttribute('aria-pressed', chips[i].getAttribute('data-tag') === S.tag ? 'true' : 'false');
  }
  resetEl.hidden = !(S.q.trim() || S.tag || S.year || S.month);
}

function resetFilters(){
  S.q = ''; S.tag = ''; S.year = ''; S.month = '';
  qEl.value = '';
  syncFilters();
}

function applyFilters(){
  var q = S.q.trim().toLowerCase();
  S.filtered = S.entries.filter(function(e){
    if (S.tag && (e.tags || []).indexOf(S.tag) < 0) return false;
    if (S.year && String(e.year) !== S.year) return false;
    if (S.month && String(e.month || '').slice(5, 7) !== S.month) return false;
    if (q){
      var hay = (e.title || '') + ' ' + (e.markdown || '') + ' ' + (e.tags || []).join(' ')
        + ' ' + (e.mood || '') + ' ' + (e.weather || '') + ' ' + (e.location || '');
      if (hay.toLowerCase().indexOf(q) < 0) return false;
    }
    return true;
  });
}

function updateStat(){
  var total = S.entries.length;
  if (!total){ statEl.textContent = '// 暂无数据'; return; }
  var parts = ['共 ' + total + ' 篇'];
  var newest = S.entries[0], oldest = S.entries[total - 1];
  if (newest && oldest && newest.date && oldest.date){
    parts.push(slashDate(oldest.date) + ' — ' + slashDate(newest.date));
  }
  var tagCount = Object.keys(S.meta.tags || {}).length;
  if (tagCount) parts.push(tagCount + ' 个标签');
  if (S.filtered.length !== total) parts.push('筛出 ' + S.filtered.length + ' 篇');
  statEl.textContent = parts.join(' · ');
}

/* ---------- 列表 ---------- */

function cardHtml(e){
  // title 为空时退到正文首行；正文只有图片的条目退到「（只有图片）」
  var title = e.title || firstLine(e.markdown);
  if (!title && (e.media || []).length) title = '（只有图片）';
  var excerpt = e.excerpt || plainText(e.markdown).slice(0, 120);
  var meta = [];

  if (e.top) meta.push('<span class="pin">置顶</span>');
  (e.tags || []).slice(0, 4).forEach(function(t){
    meta.push('<span class="tag">' + esc(t) + '</span>');
  });
  meta.push(pill('心情', e.mood, ICON.mood));
  meta.push(pill('天气', e.weather, ICON.weather));
  meta.push(pill('位置', e.location, ICON.place));
  if (e.words) meta.push('<span>' + e.words + ' 字</span>');

  return '<a class="d-card' + (e.top ? ' is-top' : '') + '" href="#/d/' + encodeURIComponent(e.id) + '">'
    + '<div class="row1">'
    + (title ? '<div class="title">' + esc(title) + '</div>'
             : '<div class="title plain">（无标题）</div>')
    + '<span class="time">' + esc(e.time || '') + '</span>'
    + '</div>'
    + (excerpt ? '<div class="excerpt">' + esc(excerpt) + '</div>' : '')
    + '<div class="meta">' + meta.filter(Boolean).join('') + '</div>'
    + '</a>';
}

function renderList(){
  applyFilters();
  updateStat();

  if (!S.entries.length){
    viewEl.innerHTML = stateBlock('暂无日记', '这份数据里没有任何一篇日记。');
    return;
  }
  if (!S.filtered.length){
    viewEl.innerHTML = stateBlock('没有匹配的日记', '换个关键词，或者点搜索框右边的「重置」清空筛选。');
    return;
  }

  var groups = [], last = null;
  S.filtered.forEach(function(e){
    var d = e.date || '';
    if (!last || last.date !== d){ last = {date: d, items: []}; groups.push(last); }
    last.items.push(e);
  });

  viewEl.innerHTML = groups.map(function(g){
    return '<div class="day-group">'
      + '<div class="day-head">'
      + '<span>' + esc(slashDate(g.date)) + '</span>'
      + '<span class="wd">' + esc(weekdayOf(g.date)) + '</span>'
      + (g.items.length > 1 ? '<span class="n">' + g.items.length + ' 篇</span>' : '')
      + '<span class="line"></span>'
      + '</div>'
      + '<div class="dlist">' + g.items.map(cardHtml).join('') + '</div>'
      + '</div>';
  }).join('');
}

/* ---------- 详情 ---------- */

// 图片：exists=false → 占位；密文（media[].encrypted=true 或 *.enc）→ 去掉 src
// （绝不让浏览器直接请求密文），解密后换 objectURL
function preprocessImages(html, entry){
  var byName = Object.create(null);
  (entry.media || []).forEach(function(m){
    if (m) byName[basename(m.file || m.uri)] = m;
  });

  return html.replace(/<img\b[^>]*>/g, function(tag){
    var srcM = /src="([^"]*)"/.exec(tag) || /src='([^']*)'/.exec(tag);
    if (!srcM) return tag;
    var raw = decodeEntities(srcM[1]);
    var rec = byName[basename(raw)];
    if (rec && rec.exists === false){
      return fileBlockHtml('图片未同步', rec.file || rec.uri || raw);
    }
    if ((rec && rec.encrypted === true) || /\.enc(\?|#|$)/i.test(raw)){
      var altM = /alt="([^"]*)"/.exec(tag);
      return '<img class="enc-img" data-enc="' + esc(raw) + '" alt="'
        + esc(altM ? decodeEntities(altM[1]) : '') + '">';
    }
    return tag;
  });
}

function renderDetail(id){
  var e = S.byId[id];
  if (!e){
    viewEl.innerHTML = '<a class="detail-back" href="#/">← 返回列表</a>'
      + stateBlock('没有找到这篇日记', '它可能已被删除，或者不在这次备份里。');
    return;
  }

  var idx = S.entries.indexOf(e);
  var newer = idx > 0 ? S.entries[idx - 1] : null;
  var older = idx >= 0 && idx < S.entries.length - 1 ? S.entries[idx + 1] : null;

  var title = e.title || firstLine(e.markdown);
  var meta = [];
  meta.push('<span>' + esc(e.time || '') + '</span>');
  (e.tags || []).forEach(function(t){ meta.push('<span class="tag">' + esc(t) + '</span>'); });
  meta.push(pill('心情', e.mood, ICON.mood));
  meta.push(pill('天气', e.weather, ICON.weather));
  meta.push(pill('位置', e.location, ICON.place));
  if (e.words) meta.push('<span>' + e.words + ' 字</span>');
  if (e.updateTime && e.updateTime.slice(0, 10) !== (e.createTime || '').slice(0, 10)){
    meta.push('<span>更新于 ' + esc(e.updateTime) + '</span>');
  }

  var body = marked.parse(String(e.markdown || ''), {gfm: true, breaks: true});
  viewEl.innerHTML = ''
    + '<a class="detail-back" href="#/">← 返回列表</a>'
    + '<article class="detail">'
    + '<div class="detail-head">'
    + '<div class="detail-date">' + esc(slashDate(e.date))
    + '<span class="wd">' + esc(weekdayOf(e.date)) + '</span></div>'
    + (title ? '<h1 class="detail-title">' + esc(title) + '</h1>' : '')
    + '<div class="detail-meta">' + meta.filter(Boolean).join('') + '</div>'
    + '</div>'
    + '<div class="md">' + preprocessImages(body, e) + '</div>'
    + '</article>'
    + '<div class="detail-nav">'
    + (older ? '<a href="#/d/' + encodeURIComponent(older.id) + '">← '
        + esc(older.date + ' ' + (older.title || firstLine(older.markdown) || '')) + '</a>'
             : '<span class="sp"></span>')
    + (newer ? '<a href="#/d/' + encodeURIComponent(newer.id) + '">'
        + esc(newer.date + ' ' + (newer.title || firstLine(newer.markdown) || '')) + ' →</a>'
             : '<span class="sp"></span>')
    + '</div>';

  hydrateImages();
}

/* ---------- 图片 / 灯箱 ---------- */

function hydrateImages(){
  var imgs = viewEl.querySelectorAll('.md img');
  for (var i = 0; i < imgs.length; i++){
    var img = imgs[i];
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');

    if (img.hasAttribute('data-enc')){
      decryptInto(img);
      continue;
    }
    img.addEventListener('error', function(){
      this.replaceWith(fileBlockNode('图片未同步', basename(this.getAttribute('src') || '')));
    });
  }
}

function decryptInto(img){
  var url = img.getAttribute('data-enc');
  var alt = img.getAttribute('alt') || '';
  decryptedImageUrl(url).then(function(objUrl){
    if (!img.isConnected) return;
    img.removeAttribute('data-enc');
    img.src = objUrl;
    img.alt = alt;
    img.classList.add('ready');
  }).catch(function(){
    if (!img.isConnected) return;
    img.replaceWith(fileBlockNode('图片解密失败', url + '（密码错误或图片损坏）'));
  });
}

function openLightbox(src, cap){
  lbImgEl.src = src;
  lbImgEl.alt = cap || '';
  lbCapEl.textContent = cap || '';
  lightboxEl.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox(){
  if (lightboxEl.hidden) return;
  lightboxEl.hidden = true;
  lbImgEl.removeAttribute('src');
  lbCapEl.textContent = '';
  document.body.style.overflow = '';
}

/* ---------- 路由 ---------- */

function currentId(){
  var m = /^#\/d\/(.+)$/.exec(location.hash || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (err) { return m[1]; }
}

function route(){
  if (!ready) return;
  var id = currentId();
  if (id) renderDetail(id); else renderList();
  window.scrollTo(0, 0);
}

/* ---------- 事件 ---------- */

function backToRouteOrRender(){
  if (currentId()) location.hash = '#/';
  else renderList();
}

function bindEvents(){
  qEl.addEventListener('input', function(){
    S.q = qEl.value;
    syncFilters();
    backToRouteOrRender();
  });

  resetEl.addEventListener('click', function(){
    resetFilters();
    backToRouteOrRender();
  });

  yearSel.addEventListener('change', function(){
    S.year = yearSel.value;
    syncFilters();
    backToRouteOrRender();
  });

  monthSel.addEventListener('change', function(){
    S.month = monthSel.value;
    syncFilters();
    backToRouteOrRender();
  });

  tagsEl.addEventListener('click', function(ev){
    var btn = ev.target.closest ? ev.target.closest('.chip') : null;
    if (!btn) return;
    var tag = btn.getAttribute('data-tag');
    S.tag = (S.tag === tag) ? '' : tag;
    syncFilters();
    backToRouteOrRender();
  });

  randomLink.addEventListener('click', function(ev){
    ev.preventDefault();
    var pool = S.filtered.length ? S.filtered : S.entries;
    if (!pool.length) return;
    var pick = pool[Math.floor(Math.random() * pool.length)];
    location.hash = '#/d/' + encodeURIComponent(pick.id);
  });

  viewEl.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || t.tagName !== 'IMG' || !t.getAttribute('src')) return;
    if (!t.closest || !t.closest('.md')) return;
    openLightbox(t.getAttribute('src'), t.getAttribute('alt'));
  });

  lightboxEl.addEventListener('click', closeLightbox);

  document.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape'){
      if (!lightboxEl.hidden){ closeLightbox(); return; }
      if (currentId()) location.hash = '#/';
    }
  });

  window.addEventListener('hashchange', route);
}

/* ---------- boot ---------- */

function init(){
  viewEl = $('view');
  statEl = $('stat');
  toolbarEl = $('toolbar');
  qEl = $('q');
  resetEl = $('reset');
  yearSel = $('f-year');
  monthSel = $('f-month');
  tagsEl = $('f-tags');
  footNoteEl = $('foot-note');
  lightboxEl = $('lightbox');
  lbImgEl = $('lb-img');
  lbCapEl = $('lb-cap');
  randomLink = $('random-link');

  $('lb-close').addEventListener('click', closeLightbox);
  $('year').textContent = new Date().getFullYear();

  bindEvents();
  loadData();
}

init();

})();
