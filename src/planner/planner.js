// planner.js — renderer process
// Все API-вызовы идут через IPC в main-процесс (не напрямую из renderer)

const { ipcRenderer } = require('electron')
const fs   = require('fs')
const path = require('path')

// ── State ──────────────────────────────────────────────────
let currentImageB64  = null
let currentMime      = 'image/jpeg'
let currentImageEl   = null
let rooms            = []
let selectedRoomId   = null
let currentView      = 'all'

// Локальный выбор провайдера/модели (может отличаться от трей-выбора)
let plannerProvider  = null   // 'gemini' | 'openrouter'
let plannerModelId   = null

const PALETTE = [
  '#c9ffd4','#ffd6c9','#c9d6ff','#fffbc9','#f5c9ff',
  '#c9fff5','#ffc9e8','#d4ffc9','#c9eaff','#ffe8c9',
  '#ffd4d4','#d4d4ff','#d4ffff','#ffe4c9','#e4ffc9',
  '#ffc9d4','#c9ffc9'
]
const HIGHLIGHT_ALPHA = 0.52

// ── DOM ────────────────────────────────────────────────────
const canvas          = document.getElementById('planCanvas')
const ctx             = canvas.getContext('2d')
const dropzone        = document.getElementById('dropzone')
const previewThumb    = document.getElementById('previewThumb')
const previewImg      = document.getElementById('previewImg')
const analyseBtn      = document.getElementById('analyseBtn')
const roomsList       = document.getElementById('roomsList')
const roomsEmpty      = document.getElementById('roomsEmpty')
const roomsTitle      = document.getElementById('roomsTitle')
const roomsDivider    = document.getElementById('roomsDivider')
const progressOverlay = document.getElementById('progressOverlay')
const progressText    = document.getElementById('progressText')
const progressStep    = document.getElementById('progressStep')
const saveBar         = document.getElementById('saveBar')
const roomCount       = document.getElementById('roomCount')
const viewLabel       = document.getElementById('viewLabel')
const viewAllBtn      = document.getElementById('viewAll')
const viewSelBtn      = document.getElementById('viewSelected')
const canvasPlaceholder = document.getElementById('canvasPlaceholder')
const providerSelect  = document.getElementById('providerSelect')
const modelSelect     = document.getElementById('modelSelect')

// ── Init ───────────────────────────────────────────────────
async function init() {
  const cfg   = await ipcRenderer.invoke('get-config')
  const model = await ipcRenderer.invoke('get-active-model')

  // Установим провайдер из трея как дефолт
  plannerProvider = model?.provider || 'gemini'
  plannerModelId  = model?.id       || null

  await refreshProviderSelect(cfg)
  await refreshModelSelect(cfg)

  // Синхронизировать когда трей меняет модель
  ipcRenderer.on('model-changed', async (e, m) => {
    const c = await ipcRenderer.invoke('get-config')
    await refreshProviderSelect(c)
    await refreshModelSelect(c)
  })
}

async function refreshProviderSelect(cfg) {
  const hasGemini = !!(cfg.gemini_api_key || cfg.api_key)
  const hasOR     = !!cfg.openrouter_api_key

  // Строим опции только для доступных провайдеров
  providerSelect.innerHTML = ''
  if (hasGemini) {
    const o = document.createElement('option')
    o.value = 'gemini'; o.textContent = 'Gemini'
    providerSelect.appendChild(o)
  }
  if (hasOR) {
    const o = document.createElement('option')
    o.value = 'openrouter'; o.textContent = 'OpenRouter Free'
    providerSelect.appendChild(o)
  }
  if (!hasGemini && !hasOR) {
    const o = document.createElement('option')
    o.value = ''; o.textContent = 'Нет API-ключей'
    providerSelect.appendChild(o)
  }

  // Восстанавливаем выбор
  if (plannerProvider && [...providerSelect.options].find(o => o.value === plannerProvider)) {
    providerSelect.value = plannerProvider
  } else {
    plannerProvider = providerSelect.value
  }
}

