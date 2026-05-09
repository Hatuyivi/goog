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
let selectedRoomId   = null   // single highlighted room (click)
let selectedRoomIds  = new Set()  // rooms checked for export (checkboxes / ctrl+click)
let currentView      = 'all'
let mode             = 'local'  // 'local' | 'ai'

// ── Edit state ─────────────────────────────────────────────
let editMode         = 'view'   // 'view' | 'edit' | 'delete' | 'collider'
let dragState        = null     // { roomId, ptIdx, startX, startY }
let hoverState       = null     // { roomId, ptIdx, edgeIdx } — what cursor is over
let hasUnsavedEdits  = false
let trainingCount    = 0        // cached count of saved training samples

// ── Undo history ───────────────────────────────────────────
const MAX_UNDO       = 30
let undoStack        = []       // each entry: deep copy of rooms array
let showPolygons     = true     // toggle polygon visibility in app

// ── Eraser state ───────────────────────────────────────────
let eraserStrokes    = []       // array of strokes; each stroke = array of {x,y,r} in image coords
let eraserActive     = false    // currently drawing eraser stroke
let eraserCurrentStroke = []
let eraserSize       = 30       // radius in image px

// ── Zoom / Pan state ───────────────────────────────────────
let zoomLevel        = 1.0      // current zoom multiplier (1 = fit view)
let panX             = 0        // pan offset in screen px
let panY             = 0        // pan offset in screen px
let isPanning        = false    // is user currently panning (middle-btn drag)
let panStart         = null     // {x, y, panX, panY}
const ZOOM_MIN       = 0.5
const ZOOM_MAX       = 8.0
const ZOOM_STEP      = 0.15

// ── Room drawing state ──────────────────────────────────────
// Users can draw rectangular rooms manually on the canvas.
let roomDraw         = null     // {x0,y0,x1,y1} — rect being drawn right now
let drawnRoomCount   = 0        // counter for auto-labelling drawn rooms

const ROOM_COLOR   = '#c9ffd4'
const ROOM_ALPHA   = 0.40
const STROKE_COLOR = 'rgba(60,160,80,0.75)'
const STROKE_WIDTH = 2

const DRAW_ROOM_COLOR  = 'rgba(100,160,255,0.12)'
const DRAW_ROOM_STROKE = 'rgba(0,100,220,0.55)'

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
const undoBtn           = document.getElementById('undoBtn')
const trainingBadge     = document.getElementById('trainingBadge')

const paramThreshold = document.getElementById('paramThreshold')
const paramDilate    = document.getElementById('paramDilate')
const paramMinArea   = document.getElementById('paramMinArea')
const paramEpsilon   = document.getElementById('paramEpsilon')
const vThr = document.getElementById('vThr')
const vDil = document.getElementById('vDil')
const vMin = document.getElementById('vMin')
const vEps = document.getElementById('vEps')

paramThreshold.oninput = () => vThr.textContent = paramThreshold.value === '0' ? 'авто' : paramThreshold.value
paramDilate   .oninput = () => vDil.textContent = `${paramDilate.value} px`
paramMinArea  .oninput = () => vMin.textContent = `${(Number(paramMinArea.value)/10).toFixed(2)}%`
paramEpsilon  .oninput = () => vEps.textContent = `${paramEpsilon.value} px`

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
      eraserStrokes = []
      resizeCanvas(img)
      drawPlan()
      canvas.style.display = 'block'
      canvasPlaceholder.style.display = 'none'
      viewLabel.textContent = 'Нажми «Распознать помещения»'
      resetZoom()
    }
    img.src = `data:${currentMime};base64,${currentImageB64}`
  } catch(e) { alert('Ошибка загрузки: ' + e.message) }
}

// ── BG adjustment state ────────────────────────────────────
// Смешение ч/б (Camera Raw style)
let bwMix = { red: 40, orange: 33, yellow: 17, green: -20, aqua: -8, blue: -10, lavender: 0, magenta: 0 }
// Основные (Camera Raw style)
let basicAdj = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0 }

// Raw pixel cache — populated once on image load, never mutated
let _rawPixels   = null   // Uint8ClampedArray original RGBA
let _rawWidth    = 0
let _rawHeight   = 0

// rAF debounce handle
let _rebuildRaf  = null

// Offscreen B&W canvas (used for export visuals)
function makeBWCanvas(img) {
  const off = document.createElement('canvas')
  off.width = img.naturalWidth; off.height = img.naturalHeight
  const c = off.getContext('2d')
  c.drawImage(img, 0, 0)

  // Cache raw pixels once
  const imageData = c.getImageData(0, 0, off.width, off.height)
  _rawPixels = new Uint8ClampedArray(imageData.data)   // immutable copy
  _rawWidth  = off.width
  _rawHeight = off.height

  applyBWProcessing(imageData.data)
  c.putImageData(imageData, 0, 0)
  return off
}

