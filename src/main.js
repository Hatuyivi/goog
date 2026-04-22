const { app, Menu, Tray, dialog, clipboard, Notification, nativeImage } = require('electron')
const { execFile } = require('child_process')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')

// ── Конфиг ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.numsum_config.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg), 'utf8')
}

// ── Globals ───────────────────────────────────────────────────────────────────

let tray = null
let history = []

// ── App init ──────────────────────────────────────────────────────────────────

app.dock?.hide() // не показывать в Dock
app.whenReady().then(() => {
  // Создаём иконку из текста Σ
  const icon = createTextIcon('Σ')
  tray = new Tray(icon)
  tray.setToolTip('numsum')
  buildMenu()

  // Спросить ключ при первом запуске
  if (!loadConfig().api_key) {
    setTimeout(() => promptApiKey(), 300)
  }
})

app.on('window-all-closed', () => {}) // не закрываться при закрытии окон

// ── Иконка из текста ──────────────────────────────────────────────────────────

function createTextIcon(text) {
  // Создаём простую PNG иконку 22x22 через canvas-like подход
  // Используем пустую иконку и ставим title
  const size = 22
  // Создаём минимальную прозрачную PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH6AQWDjMvH7OOkgAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAAUSURBVDjLY2AYBaNgFAx/AAQAAAT/AAFm2zMAAAAASUVORK5CYII=',
    'base64'
  )
  const img = nativeImage.createFromBuffer(png)
  img.setTemplateImage(true)
  tray?.setTitle(text) // macOS покажет текст рядом с иконкой
  return img
}

// ── Меню ──────────────────────────────────────────────────────────────────────

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Выделить область',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: capture
    },
    { type: 'separator' },
    {
      label: history.length ? `История (${history.length})` : 'История',
      click: showHistory
    },
    { type: 'separator' },
    { label: 'API-ключ…', click: promptApiKey },
    { label: 'Выйти', role: 'quit' }
  ])
  tray.setContextMenu(menu)
}

// ── Захват области ────────────────────────────────────────────────────────────

function capture() {
  const cfg = loadConfig()
  if (!cfg.api_key) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'numsum',
      message: 'Сначала укажи API-ключ',
      detail: 'Меню → API-ключ…'
    })
    return
  }

  const tmpPath = path.join(os.tmpdir(), `numsum_${Date.now()}.png`)

  execFile('/usr/sbin/screencapture', ['-i', '-s', tmpPath], (err) => {
    if (err || !fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      try { fs.unlinkSync(tmpPath) } catch {}
      return // пользователь нажал Escape
    }

    tray.setTitle('…')

    callGemini(cfg.api_key, tmpPath, (error, data) => {
      try { fs.unlinkSync(tmpPath) } catch {}
      tray.setTitle('Σ')

      if (error) {
        notify('Ошибка', error)
        return
      }

      const numbers = data.numbers || []
      const sum = data.sum ?? 0

      if (!numbers.length) {
        notify('numsum', 'Чисел не найдено')
        return
      }

      history.unshift({ numbers, sum })
      if (history.length > 20) history.pop()
      buildMenu()

      const sumStr = Number.isInteger(sum) ? String(sum) : String(sum)
      clipboard.writeText(sumStr)

      const preview = numbers.slice(0, 6).join(' + ') + (numbers.length > 6 ? ' + …' : '')
      notify(`= ${sumStr}  (скопировано)`, preview)
    })
  })
}

// ── Gemini API ────────────────────────────────────────────────────────────────

function callGemini(apiKey, imagePath, callback) {
  const imageData = fs.readFileSync(imagePath).toString('base64')

  const prompt = `На изображении есть числа. Найди ВСЕ числа (целые и дробные).
Верни ответ СТРОГО в формате JSON без markdown-обёртки:
{"numbers": [список всех найденных чисел], "sum": итоговая сумма, "note": "пояснение или пустая строка"}
Если чисел нет, верни numbers:[] и sum:0.`

  const body = JSON.stringify({
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: 'image/png', data: imageData } }
    ]}],
    generationConfig: { temperature: 0 }
  })

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }

  const req = https.request(options, (res) => {
    let raw = ''
    res.on('data', chunk => raw += chunk)
    res.on('end', () => {
      try {
        const json = JSON.parse(raw)
        if (json.error) { callback(json.error.message || 'Ошибка API'); return }
        let text = json.candidates[0].content.parts[0].text
        text = text.replace(/```json|```/g, '').trim()
        const result = JSON.parse(text)
        callback(null, result)
      } catch (e) {
        callback(`Не удалось разобрать ответ: ${raw.slice(0, 100)}`)
      }
    })
  })

  req.on('error', e => callback(e.message))
  req.write(body)
  req.end()
}

// ── История ───────────────────────────────────────────────────────────────────

function showHistory() {
  if (!history.length) {
    dialog.showMessageBoxSync({ title: 'numsum — История', message: 'Пока нет результатов' })
    return
  }

  const lines = history.slice(0, 10).map((e, i) => {
    const nums = e.numbers.slice(0, 5).join(', ') + (e.numbers.length > 5 ? '…' : '')
    const s = Number.isInteger(e.sum) ? e.sum : e.sum
    return `${i + 1}. [${nums}]  →  ${s}`
  }).join('\n')

  dialog.showMessageBoxSync({ title: 'numsum — Последние результаты', message: lines })
}

// ── API Key ───────────────────────────────────────────────────────────────────

function promptApiKey() {
  const cfg = loadConfig()
  const result = dialog.showMessageBoxSync({
    type: 'question',
    title: 'numsum — API-ключ',
    message: 'Введи Gemini API-ключ',
    detail: 'Получить бесплатно: aistudio.google.com/app/apikey\n\nТекущий ключ будет заменён.',
    buttons: ['Ввести ключ', 'Отмена'],
    defaultId: 0
  })

  if (result !== 0) return

  // Используем AppleScript для ввода текста (нет встроенного input в Electron без окна)
  execFile('/usr/bin/osascript', [
    '-e',
    `display dialog "Введи Gemini API-ключ:" default answer "${cfg.api_key || ''}" with title "numsum" buttons {"Отмена", "Сохранить"} default button "Сохранить"`
  ], (err, stdout) => {
    if (err) return
    const match = stdout.match(/text returned:(.+)/)
    if (match) {
      const key = match[1].trim()
      if (key) {
        saveConfig({ ...cfg, api_key: key })
        notify('numsum', 'API-ключ сохранён ✓')
      }
    }
  })
}

// ── Уведомления ───────────────────────────────────────────────────────────────

function notify(title, body) {
  new Notification({ title, body }).show()
}
