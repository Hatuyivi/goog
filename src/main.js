const { app, Menu, Tray, dialog, clipboard, Notification, nativeImage, BrowserWindow, ipcMain, shell } = require('electron')
const { execFile } = require('child_process')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Tesseract loaded lazily — heavy first init (downloads language data)
let _tesseract = null
function getTesseract() {
  if (!_tesseract) _tesseract = require('tesseract.js')
  return _tesseract
}

const CONFIG_PATH = path.join(os.homedir(), '.numsum_config.json')
const LOG_PATH    = path.join(os.homedir(), '.numsum_log.txt')

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

// ── Providers & Models ────────────────────────────────────
const PROVIDERS = {
  gemini:     { label: 'Gemini',     key: 'gemini_api_key',     needsKey: true  },
  openrouter: { label: 'OpenRouter', key: 'openrouter_api_key', needsKey: true  },
  local:      { label: 'Локально (OCR)', key: null,             needsKey: false },
}

// Local OCR pseudo-models — represent recognition mode + language combo.
const LOCAL_MODELS = [
  { id: 'tesseract-rus-eng', provider: 'local', label: 'Tesseract · Рус + Eng' },
  { id: 'tesseract-eng',     provider: 'local', label: 'Tesseract · Eng' },
  { id: 'tesseract-digits',  provider: 'local', label: 'Tesseract · только цифры' },
]
const GEMINI_MODELS_FALLBACK = [
  { id: 'gemini-2.0-flash',      provider: 'gemini', label: 'Gemini 2.0 Flash' },
  { id: 'gemini-2.0-flash-lite', provider: 'gemini', label: 'Gemini 2.0 Flash Lite' },
  { id: 'gemini-1.5-flash',      provider: 'gemini', label: 'Gemini 1.5 Flash' },
]
let geminiModels     = [...GEMINI_MODELS_FALLBACK]
let geminiLoaded     = false
let openrouterModels = []
let openrouterLoaded = false