// Schedule rebuild via rAF — coalesces rapid slider updates into one frame
function rebuildBWCanvas() {
  if (!currentImageEl) return
  if (_rebuildRaf) return          // already scheduled
  _rebuildRaf = requestAnimationFrame(() => {
    _rebuildRaf = null
    _doRebuildBWCanvas()
  })
}

function _doRebuildBWCanvas() {
  if (!currentImageEl || !_rawPixels) return

  if (!currentImageBW) {
    currentImageBW = document.createElement('canvas')
    currentImageBW.width  = _rawWidth
    currentImageBW.height = _rawHeight
  }

  const c = currentImageBW.getContext('2d')

  // Work on a copy of raw pixels — no getImageData round-trip
  const data = new Uint8ClampedArray(_rawPixels)
  applyBWProcessing(data)

  const imageData = new ImageData(data, _rawWidth, _rawHeight)
  c.putImageData(imageData, 0, 0)

  // Re-apply eraser strokes
  if (eraserStrokes.length) {
    c.fillStyle = '#ffffff'
    for (const stroke of eraserStrokes) {
      for (const pt of stroke) {
        c.beginPath()
        c.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2)
        c.fill()
      }
    }
  }

  drawPlan()
}

function applyBWProcessing(d) {
  const expMult = Math.pow(2, basicAdj.exposure * 0.04)
  const contr   = basicAdj.contrast   / 100
  const hi      = basicAdj.highlights / 200
  const sh      = basicAdj.shadows    / 200
  const wh      = basicAdj.whites     / 200
  const bl      = basicAdj.blacks     / 200
  const sat     = 1 + basicAdj.saturation / 100
  const vib     = basicAdj.vibrance   / 200
  const clar    = basicAdj.clarity    / 100
  const deh     = basicAdj.dehaze     / 100

  // Pre-compute BW mix stop table once per call
  const mx = bwMix
  const stops = [
    { h:   0, v: mx.red      / 200 },
    { h:  30, v: mx.orange   / 200 },
    { h:  60, v: mx.yellow   / 200 },
    { h: 120, v: mx.green    / 200 },
    { h: 180, v: mx.aqua     / 200 },
    { h: 240, v: mx.blue     / 200 },
    { h: 280, v: mx.lavender / 200 },
    { h: 320, v: mx.magenta  / 200 },
    { h: 360, v: mx.red      / 200 },
  ]

  // Pre-build a 360-entry hue→mixShift LUT
  const hueLUT = new Float32Array(361)
  for (let h = 0; h <= 360; h++) {
    for (let s = 0; s < stops.length - 1; s++) {
      if (h >= stops[s].h && h <= stops[s+1].h) {
        const t = (h - stops[s].h) / (stops[s+1].h - stops[s].h)
        hueLUT[h] = stops[s].v * (1 - t) + stops[s+1].v * t
        break
      }
    }
  }

  const len = d.length
  for (let i = 0; i < len; i += 4) {
    let r = d[i] * 0.003921569   // / 255
    let g = d[i+1] * 0.003921569
    let b = d[i+2] * 0.003921569

    // Exposure
    r *= expMult; g *= expMult; b *= expMult

    // Saturation & Vibrance
    const lum0 = 0.299*r + 0.587*g + 0.114*b
    const satF = sat + vib * (1 - Math.abs(2*lum0 - 1))
    if (satF !== 1) {
      r = lum0 + (r - lum0) * satF
      g = lum0 + (g - lum0) * satF
      b = lum0 + (b - lum0) * satF
    }

    // Dehaze
    if (deh !== 0) {
      const lift = deh * 0.15
      r -= lift; g -= lift; b -= lift
      if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0
    }

    // Hue & saturation for BW mix (fast path: skip if unsaturated)
    let mixShift = 0
    const cMax = r > g ? (r > b ? r : b) : (g > b ? g : b)
    const cMin = r < g ? (r < b ? r : b) : (g < b ? g : b)
    const delta = cMax - cMin
    if (delta > 0.02 && cMax > 0.001) {
      let hue
      if      (cMax === r) hue = 60 * (((g - b) / delta) % 6)
      else if (cMax === g) hue = 60 * ((b - r) / delta + 2)
      else                 hue = 60 * ((r - g) / delta + 4)
      if (hue < 0) hue += 360
      const satLevel = delta / cMax
      mixShift = hueLUT[Math.round(hue)] * satLevel
    }

    // BW conversion
    let gray = 0.299*r + 0.587*g + 0.114*b + mixShift
    if (gray < 0) gray = 0; else if (gray > 1) gray = 1

    // Contrast S-curve
    if (contr !== 0) gray += contr * (gray - 0.5) * (1 - Math.abs(gray - 0.5)) * 2

    // Tone ranges
    if (hi !== 0 && gray > 0.5)  gray += hi * (gray - 0.5) * 2
    if (sh !== 0 && gray <= 0.5) gray += sh * (0.5 - gray) * 2
    if (wh !== 0 && gray > 0.85) gray += wh * (gray - 0.85) / 0.15
    if (bl !== 0 && gray < 0.15) gray -= bl * (0.15 - gray) / 0.15

    // Clarity
    if (clar !== 0) {
      const sign = gray > 0.5 ? 1 : -1
      gray += clar * sign * Math.pow(Math.abs(gray - 0.5), 0.7) * 0.3
    }

    if (gray < 0) gray = 0; else if (gray > 1) gray = 1
    const v = gray * 255 + 0.5 | 0
    d[i] = d[i+1] = d[i+2] = v
  }
}

