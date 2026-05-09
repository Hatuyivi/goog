// planner.js — renderer process
// Two recognition modes:
//   • Local CV  — pure-JS image processing in renderer (no internet)
//   • AI (API)  — sends image to Gemini/OpenRouter via main process

const { ipcRenderer } = require('electron')
const fs   = require('fs')
const path = require('path')

// ── State ──────────────────────────────────────────────────
let currentImageB64  = null
let currentMime      = 'image/jpeg'
let currentImageEl   = null
let currentImageBW   = null   // offscreen B&W canvas (for export)
let rooms            = []
let originalRooms    = []     // snapshot at recognition time — for training diff
let selectedRoomId   = null
let currentView      = 'all'
let mode             = 'local'  // 'local' | 'ai'

// ── Edit state ─────────────────────────────────────────────
let editMode         = 'view'   // 'view' | 'edit' | 'delete' | 'collider' | 'eraser' | 'rescan' | 'crop'
let dragState        = null     // { roomId, ptIdx }
let hoverState       = null     // { roomId, ptIdx, edgeIdx } — what cursor is over
let hasUnsavedEdits  = false
let trainingCount    = 0        // cached count of saved training samples

const ROOM_COLOR   = '#c9ffd4'
const ROOM_ALPHA   = 0.55
const STROKE_COLOR = 'rgba(60,160,80,0.75)'
const STROKE_WIDTH = 2

// ── DOM ────────────────────────────────────────────────────
const canvas            = document.getElementById('planCanvas')
const ctx               = canvas.getContext('2d')
const dropzone          = document.getElementById('dropzone')
const previewThumb      = document.getElementById('previewThumb')
const previewImg        = document.getElementById('previewImg')
const analyseBtn        = document.getElementById('analyseBtn')
const roomsList         = document.getElementById('roomsList')
const roomsEmpty        = document.getElementById('roomsEmpty')
const roomsTitle        = document.getElementById('roomsTitle')
const roomsDivider      = document.getElementById('roomsDivider')
const progressOverlay   = document.getElementById('progressOverlay')
const progressText      = document.getElementById('progressText')
const progressStep      = document.getElementById('progressStep')
const saveBar           = document.getElementById('saveBar')
const roomCount         = document.getElementById('roomCount')
const viewLabel         = document.getElementById('viewLabel')
const viewAllBtn        = document.getElementById('viewAll')
const viewSelBtn        = document.getElementById('viewSelected')
const canvasPlaceholder = document.getElementById('canvasPlaceholder')
const activeModelLabel  = document.getElementById('activeModelLabel')
const aiInfo            = document.getElementById('aiInfo')
const localParams       = document.getElementById('localParams')
const editToolbar       = document.getElementById('editToolbar')
const saveEditsBtn      = document.getElementById('saveEditsBtn')
const trainingBadge     = document.getElementById('trainingBadge')

const paramThreshold = document.getElementById('paramThreshold')
const paramEpsilon   = document.getElementById('paramEpsilon')
const vThr = document.getElementById('vThr')
const vEps = document.getElementById('vEps')

if (paramThreshold) paramThreshold.oninput = () => { if (vThr) vThr.textContent = paramThreshold.value === '0' ? 'авто' : paramThreshold.value }
if (paramEpsilon)   paramEpsilon.oninput   = () => { if (vEps) vEps.textContent = `${paramEpsilon.value} px` }

// ── Init ───────────────────────────────────────────────────
async function init() {
  await updateModelLabel()
  ipcRenderer.on('planner-model-changed', (_, model) => {
    if (activeModelLabel) {
      if (!model) {
        activeModelLabel.textContent = 'Нет модели — выбери в меню ⌂'
      } else {
        const provLabel = model.provider === 'openrouter'  ? 'OpenRouter'
                        : model.provider === 'cloudflare'  ? 'Cloudflare AI'
                        : model.provider === 'local'       ? 'Локально'
                        : 'Gemini'
        activeModelLabel.textContent = `${provLabel} · ${model.label}`
      }
    }
  })
}

async function updateModelLabel() {
  const model = await ipcRenderer.invoke('get-active-model')
  if (activeModelLabel) {
    if (!model) {
      activeModelLabel.textContent = 'Нет модели — выбери в меню ⌂'
    } else {
      const provLabel = model.provider === 'openrouter'  ? 'OpenRouter'
                      : model.provider === 'cloudflare'  ? 'Cloudflare AI'
                      : model.provider === 'local'       ? 'Локально'
                      : 'Gemini'
      activeModelLabel.textContent = `${provLabel} · ${model.label}`
    }
  }
}

// ── Mode toggle ────────────────────────────────────────────
function setMode(m) {
  mode = m
  document.getElementById('modeLocal').classList.toggle('active', m === 'local')
  document.getElementById('modeAi').classList.toggle('active',    m === 'ai')
  localParams.classList.toggle('visible', m === 'local')
  aiInfo.style.display = m === 'ai' ? '' : 'none'
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
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
    currentMime     = mimeMap[ext] || 'image/jpeg'
    currentImageB64 = buf.toString('base64')

    previewImg.src = `data:${currentMime};base64,${currentImageB64}`
    previewThumb.style.display = 'block'
    dropzone.style.display = 'none'
    analyseBtn.disabled = false
    clearResults()

    const img = new Image()
    img.onload = () => {
      currentImageEl = img
      currentImageBW = makeBWCanvas(img)
      resizeCanvas(img)
      drawPlan()
      document.getElementById('canvasGroup').style.display = ''
      canvas.style.display = 'block'
      canvasPlaceholder.style.display = 'none'
      viewLabel.textContent = 'Нажми «Распознать помещения»'
    }
    img.src = `data:${currentMime};base64,${currentImageB64}`
  } catch(e) { alert('Ошибка загрузки: ' + e.message) }
}

// Offscreen B&W canvas (used for export visuals)
function makeBWCanvas(img) {
  const off = document.createElement('canvas')
  off.width = img.naturalWidth; off.height = img.naturalHeight
  const c = off.getContext('2d')
  c.drawImage(img, 0, 0)
  const imageData = c.getImageData(0, 0, off.width, off.height)
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]
    d[i] = d[i+1] = d[i+2] = gray
  }
  c.putImageData(imageData, 0, 0)
  return off
}

