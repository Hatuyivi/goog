// planner.js — renderer process

const { ipcRenderer } = require('electron')
const fs   = require('fs')
const path = require('path')
const os   = require('os')

// ── State ──────────────────────────────────────────────────
let currentImagePath = null   // path on disk
let currentImageB64  = null   // base64 string
let currentImageEl   = null   // Image object for canvas
let rooms = []                // [{ id, label, polygon, color }]
let selectedRoomId = null
let currentView = 'all'       // 'all' | 'selected'

const HIGHLIGHT_COLOR = '#c9ffd4'
const HIGHLIGHT_ALPHA = 0.55
const PALETTE = [
  '#c9ffd4','#ffd6c9','#c9d6ff','#fffbc9','#f5c9ff',
  '#c9fff5','#ffc9e8','#d4ffc9','#c9eaff','#ffe8c9'
]

// ── DOM refs ───────────────────────────────────────────────
const canvas       = document.getElementById('planCanvas')
const ctx          = canvas.getContext('2d')
const dropzone     = document.getElementById('dropzone')
const previewThumb = document.getElementById('previewThumb')
const previewImg   = document.getElementById('previewImg')
const analyseBtn   = document.getElementById('analyseBtn')
const roomsList    = document.getElementById('roomsList')
const roomsEmpty   = document.getElementById('roomsEmpty')
const roomsTitle   = document.getElementById('roomsTitle')
const progressOverlay = document.getElementById('progressOverlay')
const progressText = document.getElementById('progressText')
const progressStep = document.getElementById('progressStep')
const saveAllBar   = document.getElementById('saveAllBar')
const roomCount    = document.getElementById('roomCount')
const viewLabel    = document.getElementById('viewLabel')
const viewAllBtn   = document.getElementById('viewAll')
const viewSelBtn   = document.getElementById('viewSelected')
const canvasPlaceholder = document.getElementById('canvasPlaceholder')
const modelName    = document.getElementById('modelName')

// ── Init ───────────────────────────────────────────────────
switchTab('plan')
ipcRenderer.invoke('get-active-model').then(m => {
  modelName.textContent = m ? m.label : 'нет'
})

// ── Tab switching ──────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('tab-'  + tab).classList.add('active')
  document.getElementById('page-' + tab).classList.add('active')
}

// ── Drag & Drop ────────────────────────────────────────────
function onDragOver(e) {
  e.preventDefault()
  dropzone.classList.add('drag-over')
}
function onDragLeave(e) {
  dropzone.classList.remove('drag-over')
}
function onDrop(e) {
  e.preventDefault()
  dropzone.classList.remove('drag-over')
  const file = e.dataTransfer.files[0]
  if (file) loadFile(file.path)
}
function onFileSelected(e) {
  const file = e.target.files[0]
  if (file) loadFile(file.path)
  e.target.value = ''
}

function loadFile(filePath) {
  try {
    const buf  = fs.readFileSync(filePath)
    const ext  = path.extname(filePath).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
    const b64  = buf.toString('base64')

    currentImagePath = filePath
    currentImageB64  = b64

    // Show thumb
    previewImg.src = `data:${mime};base64,${b64}`
    previewThumb.style.display = 'block'
    dropzone.style.display = 'none'
    analyseBtn.disabled = false

    // Draw on canvas
    loadImageToCanvas(`data:${mime};base64,${b64}`)

    // Clear previous results
    clearResults()
  } catch(e) {
    alert('Не удалось загрузить файл: ' + e.message)
  }
}

function loadImageToCanvas(src) {
  const img = new Image()
  img.onload = () => {
    currentImageEl = img
    resizeCanvas(img)
    drawPlan()
    canvas.style.display = 'block'
    canvasPlaceholder.style.display = 'none'
    viewLabel.textContent = 'Нажми «Распознать помещения»'
  }
  img.src = src
}

function resizeCanvas(img) {
  // Fit to wrap container — max 1400px
  const maxW = 1400, maxH = 900
  let w = img.naturalWidth, h = img.naturalHeight
  const scale = Math.min(maxW / w, maxH / h, 1)
  canvas.width  = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
}

function clearPlan() {
  currentImagePath = null
  currentImageB64  = null
  currentImageEl   = null
  previewThumb.style.display = 'none'
  dropzone.style.display = 'block'
  canvas.style.display = 'none'
  canvasPlaceholder.style.display = 'flex'
  analyseBtn.disabled = true
  viewLabel.textContent = 'Загрузи план слева'
  viewAllBtn.style.display = 'none'
  viewSelBtn.style.display = 'none'
  clearResults()
}

