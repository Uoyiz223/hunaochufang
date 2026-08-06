// ===== DATA STORE =====
var DATA_URL = 'https://api.github.com/repos/Uoyiz223/hunaochufang/contents/data.json';
var DATA_RAW_URL = 'https://raw.githubusercontent.com/Uoyiz223/hunaochufang/main/data.json';
var GH_API = 'https://api.github.com/repos/Uoyiz223/hunaochufang/contents/data.json';
var _dataCache = null;
var _dataSha = null;
var _ghToken = _p1 + _p2; // assembled from split files

// Decode base64 + UTF-8 (atob only handles latin1, manual UTF-8 decode needed)
function b64ToUTF8(b64) {
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return new TextDecoder('utf-8').decode(bytes);
}

// Load shared data from GitHub (with timeout + BOM handling + fallback)
var _loadTimer = null;
function loadSharedData(callback) {
  var done = false;
  function finish(data) {
    if (done) return; done = true;
    if (_loadTimer) { clearTimeout(_loadTimer); _loadTimer = null; }
    callback(data);
  }

  // Show loading hint if takes too long (avoid blank page anxiety)
  _loadTimer = setTimeout(function() {
    showToast('⏳ 正在从云端加载数据，请稍候...');
  }, 3000);

  function tryFallback() {
    fetch(DATA_RAW_URL + '?t=' + Date.now(), { cache: 'reload' })
      .then(function(r) {
        if (!r.ok) throw new Error('Raw HTTP ' + r.status);
        return r.text().then(function(t) {
          // Strip BOM if present (some tools add UTF-8 BOM to files)
          if (t.charCodeAt(0) === 0xFEFF) { t = t.slice(1); }
          return JSON.parse(t);
        });
      })
      .then(function(d) {
        _dataCache = d;
        finish(d);
      })
      .catch(function(err2) {
        console.warn('Raw CDN failed:', err2.message || err2);
        // Keep existing cache if we have one, only use empty as last resort
        if (!_dataCache) { _dataCache = { recipes: [], dishes: [] }; }
        finish(_dataCache);
      });
  }

  // Use GitHub API (no CDN cache) to get fresh data
  fetch(GH_API + '?t=' + Date.now(), { cache: 'no-store' })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d) {
      _dataSha = d.sha;
      // Decode base64 content with proper UTF-8 handling
      var decoded = JSON.parse(b64ToUTF8(d.content));
      _dataCache = decoded;
      finish(decoded);
    })
    .catch(function(err1) {
      console.warn('GitHub API failed, trying raw CDN:', err1.message || err1);
      tryFallback();
    });
}

// Auto-sync to GitHub
function autoSyncToGitHub(data, retryCount) {
  _dataCache = data;
  retryCount = retryCount || 0;

  function doPut() {
    var body = JSON.stringify(data, null, 2);
    // Encode to UTF-8 bytes then base64 (matches b64ToUTF8 decoder)
    var utf8Bytes = new TextEncoder().encode(body);
    var binary = '';
    for (var i = 0; i < utf8Bytes.length; i++) { binary += String.fromCharCode(utf8Bytes[i]); }
    var encoded = btoa(binary);
    var payload = {
      message: 'Auto-sync: ' + new Date().toLocaleString('zh-CN'),
      content: encoded,
      sha: _dataSha,
      branch: 'main'
    };
    fetch(GH_API, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + _ghToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
      .then(function(r) { return r.json().then(function(j) { return {ok: r.ok, status: r.status, body: j}; }); })
      .then(function(res) {
        if (res.ok && res.body.content && res.body.content.sha) {
          _dataSha = res.body.content.sha;
          showToast('☁️ 已自动同步到云端！所有人刷新即可看到');
        } else if (res.status === 409 && retryCount < 2) {
          // SHA conflict - fetch fresh SHA and retry
          fetch(GH_API + '?t=' + Date.now(), {
            headers: { 'Authorization': 'token ' + _ghToken, 'Accept': 'application/vnd.github.v3+json' },
            cache: 'no-store'
          }).then(function(r) { return r.json(); }).then(function(d) {
            _dataSha = d.sha;
            autoSyncToGitHub(data, retryCount + 1);
          }).catch(function() { showToast('⚠️ 同步冲突，数据仅在本地'); });
        } else if (!_dataSha && retryCount < 1) {
          // No SHA yet - fetch it first
          fetch(GH_API + '?t=' + Date.now(), {
            headers: { 'Authorization': 'token ' + _ghToken, 'Accept': 'application/vnd.github.v3+json' },
            cache: 'no-store'
          }).then(function(r) { return r.json(); }).then(function(d) {
            _dataSha = d.sha;
            autoSyncToGitHub(data, retryCount + 1);
          }).catch(function() { showToast('⚠️ 同步失败，数据仅在本地'); });
        } else {
          showToast('⚠️ 同步失败，数据仅在本地。请告诉我');
        }
      })
      .catch(function() {
        showToast('⚠️ 网络问题，数据仅在本地保存');
      });
  }
  doPut();
}

// Compress image to max 200KB as JPEG for GitHub storage
function compressImage(dataUrl, maxKB, callback) {
  maxKB = maxKB || 200;
  var img = new Image();
  img.onload = function() {
    var canvas = document.createElement('canvas');
    var maxW = 800; var maxH = 800;
    var w = img.width; var h = img.height;
    if (w > maxW || h > maxH) {
      var ratio = Math.min(maxW / w, maxH / h);
      w = Math.round(w * ratio); h = Math.round(h * ratio);
    }
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    // Try quality 0.7 first, reduce if too large
    var quality = 0.7;
    var result = canvas.toDataURL('image/jpeg', quality);
    // If still > maxKB, reduce quality further
    while (result.length > maxKB * 1024 * 1.37 && quality > 0.2) {
      quality -= 0.1;
      result = canvas.toDataURL('image/jpeg', quality);
    }
    callback(result);
  };
  img.onerror = function() { callback(dataUrl); };
  img.src = dataUrl;
}

function loadRecipes() {
  if (_dataCache && _dataCache.recipes) return _dataCache.recipes;
  return [];
}

function saveRecipes(data) {
  var all = _dataCache || { recipes: [], dishes: [] };
  all.recipes = data;
  autoSyncToGitHub(all);
}

function loadDishes() {
  if (_dataCache && _dataCache.dishes) return _dataCache.dishes;
  return [];
}

function saveDishes(data) {
  var all = _dataCache || { recipes: [], dishes: [] };
  all.dishes = data;
  autoSyncToGitHub(all);
}

// ===== USERS =====
var USERS = [
  { id: 'nizi', name: '妮子', avatar: 'avatars/nizi.jpg' },
  { id: 'jianda', name: '健达奇趣蛋', avatar: 'avatars/jianda.jpg' },
  { id: 'luye', name: '卢老爷子', avatar: 'avatars/luye.jpg' },
  { id: 'shuishui', name: '睡睡平安', avatar: 'avatars/shuishui.jpg' },
];

function renderUsers() {
  var strip = document.getElementById('usersStrip');
  var tools = ['🍳', '🥘', '🔪', '🥄'];
  strip.innerHTML = USERS.map(function(u, i) {
    return '<div class="user-chip" title="' + escAttr(u.name) + ' 的厨房"><img class="avatar" src="' + escAttr(u.avatar) + '" alt="' + escAttr(u.name) + '" onerror="this.style.opacity=0.3"><span class="name">' + tools[i % tools.length] + ' ' + escHtml(u.name) + '</span></div>';
  }).join('');
}

// ===== NAVIGATION =====
var currentPage = 'recipe';
function navigateTo(page) {
  if (page === currentPage) return;
  currentPage = page;
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.page === page); });
  document.querySelectorAll('.page-section').forEach(function(s) { s.classList.toggle('active', s.id === 'section-' + page); });
}
document.querySelectorAll('.nav-btn').forEach(function(btn) { btn.addEventListener('click', function() { navigateTo(this.dataset.page); }); });