function resizeCanvas(img) {
  const maxW = 1600, maxH = 1000
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
  canvas.width  = Math.round(img.naturalWidth  * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
}

function clearPlan() {
  currentImageB64 = null; currentImageEl = null; currentImageBW = null
  previewThumb.style.display = 'none'; dropzone.style.display = 'block'
  canvas.style.display = 'none'; canvasPlaceholder.style.display = 'flex'
  document.getElementById('canvasGroup').style.display = 'none'
  analyseBtn.disabled = true
  viewLabel.textContent = 'Загрузи план слева'
  viewAllBtn.style.display = 'none'; viewSelBtn.style.display = 'none'
  clearResults()
}

function clearResults() {
  rooms = []; originalRooms = []; selectedRoomId = null
  hasUnsavedEdits = false; dragState = null; hoverState = null
  saveBar.classList.remove('visible')
  editToolbar.classList.remove('visible')
  roomsTitle.style.display = 'none'; roomsDivider.style.display = 'none'
  roomsList.innerHTML = ''; roomsList.appendChild(roomsEmpty); roomsEmpty.style.display = 'block'
  if (currentImageEl) drawPlan()
}

// ── Canvas render ──────────────────────────────────────────
function drawPlan() {
  if (!currentImageEl) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const sx = canvas.width  / currentImageEl.naturalWidth
  const sy = canvas.height / currentImageEl.naturalHeight

  if (rooms.length && currentImageBW) {
    ctx.drawImage(currentImageBW, 0, 0, canvas.width, canvas.height)
  } else {
    ctx.drawImage(currentImageEl, 0, 0, canvas.width, canvas.height)
    return
  }

  rooms.forEach(room => {
    if (!room.polygon || room.polygon.length < 3) return
    const isSelected = room.id === selectedRoomId
    const show = currentView === 'all' || isSelected
    if (!show) return

    const pts = room.polygon.map(([x, y]) => [x * sx, y * sy])

    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y))
    ctx.closePath()

    ctx.globalAlpha = isSelected ? 0.78 : ROOM_ALPHA
    ctx.fillStyle   = ROOM_COLOR
    ctx.fill()

    ctx.globalAlpha = 1
    ctx.strokeStyle = isSelected ? 'rgba(30,120,60,0.95)' : STROKE_COLOR
    ctx.lineWidth   = isSelected ? 3 : STROKE_WIDTH
    ctx.stroke()

    // label
    const cx = pts.reduce((s,p)=>s+p[0],0) / pts.length
    const cy = pts.reduce((s,p)=>s+p[1],0) / pts.length
    const fontSize = Math.max(11, Math.min(16, Math.round(canvas.width / 80)))
    ctx.font = `600 ${fontSize}px -apple-system, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const tw = ctx.measureText(room.label).width + 10
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.fillRect(cx - tw/2, cy - fontSize*0.7, tw, fontSize*1.4)
    ctx.fillStyle = '#1d1d1f'
    ctx.fillText(room.label, cx, cy)
  })

  // Draw vertices in edit mode
  if (editMode === 'edit') {
    for (const room of rooms) {
      if (!room.polygon) continue
      if (currentView === 'selected' && room.id !== selectedRoomId) continue
      const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])

      // Draw edge midpoints as faint add-points
      for (let i = 0; i < pts.length; i++) {
        const j = (i+1) % pts.length
        const mx = (pts[i][0]+pts[j][0])/2, my = (pts[i][1]+pts[j][1])/2
        const isHovered = hoverState?.roomId===room.id && hoverState?.edgeIdx===i
        ctx.globalAlpha = isHovered ? 1 : 0.35
        ctx.beginPath(); ctx.arc(mx, my, isHovered ? 5 : 3, 0, Math.PI*2)
        ctx.fillStyle = '#007aff'; ctx.fill()
      }

      // Draw vertices
      for (let i = 0; i < pts.length; i++) {
        const isHovered = hoverState?.roomId===room.id && hoverState?.ptIdx===i
        const isDragging = dragState?.roomId===room.id && dragState?.ptIdx===i
        const r = (isHovered || isDragging) ? 7 : 5
        ctx.globalAlpha = 1
        ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], r, 0, Math.PI*2)
        ctx.fillStyle = isDragging ? '#ff9500' : isHovered ? '#ff3b30' : '#fff'
        ctx.fill()
        ctx.strokeStyle = isDragging ? '#ff6a00' : isHovered ? '#cc1000' : 'rgba(30,120,60,0.9)'
        ctx.lineWidth = 2; ctx.stroke()
      }
    }
  }

  ctx.globalAlpha = 1
}

// ── Click handler (view mode only — edit/delete handled in mousedown) ─────
canvas.addEventListener('click', e => {
  if (editMode !== 'view') return
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
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('selected'))
  drawPlan()
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
  drawPlan()
}

function selectRoom(id) {
  selectedRoomId = id
  document.querySelectorAll('.room-item').forEach(el => el.classList.toggle('selected', el.dataset.id === id))
  drawPlan()
  const el = document.querySelector(`.room-item[data-id="${id}"]`)
  if (el) el.scrollIntoView({ block: 'nearest' })
}

function buildRoomList() {
  roomsList.innerHTML = ''
  if (!rooms.length) { roomsList.appendChild(roomsEmpty); roomsEmpty.style.display = 'block'; return }
  roomsEmpty.style.display = 'none'
  roomsTitle.style.display = 'block'; roomsDivider.style.display = 'block'
  roomCount.textContent = rooms.length

  rooms.forEach(room => {
    const item = document.createElement('div')
    item.className = 'room-item'; item.dataset.id = room.id
    const areaText = room.areaPx ? `${(room.areaPx/1000).toFixed(1)}k px²` : ''
    item.innerHTML = `
      <div class="room-dot"></div>
      <span class="room-label" title="${room.label}">${room.label}</span>
      <span class="room-area">${areaText}</span>
      <button class="room-save" title="Сохранить PNG" onclick="saveRoom('${room.id}',event)">💾</button>
    `
    item.addEventListener('click', () => selectRoom(room.id))
    roomsList.appendChild(item)
  })
}

// ── Analyse (dispatcher) ───────────────────────────────────
async function analysePlan() {
  if (!currentImageB64) return
  analyseBtn.disabled = true
  try {
    if (mode === 'local') await analyseLocal()
    else                  await analyseAI()
  } catch(e) {
    alert('Ошибка: ' + e.message)
  } finally {
    hideProgress()
    analyseBtn.disabled = false
  }
}

async function analyseAI() {
  const model = await ipcRenderer.invoke('get-active-model')
  const provLabel = !model              ? '…'
                  : model.provider === 'openrouter'  ? 'OpenRouter'
                  : model.provider === 'cloudflare'  ? 'Cloudflare AI'
                  : model.provider === 'local'       ? 'Локально'
                  : 'Gemini'
  showProgress('Отправляем план в Vision API…',
    model ? `${provLabel} · ${model.label}` : '…')
  setProgressStep('ИИ анализирует план…')

  const result = await ipcRenderer.invoke('planner-analyse', {
    b64:  currentImageB64,
    mime: currentMime,
    imgW: currentImageEl.naturalWidth,
    imgH: currentImageEl.naturalHeight,
  })
  if (!result) throw new Error('Нет ответа от API. Проверь настройки модели в меню ⌂')
  if (result.error) throw new Error(result.error)
  rooms = Array.isArray(result.rooms) ? result.rooms : []
  if (!rooms.length) throw new Error('Помещения не найдены. Попробуй другую модель в меню Σ или более чёткий план.')

  finishAnalysis()
}

async function analyseLocal() {
  showProgress('Локальный анализ…', 'Подготовка изображения')
  await tick()

  const tManual = paramThreshold ? Number(paramThreshold.value) : 0
  const dilateK = 2
  const minPct  = 0.003
  const epsilon = paramEpsilon ? Number(paramEpsilon.value) : 3

  setProgressStep('Поиск стен и помещений…')
  await tick()

  rooms = await detectRoomsLocal(currentImageEl, {
    threshold: tManual || null,
    dilateK,
    minAreaFrac: minPct,
    epsilon,
  })
  if (!rooms.length) throw new Error('Помещения не найдены. Попробуй уменьшить «Мин. площадь» или включить «Утолщение стен».')

  finishAnalysis()
}

function finishAnalysis() {
  // Regularize polygons: remove staircase artifacts, snap to ortho, fit arcs
  regularizeAll()
  // Snapshot for training diff
  originalRooms = rooms.map(r => ({ ...r, polygon: r.polygon.map(p => [...p]) }))
  hasUnsavedEdits = false
  buildRoomList()
  drawPlan()
  saveBar.classList.add('visible')
  viewAllBtn.style.display = ''; viewSelBtn.style.display = ''
  viewLabel.textContent = `Найдено: ${rooms.length} помещений — кликни для выбора`
  editToolbar.classList.add('visible')
  saveEditsBtn.style.display = 'none'
  setEditMode('view')
  updateTrainingBadge()
}

// ── Edit mode ──────────────────────────────────────────────
function setEditMode(m) {
  // Exit crop mode cleanly
  if (editMode === 'crop' && m !== 'crop') {
    const overlay = document.getElementById('cropOverlay')
    if (overlay) overlay.style.display = 'none'
  }
  editMode = m
  // Toggle all mode buttons
  const btnMap = { view: 'emodeView', edit: 'emodeEdit', delete: 'emodeDelete',
                   collider: 'emodeDraw', eraser: 'emodeEraser', rescan: 'emodeRescan' }
  Object.entries(btnMap).forEach(([mode, id]) => {
    const el = document.getElementById(id)
    if (el) el.classList.toggle('active', m === mode)
  })
  const undoBtn = document.getElementById('undoBtn')
  if (undoBtn) undoBtn.disabled = undoStack.length === 0
  canvas.className = m !== 'view' ? `mode-${m}` : ''
  hoverState = null
  dragState  = null
  // Eraser cursor size display
  const eraserSpan = document.getElementById('eraserSizeVal')
  if (eraserSpan) eraserSpan.textContent = eraserSize
  // Crop mode: show overlay
  if (m === 'crop') initCropOverlay()
  drawPlan()
}

// ── Canvas hit testing ─────────────────────────────────────
const VERTEX_HIT_R  = 8   // px on screen
const EDGE_HIT_R    = 6

function canvasToImage(cx, cy) {
  if (!currentImageEl) return [cx, cy]
  return [
    cx * currentImageEl.naturalWidth  / canvas.width,
    cy * currentImageEl.naturalHeight / canvas.height,
  ]
}
function imageToCanvas(ix, iy) {
  if (!currentImageEl) return [ix, iy]
  return [
    ix * canvas.width  / currentImageEl.naturalWidth,
    iy * canvas.height / currentImageEl.naturalHeight,
  ]
}

function ptDistSq(ax, ay, bx, by) { return (ax-bx)**2 + (ay-by)**2 }

function segDistSq(px, py, ax, ay, bx, by) {
  const dx = bx-ax, dy = by-ay
  const lenSq = dx*dx + dy*dy
  if (lenSq === 0) return ptDistSq(px, py, ax, ay)
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq))
  return ptDistSq(px, py, ax + t*dx, ay + t*dy)
}

// Returns {roomId, ptIdx} for nearest vertex, or {roomId, edgeIdx} for nearest edge, or null
function hitTest(cx, cy) {
  if (!rooms.length || !currentImageEl) return null
  const sx = canvas.width  / currentImageEl.naturalWidth
  const sy = canvas.height / currentImageEl.naturalHeight
  let bestVDist = VERTEX_HIT_R * VERTEX_HIT_R
  let bestEDist = EDGE_HIT_R * EDGE_HIT_R
  let bestV = null, bestE = null

  for (const room of rooms) {
    if (!room.polygon) continue
    const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])
    // Check vertices
    for (let i = 0; i < pts.length; i++) {
      const d = ptDistSq(cx, cy, pts[i][0], pts[i][1])
      if (d < bestVDist) { bestVDist = d; bestV = { roomId: room.id, ptIdx: i } }
    }
    // Check edges
    for (let i = 0; i < pts.length; i++) {
      const j = (i+1) % pts.length
      const d = segDistSq(cx, cy, pts[i][0], pts[i][1], pts[j][0], pts[j][1])
      if (d < bestEDist) { bestEDist = d; bestE = { roomId: room.id, edgeIdx: i } }
    }
  }
  return bestV || bestE || null
}

// ── Polygon editing ────────────────────────────────────────
function markEdited() {
  hasUnsavedEdits = true
  saveEditsBtn.style.display = ''
}

function deleteRoom(id) {
  rooms = rooms.filter(r => r.id !== id)
  if (selectedRoomId === id) selectedRoomId = null
  buildRoomList()
  drawPlan()
  markEdited()
}

function addVertexOnEdge(roomId, edgeIdx, cx, cy) {
  const room = rooms.find(r => r.id === roomId)
  if (!room) return
  const [ix, iy] = canvasToImage(cx, cy)
  const pt = [Math.round(ix), Math.round(iy)]
  room.polygon.splice(edgeIdx + 1, 0, pt)
  markEdited()
}

function removeVertex(roomId, ptIdx) {
  const room = rooms.find(r => r.id === roomId)
  if (!room || room.polygon.length <= 3) return  // keep minimum 3 pts
  room.polygon.splice(ptIdx, 1)
  markEdited()
}

// ── Canvas mouse events ────────────────────────────────────
function getCanvasXY(e) {
  const rect = canvas.getBoundingClientRect()
  return [
    (e.clientX - rect.left) * (canvas.width  / rect.width),
    (e.clientY - rect.top)  * (canvas.height / rect.height),
  ]
}

canvas.addEventListener('mousedown', e => {
  if (!rooms.length || !currentImageEl) return
  const [cx, cy] = getCanvasXY(e)

  if (editMode === 'delete') {
    // Delete whole room on click
    const sx = canvas.width  / currentImageEl.naturalWidth
    const sy = canvas.height / currentImageEl.naturalHeight
    for (const room of [...rooms].reverse()) {
      if (!room.polygon) continue
      const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])
      if (pointInPolygon(cx, cy, pts)) { deleteRoom(room.id); return }
    }
    return
  }

  if (editMode === 'edit') {
    const hit = hitTest(cx, cy)
    if (!hit) return
    if (hit.ptIdx !== undefined) {
      // Start dragging vertex — save original position for cancel-on-mouseleave
      const _room = rooms.find(r => r.id === hit.roomId)
      const _origPt = _room ? [..._room.polygon[hit.ptIdx]] : null
      dragState = { roomId: hit.roomId, ptIdx: hit.ptIdx, _origPt }
      selectRoom(hit.roomId)
      e.preventDefault()
    } else if (hit.edgeIdx !== undefined) {
      // Insert vertex on edge then start dragging it
      addVertexOnEdge(hit.roomId, hit.edgeIdx, cx, cy)
      const room = rooms.find(r => r.id === hit.roomId)
      const newIdx = hit.edgeIdx + 1
      const _origPt = room ? [...room.polygon[newIdx]] : null
      dragState = { roomId: hit.roomId, ptIdx: newIdx, _origPt, _isNew: true }
      selectRoom(hit.roomId)
      e.preventDefault()
    }
    return
  }

  // view mode: room selection handled by the 'click' event listener below
})

canvas.addEventListener('mousemove', e => {
  if (!rooms.length || !currentImageEl) return
  const [cx, cy] = getCanvasXY(e)

  if (dragState) {
    // Move dragged vertex
    const room = rooms.find(r => r.id === dragState.roomId)
    if (room) {
      const [ix, iy] = canvasToImage(cx, cy)
      room.polygon[dragState.ptIdx] = [Math.round(ix), Math.round(iy)]
      drawPlan()
    }
    return
  }

  if (editMode === 'edit') {
    const prevHover = JSON.stringify(hoverState)
    hoverState = hitTest(cx, cy)
    if (JSON.stringify(hoverState) !== prevHover) drawPlan()
    // Cursor
    if (hoverState?.ptIdx !== undefined) canvas.style.cursor = 'grab'
    else if (hoverState?.edgeIdx !== undefined) canvas.style.cursor = 'cell'
    else canvas.style.cursor = 'crosshair'
    return
  }

  if (editMode === 'delete') {
    const sx = canvas.width  / currentImageEl.naturalWidth
    const sy = canvas.height / currentImageEl.naturalHeight
    for (const room of rooms) {
      if (!room.polygon) continue
      const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])
      if (pointInPolygon(cx, cy, pts)) { canvas.style.cursor = 'not-allowed'; return }
    }
    canvas.style.cursor = 'default'; return
  }
})

canvas.addEventListener('mouseup', e => {
  if (dragState) {
    markEdited()
    dragState = null
    drawPlan()
  }
})

canvas.addEventListener('mouseleave', () => {
  // If dragging when cursor leaves — cancel drag without marking edited
  if (dragState) {
    const room = rooms.find(r => r.id === dragState.roomId)
    if (room) {
      if (dragState._isNew) {
        // Vertex was just inserted — remove it entirely
        room.polygon.splice(dragState.ptIdx, 1)
      } else if (dragState._origPt) {
        // Restore original position
        room.polygon[dragState.ptIdx] = dragState._origPt
      }
    }
    dragState = null
  }
  hoverState = null
  if (editMode !== 'view') canvas.style.cursor = editMode === 'delete' ? 'not-allowed' : 'crosshair'
  drawPlan()
})

canvas.addEventListener('dblclick', e => {
  if (editMode !== 'edit') return
  const [cx, cy] = getCanvasXY(e)
  const hit = hitTest(cx, cy)
  if (hit?.ptIdx !== undefined) {
    removeVertex(hit.roomId, hit.ptIdx)
    hoverState = null
    drawPlan()
  }
})

// ── Training ───────────────────────────────────────────────
async function updateTrainingBadge() {
  const data = await ipcRenderer.invoke('get-training-data')
  trainingCount = data.length
  trainingBadge.textContent = `✦ ${trainingCount} образц${trainingCount === 1 ? '' : trainingCount < 5 ? 'а' : 'ов'}`
  trainingBadge.classList.toggle('visible', trainingCount > 0)
}

function imageHash() {
  // Simple hash from first 200 chars of b64 + image dimensions
  if (!currentImageB64) return 'none'
  return `${currentImageEl?.naturalWidth}x${currentImageEl?.naturalHeight}_${currentImageB64.slice(0, 80)}`
}

async function saveEdits() {
  const hash = imageHash()
  const deletedIds = originalRooms
    .filter(o => !rooms.find(r => r.id === o.id))
    .map(o => o.id)

  const sample = {
    imageHash:  hash,
    savedAt:    new Date().toISOString(),
    original:   originalRooms,
    edited:     rooms.map(r => ({ ...r, polygon: r.polygon.map(p => [...p]) })),
    deletedIds,
  }

  const count = await ipcRenderer.invoke('save-training-sample', sample)
  hasUnsavedEdits = false
  saveEditsBtn.style.display = 'none'
  trainingCount = count
  await updateTrainingBadge()

  // Brief visual confirmation
  const orig = trainingBadge.style.background
  trainingBadge.style.background = '#d4f8df'
  setTimeout(() => { trainingBadge.style.background = orig }, 800)
}

function tick() { return new Promise(r => setTimeout(r, 0)) }

// ── Local CV pipeline ──────────────────────────────────────
async function detectRoomsLocal(imageEl, opts) {
  const W0 = imageEl.naturalWidth, H0 = imageEl.naturalHeight

  // Downscale for speed — but keep enough detail for small rooms
  const MAX_DIM = 2000
  const scale = Math.min(1, MAX_DIM / Math.max(W0, H0))
  const W = Math.round(W0 * scale), H = Math.round(H0 * scale)

  const work = document.createElement('canvas')
  work.width = W; work.height = H
  const wctx = work.getContext('2d')
  wctx.drawImage(imageEl, 0, 0, W, H)
  const px = wctx.getImageData(0, 0, W, H).data

  // Grayscale
  const gray = new Uint8Array(W * H)
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114) | 0
  }

  // ── Multi-level threshold ──────────────────────────────
  // Run two passes: global Otsu + a slightly lower threshold to catch
  // rooms whose walls are lighter (partial walls, dashed lines).
  const T_global = opts.threshold != null ? opts.threshold : otsu(gray)
  // Second threshold slightly lower catches semi-dark boundaries
  const T_loose  = Math.max(T_global - 30, 80)

  // Binary pass 1: strict (main structure)
  const binStrict = new Uint8Array(W * H)
  for (let i = 0; i < gray.length; i++) binStrict[i] = gray[i] > T_global ? 1 : 0

  // Binary pass 2: loose (small rooms inside thick walls)
  const binLoose = new Uint8Array(W * H)
  for (let i = 0; i < gray.length; i++) binLoose[i] = gray[i] > T_loose ? 1 : 0

  // Erode to thicken walls on both
  let bin1 = binStrict, bin2 = binLoose
  for (let i = 0; i < opts.dilateK; i++) { bin1 = erode4(bin1, W, H); bin2 = erode4(bin2, W, H) }
  // Extra erode pass on loose to ensure walls are solid
  bin2 = erode4(bin2, W, H)

  // ── Connected components ────────────────────────────────
  function floodFill(bin) {
    const labels = new Int32Array(W * H)
    const regions = []
    let nextLabel = 1
    const stack = new Int32Array(W * H)

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x
        if (bin[idx] !== 1 || labels[idx] !== 0) continue

        let minX = x, maxX = x, minY = y, maxY = y, area = 0
        let touchesBorder = false
        let sp = 0
        stack[sp++] = idx
        labels[idx] = nextLabel

        while (sp > 0) {
          const p = stack[--sp]
          const py = (p / W) | 0
          const pxx = p - py * W
          area++
          if (pxx < minX) minX = pxx; if (pxx > maxX) maxX = pxx
          if (py  < minY) minY = py;  if (py  > maxY) maxY = py
          if (pxx === 0 || py === 0 || pxx === W - 1 || py === H - 1) touchesBorder = true
          if (pxx > 0)     { const n = p-1; if (bin[n]===1 && labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
          if (pxx < W - 1) { const n = p+1; if (bin[n]===1 && labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
          if (py  > 0)     { const n = p-W; if (bin[n]===1 && labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
          if (py  < H - 1) { const n = p+W; if (bin[n]===1 && labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
        }
        regions.push({ label: nextLabel, minX, maxX, minY, maxY, area, touchesBorder })
        nextLabel++
      }
    }
    return { labels, regions }
  }

  const { labels: labels1, regions: regions1 } = floodFill(bin1)
  const { labels: labels2, regions: regions2 } = floodFill(bin2)

  // Заполнить дыры от мебели/деталей внутри помещений
  fillEnclosedHoles(labels1, regions1, W, H)
  fillEnclosedHoles(labels2, regions2, W, H)

  await tick()

  // ── Candidate filtering ─────────────────────────────────
  const total = W * H
  const minArea    = total * opts.minAreaFrac
  // No fixed maxArea ceiling — instead filter by bboxFill ratio
  // This lets us catch small rooms while still rejecting background.
  // Only reject regions that are overwhelmingly large (>70% of image)
  const maxArea    = total * 0.70

  function filterRegions(regions, fillRatioMin) {
    return regions.filter(r => {
      if (r.touchesBorder) return false
      if (r.area < minArea || r.area > maxArea) return false
      const bboxArea = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1)
      // Small rooms can have lower fill ratio (irregular shapes, notched walls)
      if (bboxArea > 0 && r.area / bboxArea < fillRatioMin) return false
      return true
    })
  }

  // Strict pass: normal fill threshold
  const cand1 = filterRegions(regions1, 0.30)
  // Loose pass: allow slightly lower fill ratio for small rooms
  const cand2 = filterRegions(regions2, 0.20)

  // ── Merge and deduplicate ───────────────────────────────
  // Prefer strict candidates; add loose ones that don't overlap with any strict.
  // Two regions "overlap" if their centroids are within ~30px or bboxes >50% IoU.
  function bbox(r) { return { x1: r.minX, y1: r.minY, x2: r.maxX, y2: r.maxY } }
  function iou(a, b) {
    const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1)
    const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2)
    if (ix2 <= ix1 || iy2 <= iy1) return 0
    const inter = (ix2 - ix1) * (iy2 - iy1)
    const unionA = (a.x2-a.x1)*(a.y2-a.y1) + (b.x2-b.x1)*(b.y2-b.y1) - inter
    return unionA <= 0 ? 0 : inter / unionA
  }

  const merged = [...cand1]
  const strictBoxes = cand1.map(bbox)
  for (const r of cand2) {
    const rb = bbox(r)
    const overlaps = strictBoxes.some(sb => iou(sb, rb) > 0.4)
    if (!overlaps) merged.push(r)
  }

  // ── Sort top-to-bottom, left-to-right ──────────────────
  merged.sort((a, b) => {
    const cyA = (a.minY + a.maxY) / 2, cyB = (b.minY + b.maxY) / 2
    if (Math.abs(cyA - cyB) > 20) return cyA - cyB
    return ((a.minX + a.maxX) / 2) - ((b.minX + b.maxX) / 2)
  })

  await tick()

  // ── Build polygons ──────────────────────────────────────
  const inv = 1 / scale
  const rooms = []

  for (let i = 0; i < merged.length; i++) {
    const r = merged[i]
    // Use the label map that produced this candidate
    const isFromLoose = !cand1.includes(r)
    const labelsMap   = isFromLoose ? labels2 : labels1

    const poly = traceContour(labelsMap, r.label, W, H, r)
    if (poly.length < 4) continue
    const simp = rdp(poly, opts.epsilon || 2)
    if (simp.length < 3) continue

    rooms.push({
      id:      `r${i + 1}`,
      label:   `Помещение ${i + 1}`,
      areaPx:  Math.round(r.area * inv * inv),
      polygon: simp.map(([x, y]) => [Math.round(x * inv), Math.round(y * inv)]),
    })
  }
  return rooms
}

// Otsu threshold
function otsu(gray) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, max = 0, threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > max) { max = between; threshold = t }
  }
  return threshold
}

// 4-connected erosion of value=1 (interior)
function erode4(bin, W, H) {
  const out = new Uint8Array(bin.length)
  for (let y = 1; y < H - 1; y++) {
    const off = y * W
    for (let x = 1; x < W - 1; x++) {
      const i = off + x
      out[i] = (bin[i] && bin[i-1] && bin[i+1] && bin[i-W] && bin[i+W]) ? 1 : 0
    }
  }
  return out
}


// ── Заполнение замкнутых дыр внутри помещений ─────────────────
// После flood fill пиксели мебели/штриховки/лестниц остаются с label=0
// внутри комнаты — это и есть «дыры». Алгоритм:
//   1. BFS от всех граничных пикселей с label=0 → «внешние» стены
//   2. Любой label=0 недостижимый снаружи — замкнутая дыра
//   3. Назначаем ей метку ближайшего соседа (=помещение вокруг)
// Безопаснее морфологического закрытия: не может объединить соседние комнаты.
function fillEnclosedHoles(labels, regions, W, H) {
  // Шаг 1: BFS от границы через label=0 пиксели
  const reachable = new Uint8Array(W * H)
  const queue = new Int32Array(W * H)
  let qHead = 0, qTail = 0

  function seed(p) {
    if (labels[p] === 0 && !reachable[p]) { reachable[p] = 1; queue[qTail++] = p }
  }
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x) }
  for (let y = 1; y < H - 1; y++) { seed(y * W); seed(y * W + W - 1) }

  while (qHead < qTail) {
    const p = queue[qHead++]
    const py = (p / W) | 0, px = p % W
    if (px > 0     && labels[p-1] === 0 && !reachable[p-1]) { reachable[p-1]=1; queue[qTail++]=p-1 }
    if (px < W - 1 && labels[p+1] === 0 && !reachable[p+1]) { reachable[p+1]=1; queue[qTail++]=p+1 }
    if (py > 0     && labels[p-W] === 0 && !reachable[p-W]) { reachable[p-W]=1; queue[qTail++]=p-W }
    if (py < H - 1 && labels[p+W] === 0 && !reachable[p+W]) { reachable[p+W]=1; queue[qTail++]=p+W }
  }

  // Шаг 2: заполнить замкнутые дыры — несколько волн расширения от соседей
  // Итерируем пока есть изменения (дыры могут быть больше 1 пикселя)
  let changed = true
  while (changed) {
    changed = false
    for (let p = 0; p < W * H; p++) {
      if (labels[p] !== 0 || reachable[p]) continue
      const py = (p / W) | 0, px = p % W
      let nb = 0
      if (px > 0     && labels[p-1] > 0) nb = labels[p-1]
      else if (px < W-1 && labels[p+1] > 0) nb = labels[p+1]
      else if (py > 0     && labels[p-W] > 0) nb = labels[p-W]
      else if (py < H-1  && labels[p+W] > 0) nb = labels[p+W]
      if (nb > 0) { labels[p] = nb; changed = true }
    }
  }

  // Шаг 3: пересчитать площади регионов
  const areaCnt = new Map()
  for (let p = 0; p < W * H; p++) {
    const lb = labels[p]
    if (lb > 0) areaCnt.set(lb, (areaCnt.get(lb) || 0) + 1)
  }
  for (const r of regions) {
    const updated = areaCnt.get(r.label)
    if (updated) r.area = updated
  }
}

// Moore-neighbor boundary tracing on a labeled region.
// Returns ordered list of [x,y] pixel coords forming a closed contour.
function traceContour(labels, label, W, H, region) {
  // Find topmost-leftmost pixel of region
  let sx = -1, sy = -1
  outer: for (let y = region.minY; y <= region.maxY; y++) {
    for (let x = region.minX; x <= region.maxX; x++) {
      if (labels[y * W + x] === label) { sx = x; sy = y; break outer }
    }
  }
  if (sx < 0) return []

  const isLabel = (x, y) =>
    x >= 0 && x < W && y >= 0 && y < H && labels[y * W + x] === label

  // 8-neighbor offsets, clockwise starting from East
  const dx = [ 1, 1, 0,-1,-1,-1, 0, 1]
  const dy = [ 0, 1, 1, 1, 0,-1,-1,-1]

  const poly = [[sx, sy]]
  let cx = sx, cy = sy
  // Came from West (since topmost-leftmost has nothing W or N)
  let backDir = 4

  const maxSteps = (region.maxX - region.minX + region.maxY - region.minY + 4) * 8
  for (let step = 0; step < maxSteps; step++) {
    let found = false
    // Search 8 directions clockwise starting from (backDir + 1)
    for (let i = 1; i <= 8; i++) {
      const d = (backDir + i) % 8
      const nx = cx + dx[d], ny = cy + dy[d]
      if (isLabel(nx, ny)) {
        cx = nx; cy = ny
        // New backtrack direction = opposite of approach direction
        backDir = (d + 4) % 8
        poly.push([cx, cy])
        found = true
        break
      }
    }
    if (!found) break  // isolated pixel
    if (cx === sx && cy === sy && poly.length > 2) break
  }
  return poly
}

// Ramer-Douglas-Peucker polygon simplification (iterative-safe)
function rdp(points, eps) {
  if (points.length < 3 || eps <= 0) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1; keep[points.length - 1] = 1

  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    let maxD = 0, idx = -1
    const [x1, y1] = points[a], [x2, y2] = points[b]
    const dxAB = x2 - x1, dyAB = y2 - y1
    const denom = dxAB * dxAB + dyAB * dyAB
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]
      let d
      if (denom === 0) {
        d = Math.hypot(px - x1, py - y1)
      } else {
        const t = ((px - x1) * dxAB + (py - y1) * dyAB) / denom
        const tx = x1 + t * dxAB, ty = y1 + t * dyAB
        d = Math.hypot(px - tx, py - ty)
      }
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx])
      stack.push([idx, b])
    }
  }
  const out = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

// ── Save ───────────────────────────────────────────────────
async function saveRoom(id, e) {
  e && e.stopPropagation()
  const room = rooms.find(r => r.id === id)
  if (!room) return
  const savePath = await ipcRenderer.invoke('save-dialog', `${sanitizeFilename(room.label)}.png`)
  if (!savePath) return
  writeCanvas(makeRoomCanvas(room), savePath)
}

async function saveSelected() {
  if (!selectedRoomId) { alert('Сначала выбери помещение кликом'); return }
  await saveRoom(selectedRoomId)
}

async function saveAll() {
  const dir = await ipcRenderer.invoke('save-dir-dialog')
  if (!dir) return
  writeCanvas(makeCombinedCanvas(), path.join(dir, '00_все_помещения.png'))
  rooms.forEach((room, idx) => {
    writeCanvas(makeRoomCanvas(room), path.join(dir, `${String(idx+1).padStart(2,'0')}_${sanitizeFilename(room.label)}.png`))
  })
  alert(`Сохранено ${rooms.length + 1} файлов в:\n${dir}`)
}

function makeRoomCanvas(room) {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.drawImage(currentImageBW || currentImageEl, 0, 0)
  if (room.polygon?.length >= 3) {
    c.beginPath()
    drawRoomPath(c, room, 1, 1)
    c.closePath()
    c.globalAlpha = 0.75; c.fillStyle = ROOM_COLOR; c.fill()
    c.globalAlpha = 1; c.strokeStyle = 'rgba(30,120,60,0.9)'; c.lineWidth = 3; c.stroke()
    const cx = room.polygon.reduce((s,p)=>s+p[0],0) / room.polygon.length
    const cy = room.polygon.reduce((s,p)=>s+p[1],0) / room.polygon.length
    const fs = Math.max(14, Math.round(w / 60))
    c.font = `bold ${fs}px -apple-system, sans-serif`
    c.textAlign = 'center'; c.textBaseline = 'middle'
    const tw = c.measureText(room.label).width + 16
    c.fillStyle = 'rgba(255,255,255,0.9)'; c.fillRect(cx-tw/2, cy-fs*0.75, tw, fs*1.5)
    c.fillStyle = '#1d1d1f'; c.fillText(room.label, cx, cy)
  }
  return off
}

function makeCombinedCanvas() {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.drawImage(currentImageBW || currentImageEl, 0, 0)
  rooms.forEach(room => {
    if (!room.polygon?.length) return
    c.beginPath()
    drawRoomPath(c, room, 1, 1)
    c.closePath()
    c.globalAlpha = ROOM_ALPHA; c.fillStyle = ROOM_COLOR; c.fill()
    c.globalAlpha = 1; c.strokeStyle = STROKE_COLOR; c.lineWidth = STROKE_WIDTH; c.stroke()
    const cx = room.polygon.reduce((s,p)=>s+p[0],0) / room.polygon.length
    const cy = room.polygon.reduce((s,p)=>s+p[1],0) / room.polygon.length
    const fs = Math.max(12, Math.round(w / 80))
    c.font = `600 ${fs}px -apple-system, sans-serif`
    c.textAlign = 'center'; c.textBaseline = 'middle'
    const tw = c.measureText(room.label).width + 12
    c.fillStyle = 'rgba(255,255,255,0.92)'
    c.fillRect(cx-tw/2, cy-fs*0.7, tw, fs*1.4)
    c.fillStyle = '#1d1d1f'
    c.fillText(room.label, cx, cy)
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

// ── Undo ──────────────────────────────────────────────────
const undoStack = []
const UNDO_MAX  = 30

function pushUndo() {
  undoStack.push(rooms.map(r => ({ ...r, polygon: r.polygon.map(p => [...p]) })))
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  const btn = document.getElementById('undoBtn')
  if (btn) btn.disabled = false
}

function undo() {
  if (!undoStack.length) return
  rooms = undoStack.pop()
  regularizeAll()  // re-apply regularization after undo
  if (selectedRoomId && !rooms.find(r => r.id === selectedRoomId)) selectedRoomId = null
  buildRoomList()
  drawPlan()
  const btn = document.getElementById('undoBtn')
  if (btn) btn.disabled = undoStack.length === 0
  hasUnsavedEdits = true
  saveEditsBtn.style.display = ''
}

// ── Zoom ───────────────────────────────────────────────────
let zoomLevel = 1.0
const ZOOM_MIN = 0.25, ZOOM_MAX = 8.0, ZOOM_STEP = 0.2

function applyZoom() {
  const group = document.getElementById('canvasGroup')
  const wrap  = document.querySelector('.canvas-wrap')
  if (!group || !wrap) return

  // CSS zoom (Chromium/Electron) — в отличие от transform:scale реально
  // раздвигает layout, поэтому overflow:auto даёт полосы прокрутки
  group.style.zoom      = zoomLevel
  group.style.transform = ''  // убрать старый scale если был

  if (zoomLevel > 1) {
    wrap.style.overflow       = 'auto'
    wrap.style.alignItems     = 'flex-start'
    wrap.style.justifyContent = 'flex-start'
  } else {
    wrap.style.overflow       = 'hidden'
    wrap.style.alignItems     = 'center'
    wrap.style.justifyContent = 'center'
  }

  const lbl = document.getElementById('zoomLabel')
  if (lbl) lbl.textContent = `${Math.round(zoomLevel * 100)}%`
}

function zoomIn()    { zoomLevel = Math.min(ZOOM_MAX, +(zoomLevel + ZOOM_STEP).toFixed(2)); applyZoom() }
function zoomOut()   { zoomLevel = Math.max(ZOOM_MIN, +(zoomLevel - ZOOM_STEP).toFixed(2)); applyZoom() }
function resetZoom() { zoomLevel = 1.0; applyZoom(); const wrap = document.querySelector('.canvas-wrap'); if (wrap) { wrap.scrollLeft = 0; wrap.scrollTop = 0 } }

// Зум колесом мыши над холстом (без Ctrl)
const _canvasWrap = document.querySelector('.canvas-wrap')
if (_canvasWrap) {
  _canvasWrap.addEventListener('wheel', e => {
    if (editMode === 'eraser') return  // ластик использует колесо сам
    e.preventDefault()
    e.deltaY < 0 ? zoomIn() : zoomOut()
  }, { passive: false })
}

// Панорамирование перетаскиванием (во всех режимах кроме edit/draw/eraser)
;(function initPan() {
  const wrap = document.querySelector('.canvas-wrap')
  if (!wrap) return
  let _pan = null  // { startX, startY, scrollLeft, scrollTop }

  wrap.addEventListener('mousedown', e => {
    // Только левая кнопка, только в view/delete/rescan/crop режимах
    if (e.button !== 0) return
    if (editMode === 'edit' || editMode === 'collider' || editMode === 'eraser') return
    // Если клик по канвасу — даём click-handler выбрать комнату,
    // но одновременно начинаем отслеживать drag
    _pan = { startX: e.clientX, startY: e.clientY,
             scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop,
             moved: false }
  })

  window.addEventListener('mousemove', e => {
    if (!_pan) return
    const dx = e.clientX - _pan.startX
    const dy = e.clientY - _pan.startY
    if (!_pan.moved && Math.hypot(dx, dy) < 4) return  // порог
    _pan.moved = true
    wrap.scrollLeft = _pan.scrollLeft - dx
    wrap.scrollTop  = _pan.scrollTop  - dy
    wrap.style.cursor = 'grabbing'
  })

  window.addEventListener('mouseup', () => {
    if (_pan) {
      wrap.style.cursor = ''
      _pan = null
    }
  })
})()

document.addEventListener('keydown', e => {
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn() }
  if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoomOut() }
  if (e.ctrlKey && e.key === '0') { e.preventDefault(); resetZoom() }
  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo() }
})

// ── Toggle polygons visibility ─────────────────────────────
let polygonsVisible = true
function togglePolygons() {
  polygonsVisible = !polygonsVisible
  const btn = document.getElementById('togglePolygonsBtn')
  if (btn) btn.classList.toggle('active', !polygonsVisible)
  drawPlan()
}

// ── Toggle B&W background ──────────────────────────────────
let showBW = true
function toggleBWBackground() {
  showBW = !showBW
  const btn = document.getElementById('toggleBWBtn')
  if (btn) btn.classList.toggle('active', showBW)
  drawPlan()
}

// ── Eraser ─────────────────────────────────────────────────
let eraserSize = 30
let _eraserActive = false

canvas.addEventListener('wheel', e => {
  if (editMode !== 'eraser') return
  e.preventDefault()
  eraserSize = Math.max(5, Math.min(200, eraserSize + (e.deltaY < 0 ? 5 : -5)))
  const sp = document.getElementById('eraserSizeVal')
  if (sp) sp.textContent = eraserSize
  drawPlan()
}, { passive: false })

canvas.addEventListener('mousedown', e => {
  if (editMode !== 'eraser') return
  _eraserActive = true
  applyEraser(e)
}, { capture: true })

canvas.addEventListener('mousemove', e => {
  if (editMode !== 'eraser') return
  if (_eraserActive) applyEraser(e)
  drawPlan()
  const [cx, cy] = getCanvasXY(e)
  ctx.save()
  ctx.globalAlpha = 0.6
  ctx.strokeStyle = '#ff3b30'
  ctx.lineWidth = 1.5
  ctx.setLineDash([3, 2])
  ctx.beginPath()
  ctx.arc(cx, cy, eraserSize / 2, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}, { capture: true })

canvas.addEventListener('mouseup', () => { _eraserActive = false })

function applyEraser(e) {
  if (!currentImageBW) return
  const [cx, cy] = getCanvasXY(e)
  const r = eraserSize / 2
  const scaleX = currentImageBW.width  / canvas.width
  const scaleY = currentImageBW.height / canvas.height
  const bwCtx  = currentImageBW.getContext('2d')
  bwCtx.save()
  bwCtx.globalCompositeOperation = 'source-over'
  bwCtx.fillStyle = '#ffffff'
  bwCtx.beginPath()
  bwCtx.arc(cx * scaleX, cy * scaleY, r * scaleX, 0, Math.PI * 2)
  bwCtx.fill()
  bwCtx.restore()
  drawPlan()
}

// ── Rescan zone ────────────────────────────────────────────
let _rescanStart = null
let _rescanRect  = null

canvas.addEventListener('mousedown', e => {
  if (editMode !== 'rescan') return
  const [cx, cy] = getCanvasXY(e)
  _rescanStart = [cx, cy]
  _rescanRect  = null
}, { capture: true })

canvas.addEventListener('mousemove', e => {
  if (editMode !== 'rescan' || !_rescanStart) return
  const [cx, cy] = getCanvasXY(e)
  _rescanRect = {
    x: Math.min(_rescanStart[0], cx), y: Math.min(_rescanStart[1], cy),
    w: Math.abs(cx - _rescanStart[0]),  h: Math.abs(cy - _rescanStart[1]),
  }
  drawPlan()
  if (_rescanRect.w > 2 && _rescanRect.h > 2) {
    ctx.save()
    ctx.strokeStyle = '#007aff'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3])
    ctx.strokeRect(_rescanRect.x, _rescanRect.y, _rescanRect.w, _rescanRect.h)
    ctx.globalAlpha = 0.08; ctx.fillStyle = '#007aff'
    ctx.fillRect(_rescanRect.x, _rescanRect.y, _rescanRect.w, _rescanRect.h)
    ctx.restore()
  }
}, { capture: true })

canvas.addEventListener('mouseup', async e => {
  if (editMode !== 'rescan' || !_rescanStart) return
  const rect = _rescanRect
  _rescanStart = null; _rescanRect = null
  if (!rect || rect.w < 20 || rect.h < 20) return

  const sx = currentImageEl.naturalWidth  / canvas.width
  const sy = currentImageEl.naturalHeight / canvas.height
  const ix = Math.round(rect.x * sx), iy = Math.round(rect.y * sy)
  const iw = Math.round(rect.w * sx), ih = Math.round(rect.h * sy)

  const tmp = document.createElement('canvas')
  tmp.width = iw; tmp.height = ih
  tmp.getContext('2d').drawImage(currentImageEl, ix, iy, iw, ih, 0, 0, iw, ih)

  showProgress('Доиск…', 'Анализ выделенной зоны')
  await tick()

  try {
    const tManual = Number(paramThreshold.value)
    const dilateK = Number(paramDilate.value)
    const minPct  = Number(paramMinArea.value) / 1000
    const epsilon = Number(paramEpsilon.value)

    const found = await detectRoomsLocal(tmp, {
      threshold: tManual || null, dilateK,
      minAreaFrac: minPct * 0.3,
      epsilon,
    })

    if (found.length) {
      pushUndo()
      found.forEach((r, i) => {
        r.id = `r_rs_${Date.now()}_${i}`
        r.polygon = r.polygon.map(([px, py]) => [px + ix, py + iy])
        rooms.push(r)
      })
      buildRoomList()
      drawPlan()
      markEdited()
    } else {
      alert('В выделенной зоне помещения не найдены.')
    }
  } catch(err) {
    alert('Ошибка доиска: ' + err.message)
  } finally {
    hideProgress()
  }
}, { capture: true })

// ── Collider (draw new room) ───────────────────────────────
let _colliderPts = []
let _colliderMovePt = null

canvas.addEventListener('mousedown', e => {
  if (editMode !== 'collider' || e.button !== 0) return
  const [cx, cy] = getCanvasXY(e)
  if (_colliderPts.length >= 3) {
    const [fx, fy] = _colliderPts[0]
    if (Math.hypot(cx - fx, cy - fy) < 12) { finalizeCollider(); return }
  }
  _colliderPts.push([cx, cy])
  drawPlan()
  _drawColliderPreview()
}, { capture: true })

canvas.addEventListener('mousemove', e => {
  if (editMode !== 'collider' || !_colliderPts.length) return
  const [cx, cy] = getCanvasXY(e)
  _colliderMovePt = [cx, cy]
  drawPlan()
  _drawColliderPreview()
}, { capture: true })

canvas.addEventListener('dblclick', e => {
  if (editMode !== 'collider' || _colliderPts.length < 3) return
  e.stopImmediatePropagation()
  finalizeCollider()
}, { capture: true })

canvas.addEventListener('contextmenu', e => {
  if (editMode !== 'collider') return
  e.preventDefault()
  if (_colliderPts.length > 0) _colliderPts.pop()
  drawPlan(); _drawColliderPreview()
})

function _drawColliderPreview() {
  if (!_colliderPts.length) return
  ctx.save()
  ctx.strokeStyle = '#007aff'; ctx.lineWidth = 2; ctx.setLineDash([5, 3])
  ctx.fillStyle = 'rgba(0,122,255,0.12)'
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.moveTo(_colliderPts[0][0], _colliderPts[0][1])
  _colliderPts.slice(1).forEach(([x,y]) => ctx.lineTo(x, y))
  if (_colliderMovePt) ctx.lineTo(_colliderMovePt[0], _colliderMovePt[1])
  ctx.stroke()
  if (_colliderPts.length >= 3) { ctx.closePath(); ctx.fill() }
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(_colliderPts[0][0], _colliderPts[0][1], 6, 0, Math.PI*2)
  ctx.fillStyle = '#007aff'; ctx.fill()
  _colliderPts.forEach(([x,y]) => {
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2)
    ctx.fillStyle = '#fff'; ctx.fill()
    ctx.strokeStyle = '#007aff'; ctx.lineWidth = 1.5; ctx.stroke()
  })
  ctx.restore()
}

function finalizeCollider() {
  if (_colliderPts.length < 3) { _colliderPts = []; return }
  const pts = _colliderPts.map(([cx,cy]) => {
    const [ix,iy] = canvasToImage(cx, cy)
    return [Math.round(ix), Math.round(iy)]
  })
  pushUndo()
  const id = `r_c_${Date.now()}`
  const newRoom = { id, label: `Помещение ${rooms.length + 1}`, areaPx: 0, polygon: pts }
  rooms.push(newRoom)
  regularizeRoom(newRoom)
  _colliderPts = []; _colliderMovePt = null
  buildRoomList()
  drawPlan()
  markEdited()
}

// ── Crop ───────────────────────────────────────────────────
let _cropRatio = 'free'
let _cropBox   = { x: 50, y: 50, w: 200, h: 150 }
let _cropDrag  = null

function initCropOverlay() {
  const overlay = document.getElementById('cropOverlay')
  const wrap    = document.querySelector('.canvas-wrap')
  const grp     = document.getElementById('canvasGroup')
  if (!overlay || !grp || !currentImageEl) return

  const gr = grp.getBoundingClientRect()
  const wr = wrap.getBoundingClientRect()
  overlay.style.display = 'block'
  overlay.style.position = 'absolute'
  overlay.style.left   = (gr.left - wr.left) + 'px'
  overlay.style.top    = (gr.top  - wr.top)  + 'px'
  overlay.style.width  = gr.width  + 'px'
  overlay.style.height = gr.height + 'px'

  const bw = Math.round(gr.width  * 0.7), bh = Math.round(gr.height * 0.7)
  _cropBox = { x: Math.round((gr.width - bw) / 2), y: Math.round((gr.height - bh) / 2), w: bw, h: bh }
  _applyCropBox()

  document.querySelectorAll('.crop-ratio-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ratio === _cropRatio)
    btn.onclick = () => {
      _cropRatio = btn.dataset.ratio
      document.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.toggle('active', b.dataset.ratio === _cropRatio))
    }
  })

  const boxEl = document.getElementById('cropBox')
  document.querySelectorAll('.crop-handle').forEach(handle => {
    handle.onmousedown = ev => {
      ev.preventDefault()
      _cropDrag = { h: handle.dataset.h, sx: ev.clientX, sy: ev.clientY, box: { ..._cropBox } }
      const onMove = em => _onCropHandleMove(em)
      const onUp   = () => { _cropDrag = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  })
  boxEl.onmousedown = ev => {
    if (ev.target.classList.contains('crop-handle')) return
    ev.preventDefault()
    _cropDrag = { h: 'move', sx: ev.clientX, sy: ev.clientY, box: { ..._cropBox } }
    const onMove = em => _onCropHandleMove(em)
    const onUp   = () => { _cropDrag = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
}

function _onCropHandleMove(e) {
  if (!_cropDrag) return
  const dx = e.clientX - _cropDrag.sx, dy = e.clientY - _cropDrag.sy
  let { x, y, w, h } = _cropDrag.box
  const MIN = 20
  const hDir = _cropDrag.h
  if (hDir === 'move') { x += dx; y += dy }
  if (hDir.includes('e'))  w = Math.max(MIN, w + dx)
  if (hDir.includes('s'))  h = Math.max(MIN, h + dy)
  if (hDir.includes('w'))  { const nw = Math.max(MIN, w - dx); x += w - nw; w = nw }
  if (hDir.includes('n'))  { const nh = Math.max(MIN, h - dy); y += h - nh; h = nh }
  if (_cropRatio !== 'free') {
    const [rw, rh] = _cropRatio.split(':').map(Number)
    h = Math.round(w * rh / rw)
  }
  _cropBox = { x, y, w, h }
  _applyCropBox()
}

function _applyCropBox() {
  const box = document.getElementById('cropBox')
  if (!box) return
  box.style.left   = _cropBox.x + 'px'
  box.style.top    = _cropBox.y + 'px'
  box.style.width  = _cropBox.w + 'px'
  box.style.height = _cropBox.h + 'px'
}

async function applyCrop() {
  if (!currentImageEl) return
  const scaleX = currentImageEl.naturalWidth  / canvas.width
  const scaleY = currentImageEl.naturalHeight / canvas.height
  const ix = Math.round(_cropBox.x * scaleX), iy = Math.round(_cropBox.y * scaleY)
  const iw = Math.round(_cropBox.w * scaleX), ih = Math.round(_cropBox.h * scaleY)
  if (iw < 10 || ih < 10) return

  const tmp = document.createElement('canvas')
  tmp.width = iw; tmp.height = ih
  tmp.getContext('2d').drawImage(currentImageEl, ix, iy, iw, ih, 0, 0, iw, ih)
  currentImageB64 = tmp.toDataURL(currentMime).split(',')[1]

  const newImg = new Image()
  newImg.onload = () => {
    currentImageEl = newImg
    currentImageBW = makeBWCanvas(newImg)
    resizeCanvas(newImg)
    rooms.forEach(r => {
      if (!r.polygon) return
      r.polygon = r.polygon
        .map(([px, py]) => [px - ix, py - iy])
        .filter(([px, py]) => px >= 0 && py >= 0 && px <= iw && py <= ih)
    })
    rooms = rooms.filter(r => r.polygon && r.polygon.length >= 3)
    buildRoomList()
    drawPlan()
    markEdited()
  }
  newImg.src = tmp.toDataURL(currentMime)
  setEditMode('view')
}

// ── Save checked (export selected rooms) ──────────────────
function saveChecked() {
  const checked = [...document.querySelectorAll('.room-check:checked')]
  if (!checked.length) { alert('Отметь помещения галочкой'); return }
  const ids = checked.map(el => el.closest('.room-item')?.dataset?.id).filter(Boolean)
  const selected = rooms.filter(r => ids.includes(r.id))
  if (!selected.length) return
  ipcRenderer.invoke('save-dir-dialog').then(dir => {
    if (!dir) return
    selected.forEach((room, idx) => {
      writeCanvas(makeRoomCanvas(room),
        path.join(dir, `${String(idx+1).padStart(2,'0')}_${sanitizeFilename(room.label)}.png`))
    })
    alert(`Экспортировано ${selected.length} помещений в:\n${dir}`)
  })
}


// ══════════════════════════════════════════════════════════════
// ── Polygon Regularization ────────────────────────────────────
// Превращает «лесенчатые» пиксельные контуры в аккуратные
// геометрические фигуры:
//   1. Collinear merge   — убирает лишние точки на прямых
//   2. Orthogonalize     — выравнивает рёбра по 0° / 90°
//   3. Arc fitting       — заменяет серии точек дугами окружности
//
// room.segments — массив {type:'line'|'arc', ...} для рендеринга
// room.polygon  — обновляется семплированными точками
// ══════════════════════════════════════════════════════════════

const REG = {
  // Порог угла (°) для слияния коллинеарных вершин
  collinearDeg:   8,
  // Порог (°) для snap рёбер к ближайшему кратному 90°
  // от доминирующей ориентации помещения
  orthoDeg:       22,
  // Мин. точек на дуге для детектирования
  arcMinPts:      5,
  // Макс. RMS отклонение (px в координатах изображения) для дуги
  arcMaxRms:      4.0,
  // Мин. угловой диапазон дуги (°)
  arcMinSpanDeg:  20,
}

// ── helpers ───────────────────────────────────────────────────
function _angle(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax)
}
function _angleDiff(a, b) {
  let d = ((b - a) * 180 / Math.PI) % 360
  if (d >  180) d -= 360
  if (d < -180) d += 360
  return d
}
function _dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay)
}
function _ptDistToLine(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return _dist(px, py, ax, ay)
  const t = ((px - ax) * dx + (py - ay) * dy) / len2
  return _dist(px, py, ax + t * dx, ay + t * dy)
}

// Наименьший квадрат — центр и радиус окружности через 3+ точки
// Возвращает {cx, cy, r, rms} или null
function _fitCircle(pts) {
  if (pts.length < 3) return null
  // Kåsa / algebraic fit: minimise (x-cx)²+(y-cy)²-r²
  // Reduce to linear: 2cx·xi + 2cy·yi + c = xi²+yi²  where c = r²-cx²-cy²
  const n = pts.length
  let sumX=0, sumY=0, sumX2=0, sumY2=0, sumXY=0, sumR=0, sumXR=0, sumYR=0
  for (const [x, y] of pts) {
    const r2 = x*x + y*y
    sumX  += x;  sumY  += y
    sumX2 += x*x; sumY2 += y*y; sumXY += x*y
    sumR  += r2; sumXR += x*r2; sumYR += y*r2
  }
  // Normal equations (3×3 linear system)
  const A = [[2*sumX2, 2*sumXY, sumX],
             [2*sumXY, 2*sumY2, sumY],
             [sumX,    sumY,    n   ]]
  const b = [sumXR, sumYR, sumR]
  // Gaussian elimination
  const m = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < 3; col++) {
    let maxRow = col
    for (let row = col+1; row < 3; row++)
      if (Math.abs(m[row][col]) > Math.abs(m[maxRow][col])) maxRow = row
    ;[m[col], m[maxRow]] = [m[maxRow], m[col]]
    if (Math.abs(m[col][col]) < 1e-10) return null
    for (let row = col+1; row < 3; row++) {
      const f = m[row][col] / m[col][col]
      for (let k = col; k <= 3; k++) m[row][k] -= f * m[col][k]
    }
  }
  const cx = (m[0][3] - m[0][1]/m[1][1]*m[1][3] - m[0][2]/m[2][2]*m[2][3] +
              m[0][1]/m[1][1]*m[1][2]/m[2][2]*m[2][3]) /
             (m[0][0] - m[0][1]/m[1][1]*m[1][0] - m[0][2]/m[2][2]*m[2][0] +
              m[0][1]/m[1][1]*m[1][2]/m[2][2]*m[2][0])
  // back-sub
  let x = [0, 0, 0]
  x[2] = m[2][3] / m[2][2]
  x[1] = (m[1][3] - m[1][2]*x[2]) / m[1][1]
  x[0] = (m[0][3] - m[0][2]*x[2] - m[0][1]*x[1]) / m[0][0]
  const ocx = x[0], ocy = x[1]
  const r   = Math.sqrt(Math.max(0, x[2] + ocx*ocx + ocy*ocy))
  if (r < 2) return null
  // RMS
  let rms = 0
  for (const [px, py] of pts) {
    const d = _dist(px, py, ocx, ocy) - r
    rms += d * d
  }
  rms = Math.sqrt(rms / n)
  return { cx: ocx, cy: ocy, r, rms }
}

// ── Step 1: merge collinear / near-collinear vertices ─────────
function _mergeCollinear(poly, threshDeg) {
  if (poly.length < 3) return poly.slice()
  const thresh = threshDeg * Math.PI / 180
  let pts = poly.slice()
  let changed = true
  while (changed) {
    changed = false
    const out = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n]
      const cur  = pts[i]
      const next = pts[(i + 1) % n]
      const a1 = _angle(prev[0], prev[1], cur[0],  cur[1])
      const a2 = _angle(cur[0],  cur[1],  next[0], next[1])
      const diff = Math.abs(_angleDiff(a1, a2)) * Math.PI / 180
      if (diff < thresh) { changed = true } // skip cur — collinear
      else out.push(cur)
    }
    if (out.length < 3) break
    pts = out
  }
  return pts
}


// ── Доминирующая ориентация помещения ────────────────────────
// Возвращает угол (°) наиболее длинных рёбер, свёрнутый в [0°, 90°).
// Это "база" для snap: комната, повёрнутая на любой угол, получает
// прямые углы в своей локальной системе, а не только axis-aligned.
function _findDominantAngle(poly) {
  const n = poly.length
  const BINS = 360  // 0.25° точность в [0°, 90°)
  const hist = new Float64Array(BINS)

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = poly[j][0] - poly[i][0]
    const dy = poly[j][1] - poly[i][1]
    const len = Math.hypot(dx, dy)
    if (len < 2) continue
    // Угол в [0°, 180°), затем складываем в [0°, 90°)
    let ang = Math.atan2(dy, dx) * 180 / Math.PI
    ang = ((ang % 180) + 180) % 180
    if (ang >= 90) ang -= 90
    const bin = Math.min(BINS - 1, Math.floor(ang / 90 * BINS))
    hist[bin] += len
  }

  // Мягкое сглаживание (Gaussian-like, окно ±3 бина)
  const smooth = new Float64Array(BINS)
  const W = [0.25, 0.5, 1.0, 0.5, 0.25]
  for (let i = 0; i < BINS; i++) {
    let s = 0
    for (let d = -2; d <= 2; d++) s += hist[((i + d) % BINS + BINS) % BINS] * W[d + 2]
    smooth[i] = s
  }

  // Пик
  let peak = 0
  for (let i = 1; i < BINS; i++) if (smooth[i] > smooth[peak]) peak = i

  // Взвешенный центроид вокруг пика для субпиксельной точности
  let sumW = 0, sumA = 0
  for (let d = -4; d <= 4; d++) {
    const b = ((peak + d) % BINS + BINS) % BINS
    sumW += smooth[b]
    sumA += smooth[b] * (b + 0.5)
  }
  return sumW > 0 ? (sumA / sumW) / BINS * 90 : 0
}

// ── Step 2: snap edges to 90°-multiples of dominant room angle ─
// Комната может быть повёрнута на произвольный угол: сначала
// находим её доминирующую ориентацию, затем снэпим каждое ребро
// к ближайшему кратному 90° от этой базы.
function _orthogonalize(poly, threshDeg) {
  if (poly.length < 3) return poly.slice()

  // Базовый угол помещения (в его «локальной» системе)
  const base = _findDominantAngle(poly)

  const pts = poly.map(p => [...p])
  const n   = pts.length
  // Три прохода для стабильности
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const dx = pts[j][0] - pts[i][0]
      const dy = pts[j][1] - pts[i][1]
      const ang = Math.atan2(dy, dx) * 180 / Math.PI
      // Ближайший кратный 90° от base
      const rel     = ang - base
      const snapped = Math.round(rel / 90) * 90 + base
      if (Math.abs(ang - snapped) <= threshDeg) {
        const len = Math.hypot(dx, dy)
        const rad = snapped * Math.PI / 180
        const nx  = pts[i][0] + len * Math.cos(rad)
        const ny  = pts[i][1] + len * Math.sin(rad)
        // Двигаем j наполовину, чтобы не перекорректировать
        pts[j][0] = Math.round((pts[j][0] + nx) / 2)
        pts[j][1] = Math.round((pts[j][1] + ny) / 2)
      }
    }
  }
  return pts
}

// ── Step 3: arc detection on a window of points ───────────────
// Returns array of segments: {type:'line', pts:[...]} | {type:'arc', cx, cy, r, startAngle, endAngle, ccw, pts:[...]}
function _detectArcs(poly) {
  const n    = poly.length
  const segs = []
  const used = new Uint8Array(n)
  const MIN  = REG.arcMinPts

  let i = 0
  while (i < n) {
    if (used[i]) { i++; continue }
    // Try extending an arc window starting at i
    let bestEnd = -1, bestFit = null

    // Grow window greedily
    let winPts = [poly[i]]
    let j = (i + 1) % n
    let steps = 0
    while (steps < n - 1) {
      winPts.push(poly[j])
      if (winPts.length >= MIN) {
        const fit = _fitCircle(winPts)
        if (fit && fit.rms <= REG.arcMaxRms && fit.r < 5000) {
          // Check angular span
          const angles = winPts.map(([px, py]) =>
            Math.atan2(py - fit.cy, px - fit.cx))
          let span = 0
          for (let k = 1; k < angles.length; k++) {
            let d = angles[k] - angles[k-1]
            while (d >  Math.PI) d -= 2*Math.PI
            while (d < -Math.PI) d += 2*Math.PI
            span += d
          }
          if (Math.abs(span) * 180 / Math.PI >= REG.arcMinSpanDeg) {
            bestEnd = j; bestFit = { ...fit, startAngle: angles[0], endAngle: angles[angles.length-1], ccw: span < 0 }
          }
        } else {
          break  // RMS exceeded — stop growing
        }
      }
      j = (j + 1) % n
      steps++
      if (j === i) break  // wrapped around
    }

    if (bestEnd >= 0 && bestFit) {
      // Mark used
      let k = i
      while (k !== bestEnd) { used[k] = 1; k = (k + 1) % n }
      used[bestEnd] = 1
      segs.push({ type: 'arc', ...bestFit, ptStart: poly[i], ptEnd: poly[bestEnd] })
      i = (bestEnd + 1) % n
      if (i <= (segs.length > 0 ? 0 : -1)) break
    } else {
      // Single line vertex
      segs.push({ type: 'line_pt', pt: poly[i] })
      i++
    }
  }
  return segs
}

// ── Main regularizer ──────────────────────────────────────────
// Mutates room in place: adds room.segments, updates room.polygon
function regularizeRoom(room) {
  if (!room.polygon || room.polygon.length < 4) return

  // 1. Merge collinear
  let poly = _mergeCollinear(room.polygon, REG.collinearDeg)
  if (poly.length < 3) { room.segments = null; return }

  // 2. Orthogonalize
  poly = _orthogonalize(poly, REG.orthoDeg)

  // 3. Arc detection
  const rawSegs = _detectArcs(poly)

  // Consolidate line_pt runs into line segments
  const segments = []
  let linePts = []
  function flushLine() {
    if (linePts.length >= 2) segments.push({ type: 'line', pts: linePts.slice() })
    else if (linePts.length === 1) segments.push({ type: 'line', pts: [linePts[0], linePts[0]] })
    linePts = []
  }
  for (const s of rawSegs) {
    if (s.type === 'line_pt') { linePts.push(s.pt) }
    else { flushLine(); segments.push(s) }
  }
  flushLine()

  room.segments = segments

  // Update polygon: sample arc back to points so downstream code still works
  const newPoly = []
  for (const seg of segments) {
    if (seg.type === 'line') {
      for (const p of seg.pts) newPoly.push([Math.round(p[0]), Math.round(p[1])])
    } else {
      // Sample arc as polyline (every 8°)
      const steps = Math.max(3, Math.round(Math.abs(_angleDiff(
        seg.startAngle * 180/Math.PI, seg.endAngle * 180/Math.PI)) / 8))
      for (let k = 0; k <= steps; k++) {
        const t   = k / steps
        let   ang = seg.startAngle + t * (seg.endAngle - seg.startAngle)
        newPoly.push([
          Math.round(seg.cx + seg.r * Math.cos(ang)),
          Math.round(seg.cy + seg.r * Math.sin(ang)),
        ])
      }
    }
  }
  if (newPoly.length >= 3) room.polygon = newPoly
}

// Batch regularize all rooms
function regularizeAll() {
  rooms.forEach(regularizeRoom)
}

// ── Draw segments (replaces simple lineTo loop) ───────────────
// Рисует room с учётом arc-сегментов если они есть
function drawRoomPath(c, room, sx, sy) {
  const segs = room.segments
  if (!segs || !segs.length) {
    // Fallback: plain polygon
    const pts = room.polygon.map(([x, y]) => [x * sx, y * sy])
    if (!pts.length) return
    c.moveTo(pts[0][0], pts[0][1])
    pts.slice(1).forEach(([x, y]) => c.lineTo(x, y))
    return
  }
  let started = false
  for (const seg of segs) {
    if (seg.type === 'line') {
      for (const [px, py] of seg.pts) {
        if (!started) { c.moveTo(px*sx, py*sy); started = true }
        else            c.lineTo(px*sx, py*sy)
      }
    } else {
      // arc
      if (!started) { c.moveTo(seg.ptStart[0]*sx, seg.ptStart[1]*sy); started = true }
      c.arc(seg.cx*sx, seg.cy*sy, seg.r*sx,
            seg.startAngle, seg.endAngle, seg.ccw)
    }
  }
}

// ── Patch drawPlan to respect polygonsVisible / showBW ─────
;(function patchDrawPlan() {
  const origDraw = drawPlan

  function drawPlanPatched() {
    if (!currentImageEl) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const sx = canvas.width  / currentImageEl.naturalWidth
    const sy = canvas.height / currentImageEl.naturalHeight

    if (rooms.length && currentImageBW && showBW) {
      ctx.drawImage(currentImageBW, 0, 0, canvas.width, canvas.height)
    } else {
      ctx.drawImage(currentImageEl, 0, 0, canvas.width, canvas.height)
    }

    if (!polygonsVisible || !rooms.length) { ctx.globalAlpha = 1; return }

    rooms.forEach(room => {
      if (!room.polygon || room.polygon.length < 3) return
      const isSelected = room.id === selectedRoomId
      const show = currentView === 'all' || isSelected
      if (!show) return
      ctx.beginPath()
      drawRoomPath(ctx, room, sx, sy)
      ctx.closePath()
      ctx.globalAlpha = isSelected ? 0.78 : ROOM_ALPHA
      ctx.fillStyle   = ROOM_COLOR; ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = isSelected ? 'rgba(30,120,60,0.95)' : STROKE_COLOR
      ctx.lineWidth   = isSelected ? 3 : STROKE_WIDTH; ctx.stroke()
      const pts = room.polygon.map(([x, y]) => [x * sx, y * sy])
      const cx = pts.reduce((s,p)=>s+p[0],0) / pts.length
      const cy = pts.reduce((s,p)=>s+p[1],0) / pts.length
      const fontSize = Math.max(11, Math.min(16, Math.round(canvas.width / 80)))
      ctx.font = `600 ${fontSize}px -apple-system, sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      const tw = ctx.measureText(room.label).width + 10
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.fillRect(cx - tw/2, cy - fontSize*0.7, tw, fontSize*1.4)
      ctx.fillStyle = '#1d1d1f'; ctx.fillText(room.label, cx, cy)
    })

    if (editMode === 'edit') {
      for (const room of rooms) {
        if (!room.polygon) continue
        if (currentView === 'selected' && room.id !== selectedRoomId) continue
        const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])
        for (let i = 0; i < pts.length; i++) {
          const j = (i+1) % pts.length
          const mx = (pts[i][0]+pts[j][0])/2, my = (pts[i][1]+pts[j][1])/2
          const isHovered = hoverState?.roomId===room.id && hoverState?.edgeIdx===i
          ctx.globalAlpha = isHovered ? 1 : 0.35
          ctx.beginPath(); ctx.arc(mx, my, isHovered ? 5 : 3, 0, Math.PI*2)
          ctx.fillStyle = '#007aff'; ctx.fill()
        }
        for (let i = 0; i < pts.length; i++) {
          const isHovered = hoverState?.roomId===room.id && hoverState?.ptIdx===i
          const isDragging = dragState?.roomId===room.id && dragState?.ptIdx===i
          const r = (isHovered || isDragging) ? 7 : 5
          ctx.globalAlpha = 1
          ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], r, 0, Math.PI*2)
          ctx.fillStyle = isDragging ? '#ff9500' : isHovered ? '#ff3b30' : '#fff'; ctx.fill()
          ctx.strokeStyle = isDragging ? '#ff6a00' : isHovered ? '#cc1000' : 'rgba(30,120,60,0.9)'
          ctx.lineWidth = 2; ctx.stroke()
        }
      }
    }
    ctx.globalAlpha = 1
  }

  // Replace global reference
  window.drawPlan = drawPlanPatched

  // Expose all onclick-referenced globals
  window.regularizeAll      = regularizeAll
  window.regularizeRoom     = regularizeRoom
  window.drawRoomPath       = drawRoomPath
  window.undo               = undo
  window.zoomIn             = zoomIn
  window.zoomOut            = zoomOut
  window.resetZoom          = resetZoom
  window.togglePolygons     = togglePolygons
  window.toggleBWBackground = toggleBWBackground
  window.saveChecked        = saveChecked
  window.applyCrop          = applyCrop
  window.finalizeCollider   = finalizeCollider
  window.setView            = setView
  window.setMode            = setMode
  window.setEditMode        = setEditMode
  window.switchTab          = switchTab
  window.analysePlan        = analysePlan
  window.clearPlan          = clearPlan
  window.saveSelected       = saveSelected
  window.saveAll            = saveAll
  window.saveRoom           = saveRoom
  window.saveEdits          = saveEdits
  window.onDragOver         = onDragOver
  window.onDragLeave        = onDragLeave
  window.onDrop             = onDrop
  window.onFileSelected     = onFileSelected
})()

// ── Boot ───────────────────────────────────────────────────
init()
updateTrainingBadge()
