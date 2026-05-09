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
let currentImageBW   = null   // offscreen B&W canvas (BW mix applied)
let currentImageColor = null   // offscreen colour-adjusted canvas
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

// ── Wall detection state ────────────────────────────────────
let _analyseRunCount = 0   // increments per recognition run; drives valley→k-means switch

// ── Undo history ───────────────────────────────────────────
const MAX_UNDO       = 30
let undoStack        = []       // each entry: deep copy of rooms array
let showPolygons     = true     // toggle polygon visibility in app
let showBWBackground = false    // false = colour-adjusted view; true = full B&W conversion

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
const ZOOM_MIN       = 0.1
const ZOOM_MAX       = 12.0
const ZOOM_STEP      = 0.12

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
const paramEpsilon   = document.getElementById('paramEpsilon')
const vThr = document.getElementById('vThr')
const vEps = document.getElementById('vEps')

paramThreshold.oninput = () => vThr.textContent = paramThreshold.value === '0' ? 'авто' : paramThreshold.value
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

  applyColorAdjustments(imageData.data)
  // Build colour-adjusted canvas
  const colOff = document.createElement('canvas')
  colOff.width = off.width; colOff.height = off.height
  colOff.getContext('2d').putImageData(imageData, 0, 0)
  currentImageColor = colOff
  // Build BW canvas (colour adjustments + BW mix)
  applyBWConversion(imageData.data)
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
  applyColorAdjustments(data)          // always: Основные sliders
  // Rebuild colour-adjusted canvas
  if (!currentImageColor) { currentImageColor = document.createElement('canvas'); currentImageColor.width = _rawWidth; currentImageColor.height = _rawHeight }
  currentImageColor.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), _rawWidth, _rawHeight), 0, 0)
  // Re-apply eraser strokes on colour canvas too
  if (eraserStrokes.length) {
    const cc = currentImageColor.getContext('2d')
    cc.fillStyle = '#ffffff'
    for (const stroke of eraserStrokes) for (const pt of stroke) { cc.beginPath(); cc.arc(pt.x, pt.y, pt.r, 0, Math.PI*2); cc.fill() }
  }
  applyBWConversion(data)              // Смешение ч/б sliders baked into BW canvas

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

// ── Stage 1: colour adjustments (Основные sliders) ────────
// Applies exposure, contrast, tone ranges, saturation, clarity to colour data.
// Output stays colour — used for display in colour mode and as input for BW conversion.
function applyColorAdjustments(d) {
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

  const len = d.length
  for (let i = 0; i < len; i += 4) {
    let r = d[i]   * 0.003921569
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

    // Tone adjustments via luminance (preserves colour)
    let lum = 0.299*r + 0.587*g + 0.114*b
    let lumNew = lum

    if (contr !== 0) lumNew += contr * (lumNew - 0.5) * (1 - Math.abs(lumNew - 0.5)) * 2
    if (hi !== 0 && lumNew > 0.5)  lumNew += hi * (lumNew - 0.5) * 2
    if (sh !== 0 && lumNew <= 0.5) lumNew += sh * (0.5 - lumNew) * 2
    if (wh !== 0 && lumNew > 0.85) lumNew += wh * (lumNew - 0.85) / 0.15
    if (bl !== 0 && lumNew < 0.15) lumNew -= bl * (0.15 - lumNew) / 0.15
    if (clar !== 0) {
      const sign = lumNew > 0.5 ? 1 : -1
      lumNew += clar * sign * Math.pow(Math.abs(lumNew - 0.5), 0.7) * 0.3
    }
    if (lumNew < 0) lumNew = 0; else if (lumNew > 1) lumNew = 1

    if (lum > 0.001) {
      const scale = lumNew / lum
      r = Math.min(1, r * scale)
      g = Math.min(1, g * scale)
      b = Math.min(1, b * scale)
    } else {
      r = lumNew; g = lumNew; b = lumNew
    }

    d[i]   = r * 255 + 0.5 | 0
    d[i+1] = g * 255 + 0.5 | 0
    d[i+2] = b * 255 + 0.5 | 0
  }
}

// ── Stage 2: BW conversion (Смешение Ч/Б sliders) ─────────
// Converts colour-adjusted data to grayscale using hue-weighted BW mix.
// Only called when the B&W toggle is ON.
function applyBWConversion(d) {
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
    const r = d[i]   * 0.003921569
    const g = d[i+1] * 0.003921569
    const b = d[i+2] * 0.003921569

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
      mixShift = hueLUT[Math.round(hue)] * (delta / cMax)
    }

    let gray = 0.299*r + 0.587*g + 0.114*b + mixShift
    if (gray < 0) gray = 0; else if (gray > 1) gray = 1
    const v = gray * 255 + 0.5 | 0
    d[i] = d[i+1] = d[i+2] = v
  }
}

// Full pipeline used by local recognition (always needs grayscale)
function applyBWProcessing(d) {
  applyColorAdjustments(d)
  applyBWConversion(d)
}