function clearResults() {
  rooms = []
  selectedRoomId = null
  saveAllBar.classList.remove('visible')
  roomsTitle.style.display = 'none'
  roomsList.innerHTML = ''
  roomsList.appendChild(roomsEmpty)
  roomsEmpty.style.display = 'block'
  if (currentImageEl) drawPlan()
}

// ── Canvas drawing ─────────────────────────────────────────
function drawPlan(highlightRoomId = null) {
  if (!currentImageEl) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw plan image
  ctx.drawImage(currentImageEl, 0, 0, canvas.width, canvas.height)

  if (!rooms.length) return

  const scaleX = canvas.width  / currentImageEl.naturalWidth
  const scaleY = canvas.height / currentImageEl.naturalHeight

  rooms.forEach((room, idx) => {
    if (!room.polygon || room.polygon.length < 3) return

    const showThis = currentView === 'all'
      ? true
      : (room.id === selectedRoomId)

    if (!showThis) return

    const color = room.color || PALETTE[idx % PALETTE.length]
    const pts   = room.polygon.map(([x, y]) => [x * scaleX, y * scaleY])

    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y))
    ctx.closePath()

    // Fill
    ctx.globalAlpha = highlightRoomId === room.id ? 0.75 : HIGHLIGHT_ALPHA
    ctx.fillStyle   = color
    ctx.fill()

    // Stroke
    ctx.globalAlpha = 1
    ctx.strokeStyle = highlightRoomId === room.id ? '#007aff' : 'rgba(0,0,0,0.25)'
    ctx.lineWidth   = highlightRoomId === room.id ? 2.5 : 1.5
    ctx.stroke()
  })

  ctx.globalAlpha = 1
}

// Click on canvas → select room
canvas.addEventListener('click', (e) => {
  if (!rooms.length) return
  const rect = canvas.getBoundingClientRect()
  const mx   = (e.clientX - rect.left) * (canvas.width  / rect.width)
  const my   = (e.clientY - rect.top)  * (canvas.height / rect.height)

  const scaleX = canvas.width  / currentImageEl.naturalWidth
  const scaleY = canvas.height / currentImageEl.naturalHeight

  for (const room of rooms) {
    if (!room.polygon) continue
    const pts = room.polygon.map(([x, y]) => [x * scaleX, y * scaleY])
    if (pointInPolygon(mx, my, pts)) {
      selectRoom(room.id)
      return
    }
  }
  // Click outside — deselect
  selectedRoomId = null
  drawPlan()
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('selected'))
})

function pointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// ── View switch ────────────────────────────────────────────
function setView(v) {
  currentView = v
  viewAllBtn.classList.toggle('active', v === 'all')
  viewSelBtn.classList.toggle('active', v === 'selected')
  drawPlan(selectedRoomId)
}

// ── Room list ──────────────────────────────────────────────
function buildRoomList() {
  roomsList.innerHTML = ''
  if (!rooms.length) {
    roomsList.appendChild(roomsEmpty)
    roomsEmpty.style.display = 'block'
    return
  }
  roomsEmpty.style.display = 'none'
  roomsTitle.style.display = 'block'
  roomCount.textContent = rooms.length

  rooms.forEach((room, idx) => {
    const color = room.color || PALETTE[idx % PALETTE.length]
    room.color  = color

    const item = document.createElement('div')
    item.className = 'room-item'
    item.dataset.id = room.id
    item.innerHTML = `
      <div class="room-color" style="background:${color}"></div>
      <span class="room-label">${room.label}</span>
      <button class="room-save" title="Сохранить PNG" onclick="saveRoom('${room.id}', event)">💾</button>
    `
    item.addEventListener('click', () => selectRoom(room.id))
    roomsList.appendChild(item)
  })
}

function selectRoom(id) {
  selectedRoomId = id
  document.querySelectorAll('.room-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id)
  })
  drawPlan(id)

  // Auto switch to 'selected' view
  if (currentView !== 'all') {
    drawPlan(id)
  }
}

