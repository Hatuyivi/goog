const { app, Menu, Tray, dialog, clipboard, Notification, nativeImage, BrowserWindow, ipcMain, shell } = require('electron')
const { execFile } = require('child_process')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Tesseract loaded lazily
let _tesseract = null
function getTesseract() {
  if (!_tesseract) _tesseract = require('tesseract.js')
  return _tesseract
}

const CONFIG_PATH   = path.join(os.homedir(), '.numsum_config.json')
const LOG_PATH      = path.join(os.homedir(), '.numsum_log.txt')
const TRAINING_PATH = path.join(os.homedir(), '.numsum_training.json')

const MAX_TRAINING_SAMPLES = 40

function loadTraining() {
  try { return JSON.parse(fs.readFileSync(TRAINING_PATH, 'utf8')) } catch { return [] }
}
function saveTraining(samples) {
  try { fs.writeFileSync(TRAINING_PATH, JSON.stringify(samples, null, 2), 'utf8') }
  catch(e) { log('saveTraining error: ' + e.message) }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(LOG_PATH, line) } catch {}
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8') }
  catch (e) { log(`saveConfig error: ${e.message}`) }
}

// ── Providers ──────────────────────────────────────────────
const PROVIDERS = {
  gemini:     { label: 'Gemini',         key: 'gemini_api_key',     needsKey: true  },
  openrouter: { label: 'OpenRouter',     key: 'openrouter_api_key', needsKey: true  },
  cloudflare: { label: 'Cloudflare AI',  key: 'cf_api_token',       needsKey: true  },
  local:      { label: 'Локально (OCR)', key: null,                 needsKey: false },
}

// Local OCR pseudo-models (sum module only)
const LOCAL_MODELS = [
  { id: 'tesseract-rus-eng', provider: 'local', label: 'Tesseract · Рус + Eng' },
  { id: 'tesseract-eng',     provider: 'local', label: 'Tesseract · Eng' },
  { id: 'tesseract-digits',  provider: 'local', label: 'Tesseract · только цифры' },
]

// ── Dynamic model cache ────────────────────────────────────
const GEMINI_FALLBACK = [
  { id: 'gemini-2.0-flash',      provider: 'gemini', label: 'Gemini 2.0 Flash' },
  { id: 'gemini-2.0-flash-lite', provider: 'gemini', label: 'Gemini 2.0 Flash Lite' },
  { id: 'gemini-1.5-flash',      provider: 'gemini', label: 'Gemini 1.5 Flash' },
]
const CF_FALLBACK = [
  { id: '@cf/meta/llama-3.2-11b-vision-instruct', provider: 'cloudflare', label: 'Llama 3.2 11B Vision' },
  { id: '@cf/meta/llava-1.5-7b-hf',               provider: 'cloudflare', label: 'LLaVA 1.5 7B' },
  { id: '@cf/unum/uform-gen2-qwen-500m',           provider: 'cloudflare', label: 'UForm Gen2 Qwen 500M' },
]
const modelCache = {
  gemini:     { models: [...GEMINI_FALLBACK], loaded: false, loading: false },
  openrouter: { models: [],                  loaded: false, loading: false },
  cloudflare: { models: [...CF_FALLBACK],    loaded: false, loading: false },
}

function modelsFor(provider) {
  if (provider === 'local') return LOCAL_MODELS
  return modelCache[provider]?.models || []
}

// ── Per-module state ───────────────────────────────────────
// 'sum' = menu-bar Σ capture, 'planner' = floor plan window ⌂
function makeModState(provider, modelId) {
  return { selectedProvider: provider, selectedModelId: modelId,
           activeProvider:   provider, activeModelId:   modelId }
}
const mod = {
  sum:     makeModState('gemini', GEMINI_FALLBACK[0].id),
  planner: makeModState('gemini', GEMINI_FALLBACK[0].id),
}

function getActiveModel(module) {
  const s = mod[module]
  const list = modelsFor(s.activeProvider)
  return list.find(m => m.id === s.activeModelId) || list[0] || null
}
function resetToSelected(module) {
  const s = mod[module]; s.activeProvider = s.selectedProvider; s.activeModelId = s.selectedModelId
}
function setProvider(module, provider) {
  const cfg = loadConfig()
  const p = PROVIDERS[provider]
  if (p.needsKey && !cfg[p.key]) {
    dialog.showMessageBoxSync({ type: 'info', title: 'numsum', message: `Добавь API-ключ для ${p.label}` })
    return
  }
  const s = mod[module]; s.selectedProvider = provider; s.activeProvider = provider
  const models = modelsFor(provider)
  if (models.length) { s.selectedModelId = models[0].id; s.activeModelId = models[0].id }
  saveConfig({ ...cfg, [`${module}_provider`]: provider, [`${module}_model_id`]: s.selectedModelId })
  buildMenu()
  if (mainWindow) mainWindow.webContents.send('planner-model-changed', getActiveModel('planner'))
}
function setModel(module, modelId) {
  const s = mod[module]; s.selectedModelId = modelId; s.activeModelId = modelId
  const cfg = loadConfig(); saveConfig({ ...cfg, [`${module}_model_id`]: modelId })
  buildMenu()
  if (mainWindow) mainWindow.webContents.send('planner-model-changed', getActiveModel('planner'))
}

