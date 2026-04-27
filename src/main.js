const { app, Menu, Tray, dialog, clipboard, Notification, nativeImage } = require('electron')
const { execFile } = require('child_process')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')

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

// ============================================================
// Провайдеры
// ============================================================
const PROVIDERS = {
  gemini:      { label: 'Gemini',      key: 'gemini_api_key' },
  openrouter:  { label: 'OpenRouter',  key: 'openrouter_api_key' },
}

// Статические Gemini-модели
const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-preview-05-20', provider: 'gemini', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.0-flash',               provider: 'gemini', label: 'Gemini 2.0 Flash' },
  { id: 'gemini-2.0-flash-lite',          provider: 'gemini', label: 'Gemini 2.0 Flash Lite' },
  { id: 'gemini-1.5-flash',               provider: 'gemini', label: 'Gemini 1.5 Flash' },
]

// OpenRouter: загружаются динамически
let openrouterModels = []
let openrouterLoaded = false

function modelsForProvider(provider) {
  if (provider === 'gemini')     return GEMINI_MODELS
  if (provider === 'openrouter') return openrouterModels
  return []
}

// ============================================================
// Текущий выбор: провайдер + модель внутри него
// ============================================================
let selectedProvider   = 'gemini'  // 'gemini' | 'openrouter'
let selectedModelId    = GEMINI_MODELS[0].id

// Fallback: плоский список всех моделей через провайдеры
let activeProvider  = selectedProvider
let activeModelId   = selectedModelId

function getActiveModel() {
  return modelsForProvider(activeProvider).find(m => m.id === activeModelId)
    || modelsForProvider(activeProvider)[0]
    || null
}

function getAllModelsFlat() {
  return [...GEMINI_MODELS, ...openrouterModels]
}

// Переключиться на следующую модель/провайдер при fallback
function tryNextModel() {
  const flat = getAllModelsFlat()
  const cur  = flat.findIndex(m => m.id === activeModelId && m.provider === activeProvider)
  if (cur < flat.length - 1) {
    const next = flat[cur + 1]
    activeProvider = next.provider
    activeModelId  = next.id
    log(`Fallback -> ${next.label} (${next.provider})`)
    return true
  }
  return false
}

function resetToSelected() {
  activeProvider = selectedProvider
  activeModelId  = selectedModelId
}

// Установить провайдер вручную — сбрасывает модель на первую доступную
function setProvider(provider) {
  const cfg = loadConfig()
  const apiKey = cfg[PROVIDERS[provider].key]
  if (!apiKey) {
    // Предложим добавить ключ
    dialog.showMessageBoxSync({
      type: 'info', title: 'numsum',
      message: `Добавь API-ключ для ${PROVIDERS[provider].label}`,
      detail: `Меню → ${PROVIDERS[provider].label} API-ключ…`
    })
    return
  }

  selectedProvider = provider
  activeProvider   = provider

  // Выбираем первую модель провайдера
  const models = modelsForProvider(provider)
  if (models.length > 0) {
    selectedModelId = models[0].id
    activeModelId   = models[0].id
  }

  saveConfig({ ...cfg, selected_provider: provider, selected_model_id: selectedModelId })
  log(`Провайдер: ${provider}, модель: ${selectedModelId}`)
  buildMenu()
}

// Установить модель вручную
function setModel(modelId) {
  selectedModelId = modelId
  activeModelId   = modelId
  const cfg = loadConfig()
  saveConfig({ ...cfg, selected_model_id: modelId })
  log(`Модель: ${modelId}`)
  buildMenu()
}