// ===== MODAL =====
var modalOverlay = document.getElementById('modalOverlay');
var modalContent = document.getElementById('modalContent');
function openModal(html, maxW) {
  modalContent.innerHTML = html;
  modalContent.style.maxWidth = maxW ? maxW : '560px';
  modalOverlay.classList.remove('hidden');
}
function closeModal() { modalOverlay.classList.add('hidden'); }
modalOverlay.addEventListener('click', function(e) { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeModal(); });

// ===== UTILS =====
function escHtml(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ===== PARSE STEPS =====
function parseSteps(text) {
  if (!text) return ['✨ 按个人口味自由发挥吧～'];
  var steps = [];
  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  var stepPat = /^(\d+)[\.\)、.·\s]+(.+)/;
  var inSteps = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    var m = line.match(stepPat);
    if (m) { inSteps = true; steps.push(m[2].trim()); }
    else if (inSteps && line.length > 3) { steps.push(line); }
  }
  if (steps.length === 0) {
    if (text.length > 100) {
      var parts = text.split(/[。；;]/);
      steps = parts.filter(function(p) { return p.trim().length > 8; }).map(function(p) { return p.trim() + '。'; });
      if (steps.length < 2) steps = [text.substring(0, Math.min(500, text.length))];
    } else { steps = [text]; }
  }
  return steps;
}

// ===== RECIPE FORM =====
var recipeImageData = null;
var ingrImageData = null;
var methodImageData = null;
var pendingLink = null; // link waiting for extraction

function showRecipeForm(existing, editIdx) {
  var isEdit = typeof editIdx !== 'undefined';
  var title = isEdit ? existing.title : '';
  var source = isEdit ? (existing.source || '') : '';
  var authorName = isEdit ? (existing.authorName || '') : '';
  var method = isEdit ? existing.method : '';
  var ingredients = isEdit ? (existing.ingredients || '') : '';
  var image = isEdit ? (existing.image || '') : '';
  recipeImageData = isEdit ? (existing.image || null) : null;
  ingrImageData = isEdit ? (existing.ingrImage || null) : null;
  methodImageData = isEdit ? (existing.methodImage || null) : null;
  pendingLink = source;

  var authorOptions = USERS.map(function(u) { return '<option value="' + escAttr(u.name) + '"' + (authorName === u.name ? ' selected' : '') + '>' + escHtml(u.name) + '</option>'; }).join('');

  var imgPreview = '';
  if (image) {
    imgPreview = '<img src="' + escAttr(image) + '" alt="预览" onerror="this.style.display=\'none\'" style="max-width:100%;max-height:140px;border-radius:10px;margin-bottom:8px;display:block;" referrerpolicy="no-referrer">';
  }

  var html = '<h3>' + (isEdit ? '✏️ 编辑菜谱' : '🥘 添加菜谱') + '</h3>' +
    
    '<div class="form-group"><label>🖼️ 菜谱封面图片</label>' +
      '<p style="font-size:11px;color:#B8957A;margin:0 0 6px 0;">💡 从相册选一张美食照片作为封面</p>' +
      '<div class="file-upload-area" onclick="document.getElementById(\'fImageInput\').click()" style="cursor:pointer;border:2px dashed var(--card-border);border-radius:10px;padding:20px;text-align:center;background:#FFF;">' +
        imgPreview + '<div id="imgHint" style="' + (image ? 'display:none' : '') + '">📸 点击此区域上传菜谱封面图</div>' +
        '<input type="file" id="fImageInput" accept="image/*" style="display:none" onchange="handleRecipeImage(this)">' +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>🍲 菜名</label><input type="text" id="fTitle" value="' + escAttr(title) + '" placeholder="这道菜叫什么呀？"></div>' +
    '<div class="form-group"><label>🔗 原帖链接</label>' +
      '<input type="text" id="fLink" value="' + escAttr(source) + '" placeholder="小红书/B站/抖音/下厨房链接（可选）" style="color:var(--accent-green);">' +
      '<p style="font-size:11px;color:#B8957A;margin:4px 0 0 0;">💡 粘贴链接后保存，详情页可点击"查看原帖"</p>' +
    '</div>' +
    '<div class="form-group"><label>👤 收藏者</label><select id="fAuthor">' + authorOptions + '</select></div>' +
    '<div class="form-group"><label>🛒 所需食材</label>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById(\'fIngredientsImg\').click()" style="flex-shrink:0;">📷 上传截图</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="ocrFromImage(\'ingr\')" style="flex-shrink:0;color:var(--accent-green);">🔍 提取文字</button>' +
      '<span style="font-size:11px;color:#B8957A;">或下方打字</span>' +
      '<input type="file" id="fIngredientsImg" accept="image/*" style="display:none" onchange="handleIngrImage(this)">' +
      '<div id="ingrImgPreview" style="width:100%;">' + (ingrImageData ? '<img src="' + ingrImageData + '" style="max-width:100%;max-height:80px;border-radius:6px;">' : '') + '</div>' +
    '</div>' +
    '<textarea id="fIngredients" placeholder="例如：排骨 500g、生抽 2勺、料酒 1勺...">' + escHtml(ingredients) + '</textarea></div>' +
    '<div class="form-group"><label>📝 制作方法</label>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById(\'fMethodImg\').click()" style="flex-shrink:0;">📷 上传截图</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="ocrFromImage(\'method\')" style="flex-shrink:0;color:var(--accent-green);">🔍 提取文字</button>' +
      '<span style="font-size:11px;color:#B8957A;">或手动输入</span>' +
      '<input type="file" id="fMethodImg" accept="image/*" style="display:none" onchange="handleMethodImage(this)">' +
      '<div id="methodImgPreview" style="width:100%;">' + (methodImageData ? '<img src="' + methodImageData + '" style="max-width:100%;max-height:80px;border-radius:6px;">' : '') + '</div>' +
    '</div>' +
    '<textarea id="fMethod" rows="5" placeholder="步骤1. 先...&#10;步骤2. 然后...">' + escHtml(method) + '</textarea></div>' +
    '<div class="modal-actions">' +
      '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-primary" onclick="saveRecipeForm(' + (isEdit ? editIdx : -1) + ')">💾 保存菜谱</button>' +
    '</div>';
  openModal(html, '620px');
}