// ── Analyse ────────────────────────────────────────────────
async function analysePlan() {
  if (!currentImageB64) return

  analyseBtn.disabled = true
  showProgress('Отправляем план в Vision API…', '')

  try {
    const cfg = await ipcRenderer.invoke('get-config')
    const model = await ipcRenderer.invoke('get-active-model')

    if (!model) throw new Error('Нет активной модели. Настрой её в меню.')

    const apiKey = model.provider === 'openrouter'
      ? cfg.openrouter_api_key
      : (cfg.gemini_api_key || cfg.api_key)

    if (!apiKey) throw new Error(`Нет API-ключа для ${model.provider}`)

    setProgressStep('Шаг 1/2 — Анализ структуры плана…')

    // Step 1: detect rooms, get polygons
    const raw = await callVisionAPI(apiKey, model, currentImageB64, PROMPT_DETECT)
    setProgressStep('Шаг 2/2 — Обработка результатов…')

    const parsed = parseRooms(raw, currentImageEl.naturalWidth, currentImageEl.naturalHeight)
    if (!parsed.length) throw new Error('Помещения не найдены. Попробуй другую модель или более чёткий план.')

    rooms = parsed
    buildRoomList()
    drawPlan()
    saveAllBar.classList.add('visible')
    viewAllBtn.style.display = ''
    viewSelBtn.style.display = ''
    viewLabel.textContent = `Найдено помещений: ${rooms.length} — нажми для выбора`

  } catch(e) {
    alert('Ошибка: ' + e.message)
  } finally {
    hideProgress()
    analyseBtn.disabled = false
  }
}

// ── Vision API prompt ──────────────────────────────────────
const PROMPT_DETECT = `Это план помещения/квартиры/здания.

Твоя задача:
1. Распознай ВСЕ отдельные помещения/комнаты (даже если выделены одинаковым цветом — они могут быть разделены стенами или линиями).
2. Для каждого помещения верни полигон — список точек [x, y] в пикселях оригинального изображения, обходящий контур помещения по часовой стрелке. Минимум 4 точки, максимум 20.
3. Дай каждому помещению название (Кухня, Спальня, Гостиная, Ванная, Коридор, Балкон, и т.д.). Если назначение неясно — «Комната N».
4. Если план сфотографирован под углом (есть перспективное искажение) — скорректируй координаты так, чтобы они соответствовали выровненному плану.

Игнорируй: надписи, размерные линии, сетку, штриховку, мебель.

Верни СТРОГО JSON без markdown:
{
  "rooms": [
    {
      "id": "r1",
      "label": "Кухня",
      "polygon": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
    }
  ]
}

Координаты — в пикселях изображения (от 0,0 в левом верхнем углу).`

// ── API call (Gemini or OpenRouter) ───────────────────────
function callVisionAPI(apiKey, model, b64, prompt) {
  return new Promise((resolve, reject) => {
    if (model.provider === 'openrouter') {
      callOpenRouter(apiKey, model.id, b64, prompt, resolve, reject)
    } else {
      callGemini(apiKey, model.id, b64, prompt, resolve, reject)
    }
  })
}

function callGemini(apiKey, modelId, b64, prompt, resolve, reject) {
  const https = require('https')
  const body = JSON.stringify({
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: 'image/jpeg', data: b64 } }
    ]}],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 }
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
        if (json.error) { reject(new Error(json.error.message)); return }
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text
        resolve(text || '')
      } catch(e) { reject(e) }
    })
  })
  req.setTimeout(60000, () => { req.destroy(); reject(new Error('Таймаут (60 сек)')) })
  req.on('error', reject)
  req.write(body); req.end()
}

function callOpenRouter(apiKey, modelId, b64, prompt, resolve, reject) {
  const https = require('https')
  const body = JSON.stringify({
    model: modelId,
    temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
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
        if (json.error) { reject(new Error(json.error.message)); return }
        resolve(json.choices?.[0]?.message?.content || '')
      } catch(e) { reject(e) }
    })
  })
  req.setTimeout(60000, () => { req.destroy(); reject(new Error('Таймаут (60 сек)')) })
  req.on('error', reject)
  req.write(body); req.end()
}

// ── Parse API response ─────────────────────────────────────
function parseRooms(text, imgW, imgH) {
  if (!text) return []
  try {
    const clean = text.replace(/```json|```/g, '').trim()
    const match = clean.match(/\{[\s\S]*\}/)
    if (!match) return []
    const json  = JSON.parse(match[0])
    const raw   = json.rooms || []

    return raw
      .filter(r => r.polygon && r.polygon.length >= 3)
      .map((r, i) => ({
        id:      r.id || `r${i + 1}`,
        label:   r.label || `Комната ${i + 1}`,
        polygon: r.polygon,
        color:   PALETTE[i % PALETTE.length],
      }))
  } catch(e) {
    console.error('parseRooms error:', e, text.slice(0, 300))
    return []
  }
}