// ============================================================
// Загрузка OR-моделей
// ============================================================
function fetchOpenRouterFreeModels(apiKey, callback) {
  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/models',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://numsum.app' }
  }

  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        const models = (json.data || [])
          .filter(m => {
            if (!m.id.endsWith(':free')) return false
            const mods = m.architecture?.input_modalities
            return Array.isArray(mods)
              ? mods.includes('image')
              : (m.architecture?.modality || '').includes('image')
          })
          .map(m => ({
            id:       m.id,
            provider: 'openrouter',
            label:    m.name || m.id.replace(':free', ''),
          }))
        log(`OpenRouter: ${models.length} бесплатных vision-моделей`)
        callback(null, models)
      } catch (e) { callback(e.message, []) }
    })
  })
  req.setTimeout(10000, () => { req.destroy(); callback('timeout', []) })
  req.on('error', e => callback(e.message, []))
  req.end()
}

function loadOpenRouterModels(apiKey, done) {
  fetchOpenRouterFreeModels(apiKey, (err, models) => {
    if (!err && models.length > 0) {
      openrouterModels = models
      openrouterLoaded = true
    }
    if (err) log(`OR load error: ${err}`)
    buildMenu()
    if (done) done()
  })
}

// ============================================================
// Kill switch
// ============================================================
function checkKillSwitch(callback) {
  https.get('https://pastebin.com/raw/Em5v2QK7', (res) => {
    let data = ''
    res.on('data', c => data += c)
    res.on('end', () => {
      try { callback(JSON.parse(data).blocked === true) }
      catch { callback(false) }
    })
  }).on('error', () => callback(false))
    .setTimeout(5000, function() { this.destroy(); callback(false) })
}

let tray = null
let history = []

app.dock?.hide()

app.whenReady().then(() => {
  const cfg = loadConfig()

  // Восстанавливаем выбор
  if (cfg.selected_provider && PROVIDERS[cfg.selected_provider]) {
    selectedProvider = cfg.selected_provider
    activeProvider   = cfg.selected_provider
  }

  checkKillSwitch((blocked) => {
    if (blocked) {
      dialog.showMessageBoxSync({ type: 'error', title: 'numsum', message: 'Приложение заблокировано' })
      app.quit()
      return
    }

    const img = nativeImage.createEmpty()
    tray = new Tray(img)
    tray.setTitle('Σ')
    tray.setToolTip('numsum')
    buildMenu()

    if (!cfg.gemini_api_key && !cfg.api_key) {
      setTimeout(() => promptApiKey('gemini'), 300)
    }

    // Грузим OR-модели если есть ключ
    if (cfg.openrouter_api_key) {
      loadOpenRouterModels(cfg.openrouter_api_key, () => {
        // Восстанавливаем модель после загрузки
        if (cfg.selected_model_id) {
          const all = getAllModelsFlat()
          const found = all.find(m => m.id === cfg.selected_model_id && m.provider === selectedProvider)
          if (found) {
            selectedModelId = found.id
            activeModelId   = found.id
          }
        }
        buildMenu()
      })
    } else {
      // Только Gemini — восстанавливаем модель
      if (cfg.selected_model_id) {
        const found = GEMINI_MODELS.find(m => m.id === cfg.selected_model_id)
        if (found) { selectedModelId = found.id; activeModelId = found.id }
      }
      buildMenu()
    }
  })
})

app.on('window-all-closed', () => {})