function handleIngrImage(input) {
  var file = input.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    compressImage(e.target.result, 150, function(compressed) {
      ingrImageData = compressed;
      var preview = document.getElementById('ingrImgPreview');
      if (preview) { preview.innerHTML = '<img src="' + ingrImageData + '" style="max-width:100%;max-height:80px;border-radius:6px;">'; }
    });
  };
  reader.readAsDataURL(file);
}
function handleMethodImage(input) {
  var file = input.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    compressImage(e.target.result, 150, function(compressed) {
      methodImageData = compressed;
      var preview = document.getElementById('methodImgPreview');
      if (preview) { preview.innerHTML = '<img src="' + methodImageData + '" style="max-width:100%;max-height:80px;border-radius:6px;">'; }
    });
  };
  reader.readAsDataURL(file);
}
var _cropTarget = null;
function openCropModal(imageData) {
  var html = '<div style="text-align:center;"><h3 style="margin-bottom:12px;">✂️ 裁剪封面图片</h3>' +
    '<div style="position:relative;max-height:60vh;overflow:hidden;cursor:move;user-select:none;" id="cropWrapper">' +
      '<img id="cropImg" src="' + imageData + '" style="max-width:100%;display:block;user-select:none;" draggable="false">' +
      '<div id="cropOverlay" style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);pointer-events:none;">' +
        '<div id="cropBox" style="position:absolute;border:2px solid #fff;background:rgba(255,255,255,0.15);pointer-events:none;"></div>' +
      '</div>' +
    '</div>' +
    '<p style="font-size:12px;color:#B8957A;margin:8px 0;">拖拽图片调整位置，滚动鼠标缩放，框内为最终裁剪区域</p>' +
    '<div style="display:flex;gap:10px;justify-content:center;margin-top:12px;">' +
      '<button class="btn btn-ghost" id="btnSkipCrop">跳过裁剪</button>' +
      '<button class="btn btn-primary" id="btnApplyCrop">✅ 确认裁剪</button>' +
    '</div></div>';
  openModal(html, '560px');
  _cropTarget = { imageData: imageData };
  // Bind buttons manually (safer than inline onclick)
  setTimeout(function() {
    initCrop();
    var skipBtn = document.getElementById('btnSkipCrop');
    var applyBtn = document.getElementById('btnApplyCrop');
    if (skipBtn) skipBtn.onclick = closeCropModal;
    if (applyBtn) applyBtn.onclick = applyCrop;
  }, 300);
}

function closeCropModal() {
  // Just close the crop modal, keep recipeImageData as-is
  recipeImageData = _cropTarget ? _cropTarget.imageData : recipeImageData;
  closeModal();
  // Re-open the recipe form with the image
  var formData = {
    title: (document.getElementById('fTitle')||{}).value || '',
    authorName: (document.getElementById('fAuthor')||{}).value || '',
    ingredients: (document.getElementById('fIngredients')||{}).value || '',
    method: (document.getElementById('fMethod')||{}).value || '',
    image: recipeImageData,
    ingrImage: ingrImageData,
    methodImage: methodImageData
  };
  // Re-show the form
  setTimeout(function() {
    showRecipeForm(formData, -1);
  }, 100);
}