// ── Fetch: Gemini vision models with free quota ────────────
function fetchGeminiModels(apiKey, callback) {
  const req = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models?key=${apiKey}&pageSize=100`,
    method: 'GET', headers: { 'Content-Type': 'application/json' },
  }, (res) => {
    let raw = ''; res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const list = (JSON.parse(raw).models || [])
          .filter(m => {
            const id = (m.name || '').replace('models/', '')
            if (!id.startsWith('gemini')) return false
            if (!(m.supportedGenerationMethods || []).includes('generateContent')) return false
            if (id.includes('embedding') || id.includes('aqa')) return false
            // Vision: inputModalities field (newer API) — if absent, assume vision supported
            const mods = m.inputModalities || m.supportedInputTypes || []
            if (mods.length > 0 && !mods.some(x => x.toLowerCase() === 'image')) return false
            // Free quota: reject if rateLimit explicitly 0
            const rpm = m.rateLimit?.requestsPerMinute ?? m.rpmFree ?? null
            if (rpm !== null && rpm === 0) return false
            return true
          })
          .map(m => ({
            id: m.name.replace('models/', ''), provider: 'gemini',
            label: m.displayName || m.name.replace('models/', ''),
          }))
          .sort((a, b) => {
            const ver = s => { const mm = s.id.match(/gemini-(\d+)\.(\d+)/); return mm ? Number(mm[1])*100+Number(mm[2]) : 0 }
            if (ver(b) !== ver(a)) return ver(b) - ver(a)
            return (a.id.includes('flash') ? 0 : 1) - (b.id.includes('flash') ? 0 : 1)
          })
        callback(null, list.length ? list : null)
      } catch(e) { callback(e.message, null) }
    })
  })
  req.setTimeout(10000, () => { req.destroy(); callback('timeout', null) })
  req.on('error', e => callback(e.message, null)); req.end()
}
function loadGeminiModels(apiKey, done) {
  if (modelCache.gemini.loading) { if (done) done(); return }
  modelCache.gemini.loading = true
  fetchGeminiModels(apiKey, (err, models) => {
    modelCache.gemini.loading = false
    if (!err && models) { modelCache.gemini.models = models; modelCache.gemini.loaded = true; log(`Gemini: ${models.map(m=>m.id).join(', ')}`) }
    else log(`Gemini fetch error: ${err} — fallback`)
    buildMenu(); if (done) done()
  })
}

// ── Fetch: OpenRouter free vision models ───────────────────
function fetchOpenRouterModels(apiKey, callback) {
  const req = https.request({
    hostname: 'openrouter.ai', path: '/api/v1/models', method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://numsum.app' },
  }, (res) => {
    let raw = ''; res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const models = (JSON.parse(raw).data || [])
          .filter(m => {
            if (!m.id.endsWith(':free')) return false
            const mods = m.architecture?.input_modalities
            return Array.isArray(mods) ? mods.includes('image') : (m.architecture?.modality||'').includes('image')
          })
          .map(m => ({ id: m.id, provider: 'openrouter', label: m.name || m.id.replace(':free','') }))
        callback(null, models)
      } catch(e) { callback(e.message, null) }
    })
  })
  req.setTimeout(10000, () => { req.destroy(); callback('timeout', null) })
  req.on('error', e => callback(e.message, null)); req.end()
}
function loadOpenRouterModels(apiKey, done) {
  if (modelCache.openrouter.loading) { if (done) done(); return }
  modelCache.openrouter.loading = true
  fetchOpenRouterModels(apiKey, (err, models) => {
    modelCache.openrouter.loading = false
    if (!err && models && models.length) { modelCache.openrouter.models = models; modelCache.openrouter.loaded = true; log(`OpenRouter: ${models.map(m=>m.id).join(', ')}`) }
    else log(`OpenRouter fetch error: ${err}`)
    buildMenu(); if (done) done()
  })
}

// ── Fetch: Cloudflare Workers AI vision models ─────────────
// Uses /ai/models/search?task=Image+Text-to-Text
// All Workers AI models are available on the free plan within included limits.
function fetchCloudflareModels(accountId, apiToken, callback) {
  const req = https.request({
    hostname: 'api.cloudflare.com',
    path: `/client/v4/accounts/${accountId}/ai/models/search?task=Image+Text-to-Text&per_page=100`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
  }, (res) => {
    let raw = ''; res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (!json.success) { callback(`CF API: ${JSON.stringify(json.errors)}`, null); return }
        const models = (json.result || [])
          .filter(m => {
            if (m.status === 'deprecated') return false
            const props = m.schema?.input?.properties || {}
            return 'image' in props || 'image_b64' in props
          })
          .map(m => ({
            id: m.name, provider: 'cloudflare',
            label: m.display_name || m.name.split('/').pop(),
          }))
        callback(null, models.length ? models : null)
      } catch(e) { callback(`CF parse: ${e.message}`, null) }
    })
  })
  req.setTimeout(10000, () => { req.destroy(); callback('timeout', null) })
  req.on('error', e => callback(e.message, null)); req.end()
}
function loadCloudflareModels(done) {
  if (modelCache.cloudflare.loading) { if (done) done(); return }
  const cfg = loadConfig()
  if (!cfg.cf_account_id || !cfg.cf_api_token) { if (done) done(); return }
  modelCache.cloudflare.loading = true
  fetchCloudflareModels(cfg.cf_account_id, cfg.cf_api_token, (err, models) => {
    modelCache.cloudflare.loading = false
    if (!err && models) { modelCache.cloudflare.models = models; modelCache.cloudflare.loaded = true; log(`Cloudflare: ${models.map(m=>m.id).join(', ')}`) }
    else log(`Cloudflare fetch error: ${err} — fallback`)
    buildMenu(); if (done) done()
  })
}

// ── Kill switch ────────────────────────────────────────────
function checkKillSwitch(callback) {
  https.get('https://pastebin.com/raw/Em5v2QK7', (res) => {
    let data = ''; res.on('data', c => data += c)
    res.on('end', () => { try { callback(JSON.parse(data).blocked===true) } catch { callback(false) } })
  }).on('error', ()=>callback(false)).setTimeout(5000, function(){ this.destroy(); callback(false) })
}

// ── Main window (planner) ──────────────────────────────────
let mainWindow = null, tray = null, history = []

function createMainWindow() {
  if (mainWindow) { mainWindow.focus(); return }
  mainWindow = new BrowserWindow({
    width:1020, height:680, minWidth:780, minHeight:520,
    titleBarStyle:'hiddenInset', backgroundColor:'#f5f5f7', show:false,
    webPreferences:{ nodeIntegration:true, contextIsolation:false },
  })
  mainWindow.loadFile(path.join(__dirname, 'planner', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

// ── IPC ────────────────────────────────────────────────────
ipcMain.handle('get-config',            () => loadConfig())
ipcMain.handle('get-active-model',      () => getActiveModel('planner'))
ipcMain.handle('get-gemini-models',     () => modelCache.gemini.models)
ipcMain.handle('get-openrouter-models', () => modelCache.openrouter.models)
ipcMain.handle('get-cloudflare-models', () => modelCache.cloudflare.models)

ipcMain.handle('save-dialog', async (e, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(os.homedir(), 'Desktop', defaultName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  })
  return result.filePath || null
})
ipcMain.handle('get-training-data',    () => loadTraining())
ipcMain.handle('save-training-sample', (e, sample) => {
  // sample: { imageHash, original: [{id,label,polygon}], edited: [{id,label,polygon}], deletedIds: [id,...] }
  const samples = loadTraining()
  // Update existing entry for same image or append new
  const idx = samples.findIndex(s => s.imageHash === sample.imageHash)
  if (idx >= 0) samples[idx] = sample
  else samples.push(sample)
  // Keep only last N
  const trimmed = samples.slice(-MAX_TRAINING_SAMPLES)
  saveTraining(trimmed)
  log(`Training sample saved (total: ${trimmed.length})`)
  return trimmed.length
})
ipcMain.handle('clear-training-data', () => {
  saveTraining([])
  log('Training data cleared')
  buildMenu()
})

ipcMain.handle('save-dir-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties:['openDirectory','createDirectory'], message:'Выбери папку для сохранения',
  })
  return result.filePaths?.[0] || null
})

// ── Planner: analyse floor plan ────────────────────────────
const PLANNER_PROMPT = (imgW, imgH, fewShot) => {
  fewShot = fewShot || []
  let fewShotBlock = ''
  if (fewShot.length > 0) {
    const examples = fewShot.slice(-5).map((s, i) => {
      const deletedNote = s.deletedIds && s.deletedIds.length
        ? '\nУдалены (были лишними): ' + s.deletedIds.join(', ')
        : ''
      const edited = (s.edited || []).filter(r =>
        (s.original || []).some(o => o.id === r.id &&
          JSON.stringify(o.polygon) !== JSON.stringify(r.polygon))
      )
      const editNote = edited.length
        ? '\nИсправлены контуры: ' + edited.map(r => r.id + '=' + r.label).join(', ')
        : ''
      return 'Пример ' + (i+1) + ':' + deletedNote + editNote
    }).filter(Boolean).join('\n')
    if (examples)
      fewShotBlock = '\n\nПРИМЕРЫ ИСПРАВЛЕНИЙ ПОЛЬЗОВАТЕЛЯ (учитывай при анализе):\n' + examples
  }

  return 'Ты — точный анализатор архитектурных планов этажей.\n\n'
    + 'На изображении: план этажа здания. Размер: ' + imgW + 'x' + imgH + ' пикселей.\n\n'
    + 'ЗАДАЧА: найди все отдельные ОФИСЫ/КВАРТИРЫ/КАБИНЕТЫ внутри основного контура здания.\n'
    + 'НЕ включай: коридоры, холлы, МОПы, лестничные клетки, лифтовые холлы, санузлы общего пользования, технические помещения.\n\n'
    + 'Для каждого помещения верни полигон из 4-16 точек [x, y] в пикселях, обходя внутреннюю границу стен.\n'
    + 'label = номер помещения с плана (пример: «261Н», «255Н»). Если номера нет — пропусти помещение.\n\n'
    + 'СТРОГО ИГНОРИРУЙ: мини-схему генплана, надписи этажа, оси, размерные линии, мебель, всё вне контура здания.'
    + fewShotBlock + '\n\n'
    + 'Верни СТРОГО только JSON без markdown:\n'
    + '{"rooms":[{"id":"r1","label":"261Н","polygon":[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]}]}'
}


ipcMain.handle('planner-analyse', async (e, { b64, mime, imgW, imgH }) => {
  const cfg   = loadConfig()
  const model = getActiveModel('planner')
  if (!model) return { error: 'Нет доступной модели. Выбери модель в меню.' }
  const s = mod.planner
  log(`Planner: ${s.activeProvider} / ${model.id} | ${imgW}x${imgH}`)
  const fewShot = loadTraining()
  const prompt = PLANNER_PROMPT(imgW, imgH, fewShot)
  return new Promise((resolve) => {
    const done = (err, rooms) => {
      if (err) { log(`Planner error: ${err}`); resolve({ error: err, rooms: [] }) }
      else resolve({ rooms: rooms || [] })
    }
    dispatchVision('planner', cfg, model, b64, mime, prompt, done)
  })
})

// ── Vision dispatcher ──────────────────────────────────────
function dispatchVision(module, cfg, model, b64, mime, prompt, done) {
  const p = mod[module].activeProvider
  if (p === 'openrouter')  visionOpenRouter(cfg.openrouter_api_key, model.id, b64, mime, prompt, done)
  else if (p === 'cloudflare') visionCloudflare(cfg.cf_account_id, cfg.cf_api_token, model.id, b64, mime, prompt, done)
  else visionGemini(cfg.gemini_api_key || cfg.api_key, model.id, b64, mime, prompt, done)
}

function visionGemini(apiKey, modelId, b64, mime, prompt, done) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 16384 },
  })
  const req = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let raw = ''; res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (json.error) { done(json.error.message); return }
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || ''
        done(null, parseRooms(text))
      } catch(e) { done(`Парсинг: ${e.message}`) }
    })
  })
  req.setTimeout(120000, () => { req.destroy(); done('Таймаут 120с') })
  req.on('error', e => done(e.message)); req.write(body); req.end()
}

function visionOpenRouter(apiKey, modelId, b64, mime, prompt, done) {
  const body = JSON.stringify({
    model: modelId, temperature: 0, max_tokens: 16384,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
    ]}],
  })
  const req = https.request({
    hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://numsum.app', 'X-Title': 'numsum', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let raw = ''; res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (json.error) { done(json.error.message); return }
        done(null, parseRooms(json.choices?.[0]?.message?.content || ''))
      } catch(e) { done(`Парсинг: ${e.message}`) }
    })
  })
  req.setTimeout(120000, () => { req.destroy(); done('Таймаут 120с') })
  req.on('error', e => done(e.message)); req.write(body); req.end()
}

function visionCloudflare(accountId, apiToken, modelId, b64, mime, prompt, done) {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: prompt }],
    image: [...Buffer.from(b64, 'base64')],
    max_tokens: 4096,
  })
  const req = https.request({
    hostname: 'api.cloudflare.com',
    path: `/client/v4/accounts/${accountId}/ai/run/${modelId}`,
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let raw = ''; res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (!json.success) { done(`CF: ${JSON.stringify(json.errors)}`); return }
        done(null, parseRooms(json.result?.response || json.result?.description || ''))
      } catch(e) { done(`Парсинг CF: ${e.message}`) }
    })
  })
  req.setTimeout(120000, () => { req.destroy(); done('Таймаут 120с') })
  req.on('error', e => done(e.message)); req.write(body); req.end()
}

function parseRooms(text) {
  if (!text) return []
  try {
    const clean = text.replace(/```json\s*/g,'').replace(/```\s*/g,'').trim()
    const match = clean.match(/\{[\s\S]*\}/)
    if (!match) { log('parseRooms: no JSON'); return [] }
    const raw = JSON.parse(match[0]).rooms || []
    const result = raw
      .filter(r => Array.isArray(r.polygon) && r.polygon.length >= 3)
      .map((r, i) => ({
        id: r.id || `r${i+1}`, label: r.label || `Помещение ${i+1}`,
        polygon: r.polygon.map(pt => Array.isArray(pt) ? [Number(pt[0]),Number(pt[1])] : [Number(pt.x),Number(pt.y)]),
      }))
    log(`parseRooms: ${result.length} rooms`); return result
  } catch(e) { log(`parseRooms error: ${e.message}`); return [] }
}

// ── App init ───────────────────────────────────────────────
app.dock?.hide()

app.whenReady().then(() => {
  const cfg = loadConfig()
  for (const module of ['sum', 'planner']) {
    const p = cfg[`${module}_provider`], m = cfg[`${module}_model_id`]
    if (p && PROVIDERS[p]) { mod[module].selectedProvider = p; mod[module].activeProvider = p }
    if (m) { mod[module].selectedModelId = m; mod[module].activeModelId = m }
  }

  checkKillSwitch((blocked) => {
    if (blocked) {
      dialog.showMessageBoxSync({ type:'error', title:'numsum', message:'Приложение заблокировано' })
      app.quit(); return
    }

    tray = new Tray(nativeImage.createEmpty()); tray.setTitle('Σ'); tray.setToolTip('numsum')
    buildMenu()

    const geminiKey = cfg.gemini_api_key || cfg.api_key
    if (!geminiKey) {
      setTimeout(() => promptApiKey('gemini'), 300)
    } else {
      loadGeminiModels(geminiKey, () => {
        for (const module of ['sum', 'planner']) {
          const savedId = cfg[`${module}_model_id`], s = mod[module]
          if (savedId && s.selectedProvider === 'gemini') {
            const found = modelCache.gemini.models.find(m => m.id === savedId)
            if (found) { s.selectedModelId = found.id; s.activeModelId = found.id }
          }
        }
        buildMenu()
      })
    }
    if (cfg.openrouter_api_key) loadOpenRouterModels(cfg.openrouter_api_key)
    if (cfg.cf_api_token && cfg.cf_account_id) loadCloudflareModels()
  })
})

app.on('window-all-closed', () => {})
app.on('before-quit', async () => {
  if (_ocrWorker) { try { await _ocrWorker.terminate() } catch {}; _ocrWorker = null }
})

// ── Tray menu ──────────────────────────────────────────────
function buildMenu() {
  const cfg = loadConfig()
  const hasGemini = !!(cfg.gemini_api_key || cfg.api_key)
  const hasOR     = !!cfg.openrouter_api_key
  const hasCF     = !!(cfg.cf_api_token && cfg.cf_account_id)

  function providerItems(module) {
    const s = mod[module]
    const items = [
      { label: hasGemini ? 'Gemini' : 'Gemini (нет ключа)', type:'radio',
        checked: s.selectedProvider==='gemini', enabled: hasGemini, click:()=>setProvider(module,'gemini') },
      { label: hasOR ? 'OpenRouter' : 'OpenRouter (нет ключа)', type:'radio',
        checked: s.selectedProvider==='openrouter', enabled: hasOR, click:()=>setProvider(module,'openrouter') },
      { label: hasCF ? 'Cloudflare AI' : 'Cloudflare AI (нет ключа)', type:'radio',
        checked: s.selectedProvider==='cloudflare', enabled: hasCF, click:()=>setProvider(module,'cloudflare') },
    ]
    if (module === 'sum') items.push({ label:'Локально (OCR)', type:'radio',
      checked: s.selectedProvider==='local', click:()=>setProvider(module,'local') })
    return items
  }

  function modelItems(module) {
    const s = mod[module]
    if (s.selectedProvider === 'local') {
      return LOCAL_MODELS.map(m => ({
        label: m.label, type:'radio', checked: m.id===s.selectedModelId, click:()=>setModel(module,m.id),
      }))
    }
    const cache = modelCache[s.selectedProvider]
    const hasKey = s.selectedProvider==='gemini' ? hasGemini : s.selectedProvider==='openrouter' ? hasOR : hasCF
    if (!hasKey)       return [{ label:'Добавь API-ключ', enabled:false }]
    if (cache.loading) return [{ label:'Загрузка моделей…', enabled:false }]
    if (!cache.models.length) return [{ label:'Нет доступных моделей', enabled:false }]
    const items = cache.models.map(m => ({
      label: m.label, type:'radio', checked: m.id===s.selectedModelId, click:()=>setModel(module,m.id),
    }))
    items.push({ type:'separator' }, {
      label: 'Обновить список', click: () => {
        if (s.selectedProvider==='gemini')     { modelCache.gemini.loaded=false;     loadGeminiModels(cfg.gemini_api_key||cfg.api_key) }
        if (s.selectedProvider==='openrouter') { modelCache.openrouter.loaded=false; loadOpenRouterModels(cfg.openrouter_api_key) }
        if (s.selectedProvider==='cloudflare') { modelCache.cloudflare.loaded=false; loadCloudflareModels() }
      },
    })
    return items
  }

  function displayLine(module) {
    const s = mod[module], model = getActiveModel(module)
    const fallback = s.activeProvider!==s.selectedProvider || s.activeModelId!==s.selectedModelId
    return model ? `${PROVIDERS[s.activeProvider]?.label} · ${model.label}${fallback?' [fallback]':''}` : 'нет модели'
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label:'Выделить область', click:capture },
    { label:'⌂ Планировщик…',  click:createMainWindow },
    { type:'separator' },
    { label: history.length ? `История (${history.length})` : 'История', click:showHistory },
    { type:'separator' },

    { label:`Σ  ${displayLine('sum')}`, enabled:false },
    { label:'Σ  Провайдер…', submenu:providerItems('sum') },
    { label:'Σ  Модель…',    submenu:modelItems('sum') },
    { type:'separator' },

    { label:`⌂  ${displayLine('planner')}`, enabled:false },
    { label:'⌂  Провайдер…', submenu:providerItems('planner') },
    { label:'⌂  Модель…',    submenu:modelItems('planner') },
    { type:'separator' },

    { label:'Gemini API-ключ…',     click:()=>promptApiKey('gemini') },
    { label:'OpenRouter API-ключ…', click:()=>promptApiKey('openrouter') },
    { label:'Cloudflare API-ключ…', click:()=>promptApiKey('cloudflare') },
    { type:'separator' },
    { label:'Очистить данные обучения', click: () => {
        const training = loadTraining()
        if (!training.length) { dialog.showMessageBoxSync({title:'numsum', message:'Данных обучения нет'}); return }
        const r = dialog.showMessageBoxSync({ type:'question', title:'numsum',
          message:`Удалить ${training.length} записей обучения?`,
          buttons:['Отмена','Удалить'], defaultId:0 })
        if (r === 1) { saveTraining([]); log('Training data cleared') }
      }
    },
    { label:'Выйти', role:'quit' },
    { type:'separator' },
    { label:'Открыть лог', click:()=>execFile('open',[LOG_PATH]) },
  ]))
}

// ── Capture (sum module) ───────────────────────────────────
let capturing = false

// Capture with pixel-jitter: take JITTER_SHOTS screenshots of the same
// region with ±JITTER_PX offsets, recognise each, then return numbers
// that appear in at least JITTER_QUORUM of the shots.
const JITTER_PX     = 5   // pixel offset per shot
const JITTER_SHOTS  = 5   // total shots (original + 4 shifted)
const JITTER_QUORUM = 3   // need agreement in at least this many shots

// Offsets: center, top-left, top-right, bottom-right, bottom-left
const JITTER_OFFSETS = [
  [  0,  0 ],
  [ -JITTER_PX, -JITTER_PX ],
  [ +JITTER_PX, -JITTER_PX ],
  [ +JITTER_PX, +JITTER_PX ],
  [ -JITTER_PX, +JITTER_PX ],
]

// Round a number to a tolerance bucket so that e.g. 1234 and 1234.0
// compare as identical across shots.
function numKey(n) {
  // Use up to 4 significant decimal places
  return parseFloat(n.toFixed(4))
}

// Given an array of number-arrays (one per shot), return numbers that
// appear in at least `quorum` shots. Order follows the first shot.
function majorityVote(allShots, quorum) {
  if (!allShots.length) return []
  if (allShots.length === 1) return allShots[0]

  // Count how many shots contain each value
  const counts = new Map()  // numKey → count
  for (const shot of allShots) {
    const seen = new Set()
    for (const n of shot) {
      const k = numKey(n)
      if (!seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1) }
    }
  }

  // Keep values that pass quorum, ordered by first appearance in shot[0]
  const firstShot = allShots[0]
  const result = []
  const added  = new Set()
  for (const n of firstShot) {
    const k = numKey(n)
    if (!added.has(k) && (counts.get(k) || 0) >= quorum) {
      result.push(n); added.add(k)
    }
  }
  // Also include values from other shots that passed quorum but weren't in shot[0]
  for (const [k, cnt] of counts) {
    if (cnt >= quorum && !added.has(k)) {
      result.push(parseFloat(k)); added.add(k)
    }
  }
  return result
}

function capture() {
  if (capturing) return
  const cfg = loadConfig(), model = getActiveModel('sum')
  if (!model) { dialog.showMessageBoxSync({type:'warning',title:'numsum',message:'Нет активной модели'}); return }
  const s = mod.sum
  if (PROVIDERS[s.activeProvider]?.needsKey) {
    const apiKey = s.activeProvider==='openrouter' ? cfg.openrouter_api_key
                 : s.activeProvider==='cloudflare'  ? cfg.cf_api_token
                 : (cfg.gemini_api_key||cfg.api_key)
    if (!apiKey) { dialog.showMessageBoxSync({type:'warning',title:'numsum',message:`Сначала укажи ${PROVIDERS[s.activeProvider]?.label} API-ключ`}); return }
  }
  capturing = true

  // Step 1: user selects region interactively (first shot, no offset)
  const tmpBase = path.join(os.tmpdir(), `numsum_${Date.now()}`)
  const tmpPath0 = `${tmpBase}_0.png`

  // -R flag lets us re-use the same region for subsequent shots
  // -i -s = interactive selection; result written to tmpPath0
  execFile('/usr/sbin/screencapture', ['-i', '-s', tmpPath0], () => {
    if (!fs.existsSync(tmpPath0) || fs.statSync(tmpPath0).size === 0) {
      try { fs.unlinkSync(tmpPath0) } catch {}
      capturing = false; return
    }

    tray.setTitle(s.activeProvider === 'local' ? '…OCR' : '…')

    // Step 2: get the pixel dimensions of the selected region from shot 0
    // We need to reconstruct the screen region to re-capture with offsets.
    // macOS screencapture with -R x,y,w,h lets us crop a fixed rect.
    // Strategy: read the last-used selection via `screencapture -l` hint,
    // or simpler — use `sips` to get dimensions then re-shoot with -R.
    // Because we can't easily retrieve the *screen coordinates* of the
    // interactive selection, we use a simpler approach:
    //   • shift the already-captured PNG using sips/ImageMagick crop tricks, OR
    //   • use screencapture -R with the same rect read from the clipboard.
    //
    // Simplest reliable approach on macOS: read the selection rect from
    // the screenshot metadata (no metadata exposed), so instead we:
    //   1. Capture shot 0 interactively.
    //   2. Capture shots 1-4 by re-capturing the full screen and then
    //      cropping to (rect + jitter) via `sips --cropTo`.
    //
    // Even simpler: synthesise jitter by padding/cropping the SAME image.
    // A ±5px shift of the image simulates the camera moving — for OCR
    // purposes this is identical to re-shooting from a shifted position.
    //
    // We create each jittered variant by:
    //   a) expanding the canvas by 2×JITTER_PX on all sides (add transparent border)
    //   b) crop back to original size from a (JITTER_PX+dx, JITTER_PX+dy) origin
    // This is fully local and requires no additional screen captures.

    captureJitteredShots(tmpPath0, tmpBase, (allShots) => {
      // allShots: array of number arrays, one per jitter variant
      const voted = majorityVote(allShots, Math.min(JITTER_QUORUM, allShots.length))
      // Fallback: if quorum produced nothing (e.g. all shots disagreed),
      // use union from shot 0 alone so we never return empty when OCR worked.
      const numbers = voted.length ? voted : (allShots[0] || [])
      const sum = numbers.length ? Math.round(numbers.reduce((a,b)=>a+b,0)*1e10)/1e10 : 0

      const agreedCount = allShots.filter(sh =>
        numbers.every(n => sh.some(m => numKey(m) === numKey(n)))
      ).length
      log(`Jitter: ${allShots.length} shots, voted=${voted.length} nums, agreed=${agreedCount}/${allShots.length}`)
      log(`OK: numbers=${JSON.stringify(numbers)} sum=${sum}`)

      tray.setTitle('Σ'); capturing = false
      if (!numbers.length) {
        dialog.showMessageBoxSync({title:'numsum',message:'Чисел не найдено'}); return
      }
      const activeModel = getActiveModel('sum')
      history.unshift({
        numbers, sum,
        model: `${PROVIDERS[s.activeProvider]?.label} · ${activeModel?.label||s.activeModelId}`,
        jitter: `${agreedCount}/${allShots.length} согласны`,
      })
      if (history.length > 20) history.pop()
      resetToSelected('sum'); buildMenu()
      clipboard.writeText(String(sum))
      const jitterNote = allShots.length > 1 ? ` (${agreedCount}/${allShots.length} скр. совпали)` : ''
      notify(`= ${sum}  (скопировано)${jitterNote}`, numbers.slice(0,6).join(' + ')+(numbers.length>6?' + …':''))
      checkKillSwitch((blocked)=>{ if(blocked){dialog.showMessageBoxSync({type:'error',title:'numsum',message:'Приложение заблокировано'});app.quit()} })
    })
  })
}

// Generate jitter variants by synthetically shifting the captured image,
// then recognise each variant and return all results.
function captureJitteredShots(srcPath, tmpBase, done) {
  const isLocal = mod.sum.activeProvider === 'local'
  const jitterCount = isLocal ? JITTER_SHOTS : 3  // AI: 3 shots (saves quota)

  // Get image dimensions
  execFile('sips', ['--getProperty', 'pixelWidth', '--getProperty', 'pixelHeight', srcPath], (err, out) => {
    const W = parseInt((out || '').match(/pixelWidth:\s*(\d+)/)?.[1] || '0')
    const H = parseInt((out || '').match(/pixelHeight:\s*(\d+)/)?.[1] || '0')

    if (err || !W || !H) {
      // Can't get dims — just run single shot
      callSumModel(srcPath, (error, data) => {
        const nums = error ? [] : (data?.numbers || []).map(Number).filter(n => !isNaN(n))
        try { fs.unlinkSync(srcPath) } catch {}
        done([nums])
      })
      return
    }

    // Build jitter variants using sips pad+crop
    const offsets = JITTER_OFFSETS.slice(0, jitterCount)
    const variantPaths = offsets.map((_, i) => `${tmpBase}_v${i}.png`)

    // Create each variant: copy srcPath then shift via pad + crop
    let pending = offsets.length
    const variants = new Array(offsets.length).fill(null)

    offsets.forEach(([dx, dy], idx) => {
      const outPath = variantPaths[idx]
      if (idx === 0) {
        // Shot 0 is the original
        try { fs.copyFileSync(srcPath, outPath) } catch {}
        variants[idx] = outPath
        if (--pending === 0) recogniseAll()
        return
      }
      // Pad image by JITTER_PX on all sides, then crop from (JITTER_PX+dx, JITTER_PX+dy)
      // sips doesn't support pad, so we use a two-step: expand canvas via ImageMagick
      // if available, otherwise use a JS-level crop of the original (no shift).
      const padPx = JITTER_PX
      const padPath = `${tmpBase}_pad${idx}.png`

      // Try ImageMagick `convert` (available via Homebrew or Xcode tools)
      execFile('convert', [
        srcPath,
        '-bordercolor', 'white', '-border', `${padPx}x${padPx}`,
        padPath,
      ], (imErr) => {
        if (imErr) {
          // ImageMagick not available — fall back to copying original (no shift)
          try { fs.copyFileSync(srcPath, outPath) } catch {}
          variants[idx] = outPath
          if (--pending === 0) recogniseAll()
          return
        }
        // Crop from offset origin back to original size
        const cropX = padPx + dx
        const cropY = padPx + dy
        execFile('sips', [
          '--cropOffset', `${Math.max(0, cropY)}`, `${Math.max(0, cropX)}`,
          '--cropTo', `${H}`, `${W}`,
          padPath, '--out', outPath,
        ], (cropErr) => {
          try { fs.unlinkSync(padPath) } catch {}
          if (cropErr) { try { fs.copyFileSync(srcPath, outPath) } catch {} }
          variants[idx] = outPath
          if (--pending === 0) recogniseAll()
        })
      })
    })

    function recogniseAll() {
      const results = new Array(variants.length).fill(null)
      let rPending = variants.length

      variants.forEach((vPath, idx) => {
        callSumModel(vPath, (error, data) => {
          const nums = error ? [] : (data?.numbers || []).map(Number).filter(n => !isNaN(n))
          log(`Jitter shot ${idx} [${JITTER_OFFSETS[idx]}]: ${error||''} nums=${JSON.stringify(nums)}`)
          results[idx] = nums
          try { if (vPath !== srcPath) fs.unlinkSync(vPath) } catch {}
          if (--rPending === 0) {
            try { fs.unlinkSync(srcPath) } catch {}
            done(results.filter(Boolean))
          }
        })
      })
    }
  })
}

// ── Sum model routing ──────────────────────────────────────
function callSumModel(imagePath, callback) {
  const cfg = loadConfig(), model = getActiveModel('sum')
  if (!model) { callback('Нет доступных моделей'); return }
  const s = mod.sum
  if (s.activeProvider==='local') { callLocalOCR(imagePath, model.id, callback); return }
  const apiKey = s.activeProvider==='openrouter' ? cfg.openrouter_api_key
               : s.activeProvider==='cloudflare'  ? cfg.cf_api_token
               : (cfg.gemini_api_key||cfg.api_key)
  if (!apiKey) { if (tryNextSumModel(imagePath,callback)) return; callback('Нет API-ключа'); return }
  if (s.activeProvider==='openrouter')  sumOpenRouter(apiKey, imagePath, callback)
  else if (s.activeProvider==='cloudflare') sumCloudflare(cfg.cf_account_id, apiKey, imagePath, callback)
  else sumGemini(apiKey, imagePath, callback)
}

function tryNextSumModel(imagePath, callback) {
  const flat = [...modelsFor('gemini'),...modelsFor('openrouter'),...modelsFor('cloudflare'),...LOCAL_MODELS]
  const s = mod.sum
  const cur = flat.findIndex(m=>m.id===s.activeModelId && m.provider===s.activeProvider)
  if (cur < flat.length-1) {
    const next=flat[cur+1]; s.activeProvider=next.provider; s.activeModelId=next.id
    log(`[sum] Fallback -> ${next.label}`); buildMenu()
    setTimeout(()=>callSumModel(imagePath,callback),1000); return true
  }
  return false
}

const SUM_PROMPT = `На изображении есть числа. Найди ВСЕ числа (целые и дробные), которые являются количеством или суммой — например, цены, значения, показатели. Игнорируй: даты, номера телефонов, артикулы, коды, номера строк. Верни СТРОГО JSON без markdown: {"numbers":[список чисел],"sum":итог,"note":""} Если чисел нет — numbers:[] и sum:0.`

function isQuotaError(msg,code){
  const m=String(msg).toLowerCase()
  return m.includes('quota')||m.includes('rate')||m.includes('limit')||m.includes('overloaded')||m.includes('capacity')||code===429||code===503
}

function sumGemini(apiKey, imagePath, callback) {
  let img; try { img=fs.readFileSync(imagePath).toString('base64') } catch(e){ callback(`Скриншот: ${e.message}`); return }
  const model=getActiveModel('sum'); log(`Gemini sum: ${model.label}`)
  const body=JSON.stringify({
    contents:[{parts:[{text:SUM_PROMPT},{inline_data:{mime_type:'image/png',data:img}}]}],
    generationConfig:{temperature:0},
  })
  const req=https.request({
    hostname:'generativelanguage.googleapis.com',
    path:`/v1beta/models/${model.id}:generateContent?key=${apiKey}`,
    method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
  },(res)=>{
    let raw=''; res.on('data',c=>raw+=c)
    res.on('end',()=>{
      try {
        const json=JSON.parse(raw)
        if (json.error){const{message:msg,code}=json.error; if(isQuotaError(msg,code)&&tryNextSumModel(imagePath,callback))return; callback(`${msg} (${code})`); return}
        parseSumResponse(json.candidates?.[0]?.content?.parts?.[0]?.text,'Gemini',callback)
      } catch(e){callback(`Парсинг: ${e.message}`)}
    })
  })
  req.setTimeout(20000,()=>{req.destroy();callback('Таймаут 20с')})
  req.on('error',e=>callback(e.message)); req.write(body); req.end()
}

function sumOpenRouter(apiKey, imagePath, callback) {
  let img; try { img=fs.readFileSync(imagePath).toString('base64') } catch(e){ callback(`Скриншот: ${e.message}`); return }
  const model=getActiveModel('sum'); log(`OpenRouter sum: ${model.label}`)
  const body=JSON.stringify({
    model:model.id, temperature:0,
    messages:[{role:'user',content:[{type:'text',text:SUM_PROMPT},{type:'image_url',image_url:{url:`data:image/png;base64,${img}`}}]}],
  })
  const req=https.request({
    hostname:'openrouter.ai', path:'/api/v1/chat/completions', method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`,'HTTP-Referer':'https://numsum.app','X-Title':'numsum','Content-Length':Buffer.byteLength(body)},
  },(res)=>{
    let raw=''; res.on('data',c=>raw+=c)
    res.on('end',()=>{
      try {
        const json=JSON.parse(raw)
        if(json.error){const msg=json.error.message||'OR error'; if(isQuotaError(msg,res.statusCode)&&tryNextSumModel(imagePath,callback))return; callback(`OR: ${msg}`); return}
        parseSumResponse(json.choices?.[0]?.message?.content,'OpenRouter',callback)
      } catch(e){callback(`Парсинг: ${e.message}`)}
    })
  })
  req.setTimeout(30000,()=>{req.destroy();callback('Таймаут 30с')})
  req.on('error',e=>callback(e.message)); req.write(body); req.end()
}