// ============================================================
// Меню
// ============================================================
function buildMenu() {
  const cfg = loadConfig()

  // --- Активная модель для отображения ---
  const activeModel  = getActiveModel()
  const isFallback   = activeProvider !== selectedProvider || activeModelId !== selectedModelId
  const providerLabel = PROVIDERS[activeProvider]?.label || activeProvider
  const modelLabel    = activeModel?.label || activeModelId
  const displayLine   = isFallback
    ? `${providerLabel} · ${modelLabel} [fallback]`
    : `${providerLabel} · ${modelLabel}`

  // ---- 1. Субменю: выбор провайдера ----
  const hasGemini = !!(cfg.gemini_api_key || cfg.api_key)
  const hasOR     = !!cfg.openrouter_api_key

  const providerItems = [
    {
      label:   hasGemini ? 'Gemini' : 'Gemini (нет ключа)',
      type:    'radio',
      checked: selectedProvider === 'gemini',
      enabled: hasGemini,
      click:   () => setProvider('gemini'),
    },
    {
      label:   hasOR ? 'OpenRouter Free' : 'OpenRouter Free (нет ключа)',
      type:    'radio',
      checked: selectedProvider === 'openrouter',
      enabled: hasOR,
      click:   () => setProvider('openrouter'),
    },
  ]

  // ---- 2. Субменю: выбор модели текущего провайдера ----
  let modelItems = []

  if (selectedProvider === 'gemini') {
    modelItems = GEMINI_MODELS.map(m => ({
      label:   m.label,
      type:    'radio',
      checked: m.id === selectedModelId,
      click:   () => setModel(m.id),
    }))
  } else if (selectedProvider === 'openrouter') {
    if (!hasOR) {
      modelItems = [{ label: 'Добавь OpenRouter API-ключ', enabled: false }]
    } else if (!openrouterLoaded) {
      modelItems = [{ label: 'Загрузка моделей…', enabled: false }]
    } else if (openrouterModels.length === 0) {
      modelItems = [{ label: 'Нет доступных моделей', enabled: false }]
    } else {
      modelItems = openrouterModels.map(m => ({
        label:   m.label,
        type:    'radio',
        checked: m.id === selectedModelId,
        click:   () => setModel(m.id),
      }))
      modelItems.push(
        { type: 'separator' },
        {
          label: 'Обновить список моделей',
          click: () => {
            openrouterLoaded = false
            buildMenu()
            loadOpenRouterModels(cfg.openrouter_api_key)
          }
        }
      )
    }
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Выделить область', click: capture },
    { type: 'separator' },
    { label: history.length ? `История (${history.length})` : 'История', click: showHistory },
    { type: 'separator' },
    { label: displayLine, enabled: false },
    { label: 'Провайдер…', submenu: providerItems },
    { label: 'Модель…',    submenu: modelItems },
    { type: 'separator' },
    { label: 'Gemini API-ключ…',     click: () => promptApiKey('gemini') },
    { label: 'OpenRouter API-ключ…', click: () => promptApiKey('openrouter') },
    { type: 'separator' },
    { label: 'Выйти', role: 'quit' },
    { type: 'separator' },
    { label: 'Открыть лог', click: () => { execFile('open', [LOG_PATH]) } }
  ])
  tray.setContextMenu(menu)
}

// ============================================================
// Capture
// ============================================================
let capturing = false

function capture() {
  if (capturing) return
  const cfg   = loadConfig()
  const model = getActiveModel()

  if (!model) {
    dialog.showMessageBoxSync({ type: 'warning', title: 'numsum', message: 'Нет активной модели' })
    return
  }

  const apiKey = activeProvider === 'openrouter'
    ? cfg.openrouter_api_key
    : (cfg.gemini_api_key || cfg.api_key)

  if (!apiKey) {
    const name = PROVIDERS[activeProvider]?.label || activeProvider
    dialog.showMessageBoxSync({
      type: 'warning', title: 'numsum',
      message: `Сначала укажи ${name} API-ключ`,
      detail: `Меню → ${name} API-ключ…`
    })
    return
  }

  capturing = true
  const tmpPath = path.join(os.tmpdir(), `numsum_${Date.now()}.png`)

  execFile('/usr/sbin/screencapture', ['-i', '-s', tmpPath], () => {
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      try { fs.unlinkSync(tmpPath) } catch {}
      capturing = false
      return
    }

    tray.setTitle('…')

    callModel(tmpPath, (error, data) => {
      try { fs.unlinkSync(tmpPath) } catch {}
      tray.setTitle('Σ')
      capturing = false

      if (error) {
        log(`ERROR: ${error}`)
        dialog.showMessageBoxSync({ type: 'error', title: 'numsum — ошибка', message: String(error) })
        return
      }

      const numbers = (data.numbers || []).map(n => Number(n)).filter(n => !isNaN(n))
      const sum     = numbers.length
        ? Math.round(numbers.reduce((a, b) => a + b, 0) * 1e10) / 1e10
        : 0

      log(`OK: numbers=${JSON.stringify(numbers)} sum=${sum}`)

      if (!numbers.length) {
        dialog.showMessageBoxSync({ title: 'numsum', message: 'Чисел не найдено' })
        return
      }

      const usedModel = getActiveModel()
      history.unshift({ numbers, sum, model: `${PROVIDERS[activeProvider]?.label} · ${usedModel?.label || activeModelId}` })
      if (history.length > 20) history.pop()

      resetToSelected()
      buildMenu()

      const sumStr  = String(sum)
      clipboard.writeText(sumStr)
      const preview = numbers.slice(0, 6).join(' + ') + (numbers.length > 6 ? ' + …' : '')
      notify(`= ${sumStr}  (скопировано)`, preview)

      checkKillSwitch((blocked) => {
        if (blocked) {
          dialog.showMessageBoxSync({ type: 'error', title: 'numsum', message: 'Приложение заблокировано' })
          app.quit()
        }
      })
    })
  })
}