function resizeCanvas(img) {
  const maxW = 1600, maxH = 1000
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
  canvas.width  = Math.round(img.naturalWidth  * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
}

function clearPlan() {
  currentImageB64 = null; currentImageEl = null; currentImageBW = null
  _rawPixels = null; _rawWidth = 0; _rawHeight = 0
  if (_rebuildRaf) { cancelAnimationFrame(_rebuildRaf); _rebuildRaf = null }
  previewThumb.style.display = 'none'; dropzone.style.display = 'block'
  canvas.style.display = 'none'; canvasPlaceholder.style.display = 'flex'
  analyseBtn.disabled = true
  viewLabel.textContent = 'Загрузи план слева'
  viewAllBtn.style.display = 'none'; viewSelBtn.style.display = 'none'
  clearResults()
}

function clearResults() {
  rooms = []; originalRooms = []; selectedRoomId = null; selectedRoomIds = new Set()
  hasUnsavedEdits = false; dragState = null; hoverState = null
  roomDraw = null; drawnRoomCount = 0
  undoStack = []
  if (undoBtn) undoBtn.disabled = true
  eraserStrokes = []; eraserActive = false
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
    if (!showPolygons) return
    if (!room.polygon || room.polygon.length < 3) return
    const isSelected = room.id === selectedRoomId
    const show = currentView === 'all' || isSelected
    if (!show) return

    const pts = room.polygon.map(([x, y]) => [x * sx, y * sy])

    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y))
    ctx.closePath()

    const isChecked = selectedRoomIds.has(room.id)
    ctx.globalAlpha = isSelected ? 0.78 : ROOM_ALPHA
    ctx.fillStyle   = isChecked ? '#c8e6ff' : ROOM_COLOR
    ctx.fill()

    ctx.globalAlpha = 1
    ctx.strokeStyle = isSelected ? 'rgba(30,120,60,0.95)' : isChecked ? 'rgba(0,100,220,0.85)' : STROKE_COLOR
    ctx.lineWidth   = isSelected ? 3 : isChecked ? 2.5 : STROKE_WIDTH
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
  if (editMode === 'edit' && showPolygons) {
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

  // Draw in-progress room rectangle (draw mode)
  if (roomDraw) {
    const csx = canvas.width  / currentImageEl.naturalWidth
    const csy = canvas.height / currentImageEl.naturalHeight
    const x0 = roomDraw.x0 * csx, y0 = roomDraw.y0 * csy
    const x1 = roomDraw.x1 * csx, y1 = roomDraw.y1 * csy
    ctx.globalAlpha = 1
    ctx.fillStyle = DRAW_ROOM_COLOR
    ctx.fillRect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0))
    ctx.setLineDash([5, 4])
    ctx.strokeStyle = DRAW_ROOM_STROKE
    ctx.lineWidth = 1.5
    ctx.strokeRect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0))
    ctx.setLineDash([])
  }
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
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+click toggles export checkbox
        if (selectedRoomIds.has(room.id)) selectedRoomIds.delete(room.id)
        else selectedRoomIds.add(room.id)
        // sync checkbox in list
        const cb = document.querySelector(`.room-item[data-id="${room.id}"] .room-check`)
        if (cb) cb.checked = selectedRoomIds.has(room.id)
        updateExportBtn()
        drawPlan()
      } else {
        selectRoom(room.id)
      }
      return
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
    item.className = 'room-item' + (room.id === selectedRoomId ? ' selected' : '')
    item.dataset.id = room.id

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'room-check'
    cb.checked = selectedRoomIds.has(room.id)
    cb.title = 'Отметить для экспорта'
    cb.addEventListener('change', e => {
      e.stopPropagation()
      if (cb.checked) selectedRoomIds.add(room.id)
      else selectedRoomIds.delete(room.id)
      updateExportBtn()
      drawPlan()
    })

    const dot   = document.createElement('div');  dot.className = 'room-dot'
    const label = document.createElement('span'); label.className = 'room-label'; label.title = room.label; label.textContent = room.label
    const area  = document.createElement('span'); area.className  = 'room-area'
    if (room.areaPx) area.textContent = `${(room.areaPx/1000).toFixed(1)}k px²`

    const saveBtn = document.createElement('button')
    saveBtn.className = 'room-save'; saveBtn.title = 'Сохранить JPEG'
    saveBtn.textContent = '💾'
    saveBtn.addEventListener('click', e => { e.stopPropagation(); saveRoom(room.id) })

    item.appendChild(cb); item.appendChild(dot); item.appendChild(label)
    item.appendChild(area); item.appendChild(saveBtn)

    item.addEventListener('click', () => selectRoom(room.id))
    roomsList.appendChild(item)
  })

  updateExportBtn()
}

