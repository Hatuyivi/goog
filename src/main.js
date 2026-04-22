const { app, Menu, Tray, dialog, clipboard, Notification, nativeImage } = require('electron')
const { execFile } = require('child_process')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CONFIG_PATH = path.join(os.homedir(), '.numsum_config.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg), 'utf8')
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
    { label: 'Выйти', role: 'quit' }
  ])
  tray.setContextMenu(menu)
}

function capture() {
  const cfg = loadConfig()
  if (!cfg.api_key) {
    dialog.showMessageBoxSync({ type: 'warning', title: 'numsum', message: 'Сначала укажи API-ключ', detail: 'Меню → API-ключ…' })
    return
  }

  const tmpPath = path.join(os.tmpdir(), `numsum_${Date.now()}.png`)

  execFile('/usr/sbin/screencapture', ['-i', '-s', tmpPath], (err) => {
    if (err || !fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      try { fs.unlinkSync(tmpPath) } catch {}
      return
    }

    tray.setTitle('…')

    callGemini(cfg.api_key, tmpPath, (error, data) => {
      try { fs.unlinkSync(tmpPath) } catch {}
      tray.setTitle('Σ')

      if (error) { notify('Ошибка', error); return }

      const numbers = data.numbers || []
      const sum = data.sum ?? 0

      if (!numbers.length) { notify('numsum', 'Чисел не найдено'); return }

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
  const imageData = fs.readFileSync(imagePath).toString('base64')
  const prompt = `На изображении есть числа. Найди ВСЕ числа (целые и дробные). Верни ответ СТРОГО в формате JSON без markdown-обёртки: {"numbers": [список всех найденных чисел], "sum": итоговая сумма, "note": ""} Если чисел нет, верни numbers:[] и sum:0.`

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/png', data: imageData } }] }],
    generationConfig: { temperature: 0 }
  })

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
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
        callback(null, JSON.parse(text))
      } catch (e) {
        callback(`Ошибка: ${raw.slice(0, 100)}`)
      }
    })
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
  execFile('/usr/bin/osascript', ['-e', `display dialog "Введи Gemini API-ключ:" default answer "${cfg.api_key || ''}" with title "numsum" buttons {"Отмена", "Сохранить"} default button "Сохранить"`], (err, stdout) => {
    if (err) return
    const match = stdout.match(/text returned:(.+)/)
    if (match) {
      const key = match[1].trim()
      if (key) { saveConfig({ ...cfg, api_key: key }); notify('numsum', 'API-ключ сохранён ✓') }
    }
  })
}

function notify(title, body) {
  new Notification({ title, body }).show()
}