async function refreshModelSelect(cfg) {
  const provider = providerSelect.value
  modelSelect.innerHTML = ''

  let models = []
  if (provider === 'gemini') {
    models = await ipcRenderer.invoke('get-gemini-models')
  } else if (provider === 'openrouter') {
    models = await ipcRenderer.invoke('get-openrouter-models')
    if (!models.length) {
      const o = document.createElement('option')
      o.value = ''; o.textContent = 'Нет моделей (загрузка…)'
      modelSelect.appendChild(o)
      modelSelect.disabled = true
      return
    }
  }

  modelSelect.disabled = false
  models.forEach(m => {
    const o = document.createElement('option')
    o.value = m.id; o.textContent = m.label
    modelSelect.appendChild(o)
  })

  // Восстанавливаем выбранную модель
  if (plannerModelId && provider === plannerProvider) {
    const found = [...modelSelect.options].find(o => o.value === plannerModelId)
    if (found) modelSelect.value = plannerModelId
  }
  plannerModelId = modelSelect.value
}

function onProviderChange() {
  plannerProvider = providerSelect.value
  plannerModelId  = null
  ipcRenderer.invoke('get-config').then(cfg => refreshModelSelect(cfg))
}

function onModelChange() {
  plannerModelId = modelSelect.value
}

// ── Tab switch ─────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('tab-'  + tab).classList.add('active')
  document.getElementById('page-' + tab).classList.add('active')
}

// ── Drag & drop ────────────────────────────────────────────
function onDragOver(e) { e.preventDefault(); dropzone.classList.add('drag-over') }
function onDragLeave()  { dropzone.classList.remove('drag-over') }
function onDrop(e) {
  e.preventDefault(); dropzone.classList.remove('drag-over')
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
    currentMime = ext === '.png' ? 'image/png' : 'image/jpeg'
    currentImageB64 = buf.toString('base64')

    previewImg.src = `data:${currentMime};base64,${currentImageB64}`
    previewThumb.style.display = 'block'
    dropzone.style.display = 'none'
    analyseBtn.disabled = false
    clearResults()

    const img = new Image()
    img.onload = () => {
      currentImageEl = img
      resizeCanvas(img)
      drawPlan()
      canvas.style.display = 'block'
      canvasPlaceholder.style.display = 'none'
      viewLabel.textContent = 'Нажми «Распознать помещения»'
    }
    img.src = `data:${currentMime};base64,${currentImageB64}`
  } catch(e) { alert('Ошибка загрузки: ' + e.message) }
}

function resizeCanvas(img) {
  const maxW = 1600, maxH = 1000
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
  canvas.width  = Math.round(img.naturalWidth  * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
}

function clearPlan() {
  currentImageB64 = null; currentImageEl = null
  previewThumb.style.display = 'none'; dropzone.style.display = 'block'
  canvas.style.display = 'none'; canvasPlaceholder.style.display = 'flex'
  analyseBtn.disabled = true; viewLabel.textContent = 'Загрузи план слева'
  viewAllBtn.style.display = 'none'; viewSelBtn.style.display = 'none'
  clearResults()
}

function clearResults() {
  rooms = []; selectedRoomId = null
  saveBar.classList.remove('visible')
  roomsTitle.style.display = 'none'; roomsDivider.style.display = 'none'
  roomsList.innerHTML = ''; roomsList.appendChild(roomsEmpty); roomsEmpty.style.display = 'block'
  if (currentImageEl) drawPlan()
}

// ── Canvas ─────────────────────────────────────────────────
function drawPlan(highlightId = null) {
  if (!currentImageEl) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(currentImageEl, 0, 0, canvas.width, canvas.height)
  if (!rooms.length) return

  const sx = canvas.width  / currentImageEl.naturalWidth
  const sy = canvas.height / currentImageEl.naturalHeight

  rooms.forEach((room, idx) => {
    if (!room.polygon || room.polygon.length < 3) return
    const show = currentView === 'all' ? true : room.id === selectedRoomId
    if (!show) return

    const pts   = room.polygon.map(([x, y]) => [x * sx, y * sy])
    const isHl  = highlightId === room.id
    const color = room.color || PALETTE[idx % PALETTE.length]

    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y))
    ctx.closePath()

    ctx.globalAlpha = isHl ? 0.72 : HIGHLIGHT_ALPHA
    ctx.fillStyle   = color
    ctx.fill()

    ctx.globalAlpha = 1
    ctx.strokeStyle = isHl ? '#007aff' : 'rgba(0,0,0,0.2)'
    ctx.lineWidth   = isHl ? 2.5 : 1.5
    ctx.stroke()
  })
  ctx.globalAlpha = 1
}