// ============================================================
// Роутер вызовов + fallback
// ============================================================
function callModel(imagePath, callback) {
  const cfg   = loadConfig()
  const model = getActiveModel()
  if (!model) { callback('Нет доступных моделей'); return }

  const apiKey = activeProvider === 'openrouter'
    ? cfg.openrouter_api_key
    : (cfg.gemini_api_key || cfg.api_key)

  if (!apiKey) {
    if (tryNextModel()) { buildMenu(); return callModel(imagePath, callback) }
    callback('Нет API-ключа ни для одной из доступных моделей')
    return
  }

  if (activeProvider === 'openrouter') {
    callOpenRouter(apiKey, imagePath, callback)
  } else {
    callGemini(apiKey, imagePath, callback)
  }
}

function isQuotaError(msg, code) {
  const m = String(msg).toLowerCase()
  return m.includes('quota') || m.includes('rate') || m.includes('limit') ||
         m.includes('overloaded') || m.includes('capacity') ||
         code === 429 || code === 503
}

function handleQuotaError(imagePath, msg, callback) {
  const cur = getActiveModel()
  log(`Квота/перегрузка для ${cur?.label} (${activeProvider}): ${msg}`)
  if (tryNextModel()) { buildMenu(); setTimeout(() => callModel(imagePath, callback), 1000); return true }
  return false
}

const PROMPT = `На изображении есть числа. Найди ВСЕ числа (целые и дробные), которые являются количеством или суммой — например, цены, значения, показатели. Игнорируй: даты (2024, 01.01.2024), номера телефонов, артикулы, коды, номера строк и любые числа которые являются идентификаторами. Верни ответ СТРОГО в формате JSON без markdown-обёртки: {"numbers": [список чисел как Number], "sum": итоговая сумма, "note": ""} Если чисел нет, верни numbers:[] и sum:0.`

// ============================================================
// Gemini API
// ============================================================
function callGemini(apiKey, imagePath, callback) {
  let imageData
  try { imageData = fs.readFileSync(imagePath).toString('base64') }
  catch (e) { callback(`Не удалось прочитать скриншот: ${e.message}`); return }

  const model = getActiveModel()
  log(`Gemini: ${model.label}`)

  const body = JSON.stringify({
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/png', data: imageData } }] }],
    generationConfig: { temperature: 0 }
  })

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model.id}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }

  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', c => raw += c)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (json.error) {
          const { message: msg, code } = json.error
          if (isQuotaError(msg, code) && handleQuotaError(imagePath, msg, callback)) return
          callback(`${msg} (код: ${code})`); return
        }
        parseTextResponse(json.candidates?.[0]?.content?.parts?.[0]?.text, raw, 'Gemini', callback)
      } catch (e) { callback(`Ошибка парсинга: ${e.message}`) }
    })
  })
  req.setTimeout(20000, () => { req.destroy(); callback('Таймаут (20 сек)') })
  req.on('error', e => callback(e.message))
  req.write(body); req.end()
}