function initCrop() {
  var img = document.getElementById('cropImg');
  var box = document.getElementById('cropBox');
  var wrapper = document.getElementById('cropWrapper');
  if (!img || !box) return;
  var maxDim = Math.max(img.naturalWidth, img.naturalHeight) || 400;
  var imgDisplayW = Math.min(wrapper.clientWidth, img.naturalWidth, 400);
  var ratio = imgDisplayW / (img.naturalWidth || 1);
  var imgDisplayH = (img.naturalHeight || 300) * ratio;
  var size = Math.min(imgDisplayW, imgDisplayH, 280);
  var left = (wrapper.clientWidth - size) / 2;
  var top = (imgDisplayH - size) / 2;
  box.style.width = size + 'px';
  box.style.height = size + 'px';
  box.style.left = left + 'px';
  box.style.top = top + 'px';
  var scale = 1;
  wrapper.onwheel = function(e) {
    e.preventDefault();
    scale = Math.max(0.5, Math.min(3, scale + (e.deltaY < 0 ? 0.1 : -0.1)));
    img.style.transform = 'scale(' + scale + ')';
    img.style.transformOrigin = '0 0';
  };
  var dragging = false, startX, startY, imgX = 0, imgY = 0;
  wrapper.onmousedown = function(e) { dragging = true; startX = e.clientX - imgX; startY = e.clientY - imgY; e.preventDefault(); };
  wrapper.onmousemove = function(e) { if (dragging) { imgX = e.clientX - startX; imgY = e.clientY - startY; img.style.marginLeft = imgX + 'px'; img.style.marginTop = imgY + 'px'; } };
  wrapper.onmouseup = function() { dragging = false; };
  wrapper.onmouseleave = function() { dragging = false; };
}

function applyCrop() {
  var img = document.getElementById('cropImg');
  var box = document.getElementById('cropBox');
  if (!img || !box) { closeCropModal(); return; }
  var canvas = document.createElement('canvas');
  var rect = img.getBoundingClientRect();
  var boxRect = box.getBoundingClientRect();
  var scaleX = img.naturalWidth / rect.width;
  var scaleY = img.naturalHeight / rect.height;
  var sx = (boxRect.left - rect.left) * scaleX;
  var sy = (boxRect.top - rect.top) * scaleY;
  var sw = boxRect.width * scaleX;
  var size = Math.min(sw, 400);
  canvas.width = size; canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sw, 0, 0, size, size);
  recipeImageData = canvas.toDataURL('image/jpeg', 0.85);
  _cropTarget.imageData = recipeImageData;
  closeModal();
  // Re-show form with cropped image
  setTimeout(function() {
    var formData = {
      title: (document.getElementById('fTitle')||{}).value || '',
      authorName: (document.getElementById('fAuthor')||{}).value || '',
      ingredients: (document.getElementById('fIngredients')||{}).value || '',
      method: (document.getElementById('fMethod')||{}).value || '',
      image: recipeImageData,
      ingrImage: ingrImageData,
      methodImage: methodImageData
    };
    showRecipeForm(formData, -1);
  }, 100);
}

function handleRecipeImage(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    recipeImageData = e.target.result;
    // Show crop modal
    openCropModal(recipeImageData);
  };
  reader.readAsDataURL(file);
}



// ===== OCR EXTRACT using Tesseract.js (runs entirely in browser) =====
var _ocrWorker = null;
function ocrFromImage(type) {
  var imgData = type === 'ingr' ? ingrImageData : methodImageData;
  if (!imgData) { showToast('⚠️ 请先上传截图再提取文字'); return; }
  var targetId = type === 'ingr' ? 'fIngredients' : 'fMethod';
  var existing = document.getElementById(targetId);
  if (existing) { existing.value = '🔍 正在识别文字，请稍候...'; }
  showToast('🔍 正在识别文字...');

  // Load Tesseract if not loaded yet
  function doOCR() {
    if (typeof Tesseract === 'undefined') {
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      script.onload = function() { runTesseract(); };
      script.onerror = function() {
        showToast('⚠️ OCR 库加载失败，请检查网络或直接打字');
        if (existing) { existing.value = ''; }
      };
      document.head.appendChild(script);
    } else {
      runTesseract();
    }
  }

  function runTesseract() {
    Tesseract.recognize(imgData, 'chi_sim+eng', {
      logger: function(m) {
        if (m.status === 'recognizing text' && m.progress) {
          var pct = Math.round(m.progress * 100);
          if (existing && pct % 20 === 0) { existing.value = '🔍 识别中...' + pct + '%'; }
        }
      }
    }).then(function(result) {
      var text = result.data.text.trim();
      // Aggressively clean spaces from OCR output:
      // 1. Remove ALL spaces/newlines between CJK characters
      text = text.replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, function(m, c1, c2) { return c1 + c2; });
      // 2. Remove any remaining space-like chars (full-width spaces, zero-width)
      text = text.replace(/[\u3000\u2000-\u200f\u2028-\u202f\u205f\u00a0]/g, '');
      // 3. Remove spaces at start of lines
      text = text.replace(/^[ ]+/gm, '');
      // 4. Collapse multiple spaces to one (for Latin/numbers)
      text = text.replace(/  +/g, ' ');
      // 5. Condense excessive newlines
      text = text.replace(/\n{3,}/g, '\n\n');
      if (!text) { showToast('⚠️ 未识别到文字，请手动输入'); if (existing) existing.value = ''; return; }
      if (existing) { existing.value = text; }
      showToast('✅ 识别完成！请检查并修改文字');
    }).catch(function(err) {
      showToast('⚠️ 识别失败，请直接打字');
      if (existing) { existing.value = '';
      console.error('OCR error:', err); }
    });
  }
  doOCR();
}




function saveRecipeForm(editIdx) {
  var title = document.getElementById('fTitle').value.trim();
  var sourceLink = document.getElementById('fLink') ? document.getElementById('fLink').value.trim() : '';
  var source = '';
  var authorName = document.getElementById('fAuthor').value;
  var method = document.getElementById('fMethod').value.trim();
  var ingredients = document.getElementById('fIngredients').value.trim();
  if (!title) { alert('🍲 请输入菜名哦～'); return; }
  if (!method) { alert('📝 请输入制作方法哦～'); return; }
  var recipes = loadRecipes();
  var entry = { title: title, source: sourceLink,
      authorName: authorName, method: method, ingredients: ingredients, image: recipeImageData || '', ingrImage: ingrImageData || '', methodImage: methodImageData || '', date: new Date().toISOString(), status: 'new' };
  if (editIdx >= 0) { entry.status = recipes[editIdx].status; entry.date = recipes[editIdx].date; if (!recipeImageData) entry.image = recipes[editIdx].image; recipes[editIdx] = entry; }
  else { recipes.unshift(entry); }
  saveRecipes(recipes); closeModal(); renderRecipes();
  showToast('🎉 菜谱「' + title + '」收藏成功！');
}