function resizeCanvas(img) {
  const maxW = 1600, maxH = 1000
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
  canvas.width  = Math.round(img.naturalWidth  * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
}

function clearPlan() {
  currentImageB64 = null; currentImageEl = null; currentImageBW = null; currentImageColor = null
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
  _analyseRunCount = 0   // reset method choice for new image
  const wib = document.getElementById('wallInfoBox')
  if (wib) wib.style.display = 'none'
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

  // Colour mode: draw original (currentImageBW has BW mix baked in — not suitable for colour)
  // B&W mode: draw currentImageBW which has colour adjustments + BW mix sliders applied
  ctx.save()
  const srcImg = showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl)
  ctx.drawImage(srcImg, 0, 0, canvas.width, canvas.height)

  // Overlay eraser strokes as white
  if (eraserStrokes.length) {
    ctx.fillStyle = '#ffffff'
    for (const stroke of eraserStrokes) {
      for (const pt of stroke) {
        ctx.beginPath()
        ctx.arc(pt.x * sx, pt.y * sy, pt.r * sx, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.restore()

  if (!rooms.length) return

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
    // Обводка и шрифт делятся на zoomLevel — остаются постоянными на экране
    const iz = 1 / zoomLevel
    ctx.lineWidth   = (isSelected ? 3 : isChecked ? 2.5 : STROKE_WIDTH) * iz
    ctx.stroke()

    // label
    const cx = pts.reduce((s,p)=>s+p[0],0) / pts.length
    const cy = pts.reduce((s,p)=>s+p[1],0) / pts.length
    const fontSize = Math.max(11, Math.min(16, Math.round(canvas.width / 80))) * iz
    ctx.font = `600 ${fontSize}px -apple-system, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const tw = ctx.measureText(room.label).width + 10 * iz
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

      // Точки рисуются в canvas-px, но canvas масштабируется через CSS transform scale(zoomLevel).
      // Делим радиусы и lineWidth на zoomLevel — точки остаются одного размера на экране.
      const iz = 1 / zoomLevel

      // Draw edge midpoints as faint add-points
      for (let i = 0; i < pts.length; i++) {
        const j = (i+1) % pts.length
        const mx = (pts[i][0]+pts[j][0])/2, my = (pts[i][1]+pts[j][1])/2
        const isHovered = hoverState?.roomId===room.id && hoverState?.edgeIdx===i
        ctx.globalAlpha = isHovered ? 1 : 0.35
        ctx.beginPath(); ctx.arc(mx, my, (isHovered ? 5 : 3) * iz, 0, Math.PI*2)
        ctx.fillStyle = '#007aff'; ctx.fill()
      }

      // Draw vertices
      for (let i = 0; i < pts.length; i++) {
        const isHovered = hoverState?.roomId===room.id && hoverState?.ptIdx===i
        const isDragging = dragState?.roomId===room.id && dragState?.ptIdx===i
        const r = (isHovered || isDragging) ? 7 : 5
        ctx.globalAlpha = 1
        ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], r * iz, 0, Math.PI*2)
        ctx.fillStyle = isDragging ? '#ff9500' : isHovered ? '#ff3b30' : '#fff'
        ctx.fill()
        ctx.strokeStyle = isDragging ? '#ff6a00' : isHovered ? '#cc1000' : 'rgba(30,120,60,0.9)'
        ctx.lineWidth = 2 * iz; ctx.stroke()
      }
    }
  }

  ctx.globalAlpha = 1

  // Draw in-progress room rectangle (draw mode or rescan zone)
  if (roomDraw) {
    const csx = canvas.width  / currentImageEl.naturalWidth
    const csy = canvas.height / currentImageEl.naturalHeight
    const x0 = roomDraw.x0 * csx, y0 = roomDraw.y0 * csy
    const x1 = roomDraw.x1 * csx, y1 = roomDraw.y1 * csy
    if (editMode === 'rescan') {
      const iz = 1 / zoomLevel
      ctx.save()
      ctx.strokeStyle = '#007aff'
      ctx.lineWidth   = 2 * iz
      ctx.setLineDash([6 * iz, 4 * iz])
      ctx.strokeRect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0))
      ctx.fillStyle = 'rgba(0,122,255,0.08)'
      ctx.fillRect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0))
      ctx.restore()
      return
    }
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
function computeLocalLearning(trainingData, currentHash) {
  // Берём только локальные образцы
  const localSamples = trainingData.filter(s => !s.mode || s.mode === 'local')
  if (!localSamples.length) return null

  const keptFracs    = []
  const deletedFracs = []
  const addedFracs   = []

  for (const sample of localSamples) {
    const m = (sample.imageHash || '').match(/^(\d+)x(\d+)_/)
    if (!m) continue
    const imgArea = Number(m[1]) * Number(m[2])
    if (!imgArea) continue

    // Правки с текущего плана весят вдвое — детектор точнее подстроится
    // под конкретный масштаб/стиль чертежа, а не только под «среднее по всем»
    const weight = (currentHash && sample.imageHash === currentHash) ? 2 : 1

    const deletedSet = new Set(sample.deletedIds || [])
    const addedSet   = new Set(sample.addedIds   || [])

    for (const r of (sample.original || [])) {
      if (typeof r.areaPx !== 'number') continue
      const frac = r.areaPx / imgArea
      for (let w = 0; w < weight; w++) {
        if (deletedSet.has(r.id)) deletedFracs.push(frac)
        else                       keptFracs.push(frac)
      }
    }

    for (const r of (sample.edited || [])) {
      if (!addedSet.has(r.id) || typeof r.areaPx !== 'number') continue
      const frac = r.areaPx / imgArea
      for (let w = 0; w < weight; w++) {
        addedFracs.push(frac)
        keptFracs.push(frac)
      }
    }
  }

  if (keptFracs.length === 0) return null
  keptFracs.sort((a, b) => a - b)

  const idxLow  = Math.max(0, Math.floor(keptFracs.length * 0.05))
  const idxHigh = Math.min(keptFracs.length - 1, Math.floor(keptFracs.length * 0.98))
  const minAreaFrac = keptFracs[idxLow]
  const maxAreaFrac = keptFracs[idxHigh]

  const truePositives = deletedFracs.filter(f => f < minAreaFrac || f > maxAreaFrac).length

  return {
    minAreaFrac,
    maxAreaFrac,
    sampleCount:   localSamples.length,
    keptCount:     keptFracs.length,
    deletedCount:  deletedFracs.length,
    addedCount:    addedFracs.length,
    filterAccuracy: deletedFracs.length
      ? Math.round(truePositives / deletedFracs.length * 100)
      : null,
  }
}


// ── Shape-фильтр: учится на compactness/aspect удалённых помещений ────────────
// Применяется ТОЛЬКО если накопили ≥5 образцов И точность фильтра >70%.
// Без достаточной статистики — не трогает ничего.
function computeShapeFilter(trainingData, currentHash) {
  const MIN_SAMPLES  = 5
  const MIN_ACCURACY = 0.70

  const localSamples = trainingData.filter(s => !s.mode || s.mode === 'local')
  if (localSamples.length < MIN_SAMPLES) return null

  const deletedShapes = []
  const keptShapes    = []

  for (const sample of localSamples) {
    const weight     = (currentHash && sample.imageHash === currentHash) ? 2 : 1
    const deletedSet = new Set(sample.deletedIds || [])
    const allRooms   = [...(sample.original || []), ...(sample.edited || [])]
    for (const r of allRooms) {
      if (typeof r.compactness !== 'number' || typeof r.aspect !== 'number') continue
      const entry = { c: r.compactness, a: r.aspect }
      for (let w = 0; w < weight; w++) {
        if (deletedSet.has(r.id)) deletedShapes.push(entry)
        else                       keptShapes.push(entry)
      }
    }
  }

  if (!keptShapes.length || !deletedShapes.length) return null

  // Строим пороги по p10 оставленных (консервативно — не режем то, что пользователь хранит)
  keptShapes.sort((a, b) => a.c - b.c)
  const compactThresh = keptShapes[Math.floor(keptShapes.length * 0.10)].c * 0.80

  keptShapes.sort((a, b) => a.a - b.a)
  const aspectThresh  = keptShapes[Math.floor(keptShapes.length * 0.90)].a * 1.30

  // Проверяем точность: сколько удалённых действительно попадают под фильтр
  const trueFiltered = deletedShapes.filter(s => s.c < compactThresh || s.a > aspectThresh).length
  const accuracy = trueFiltered / deletedShapes.length

  // Активируем только если фильтр действительно работает
  if (accuracy < MIN_ACCURACY) return null

  return {
    compactThresh,
    aspectThresh,
    accuracy: Math.round(accuracy * 100),
    sampleCount: localSamples.length,
  }
}

async function analyseLocal() {
  showProgress('Локальный анализ…', 'Загрузка данных обучения')
  await tick()

  // ── Загружаем накопленные правки ───────────────────────
  const trainingData = await ipcRenderer.invoke('get-training-data')

  // ── Стандартная детекция ───────────────────────────────
  // Правки пользователя — сигнал для обучения (фильтры площади и формы),
  // а не кэш результата. Детекция запускается всегда заново.
  // Убеждаемся, что BW-канвас актуален (может быть отложен через rAF)
  if (_rebuildRaf) { cancelAnimationFrame(_rebuildRaf); _rebuildRaf = null; _doRebuildBWCanvas() }

  // Local CV always needs a grayscale canvas — build one with full BW pipeline
  // regardless of the display toggle (user may be in colour mode)
  let recognitionCanvas = currentImageBW
  if (!showBWBackground && _rawPixels) {
    const data = new Uint8ClampedArray(_rawPixels)
    applyBWProcessing(data)
    if (eraserStrokes.length) {
      const tmp = document.createElement('canvas')
      tmp.width = _rawWidth; tmp.height = _rawHeight
      const tc = tmp.getContext('2d')
      tc.putImageData(new ImageData(data, _rawWidth, _rawHeight), 0, 0)
      tc.fillStyle = '#ffffff'
      for (const stroke of eraserStrokes)
        for (const pt of stroke) { tc.beginPath(); tc.arc(pt.x, pt.y, pt.r, 0, Math.PI*2); tc.fill() }
      recognitionCanvas = tmp
    } else {
      const tmp = document.createElement('canvas')
      tmp.width = _rawWidth; tmp.height = _rawHeight
      tmp.getContext('2d').putImageData(new ImageData(data, _rawWidth, _rawHeight), 0, 0)
      recognitionCanvas = tmp
    }
  }

  const currentHash = imageHash()   // передаём в learning-функции для взвешивания
  setProgressStep('Подготовка изображения')
  await tick()

  const tManual = Number(paramThreshold.value)         // 0 = auto (Otsu)
  const epsilon = Number(paramEpsilon.value)           // px in display scale

  _analyseRunCount++   // 1st run → valley method; 2nd+ → k-means

  setProgressStep('Поиск стен и помещений…')
  await tick()

  const result = await detectRoomsLocal(recognitionCanvas || currentImageEl, {
    threshold: tManual || null,
    epsilon,
    useKmeans: _analyseRunCount > 1,
  })
  rooms = result.rooms
  updateWallInfoDisplay(result.wallInfo)

  // ── Функция 2: автофильтрация по накопленным площадям ─
  // Учится на том, комнаты каких размеров пользователь обычно удаляет.
  const learned = computeLocalLearning(trainingData, currentHash)
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

  // ── Shape-фильтр (МОП и нестандартные формы) ──────────────────────────────
  // Активируется только при достаточном количестве обучающих данных (≥5 образцов)
  // и высокой точности (>70%). Без данных — не трогает ничего.
  const shapeFilter = computeShapeFilter(trainingData, currentHash)
  let shapeFilteredCount = 0
  if (shapeFilter && rooms.length) {
    const before = rooms.length
    rooms = rooms.filter(r => {
      if (typeof r.compactness !== 'number' || typeof r.aspect !== 'number') return true
      if (r.compactness < shapeFilter.compactThresh) return false
      if (r.aspect      > shapeFilter.aspectThresh)  return false
      return true
    })
    shapeFilteredCount = before - rooms.length
  }

  // ── Слияние перекрывающихся комнат ────────────────────────────────────────
  const beforeMerge = rooms.length
  rooms = mergeOverlappingRooms(rooms)
  if (rooms.length < beforeMerge) {
    rooms.forEach((r, i) => { r.id = `r${i+1}`; r.label = `Помещение ${i+1}` })
  }

  finishAnalysis()

  // ── Строка статуса ─────────────────────────────────────────────────────────
  const notes = []
  if (learned) {
    notes.push(`✦ обучение: ${learned.sampleCount} образц.`)
    if (filteredCount > 0)      notes.push(`−${filteredCount} по площади`)
    if (learned.addedCount > 0) notes.push(`+${learned.addedCount} доб.`)
    if (learned.filterAccuracy !== null) notes.push(`точность ${learned.filterAccuracy}%`)
  }
  if (shapeFilter) {
    notes.push(`−${shapeFilteredCount} по форме (${shapeFilter.accuracy}%)`)
  }
  if (notes.length) viewLabel.textContent += ` · ${notes.join(' · ')}`
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
  // Exit crop mode if leaving it
  if (editMode === 'crop' && m !== 'crop') exitCropMode()

  editMode = m
  document.getElementById('emodeView').classList.toggle('active',     m === 'view')
  document.getElementById('emodeEdit').classList.toggle('active',     m === 'edit')
  document.getElementById('emodeDelete').classList.toggle('active',   m === 'delete')
  document.getElementById('emodeDraw').classList.toggle('active',     m === 'collider')
  document.getElementById('emodeEraser')?.classList.toggle('active',  m === 'eraser')
  document.getElementById('cropBtn')?.classList.toggle('active',      m === 'crop')
  document.getElementById('emodeRescan')?.classList.toggle('active',  m === 'rescan')
  canvas.className = m === 'eraser' ? 'mode-eraser' : m !== 'view' ? `mode-${m}` : ''
  hoverState = null
  dragState  = null
  roomDraw   = null

  if (m === 'crop') initCropMode()
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


function toggleBWBackground() {
  showBWBackground = !showBWBackground
  const btn = document.getElementById('toggleBWBtn')
  if (btn) btn.classList.toggle('active', showBWBackground)
  if (btn) btn.textContent = showBWBackground ? '🎨 Цветной' : '⬛ Ч/Б'
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

  // ── Rescan zone draw ────────────────────────────────────
  if (editMode === 'rescan') {
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

  // view mode: клик по комнате — выбор; клик по пустому месту — начало пана
  if (editMode === 'view' && e.button === 0 && !e.altKey && !_spaceDown) {
    const sx = canvas.width  / currentImageEl.naturalWidth
    const sy = canvas.height / currentImageEl.naturalHeight
    for (const room of [...rooms].reverse()) {
      if (!room.polygon) continue
      const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])
      if (pointInPolygon(cx, cy, pts)) { selectRoom(room.id); return }
    }
    // Пустое место — запускаем пан
    isPanning = true
    panStart = { x: e.clientX, y: e.clientY, panX, panY }
    document.querySelector('.canvas-wrap').style.cursor = 'grabbing'
    selectedRoomId = null
    document.querySelectorAll('.room-item').forEach(el => el.classList.remove('selected'))
    drawPlan()
    return
  }
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

  // view mode: курсор-рука на пустом месте подсказывает что можно тащить
  if (editMode === 'view' && !isPanning) {
    const sx = canvas.width  / currentImageEl.naturalWidth
    const sy = canvas.height / currentImageEl.naturalHeight
    const overRoom = rooms.some(room => {
      if (!room.polygon) return false
      return pointInPolygon(cx, cy, room.polygon.map(([x,y]) => [x*sx, y*sy]))
    })
    canvas.style.cursor = overRoom ? 'pointer' : (_spaceDown ? 'grab' : 'grab')
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

      // For manually drawn rooms: union with any overlapping existing rooms
      let mergedRoomId = newRoom.id
      let mergedPoly = newRoom.polygon.map(p => [...p])
      const toAbsorb = []

      for (let i = 0; i < rooms.length - 1; i++) {
        const other = rooms[i]
        if (!other.polygon || other.polygon.length < 3) continue
        if (!bboxOverlap(mergedPoly, other.polygon)) continue
        const inter = intersectPolygons(mergedPoly, other.polygon)
        if (!inter.length || polygonArea(inter) < 4) continue
        // True union via convex hull of both polygons
        mergedPoly = unionPolygonsConvexHull(mergedPoly, other.polygon)
        toAbsorb.push(other.id)
      }

      if (toAbsorb.length) {
        rooms = rooms.filter(r => !toAbsorb.includes(r.id))
        const nr = rooms.find(r => r.id === newRoom.id)
        if (nr) {
          nr.polygon = mergedPoly.map(p => [Math.round(p[0]), Math.round(p[1])])
          nr.areaPx  = Math.round(polygonArea(mergedPoly))
        }
      }

      markEdited()
      buildRoomList()
      selectRoom(mergedRoomId)
    }
    drawPlan()
    return
  }

  // ── Finish rescan zone ─────────────────────────────────
  if (editMode === 'rescan' && roomDraw) {
    const { x0, y0, x1, y1 } = roomDraw
    roomDraw = null
    drawPlan()
    const minW = Math.abs(x1 - x0), minH = Math.abs(y1 - y0)
    if (minW > 10 && minH > 10) {
      rescanZone(Math.min(x0,x1), Math.min(y0,y1), Math.max(x0,x1), Math.max(y0,y1))
    }
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

// ── Rescan zone ────────────────────────────────────────────
// Запускает детекцию на вырезанном прямоугольнике изображения.
// Найденные новые помещения добавляются к существующим.
// Результат автоматически сохраняется как обучающий образец.
async function rescanZone(x0, y0, x1, y1) {
  if (!currentImageEl) return
  const imgW = currentImageEl.naturalWidth
  const imgH = currentImageEl.naturalHeight

  // Зажимаем зону по границам изображения
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0))
  x1 = Math.min(imgW, Math.round(x1)); y1 = Math.min(imgH, Math.round(y1))
  const zw = x1 - x0, zh = y1 - y0
  if (zw < 10 || zh < 10) return

  showProgress('Доиск…', 'Вырезаем зону')
  await tick()

  // Вырезаем фрагмент изображения в отдельный canvas
  const zoneCanvas = document.createElement('canvas')
  zoneCanvas.width = zw; zoneCanvas.height = zh
  const zc = zoneCanvas.getContext('2d')
  const srcImg = showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl)
  zc.drawImage(srcImg, x0, y0, zw, zh, 0, 0, zw, zh)

  // Применяем BW-обработку если используем цветное изображение
  if (!showBWBackground && _rawPixels) {
    const tmp = document.createElement('canvas')
    tmp.width = zw; tmp.height = zh
    const tc = tmp.getContext('2d')
    tc.drawImage(currentImageEl, x0, y0, zw, zh, 0, 0, zw, zh)
    const id = tc.getImageData(0, 0, zw, zh)
    applyBWProcessing(id.data)
    tc.putImageData(id, 0, 0)
    zoneCanvas.getContext('2d').drawImage(tmp, 0, 0)
  }

  setProgressStep('Поиск помещений в зоне…')
  await tick()

  let found = []
  try {
    const tManual = Number(paramThreshold.value)
    const epsilon = Number(paramEpsilon.value)

    const result = await detectRoomsLocal(zoneCanvas, {
      threshold:  tManual || null,
      epsilon,
      useKmeans:  _analyseRunCount > 1,
    })
    const zoneRooms = result.rooms

    // Переводим координаты зоны → координаты всего изображения
    const translated = zoneRooms.map(r => ({
      ...r,
      polygon: r.polygon.map(([px, py]) => [px + x0, py + y0]),
      areaPx:  r.areaPx,
    }))

    // Фильтруем дубли: пропускаем помещение если его центр попадает в уже существующий полигон
    const newRooms = translated.filter(nr => {
      const cx = nr.polygon.reduce((s,p)=>s+p[0],0) / nr.polygon.length
      const cy = nr.polygon.reduce((s,p)=>s+p[1],0) / nr.polygon.length
      const sx = canvas.width  / imgW
      const sy = canvas.height / imgH
      return !rooms.some(existing => {
        if (!existing.polygon?.length) return false
        return pointInPolygon(cx * sx, cy * sy,
          existing.polygon.map(([ex,ey]) => [ex*sx, ey*sy]))
      })
    })

    found = newRooms
  } catch (err) {
    hideProgress()
    console.warn('rescanZone: детекция не дала результатов:', err.message)
    setEditMode('rescan')
    return
  }

  hideProgress()

  if (!found.length) {
    viewLabel.textContent = 'Доиск: помещений не найдено в выделенной зоне'
    setEditMode('rescan')
    return
  }

  // Добавляем найденные комнаты
  pushUndo()
  const baseIdx = rooms.length
  found.forEach((r, i) => {
    r.id    = `rescan_${Date.now()}_${i}`
    r.label = `Помещение ${baseIdx + i + 1}`
    rooms.push(r)
  })

  markEdited()
  buildRoomList()
  drawPlan()
  viewLabel.textContent = `Доиск: найдено ${found.length} новых помещений — сохрани образец`
  setEditMode('view')

  // Автосохраняем обучающий образец — нашли что-то новое, это ценный сигнал
  await saveEdits()
}

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
  // ── Debug slider params (from left panel) ──────────────────────────────────
  const _minCompact = (+(document.getElementById('paramMinCompact')?.value ?? 8))  / 100
  const _minFill    = (+(document.getElementById('paramMinFill')?.value    ?? 35)) / 100
  const _maxAreaPct = (+(document.getElementById('paramMaxArea')?.value    ?? 92)) / 100
  const _dashGapMul = (+(document.getElementById('paramDashGap')?.value    ?? 10)) / 10

  // Поддерживаем как HTMLImageElement (naturalWidth), так и HTMLCanvasElement (width)
  const W0 = imageEl.naturalWidth ?? imageEl.width
  const H0 = imageEl.naturalHeight ?? imageEl.height

  const MAX_DIM = 2000
  const scale = Math.min(1, MAX_DIM / Math.max(W0, H0))
  const W = Math.round(W0 * scale), H = Math.round(H0 * scale)

  const work = document.createElement('canvas')
  work.width = W; work.height = H
  const wctx = work.getContext('2d')
  wctx.drawImage(imageEl, 0, 0, W, H)
  const px = wctx.getImageData(0, 0, W, H).data

  // ── Grayscale ──────────────────────────────────────────────────────────────
  const gray = new Uint8Array(W * H)
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114) | 0
  }

  // ── Оцениваем качество изображения ────────────────────────────────────────
  // Стандартное отклонение яркости: низкое (<40) = плохой контраст (скан, фото телефоном)
  // В этом случае применяем CLAHE для выравнивания контраста перед порогованием.
  let mean = 0
  for (let i = 0; i < gray.length; i++) mean += gray[i]
  mean /= gray.length

  // ── Автодетекция толщины стен ─────────────────────────────────────────────
  // Запускаем до CLAHE — на исходных пикселях сигнал чище для сканов.
  // Результат используется вместо захардкоженного wallEst = 1% от короткой стороны.
  const wallInfo = detectWallThickness(gray, W, H, opts.useKmeans || false)
  let variance = 0
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) ** 2
  const stddev = Math.sqrt(variance / gray.length)
  const needsCLAHE = stddev < 40

  if (needsCLAHE) {
    // CLAHE только на изображениях с плохим контрастом
    // Делим на 8x8 тайлов, каждый выравниваем независимо, потом билинейно смешиваем
    const TILE_COLS = 8, TILE_ROWS = 8, CLIP = 3.0
    const tw = Math.ceil(W / TILE_COLS), th = Math.ceil(H / TILE_ROWS)
    const luts = []
    for (let tr = 0; tr < TILE_ROWS; tr++) {
      luts[tr] = []
      for (let tc = 0; tc < TILE_COLS; tc++) {
        const hist = new Uint32Array(256)
        const x0 = tc * tw, y0 = tr * th
        const x1 = Math.min(x0 + tw, W), y1 = Math.min(y0 + th, H)
        let count = 0
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[gray[y*W+x]]++; count++ }
        const clipLimit = Math.max(1, Math.round(CLIP * count / 256))
        let excess = 0
        for (let v = 0; v < 256; v++) { if (hist[v] > clipLimit) { excess += hist[v] - clipLimit; hist[v] = clipLimit } }
        const add = (excess / 256) | 0
        for (let v = 0; v < 256; v++) hist[v] += add
        const lut = new Uint8Array(256)
        let cdf = 0, cdfMin = -1
        for (let v = 0; v < 256; v++) {
          cdf += hist[v]
          if (cdfMin < 0 && hist[v] > 0) cdfMin = cdf
          lut[v] = (cdfMin >= 0 && count > cdfMin) ? Math.round((cdf - cdfMin) / (count - cdfMin) * 255) : v
        }
        luts[tr][tc] = lut
      }
    }
    const out = new Uint8Array(gray.length)
    for (let y = 0; y < H; y++) {
      const fyRaw = (y - th/2) / th
      const tr0 = Math.max(0, Math.min(TILE_ROWS-2, Math.floor(fyRaw)))
      const fy  = Math.max(0, Math.min(1, fyRaw - tr0))
      for (let x = 0; x < W; x++) {
        const fxRaw = (x - tw/2) / tw
        const tc0 = Math.max(0, Math.min(TILE_COLS-2, Math.floor(fxRaw)))
        const fx  = Math.max(0, Math.min(1, fxRaw - tc0))
        const v   = gray[y*W+x]
        const v00 = luts[tr0][tc0][v], v01 = luts[tr0][tc0+1][v]
        const v10 = luts[tr0+1][tc0][v], v11 = luts[tr0+1][tc0+1][v]
        out[y*W+x] = (v00*(1-fx)*(1-fy) + v01*fx*(1-fy) + v10*(1-fx)*fy + v11*fx*fy) | 0
      }
    }
    for (let i = 0; i < gray.length; i++) gray[i] = out[i]
  }

  // ── Адаптивный порог Саувола ───────────────────────────────────────────────
  // Для каждого пикселя порог = локальное среднее + k * локальное σ
  // Работает одинаково хорошо на светлых и тёмных планах — без угадывания типа.
  // Если пользователь задал порог вручную — используем глобальный Otsu как раньше.
  // Буферы под интегральные образы — выделяем один раз, переиспользуем в обоих вызовах
  // Float64Array(2001×2001) = ~32 МБ × 2 = ~64 МБ, приемлемо для Electron
  const _iSum  = new Float64Array((W+1) * (H+1))
  const _iSum2 = new Float64Array((W+1) * (H+1))

  function sauvolaThreshold(gray, W, H, windowR, k) {
    const iSum  = _iSum
    const iSum2 = _iSum2
    // Обнуляем перед использованием (буфер переиспользуется)
    iSum.fill(0); iSum2.fill(0)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = gray[y*W+x]
        iSum [(y+1)*(W+1)+(x+1)] = v + iSum [y*(W+1)+(x+1)] + iSum [(y+1)*(W+1)+x] - iSum [y*(W+1)+x]
        iSum2[(y+1)*(W+1)+(x+1)] = v*v + iSum2[y*(W+1)+(x+1)] + iSum2[(y+1)*(W+1)+x] - iSum2[y*(W+1)+x]
      }
    }
    const bin = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - windowR), y1 = Math.min(H-1, y + windowR)
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - windowR), x1 = Math.min(W-1, x + windowR)
        const n  = (y1-y0+1) * (x1-x0+1)
        const s  = iSum [(y1+1)*(W+1)+(x1+1)] - iSum [y0*(W+1)+(x1+1)] - iSum [(y1+1)*(W+1)+x0] + iSum [y0*(W+1)+x0]
        const s2 = iSum2[(y1+1)*(W+1)+(x1+1)] - iSum2[y0*(W+1)+(x1+1)] - iSum2[(y1+1)*(W+1)+x0] + iSum2[y0*(W+1)+x0]
        const localMean = s / n
        const localVar  = Math.max(0, s2/n - localMean*localMean)
        const localStd  = Math.sqrt(localVar)
        // Саувола: T = mean * (1 + k * (std/128 - 1))
        // Пиксель светлее порога → свободное пространство (комната)
        const T = localMean * (1 + k * (localStd / 128 - 1))
        bin[y*W+x] = gray[y*W+x] > T ? 1 : 0
      }
    }
    return bin
  }

  // Размер окна Саувола ≈ толщина стены × 3.
  // Используем реальный wallPeak из детекции вместо грубой эвристики 1% от стороны.
  const wallEst = wallInfo
    ? Math.max(2, Math.min(40, wallInfo.wallPeak))
    : Math.max(2, Math.min(40, Math.round(Math.min(W, H) * 0.01)))
  const windowR = Math.max(7, wallEst * 3)
  const K_SAUVOLA = 0.2

  // ── Определяем тип источника: фото или скан ──────────────────────────────
  // Фото с телефона: неравномерный фон (тени, перспектива) — высокая локальная
  // неоднородность яркости в фоновых зонах (пикселях светлее среднего).
  // Скан/PDF: фон почти однородный — низкая локальная неоднородность.
  // Метрика: среднее σ по блокам 32×32 среди светлых пикселей (фон без стен).
  let isPhoto = false
  if (opts.threshold == null) {
    const BLOCK = 32
    let blockVarSum = 0, blockCount = 0
    for (let by = 0; by + BLOCK <= H; by += BLOCK) {
      for (let bx = 0; bx + BLOCK <= W; bx += BLOCK) {
        let bSum = 0, bSum2 = 0, bN = 0
        for (let y = by; y < by + BLOCK; y++) {
          for (let x = bx; x < bx + BLOCK; x++) {
            const v = gray[y * W + x]
            if (v > mean) { bSum += v; bSum2 += v * v; bN++ }
          }
        }
        if (bN > 4) {
          const bMean = bSum / bN
          blockVarSum += Math.sqrt(Math.max(0, bSum2 / bN - bMean * bMean))
          blockCount++
        }
      }
    }
    // Среднее σ фоновых блоков > 12 → неравномерный фон → фото
    isPhoto = blockCount > 0 && (blockVarSum / blockCount) > 12
  }

  let bin1, bin2
  let _cannyEdges  = null  // Canny edges — kept for Hough snap/align (scan mode)
  let _houghRooms  = null  // Polygons built from Probabilistic Hough intersections

  // ── DETECTION: Otsu brightness threshold (primary, all modes) ───────────────
  // Rooms are light pixels, walls are dark pixels.  Otsu finds the optimal
  // threshold automatically.  This is robust for any plan with dark walls on a
  // light background — thick or thin, CAD or photo.
  //
  // Canny is kept ONLY for boundary refinement (step 7 below: snap polygon
  // vertices to real wall edges).  It is NOT used for room detection anymore
  // because Canny-inverted binaries treat thick-wall interiors as free space,
  // merging every room into one giant blob.

  if (opts.threshold == null && !isPhoto) {
    // ── Scan / CAD mode: compute Canny now so it's ready for polygon refinement.
    // Canny is NOT used to build bin1/bin2 — only stored in _cannyEdges for the
    // axisAlignEdges + snapToRightAngles refinement steps later.
    _cannyEdges = cannyEdges(gray, W, H)
    const closeR = Math.max(1, Math.round(wallEst * 0.6))
    const closedEdges = morphClose(_cannyEdges, W, H, closeR)

    // Hough line segments — used in axisAlignEdges to snap polygon edges to
    // detected wall lines.  Also feeds buildRoomsFromLines (PATH A supplement).
    const houghSegs = probabilisticHough(closedEdges, W, H, {
      threshold: Math.max(25, Math.min(W, H) * 0.05),
      minLength: Math.max(15, Math.min(W, H) * 0.03),
      maxGap:    Math.max(4,  Math.min(W, H) * 0.006),
    })
    _houghRooms = buildRoomsFromLines(houghSegs, W, H, closedEdges)
  }

  // ── bin1 (strict) and bin2 (loose) — pure brightness, no Canny ───────────
  if (isPhoto && opts.threshold == null) {
    // Photo mode: Sauvola adaptive threshold handles uneven lighting
    bin1 = sauvolaThreshold(gray, W, H, windowR,     K_SAUVOLA)
    bin2 = sauvolaThreshold(gray, W, H, windowR + 8, K_SAUVOLA - 0.05)
  } else {
    // Scan / CAD / manual mode: global Otsu or user-supplied threshold.
    // Pure brightness — correctly marks thick black wall interiors as wall (=0).
    const T      = opts.threshold != null ? opts.threshold : otsu(gray)
    const T_loose = Math.max(T - 30, 80)
    bin1 = new Uint8Array(gray.length)
    bin2 = new Uint8Array(gray.length)
    for (let i = 0; i < gray.length; i++) {
      bin1[i] = gray[i] > T       ? 1 : 0
      bin2[i] = gray[i] > T_loose ? 1 : 0
    }
  }

  // ---- Artificial wall border -----------------------------------------------
  // 3-pixel ring of zeros around the binary image prevents the touchesBorder
  // filter from incorrectly discarding perimeter offices along outer building walls.
  const WALL_BORDER = 3
  for (let k = 0; k < WALL_BORDER; k++) {
    for (let x = 0; x < W; x++) {
      bin1[k*W+x] = 0; bin2[k*W+x] = 0
      bin1[(H-1-k)*W+x] = 0; bin2[(H-1-k)*W+x] = 0
    }
    for (let y = 0; y < H; y++) {
      bin1[y*W+k] = 0; bin2[y*W+k] = 0
      bin1[y*W+(W-1-k)] = 0; bin2[y*W+(W-1-k)] = 0
    }
  }

  // ---- Close doorway gaps in binary map ----------------------------------------
  // Architectural plans have doorway openings: short gaps in walls (typ. 80-120cm).
  // We close these gaps by scanning for "gap columns/rows" — sequences of free pixels
  // flanked by wall pixels on both sides — and filling them if gap ≤ maxDoorPx.
  // This is done BEFORE erosion so that rooms separated only by a door opening
  // are treated as separate connected components.
  function closeDoorGaps(bin, W, H) {
    const out = bin.slice()
    // maxDoor: typical doorway at floor-plan scale.
    // 1.2% of short side ≈ 24 px at 2000 px → ~90 cm at 1:50 scale.
    // 2.5% was too large — it closed interior passages in large rooms.
    const maxDoor = Math.max(6, Math.round(Math.min(W, H) * 0.012))

    // Horizontal scan: free pixel runs flanked by wall on BOTH left AND right,
    // AND wall pixels present BOTH above AND below (confirms this is a doorway gap
    // cutting through a wall, not an open interior space).
    for (let y = 1; y < H - 1; y++) {
      let x = 1
      while (x < W - 1) {
        if (out[y*W+x] === 0) { x++; continue }
        let gapStart = x
        while (x < W && out[y*W+x] === 1) x++
        const gapEnd = x - 1
        const gapLen = gapEnd - gapStart + 1
        if (gapLen > maxDoor) continue
        const hasWallLeft  = gapStart > 0 && out[y*W+(gapStart-1)] === 0
        const hasWallRight = gapEnd < W-1  && out[y*W+(gapEnd+1)]  === 0
        if (hasWallLeft && hasWallRight) {
          let wallAbove = 0, wallBelow = 0
          for (let gx = gapStart; gx <= gapEnd; gx++) {
            if (y > 0   && out[(y-1)*W+gx] === 0) wallAbove++
            if (y < H-1 && out[(y+1)*W+gx] === 0) wallBelow++
          }
          // Require walls BOTH above AND below — doorway cuts through a wall.
          // OR logic caused false closures inside large open rooms.
          if (wallAbove > gapLen * 0.4 && wallBelow > gapLen * 0.4) {
            for (let gx = gapStart; gx <= gapEnd; gx++) out[y*W+gx] = 0
          }
        }
      }
    }

    // Vertical scan: same logic — require walls on BOTH left AND right sides.
    for (let x = 1; x < W - 1; x++) {
      let y = 1
      while (y < H - 1) {
        if (out[y*W+x] === 0) { y++; continue }
        let gapStart = y
        while (y < H && out[y*W+x] === 1) y++
        const gapEnd = y - 1
        const gapLen = gapEnd - gapStart + 1
        if (gapLen > maxDoor) continue
        const hasWallAbove = gapStart > 0 && out[(gapStart-1)*W+x] === 0
        const hasWallBelow = gapEnd < H-1  && out[(gapEnd+1)*W+x]  === 0
        if (hasWallAbove && hasWallBelow) {
          let wallLeft = 0, wallRight = 0
          for (let gy = gapStart; gy <= gapEnd; gy++) {
            if (x > 0   && out[gy*W+(x-1)] === 0) wallLeft++
            if (x < W-1 && out[gy*W+(x+1)] === 0) wallRight++
          }
          // Require walls BOTH left AND right.
          if (wallLeft > gapLen * 0.4 && wallRight > gapLen * 0.4) {
            for (let gy = gapStart; gy <= gapEnd; gy++) out[gy*W+x] = 0
          }
        }
      }
    }
    return out
  }

  // ---- Close dashed-wall gaps ------------------------------------------------
  // Architectural plans use dashed lines for zone/administrative boundaries.
  // These appear in the binary as repeating dark-light-dark patterns with gaps
  // larger than typical doorways (closeDoorGaps uses ~1.2% of short side, which
  // is too small for dash spacing). We detect the dash pattern and fill the gaps
  // so flood fill treats them as solid walls.
  function closeDashedWalls(bin, W, H) {
    const out = bin.slice()
    // Max gap between dashes: ~2.5% of short side × slider multiplier
    const maxGap  = Math.max(18, Math.round(Math.min(W, H) * 0.025 * _dashGapMul))
    const minDash = 3   // min dark-pixel run to qualify as a "dash"

    // Horizontal scan
    for (let y = 1; y < H - 1; y++) {
      let x = 1
      while (x < W - 1) {
        if (out[y*W+x] === 0) { x++; continue }
        const gapStart = x
        while (x < W && out[y*W+x] === 1) x++
        const gapLen = x - gapStart
        if (gapLen < 1 || gapLen > maxGap) continue
        const hasWallLeft  = gapStart > 0 && out[y*W+(gapStart-1)] === 0
        const hasWallRight = x < W        && out[y*W+x]             === 0
        if (!hasWallLeft || !hasWallRight) continue
        let leftDark = 0
        for (let lx = gapStart - 1; lx >= Math.max(0, gapStart - 20); lx--) {
          if (out[y*W+lx] === 0) leftDark++; else break
        }
        let rightDark = 0
        for (let rx = x; rx < Math.min(W, x + 20); rx++) {
          if (out[y*W+rx] === 0) rightDark++; else break
        }
        if (leftDark >= minDash && rightDark >= minDash) {
          for (let gx = gapStart; gx < x; gx++) out[y*W+gx] = 0
        }
      }
    }

    // Vertical scan
    for (let x = 1; x < W - 1; x++) {
      let y = 1
      while (y < H - 1) {
        if (out[y*W+x] === 0) { y++; continue }
        const gapStart = y
        while (y < H && out[y*W+x] === 1) y++
        const gapLen = y - gapStart
        if (gapLen < 1 || gapLen > maxGap) continue
        const hasWallAbove = gapStart > 0 && out[(gapStart-1)*W+x] === 0
        const hasWallBelow = y < H        && out[y*W+x]             === 0
        if (!hasWallAbove || !hasWallBelow) continue
        let aboveDark = 0
        for (let ay = gapStart - 1; ay >= Math.max(0, gapStart - 20); ay--) {
          if (out[ay*W+x] === 0) aboveDark++; else break
        }
        let belowDark = 0
        for (let by = y; by < Math.min(H, y + 20); by++) {
          if (out[by*W+x] === 0) belowDark++; else break
        }
        if (aboveDark >= minDash && belowDark >= minDash) {
          for (let gy = gapStart; gy < y; gy++) out[gy*W+x] = 0
        }
      }
    }
    return out
  }

  bin1 = closeDashedWalls(bin1, W, H)
  bin2 = closeDashedWalls(bin2, W, H)

  // closeDoorGaps is only meaningful on the Canny-inverted binary (bin1) where
  // "free" pixels are gaps in wall lines.  bin2 is Otsu-brightness-based — its
  // large open rooms are wide white blobs; running closeDoorGaps on them with a
  // large threshold fragments those blobs at narrow interior passages and makes
  // large rooms disappear entirely.  Never apply to bin2.
  bin1 = closeDoorGaps(bin1, W, H)

  // ---- Erosion (thicken walls) ----------------------------------------------
  // Auto: erode once when walls look thin (wallPeak < 8px in work canvas).
  // Manual threshold overrides to no erosion (user controls via threshold slider).
  const autoDilateK = (opts.threshold == null && wallInfo && wallInfo.wallPeak <= 7) ? 1 : 0
  for (let i = 0; i < autoDilateK; i++) { bin1 = erode4(bin1, W, H); bin2 = erode4(bin2, W, H) }
  bin2 = erode4(bin2, W, H)  // extra pass for loose

  // ── Connected components ───────────────────────────────────────────────────
  function floodFill(bin) {
    const labels  = new Int32Array(W * H)
    const regions = []
    let nextLabel = 1
    const stack   = new Int32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x
        if (bin[idx] !== 1 || labels[idx] !== 0) continue
        let minX = x, maxX = x, minY = y, maxY = y, area = 0
        let touchesBorder = false
        let sp = 0
        stack[sp++] = idx; labels[idx] = nextLabel
        while (sp > 0) {
          const p = stack[--sp]
          const py = (p / W) | 0, pxx = p - py * W
          area++
          if (pxx < minX) minX = pxx; if (pxx > maxX) maxX = pxx
          if (py  < minY) minY = py;  if (py  > maxY) maxY = py
          if (pxx === 0 || py === 0 || pxx === W-1 || py === H-1) touchesBorder = true
          if (pxx > 0)     { const n=p-1; if (bin[n]===1&&labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
          if (pxx < W - 1) { const n=p+1; if (bin[n]===1&&labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
          if (py  > 0)     { const n=p-W; if (bin[n]===1&&labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
          if (py  < H - 1) { const n=p+W; if (bin[n]===1&&labels[n]===0) { labels[n]=nextLabel; stack[sp++]=n } }
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

  // ── Фильтрация кандидатов ──────────────────────────────────────────────────
  const total   = W * H
  // Auto min area: room must be at least (wallMin × 4)² pixels — ~4 wall thicknesses wide.
  // Falls back to 0.3% of image area if wall detection failed.
  const autoMinAreaFrac = wallInfo
    ? Math.pow(wallInfo.wallMin * 4, 2) / total
    : 0.003
  const minArea = total * autoMinAreaFrac
  const maxArea = total * _maxAreaPct  // from slider (default 0.92)

  // touchesBorder — умная проверка: отбрасываем регион только если он касается
  // самого края растра (вероятно, фоновая область за пределами здания).
  // НО: если регион большой (> 1% площади) и компактный (fill ratio > 0.5),
  // это скорее перименальный офис у внешней стены — его НЕ выбрасываем.
  function filterRegions(regions, fillRatioMin) {
    return regions.filter(r => {
      if (r.area < minArea || r.area > maxArea) return false
      const bboxArea = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1)
      const fillRatio = bboxArea > 0 ? r.area / bboxArea : 0
      if (fillRatio < fillRatioMin) return false
      // Отбрасываем граничные регионы только если они маленькие ИЛИ некомпактные
      // Большие компактные регионы у края — это легитимные комнаты у внешней стены
      if (r.touchesBorder) {
        const isBigAndCompact = r.area > total * 0.005 && fillRatio > _minFill
        if (!isBigAndCompact) return false
      }
      return true
    })
  }

  const cand1 = filterRegions(regions1, 0.30)
  const cand2 = filterRegions(regions2, 0.20)

  // ── Дедупликация ───────────────────────────────────────────────────────────
  function bboxOf(r) { return { x1: r.minX, y1: r.minY, x2: r.maxX, y2: r.maxY } }
  function iou(a, b) {
    const ix1 = Math.max(a.x1,b.x1), iy1 = Math.max(a.y1,b.y1)
    const ix2 = Math.min(a.x2,b.x2), iy2 = Math.min(a.y2,b.y2)
    if (ix2<=ix1||iy2<=iy1) return 0
    const inter = (ix2-ix1)*(iy2-iy1)
    const u = (a.x2-a.x1)*(a.y2-a.y1)+(b.x2-b.x1)*(b.y2-b.y1)-inter
    return u<=0 ? 0 : inter/u
  }
  const merged = [...cand1]
  const strictBoxes = cand1.map(bboxOf)
  for (const r of cand2) {
    if (!strictBoxes.some(sb => iou(sb, bboxOf(r)) > 0.4)) merged.push(r)
  }

  merged.sort((a, b) => {
    const cyA = (a.minY+a.maxY)/2, cyB = (b.minY+b.maxY)/2
    if (Math.abs(cyA-cyB) > 20) return cyA-cyB
    return (a.minX+a.maxX)/2 - (b.minX+b.maxX)/2
  })

  await tick()

  // ---- Hough H/V wall line detection (for snap/align of flood-fill polygons) ---
  // Project the Canny edge map onto Y-axis (horizontals) and X-axis (verticals).
  // Peaks in each projection = wall positions used to snap polygon vertices.
  let _houghLines = null
  if (_cannyEdges) _houghLines = houghHVLines(_cannyEdges, W, H)

  // ── Построение полигонов + вычисление shape-метрик ─────────────────────────
  // compactness и aspect сохраняются в каждой комнате — используются shape-фильтром
  // в analyseLocal (только если набралось достаточно обучающих данных).
  const inv   = 1 / scale
  const rooms = []

  // ── PATH A: Probabilistic Hough + intersection polygons (scan/PDF mode) ────
  // If _houghRooms has results, convert them directly to room records.
  // Polygons are already clean rectangles with vertices at wall intersections.
  if (_houghRooms && _houghRooms.length > 0) {
    for (let i = 0; i < _houghRooms.length; i++) {
      const poly = _houghRooms[i]  // [[x,y], ...] in work-canvas coords
      if (poly.length < 3) continue

      // Compute area (shoelace) and bounding box for metrics
      let area = 0
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (let k = 0; k < poly.length; k++) {
        const [x1, y1] = poly[k], [x2, y2] = poly[(k+1) % poly.length]
        area += x1*y2 - x2*y1
        if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1
        if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1
      }
      area = Math.abs(area) / 2

      let perim = 0
      for (let k = 0; k < poly.length; k++) {
        const [x1,y1] = poly[k], [x2,y2] = poly[(k+1)%poly.length]
        perim += Math.hypot(x2-x1, y2-y1)
      }
      const compactness = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 1
      const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1
      const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH))

      rooms.push({
        id:          `r${i+1}`,
        label:       `Помещение ${i+1}`,
        areaPx:      Math.round(area * inv * inv),
        compactness: Math.round(compactness * 100) / 100,
        aspect,
        polygon:     poly.map(([x,y]) => [Math.round(x*inv), Math.round(y*inv)]),
        _source:     'hough',
      })
    }
  }

  // ── PATH B: Flood-fill + contour tracing ────────────────────────────────────
  // Runs in two modes:
  //   FULL       — Hough found < 6 rooms: flood-fill handles everything.
  //   SUPPLEMENT — Hough found >= 6 rooms: flood-fill adds only large rooms
  //                that Hough missed (large open spaces, lobbies, wings).
  const houghCoveredWell = rooms.length >= 6

  // Shared helper: build a room record from a flood-fill candidate region
  function floodRoomFromRegion(r, roomIdx) {
    const isFromLoose = !cand1.includes(r)
    const labelsMap   = isFromLoose ? labels2 : labels1
    const poly = traceContour(labelsMap, r.label, W, H, r)
    if (poly.length < 4) return null
    const dynEps = opts.epsilon > 0
      ? opts.epsilon
      : Math.max(2, Math.round(Math.min(W, H) * 0.005))
    const simp0 = rdp(poly, dynEps)
    if (simp0.length < 3) return null
    let simp
    if (_cannyEdges && _houghLines) {
      const snapDist = Math.max(4, Math.round(Math.min(W, H) * 0.008))
      const aligned  = axisAlignEdges(simp0, _houghLines.hLines, _houghLines.vLines, snapDist)
      const snapped  = snapToRightAngles(aligned)
      simp = cleanJaggedEdges(snapped)
    } else {
      simp = cleanJaggedEdges(snapToRightAngles(simp0))
    }
    if (simp.length < 3) return null
    let perim = 0
    for (let k = 0; k < simp.length; k++) {
      const [x1,y1] = simp[k], [x2,y2] = simp[(k+1)%simp.length]
      perim += Math.hypot(x2-x1, y2-y1)
    }
    const compactness = perim > 0 ? (4 * Math.PI * r.area) / (perim * perim) : 1
    const bboxW2 = r.maxX - r.minX + 1, bboxH2 = r.maxY - r.minY + 1
    const aspect = Math.max(bboxW2, bboxH2) / Math.max(1, Math.min(bboxW2, bboxH2))
    return {
      id:          `r${roomIdx}`,
      label:       `Помещение ${roomIdx}`,
      areaPx:      Math.round(r.area * inv * inv),
      compactness: Math.round(compactness * 100) / 100,
      aspect,
      polygon:     simp.map(([x,y]) => [Math.round(x*inv), Math.round(y*inv)]),
      _source:     'flood',
    }
  }

  if (!houghCoveredWell) {
    // ── FULL mode ──────────────────────────────────────────────────────────────
    rooms.length = 0
    for (let i = 0; i < merged.length; i++) {
      const room = floodRoomFromRegion(merged[i], i + 1)
      if (room && room.compactness >= _minCompact) rooms.push(room)
    }
  } else {
    // ── SUPPLEMENT mode: add large rooms Hough missed ─────────────────────────
    // Hough builds rooms only from adjacent H×V wall-line intersections, so it
    // consistently misses large open spaces (entire wings, lobbies, open floors)
    // whose boundary walls don't form clean grid pairs in the line clustering.
    // Threshold: supplement only regions > 1.5% of image area.
    const largeAreaThresh = total * 0.015

    // Bboxes of existing Hough rooms in work-canvas coords for IoU check
    const coveredBboxes = rooms.map(r => {
      let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity
      for (const [px,py] of r.polygon) {
        const wx=px*scale, wy=py*scale
        if (wx<x1)x1=wx; if (wx>x2)x2=wx
        if (wy<y1)y1=wy; if (wy>y2)y2=wy
      }
      return {x1,y1,x2,y2}
    })

    function bboxIoU(ax1,ay1,ax2,ay2, bx1,by1,bx2,by2) {
      const ix1=Math.max(ax1,bx1), iy1=Math.max(ay1,by1)
      const ix2=Math.min(ax2,bx2), iy2=Math.min(ay2,by2)
      if (ix2<=ix1||iy2<=iy1) return 0
      const inter=(ix2-ix1)*(iy2-iy1)
      const ua=(ax2-ax1)*(ay2-ay1), ub=(bx2-bx1)*(by2-by1)
      return inter/(ua+ub-inter)
    }

    for (let i = 0; i < merged.length; i++) {
      const r = merged[i]
      if (r.area < largeAreaThresh) continue  // small rooms already handled by Hough

      const overlapHough = coveredBboxes.some(cb =>
        bboxIoU(r.minX,r.minY,r.maxX,r.maxY, cb.x1,cb.y1,cb.x2,cb.y2) > 0.35
      )
      if (overlapHough) continue  // already well-covered

      const room = floodRoomFromRegion(r, rooms.length + 1)
      if (room && room.compactness >= _minCompact) {
        rooms.push(room)
        coveredBboxes.push({x1:r.minX,y1:r.minY,x2:r.maxX,y2:r.maxY})
      }
    }
  }

  return { rooms, wallInfo }
}

// ── Auto wall-thickness detection ──────────────────────────────────────────
// Scans 3 horizontal + 3 vertical lines through the gray image,
// collects dark-pixel run lengths, and finds the structural-wall cluster
// via valley detection (1st run) or k-means (subsequent runs).
// Returns { wallMin, wallMax, wallPeak, method } in work-canvas px, or null.
function detectWallThickness(gray, W, H, useKmeans) {
  // Quick threshold: pixels below 75% of mean = dark (wall candidate)
  let gSum = 0
  for (let i = 0; i < gray.length; i++) gSum += gray[i]
  const darkThresh = (gSum / gray.length) * 0.75

  const maxRun = Math.min(W, H) * 0.18   // longer runs = background, skip

  const runs = []
  // Helper: collect dark runs along a scanline
  function scanLine(get, len) {
    let inDark = false, runStart = 0
    for (let i = 0; i < len; i++) {
      const dark = get(i) < darkThresh
      if (dark && !inDark) { inDark = true; runStart = i }
      else if (!dark && inDark) {
        inDark = false
        const r = i - runStart
        if (r >= 2 && r < maxRun) runs.push(r)
      }
    }
    if (inDark) { const r = len - runStart; if (r >= 2 && r < maxRun) runs.push(r) }
  }

  // 3 horizontal scan lines at 33%, 50%, 67%
  for (const fy of [0.33, 0.50, 0.67]) {
    const y = Math.floor(H * fy)
    scanLine(x => gray[y*W+x], W)
  }
  // 3 vertical scan lines at 33%, 50%, 67%
  for (const fx of [0.33, 0.50, 0.67]) {
    const x = Math.floor(W * fx)
    scanLine(y => gray[y*W+x], H)
  }

  if (runs.length < 6) return null

  const maxBin = Math.ceil(maxRun)

  if (!useKmeans) {
    // ── Valley method (first run) ────────────────────────────────────────────
    const hist = new Uint32Array(maxBin + 1)
    for (const r of runs) hist[Math.min(Math.round(r), maxBin)]++

    // 3-point smooth
    const s = new Float32Array(maxBin + 1)
    s[0] = hist[0]
    for (let i = 1; i < maxBin; i++) s[i] = (hist[i-1] + hist[i]*2 + hist[i+1]) / 4
    s[maxBin] = hist[maxBin]

    // First peak — thin lines/artifacts (search first quarter)
    let p1 = 1
    const p1Limit = Math.min(14, maxBin >> 2)
    for (let i = 2; i <= p1Limit; i++) if (s[i] > s[p1]) p1 = i

    // Valley after first peak
    let valley = p1
    for (let i = p1 + 1; i < Math.min(p1 * 6 + 3, maxBin); i++) if (s[i] < s[valley]) valley = i

    // Second peak — structural walls
    let p2 = valley
    for (let i = valley + 1; i < Math.min(valley + p1 * 10 + 4, maxBin); i++) if (s[i] > s[p2]) p2 = i

    // If no clear two-peak structure — fall back to median
    if (p2 <= valley || s[p2] < 1) {
      const sorted = runs.slice().sort((a, b) => a - b)
      const wallPeak = sorted[Math.floor(sorted.length * 0.50)]
      return {
        wallMin:  Math.max(2, Math.round(wallPeak * 0.60)),
        wallMax:  Math.min(maxBin, Math.round(wallPeak * 2.20)),
        wallPeak: Math.round(wallPeak),
        method:   'median',
      }
    }

    return {
      wallMin:  Math.max(2, valley > p1 ? valley : p1 + 1),
      wallMax:  Math.min(maxBin, Math.round(p2 * 2.20)),
      wallPeak: p2,
      method:   'valley',
    }

  } else {
    // ── K-means k=3: thin lines | structural walls | exterior walls ──────────
    let c0 = 2, c1 = maxRun * 0.08, c2 = maxRun * 0.25
    for (let iter = 0; iter < 25; iter++) {
      let s0=0,n0=0, s1=0,n1=0, s2=0,n2=0
      for (const v of runs) {
        const d0=Math.abs(v-c0), d1=Math.abs(v-c1), d2=Math.abs(v-c2)
        if (d0<=d1&&d0<=d2) { s0+=v; n0++ }
        else if (d1<=d2)    { s1+=v; n1++ }
        else                { s2+=v; n2++ }
      }
      const nc0=n0?s0/n0:c0, nc1=n1?s1/n1:c1, nc2=n2?s2/n2:c2
      if (Math.abs(nc0-c0)<0.3&&Math.abs(nc1-c1)<0.3&&Math.abs(nc2-c2)<0.3) break
      c0=nc0; c1=nc1; c2=nc2
    }
    const [thin, wall, thick] = [c0,c1,c2].sort((a,b)=>a-b)
    return {
      wallMin:  Math.max(2, Math.round((thin + wall) / 2)),
      wallMax:  Math.min(maxBin, Math.round((wall + thick) / 2 + wall * 0.5)),
      wallPeak: Math.round(wall),
      method:   'kmeans',
    }
  }
}

// ── Wall info display ──────────────────────────────────────────────────────
function updateWallInfoDisplay(wallInfo) {
  const box = document.getElementById('wallInfoBox')
  if (!box) return
  if (!wallInfo) { box.style.display = 'none'; return }

  // Scale factor: work-canvas px → image px
  const inv = currentImageEl
    ? Math.min(1, 2000 / Math.max(currentImageEl.naturalWidth, currentImageEl.naturalHeight))
    : 1

  const minPx  = Math.round(wallInfo.wallMin  / inv)
  const maxPx  = Math.round(wallInfo.wallMax  / inv)
  const minSide = wallInfo.wallMin * 4   // min room side in work-canvas px
  const minAreaImg = Math.round(Math.pow(minSide / inv, 2) / 1000)

  document.getElementById('wallInfoRange').textContent   = `${minPx}–${maxPx} px`
  document.getElementById('wallInfoMinArea').textContent = `${minAreaImg}k px²`
  const labels = { valley: 'долина (1-й запуск)', kmeans: 'k-means', median: 'медиана' }
  document.getElementById('wallInfoMethod').textContent  = labels[wallInfo.method] || wallInfo.method

  box.style.display = ''
}
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

// ---- Canny Edge Detection --------------------------------------------------
// Pure-JS Canny for the Electron renderer.
// Steps: 3x3 Gaussian -> Sobel -> NMS -> double-threshold + BFS hysteresis.
// Returns Uint8Array: 1 = edge/wall, 0 = background/room.
function cannyEdges(gray, W, H) {
  // 1. Gaussian blur 3x3
  const blur = new Uint8Array(W * H)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      blur[y*W+x] = (
        gray[(y-1)*W+(x-1)]   + gray[(y-1)*W+x]*2 + gray[(y-1)*W+(x+1)] +
        gray[ y   *W+(x-1)]*2 + gray[ y   *W+x]*4 + gray[ y   *W+(x+1)]*2 +
        gray[(y+1)*W+(x-1)]   + gray[(y+1)*W+x]*2 + gray[(y+1)*W+(x+1)]
      ) >> 4
    }
  }

  // 2. Sobel gradient magnitude + quantised angle (4 directions)
  const mag = new Float32Array(W * H)
  const ang = new Uint8Array(W * H)  // 0=horiz 1=+45 2=vert 3=-45
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const gx = -blur[(y-1)*W+(x-1)] + blur[(y-1)*W+(x+1)]
               - 2*blur[y*W+(x-1)]   + 2*blur[y*W+(x+1)]
               - blur[(y+1)*W+(x-1)] + blur[(y+1)*W+(x+1)]
      const gy = -blur[(y-1)*W+(x-1)] - 2*blur[(y-1)*W+x] - blur[(y-1)*W+(x+1)]
               + blur[(y+1)*W+(x-1)] + 2*blur[(y+1)*W+x] + blur[(y+1)*W+(x+1)]
      mag[y*W+x] = Math.sqrt(gx*gx + gy*gy)
      const a = Math.atan2(Math.abs(gy), Math.abs(gx))
      ang[y*W+x] = a < 0.3927 ? 0 : a < 1.1781 ? (gy * gx >= 0 ? 1 : 3) : 2
    }
  }

  // 3. Non-maximum suppression
  const nms = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const m = mag[y*W+x]
      if (!m) continue
      let n1, n2
      switch (ang[y*W+x]) {
        case 0: n1 = mag[y*W+(x-1)];       n2 = mag[y*W+(x+1)];       break
        case 1: n1 = mag[(y-1)*W+(x+1)];   n2 = mag[(y+1)*W+(x-1)];   break
        case 2: n1 = mag[(y-1)*W+x];       n2 = mag[(y+1)*W+x];       break
        case 3: n1 = mag[(y-1)*W+(x-1)];   n2 = mag[(y+1)*W+(x+1)];   break
      }
      if (m >= n1 && m >= n2) nms[y*W+x] = m
    }
  }

  // 4. Auto-thresholds from 85th-percentile of non-zero gradient magnitudes
  const magHist = new Uint32Array(512)
  for (let i = 0; i < nms.length; i++) magHist[Math.min(511, nms[i] | 0)]++
  let nonZero = 0
  for (let i = 1; i < 512; i++) nonZero += magHist[i]
  let cumul = 0, highT = 50
  for (let i = 1; i < 512; i++) {
    cumul += magHist[i]
    if (cumul >= nonZero * 0.85) { highT = i; break }
  }
  const lowT = Math.max(5, highT * 0.35)

  // 5. Double-threshold + BFS hysteresis
  const state = new Uint8Array(W * H)  // 0=none 1=weak 2=strong
  for (let i = 0; i < nms.length; i++) {
    if (nms[i] >= highT) state[i] = 2
    else if (nms[i] >= lowT) state[i] = 1
  }
  const queue = []
  for (let i = 0; i < state.length; i++) if (state[i] === 2) queue.push(i)
  let qi = 0
  while (qi < queue.length) {
    const p = queue[qi++]
    const py = (p / W) | 0, px = p - py * W
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const ny = py + dy, nx = px + dx
      if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue
      const ni = ny * W + nx
      if (state[ni] === 1) { state[ni] = 2; queue.push(ni) }
    }
  }
  const out = new Uint8Array(W * H)
  for (let i = 0; i < state.length; i++) out[i] = state[i] === 2 ? 1 : 0
  return out
}

// ── Morphological Closing ─────────────────────────────────────────────────────
// Dilation followed by erosion with a square structuring element of radius r.
// Closes small gaps in edge maps, connecting broken wall segments.
// Input/output: Uint8Array of edge pixels (1 = edge, 0 = background).
function morphClose(edges, W, H, r) {
  // Dilation pass — set pixel if any neighbour within r×r is an edge
  const dilated = new Uint8Array(W * H)
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      let has = 0
      outer1: for (let dy = -r; dy <= r && !has; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (edges[(y+dy)*W+(x+dx)]) { has = 1; break outer1 }
      dilated[y*W+x] = has
    }
  }
  // Erosion pass — keep pixel only if all neighbours within r×r are set
  const closed = new Uint8Array(W * H)
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      if (!dilated[y*W+x]) continue
      let all = 1
      outer2: for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (!dilated[(y+dy)*W+(x+dx)]) { all = 0; break outer2 }
      closed[y*W+x] = all
    }
  }
  return closed
}

// ── Probabilistic Hough Transform ─────────────────────────────────────────────
// Detects line segments in an edge map using a simplified PPHT approach:
//   1. Accumulate votes in (rho, theta) space for 180 angle buckets.
//   2. For each peak above threshold, walk along the line collecting
//      connected edge pixels into segments (gap tolerance = maxGap).
// Returns [{x1,y1,x2,y2,theta,rho}, ...] sorted by length descending.
function probabilisticHough(edges, W, H, opts) {
  const NUM_ANGLES  = 180
  const threshold   = opts.threshold  ?? Math.max(30, Math.min(W, H) * 0.06)
  const minLength   = opts.minLength  ?? Math.max(20, Math.min(W, H) * 0.04)
  const maxGap      = opts.maxGap     ?? Math.max(5,  Math.min(W, H) * 0.008)

  const diag     = Math.ceil(Math.sqrt(W*W + H*H))
  const numRho   = diag * 2 + 1
  const cosT     = new Float32Array(NUM_ANGLES)
  const sinT     = new Float32Array(NUM_ANGLES)
  for (let a = 0; a < NUM_ANGLES; a++) {
    const ang = a * Math.PI / NUM_ANGLES
    cosT[a] = Math.cos(ang)
    sinT[a] = Math.sin(ang)
  }

  // Accumulator
  const acc = new Int32Array(numRho * NUM_ANGLES)
  const edgePts = []
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (edges[y*W+x]) {
        edgePts.push([x, y])
        for (let a = 0; a < NUM_ANGLES; a++) {
          const rho = Math.round(x * cosT[a] + y * sinT[a]) + diag
          acc[rho * NUM_ANGLES + a]++
        }
      }

  // Find peaks with NMS (5×5 window)
  const peaks = []
  for (let ri = 5; ri < numRho - 5; ri++) {
    for (let ai = 5; ai < NUM_ANGLES - 5; ai++) {
      const v = acc[ri * NUM_ANGLES + ai]
      if (v < threshold) continue
      let isMax = true
      check: for (let dr = -2; dr <= 2; dr++)
        for (let da = -2; da <= 2; da++) {
          if (dr === 0 && da === 0) continue
          if (acc[(ri+dr)*NUM_ANGLES+(ai+da)] >= v) { isMax = false; break check }
        }
      if (isMax) peaks.push({ rho: ri - diag, theta: ai, votes: v })
    }
  }
  peaks.sort((a,b) => b.votes - a.votes)

  // For each peak, extract segments by walking along the line
  const used = new Uint8Array(W * H)
  const segments = []

  for (const pk of peaks) {
    const { rho, theta } = pk
    const cos = cosT[theta], sin = sinT[theta]

    // Parametrise scan direction perpendicular to line normal
    // Walk in the direction of the line (perpendicular to normal)
    const scanDx = -sin, scanDy = cos  // direction along the line
    // Find starting point: the edge pixel closest to the line
    let bestDist = Infinity, startX = -1, startY = -1
    for (const [ex, ey] of edgePts) {
      if (used[ey*W+ex]) continue
      const d = Math.abs(ex * cos + ey * sin - rho)
      if (d < 1.5 && d < bestDist) { bestDist = d; startX = ex; startY = ey }
    }
    if (startX < 0) continue

    // Walk in both directions from startX,startY collecting pixels
    function collectSegment(sx, sy) {
      const segs = []
      let curSeg = null, gapCount = 0
      // Project all edge points onto line, sort by parameter t
      const pts = []
      for (const [ex, ey] of edgePts) {
        if (used[ey*W+ex]) continue
        const perpDist = Math.abs(ex * cos + ey * sin - rho)
        if (perpDist > 1.5) continue
        const t = ex * scanDx + ey * scanDy
        pts.push({ x: ex, y: ey, t })
      }
      pts.sort((a,b) => a.t - b.t)

      if (pts.length < 2) return []
      const result = []
      let segStart = null, segPrev = null
      for (const pt of pts) {
        if (!segStart) { segStart = pt; segPrev = pt; continue }
        const gap = pt.t - segPrev.t
        if (gap > maxGap) {
          const len = Math.hypot(segPrev.x - segStart.x, segPrev.y - segStart.y)
          if (len >= minLength) result.push([segStart, segPrev])
          segStart = pt
        }
        segPrev = pt
      }
      if (segStart && segPrev && segStart !== segPrev) {
        const len = Math.hypot(segPrev.x - segStart.x, segPrev.y - segStart.y)
        if (len >= minLength) result.push([segStart, segPrev])
      }
      return result
    }

    const found = collectSegment(startX, startY)
    for (const [a, b] of found) {
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, theta, rho })
      // Mark used pixels near this segment to avoid double-counting
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const steps = Math.ceil(len)
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        const mx = Math.round(a.x + (b.x - a.x) * t)
        const my = Math.round(a.y + (b.y - a.y) * t)
        if (mx >= 0 && mx < W && my >= 0 && my < H) used[my*W+mx] = 1
      }
    }
  }

  segments.sort((a,b) =>
    Math.hypot(b.x2-b.x1,b.y2-b.y1) - Math.hypot(a.x2-a.x1,a.y2-a.y1))
  return segments
}

// ── Line-segment intersection ──────────────────────────────────────────────────
// Returns {x, y} intersection point or null if lines are parallel / don't meet.
// Lines are treated as infinite (for wall extension) — use tMin/tMax to clamp.
function lineIntersect(x1,y1,x2,y2, x3,y3,x4,y4) {
  const d1x = x2-x1, d1y = y2-y1
  const d2x = x4-x3, d2y = y4-y3
  const denom = d1x*d2y - d1y*d2x
  if (Math.abs(denom) < 1e-6) return null
  const t = ((x3-x1)*d2y - (y3-y1)*d2x) / denom
  return { x: x1 + t*d1x, y: y1 + t*d1y, t }
}

// ── Build room polygons from Hough line intersections ─────────────────────────
// Groups wall segments by orientation (H/V), extends them to their grid position,
// then computes all grid-cell polygons formed by pairs of H-walls and V-walls.
// Returns array of polygon vertex arrays [[x,y], ...].
function buildRoomsFromLines(segments, W, H, edges) {
  // Separate horizontal vs vertical segments (within 20° of axis)
  const hSegs = [], vSegs = []
  for (const seg of segments) {
    const dx = Math.abs(seg.x2 - seg.x1), dy = Math.abs(seg.y2 - seg.y1)
    if (dy <= dx * 0.36) hSegs.push(seg)   // ≤ ~20° from horizontal
    else if (dx <= dy * 0.36) vSegs.push(seg)  // ≤ ~20° from vertical
    // Diagonal segments ignored for rectangular room detection
  }

  if (hSegs.length < 2 || vSegs.length < 2) return []

  // Cluster H-segments by Y coordinate (merge if within mergeR pixels)
  function clusterLines(segs, coordFn, spanFn, mergeR) {
    const sorted = [...segs].sort((a,b) => coordFn(a) - coordFn(b))
    const clusters = []
    for (const seg of sorted) {
      const c = coordFn(seg)
      const last = clusters[clusters.length - 1]
      if (last && Math.abs(c - last.coord) <= mergeR) {
        last.coord = (last.coord * last.count + c) / (last.count + 1)
        last.count++
        const [s1, e1] = spanFn(last)
        const [s2, e2] = spanFn(seg)
        last.span = [Math.min(s1, s2), Math.max(e1, e2)]
      } else {
        clusters.push({ coord: c, count: 1, span: spanFn(seg) })
      }
    }
    return clusters
  }

  const mergeR = Math.max(6, Math.min(W, H) * 0.012)
  const hClusters = clusterLines(hSegs,
    s => (s.y1 + s.y2) / 2,
    s => [Math.min(s.x1,s.x2), Math.max(s.x1,s.x2)],
    mergeR)
  const vClusters = clusterLines(vSegs,
    s => (s.x1 + s.x2) / 2,
    s => [Math.min(s.y1,s.y2), Math.max(s.y1,s.y2)],
    mergeR)

  hClusters.sort((a,b) => a.coord - b.coord)
  vClusters.sort((a,b) => a.coord - b.coord)

  // Build candidate room rectangles: for each pair of adjacent H-lines and
  // adjacent V-lines, check that all 4 corners are near real edge pixels.
  const minRoomPx = Math.min(W, H) * 0.02   // минимум ~2% короткой стороны
  const maxRoomPx = Math.min(W, H) * 0.98   // почти вся картинка — нет потолка
  const rooms = []

  function edgeNear(ex, ey, r) {
    const ix = Math.round(ex), iy = Math.round(ey)
    const r2 = r * r
    for (let dy = -r; dy <= r; dy++) {
      const ny = iy + dy
      if (ny < 0 || ny >= H) continue
      for (let dx = -r; dx <= r; dx++) {
        if (dx*dx+dy*dy > r2) continue
        const nx = ix + dx
        if (nx >= 0 && nx < W && edges[ny*W+nx]) return true
      }
    }
    return false
  }

  // Радиус поиска рёбра у угла — для больших комнат чуть больше
  const cornerR = Math.max(12, mergeR * 2)

  for (let hi = 0; hi < hClusters.length - 1; hi++) {
    const h1 = hClusters[hi], h2 = hClusters[hi+1]
    const roomH = h2.coord - h1.coord
    if (roomH < minRoomPx || roomH > maxRoomPx) continue

    for (let vi = 0; vi < vClusters.length - 1; vi++) {
      const v1 = vClusters[vi], v2 = vClusters[vi+1]
      const roomW2 = v2.coord - v1.coord
      if (roomW2 < minRoomPx || roomW2 > maxRoomPx) continue

      // Check corners: достаточно 3 из 4 углов (один может быть проёмом/дверью)
      const corners = [
        [v1.coord, h1.coord], [v2.coord, h1.coord],
        [v2.coord, h2.coord], [v1.coord, h2.coord],
      ]
      const cornersFound = corners.filter(([cx, cy]) => edgeNear(cx, cy, cornerR)).length
      if (cornersFound < 3) continue

      // Check that the centre of the room is NOT an edge pixel (it's open space)
      const midX = Math.round((v1.coord + v2.coord) / 2)
      const midY = Math.round((h1.coord + h2.coord) / 2)
      // Wall density check: use a small fixed radius (20px) around room centre.
      // Previously used 15% of room size — for a 400×300 px room that's a 45 px
      // radius, pulling in column markers (⊠) and furniture symbols and causing
      // large valid rooms to be rejected as "wall".  A fixed 20 px radius tests
      // only the immediate centre, where a real room is always open.
      const checkRi = 20
      let wallDensity = 0
      for (let dy = -checkRi; dy <= checkRi; dy++)
        for (let dx = -checkRi; dx <= checkRi; dx++) {
          const ny = midY+dy, nx = midX+dx
          if (ny>=0&&ny<H&&nx>=0&&nx<W&&edges[ny*W+nx]) wallDensity++
        }
      const checkArea = (2*checkRi+1)*(2*checkRi+1)
      // Large rooms tolerate a bit more (columns, symbols); small rooms stricter.
      const densityLimit = (roomW2 * roomH > W * H * 0.02) ? 0.20 : 0.30
      if (wallDensity / checkArea > densityLimit) continue  // too many edges = wall, not room

      rooms.push(corners.map(([cx,cy]) => [Math.round(cx), Math.round(cy)]))
    }
  }

  // Deduplicate highly overlapping rectangles (IoU > 0.5)
  function rectIoU(a, b) {
    const ax1=a[0][0],ay1=a[0][1],ax2=a[2][0],ay2=a[2][1]
    const bx1=b[0][0],by1=b[0][1],bx2=b[2][0],by2=b[2][1]
    const ix1=Math.max(ax1,bx1), iy1=Math.max(ay1,by1)
    const ix2=Math.min(ax2,bx2), iy2=Math.min(ay2,by2)
    if (ix2<=ix1||iy2<=iy1) return 0
    const inter=(ix2-ix1)*(iy2-iy1)
    const ua=(ax2-ax1)*(ay2-ay1), ub=(bx2-bx1)*(by2-by1)
    return inter/(ua+ub-inter)
  }
  const kept = []
  for (let i = 0; i < rooms.length; i++) {
    if (kept.some(j => rectIoU(rooms[j], rooms[i]) > 0.5)) continue
    kept.push(i)
  }
  return kept.map(i => rooms[i])
}

// ---- Hough H/V Line Detector (legacy — used for snap/align only) -----------
// Projects the Canny edge map onto the Y-axis (horizontals) and X-axis
// (verticals). Local maxima in each 1-D projection that exceed minVotes are
// returned as wall coordinates.  minVotes defaults to 4% of image dimension.
function houghHVLines(edges, W, H) {
  const hAcc = new Uint32Array(H)
  const vAcc = new Uint32Array(W)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (edges[y*W+x]) { hAcc[y]++; vAcc[x]++ }

  const minH = Math.max(8, W * 0.04)
  const minV = Math.max(8, H * 0.04)

  function nmsPeaks(acc, n, minVal) {
    const peaks = []
    for (let i = 2; i < n - 2; i++) {
      if (acc[i] < minVal) continue
      if (acc[i] >= acc[i-1] && acc[i] >= acc[i+1] &&
          acc[i] >= acc[i-2] && acc[i] >= acc[i+2]) peaks.push(i)
    }
    return peaks
  }

  return {
    hLines: nmsPeaks(hAcc, H, minH),  // y-coords of horizontal walls
    vLines: nmsPeaks(vAcc, W, minV),  // x-coords of vertical walls
  }
}

// ---- Axis-align polygon edges using Hough wall lines -----------------------
// For each polygon edge:
//   - nearly horizontal (dy <= 0.4*dx): snap both endpoints to the nearest
//     horizontal Hough line within snapDist pixels;
//   - nearly vertical  (dx <= 0.4*dy): snap to nearest vertical Hough line.
// Two alignment passes stabilise adjacent edges that share vertices.
function axisAlignEdges(poly, hLines, vLines, snapDist) {
  if (!poly.length || (!hLines.length && !vLines.length)) return poly
  const n = poly.length
  const result = poly.map(p => [p[0], p[1]])

  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const [x1, y1] = result[i], [x2, y2] = result[j]
      const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1)

      if (dy <= dx * 0.4) {
        // Nearly horizontal edge: align to common Y
        const midY = (y1 + y2) * 0.5
        let bestY = midY, bestD = snapDist
        for (const hy of hLines) {
          const d = Math.abs(midY - hy)
          if (d < bestD) { bestD = d; bestY = hy }
        }
        result[i][1] = Math.round(bestY)
        result[j][1] = Math.round(bestY)
      } else if (dx <= dy * 0.4) {
        // Nearly vertical edge: align to common X
        const midX = (x1 + x2) * 0.5
        let bestX = midX, bestD = snapDist
        for (const vx of vLines) {
          const d = Math.abs(midX - vx)
          if (d < bestD) { bestD = d; bestX = vx }
        }
        result[i][0] = Math.round(bestX)
        result[j][0] = Math.round(bestX)
      }
    }
  }

  // Remove collapsed adjacent points
  const out = []
  for (let i = 0; i < n; i++) {
    const [cx, cy] = result[i], [px, py] = result[(i - 1 + n) % n]
    if (Math.hypot(cx - px, cy - py) >= 1) out.push([cx, cy])
  }
  return out.length >= 3 ? out : poly
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

  const maxSteps = Math.max(
    (region.maxX - region.minX + region.maxY - region.minY + 4) * 8,
    (region.maxX - region.minX + 1) * (region.maxY - region.minY + 1) * 2
  )
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
// Сглаживание контура с сохранением углов.
// Алгоритм:
//   1. Находим "угловые" точки — где направление контура резко меняется
//      (угол между соседними отрезками > angleThr градусов).
//   2. Между каждой парой соседних углов — прямой участок стены.
//      Применяем RDP только внутри этого участка, фиксируя его концы.
//      Это убирает зубчики вдоль прямой, не трогая сами углы.
function rdp(points, eps) {
  const n = points.length
  if (n < 3 || eps <= 0) return points.slice()

  // Угол в градусах между векторами (prev→cur) и (cur→next)
  function angleDeg(prev, cur, next) {
    const ax = cur[0] - prev[0], ay = cur[1] - prev[1]
    const bx = next[0] - cur[0],  by = next[1] - cur[1]
    const dot   = ax*bx + ay*by
    const cross  = ax*by - ay*bx
    return Math.abs(Math.atan2(Math.abs(cross), dot) * 180 / Math.PI)
  }

  // Порог угла: чем больше eps, тем мягче (меньше точек считаются углами).
  // При eps=1 почти все изломы — углы; при eps=20 только резкие повороты.
  const angleThr = Math.max(15, 60 - eps * 2)  // 15°..58°

  // Шаг 1: помечаем угловые точки (замкнутый контур)
  const isCorner = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur  = points[i]
    const next = points[(i + 1) % n]
    if (angleDeg(prev, cur, next) > angleThr) isCorner[i] = 1
  }

  // Если углов нет — вся комната круглая/бесформенная, применяем обычный RDP
  const corners = []
  for (let i = 0; i < n; i++) if (isCorner[i]) corners.push(i)
  if (corners.length < 2) return rdpSegment(points, 0, n - 1, eps)

  // Шаг 2: между каждой парой соседних углов — сегмент прямой стены.
  // Применяем RDP внутри сегмента, концы фиксированы.
  const keep = new Uint8Array(n)
  for (const ci of corners) keep[ci] = 1

  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % corners.length]
    // Сегмент может перематываться через 0
    const seg = []
    let idx = a
    while (idx !== b) { seg.push(idx); idx = (idx + 1) % n }
    seg.push(b)
    if (seg.length < 3) continue
    // Применяем RDP к этому сегменту
    const pts = seg.map(i => points[i])
    const kept = rdpSegment(pts, 0, pts.length - 1, eps)
    const keptSet = new Set(kept.map(p => p[0] * 100000 + p[1]))
    for (let s = 1; s < seg.length - 1; s++) {
      const [px, py] = points[seg[s]]
      if (keptSet.has(px * 100000 + py)) keep[seg[s]] = 1
    }
  }

  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out.length >= 3 ? out : points.slice()
}

// Стандартный RDP для отрезка (не замкнутого), возвращает массив точек
function rdpSegment(points, a, b, eps) {
  if (b - a < 2) return points.slice(a, b + 1)
  const keep = new Uint8Array(points.length)
  keep[a] = 1; keep[b] = 1
  const stack = [[a, b]]
  while (stack.length) {
    const [i, j] = stack.pop()
    if (j - i < 2) continue
    let maxD = 0, idx = -1
    const [x1, y1] = points[i], [x2, y2] = points[j]
    const dxAB = x2 - x1, dyAB = y2 - y1
    const denom = dxAB * dxAB + dyAB * dyAB
    for (let k = i + 1; k < j; k++) {
      const [px, py] = points[k]
      let d
      if (denom === 0) {
        d = Math.hypot(px - x1, py - y1)
      } else {
        const t = ((px - x1) * dxAB + (py - y1) * dyAB) / denom
        const tx = x1 + t * dxAB, ty = y1 + t * dyAB
        d = Math.hypot(px - tx, py - ty)
      }
      if (d > maxD) { maxD = d; idx = k }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1
      stack.push([i, idx])
      stack.push([idx, j])
    }
  }
  const out = []
  for (let i = a; i <= b; i++) if (keep[i]) out.push(points[i])
  return out
}

// ── Post-processing: snap corners + clean jagged edges ────────────────────────

// Шаг 1. snapToRightAngles
// Если угол при вершине близок к 90° (90° ± snapThr), делаем его точно 90°.
//
// Edge cases:
//  • Круглые/многоугольные помещения — у них нет углов ≈90°, функция их не трогает
//  • Очень короткие рёбра (< minEdge px) — снап пропускается, чтобы не схлопнуть точки
//  • Сдвиг вершины оказался слишком большим (> 35% короткого ребра) — снап отменяется
//  • Все вершины сошлись в одну точку — возвращаем исходный массив
//  • < 3 точек — возвращаем as-is
function snapToRightAngles(points, snapThr) {
  snapThr = snapThr || 15   // ±15° от 90°
  const n = points.length
  if (n < 3) return points.slice()

  const result = points.map(p => [p[0], p[1]])

  for (let iter = 0; iter < 4; iter++) {
    let anySnapped = false
    for (let i = 0; i < n; i++) {
      const prev = result[(i - 1 + n) % n]
      const cur  = result[i]
      const next = result[(i + 1) % n]

      const ax = cur[0] - prev[0], ay = cur[1] - prev[1]
      const bx = next[0] - cur[0], by = next[1] - cur[1]
      const lenA = Math.hypot(ax, ay)
      const lenB = Math.hypot(bx, by)

      // Защита от вырожденных рёбер (точки совпадают или почти)
      if (lenA < 2 || lenB < 2) continue

      const uax = ax / lenA, uay = ay / lenA
      const ubx = bx / lenB, uby = by / lenB

      const dot   = uax * ubx + uay * uby
      const cross = uax * uby - uay * ubx
      // turnDeg — угол отклонения от прямой (0° = прямо, 90° = поворот)
      const turnDeg = Math.abs(Math.atan2(Math.abs(cross), dot) * 180 / Math.PI)

      // Нас интересует только поворот ≈90°
      if (Math.abs(turnDeg - 90) > snapThr) continue

      // Снаппим: двигаем cur так, чтобы B стал перпендикулярен A.
      // Перп к A (повёрнут влево):
      const perpAx = -uay, perpAy = uax
      // Проекция B на перп(A) — это «правильная» составляющая B
      const bAlongPerp = ubx * perpAx + uby * perpAy
      const sign = bAlongPerp >= 0 ? 1 : -1

      const newX = next[0] - lenB * sign * perpAx
      const newY = next[1] - lenB * sign * perpAy

      // Отменяем снап если сдвиг слишком большой
      const shift   = Math.hypot(newX - cur[0], newY - cur[1])
      const minEdge = Math.min(lenA, lenB)
      if (shift > minEdge * 0.35) continue

      result[i] = [Math.round(newX), Math.round(newY)]
      anySnapped = true
    }
    if (!anySnapped) break
  }

  // Финальная проверка: не допускаем схлопывания точек
  const deduped = []
  for (let i = 0; i < n; i++) {
    const prev = result[(i - 1 + n) % n]
    const cur  = result[i]
    if (Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) >= 1) deduped.push(cur)
  }
  return deduped.length >= 3 ? deduped : points.slice()
}

// Шаг 2. cleanJaggedEdges
// Удаляет точки-зубчики вдоль прямых участков стен (между угловыми вершинами).
// Угловые вершины определяются по величине поворота — они защищены от удаления.
//
// Edge cases:
//  • Круглые помещения — угловых вершин нет или мало, функция возвращает исходный контур
//  • Все точки — угловые (сложная форма) — зубчики не удаляются, форма сохранена
//  • После чистки осталось < 3 точек — возвращаем исходный массив
//  • Сегмент между углами содержит 0 промежуточных точек — пропускается корректно
function cleanJaggedEdges(points, devEps) {
  devEps = devEps || 3  // макс. допустимое отклонение от прямой, пикс
  const n = points.length
  if (n < 4) return points.slice()

  // Порог угла: считаем вершину «угловой» если поворот > cornerThr°
  // 30° — достаточно мягко, чтобы поймать слегка скошенные углы после снаппа
  const cornerThrRad = 30 * Math.PI / 180

  const isCorner = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur  = points[i]
    const next = points[(i + 1) % n]
    const ax = cur[0] - prev[0], ay = cur[1] - prev[1]
    const bx = next[0] - cur[0], by = next[1] - cur[1]
    const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by)
    if (lenA < 1 || lenB < 1) { isCorner[i] = 1; continue }  // вырожденная — считаем угловой
    const dot   = (ax * bx + ay * by) / (lenA * lenB)
    const cross = (ax * by - ay * bx) / (lenA * lenB)
    const turn  = Math.abs(Math.atan2(Math.abs(cross), dot))
    if (turn > cornerThrRad) isCorner[i] = 1
  }

  const corners = []
  for (let i = 0; i < n; i++) if (isCorner[i]) corners.push(i)

  // Круглое или бесформенное помещение — угловых вершин нет или очень мало.
  // Не трогаем: RDP уже дал оптимальное приближение.
  if (corners.length < 2) return points.slice()

  const keep = new Uint8Array(n)
  for (const ci of corners) keep[ci] = 1

  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % corners.length]
    const [x1, y1] = points[a]
    const [x2, y2] = points[b]
    const segLen = Math.hypot(x2 - x1, y2 - y1)

    // Обходим сегмент от a до b (может перематываться через 0)
    let idx = (a + 1) % n
    while (idx !== b) {
      const [px, py] = points[idx]
      // Расстояние от точки до прямой AB
      const dist = segLen > 0
        ? Math.abs((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1) / segLen
        : Math.hypot(px - x1, py - y1)

      // Оставляем только точки, которые заметно отклоняются от прямой стены
      if (dist > devEps) keep[idx] = 1
      idx = (idx + 1) % n
    }
  }

  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])

  // Если после чистки потеряли слишком много — возвращаем исходное
  return out.length >= 3 ? out : points.slice()
}


// ── Polygon overlap & union helpers ───────────────────────

// Sutherland–Hodgman clip of subjectPolygon against one edge [edgeA→edgeB]
function clipPolygonByEdge(poly, ax, ay, bx, by) {
  if (!poly.length) return []
  const out = []
  const dx = bx - ax, dy = by - ay
  function inside(px, py) { return dx * (py - ay) - dy * (px - ax) >= 0 }
  function intersect(px, py, qx, qy) {
    const t_num = (ax - px) * (ay - qy) - (ay - py) * (ax - qx)
    const t_den = (px - qx) * (ay - by) - (py - qy) * (ax - bx)
    if (t_den === 0) return [px, py]
    const t = t_num / t_den
    return [px + t * (qx - px), py + t * (qy - py)]
  }
  for (let i = 0; i < poly.length; i++) {
    const [cx, cy] = poly[i]
    const [px, py] = poly[(i + poly.length - 1) % poly.length]
    const cIn = inside(cx, cy), pIn = inside(px, py)
    if (cIn) {
      if (!pIn) out.push(intersect(px, py, cx, cy))
      out.push([cx, cy])
    } else if (pIn) {
      out.push(intersect(px, py, cx, cy))
    }
  }
  return out
}

// Sutherland–Hodgman intersection of two convex-ish polygons
// Returns the overlapping polygon or []
function intersectPolygons(p, q) {
  let clipped = p.slice()
  for (let i = 0; i < q.length; i++) {
    if (!clipped.length) return []
    const [ax, ay] = q[i]
    const [bx, by] = q[(i + 1) % q.length]
    clipped = clipPolygonByEdge(clipped, ax, ay, bx, by)
  }
  return clipped
}

function polygonArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

// Axis-aligned bounding boxes overlap?
function bboxOverlap(a, b) {
  const axMin = Math.min(...a.map(p => p[0])), axMax = Math.max(...a.map(p => p[0]))
  const ayMin = Math.min(...a.map(p => p[1])), ayMax = Math.max(...a.map(p => p[1]))
  const bxMin = Math.min(...b.map(p => p[0])), bxMax = Math.max(...b.map(p => p[0]))
  const byMin = Math.min(...b.map(p => p[1])), byMax = Math.max(...b.map(p => p[1]))
  return axMin < bxMax && axMax > bxMin && ayMin < byMax && ayMax > byMin
}

// Union of two polygons: returns convex hull of all vertices of both
// (works well for rooms which are mostly rectangular/convex)
function unionPolygonsConvexHull(a, b) {
  const pts = [...a, ...b]
  // Convex hull (Graham scan)
  pts.sort((p, q) => p[0] !== q[0] ? p[0] - q[0] : p[1] - q[1])
  const cross = (O, A, B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0])
  const lower = [], upper = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop(); lower.pop()
  return [...lower, ...upper]
}

// Merge rooms whose polygons overlap significantly (IoU or containment > threshold)
// Returns new rooms array with overlapping rooms unified
// Обрезаем полигон poly так, чтобы он не пересекался с полигоном clipper.
// Используем инвертированный Sutherland-Hodgman: для каждого ребра clipper
// оставляем пиксели СНАРУЖИ (outside) этого ребра.
// Это даёт приближение разности A\ B для выпуклых clipper-ов.
// Обрезаем poly по разделительной линии, сдвинутой на offset вдоль нормали ребра.
// offset > 0 — линия смещается внутрь poly (отдаём часть перекрытия), < 0 — наружу.
function clipPolyByOffsetEdge(poly, ax, ay, bx, by, offset) {
  // Нормаль к ребру (a→b), единичная, направленная внутрь (влево)
  const len = Math.hypot(bx - ax, by - ay)
  if (len < 0.001) return poly
  const nx = -(by - ay) / len
  const ny =  (bx - ax) / len
  // Смещаем ребро на offset вдоль нормали
  const mx = ax + nx * offset
  const my = ay + ny * offset
  const ex = bx + nx * offset
  const ey = by + ny * offset
  // Оставляем пиксели снаружи сдвинутого ребра (переворачиваем — b→a)
  return clipPolygonByEdge(poly, ex, ey, mx, my)
}

function mergeOverlappingRooms(roomList) {
  if (!roomList.length) return roomList

  const polys = roomList.map(r => r.polygon.map(p => [...p]))  // deep copy
  const n = polys.length

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!bboxOverlap(polys[i], polys[j])) continue

      const inter = intersectPolygons(polys[i], polys[j])
      if (!inter.length) continue

      const interArea = polygonArea(inter)
      if (interArea < 2) continue  // шум/артефакт

      const areaI = polygonArea(polys[i])
      const areaJ = polygonArea(polys[j])
      if (areaI < 2 || areaJ < 2) continue

      // Один полигон почти целиком внутри другого — поглощается (колонна, ниша)
      const smaller = Math.min(areaI, areaJ)
      if (interArea / smaller > 0.85) {
        if (areaI < areaJ) polys[i] = []; else polys[j] = []
        continue
      }

      // ── Смежные комнаты: делим перекрытие пополам ─────────────────────────
      // Находим ребро полигона i, которое максимально "врезается" в j.
      // Это ребро и есть граница стены. Делим перекрытие пополам:
      // каждый полигон обрезается по линии, сдвинутой на половину глубины.
      let bestEdge = -1, bestDepth = -Infinity, bestLen = 0
      for (let e = 0; e < polys[i].length; e++) {
        const [ax, ay] = polys[i][e]
        const [bx, by] = polys[i][(e + 1) % polys[i].length]
        const dx = bx - ax, dy = by - ay
        // Глубина проникновения вершин j за это ребро
        let depth = 0, count = 0
        for (const [px, py] of polys[j]) {
          const d = dx * (py - ay) - dy * (px - ax)  // > 0 = внутри i
          if (d > 0) { depth += d; count++ }
        }
        if (count > 0 && depth > bestDepth) {
          bestDepth = depth
          bestEdge  = e
          bestLen   = Math.hypot(dx, dy)
        }
      }

      if (bestEdge < 0 || bestLen < 0.001) continue

      const [ax, ay] = polys[i][bestEdge]
      const [bx, by] = polys[i][(bestEdge + 1) % polys[i].length]

      // Средняя глубина проникновения на вершину — половина этого = линия раздела
      const avgDepth = bestDepth / polys[j].length
      const half = avgDepth / 2

      // Полигон i отступает на half (отдаёт половину перекрытия)
      const newI = clipPolyByOffsetEdge(polys[i], ax, ay, bx, by, -half)
      // Полигон j обрезается до той же линии (оставляет себе половину перекрытия)
      const newJ = clipPolyByOffsetEdge(polys[j], ax, ay, bx, by,  half)

      if (newI.length >= 3) polys[i] = newI
      if (newJ.length >= 3) polys[j] = newJ
    }
  }

  return roomList.map((room, i) => {
    const poly = polys[i]
    if (!poly || poly.length < 3) return null
    return {
      ...room,
      polygon: poly.map(p => [Math.round(p[0]), Math.round(p[1])]),
      areaPx:  Math.round(polygonArea(poly)),
    }
  }).filter(Boolean)
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

// Apply grayscale to offscreen canvas pixels (for export when B&W toggle is on)
function applyGrayscaleToCanvas(c, w, h) {
  const id = c.getImageData(0, 0, w, h)
  const d = id.data
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114)
    d[i] = d[i+1] = d[i+2] = g
  }
  c.putImageData(id, 0, 0)
}

function makeRoomCanvas(room) {
  const w = currentImageEl.naturalWidth, h = currentImageEl.naturalHeight
  const off = document.createElement('canvas'); off.width = w; off.height = h
  const c = off.getContext('2d')
  c.drawImage(showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl), 0, 0)
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
  c.drawImage(showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl), 0, 0)
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
  c.drawImage(showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl), 0, 0)
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

// ── Zoom & Pan ─────────────────────────────────────────────
// Плавный зум: накапливаем deltaY и применяем через rAF (инерция трекпада)
let _wheelAccum   = 0      // накопленная «сырая» дельта (px / line / page)
let _wheelRafId   = null
let _wheelOriginX = 0
let _wheelOriginY = 0
const WHEEL_SENSITIVITY = 0.0008   // px→ratio: меньше = мягче
const WHEEL_MAX_STEP    = 0.18     // максимальный шаг за один кадр

function _flushWheel() {
  _wheelRafId = null
  if (_wheelAccum === 0) return
  // Нормализуем дельту — трекпад даёт маленькие дроби, мышь — 100/120/3
  const clamped = Math.max(-WHEEL_MAX_STEP, Math.min(WHEEL_MAX_STEP, _wheelAccum * WHEEL_SENSITIVITY))
  zoomBy(-clamped, _wheelOriginX, _wheelOriginY)
  _wheelAccum = 0
}

document.querySelector('.canvas-wrap').addEventListener('wheel', e => {
  e.preventDefault()
  if (editMode === 'eraser') {
    // В режиме ластика колесо меняет размер
    eraserSize = Math.max(5, Math.min(150, eraserSize - Math.sign(e.deltaY) * 3))
    const sizeEl  = document.getElementById('eraserSizeVal');   if (sizeEl)  sizeEl.textContent  = eraserSize
    const sizeEl2 = document.getElementById('eraserSizeVal2');  if (sizeEl2) sizeEl2.textContent = eraserSize
    const slider  = document.getElementById('eraserSizeSlider');if (slider)  slider.value        = eraserSize
    drawPlan()
    return
  }
  // Нормализуем единицы: DOM_DELTA_LINE ≈ 16px, DOM_DELTA_PAGE ≈ 400px
  let delta = e.deltaY
  if (e.deltaMode === 1) delta *= 16
  if (e.deltaMode === 2) delta *= 400
  _wheelAccum   += delta
  _wheelOriginX  = e.clientX
  _wheelOriginY  = e.clientY
  if (!_wheelRafId) _wheelRafId = requestAnimationFrame(_flushWheel)
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
    zoomBy(ratio - 1, cx, cy)
  }
  _lastPinchDist = dist
}, { passive: false })
document.querySelector('.canvas-wrap').addEventListener('touchend', () => { _lastPinchDist = null })

// Trackpad pinch via gesturechange (Safari/Electron WebKit)
document.querySelector('.canvas-wrap').addEventListener('gesturestart', e => e.preventDefault(), { passive: false })
document.querySelector('.canvas-wrap').addEventListener('gesturechange', e => {
  e.preventDefault()
  zoomBy((e.scale - 1) * 0.08)
}, { passive: false })

// ── Пanning ────────────────────────────────────────────────
// Способы начать панорамирование:
//   1. Средняя кнопка мыши (MMB)
//   2. Alt + ЛКМ
//   3. Пробел + ЛКМ (Figma/Sketch стиль)
//   4. Левая кнопка мыши в режиме просмотра (editMode === 'view') вне комнат
let _spaceDown = false

window.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.repeat && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault()
    _spaceDown = true
    document.querySelector('.canvas-wrap').style.cursor = 'grab'
  }
})
window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    _spaceDown = false
    if (!isPanning) document.querySelector('.canvas-wrap').style.cursor = ''
  }
})

document.querySelector('.canvas-wrap').addEventListener('mousedown', e => {
  const startPan = e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && _spaceDown)
  if (startPan) {
    e.preventDefault()
    isPanning = true
    panStart = { x: e.clientX, y: e.clientY, panX, panY }
    document.querySelector('.canvas-wrap').style.cursor = 'grabbing'
  }
})
window.addEventListener('mousemove', e => {
  if (!isPanning || !panStart) return
  panX = panStart.panX + (e.clientX - panStart.x)
  panY = panStart.panY + (e.clientY - panStart.y)
  applyZoomTransform()
  document.querySelector('.canvas-wrap').style.cursor = 'grabbing'
})
window.addEventListener('mouseup', e => {
  if (isPanning) {
    isPanning = false; panStart = null
    document.querySelector('.canvas-wrap').style.cursor = _spaceDown ? 'grab' : ''
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

// ── Crop ───────────────────────────────────────────────────
let cropRect    = null   // { x, y, w, h } in canvas-overlay px
let cropRatio   = 'free' // 'free' | '4:3' | '3:4' | '16:9' | '1:1'
let _cropDrag   = null   // { type: 'move'|handle, startX, startY, origRect }

const RATIOS = { 'free': null, '4:3': 4/3, '3:4': 3/4, '16:9': 16/9, '1:1': 1 }

function initCropMode() {
  const overlay = document.getElementById('cropOverlay')
  const wrap    = document.querySelector('.canvas-wrap')
  const wrapRect = wrap.getBoundingClientRect()

  // Default crop: full canvas area, or 4:3 centred
  const cRect = canvas.getBoundingClientRect()
  const cx = cRect.left - wrapRect.left
  const cy = cRect.top  - wrapRect.top
  const cw = cRect.width
  const ch = cRect.height

  let bx, by, bw, bh
  const r = RATIOS[cropRatio]
  if (r) {
    if (cw / ch > r) { bh = ch * 0.9; bw = bh * r } else { bw = cw * 0.9; bh = bw / r }
  } else { bw = cw * 0.85; bh = ch * 0.85 }
  bx = cx + (cw - bw) / 2
  by = cy + (ch - bh) / 2

  cropRect = { x: bx, y: by, w: bw, h: bh }
  overlay.style.display = 'block'
  updateCropBox()

  // Ratio buttons
  document.querySelectorAll('.crop-ratio-btn').forEach(btn => {
    btn.onclick = () => {
      cropRatio = btn.dataset.ratio
      document.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.toggle('active', b === btn))
      enforceRatio()
      updateCropBox()
    }
  })

  // Drag on cropBox (move) and handles (resize)
  const cropBox = document.getElementById('cropBox')
  cropBox.onmousedown = e => {
    if (e.target.classList.contains('crop-handle')) return
    e.preventDefault()
    _cropDrag = { type: 'move', startX: e.clientX, startY: e.clientY, origRect: { ...cropRect } }
  }
  document.querySelectorAll('.crop-handle').forEach(h => {
    h.onmousedown = e => {
      e.preventDefault(); e.stopPropagation()
      _cropDrag = { type: h.dataset.h, startX: e.clientX, startY: e.clientY, origRect: { ...cropRect } }
    }
  })

  window.addEventListener('mousemove', onCropMouseMove)
  window.addEventListener('mouseup',   onCropMouseUp)
}

function onCropMouseMove(e) {
  if (!_cropDrag) return
  const wrap = document.querySelector('.canvas-wrap')
  const wrapRect = wrap.getBoundingClientRect()
  const dx = e.clientX - _cropDrag.startX
  const dy = e.clientY - _cropDrag.startY
  const o  = _cropDrag.origRect
  let { x, y, w, h } = o
  const MIN = 30

  if (_cropDrag.type === 'move') {
    x = o.x + dx; y = o.y + dy
  } else {
    const t = _cropDrag.type
    if (t.includes('e')) w = Math.max(MIN, o.w + dx)
    if (t.includes('s')) h = Math.max(MIN, o.h + dy)
    if (t.includes('w')) { const nw = Math.max(MIN, o.w - dx); x = o.x + o.w - nw; w = nw }
    if (t.includes('n')) { const nh = Math.max(MIN, o.h - dy); y = o.y + o.h - nh; h = nh }
  }

  cropRect = { x, y, w, h }
  enforceRatio()
  updateCropBox()
}

function onCropMouseUp() {
  _cropDrag = null
}

function enforceRatio() {
  const r = RATIOS[cropRatio]
  if (!r) return
  // Keep width, adjust height
  cropRect.h = cropRect.w / r
}

function updateCropBox() {
  const box = document.getElementById('cropBox')
  box.style.left   = cropRect.x + 'px'
  box.style.top    = cropRect.y + 'px'
  box.style.width  = cropRect.w + 'px'
  box.style.height = cropRect.h + 'px'
}

function exitCropMode() {
  document.getElementById('cropOverlay').style.display = 'none'
  window.removeEventListener('mousemove', onCropMouseMove)
  window.removeEventListener('mouseup',   onCropMouseUp)
  _cropDrag = null
}

function applyCrop() {
  if (!currentImageEl || !cropRect) return

  const wrap    = document.querySelector('.canvas-wrap')
  const wrapRect = wrap.getBoundingClientRect()
  const cRect   = canvas.getBoundingClientRect()

  // Convert overlay px → image px
  // cropRect is in wrap coords; canvas is positioned inside wrap
  const scaleX = currentImageEl.naturalWidth  / cRect.width
  const scaleY = currentImageEl.naturalHeight / cRect.height

  // offset of canvas inside wrap
  const offX = cRect.left - wrapRect.left
  const offY = cRect.top  - wrapRect.top

  // crop box in canvas-element px
  const bx = (cropRect.x - offX)
  const by = (cropRect.y - offY)
  const bw = cropRect.w
  const bh = cropRect.h

  // crop in image px (may extend outside image bounds)
  const ix = Math.round(bx * scaleX)
  const iy = Math.round(by * scaleY)
  const iw = Math.round(bw * scaleX)
  const ih = Math.round(bh * scaleY)

  // Build new canvas with white background (handles out-of-bounds)
  const off = document.createElement('canvas')
  off.width  = iw
  off.height = ih
  const c = off.getContext('2d')
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, iw, ih)

  // Draw source image offset so crop origin aligns
  const srcImg = showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl)
  c.drawImage(srcImg, -ix, -iy, currentImageEl.naturalWidth, currentImageEl.naturalHeight)

  // Convert to data URL and reload as new image
  const dataUrl = off.toDataURL('image/jpeg', 0.95)
  const newImg = new Image()
  newImg.onload = () => {
    pushUndo()
    currentImageEl = newImg
    currentImageB64 = dataUrl.split(',')[1]
    currentMime = 'image/jpeg'

    // Сдвигаем полигоны всех помещений на величину кропа (ix, iy) в image px.
    // Точки за пределами нового изображения зажимаем по границе.
    // Комнаты, полностью вышедшие за кадр, удаляем.
    function shiftPolygons(roomList) {
      return roomList.map(room => {
        if (!room.polygon?.length) return room
        const newPoly = room.polygon.map(([x, y]) => [
          Math.max(0, Math.min(iw, Math.round(x - ix))),
          Math.max(0, Math.min(ih, Math.round(y - iy))),
        ])
        const inside = newPoly.some(([x, y]) => x > 0 && x < iw && y > 0 && y < ih)
        if (!inside) return null
        return { ...room, polygon: newPoly }
      }).filter(Boolean)
    }
    rooms = shiftPolygons(rooms)
    originalRooms = shiftPolygons(originalRooms)

    // Rebuild adjusted canvases
    currentImageBW    = null
    currentImageColor = null
    _rawPixels = null

    const rebuildOff = document.createElement('canvas')
    rebuildOff.width  = newImg.naturalWidth
    rebuildOff.height = newImg.naturalHeight
    const rc = rebuildOff.getContext('2d')
    rc.drawImage(newImg, 0, 0)
    const id = rc.getImageData(0, 0, rebuildOff.width, rebuildOff.height)
    _rawPixels = new Uint8ClampedArray(id.data)
    _rawWidth  = rebuildOff.width
    _rawHeight = rebuildOff.height

    currentImageBW = makeBWCanvas(newImg)
    resizeCanvas(newImg)
    buildRoomList()
    exitCropMode()
    setEditMode('view')
    drawPlan()
  }
  newImg.src = dataUrl
}