// ── Save PNG ───────────────────────────────────────────────
async function saveRoom(id, e) {
  e && e.stopPropagation()
  const room = rooms.find(r => r.id === id)
  if (!room) return

  const savePath = await ipcRenderer.invoke('save-dialog', `${room.label}.png`)
  if (!savePath) return

  const offCanvas = generateRoomCanvas(room, false)
  const buf = Buffer.from(offCanvas.toDataURL('image/png').split(',')[1], 'base64')
  fs.writeFileSync(savePath, buf)
}

async function saveSelected() {
  if (!selectedRoomId) { alert('Сначала выбери помещение'); return }
  await saveRoom(selectedRoomId)
}

async function saveAll() {
  const dir = await ipcRenderer.invoke('save-dir-dialog')
  if (!dir) return

  rooms.forEach((room, idx) => {
    const offCanvas = generateRoomCanvas(room, false)
    const buf = Buffer.from(offCanvas.toDataURL('image/png').split(',')[1], 'base64')
    const fname = path.join(dir, `${String(idx + 1).padStart(2,'0')}_${room.label}.png`)
    fs.writeFileSync(fname, buf)
  })

  // Also save combined
  const combinedCanvas = generateCombinedCanvas()
  const buf = Buffer.from(combinedCanvas.toDataURL('image/png').split(',')[1], 'base64')
  fs.writeFileSync(path.join(dir, '00_все_помещения.png'), buf)

  alert(`Сохранено ${rooms.length + 1} файлов в:\n${dir}`)
}

// Generate a clean PNG for one room (white bg, plan outline, room highlighted)
function generateRoomCanvas(room, combined = false) {
  const w = currentImageEl.naturalWidth
  const h = currentImageEl.naturalHeight
  const off = document.createElement('canvas')
  off.width  = w
  off.height = h
  const c = off.getContext('2d')

  // White background
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, w, h)

  // Draw original plan (for walls/contour context)
  c.drawImage(currentImageEl, 0, 0, w, h)

  const drawRoom = (r, alpha) => {
    if (!r.polygon || r.polygon.length < 3) return
    c.beginPath()
    c.moveTo(r.polygon[0][0], r.polygon[0][1])
    r.polygon.slice(1).forEach(([x, y]) => c.lineTo(x, y))
    c.closePath()
    c.globalAlpha = alpha
    c.fillStyle = HIGHLIGHT_COLOR
    c.fill()
    c.globalAlpha = 1
    c.strokeStyle = 'rgba(0,0,0,0.3)'
    c.lineWidth = 2
    c.stroke()
  }

  if (combined) {
    rooms.forEach(r => drawRoom(r, HIGHLIGHT_ALPHA))
  } else {
    drawRoom(room, 0.65)
    // Label
    if (room.polygon.length) {
      const cx = room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length
      const cy = room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length
      c.font = 'bold 18px -apple-system, sans-serif'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillStyle = 'rgba(255,255,255,0.85)'
      c.fillRect(cx - 60, cy - 14, 120, 28)
      c.fillStyle = '#1d1d1f'
      c.fillText(room.label, cx, cy)
    }
  }

  return off
}

function generateCombinedCanvas() {
  const off = document.createElement('canvas')
  off.width  = currentImageEl.naturalWidth
  off.height = currentImageEl.naturalHeight
  const c = off.getContext('2d')
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, off.width, off.height)
  c.drawImage(currentImageEl, 0, 0)

  rooms.forEach((room, idx) => {
    if (!room.polygon) return
    const color = PALETTE[idx % PALETTE.length]
    c.beginPath()
    c.moveTo(room.polygon[0][0], room.polygon[0][1])
    room.polygon.slice(1).forEach(([x, y]) => c.lineTo(x, y))
    c.closePath()
    c.globalAlpha = HIGHLIGHT_ALPHA
    c.fillStyle = color
    c.fill()
    c.globalAlpha = 1
    c.strokeStyle = 'rgba(0,0,0,0.25)'
    c.lineWidth = 1.5
    c.stroke()
  })

  return off
}

// ── Progress helpers ───────────────────────────────────────
function showProgress(text, step) {
  progressText.textContent = text
  progressStep.textContent = step
  progressOverlay.classList.add('visible')
}
function setProgressStep(step) {
  progressStep.textContent = step
}
function hideProgress() {
  progressOverlay.classList.remove('visible')
}