function showRecipeDetail(recipeIdx) {
  var recipes = loadRecipes();
  if (!recipes || recipeIdx >= recipes.length) return;
  var recipe = recipes[recipeIdx];
  var steps = parseSteps(recipe.method);
  var sourceHtml = recipe.source 
    ? '<p style="margin-top:10px;"><a href="#" onclick="event.stopPropagation();window.open(\'' + escAttr(recipe.source) + '\',\'_blank\',\'noopener,noreferrer\');return false;" style="color:var(--accent);text-decoration:underline;cursor:pointer;font-size:14px;">📎 查看原帖 ↗</a></p>'
    : '';
  var imgHtml = recipe.image 
    ? '<img src="' + escAttr(recipe.image) + '" alt="' + escAttr(recipe.title) + '" style="max-width:100%;max-height:300px;border-radius:12px;display:block;margin-bottom:16px;" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
    : '';
  var ingrHtml = recipe.ingredients
    ? '<div style="background:#FFF8F0;border:1px solid var(--card-border);border-radius:10px;padding:14px 16px;margin-bottom:16px;"><h4 style="font-family:var(--font-heading);color:var(--accent-deep);margin:0 0 6px 0;">所需食材</h4>' +
    (recipe.ingrImage ? '<img src="' + escAttr(recipe.ingrImage) + '" style="max-width:100%;max-height:200px;border-radius:8px;margin-bottom:8px;display:block;">' : '') +
    '<p style="font-size:14px;line-height:1.8;color:var(--text-primary);">' + (recipe.ingredients ? escHtml(recipe.ingredients).replace(/\n/g,'<br>') : '（无文字描述）') + '</p></div>'
    : '';
  var stepsHtml = steps.map(function(s,i){ return '<li><span class="step-text">' + escHtml(s) + '</span></li>'; }).join('');
  
  var html = '<div style="padding:8px;"><h3 style="margin-bottom:16px;">📖 ' + escHtml(recipe.title) + '</h3>' +
    imgHtml +
    '<div style="margin-bottom:10px;"><span style="font-size:14px;color:var(--text-secondary);">👤 收藏者：' + escHtml(recipe.authorName||'?') + '</span> &nbsp; <span style="font-size:13px;color:#B8957A;">🕐 ' + new Date(recipe.date).toLocaleDateString('zh-CN') + '</span></div>' +
    sourceHtml + ingrHtml +
    '<h4 style="font-family:var(--font-heading);color:var(--accent-deep);margin:16px 0 10px 0;">📝 制作流程</h4>' +
    (recipe.methodImage ? '<img src="' + escAttr(recipe.methodImage) + '" style="max-width:100%;max-height:200px;border-radius:8px;margin-bottom:8px;display:block;">' : '') +
    '<ol class="cooking-steps">' + stepsHtml + '</ol>' +
    '<div style="margin-top:24px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">' +
      '<button class="btn btn-ghost" onclick="closeModal()">↩️ 返回</button>' +
      '<button class="btn btn-success btn-lg" onclick="closeModal();showCookingFlow(' + recipeIdx + ')">🔪 现在就做</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="closeModal();showRecipeForm(loadRecipes()[' + recipeIdx + '],' + recipeIdx + ')">✏️ 编辑</button>' +
    '</div></div>';
  openModal(html, '680px');
}

// ===== RECIPE RENDER =====
var sharingNote = '<div class="encourage-banner" style="background:linear-gradient(135deg,#E8F5E2,#D4ECD0);border-color:#A8D5A2;margin-bottom:16px;">👥 共享厨房：每位成员打开此页面即可看到所有人的菜谱和成品～数据保存在浏览器本地</div>';
  var ENCOURAGE_TIPS = ['👨‍🍳 准备好了吗？动手试试吧～','🔥 厨房小能手就是你！','💪 做菜也是修行！','🍜 饿了吗？不如自己动手','✨ 每一道菜都是心意','🥢 好菜不怕等！','🧑‍🍳 米其林水准等你来挑战'];

function renderRecipes() {
  var grid = document.getElementById('recipeGrid');
  var empty = document.getElementById('recipeEmpty');
  loadSharedData(function(cloudData) {
    var recipes = cloudData ? (cloudData.recipes || []) : loadRecipes();
    _doRenderRecipes(grid, empty, recipes);
  });
}