// ── Gemini models (dynamic) ────────────────────────────────
function fetchGeminiModels(apiKey, callback) {
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models?key=${apiKey}&pageSize=100`,
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  }
  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const list = (JSON.parse(raw).models || [])
          .filter(m => {
            const id = (m.name || '').replace('models/', '')
            if (!id.startsWith('gemini')) return false
            const methods = m.supportedGenerationMethods || []
            if (!methods.includes('generateContent')) return false
            if (id.includes('embedding') || id.includes('aqa')) return false
            // Оставляем только модели с ненулевым бесплатным лимитом
            const rpm = m.rateLimit?.requestsPerMinute ?? m.rpmFree ?? null
            // Если API не вернул лимиты — оставляем (поле может отсутствовать)
            // Если вернул явный 0 — убираем
            if (rpm !== null && rpm === 0) return false
            return true
          })
          .map(m => {
            const id = m.name.replace('models/', '')
            const label = (m.displayName || id).replace('models/', '')
            return { id, provider: 'gemini', label }
          })
          .sort((a, b) => {
            const ver = s => {
              const mm = s.id.match(/gemini-(\d+)\.(\d+)/)
              return mm ? Number(mm[1]) * 100 + Number(mm[2]) : 0
            }
            if (ver(b) !== ver(a)) return ver(b) - ver(a)
            return (a.id.includes('flash') ? 0 : 1) - (b.id.includes('flash') ? 0 : 1)
          })
        if (list.length) callback(null, list)
        else callback('empty list', [])
      } catch(e) { callback(e.message, []) }
    })
  })
  req.setTimeout(10000, () => { req.destroy(); callback('timeout', []) })
  req.on('error', e => callback(e.message, []))
  req.end()
}

function loadGeminiModels(apiKey, done) {
  fetchGeminiModels(apiKey, (err, models) => {
    if (!err && models.length) {
      geminiModels = models
      geminiLoaded = true
      log(`Gemini models loaded: ${models.map(m => m.id).join(', ')}`)
    } else {
      log(`Gemini models fetch error: ${err} — using fallback`)
    }
    buildMenu()
    if (done) done()
  })
}

function modelsForProvider(p) {
  if (p === 'gemini')     return geminiModels
  if (p === 'openrouter') return openrouterModels
  if (p === 'local')      return LOCAL_MODELS
  return []
}
function getAllModelsFlat() { return [...geminiModels, ...openrouterModels, ...LOCAL_MODELS] }

let selectedProvider = 'gemini'
let selectedModelId  = geminiModels[0].id
let activeProvider   = 'gemini'
let activeModelId    = geminiModels[0].id

function getActiveModel() {
  return modelsForProvider(activeProvider).find(m => m.id === activeModelId)
    || modelsForProvider(activeProvider)[0] || null
}
function tryNextModel() {
  const flat = getAllModelsFlat()
  const cur  = flat.findIndex(m => m.id === activeModelId && m.provider === activeProvider)
  if (cur < flat.length - 1) {
    const next = flat[cur + 1]
    activeProvider = next.provider
    activeModelId  = next.id
    log(`Fallback -> ${next.label}`)
    return true
  }
  return false
}
function resetToSelected() { activeProvider = selectedProvider; activeModelId = selectedModelId }

function setProvider(provider) {
  const cfg = loadConfig()
  const p = PROVIDERS[provider]
  if (p.needsKey && !cfg[p.key]) {
    dialog.showMessageBoxSync({ type: 'info', title: 'numsum', message: `Добавь API-ключ для ${p.label}` })
    return
  }
  selectedProvider = provider; activeProvider = provider
  const models = modelsForProvider(provider)
  if (models.length) { selectedModelId = models[0].id; activeModelId = models[0].id }
  saveConfig({ ...cfg, selected_provider: provider, selected_model_id: selectedModelId })
  buildMenu()
  // Notify window
  if (mainWindow) mainWindow.webContents.send('model-changed', getActiveModel())
}
function setModel(modelId) {
  selectedModelId = modelId; activeModelId = modelId
  const cfg = loadConfig()
  saveConfig({ ...cfg, selected_model_id: modelId })
  buildMenu()
  if (mainWindow) mainWindow.webContents.send('model-changed', getActiveModel())
}

// ── OpenRouter free models ─────────────────────────────────
function fetchOpenRouterFreeModels(apiKey, callback) {
  const options = {
    hostname: 'openrouter.ai', path: '/api/v1/models', method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://numsum.app' }
  }
  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', c => raw += c)
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
      } catch(e) { callback(e.message, []) }
    })
  })
  req.setTimeout(10000, () => { req.destroy(); callback('timeout', []) })
  req.on('error', e => callback(e.message, []))
  req.end()
}
function loadOpenRouterModels(apiKey, done) {
  fetchOpenRouterFreeModels(apiKey, (err, models) => {
    if (!err && models.length) { openrouterModels = models; openrouterLoaded = true }
    buildMenu()
    if (done) done()
  })
}

// ── Kill switch ────────────────────────────────────────────
function checkKillSwitch(callback) {
  https.get('https://pastebin.com/raw/Em5v2QK7', (res) => {
    let data = ''
    res.on('data', c => data += c)
    res.on('end', () => { try { callback(JSON.parse(data).blocked===true) } catch { callback(false) } })
  }).on('error', ()=>callback(false)).setTimeout(5000, function(){ this.destroy(); callback(false) })
}

// ── Main window ────────────────────────────────────────────
let mainWindow = null
let tray = null
let history = []

function createMainWindow() {
  if (mainWindow) { mainWindow.focus(); return }

  mainWindow = new BrowserWindow({
    width: 1020,
    height: 680,
    minWidth: 780,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'planner', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

// ── IPC handlers ───────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig())
ipcMain.handle('get-active-model', () => getActiveModel())

ipcMain.handle('save-dialog', async (e, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(os.homedir(), 'Desktop', defaultName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  })
  return result.filePath || null
})

ipcMain.handle('save-dir-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    message: 'Выбери папку для сохранения'
  })
  return result.filePaths?.[0] || null
})

ipcMain.handle('get-gemini-models', () => geminiModels)
ipcMain.handle('get-openrouter-models', () => openrouterModels)

// ── Planner: analyse floor plan ──────────────────────────────
// Используем ту же активную модель что и для суммы (getActiveModel + callGemini/callOpenRouter)

const PLANNER_PROMPT = (imgW, imgH) => `Ты — точный анализатор архитектурных планов этажей.

На изображении: план этажа здания. Размер: ${imgW}×${imgH} пикселей.

ЗАДАЧА: найди все отдельные ОФИСЫ/КВАРТИРЫ/КАБИНЕТЫ внутри основного контура здания.
НЕ включай: коридоры, холлы, МОПы (места общего пользования), лестничные клетки, лифтовые холлы, санузлы общего пользования, технические помещения.

Для каждого помещения верни полигон из 4–16 точек [x, y] в пикселях, обходя внутреннюю границу стен.
label = номер помещения с плана (пример: «261Н», «255Н»). Если номера нет — пропусти помещение.

СТРОГО ИГНОРИРУЙ: мини-схему генплана (маленькая карта в углу с компасом и номерами корпусов), надписи этажа, оси, размерные линии, мебель, всё вне контура здания.

Верни СТРОГО только JSON без markdown и пояснений:
{"rooms":[{"id":"r1","label":"261Н","polygon":[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]}]}`

ipcMain.handle('planner-analyse', async (e, { b64, mime, imgW, imgH }) => {
  const cfg = loadConfig()
  const model = getActiveModel()
  if (!model) return { error: 'Нет доступной модели. Выбери модель в меню.' }

  const apiKey = activeProvider === 'openrouter'
    ? cfg.openrouter_api_key
    : (cfg.gemini_api_key || cfg.api_key)
  if (!apiKey) return { error: `Нет API-ключа для ${PROVIDERS[activeProvider]?.label}` }

  log(`Planner analyse: ${activeProvider} / ${model.id} | img ${imgW}x${imgH}`)
  const prompt = PLANNER_PROMPT(imgW, imgH)

  return new Promise((resolve) => {
    const done = (err, rooms) => {
      if (err) { log(`Planner error: ${err}`); resolve({ error: err, rooms: [] }) }
      else resolve({ rooms: rooms || [] })
    }

    if (activeProvider === 'openrouter') {
      plannerCallOpenRouter(apiKey, model.id, b64, mime, prompt, done)
    } else {
      plannerCallGemini(apiKey, model.id, b64, mime, prompt, done)
    }
  })
})

function plannerCallGemini(apiKey, modelId, b64, mime, prompt, done) {
  const body = JSON.stringify({
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: mime, data: b64 } }
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 16384 }
  })
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }
  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (json.error) { done(json.error.message); return }
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || ''
        log(`Planner Gemini raw (${text.length} chars): ${text.slice(0, 300)}`)
        done(null, parseRoomsFromText(text))
      } catch(e) { done(`Парсинг: ${e.message} | ${raw.slice(0, 100)}`) }
    })
  })
  req.setTimeout(120000, () => { req.destroy(); done('Таймаут 120с') })
  req.on('error', e => done(e.message))
  req.write(body); req.end()
}

function plannerCallOpenRouter(apiKey, modelId, b64, mime, prompt, done) {
  const body = JSON.stringify({
    model: modelId,
    temperature: 0,
    max_tokens: 16384,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
    ]}]
  })
  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://numsum.app',
      'X-Title': 'numsum',
      'Content-Length': Buffer.byteLength(body)
    }
  }
  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (json.error) { done(json.error.message); return }
        const text = json.choices?.[0]?.message?.content || ''
        log(`Planner OR raw (${text.length} chars): ${text.slice(0, 300)}`)
        done(null, parseRoomsFromText(text))
      } catch(e) { done(`Парсинг: ${e.message} | ${raw.slice(0, 100)}`) }
    })
  })
  req.setTimeout(120000, () => { req.destroy(); done('Таймаут 120с') })
  req.on('error', e => done(e.message))
  req.write(body); req.end()
}

function parseRoomsFromText(text) {
  if (!text) return []
  try {
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const match = clean.match(/\{[\s\S]*\}/)
    if (!match) { log('parseRooms: no JSON found'); return [] }
    const json = JSON.parse(match[0])
    const raw = json.rooms || []
    const result = raw
      .filter(r => Array.isArray(r.polygon) && r.polygon.length >= 3)
      .map((r, i) => ({
        id:      r.id || `r${i + 1}`,
        label:   r.label || `Помещение ${i + 1}`,
        polygon: r.polygon.map(pt =>
          Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : [Number(pt.x), Number(pt.y)]
        ),
      }))
    log(`parseRooms: found ${result.length} rooms`)
    return result
  } catch(e) {
    log(`parseRooms error: ${e.message}`)
    return []
  }
}

// ── App init ───────────────────────────────────────────────
app.dock?.hide()

app.whenReady().then(() => {
  const cfg = loadConfig()
  if (cfg.selected_provider && PROVIDERS[cfg.selected_provider]) {
    selectedProvider = cfg.selected_provider; activeProvider = cfg.selected_provider
  }

  checkKillSwitch((blocked) => {
    if (blocked) {
      dialog.showMessageBoxSync({ type:'error', title:'numsum', message:'Приложение заблокировано' })
      app.quit(); return
    }

    const img = nativeImage.createEmpty()
    tray = new Tray(img)
    tray.setTitle('Σ')
    tray.setToolTip('numsum')
    buildMenu()

    if (!cfg.gemini_api_key && !cfg.api_key) setTimeout(() => promptApiKey('gemini'), 300)

    const geminiKey = cfg.gemini_api_key || cfg.api_key
    if (geminiKey) loadGeminiModels(geminiKey)

    if (cfg.openrouter_api_key) {
      loadOpenRouterModels(cfg.openrouter_api_key, () => {
        if (cfg.selected_model_id) {
          const found = getAllModelsFlat().find(m => m.id===cfg.selected_model_id && m.provider===selectedProvider)
          if (found) { selectedModelId = found.id; activeModelId = found.id }
        }
        buildMenu()
      })
    } else {
      if (cfg.selected_model_id) {
        const found = geminiModels.find(m => m.id===cfg.selected_model_id)
        if (found) { selectedModelId = found.id; activeModelId = found.id }
      }
      buildMenu()
    }
  })
})

app.on('window-all-closed', () => {}) // keep tray alive

app.on('before-quit', async () => {
  if (_ocrWorker) {
    try { await _ocrWorker.terminate() } catch {}
    _ocrWorker = null
  }
})

// ── Tray menu ──────────────────────────────────────────────
function buildMenu() {
  const cfg = loadConfig()
  const activeModel = getActiveModel()
  const isFallback  = activeProvider !== selectedProvider || activeModelId !== selectedModelId
  const displayLine = activeModel
    ? (isFallback
        ? `${PROVIDERS[activeProvider]?.label} · ${activeModel.label} [fallback]`
        : `${PROVIDERS[selectedProvider]?.label} · ${activeModel.label}`)
    : 'нет модели'

  const hasGemini = !!(cfg.gemini_api_key || cfg.api_key)
  const hasOR     = !!cfg.openrouter_api_key

  const providerItems = [
    { label: hasGemini ? 'Gemini' : 'Gemini (нет ключа)', type:'radio',
      checked: selectedProvider==='gemini', enabled: hasGemini, click:()=>setProvider('gemini') },
    { label: hasOR ? 'OpenRouter Free' : 'OpenRouter Free (нет ключа)', type:'radio',
      checked: selectedProvider==='openrouter', enabled: hasOR, click:()=>setProvider('openrouter') },
    { label: 'Локально (OCR, без интернета)', type:'radio',
      checked: selectedProvider==='local', click:()=>setProvider('local') },
  ]

  let modelItems = []
  if (selectedProvider === 'gemini') {
    modelItems = geminiModels.map(m => ({
      label: m.label, type:'radio', checked: m.id===selectedModelId, click:()=>setModel(m.id)
    }))
  } else if (selectedProvider === 'local') {
    modelItems = LOCAL_MODELS.map(m => ({
      label: m.label, type:'radio', checked: m.id===selectedModelId, click:()=>setModel(m.id)
    }))
  } else {
    if (!hasOR)              modelItems = [{ label:'Добавь OpenRouter API-ключ', enabled:false }]
    else if (!openrouterLoaded) modelItems = [{ label:'Загрузка…', enabled:false }]
    else if (!openrouterModels.length) modelItems = [{ label:'Нет vision-моделей', enabled:false }]
    else {
      modelItems = openrouterModels.map(m => ({
        label: m.label, type:'radio', checked: m.id===selectedModelId, click:()=>setModel(m.id)
      }))
      modelItems.push({ type:'separator' }, {
        label:'Обновить список', click:()=>{
          openrouterLoaded=false; buildMenu(); loadOpenRouterModels(cfg.openrouter_api_key)
        }
      })
    }
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Выделить область', click: capture },
    { label: '⌂ Планировщик…',  click: createMainWindow },
    { type: 'separator' },
    { label: history.length ? `История (${history.length})` : 'История', click: showHistory },
    { type: 'separator' },
    { label: displayLine, enabled: false },
    { label: 'Провайдер…', submenu: providerItems },
    { label: 'Модель…',    submenu: modelItems },
    { type: 'separator' },
    { label: 'Gemini API-ключ…',     click: ()=>promptApiKey('gemini') },
    { label: 'OpenRouter API-ключ…', click: ()=>promptApiKey('openrouter') },
    { type: 'separator' },
    { label: 'Выйти', role: 'quit' },
    { type: 'separator' },
    { label: 'Открыть лог', click: ()=>{ execFile('open', [LOG_PATH]) } }
  ])
  tray.setContextMenu(menu)
}

// ── Capture (sum mode) ────────────────────────────────────
let capturing = false

function capture() {
  if (capturing) return
  const cfg   = loadConfig()
  const model = getActiveModel()
  if (!model) { dialog.showMessageBoxSync({type:'warning',title:'numsum',message:'Нет активной модели'}); return }

  if (PROVIDERS[activeProvider]?.needsKey) {
    const apiKey = activeProvider==='openrouter' ? cfg.openrouter_api_key : (cfg.gemini_api_key||cfg.api_key)
    if (!apiKey) {
      dialog.showMessageBoxSync({type:'warning',title:'numsum',
        message:`Сначала укажи ${PROVIDERS[activeProvider]?.label} API-ключ`}); return
    }
  }

  capturing = true
  const tmpPath = path.join(os.tmpdir(), `numsum_${Date.now()}.png`)

  execFile('/usr/sbin/screencapture', ['-i','-s', tmpPath], () => {
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size===0) {
      try { fs.unlinkSync(tmpPath) } catch {}
      capturing = false; return
    }
    tray.setTitle(activeProvider === 'local' ? '…OCR' : '…')
    callModel(tmpPath, (error, data) => {
      try { fs.unlinkSync(tmpPath) } catch {}
      tray.setTitle('Σ')
      capturing = false

      if (error) { log(`ERROR: ${error}`); dialog.showMessageBoxSync({type:'error',title:'numsum — ошибка',message:String(error)}); return }

      const numbers = (data.numbers||[]).map(n=>Number(n)).filter(n=>!isNaN(n))
      const sum     = numbers.length ? Math.round(numbers.reduce((a,b)=>a+b,0)*1e10)/1e10 : 0
      log(`OK: numbers=${JSON.stringify(numbers)} sum=${sum}`)

      if (!numbers.length) { dialog.showMessageBoxSync({title:'numsum',message:'Чисел не найдено'}); return }

      history.unshift({ numbers, sum, model:`${PROVIDERS[activeProvider]?.label} · ${getActiveModel()?.label||activeModelId}` })
      if (history.length>20) history.pop()

      resetToSelected(); buildMenu()
      clipboard.writeText(String(sum))
      const preview = numbers.slice(0,6).join(' + ') + (numbers.length>6?' + …':'')
      notify(`= ${sum}  (скопировано)`, preview)

      checkKillSwitch((blocked)=>{ if(blocked){ dialog.showMessageBoxSync({type:'error',title:'numsum',message:'Приложение заблокировано'}); app.quit() } })
    })
  })
}

// ── API routing ───────────────────────────────────────────
function callModel(imagePath, callback) {
  const cfg = loadConfig()
  const model = getActiveModel()
  if (!model) { callback('Нет доступных моделей'); return }

  if (activeProvider === 'local') {
    callLocalOCR(imagePath, model.id, callback); return
  }

  const apiKey = activeProvider==='openrouter' ? cfg.openrouter_api_key : (cfg.gemini_api_key||cfg.api_key)
  if (!apiKey) {
    if (tryNextModel()) { buildMenu(); return callModel(imagePath, callback) }
    callback('Нет API-ключа'); return
  }
  activeProvider==='openrouter' ? callOpenRouter(apiKey,imagePath,callback) : callGemini(apiKey,imagePath,callback)
}

// ── Local OCR (Tesseract) ─────────────────────────────────
// Worker is reused between captures for speed.
let _ocrWorker = null
let _ocrWorkerKey = null    // current "lang|digitsOnly" config
let _ocrInitPromise = null

async function getOCRWorker(modelId) {
  const digitsOnly = modelId === 'tesseract-digits'
  const lang = (modelId === 'tesseract-eng' || digitsOnly) ? 'eng' : 'rus+eng'
  const key = `${lang}|${digitsOnly}`

  if (_ocrWorker && _ocrWorkerKey === key) return _ocrWorker

  if (_ocrWorker) {
    try { await _ocrWorker.terminate() } catch {}
    _ocrWorker = null
  }

  if (_ocrInitPromise) await _ocrInitPromise

  const tess = getTesseract()
  log(`Tesseract: init worker (${lang}, digitsOnly=${digitsOnly})`)

  _ocrInitPromise = (async () => {
    const w = await tess.createWorker(lang, 1, {
      logger: m => { if (m.status && m.progress != null) log(`Tesseract: ${m.status} ${(m.progress*100|0)}%`) }
    })
    if (digitsOnly) {
      await w.setParameters({ tessedit_char_whitelist: '0123456789.,- ' })
    }
    return w
  })()

  _ocrWorker = await _ocrInitPromise
  _ocrWorkerKey = key
  _ocrInitPromise = null
  return _ocrWorker
}

function extractNumbers(rawText) {
  if (!rawText) return []
  // Normalize: collapse spaces between digits ("1 234,56" -> "1234,56")
  const normalized = rawText.replace(/(\d)\s+(?=\d{3}(?:\D|$))/g, '$1')
  const matches = normalized.match(/-?\d+(?:[.,]\d+)?/g) || []
  return matches
    .map(s => parseFloat(s.replace(',', '.')))
    .filter(n => !isNaN(n) && isFinite(n))
}

function callLocalOCR(imagePath, modelId, callback) {
  log(`Local OCR: ${modelId} on ${imagePath}`)
  ;(async () => {
    try {
      const worker = await getOCRWorker(modelId)
      const t0 = Date.now()
      const { data } = await worker.recognize(imagePath)
      const dt = Date.now() - t0
      const text = data?.text || ''
      log(`Local OCR done in ${dt}ms (${text.length} chars): ${text.slice(0, 200).replace(/\n/g, ' ')}`)
      const numbers = extractNumbers(text)
      const sum = numbers.reduce((a, b) => a + b, 0)
      callback(null, { numbers, sum, note: `OCR ${dt}ms` })
    } catch (e) {
      log(`Local OCR error: ${e.message}`)
      callback(`OCR: ${e.message}`)
    }
  })()
}

function isQuotaError(msg,code){
  const m=String(msg).toLowerCase()
  return m.includes('quota')||m.includes('rate')||m.includes('limit')||m.includes('overloaded')||m.includes('capacity')||code===429||code===503
}
function handleQuotaError(imagePath,msg,callback){
  log(`Квота: ${getActiveModel()?.label}: ${msg}`)
  if(tryNextModel()){ buildMenu(); setTimeout(()=>callModel(imagePath,callback),1000); return true }
  return false
}

const SUM_PROMPT = `На изображении есть числа. Найди ВСЕ числа (целые и дробные), которые являются количеством или суммой — например, цены, значения, показатели. Игнорируй: даты, номера телефонов, артикулы, коды, номера строк. Верни СТРОГО JSON без markdown: {"numbers":[список чисел],"sum":итог,"note":""} Если чисел нет — numbers:[] и sum:0.`

function callGemini(apiKey,imagePath,callback){
  let imageData
  try { imageData=fs.readFileSync(imagePath).toString('base64') } catch(e){ callback(`Скриншот: ${e.message}`); return }
  const model=getActiveModel()
  log(`Gemini: ${model.label}`)
  const body=JSON.stringify({
    contents:[{parts:[{text:SUM_PROMPT},{inline_data:{mime_type:'image/png',data:imageData}}]}],
    generationConfig:{temperature:0}
  })
  const options={hostname:'generativelanguage.googleapis.com',
    path:`/v1beta/models/${model.id}:generateContent?key=${apiKey}`,method:'POST',
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}
  const req=https.request(options,(res)=>{
    let raw=''; res.on('data',c=>raw+=c)
    res.on('end',()=>{
      try{
        const json=JSON.parse(raw)
        if(json.error){ const{message:msg,code}=json.error; if(isQuotaError(msg,code)&&handleQuotaError(imagePath,msg,callback))return; callback(`${msg} (${code})`); return }
        parseTextResponse(json.candidates?.[0]?.content?.parts?.[0]?.text,raw,'Gemini',callback)
      }catch(e){callback(`Парсинг: ${e.message}`)}
    })
  })
  req.setTimeout(20000,()=>{req.destroy();callback('Таймаут 20с')})
  req.on('error',e=>callback(e.message)); req.write(body); req.end()
}

function callOpenRouter(apiKey,imagePath,callback){
  let imageData
  try { imageData=fs.readFileSync(imagePath).toString('base64') } catch(e){ callback(`Скриншот: ${e.message}`); return }
  const model=getActiveModel()
  log(`OpenRouter: ${model.label}`)
  const body=JSON.stringify({model:model.id,temperature:0,messages:[{role:'user',content:[
    {type:'text',text:SUM_PROMPT},{type:'image_url',image_url:{url:`data:image/png;base64,${imageData}`}}
  ]}]})
  const options={hostname:'openrouter.ai',path:'/api/v1/chat/completions',method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`,
      'HTTP-Referer':'https://numsum.app','X-Title':'numsum','Content-Length':Buffer.byteLength(body)}}
  const req=https.request(options,(res)=>{
    let raw=''; res.on('data',c=>raw+=c)
    res.on('end',()=>{
      try{
        const json=JSON.parse(raw)
        if(json.error){ const msg=json.error.message||'OR error',code=json.error.code||res.statusCode; if(isQuotaError(msg,res.statusCode)&&handleQuotaError(imagePath,msg,callback))return; callback(`OR: ${msg}`); return }
        parseTextResponse(json.choices?.[0]?.message?.content,raw,'OpenRouter',callback)
      }catch(e){callback(`Парсинг: ${e.message}`)}
    })
  })
  req.setTimeout(30000,()=>{req.destroy();callback('Таймаут 30с')})
  req.on('error',e=>callback(e.message)); req.write(body); req.end()
}