function updateExportBtn() {
  const btn = document.getElementById('exportCheckedBtn')
  if (!btn) return
  const n = selectedRoomIds.size
  btn.style.display = n > 0 ? '' : 'none'
  btn.textContent = `📐 Экспорт (${n})`
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
  if (result.error) throw new Error(result.error)
  rooms = result.rooms
  if (!rooms.length) throw new Error('Помещения не найдены. Попробуй другую модель в меню Σ или более чёткий план.')

  finishAnalysis()
}

// ── Local CV learning ──────────────────────────────────────
// Анализирует накопленные правки пользователя и возвращает
// диапазоны нормализованной площади (доля от площади изображения),
// которые стоит сохранять или отбрасывать.
function computeLocalLearning(trainingData) {
  // Берём только локальные образцы (обратная совместимость: mode отсутствует → тоже считаем local)
  const localSamples = trainingData.filter(s => !s.mode || s.mode === 'local')
  if (!localSamples.length) return null

  const keptFracs    = []   // нормализованные площади оставленных комнат
  const deletedFracs = []   // нормализованные площади удалённых комнат
  const addedFracs   = []   // нормализованные площади добавленных пользователем комнат

  for (const sample of localSamples) {
    // imageHash формат: "WxH_<первые 80 символов b64>"
    const m = (sample.imageHash || '').match(/^(\d+)x(\d+)_/)
    if (!m) continue
    const imgArea = Number(m[1]) * Number(m[2])
    if (!imgArea) continue

    const deletedSet = new Set(sample.deletedIds || [])
    const addedSet   = new Set(sample.addedIds   || [])

    for (const r of (sample.original || [])) {
      if (typeof r.areaPx !== 'number') continue
      const frac = r.areaPx / imgArea
      if (deletedSet.has(r.id)) deletedFracs.push(frac)
      else                       keptFracs.push(frac)
    }

    // Добавленные пользователем помещения — явный позитивный сигнал:
    // пользователь счёл нужным нарисовать именно такой размер → расширяем диапазон
    for (const r of (sample.edited || [])) {
      if (!addedSet.has(r.id)) continue
      if (typeof r.areaPx !== 'number') continue
      const frac = r.areaPx / imgArea
      addedFracs.push(frac)
      keptFracs.push(frac)   // тоже входит в «правильный» диапазон
    }
  }

  if (keptFracs.length === 0) return null
  keptFracs.sort((a, b) => a - b)

  // p5 / p98 — устойчивые границы без выбросов
  const idxLow  = Math.max(0, Math.floor(keptFracs.length * 0.05))
  const idxHigh = Math.min(keptFracs.length - 1, Math.floor(keptFracs.length * 0.98))
  const minAreaFrac = keptFracs[idxLow]
  const maxAreaFrac = keptFracs[idxHigh]

  // Считаем, сколько «удалённых» попадало вне диапазона — качество обучения
  const truePositives = deletedFracs.filter(f => f < minAreaFrac || f > maxAreaFrac).length

  return {
    minAreaFrac,
    maxAreaFrac,
    sampleCount: localSamples.length,
    keptCount:   keptFracs.length,
    deletedCount: deletedFracs.length,
    addedCount:  addedFracs.length,
    filterAccuracy: deletedFracs.length
      ? Math.round(truePositives / deletedFracs.length * 100)
      : null,
  }
}