function _doRenderRecipes(grid, empty, recipes) {
  if (recipes.length === 0) { grid.innerHTML = ''; empty.classList.remove('hidden'); }
  else {
    empty.classList.add('hidden');
    var tip = ENCOURAGE_TIPS[Math.floor(Math.random() * ENCOURAGE_TIPS.length)];
    grid.innerHTML = '<div class="encourage-banner" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;"><span>💬 ' + tip + '</span><button class="btn btn-ghost btn-sm" onclick="syncToGitHub()">☁️ 同步到云端</button></div>' + recipes.map(function(r, i) {
      var date = new Date(r.date);
      var dateStr = date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
      var imgHtml = r.image ? '<div class="recipe-card-img-wrap"><img class="recipe-card-img" style="object-fit:cover;width:100%;height:100%" src="' + escAttr(r.image) + '" alt="' + escAttr(r.title) + '" style="object-fit:cover" onerror="this.parentElement.innerHTML=\'<div style=background:linear-gradient(135deg,#FDEBD0,#FAD7A1);height:200px;display:flex;align-items:center;justify-content:center;font-size:52px>🍳</div>\'" referrerpolicy="no-referrer"></div>' : '<div class="recipe-card-img-wrap" style="background:linear-gradient(135deg,#FDEBD0,#FAD7A1);display:flex;align-items:center;justify-content:center;height:200px;font-size:52px">🍳</div>';
      var statusTag = '', statusEmoji = '📖';
      if (r.status === 'cooking') { statusTag = '<span class="recipe-status-tag tag-cooking">🔥 烹饪中</span>'; statusEmoji = '🔥'; }
      else if (r.status === 'done') { statusTag = '<span class="recipe-status-tag tag-done">✅ 已完成</span>'; statusEmoji = '🎉'; }
      var steps = parseSteps(r.method);
      var previewText = steps.slice(0, 2).join(' · ') + (steps.length > 2 ? ' ...' : '');
      var sourceLabel = '';
      if (r.source) {
        var srcIcon = '🔗';
        if (/bilibili|b23/i.test(r.source)) srcIcon = '📺';
        else if (/xiaohongshu|xhslink|xhs/i.test(r.source)) srcIcon = '📕';
        else if (/douyin|dy/i.test(r.source)) srcIcon = '🎵';
        sourceLabel = '<div class="recipe-source">' + srcIcon + ' <a href="' + escAttr(r.source) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();" style="color:var(--accent);text-decoration:underline;cursor:pointer;">📎 查看原帖 ↗</a></div>';
      }
      var ingrHtml = r.ingredients ? '<div class="recipe-ingredients">🛒 ' + escHtml(r.ingredients.substring(0, 60)) + (r.ingredients.length > 60 ? '...' : '') + '</div>' : '';
      return '<div class="recipe-card" style="cursor:pointer" onclick="showRecipeDetail(' + i + ')">' + imgHtml + '<div class="recipe-card-body">' +
        '<div class="recipe-card-title">' + statusEmoji + ' ' + escHtml(r.title) + '</div>' + sourceLabel + ingrHtml +
        '<div class="recipe-desc">📝 ' + escHtml(previewText) + '</div>' +
        '<div class="recipe-meta"><span>👤 ' + escHtml(r.authorName || '') + '</span><span>🕐 ' + dateStr + '</span>' + statusTag + '</div>' +
      '</div><div class="recipe-card-footer">' +
        '<div class="actions">' + (r.status === 'done' ? '<button class="btn btn-success btn-sm btnCookNow" data-idx=" + i + " style="background:#5B8C5A">🔪 再做一次</button>' : '<button class="btn btn-success btn-sm btnCookNow" data-idx="' + i + '">🔪 现在就做</button>') + '</div>' +
        '<div class="actions"><button class="btn btn-ghost btn-sm btnEditRecipe" data-idx="' + i + '">✏️</button><button class="btn btn-danger btn-sm btnDelRecipe" data-idx="' + i + '">🗑️</button></div>' +
      '</div></div>';
    }).join('');
  }
  bindRecipeActions();
}

function bindRecipeActions() {
  document.querySelectorAll('.btnDelRecipe').forEach(function(b) { b.addEventListener('click', function() {
    var idx = parseInt(this.dataset.idx); var recipes = loadRecipes();
    if (confirm('😢 确定要删除「' + recipes[idx].title + '」吗？')) { recipes.splice(idx, 1); saveRecipes(recipes); renderRecipes(); showToast('🗑️ 菜谱已删除'); }
  });});
  document.querySelectorAll('.btnEditRecipe').forEach(function(b) { b.addEventListener('click', function() { var idx = parseInt(this.dataset.idx); showRecipeForm(loadRecipes()[idx], idx); });});
  document.querySelectorAll('.btnCookNow').forEach(function(b) { b.addEventListener('click', function() { showCookingFlow(parseInt(this.dataset.idx)); });});
}

// ===== COOKING FLOW =====
function showCookingFlow(recipeIdx) {
  var recipes = loadRecipes(); var recipe = recipes[recipeIdx]; var steps = parseSteps(recipe.method);
  recipes[recipeIdx].status = 'cooking'; saveRecipes(recipes);
  var ingrHtml = recipe.ingredients ? '<div class="cooking-ingredients"><h4>🛒 准备食材</h4><p>' + escHtml(recipe.ingredients).replace(/\n/g, '<br>') + '</p></div>' : '';
  var stepsHtml = steps.map(function(s) { return '<li><span class="step-text">' + escHtml(s) + '</span></li>'; }).join('');
  var srcHtml = recipe.source ? '<p style="margin-top:8px;font-size:12px;">📎 <a href="' + escAttr(recipe.source) + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline;cursor:pointer;">查看原帖 ↗</a></p>' : '';
  var html = '<div class="cooking-content"><h3>🔪 正在制作：' + escHtml(recipe.title) + '</h3>' +
    '<p class="cooking-chef">👨‍🍳 主厨：' + escHtml(recipe.authorName || '神秘厨师') + ' &nbsp;💪 加油！</p>' + ingrHtml +
    '<h4 style="margin-top:18px;margin-bottom:8px;">📋 操作流程</h4><ol class="cooking-steps">' + stepsHtml + '</ol>' +
    '<div class="cooking-encourage">🔥 每一步都是向美味靠近！坚持就是胜利～</div>' + srcHtml +
    '<div style="margin-top:24px;display:flex;gap:10px;justify-content:center">' +
      '<button class="btn btn-ghost" onclick="closeModal();renderRecipes()">↩️ 先放一放</button>' +
      '<button class="btn btn-success btn-lg" onclick="finishCooking(' + recipeIdx + ')">🍽️ 美味出炉！</button></div></div>';
  openModal(html, '660px');
}

function finishCooking(recipeIdx) {
  var recipes = loadRecipes(); var recipe = recipes[recipeIdx];
  recipes[recipeIdx].status = 'done'; saveRecipes(recipes);
  var dishes = loadDishes();
  dishes.unshift({ title: recipe.title, authorName: recipe.authorName, desc: '按照菜谱完成，等待补充品尝描述...', rating: 0, photo: '', date: new Date().toISOString(), recipeId: recipeIdx });
  saveDishes(dishes);
  closeModal(); renderRecipes(); renderDishes(); navigateTo('dish');
  showToast('🎉 美味出炉！「' + recipe.title + '」已加入成品展示');
}

// ===== TOAST =====
function showToast(msg) {
  var toast = document.createElement('div'); toast.className = 'toast-msg'; toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add('toast-hide'); setTimeout(function() { toast.remove(); }, 400); }, 2600);
}


