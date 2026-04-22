const { app, Menu, Tray, dialog, clipboard, Notification, nativeImage } = require('electron')
const { execFile } = require('child_process')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CONFIG_PATH = path.join(os.homedir(), '.numsum_config.json')
const LOG_PATH = path.join(os.homedir(), '.numsum_log.txt')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(LOG_PATH, line) } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg), 'utf8') }
  catch (e) { log(`saveConfig error: ${e.message}`) }
}

const GEMINI_MODELS = [
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  // 'gemini-1.5-flash-latest',
]

let currentModelIndex = 0

function currentModel() {
  return GEMINI_MODELS[currentModelIndex]
}

function nextModel() {
  if (currentModelIndex < GEMINI_MODELS.length - 1) {
    currentModelIndex++
    log(`Переключаемся на модель: ${currentModel()}`)
    return true
  }
  return false
}

let tray = null
let history = []

app.dock?.hide()

app.whenReady().then(() => {
  const img = nativeImage.createEmpty()
  tray = new Tray(img)
  tray.setTitle('Σ')
  tray.setToolTip('numsum')
  buildMenu()

  if (!loadConfig().api_key) {
    setTimeout(() => promptApiKey(), 300)
  }
})

app.on('window-all-closed', () => {})

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Выделить область', click: capture },
    { type: 'separator' },
    { label: history.length ? `История (${history.length})` : 'История', click: showHistory },
    { type: 'separator' },
    { label: 'API-ключ…', click: promptApiKey },
    { label: 'Выйти', role: 'quit' },
    { type: 'separator' },
    { label: 'Открыть лог', click: () => { execFile('open', [LOG_PATH]) } }
  ])
  tray.setContextMenu(menu)
}

let capturing = false

function capture() {
  if (capturing) return
  const cfg = loadConfig()
  if (!cfg.api_key) {
    dialog.showMessageBoxSync({ type: 'warning', title: 'numsum', message: 'Сначала укажи API-ключ', detail: 'Меню → API-ключ…' })
    return
  }

  capturing = true
  const tmpPath = path.join(os.tmpdir(), `numsum_${Date.now()}.png`)

  execFile('/usr/sbin/screencapture', ['-i', '-s', tmpPath], (err) => {
    // screencapture returns err when user presses Escape — not a real error, just check file
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      try { fs.unlinkSync(tmpPath) } catch {}
      capturing = false
      return
    }

    tray.setTitle('…')

    callGemini(cfg.api_key, tmpPath, (error, data) => {
      try { fs.unlinkSync(tmpPath) } catch {}
      tray.setTitle('Σ')
      capturing = false

      if (error) {
        log(`ERROR: ${error}`)
        dialog.showMessageBoxSync({ type: 'error', title: 'numsum — ошибка', message: String(error) })
        return
      }

      log(`OK: numbers=${JSON.stringify(data.numbers)} sum=${data.sum}`)

      // Gemini sometimes returns strings instead of numbers — normalize
      const numbers = (data.numbers || []).map(n => Number(n)).filter(n => !isNaN(n))
      const sum = numbers.length ? Math.round(numbers.reduce((a, b) => a + b, 0) * 1e10) / 1e10 : 0

      if (!numbers.length) {
        dialog.showMessageBoxSync({ title: 'numsum', message: 'Чисел не найдено' })
        return
      }

      history.unshift({ numbers, sum })
      if (history.length > 20) history.pop()
      buildMenu()

      const sumStr = String(sum)
      clipboard.writeText(sumStr)

      const preview = numbers.slice(0, 6).join(' + ') + (numbers.length > 6 ? ' + …' : '')
      notify(`= ${sumStr}  (скопировано)`, preview)
    })
  })
}

function callGemini(apiKey, imagePath, callback) {
  let imageData
  try { imageData = fs.readFileSync(imagePath).toString('base64') }
  catch (e) { callback(`Не удалось прочитать скриншот: ${e.message}`); return }

  const prompt = `На изображении есть числа. Найди ВСЕ числа (целые и дробные), которые являются количеством или суммой — например, цены, значения, показатели. Игнорируй: даты (2024, 01.01.2024), номера телефонов, артикулы, коды, номера строк и любые числа которые являются идентификаторами. Верни ответ СТРОГО в формате JSON без markdown-обёртки: {"numbers": [список чисел как Number], "sum": итоговая сумма, "note": ""} Если чисел нет, верни numbers:[] и sum:0.`

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/png', data: imageData } }] }],
    generationConfig: { temperature: 0 }
  })

  const model = currentModel()
  log(`Используем модель: ${model}`)

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }

  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', chunk => raw += chunk)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (json.error) {
          const msg = json.error.message || 'Ошибка API'
          const isQuota = msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate') || json.error.code === 429
          if (isQuota && nextModel()) {
            log(`Квота исчерпана для ${model}, пробуем ${currentModel()}`)
            callGemini(apiKey, imagePath, callback)
            return
          }
          callback(msg)
          return
        }
        let text = json.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) { callback(`Пустой ответ от Gemini: ${raw.slice(0, 200)}`); return }
        log(`Gemini raw text: ${text.slice(0, 300)}`)
        text = text.replace(/```json|```/g, '').trim()
        const match = text.match(/\{[\s\S]*\}/)
        if (!match) { callback(`Не удалось найти JSON в ответе: ${text.slice(0, 200)}`); return }
        callback(null, JSON.parse(match[0]))
      } catch (e) {
        log(`Parse error: ${e.message} | raw: ${raw.slice(0, 300)}`)
        callback(`Ошибка парсинга: ${e.message} | ${raw.slice(0, 100)}`)
      }
    })
  })

  req.setTimeout(15000, () => {
    req.destroy()
    callback('Таймаут запроса (15 сек) — проверь интернет-соединение')
  })
  req.on('error', e => callback(e.message))
  req.write(body)
  req.end()
}

function showHistory() {
  if (!history.length) { dialog.showMessageBoxSync({ title: 'numsum', message: 'Пока нет результатов' }); return }
  const lines = history.slice(0, 10).map((e, i) => `${i + 1}. [${e.numbers.slice(0, 5).join(', ')}]  →  ${e.sum}`).join('\n')
  dialog.showMessageBoxSync({ title: 'История', message: lines })
}

function promptApiKey() {
  const cfg = loadConfig()
  // bug fix: pass current key via separate arg to avoid osascript injection if key has quotes
  const script = `display dialog "Введи Gemini API-ключ:" default answer "" with title "numsum" buttons {"Отмена", "Сохранить"} default button "Сохранить"`
  execFile('/usr/bin/osascript', ['-e', script], (err, stdout) => {
    if (err) return  // user clicked Отмена
    const match = stdout.match(/text returned:(.+)/)
    if (match) {
      const key = match[1].trim()
      if (key) {
        saveConfig({ ...cfg, api_key: key })
        log(`API key saved (length=${key.length})`)
        dialog.showMessageBoxSync({ title: 'numsum', message: 'API-ключ сохранён ✓' })
      }
    }
  })
}

function notify(title, body) {
  new Notification({ title, body }).show()
}