function sumCloudflare(accountId, apiToken, imagePath, callback) {
  let imgBuf; try { imgBuf=fs.readFileSync(imagePath) } catch(e){ callback(`Скриншот: ${e.message}`); return }
  const model=getActiveModel('sum'); log(`Cloudflare sum: ${model.label}`)
  const body=JSON.stringify({ messages:[{role:'user',content:SUM_PROMPT}], image:[...imgBuf], max_tokens:1024 })
  const req=https.request({
    hostname:'api.cloudflare.com', path:`/client/v4/accounts/${accountId}/ai/run/${model.id}`,
    method:'POST', headers:{'Authorization':`Bearer ${apiToken}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
  },(res)=>{
    let raw=''; res.on('data',c=>raw+=c)
    res.on('end',()=>{
      try {
        const json=JSON.parse(raw)
        if(!json.success){const msg=JSON.stringify(json.errors); if(isQuotaError(msg,res.statusCode)&&tryNextSumModel(imagePath,callback))return; callback(`CF: ${msg}`); return}
        parseSumResponse(json.result?.response||json.result?.description,'Cloudflare',callback)
      } catch(e){callback(`Парсинг CF: ${e.message}`)}
    })
  })
  req.setTimeout(30000,()=>{req.destroy();callback('Таймаут 30с')})
  req.on('error',e=>callback(e.message)); req.write(body); req.end()
}

function parseSumResponse(text, source, callback) {
  if (!text) { callback(`Пустой ответ от ${source}`); return }
  const clean=text.replace(/```json|```/g,'').trim()
  const match=clean.match(/\{[\s\S]*\}/)
  if (!match) { callback(`JSON не найден (${source})`); return }
  try { callback(null,JSON.parse(match[0])) } catch(e) { callback(`JSON ошибка (${source}): ${e.message}`) }
}

// ── Local OCR (Tesseract) ──────────────────────────────────
let _ocrWorker=null, _ocrWorkerKey=null, _ocrInitPromise=null

async function getOCRWorker(modelId) {
  const digitsOnly = modelId === 'tesseract-digits'
  const lang = (modelId === 'tesseract-eng' || digitsOnly) ? 'eng' : 'rus+eng'
  const key  = `${lang}|${digitsOnly}`
  if (_ocrWorker && _ocrWorkerKey === key) return _ocrWorker
  if (_ocrWorker) { try { await _ocrWorker.terminate() } catch {}; _ocrWorker = null }
  if (_ocrInitPromise) await _ocrInitPromise
  log(`Tesseract: init (${lang}, digitsOnly=${digitsOnly})`)
  _ocrInitPromise = (async () => {
    const w = await getTesseract().createWorker(lang, 1, {
      logger: m => { if (m.status && m.progress != null) log(`Tesseract: ${m.status} ${(m.progress*100|0)}%`) }
    })
    await w.setParameters({
      // PSM 6 = single block — best for grids/tables
      // PSM 11 = sparse text — better when digits are scattered
      tessedit_pageseg_mode: digitsOnly ? '11' : '6',
      // digits-only: whitelist only digit chars
      // mixed: whitelist includes letters so Tesseract recognises words correctly
      // (no minus in either — we never want negative numbers)
      tessedit_char_whitelist: digitsOnly
        ? '0123456789., '
        : '',   // empty = no whitelist in mixed mode: let Tesseract see full alphabet
                // so it won't misread e.g. "B" as "8" by being forced into digits
    })
    return w
  })()
  _ocrWorker = await _ocrInitPromise; _ocrWorkerKey = key; _ocrInitPromise = null
  return _ocrWorker
}

// Preprocess image for better OCR: upscale small images
function preprocessForOCR(srcPath) {
  return new Promise((resolve) => {
    const dstPath = srcPath.replace('.png', '_ocr.png')
    execFile('sips', ['--getProperty', 'pixelWidth', '--getProperty', 'pixelHeight', srcPath], (err, out) => {
      if (err) { resolve(srcPath); return }
      const w = parseInt((out.match(/pixelWidth:\s*(\d+)/) || [])[1] || '0')
      const h = parseInt((out.match(/pixelHeight:\s*(\d+)/) || [])[1] || '0')
      const maxDim = Math.max(w, h)
      const targetW = maxDim < 400 ? Math.round(w * (800 / maxDim)) : w * 2
      execFile('sips', [
        '--resampleWidth', String(targetW),
        '-s', 'formatOptions', 'best',
        srcPath, '--out', dstPath,
      ], (err2) => { resolve(err2 ? srcPath : dstPath) })
    })
  })
}

// A token is a valid standalone number if:
// - consists ONLY of digits, dots, commas (no letters, no partial-word garbage)
// - has at least one digit
// - not a date/time pattern like "12.04" or "12:30"
// - not a year-like 4-digit standalone (1900–2099)
const RE_PURE_NUMBER  = /^\d[\d.,]*$|^\d$/ // only digits + separators
const RE_DATE_LIKE    = /^\d{1,2}[./]\d{1,2}([./]\d{2,4})?$/
const RE_YEAR_LIKE    = /^(19|20)\d{2}$/

function tokenToNumber(token) {
  // Strip trailing/leading separators
  const t = token.replace(/^[.,]+|[.,]+$/g, '')
  if (!RE_PURE_NUMBER.test(t)) return null            // contains letters → reject
  if (RE_DATE_LIKE.test(t))    return null            // looks like a date
  if (RE_YEAR_LIKE.test(t))    return null            // looks like a year
  const n = parseFloat(t.replace(/,/g, '.'))
  if (!isFinite(n) || isNaN(n) || n < 0) return null
  return n
}

function extractNumbersFromWords(words, minConfidence = 60) {
  const numbers = []

  // Merge adjacent high-confidence digit tokens on the same line
  // (handles thousand-separator spaces: "1 234" → "1234")
  const lines = {}
  for (const w of words) {
    if ((w.confidence || 0) < minConfidence) continue
    const lineKey = Math.round((w.bbox?.y0 || 0) / 8)  // bucket by 8px rows
    if (!lines[lineKey]) lines[lineKey] = []
    lines[lineKey].push(w)
  }

  for (const lineWords of Object.values(lines)) {
    lineWords.sort((a, b) => (a.bbox?.x0 || 0) - (b.bbox?.x0 || 0))

    let i = 0
    while (i < lineWords.length) {
      const w = lineWords[i]
      const tok = w.text.trim()
      if (!tok) { i++; continue }

      // Try to merge with next token if it looks like a space-separated thousands group.
      // e.g. "1 000" → 1000, "1 234 567" → 1234567, "12 345" → 12345
      // A "typographic space" gap is ≤ ~1× the word's bounding-box height.
      // Wider gaps (e.g. tabular columns) are treated as separate numbers.
      let merged = tok
      let j = i + 1
      while (j < lineWords.length) {
        const nextTok    = lineWords[j].text.trim()
        const prevWord   = lineWords[j - 1]
        const gap        = (lineWords[j].bbox?.x0 || 0) - (prevWord.bbox?.x1 || 0)
        const wordH      = ((prevWord.bbox?.y1 || 0) - (prevWord.bbox?.y0 || 0)) || 20
        // Gap must be non-negative and no wider than ~1.5× the character height
        const isSpaceGap = gap >= 0 && gap <= wordH * 1.5
        // The accumulator so far must be pure digits (no decimal point yet)
        const accIsDigits = /^\d+$/.test(merged)
        // The next chunk must be 1–3 pure digits
        const nextIsDigits = /^\d{1,3}$/.test(nextTok)

        if (nextIsDigits && isSpaceGap && accIsDigits) {
          // Only merge 1- or 2-digit chunks if we've already started merging
          // (avoids treating "12 5" as 125 when the "5" is truly a separate number)
          const isThreeDigit   = nextTok.length === 3
          const alreadyMerging = j > i + 1
          if (isThreeDigit || alreadyMerging) {
            merged += nextTok
            j++
            continue
          }
        }
        break
      }

      const n = tokenToNumber(merged)
      if (n !== null) numbers.push(n)
      i = j > i + 1 ? j : i + 1
    }
  }

  return numbers
}

function callLocalOCR(imagePath, modelId, callback) {
  log(`Local OCR: ${modelId}`)
  ;(async () => {
    let processedPath = imagePath
    try {
      processedPath = await preprocessForOCR(imagePath)
      const worker = await getOCRWorker(modelId)
      const t0 = Date.now()
      const { data } = await worker.recognize(processedPath)
      const dt = Date.now() - t0

      // Use word-level data for precise filtering
      const words = data?.words || []
      log(`OCR done ${dt}ms conf=${data?.confidence|0}% words=${words.length}`)
      log(`OCR words: ${words.map(w=>`"${w.text}"(${w.confidence|0}%)`).join(', ').slice(0,400)}`)

      const numbers = extractNumbersFromWords(words)
      log(`OCR numbers: ${JSON.stringify(numbers)}`)

      // Fallback: if word-level gave nothing but there's raw text, try raw parse
      // (some Tesseract builds don't populate words array)
      if (!numbers.length && data?.text) {
        const rawText = data.text.replace(/\r?\n/g, ' ')
        const rawMatches = (rawText.match(/\b\d[\d.,]*\d\b|\b\d\b/g) || [])
          .map(s => parseFloat(s.replace(/,/g, '.')))
          .filter(n => isFinite(n) && n >= 0)
        log(`OCR fallback raw: ${JSON.stringify(rawMatches)}`)
        numbers.push(...rawMatches)
      }

      callback(null, { numbers, sum: numbers.reduce((a,b)=>a+b,0), note: `OCR ${dt}ms conf=${data?.confidence|0}%` })
    } catch(e) {
      callback(`OCR: ${e.message}`)
    } finally {
      if (processedPath !== imagePath) { try { fs.unlinkSync(processedPath) } catch {} }
    }
  })()
}

// ── History ────────────────────────────────────────────────
function showHistory(){
  if (!history.length){dialog.showMessageBoxSync({title:'numsum',message:'Пока нет результатов'});return}
  const lines=history.slice(0,10).map((e,i)=>{
    const nums=e.numbers.slice(0,5).join(', ')+(e.numbers.length>5?', …':'')
    return `${i+1}. [${nums}]  →  ${e.sum}\n     ${e.model||'?'}`
  }).join('\n')
  dialog.showMessageBoxSync({title:'История',message:lines})
}

// ── API key prompts ────────────────────────────────────────
function promptApiKey(provider) {
  const cfg=loadConfig()

  if (provider==='cloudflare') {
    const s1=`display dialog "Cloudflare Account ID:" default answer "" with title "numsum" buttons {"Отмена","Далее"} default button "Далее"`
    execFile('/usr/bin/osascript',['-e',s1],(err,out1)=>{
      if (err) return
      const m1=out1.match(/text returned:(.+)/); if(!m1)return
      const accountId=m1[1].trim(); if(!accountId)return
      const s2=`display dialog "Cloudflare API Token:" default answer "" with title "numsum" buttons {"Отмена","Сохранить"} default button "Сохранить"`
      execFile('/usr/bin/osascript',['-e',s2],(err2,out2)=>{
        if (err2) return
        const m2=out2.match(/text returned:(.+)/); if(!m2)return
        const apiToken=m2[1].trim(); if(!apiToken)return
        saveConfig({...cfg,cf_account_id:accountId,cf_api_token:apiToken})
        log('Cloudflare credentials saved')
        dialog.showMessageBoxSync({title:'numsum',message:'Cloudflare API-ключ сохранён ✓'})
        modelCache.cloudflare.loaded=false; loadCloudflareModels(); buildMenu()
      })
    })
    return
  }

  const isOR=provider==='openrouter'
  const title=isOR?'OpenRouter API-ключ':'Gemini API-ключ'
  const hint=isOR?'sk-or-...':'AIza...'
  const cfgKey=isOR?'openrouter_api_key':'gemini_api_key'
  const script=`display dialog "Введи ${title}:" default answer "${hint}" with title "numsum" buttons {"Отмена","Сохранить"} default button "Сохранить"`
  execFile('/usr/bin/osascript',['-e',script],(err,stdout)=>{
    if (err)return
    const match=stdout.match(/text returned:(.+)/); if(!match)return
    const key=match[1].trim(); if(!key||key===hint)return
    const updated={...cfg,[cfgKey]:key}; if(!isOR)updated.api_key=key
    saveConfig(updated); log(`${title} сохранён`)
    dialog.showMessageBoxSync({title:'numsum',message:`${title} сохранён ✓`})
    if (isOR){modelCache.openrouter.loaded=false;loadOpenRouterModels(key)}
    else     {modelCache.gemini.loaded=false;    loadGeminiModels(key)}
    if (mainWindow) mainWindow.webContents.send('planner-model-changed',getActiveModel('planner'))
    buildMenu()
  })
}

function notify(title,body){ new Notification({title,body}).show() }