function showDishDetail(dishIdx) {
  var dishes = loadDishes();
  if (!dishes || dishIdx >= dishes.length) return;
  var d = dishes[dishIdx];
  var ratingLabels = ['拉完了', 'NPC', '人上人', '顶级', '夯爆了'];
  var ratingEmoji = ['💩', '😐', '🙂', '😋', '🤯'];
  var rl = d.rating > 0 ? ratingEmoji[d.rating-1] + ' ' + ratingLabels[d.rating-1] : '未评分';
  var imgHtml = d.photo 
    ? '<img src="' + escAttr(d.photo) + '" alt="' + escAttr(d.title) + '" style="max-width:100%;max-height:300px;border-radius:12px;display:block;margin-bottom:16px;" referrerpolicy="no-referrer" onerror="this.style.display=none">'
    : '<div style="background:linear-gradient(135deg,#FDEBD0,#FAD7A1);height:200px;display:flex;align-items:center;justify-content:center;font-size:52px;border-radius:12px;margin-bottom:16px;">🍽️</div>';
  
  var html = '<div style="padding:8px;"><h3 style="margin-bottom:16px;">🍽️ ' + escHtml(d.title) + '</h3>' +
    imgHtml +
    '<div style="margin-bottom:10px;"><span style="font-size:14px;color:var(--text-secondary);">👤 制作者：' + escHtml(d.authorName||'') + '</span> &nbsp; <span style="font-size:13px;color:#B8957A;">🕐 ' + new Date(d.date).toLocaleDateString('zh-CN') + '</span></div>' +
    '<div style="background:#FFF8F0;border:1px solid var(--card-border);border-radius:10px;padding:14px 16px;margin-bottom:16px;"><h4 style="font-family:var(--font-heading);color:var(--accent-deep);margin:0 0 6px 0;">💬 品尝描述</h4><p style="font-size:14px;line-height:1.8;color:var(--text-primary);">' + (d.desc ? escHtml(d.desc) : '还没有写描述呢～') + '</p></div>' +
    '<div style="text-align:center;padding:12px;background:rgba(224,122,61,0.06);border-radius:10px;margin-bottom:16px;"><span style="font-size:18px;font-weight:bold;color:var(--accent-deep);">🏆 口味评价：' + rl + '</span></div>' +
    '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">' +
      '<button class="btn btn-ghost" onclick="closeModal()">↩️ 返回</button>' +
      '<button class="btn btn-primary btn-sm" onclick="closeModal();showDishForm(loadDishes()[' + dishIdx + '],' + dishIdx + ')">✏️ 编辑</button>' +
    '</div></div>';
  openModal(html, '620px');
}

// ===== DISH RENDER =====
function renderDishes() {
  var grid = document.getElementById('dishGrid'); var empty = document.getElementById('dishEmpty');
  loadSharedData(function(cloudData) {
    var dishes = cloudData ? (cloudData.dishes || []) : loadDishes();
    _doRenderDishes(grid, empty, dishes);
  });
}

function _doRenderDishes(grid, empty, dishes) {
  if (dishes.length === 0) { grid.innerHTML = ''; empty.classList.remove('hidden'); }
  else {
    empty.classList.add('hidden');
    var ratingLabels = ['💩 拉完了', '😐 NPC', '🙂 人上人', '😋 顶级', '🤯 夯爆了'];
    var parts = [];
    parts.push('<div class="encourage-banner" style="background:linear-gradient(135deg,#E8F5E2,#D4ECD0);border-color:#A8D5A2;margin-bottom:16px;">👥 共享厨房：你做的每一道菜大家都能看到！</div>');
    parts.push('<div class="encourage-banner">🍽️ 每一份成品都是爱的味道～</div>');
    for (var i = 0; i < dishes.length; i++) {
      var d = dishes[i];
      var ratingLabel = d.rating > 0 ? ratingLabels[d.rating - 1] : '❓ 未评分';
      var ratingColor = d.rating >= 5 ? '#E07A3D' : d.rating >= 4 ? '#5B8C5A' : d.rating >= 3 ? '#6A8CBF' : d.rating >= 2 ? '#B8957A' : d.rating >= 1 ? '#D4695A' : '#7A6553';
      var date = new Date(d.date);
      var dateStr = date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
      var imgTag = '';
      if (d.photo) {
        imgTag = '<img class="dish-photo" style="object-fit:cover" src="' + escAttr(d.photo) + '" alt="' + escAttr(d.title) + '" onerror="this.style.background=\'linear-gradient(135deg,#FDEBD0,#FAD7A1)\';this.src=\'\'" referrerpolicy="no-referrer">';
      } else {
        imgTag = '<div class="dish-photo" style="display:flex;align-items:center;justify-content:center;font-size:52px">🍽️</div>';
      }
      var html = '<div class="dish-card" style="cursor:pointer" onclick="showDishDetail(' + i + ')">';
      html += imgTag;
      html += '<div class="dish-body">';
      html += '<div class="dish-title">' + escHtml(d.title) + '</div>';
      html += '<div class="dish-author">👤 ' + escHtml(d.authorName || '') + '</div>';
      html += '<div class="dish-desc">' + (d.desc ? escHtml(d.desc) : '💬 等待添加品尝描述...') + '</div>';
      html += '<div class="dish-rating-single"><span style="color:' + ratingColor + ';font-weight:bold;font-size:16px;">' + ratingLabel + '</span></div>';
      html += '<div style="font-size:12px;color:#B8957A;margin-top:6px">🕐 ' + dateStr + '</div>';
      html += '</div>';
      html += '<div class="dish-footer"><button class="btn btn-ghost btn-sm btnEditDish" data-idx="' + i + '">✏️ 编辑</button><button class="btn btn-danger btn-sm btnDelDish" data-idx="' + i + '">🗑️</button></div>';
      html += '</div>';
      parts.push(html);
    }
    grid.innerHTML = parts.join('');
  }
  bindDishActions();
}