canvas.addEventListener('click', e => {
  if (!rooms.length || !currentImageEl) return
  const rect = canvas.getBoundingClientRect()
  const mx = (e.clientX - rect.left) * (canvas.width  / rect.width)
  const my = (e.clientY - rect.top)  * (canvas.height / rect.height)
  const sx = canvas.width  / currentImageEl.naturalWidth
  const sy = canvas.height / currentImageEl.naturalHeight

  for (const room of rooms) {
    if (!room.polygon) continue
    if (pointInPolygon(mx, my, room.polygon.map(([x, y]) => [x * sx, y * sy]))) {
      selectRoom(room.id); return
    }
  }
  selectedRoomId = null
  drawPlan()
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('selected'))
})

function pointInPolygon(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function setView(v) {
  currentView = v
  viewAllBtn.classList.toggle('active', v === 'all')
  viewSelBtn.classList.toggle('active', v === 'selected')
  drawPlan(selectedRoomId)
}

function selectRoom(id) {
  selectedRoomId = id
  document.querySelectorAll('.room-item').forEach(el => el.classList.toggle('selected', el.dataset.id === id))
  drawPlan(id)
  // Scroll list item into view
  const el = document.querySelector(`.room-item[data-id="${id}"]`)
  if (el) el.scrollIntoView({ block: 'nearest' })
}

function buildRoomList() {
  roomsList.innerHTML = ''
  if (!rooms.length) { roomsList.appendChild(roomsEmpty); roomsEmpty.style.display = 'block'; return }
  roomsEmpty.style.display = 'none'
  roomsTitle.style.display = 'block'; roomsDivider.style.display = 'block'
  roomCount.textContent = rooms.length

  rooms.forEach((room, idx) => {
    const color = PALETTE[idx % PALETTE.length]; room.color = color
    const item = document.createElement('div')
    item.className = 'room-item'; item.dataset.id = room.id
    item.innerHTML = `
      <div class="room-dot" style="background:${color}"></div>
      <span class="room-label" title="${room.label}">${room.label}</span>
      <button class="room-save" title="Сохранить PNG" onclick="saveRoom('${room.id}',event)">💾</button>
    `
    item.addEventListener('click', () => selectRoom(room.id))
    roomsList.appendChild(item)
  })
}

// ── Analyse — через IPC в main ─────────────────────────────
async function analysePlan() {
  if (!currentImageB64) return

  const provider = providerSelect.value
  const modelId  = modelSelect.value
  if (!provider || !modelId) { alert('Выбери провайдера и модель'); return }

  analyseBtn.disabled = true
  showProgress('Отправляем план в Vision API…', `${provider === 'gemini' ? 'Gemini' : 'OpenRouter'} · ${modelSelect.options[modelSelect.selectedIndex]?.text}`)

  try {
    setProgressStep('Анализ структуры плана…')

    const result = await ipcRenderer.invoke('planner-analyse', {
      b64:      currentImageB64,
      mime:     currentMime,
      provider: provider,
      modelId:  modelId,
      imgW:     currentImageEl.naturalWidth,
      imgH:     currentImageEl.naturalHeight,
    })

    if (result.error) throw new Error(result.error)

    rooms = result.rooms
    if (!rooms.length) throw new Error('Помещения не найдены. Попробуй другую модель или более чёткий план.')

    buildRoomList()
    drawPlan()
    saveBar.classList.add('visible')
    viewAllBtn.style.display = ''; viewSelBtn.style.display = ''
    viewLabel.textContent = `Найдено: ${rooms.length} помещений — кликни для выбора`

  } catch(e) {
    alert('Ошибка: ' + e.message)
  } finally {
    hideProgress()
    analyseBtn.disabled = false
  }
}

// ── Save ───────────────────────────────────────────────────
async function saveRoom(id, e) {
  e && e.stopPropagation()
  const room = rooms.find(r => r.id === id)
  if (!room) return
  const savePath = await ipcRenderer.invoke('save-dialog', `${sanitizeFilename(room.label)}.png`)
  if (!savePath) return
  const off = makeRoomCanvas(room)
  writeCanvas(off, savePath)
}

async function saveSelected() {
  if (!selectedRoomId) { alert('Сначала выбери помещение кликом'); return }
  await saveRoom(selectedRoomId)
}

async function saveAll() {
  const dir = await ipcRenderer.invoke('save-dir-dialog')
  if (!dir) return

  const combinedPath = path.join(dir, '00_все_помещения.png')
  writeCanvas(makeCombinedCanvas(), combinedPath)

  rooms.forEach((room, idx) => {
    const fname = path.join(dir, `${String(idx+1).padStart(2,'0')}_${sanitizeFilename(room.label)}.png`)
    writeCanvas(makeRoomCanvas(room), fname)
  })

  alert(`Сохранено ${rooms.length + 1} файлов в:\n${dir}`)
}

function makeRoomCanvas(room) {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.fillStyle = '#fff'; c.fillRect(0, 0, w, h)
  c.drawImage(currentImageEl, 0, 0)
  if (room.polygon?.length >= 3) {
    c.beginPath(); c.moveTo(room.polygon[0][0], room.polygon[0][1])
    room.polygon.slice(1).forEach(([x,y]) => c.lineTo(x, y)); c.closePath()
    c.globalAlpha = 0.65; c.fillStyle = '#c9ffd4'; c.fill()
    c.globalAlpha = 1; c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 2; c.stroke()
    // Label
    const cx = room.polygon.reduce((s,p)=>s+p[0],0)/room.polygon.length
    const cy = room.polygon.reduce((s,p)=>s+p[1],0)/room.polygon.length
    c.font = `bold ${Math.max(14, Math.round(w/60))}px -apple-system, sans-serif`
    c.textAlign = 'center'; c.textBaseline = 'middle'
    const tw = c.measureText(room.label).width + 16
    c.fillStyle = 'rgba(255,255,255,0.88)'; c.fillRect(cx-tw/2, cy-12, tw, 24)
    c.fillStyle = '#1d1d1f'; c.fillText(room.label, cx, cy)
  }
  return off
}

function makeCombinedCanvas() {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.fillStyle = '#fff'; c.fillRect(0,0,w,h)
  c.drawImage(currentImageEl, 0, 0)
  rooms.forEach((room, idx) => {
    if (!room.polygon?.length) return
    c.beginPath(); c.moveTo(room.polygon[0][0], room.polygon[0][1])
    room.polygon.slice(1).forEach(([x,y]) => c.lineTo(x,y)); c.closePath()
    c.globalAlpha = HIGHLIGHT_ALPHA
    c.fillStyle = PALETTE[idx % PALETTE.length]; c.fill()
    c.globalAlpha = 1; c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = 1.5; c.stroke()
  })
  return off
}

function writeCanvas(off, filePath) {
  const buf = Buffer.from(off.toDataURL('image/png').split(',')[1], 'base64')
  fs.writeFileSync(filePath, buf)
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60)
}

// ── Progress ───────────────────────────────────────────────
function showProgress(text, step) {
  progressText.textContent = text; progressStep.textContent = step || ''
  progressOverlay.classList.add('visible')
}
function setProgressStep(s) { progressStep.textContent = s }
function hideProgress() { progressOverlay.classList.remove('visible') }

// ── Boot ───────────────────────────────────────────────────
init()
