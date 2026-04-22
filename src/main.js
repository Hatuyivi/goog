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
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-3.1-flash-lite-preview',
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

function resetModel() {
  currentModelIndex = 0
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

  const cfg = loadConfig()
  if (!cfg.gemini_api_key) {
    setTimeout(() => promptApiKey('gemini'), 300)
  }
})

app.on('window-all-closed', () => {})

function buildMenu() {
  const cfg = loadConfig()
  const hasGemini = !!cfg.gemini_api_key
  const hasOpenAI = !!cfg.openai_api_key
  
  const modelShort = currentModel()
    .replace('gemini-', 'G-')
    .replace('-preview', '')
    .replace('-lite', 'L')

  const menu = Menu.buildFromTemplate([
    { label: 'Выделить область', click: capture },
    { type: 'separator' },
    { label: history.length ? `История (${history.length})` : 'История', click: showHistory },
    { type: 'separator' },
    { label: `Двойная проверка: ${hasGemini && hasOpenAI ? 'ВКЛ' : 'ВЫКЛ'}`, enabled: false },
    { label: `Gemini: ${modelShort}`, enabled: false },
    { type: 'separator' },
    { label: 'Gemini API-ключ…', click: () => promptApiKey('gemini') },
    { label: 'OpenAI API-ключ…', click: () => promptApiKey('openai') },
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
  
  if (!cfg.gemini_api_key) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'numsum',
      message: 'Сначала укажи Gemini API-ключ',
      detail: 'Меню → Gemini API-ключ…'
    })
    return
  }

  capturing = true
  const tmpPath = path.join(os.tmpdir(), `numsum_${Date.now()}.png`)

  execFile('/usr/sbin/screencapture', ['-i', '-s', tmpPath], (err) => {
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      try { fs.unlinkSync(tmpPath) } catch {}
      capturing = false
      return
    }

    tray.setTitle('…')

    // ✅ Двойная проверка если есть оба ключа
    if (cfg.openai_api_key) {
      performDoubleCheck(cfg, tmpPath, (error, result) => {
        try { fs.unlinkSync(tmpPath) } catch {}
        tray.setTitle('Σ')
        capturing = false
        handleResult(error, result)
      })
    } else {
      // Одиночная проверка только через Gemini
      callGeminiWithRetry(cfg.gemini_api_key, tmpPath, (error, data) => {
        try { fs.unlinkSync(tmpPath) } catch {}
        tray.setTitle('Σ')
        capturing = false
        handleResult(error, data)
      })
    }
  })
}

// ✅ Новая функция двойной проверки
function performDoubleCheck(cfg, imagePath, callback) {
  log('Запуск двойной проверки: Gemini + OpenAI')
  
  let geminiResult = null
  let openaiResult = null
  let geminiDone = false
  let openaiDone = false
  
  function checkComplete() {
    if (!geminiDone || !openaiDone) return
    
    // Оба результата получены
    if (!geminiResult && !openaiResult) {
      callback('Оба API вернули ошибки')
      return
    }
    
    if (!geminiResult) {
      log('Gemini failed, using OpenAI result')
      callback(null, openaiResult)
      return
    }
    
    if (!openaiResult) {
      log('OpenAI failed, using Gemini result')
      callback(null, geminiResult)
      return
    }
    
    // Сравниваем результаты
    const geminiNumbers = geminiResult.numbers || []
    const openaiNumbers = openaiResult.numbers || []
    
    log(`Gemini нашел: [${geminiNumbers.join(', ')}] сумма: ${geminiResult.sum}`)
    log(`OpenAI нашел: [${openaiNumbers.join(', ')}] сумма: ${openaiResult.sum}`)
    
    // Проверяем совпадение сумм (с погрешностью 0.1%)
    const geminiSum = geminiResult.sum || 0
    const openaiSum = openaiResult.sum || 0
    const maxSum = Math.max(geminiSum, openaiSum)
    const diff = Math.abs(geminiSum - openaiSum)
    const diffPercent = maxSum > 0 ? (diff / maxSum) * 100 : 0
    
    if (diffPercent < 0.1) {
      log(`✅ Результаты совпадают (разница ${diffPercent.toFixed(3)}%)`)
      // Используем результат с большим количеством чисел
      const finalResult = geminiNumbers.length >= openaiNumbers.length ? geminiResult : openaiResult
      finalResult.verified = true
      callback(null, finalResult)
    } else {
      log(`⚠️ Результаты расходятся (разница ${diffPercent.toFixed(1)}%)`)
      // Возвращаем оба результата для пользователя
      const combinedResult = {
        numbers: geminiNumbers.concat(openaiNumbers),
        sum: geminiSum + openaiSum,
        note: `ВНИМАНИЕ: расхождение результатов. Gemini: ${geminiSum}, OpenAI: ${openaiSum}`,
        conflict: true
      }
      callback(null, combinedResult)
    }
  }
  
  // Запускаем Gemini
  callGeminiWithRetry(cfg.gemini_api_key, imagePath, (error, data) => {
    if (!error) geminiResult = data
    geminiDone = true
    checkComplete()
  })
  
  // Запускаем OpenAI
  callOpenAI(cfg.openai_api_key, imagePath, (error, data) => {
    if (!error) openaiResult = data
    openaiDone = true
    checkComplete()
  })
}