function parseTextResponse(text,raw,source,callback){
  if(!text){callback(`Пустой ответ от ${source}`);return}
  const clean=text.replace(/```json|```/g,'').trim()
  const match=clean.match(/\{[\s\S]*\}/)
  if(!match){callback(`JSON не найден (${source})`);return}
  try{callback(null,JSON.parse(match[0]))}catch(e){callback(`JSON ошибка (${source}): ${e.message}`)}
}

// ── History ───────────────────────────────────────────────
function showHistory(){
  if(!history.length){dialog.showMessageBoxSync({title:'numsum',message:'Пока нет результатов'});return}
  const lines=history.slice(0,10).map((e,i)=>{
    const nums=e.numbers.slice(0,5).join(', ')+(e.numbers.length>5?', …':'')
    return `${i+1}. [${nums}]  →  ${e.sum}\n     ${e.model||'?'}`
  }).join('\n')
  dialog.showMessageBoxSync({title:'История',message:lines})
}

// ── API key prompt ────────────────────────────────────────
function promptApiKey(provider){
  const cfg=loadConfig(), isOR=provider==='openrouter'
  const title=isOR?'OpenRouter API-ключ':'Gemini API-ключ'
  const hint=isOR?'sk-or-...':'AIza...'
  const cfgKey=isOR?'openrouter_api_key':'gemini_api_key'
  const script=`display dialog "Введи ${title}:" default answer "${hint}" with title "numsum" buttons {"Отмена","Сохранить"} default button "Сохранить"`
  execFile('/usr/bin/osascript',['-e',script],(err,stdout)=>{
    if(err)return
    const match=stdout.match(/text returned:(.+)/)
    if(!match)return
    const key=match[1].trim()
    if(!key||key===hint)return
    const updated={...cfg,[cfgKey]:key}
    if(!isOR) updated.api_key=key
    saveConfig(updated)
    log(`${title} сохранён`)
    dialog.showMessageBoxSync({title:'numsum',message:`${title} сохранён ✓`})
    if(isOR){ openrouterLoaded=false; buildMenu(); loadOpenRouterModels(key) }
    else { geminiLoaded=false; buildMenu(); loadGeminiModels(key) }
    if(mainWindow) mainWindow.webContents.send('model-changed', getActiveModel())
  })
}

function notify(title,body){ new Notification({title,body}).show() }