// ============================================================
// OpenRouter API
// ============================================================
function callOpenRouter(apiKey, imagePath, callback) {
  let imageData
  try { imageData = fs.readFileSync(imagePath).toString('base64') }
  catch (e) { callback(`Не удалось прочитать скриншот: ${e.message}`); return }

  const model = getActiveModel()
  log(`OpenRouter: ${model.label} (${model.id})`)

  const body = JSON.stringify({
    model: model.id,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } }
      ]
    }]
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
        if (json.error) {
          const msg  = json.error.message || 'Ошибка OpenRouter'
          const code = json.error.code || res.statusCode
          if (isQuotaError(msg, res.statusCode) && handleQuotaError(imagePath, msg, callback)) return
          callback(`OpenRouter: ${msg} (код: ${code})`); return
        }
        parseTextResponse(json.choices?.[0]?.message?.content, raw, 'OpenRouter', callback)
      } catch (e) { callback(`Ошибка парсинга: ${e.message}`) }
    })
  })
  req.setTimeout(30000, () => { req.destroy(); callback('Таймаут (30 сек)') })
  req.on('error', e => callback(e.message))
  req.write(body); req.end()
}

// ============================================================
// Парсер ответа
// ============================================================
function parseTextResponse(text, raw, source, callback) {
  if (!text) { callback(`Пустой ответ от ${source}: ${raw.slice(0, 200)}`); return }
  log(`${source} raw: ${text.slice(0, 300)}`)
  const clean = text.replace(/```json|```/g, '').trim()
  const match = clean.match(/\{[\s\S]*\}/)
  if (!match) { callback(`JSON не найден (${source}): ${clean.slice(0, 200)}`); return }
  try { callback(null, JSON.parse(match[0])) }
  catch (e) { callback(`Ошибка JSON (${source}): ${e.message}`) }
}

// ============================================================
// История
// ============================================================
function showHistory() {
  if (!history.length) { dialog.showMessageBoxSync({ title: 'numsum', message: 'Пока нет результатов' }); return }
  const lines = history.slice(0, 10).map((e, i) => {
    const nums = e.numbers.slice(0, 5).join(', ') + (e.numbers.length > 5 ? ', …' : '')
    return `${i + 1}. [${nums}]  →  ${e.sum}\n     ${e.model || '?'}`
  }).join('\n')
  dialog.showMessageBoxSync({ title: 'История', message: lines })
}

// ============================================================
// Ввод API-ключей
// ============================================================
function promptApiKey(provider) {
  const cfg    = loadConfig()
  const isOR   = provider === 'openrouter'
  const title  = isOR ? 'OpenRouter API-ключ' : 'Gemini API-ключ'
  const hint   = isOR ? 'sk-or-...' : 'AIza...'
  const cfgKey = isOR ? 'openrouter_api_key' : 'gemini_api_key'

  const script = `display dialog "Введи ${title}:" default answer "${hint}" with title "numsum" buttons {"Отмена", "Сохранить"} default button "Сохранить"`
  execFile('/usr/bin/osascript', ['-e', script], (err, stdout) => {
    if (err) return
    const match = stdout.match(/text returned:(.+)/)
    if (!match) return
    const key = match[1].trim()
    if (!key || key === hint) return

    const updated = { ...cfg, [cfgKey]: key }
    if (!isOR) updated.api_key = key
    saveConfig(updated)
    log(`${title} сохранён (length=${key.length})`)
    dialog.showMessageBoxSync({ title: 'numsum', message: `${title} сохранён ✓` })

    if (isOR) {
      openrouterLoaded = false
      buildMenu()
      loadOpenRouterModels(key)
    } else {
      buildMenu()
    }
  })
}

function notify(title, body) {
  new Notification({ title, body }).show()
}