// ✅ Функция для работы с OpenAI API
function callOpenAI(apiKey, imagePath, callback) {
  let imageData
  try { imageData = fs.readFileSync(imagePath).toString('base64') }
  catch (e) { callback(`OpenAI: Не удалось прочитать скриншот: ${e.message}`); return }

  const prompt = `Analyze the image and find ALL numbers that represent:

1. AREAS (m², sq.m, square meters) - total area values
2. MONEY (total cost, prices, sums) - with currencies ₽, $, €, USD, EUR

IMPORTANT RULES TO IGNORE:
• Numbers in parentheses (explanations): "100 (50+50)" → only count 100
• RATES per meter: 100₽/m², 50$/sq.m, 200 rub/sq.m, 75€/m2 - DO NOT COUNT
• Dates: 2024, 01.01.2024, 12/2024
• Phone numbers, article codes, line numbers, IDs
• Percentages, coefficients, ratings

WHAT TO COUNT:
• Total areas: "120 m²", "75.5 sq.m"
• Total costs: "5000000 ₽", "$250000", "price: 3500000"

Return STRICTLY in JSON format:
{"numbers": [list of numbers as Numbers], "sum": total sum, "note": "brief explanation"}

If no suitable numbers found, return numbers:[] and sum:0.`

  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` }}
      ]
    }],
    max_tokens: 500,
    temperature: 0
  })

  const options = {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
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
        
        if (json.error) {
          callback(`OpenAI: ${json.error.message}`)
          return
        }
        
        const text = json.choices?.[0]?.message?.content
        if (!text) {
          callback(`OpenAI: Пустой ответ`)
          return
        }
        
        log(`OpenAI raw text: ${text.slice(0, 300)}`)
        const cleanText = text.replace(/```json|```/g, '').trim()
        const match = cleanText.match(/\{[\s\S]*\}/)
        if (!match) {
          callback(`OpenAI: Не удалось найти JSON в ответе`)
          return
        }
        
        callback(null, JSON.parse(match[0]))
        
      } catch (e) {
        log(`OpenAI parse error: ${e.message} | raw: ${raw.slice(0, 300)}`)
        callback(`OpenAI: Ошибка парсинга: ${e.message}`)
      }
    })
  })

  req.setTimeout(15000, () => {
    req.destroy()
    callback('OpenAI: Таймаут запроса')
  })

  req.on('error', e => callback(`OpenAI: ${e.message}`))
  req.write(body)
  req.end()
}

function handleResult(error, data) {
  if (error) {
    log(`FINAL ERROR: ${error}`)
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'numsum — ошибка',
      message: String(error)
    })
    return
  }

  const numbers = (data.numbers || []).map(n => Number(n)).filter(n => !isNaN(n))
  const sum = numbers.length
    ? Math.round(numbers.reduce((a, b) => a + b, 0) * 1e10) / 1e10
    : 0

  if (!numbers.length) {
    dialog.showMessageBoxSync({ title: 'numsum', message: 'Чисел не найдено' })
    return
  }

  log(`OK: numbers=${JSON.stringify(numbers)} sum=${sum}${data.verified ? ' (verified)' : ''}${data.conflict ? ' (conflict!)' : ''}`)

  history.unshift({ 
    numbers, 
    sum, 
    verified: data.verified, 
    conflict: data.conflict,
    note: data.note 
  })
  if (history.length > 20) history.pop()
  buildMenu()

  const sumStr = String(sum)
  clipboard.writeText(sumStr)

  const preview = numbers.slice(0, 6).join(' + ') + (numbers.length > 6 ? ' + …' : '')
  const status = data.verified ? ' ✅' : data.conflict ? ' ⚠️' : ''
  notify(`= ${sumStr}${status}  (скопировано)`, preview)
  
  if (data.conflict && data.note) {
    setTimeout(() => {
      dialog.showMessageBoxSync({ 
        title: 'Расхождение результатов', 
        message: data.note 
      })
    }, 1000)
  }
}

function callGeminiWithRetry(apiKey, imagePath, callback, attemptNum = 1, maxAttempts = 6) {
  const model = currentModel()
  log(`Gemini попытка ${attemptNum}/${maxAttempts} с моделью: ${model}`)

  callGemini(apiKey, imagePath, (error, data) => {
    if (!error) {
      resetModel()
      buildMenu()
      callback(null, data)
      return
    }

    const isTemporaryError = 
      error.includes('503') || error.includes('502') ||
      error.includes('high demand') || error.includes('temporarily unavailable') ||
      error.includes('Try again later') || error.includes('timeout') ||
      error.includes('ECONNRESET') || error.includes('ETIMEDOUT')

    const isQuotaError = 
      error.includes('quota') || error.includes('rate') ||
      error.includes('limit') || error.includes('429') || error.includes('403')

    if (attemptNum < maxAttempts) {
      if (isQuotaError && nextModel()) {
        log(`Квота исчерпана для ${model}, переключаемся на ${currentModel()}`)
        buildMenu()
        setTimeout(() => {
          callGeminiWithRetry(apiKey, imagePath, callback, attemptNum + 1, maxAttempts)
        }, 1000)
        return
      }

      if (isTemporaryError) {
        const delay = Math.min(1000 * Math.pow(2, attemptNum - 1), 8000)
        log(`Временная ошибка (${error}), retry через ${delay}ms`)
        
        setTimeout(() => {
          callGeminiWithRetry(apiKey, imagePath, callback, attemptNum + 1, maxAttempts)
        }, delay)
        return
      }

      if (nextModel()) {
        log(`Ошибка с ${model}, пробуем ${currentModel()}`)
        buildMenu()
        setTimeout(() => {
          callGeminiWithRetry(apiKey, imagePath, callback, attemptNum + 1, maxAttempts)
        }, 1000)
        return
      }
    }

    callback(`Все попытки исчерпаны. Последняя ошибка: ${error}`)
  })
}

function callGemini(apiKey, imagePath, callback) {
  let imageData
  try { imageData = fs.readFileSync(imagePath).toString('base64') }
  catch (e) { callback(`Не удалось прочитать скриншот: ${e.message}`); return }

  const prompt = `На изображении есть числа. Найди ВСЕ числа (целые и дробные), которые являются:

1. ПЛОЩАДЯМИ (м², кв.м, sq.m, square meters) — общая площадь объектов
2. ДЕНЬГАМИ (общая стоимость, цены, суммы) — с валютами ₽, $, €, руб, USD, EUR

ВАЖНЫЕ ПРАВИЛА ЧТО ИГНОРИРОВАТЬ:
• Числа в скобках — это пояснения: "100 (50+50)" → учитывать только 100
• СТАВКИ ЗА МЕТР: 100₽/м², 50$/sq.m, 200 руб/кв.м, 75€/m2 — НЕ УЧИТЫВАТЬ
• Даты: 2024, 01.01.2024, 12/2024
• Телефоны, артикулы, номера строк, ID коды
• Проценты, коэффициенты, рейтинги

ЧТО УЧИТЫВАТЬ:
• Общую площадь: "120 м²", "75.5 кв.м"
• Общую стоимость: "5000000 ₽", "$250000", "цена: 3500000"
• Суммы без единиц, если контекст указывает на деньги/площадь

ПРИМЕРЫ:
✅ "100 (50+50), 20, 30" → [100, 20, 30] сумма: 150
✅ "Площадь: 75.5 м², цена: 5000000 ₽, ставка: 100₽/м²" → [75.5, 5000000]
✅ "120 кв.м, стоимость 3500000, 50₽/м²" → [120, 3500000]
❌ "Ставка 100₽/м², коэффициент 1.5" → []

Верни ответ СТРОГО в формате JSON без markdown:
{"numbers": [список чисел как Number], "sum": итоговая сумма, "note": "краткое пояснение найденного"}

Если подходящих чисел нет, верни numbers:[] и sum:0.`

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/png', data: imageData } }
      ]
    }],
    generationConfig: { temperature: 0 }
  })

  const model = currentModel()

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
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

        if (json.error) {
          const msg = json.error.message || 'Ошибка API'
          const code = json.error.code
          callback(`${msg} (код: ${code})`)
          return
        }

        let text = json.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) {
          callback(`Пустой ответ от Gemini: ${raw.slice(0, 200)}`)
          return
        }

        log(`Gemini raw text: ${text.slice(0, 300)}`)
        text = text.replace(/```json|```/g, '').trim()
        const match = text.match(/\{[\s\S]*\}/)
        if (!match) {
          callback(`Не удалось найти JSON в ответе: ${text.slice(0, 200)}`)
          return
        }

        callback(null, JSON.parse(match[0]))

      } catch (e) {
        log(`Parse error: ${e.message} | raw: ${raw.slice(0, 300)}`)
        callback(`Ошибка парсинга: ${e.message} | ${raw.slice(0, 100)}`)
      }
    })
  })

  req.setTimeout(20000, () => {
    req.destroy()
    callback('Таймаут запроса (20 сек)')
  })

  req.on('error', e => callback(e.message))
  req.write(body)
  req.end()
}

function showHistory() {
  if (!history.length) {
    dialog.showMessageBoxSync({ title: 'numsum', message: 'Пока нет результатов' })
    return
  }
  const lines = history
    .slice(0, 10)
    .map((e, i) => {
      const status = e.verified ? ' ✅' : e.conflict ? ' ⚠️' : ''
      return `${i + 1}. [${e.numbers.slice(0, 5).join(', ')}]  →  ${e.sum}${status}`
    })
    .join('\n')
  dialog.showMessageBoxSync({ title: 'История', message: lines })
}

function promptApiKey(provider = 'gemini') {
  const cfg = loadConfig()
  const isGemini = provider === 'gemini'
  const title = isGemini ? 'Gemini API-ключ' : 'OpenAI API-ключ'
  const currentKey = isGemini ? cfg.gemini_api_key : cfg.openai_api_key
  const placeholder = currentKey ? `${currentKey.slice(0, 10)}...` : ''
  
  const script = `display dialog "Введи ${title}:" default answer "${placeholder}" with title "numsum" buttons {"Отмена", "Сохранить"} default button "Сохранить"`
  
  execFile('/usr/bin/osascript', ['-e', script], (err, stdout) => {
    if (err) return
    const match = stdout.match(/text returned:(.+)/)
    if (match) {
      const key = match[1].trim()
      if (key && key !== placeholder) {
        const newCfg = { ...cfg }
        if (isGemini) {
          newCfg.gemini_api_key = key
        } else {
          newCfg.openai_api_key = key
        }
        saveConfig(newCfg)
        log(`${title} saved (length=${key.length})`)
        dialog.showMessageBoxSync({ title: 'numsum', message: `${title} сохранён ✓` })
        buildMenu() // обновляем меню
      }
    }
  })
}

function notify(title, body) {
  new Notification({ title, body }).show()
}