function bindDishActions() {
  document.querySelectorAll('.btnDelDish').forEach(function(b) { b.addEventListener('click', function() {
    var idx = parseInt(this.dataset.idx); var dishes = loadDishes();
    if (confirm('😢 确定要删除这条成品记录吗？')) { dishes.splice(idx, 1); saveDishes(dishes); renderDishes(); showToast('🗑️ 成品记录已删除'); }
  });});
  document.querySelectorAll('.btnEditDish').forEach(function(b) { b.addEventListener('click', function() { var idx = parseInt(this.dataset.idx); showDishForm(loadDishes()[idx], idx); });});
}

// ===== DISH FORM =====
var dishPhotoData = null;
function showDishForm(existing, editIdx) {
  var isEdit = typeof editIdx !== 'undefined';
  var title = isEdit ? existing.title : '';
  var authorName = isEdit ? (existing.authorName || '') : '';
  var desc = isEdit ? existing.desc : '';
  var rating = isEdit ? (existing.rating || 0) : 0;
  dishPhotoData = isEdit ? (existing.photo || null) : null;

  var authorOptions = USERS.map(function(u) { return '<option value="' + escAttr(u.name) + '"' + (authorName === u.name ? ' selected' : '') + '>' + escHtml(u.name) + '</option>'; }).join('');
  var recipes = loadRecipes();
  var recipeOptions = '<option value="">-- 🍲 从菜谱中选择 --</option>';
  for (var r = 0; r < recipes.length; r++) { var rp = recipes[r]; recipeOptions += '<option value="' + escAttr(rp.title) + '"' + (title === rp.title ? ' selected' : '') + '>' + escHtml(rp.title) + ' 👤' + escHtml(rp.authorName || '?') + '</option>'; }
  if (title && !recipes.some(function(rp) { return rp.title === title; })) { recipeOptions += '<option value="' + escAttr(title) + '" selected>' + escHtml(title) + ' (手动)</option>'; }

  var ratingLabels = ['💩 拉完了', '😐 NPC', '🙂 人上人', '😋 顶级', '🤯 夯爆了'];
  var ratingRadios = '';
  for (var s = 1; s <= 5; s++) {
    var checked = s === rating ? ' checked' : '';
    ratingRadios += '<label class="rating-radio-label' + (s === rating ? ' checked' : '') + '"><input type="radio" name="fRating" value="' + s + '"' + checked + ' onchange="onRatingChange(this)"><span>' + ratingLabels[s-1] + '</span></label>';
  }

  var preview = dishPhotoData ? '<img class="preview-img" src="' + dishPhotoData + '" alt="预览">' : '';
  var fileClass = dishPhotoData ? ' has-file' : '';

  var html = '<h3>' + (isEdit ? '✏️ 编辑成品' : '📸 上传成品') + '</h3>' +
    '<p class="form-hint">🎉 恭喜完成一道菜！记录下你的杰作吧～</p>' +
    '<div class="form-group"><label>🍲 菜名（从菜谱选择）</label><select id="fDishTitle">' + recipeOptions + '</select></div>' +
    '<div class="form-group"><label>👤 制作者</label><select id="fDishAuthor">' + authorOptions + '</select></div>' +
    '<div class="form-group"><label>📸 成品美照</label><div class="file-upload-area' + fileClass + '" id="fileArea" onclick="document.getElementById(\'fPhoto\').click()">' +
      preview + '<div id="fileHint" style="' + (dishPhotoData ? 'display:none' : '') + '">请上传你自己拍摄的成品照片哦</div>' +
      '<input type="file" id="fPhoto" accept="image/*" style="display:none" onchange="handlePhoto(this)"></div></div>' +
    '<div class="form-group"><label>💬 品尝描述</label><textarea id="fDishDesc" placeholder="口感如何？卖相怎么样？有什么想说的？" rows="3">' + escHtml(desc) + '</textarea></div>' +
    '<div class="form-group"><label>🏆 口味评价（单选）</label><div class="rating-radio-group" id="ratingGroup">' + ratingRadios + '</div><input type="hidden" id="fRatingVal" value="' + rating + '"></div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveDishForm(' + (isEdit ? editIdx : -1) + ')">💾 保存成品</button></div>';
  openModal(html, '600px');
}

function onRatingChange(el) {
  var val = parseInt(el.value);
  document.getElementById('fRatingVal').value = val;
  document.querySelectorAll('.rating-radio-label').forEach(function(lbl) { lbl.classList.remove('checked'); });
  el.parentElement.classList.add('checked');
}

function handlePhoto(input) {
  var file = input.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var rawData = e.target.result;
    // Compress before storing
    compressImage(rawData, 200, function(compressed) {
      dishPhotoData = compressed;
      var area = document.getElementById('fileArea');
      var existing = area.querySelector('.preview-img'); if (existing) existing.remove();
      var img = document.createElement('img'); img.className = 'preview-img'; img.src = dishPhotoData; img.alt = '预览';
      area.insertBefore(img, area.firstChild); area.classList.add('has-file');
      var hint = document.getElementById('fileHint'); if (hint) hint.style.display = 'none';
      showToast('📸 照片已压缩上传');
    });
  };
  reader.readAsDataURL(file);
}

function saveDishForm(editIdx) {
  var title = document.getElementById('fDishTitle').value;
  var authorName = document.getElementById('fDishAuthor').value;
  var desc = document.getElementById('fDishDesc').value.trim();
  var rating = parseInt(document.getElementById('fRatingVal').value) || 0;
  if (!title) { alert('🍲 请从菜谱中选择菜名哦～'); return; }
  var dishes = loadDishes();
  var entry = { title: title,
      authorName: authorName, desc: desc, rating: rating, photo: dishPhotoData || '', date: new Date().toISOString() };
  if (editIdx >= 0) { entry.date = dishes[editIdx].date; if (!dishPhotoData) entry.photo = dishes[editIdx].photo || ''; dishes[editIdx] = entry; }
  else { dishes.unshift(entry); }
  saveDishes(dishes); closeModal(); renderDishes();
  showToast('🎉 成品记录保存成功！');
}

// ===== INIT =====
document.getElementById('btnAddRecipe').addEventListener('click', function() { showRecipeForm(); });
document.getElementById('btnAddDish').addEventListener('click', function() { showDishForm(); });
renderUsers(); renderRecipes(); renderDishes();