async function analyseLocal() {
  showProgress('Локальный анализ…', 'Загрузка данных обучения')
  await tick()

  // ── Загружаем накопленные правки ───────────────────────
  const trainingData = await ipcRenderer.invoke('get-training-data')

  // ── Функция 1: точное восстановление ──────────────────
  // Если это изображение уже исправлялось — возвращаем сохранённый результат.
  const hash = imageHash()
  const exactMatch = trainingData.find(
    s => s.imageHash === hash && (s.mode === 'local' || !s.mode) && s.edited?.length
  )
  if (exactMatch) {
    rooms = exactMatch.edited.map(r => ({ ...r, polygon: r.polygon.map(p => [...p]) }))
    finishAnalysis()
    viewLabel.textContent = `✦ Восстановлено из обучения: ${rooms.length} помещений`
    return
  }

  // ── Стандартная детекция ───────────────────────────────
  setProgressStep('Подготовка изображения')
  await tick()

  const tManual = Number(paramThreshold.value)         // 0 = auto (Otsu)
  const dilateK = Number(paramDilate.value)            // 0..5
  const minPct  = Number(paramMinArea.value) / 1000    // /10 -> percent then /100 -> fraction
  const epsilon = Number(paramEpsilon.value)           // px in display scale

  setProgressStep('Поиск стен и помещений…')
  await tick()

  rooms = await detectRoomsLocal(currentImageEl, {
    threshold: tManual || null,
    dilateK,
    minAreaFrac: minPct,
    epsilon,
  })

  // ── Функция 2: автофильтрация по накопленным площадям ─
  // Учится на том, комнаты каких размеров пользователь обычно удаляет.
  const learned = computeLocalLearning(trainingData)
  let filteredCount = 0
  if (learned && rooms.length) {
    const imgArea = currentImageEl.naturalWidth * currentImageEl.naturalHeight
    const before  = rooms.length
    rooms = rooms.filter(r => {
      if (typeof r.areaPx !== 'number') return true   // нет данных → не трогаем
      const frac = r.areaPx / imgArea
      return frac >= learned.minAreaFrac && frac <= learned.maxAreaFrac
    })
    filteredCount = before - rooms.length
  }

  if (!rooms.length) throw new Error('Помещения не найдены. Попробуй уменьшить «Мин. площадь» или включить «Утолщение стен».')

  finishAnalysis()

  // Показываем информацию об активном обучении в строке статуса
  if (learned) {
    const accNote    = learned.filterAccuracy !== null ? `, точность ${learned.filterAccuracy}%` : ''
    const filterNote = filteredCount > 0 ? ` · −${filteredCount} отф.` : ''
    const addedNote  = learned.addedCount  > 0 ? ` · +${learned.addedCount} доб.` : ''
    viewLabel.textContent += ` · ✦ обучение: ${learned.sampleCount} образц.${filterNote}${addedNote}${accNote}`
  }
}

function finishAnalysis() {
  // Snapshot for training diff
  originalRooms = rooms.map(r => ({ ...r, polygon: r.polygon.map(p => [...p]) }))
  hasUnsavedEdits = false
  undoStack = []
  if (undoBtn) undoBtn.disabled = true
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
  editMode = m
  document.getElementById('emodeView').classList.toggle('active',     m === 'view')
  document.getElementById('emodeEdit').classList.toggle('active',     m === 'edit')
  document.getElementById('emodeDelete').classList.toggle('active',   m === 'delete')
  document.getElementById('emodeDraw').classList.toggle('active',     m === 'collider')
  document.getElementById('emodeEraser')?.classList.toggle('active',  m === 'eraser')
  canvas.className = m === 'eraser' ? 'mode-eraser' : m !== 'view' ? `mode-${m}` : ''
  hoverState = null
  dragState  = null
  roomDraw   = null
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
function deepCopyRooms(src) {
  return src.map(r => ({ ...r, polygon: r.polygon.map(p => [...p]) }))
}

function snapshotBW() {
  if (!currentImageBW) return null
  const snap = document.createElement('canvas')
  snap.width = currentImageBW.width
  snap.height = currentImageBW.height
  snap.getContext('2d').drawImage(currentImageBW, 0, 0)
  return snap
}

function pushUndo() {
  // Deep-copy eraserStrokes: each stroke is an array of {x,y,r} objects
  const eraserSnap = eraserStrokes.map(stroke => stroke.map(pt => ({ ...pt })))
  undoStack.push({ rooms: deepCopyRooms(rooms), bw: snapshotBW(), eraserStrokes: eraserSnap })
  if (undoStack.length > MAX_UNDO) undoStack.shift()
  if (undoBtn) undoBtn.disabled = false
}

function togglePolygons() {
  showPolygons = !showPolygons
  const btn = document.getElementById('togglePolygonsBtn')
  if (btn) {
    if (showPolygons) {
      btn.textContent = '🔲 Скрыть полигоны'
      btn.style.background = '#e8e8ed'
      btn.style.color = '#555'
    } else {
      btn.textContent = '🔳 Показать полигоны'
      btn.style.background = '#ff9500'
      btn.style.color = '#fff'
    }
  }
  drawPlan()
}

function undo() {
  const entry = undoStack.pop()
  rooms = entry.rooms
  // Restore eraser strokes snapshot so rebuildBWCanvas won't re-apply removed strokes
  if (entry.eraserStrokes !== undefined) {
    eraserStrokes = entry.eraserStrokes
  }
  if (entry.bw && currentImageBW) {
    currentImageBW.getContext('2d').drawImage(entry.bw, 0, 0)
  }
  if (undoBtn) undoBtn.disabled = undoStack.length === 0
  buildRoomList()
  drawPlan()
  hasUnsavedEdits = undoStack.length > 0
  saveEditsBtn.style.display = hasUnsavedEdits ? '' : 'none'
}

function markEdited() {
  hasUnsavedEdits = true
  saveEditsBtn.style.display = ''
}

function deleteRoom(id) {
  pushUndo()
  rooms = rooms.filter(r => r.id !== id)
  if (selectedRoomId === id) selectedRoomId = null
  buildRoomList()
  drawPlan()
  markEdited()
}

function addVertexOnEdge(roomId, edgeIdx, cx, cy) {
  pushUndo()
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
  pushUndo()
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

// ── Zoom helpers ───────────────────────────────────────────
function applyZoomTransform() {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`
  canvas.style.transformOrigin = '50% 50%'
  updateZoomLabel()
}

function updateZoomLabel() {
  const lbl = document.getElementById('zoomLabel')
  if (lbl) lbl.textContent = Math.round(zoomLevel * 100) + '%'
}

function zoomBy(delta, originX, originY) {
  // originX/Y are screen coords relative to canvas-wrap centre
  const wrap = document.querySelector('.canvas-wrap')
  const wRect = wrap.getBoundingClientRect()
  // point in canvas space before zoom
  const ox = originX !== undefined ? originX - wRect.left - wRect.width / 2 : 0
  const oy = originY !== undefined ? originY - wRect.top  - wRect.height / 2 : 0

  const oldZoom = zoomLevel
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel * (1 + delta)))

  // Adjust pan so the point under cursor stays fixed
  const ratio = zoomLevel / oldZoom
  panX = ox + (panX - ox) * ratio
  panY = oy + (panY - oy) * ratio

  applyZoomTransform()
}

function resetZoom() {
  zoomLevel = 1.0; panX = 0; panY = 0
  applyZoomTransform()
}

function zoomIn()  { zoomBy(ZOOM_STEP) }
function zoomOut() { zoomBy(-ZOOM_STEP) }

canvas.addEventListener('mousedown', e => {
  if (!currentImageEl) return
  const [cx, cy] = getCanvasXY(e)

  // ── Eraser ─────────────────────────────────────────────
  if (editMode === 'eraser') {
    pushUndo()
    eraserActive = true
    eraserCurrentStroke = []
    eraserStrokes.push(eraserCurrentStroke)
    const [ix, iy] = canvasToImage(cx, cy)
    const r = eraserSize * currentImageEl.naturalWidth / canvas.width
    eraserCurrentStroke.push({ x: ix, y: iy, r })
    const bwCtx = currentImageBW.getContext('2d')
    bwCtx.fillStyle = '#ffffff'
    bwCtx.beginPath(); bwCtx.arc(ix, iy, r, 0, Math.PI * 2); bwCtx.fill()
    drawPlan()
    e.preventDefault()
    return
  }

  // ── Room drawing ───────────────────────────────────────
  if (editMode === 'collider') {
    const [ix, iy] = canvasToImage(cx, cy)
    roomDraw = { x0: ix, y0: iy, x1: ix, y1: iy }
    e.preventDefault()
    return
  }

  if (!rooms.length) return

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
      // Start dragging vertex
      pushUndo()
      dragState = { roomId: hit.roomId, ptIdx: hit.ptIdx }
      selectRoom(hit.roomId)
      e.preventDefault()
    } else if (hit.edgeIdx !== undefined) {
      // Insert vertex on edge then start dragging it
      addVertexOnEdge(hit.roomId, hit.edgeIdx, cx, cy)
      const room = rooms.find(r => r.id === hit.roomId)
      dragState = { roomId: hit.roomId, ptIdx: hit.edgeIdx + 1 }
      selectRoom(hit.roomId)
      e.preventDefault()
    }
    return
  }

  // view mode: click selects room
  const sx = canvas.width  / currentImageEl.naturalWidth
  const sy = canvas.height / currentImageEl.naturalHeight

  for (const room of [...rooms].reverse()) {
    if (!room.polygon) continue
    const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])
    if (pointInPolygon(cx, cy, pts)) { selectRoom(room.id); return }
  }
  selectedRoomId = null
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('selected'))
  drawPlan()
})

canvas.addEventListener('mousemove', e => {
  if (!currentImageEl) return
  const [cx, cy] = getCanvasXY(e)

  // ── Eraser drag ────────────────────────────────────────
  if (editMode === 'eraser') {
    canvas.style.cursor = 'none'
    drawPlan()  // redraw to show eraser cursor preview
    if (eraserActive && currentImageBW) {
      const [ix, iy] = canvasToImage(cx, cy)
      const r = eraserSize * currentImageEl.naturalWidth / canvas.width
      eraserCurrentStroke.push({ x: ix, y: iy, r })
      const bwCtx = currentImageBW.getContext('2d')
      bwCtx.fillStyle = '#ffffff'
      bwCtx.beginPath(); bwCtx.arc(ix, iy, r, 0, Math.PI * 2); bwCtx.fill()
      drawPlan()
    }
    // Draw eraser cursor ring
    const r = eraserSize
    ctx.save()
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
    return
  }

  // ── Room draw drag ─────────────────────────────────────
  if (editMode === 'collider') {
    canvas.style.cursor = 'crosshair'
    if (roomDraw) {
      const [ix, iy] = canvasToImage(cx, cy)
      roomDraw.x1 = ix; roomDraw.y1 = iy
      drawPlan()
    }
    return
  }

  if (!rooms.length) return

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
  // ── Finish eraser stroke ───────────────────────────────
  if (editMode === 'eraser') {
    eraserActive = false
    eraserCurrentStroke = []
    return
  }

  // ── Finish room draw ───────────────────────────────────
  if (editMode === 'collider' && roomDraw) {
    const { x0, y0, x1, y1 } = roomDraw
    roomDraw = null
    const minW = Math.abs(x1 - x0), minH = Math.abs(y1 - y0)
    if (minW > 5 && minH > 5) {
      const lx = Math.min(x0, x1), ly = Math.min(y0, y1)
      const rx = Math.max(x0, x1), ry = Math.max(y0, y1)
      drawnRoomCount++
      pushUndo()
      const newRoom = {
        id:      `drawn${Date.now()}`,
        label:   `Помещение ${rooms.length + 1}`,
        areaPx:  Math.round(minW * minH),
        polygon: [[lx,ly],[rx,ly],[rx,ry],[lx,ry]],
        drawn:   true,
      }
      rooms.push(newRoom)
      markEdited()
      buildRoomList()
      selectRoom(newRoom.id)
    }
    drawPlan()
    return
  }

  if (dragState) {
    markEdited()
    dragState = null
    drawPlan()
  }
})

canvas.addEventListener('mouseleave', () => {
  if (editMode === 'collider' && roomDraw) {
    roomDraw = null; drawPlan()
  }
  if (dragState) { markEdited(); dragState = null }
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

  // Track rooms added by the user (not in original set)
  const addedIds = rooms
    .filter(r => !originalRooms.find(o => o.id === r.id))
    .map(r => r.id)

  const sample = {
    imageHash:  hash,
    savedAt:    new Date().toISOString(),
    mode,                 // 'local' | 'ai' — чтобы отделить локальные образцы при обучении CV
    original:   originalRooms,
    edited:     rooms.map(r => ({ ...r, polygon: r.polygon.map(p => [...p]) })),
    deletedIds,
    addedIds,
  }

  const count = await ipcRenderer.invoke('save-training-sample', sample)
  hasUnsavedEdits = false
  undoStack = []
  if (undoBtn) undoBtn.disabled = true
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
const JPEG_QUALITY = 0.92

function canvasToJpegBuf(off) {
  return Buffer.from(off.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1], 'base64')
}

async function saveRoom(id, e) {
  e && e.stopPropagation()
  const room = rooms.find(r => r.id === id)
  if (!room) return
  const savePath = await ipcRenderer.invoke('save-dialog', `${sanitizeFilename(room.label)}.jpg`)
  if (!savePath) return
  writeCanvas(makeRoomCanvas(room), savePath)
}

async function saveSelected() {
  if (!selectedRoomId) { alert('Сначала выбери помещение кликом'); return }
  await saveRoom(selectedRoomId)
}

async function saveChecked() {
  if (!selectedRoomIds.size) { alert('Отметь помещения галочками или Ctrl+кликом'); return }
  const checkedRooms = rooms.filter(r => selectedRoomIds.has(r.id))
  const firstName = sanitizeFilename(checkedRooms[0].label)
  const defaultName = checkedRooms.length === 1 ? `${firstName}.jpg` : `помещения_экспорт.jpg`
  const savePath = await ipcRenderer.invoke('save-dialog', defaultName)
  if (!savePath) return
  writeCanvas(makeMultiRoomCanvas(checkedRooms), savePath)
  alert(`Сохранено: ${checkedRooms.length} помещений в одном файле`)
}

async function saveAll() {
  const dir = await ipcRenderer.invoke('save-dir-dialog')
  if (!dir) return
  writeCanvas(makeCombinedCanvas(), path.join(dir, '00_все_помещения.jpg'))
  rooms.forEach((room, idx) => {
    writeCanvas(makeRoomCanvas(room), path.join(dir, `${String(idx+1).padStart(2,'0')}_${sanitizeFilename(room.label)}.jpg`))
  })
  alert(`Сохранено ${rooms.length + 1} файлов в:\n${dir}`)
}

// Export canvas helpers — no labels drawn on export images

function makeRoomCanvas(room) {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.drawImage(currentImageBW || currentImageEl, 0, 0)
  if (room.polygon?.length >= 3) {
    c.beginPath()
    c.moveTo(room.polygon[0][0], room.polygon[0][1])
    room.polygon.slice(1).forEach(([x,y]) => c.lineTo(x, y))
    c.closePath()
    c.globalAlpha = ROOM_ALPHA; c.fillStyle = ROOM_COLOR
    c.strokeStyle = 'transparent'; c.lineWidth = 0
    c.fill()
    c.globalAlpha = 1
  }
  return off
}

// Multiple rooms on a single plan — used by saveChecked
function makeMultiRoomCanvas(roomList) {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.drawImage(currentImageBW || currentImageEl, 0, 0)
  c.strokeStyle = 'transparent'; c.lineWidth = 0
  roomList.forEach(room => {
    if (!room.polygon?.length) return
    c.beginPath()
    c.moveTo(room.polygon[0][0], room.polygon[0][1])
    room.polygon.slice(1).forEach(([x,y]) => c.lineTo(x, y))
    c.closePath()
    c.globalAlpha = ROOM_ALPHA; c.fillStyle = ROOM_COLOR; c.fill()
  })
  c.globalAlpha = 1
  return off
}

function makeCombinedCanvas() {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.drawImage(currentImageBW || currentImageEl, 0, 0)
  c.strokeStyle = 'transparent'; c.lineWidth = 0
  rooms.forEach(room => {
    if (!room.polygon?.length) return
    c.beginPath()
    c.moveTo(room.polygon[0][0], room.polygon[0][1])
    room.polygon.slice(1).forEach(([x,y]) => c.lineTo(x,y))
    c.closePath()
    c.globalAlpha = ROOM_ALPHA; c.fillStyle = ROOM_COLOR; c.fill()
  })
  c.globalAlpha = 1
  return off
}

function writeCanvas(off, filePath) {
  // Ensure filePath has .jpg extension
  const jpgPath = filePath.replace(/\.(png|PNG)$/, '.jpg')
  const buf = canvasToJpegBuf(off)
  fs.writeFileSync(jpgPath, buf)
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

// ── Mouse wheel: zoom canvas or change eraser size ─────────
document.querySelector('.canvas-wrap').addEventListener('wheel', e => {
  e.preventDefault()
  if (editMode === 'eraser') {
    // In eraser mode: wheel changes eraser size
    eraserSize = Math.max(5, Math.min(150, eraserSize - Math.sign(e.deltaY) * 3))
    const sizeEl = document.getElementById('eraserSizeVal')
    if (sizeEl) sizeEl.textContent = eraserSize
    const sizeEl2 = document.getElementById('eraserSizeVal2')
    if (sizeEl2) sizeEl2.textContent = eraserSize
    const slider = document.getElementById('eraserSizeSlider')
    if (slider) slider.value = eraserSize
    drawPlan()
  } else {
    // Normal mode: wheel zooms, centred on cursor
    const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
    zoomBy(delta, e.clientX, e.clientY)
  }
}, { passive: false })

// ── Touch pinch-to-zoom ────────────────────────────────────
let _lastPinchDist = null
document.querySelector('.canvas-wrap').addEventListener('touchstart', e => {
  if (e.touches.length === 2) { _lastPinchDist = null }
}, { passive: true })
document.querySelector('.canvas-wrap').addEventListener('touchmove', e => {
  if (e.touches.length !== 2) return
  e.preventDefault()
  const dx = e.touches[0].clientX - e.touches[1].clientX
  const dy = e.touches[0].clientY - e.touches[1].clientY
  const dist = Math.sqrt(dx*dx + dy*dy)
  if (_lastPinchDist !== null) {
    const ratio = dist / _lastPinchDist
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2
    const delta = ratio - 1
    zoomBy(delta, cx, cy)
  }
  _lastPinchDist = dist
}, { passive: false })
document.querySelector('.canvas-wrap').addEventListener('touchend', () => { _lastPinchDist = null })

// Trackpad pinch via gesturechange (Safari/Electron WebKit)
document.querySelector('.canvas-wrap').addEventListener('gesturestart', e => e.preventDefault(), { passive: false })
document.querySelector('.canvas-wrap').addEventListener('gesturechange', e => {
  e.preventDefault()
  const delta = (e.scale - 1) * 0.08
  zoomBy(delta)
}, { passive: false })
document.querySelector('.canvas-wrap').addEventListener('mousedown', e => {
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    e.preventDefault()
    isPanning = true
    panStart = { x: e.clientX, y: e.clientY, panX, panY }
    document.querySelector('.canvas-wrap').style.cursor = 'grab'
  }
})
window.addEventListener('mousemove', e => {
  if (!isPanning || !panStart) return
  panX = panStart.panX + (e.clientX - panStart.x)
  panY = panStart.panY + (e.clientY - panStart.y)
  applyZoomTransform()
})
window.addEventListener('mouseup', e => {
  if (isPanning) {
    isPanning = false; panStart = null
    document.querySelector('.canvas-wrap').style.cursor = ''
  }
})

// Clear all eraser strokes and rebuild BW canvas
function clearEraserStrokes() {
  eraserStrokes = []
  rebuildBWCanvas()
}

// Apply bg panel changes
function applyBWMix(key, val) {
  bwMix[key] = Number(val)
  rebuildBWCanvas()
}
function applyBasicAdj(key, val) {
  basicAdj[key] = Number(val)
  rebuildBWCanvas()
}

// ── Boot ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    if (undoStack.length) { e.preventDefault(); undo() }
  }
  // Zoom shortcuts: Ctrl/Cmd + = / + / - / 0
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn() }
    if (e.key === '-')                  { e.preventDefault(); zoomOut() }
    if (e.key === '0')                  { e.preventDefault(); resetZoom() }
  }
})
init()
updateTrainingBadge()
