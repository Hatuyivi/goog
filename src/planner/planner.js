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
  document.getElementById('modeLocal').classList.toggle('active',      m === 'local')
  document.getElementById('modeAi').classList.toggle('active',         m === 'ai')
  document.getElementById('modePlaywright').classList.toggle('active', m === 'playwright')
  localParams.classList.toggle('visible', m === 'local')
  aiInfo.style.display = m === 'ai' ? '' : 'none'
  const pwParams = document.getElementById('playwrightParams')
  if (pwParams) pwParams.style.display = m === 'playwright' ? 'flex' : 'none'
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
  if (file) loadFileFromBlob(file)
}
function onFileSelected(e) {
  const file = e.target.files[0]
  if (file) loadFileFromBlob(file)
  e.target.value = ''
}

// Загрузка через FileReader — работает во всех версиях Electron без file.path
function loadFileFromBlob(file) {
  const extMatch = file.name.match(/\.(\w+)$/)
  const ext = extMatch ? extMatch[1].toLowerCase() : ''
  const mimeMap = { 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp' }
  currentMime = mimeMap[ext] || file.type || 'image/jpeg'

  const reader = new FileReader()
  reader.onload = ev => {
    try {
      const dataUrl   = ev.target.result
      currentImageB64 = dataUrl.split(',')[1]

      previewImg.src = dataUrl
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
      img.src = dataUrl
    } catch(e) { alert('Ошибка загрузки: ' + e.message) }
  }
  reader.onerror = () => alert('Не удалось прочитать файл')
  reader.readAsDataURL(file)
}

function loadFile(filePath) {
  try {
    const buf  = fs.readFileSync(filePath)
    const extMatch = filePath.match(/\.(\w+)$/)
    const ext  = extMatch ? extMatch[1].toLowerCase() : ''
    const mimeMap = { 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp' }
    currentMime     = mimeMap[ext] || 'image/jpeg'
    currentImageB64 = buf.toString('base64')

    const dataUrl = `data:${currentMime};base64,${currentImageB64}`
    previewImg.src = dataUrl
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
    img.src = dataUrl
  } catch(e) { alert('Ошибка загрузки: ' + e.message) }
}

// ── BG adjustment state ────────────────────────────────────
let bwMix = { red: 40, orange: 33, yellow: 17, green: -20, aqua: -8, blue: -10, lavender: 0, magenta: 0 }
let basicAdj = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0 }

let _rawPixels   = null
let _rawWidth    = 0
let _rawHeight   = 0
let _rebuildRaf  = null

function makeBWCanvas(img) {
  const off = document.createElement('canvas')
  off.width = img.naturalWidth; off.height = img.naturalHeight
  const c = off.getContext('2d')
  c.drawImage(img, 0, 0)

  const imageData = c.getImageData(0, 0, off.width, off.height)
  _rawPixels = new Uint8ClampedArray(imageData.data)
  _rawWidth  = off.width
  _rawHeight = off.height

  applyColorAdjustments(imageData.data)
  const colOff = document.createElement('canvas')
  colOff.width = off.width; colOff.height = off.height
  colOff.getContext('2d').putImageData(imageData, 0, 0)
  currentImageColor = colOff
  applyBWConversion(imageData.data)
  c.putImageData(imageData, 0, 0)
  return off
}

function rebuildBWCanvas() {
  if (!currentImageEl) return
  if (_rebuildRaf) return
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
  const data = new Uint8ClampedArray(_rawPixels)
  applyColorAdjustments(data)
  if (!currentImageColor) { currentImageColor = document.createElement('canvas'); currentImageColor.width = _rawWidth; currentImageColor.height = _rawHeight }
  currentImageColor.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), _rawWidth, _rawHeight), 0, 0)
  if (eraserStrokes.length) {
    const cc = currentImageColor.getContext('2d')
    cc.fillStyle = '#ffffff'
    for (const stroke of eraserStrokes) for (const pt of stroke) { cc.beginPath(); cc.arc(pt.x, pt.y, pt.r, 0, Math.PI*2); cc.fill() }
  }
  applyBWConversion(data)

  const imageData = new ImageData(data, _rawWidth, _rawHeight)
  c.putImageData(imageData, 0, 0)

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

    r *= expMult; g *= expMult; b *= expMult

    const lum0 = 0.299*r + 0.587*g + 0.114*b
    const satF = sat + vib * (1 - Math.abs(2*lum0 - 1))
    if (satF !== 1) {
      r = lum0 + (r - lum0) * satF
      g = lum0 + (g - lum0) * satF
      b = lum0 + (b - lum0) * satF
    }

    if (deh !== 0) {
      const lift = deh * 0.15
      r -= lift; g -= lift; b -= lift
      if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0
    }

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

  ctx.save()
  const srcImg = showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl)
  ctx.drawImage(srcImg, 0, 0, canvas.width, canvas.height)

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
    const iz = 1 / zoomLevel
    ctx.lineWidth   = (isSelected ? 3 : isChecked ? 2.5 : STROKE_WIDTH) * iz
    ctx.stroke()

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

  if (editMode === 'edit' && showPolygons) {
    for (const room of rooms) {
      if (!room.polygon) continue
      if (currentView === 'selected' && room.id !== selectedRoomId) continue
      const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])

      const iz = 1 / zoomLevel

      for (let i = 0; i < pts.length; i++) {
        const j = (i+1) % pts.length
        const mx = (pts[i][0]+pts[j][0])/2, my = (pts[i][1]+pts[j][1])/2
        const isHovered = hoverState?.roomId===room.id && hoverState?.edgeIdx===i
        ctx.globalAlpha = isHovered ? 1 : 0.35
        ctx.beginPath(); ctx.arc(mx, my, (isHovered ? 5 : 3) * iz, 0, Math.PI*2)
        ctx.fillStyle = '#007aff'; ctx.fill()
      }

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

// ── Click handler ──────────────────────────────────────────
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
        if (selectedRoomIds.has(room.id)) selectedRoomIds.delete(room.id)
        else selectedRoomIds.add(room.id)
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

// ── CV-функции распознавания ────────────────────────────
// detectRoomsLocal, otsu, erode4, traceContour, rdp, rdpSegment,
// snapToRightAngles, cleanJaggedEdges, polygonArea, bboxOverlap,
// intersectPolygons, unionPolygonsConvexHull, clipPolyByOffsetEdge,
// mergeOverlappingRooms, computeLocalLearning, computeShapeFilter
// → вынесены в recognizer.js

// ── Analyse ────────────────────────────────────────────────
async function analysePlan() {
  if (!currentImageB64) return
  analyseBtn.disabled = true
  try {
    if (mode === 'local')      await analyseLocal()
    else if (mode === 'ai')    await analyseAI()
    else                       await analysePlaywright()
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

// ── Playwright / local-model recognition ──────────────────
//
// Алгоритм:
//  1. Отправляем оригинальное изображение на локальный сервер (multipart/form-data).
//  2. Сервер возвращает PNG с помещениями, закрашенными уникальными цветами.
//  3. Парсим цветные регионы через flood-fill прямо в браузере.
//  4. Для каждого региона строим полигон контура (тот же traceContour из recognizer.js).
//  5. Полигоны накладываем на ОРИГИНАЛЬНОЕ изображение.
//
async function analysePlaywright() {
  const urlInput    = document.getElementById('playwrightUrl')
  const promptInput = document.getElementById('playwrightPrompt')
  const statusEl    = document.getElementById('playwrightStatus')

  const serverUrl  = (urlInput?.value  || 'http://localhost:3000/generate').trim()
  const userPrompt = (promptInput?.value || '').trim() ||
    'выдели помещения уникальными цветами, игнорируй МОП'

  if (statusEl) statusEl.textContent = ''

  showProgress('Отправляем план на локальную модель…', serverUrl)
  setProgressStep('Подготовка изображения…')
  await tick()

  // Конвертируем base64 → Blob
  const byteStr  = atob(currentImageB64)
  const byteArr  = new Uint8Array(byteStr.length)
  for (let i = 0; i < byteStr.length; i++) byteArr[i] = byteStr.charCodeAt(i)
  const blob     = new Blob([byteArr], { type: currentMime })
  const ext      = currentMime.includes('png') ? 'png' : 'jpg'

  const form = new FormData()
  form.append('prompt', userPrompt)
  form.append('image',  blob, `plan.${ext}`)

  setProgressStep('Ожидаем ответ сервера…')
  await tick()

  let responseBlob
  try {
    const resp = await fetch(serverUrl, { method: 'POST', body: form })
    if (!resp.ok) throw new Error(`Сервер вернул ${resp.status}: ${resp.statusText}`)
    responseBlob = await resp.blob()
  } catch (err) {
    if (err.message.startsWith('Сервер вернул')) throw err
    throw new Error(`Не удалось подключиться к ${serverUrl}.\nПроверь, что сервер запущен и в gemini_api.js добавлены CORS-заголовки.\n\n${err.message}`)
  }

  setProgressStep('Анализ цветных регионов…')
  await tick()

  // Загружаем ответное изображение в <img>
  const coloredUrl = URL.createObjectURL(responseBlob)
  const coloredImg = await new Promise((res, rej) => {
    const img   = new Image()
    const timer = setTimeout(() => rej(new Error('Таймаут декодирования изображения (10 сек)')), 10000)
    img.onload  = () => { clearTimeout(timer); res(img) }
    img.onerror = () => { clearTimeout(timer); rej(new Error('Не удалось декодировать ответное изображение')) }
    img.src = coloredUrl
  })

  const CW = coloredImg.naturalWidth
  const CH = coloredImg.naturalHeight

  // Рисуем на offscreen canvas
  const offC = document.createElement('canvas')
  offC.width = CW; offC.height = CH
  const offCtx = offC.getContext('2d')
  offCtx.drawImage(coloredImg, 0, 0, CW, CH)
  URL.revokeObjectURL(coloredUrl)

  const imgData = offCtx.getImageData(0, 0, CW, CH)
  const px      = imgData.data

  // Масштаб: ответное изображение может отличаться по размеру от оригинала
  const origW = currentImageEl.naturalWidth
  const origH = currentImageEl.naturalHeight
  const scaleX = origW / CW
  const scaleY = origH / CH

  // ── Разделяем пиксели на цветовые кластеры ──────────────
  // Квантуем цвет → 32-bit ключ (каждый канал округляем до 8)
  const QUANT = 32
  const colorMap  = new Map()   // key → label
  const labelArr  = new Int32Array(CW * CH)
  let   nextLabel = 1

  // Белые / серые / тёмные пиксели — фон/стены (игнорируем)
  function isBg(r, g, b) {
    const mn = Math.min(r, g, b)
    const mx = Math.max(r, g, b)
    // Ахроматический: насыщенность < порога  ИЛИ  очень светлый / очень тёмный
    if (mx - mn < 30) return true     // серый / белый / чёрный
    if (mx < 30)      return true     // очень тёмный
    return false
  }

  for (let i = 0; i < CW * CH; i++) {
    const r = px[i*4], g = px[i*4+1], b = px[i*4+2]
    if (isBg(r, g, b)) { labelArr[i] = 0; continue }
    const qr = Math.round(r / QUANT) * QUANT
    const qg = Math.round(g / QUANT) * QUANT
    const qb = Math.round(b / QUANT) * QUANT
    const key = (qr << 16) | (qg << 8) | qb
    if (!colorMap.has(key)) colorMap.set(key, nextLabel++)
    labelArr[i] = colorMap.get(key)
  }

  // ── Flood-fill внутри каждого цветового класса ───────────
  const regionLabels = new Int32Array(CW * CH)   // итоговые метки регионов
  let   regionId     = 1
  const regionInfo   = []   // { id, minX, maxX, minY, maxY, area, colorLabel }
  const stack        = new Int32Array(CW * CH)

  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const idx = y * CW + x
      if (labelArr[idx] === 0 || regionLabels[idx] !== 0) continue

      const cl = labelArr[idx]
      let minX = x, maxX = x, minY = y, maxY = y, area = 0
      let sp = 0
      stack[sp++] = idx
      regionLabels[idx] = regionId

      while (sp > 0) {
        const p  = stack[--sp]
        const py = (p / CW) | 0
        const px_ = p - py * CW
        area++
        if (px_ < minX) minX = px_; if (px_ > maxX) maxX = px_
        if (py  < minY) minY = py;  if (py  > maxY) maxY = py
        const check = (nx, ny) => {
          if (nx < 0 || nx >= CW || ny < 0 || ny >= CH) return
          const ni = ny * CW + nx
          if (labelArr[ni] === cl && regionLabels[ni] === 0) {
            regionLabels[ni] = regionId
            stack[sp++] = ni
          }
        }
        check(px_-1, py); check(px_+1, py)
        check(px_, py-1); check(px_, py+1)
      }

      regionInfo.push({ id: regionId, minX, maxX, minY, maxY, area, colorLabel: cl })
      regionId++
    }
  }

  await tick()

  // ── Фильтрация: убираем слишком мелкие и слишком большие ─
  const total    = CW * CH
  const minArea  = total * 0.003   // < 0.3% площади → мусор
  const maxArea  = total * 0.70

  const candidates = regionInfo.filter(r =>
    r.area >= minArea && r.area <= maxArea
  )

  if (!candidates.length) {
    throw new Error(
      'Сервер вернул изображение, но цветных помещений не обнаружено.\n' +
      'Проверь промпт или вывод сервера.'
    )
  }

  // Сортировка сверху-вниз, слева-направо (как в local CV)
  candidates.sort((a, b) => {
    const cyA = (a.minY + a.maxY) / 2, cyB = (b.minY + b.maxY) / 2
    if (Math.abs(cyA - cyB) > 20) return cyA - cyB
    return (a.minX + a.maxX) / 2 - (b.minX + b.maxX) / 2
  })

  // ── Строим полигоны (traceContour + rdp из recognizer.js) ─
  rooms = []
  let roomIdx = 1

  for (const region of candidates) {
    const poly = traceContour(regionLabels, region.id, CW, CH, region)
    if (poly.length < 4) continue

    const simp0 = rdp(poly, 2)
    if (simp0.length < 3) continue
    const simp1 = snapToRightAngles(simp0)
    const simp  = cleanJaggedEdges(simp1)
    if (simp.length < 3) continue

    // Масштабируем координаты обратно на оригинальное изображение
    const scaledPoly = simp.map(([x, y]) => [
      Math.round(x * scaleX),
      Math.round(y * scaleY),
    ])

    rooms.push({
      id:      `r${roomIdx}`,
      label:   `Помещение ${roomIdx}`,
      areaPx:  Math.round(region.area * scaleX * scaleY),
      compactness: null,
      aspect:  null,
      polygon: scaledPoly,
      mode:    'playwright',
    })
    roomIdx++
  }

  if (!rooms.length) throw new Error('Помещения не найдены — полигоны не удалось построить.')

  if (statusEl) statusEl.textContent = `✓ Получено ${rooms.length} помещений от локальной модели`

  finishAnalysis()
}

async function analyseLocal() {
  showProgress('Локальный анализ…', 'Загрузка данных обучения')
  await tick()

  const trainingData = await ipcRenderer.invoke('get-training-data')

  if (_rebuildRaf) { cancelAnimationFrame(_rebuildRaf); _rebuildRaf = null; _doRebuildBWCanvas() }

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

  const currentHash = imageHash()
  setProgressStep('Подготовка изображения')
  await tick()

  const tManual = Number(paramThreshold.value)
  const dilateK = Number(paramDilate.value)
  const minPct  = Number(paramMinArea.value) / 1000
  const epsilon = Number(paramEpsilon.value)

  setProgressStep('Поиск стен и помещений…')
  await tick()

  rooms = await detectRoomsLocal(recognitionCanvas || currentImageEl, {
    threshold: tManual || null,
    dilateK,
    minAreaFrac: minPct,
    epsilon,
  })

  const learned = computeLocalLearning(trainingData, currentHash)
  let filteredCount = 0
  if (learned && rooms.length) {
    const imgArea = currentImageEl.naturalWidth * currentImageEl.naturalHeight
    const before  = rooms.length
    rooms = rooms.filter(r => {
      if (typeof r.areaPx !== 'number') return true
      const frac = r.areaPx / imgArea
      return frac >= learned.minAreaFrac && frac <= learned.maxAreaFrac
    })
    filteredCount = before - rooms.length
  }

  if (!rooms.length) throw new Error('Помещения не найдены. Попробуй уменьшить «Мин. площадь» или включить «Утолщение стен».')

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

  const beforeMerge = rooms.length
  rooms = mergeOverlappingRooms(rooms)
  if (rooms.length < beforeMerge) {
    rooms.forEach((r, i) => { r.id = `r${i+1}`; r.label = `Помещение ${i+1}` })
  }

  finishAnalysis()

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
const VERTEX_HIT_R  = 8
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
    for (let i = 0; i < pts.length; i++) {
      const d = ptDistSq(cx, cy, pts[i][0], pts[i][1])
      if (d < bestVDist) { bestVDist = d; bestV = { roomId: room.id, ptIdx: i } }
    }
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
  if (!room || room.polygon.length <= 3) return
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
  const wrap = document.querySelector('.canvas-wrap')
  const wRect = wrap.getBoundingClientRect()
  const ox = originX !== undefined ? originX - wRect.left - wRect.width / 2 : 0
  const oy = originY !== undefined ? originY - wRect.top  - wRect.height / 2 : 0

  const oldZoom = zoomLevel
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel * (1 + delta)))

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

  if (editMode === 'collider') {
    const [ix, iy] = canvasToImage(cx, cy)
    roomDraw = { x0: ix, y0: iy, x1: ix, y1: iy }
    e.preventDefault()
    return
  }

  if (editMode === 'rescan') {
    const [ix, iy] = canvasToImage(cx, cy)
    roomDraw = { x0: ix, y0: iy, x1: ix, y1: iy }
    e.preventDefault()
    return
  }

  if (!rooms.length) return

  if (editMode === 'delete') {
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
      pushUndo()
      dragState = { roomId: hit.roomId, ptIdx: hit.ptIdx }
      selectRoom(hit.roomId)
      e.preventDefault()
    } else if (hit.edgeIdx !== undefined) {
      addVertexOnEdge(hit.roomId, hit.edgeIdx, cx, cy)
      const room = rooms.find(r => r.id === hit.roomId)
      dragState = { roomId: hit.roomId, ptIdx: hit.edgeIdx + 1 }
      selectRoom(hit.roomId)
      e.preventDefault()
    }
    return
  }

  if (editMode === 'view' && e.button === 0 && !e.altKey && !_spaceDown) {
    const sx = canvas.width  / currentImageEl.naturalWidth
    const sy = canvas.height / currentImageEl.naturalHeight
    for (const room of [...rooms].reverse()) {
      if (!room.polygon) continue
      const pts = room.polygon.map(([x,y]) => [x*sx, y*sy])
      if (pointInPolygon(cx, cy, pts)) { selectRoom(room.id); return }
    }
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

  if (editMode === 'eraser') {
    canvas.style.cursor = 'none'
    drawPlan()
    if (eraserActive && currentImageBW) {
      const [ix, iy] = canvasToImage(cx, cy)
      const r = eraserSize * currentImageEl.naturalWidth / canvas.width
      eraserCurrentStroke.push({ x: ix, y: iy, r })
      drawPlan()
    }
    const r = eraserSize
    ctx.save()
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
    return
  }

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
  if (editMode === 'eraser') {
    eraserActive = false
    eraserCurrentStroke = []
    return
  }

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

      let mergedRoomId = newRoom.id
      let mergedPoly = newRoom.polygon.map(p => [...p])
      const toAbsorb = []

      for (let i = 0; i < rooms.length - 1; i++) {
        const other = rooms[i]
        if (!other.polygon || other.polygon.length < 3) continue
        if (!bboxOverlap(mergedPoly, other.polygon)) continue
        const inter = intersectPolygons(mergedPoly, other.polygon)
        if (!inter.length || polygonArea(inter) < 4) continue
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
async function rescanZone(x0, y0, x1, y1) {
  if (!currentImageEl) return
  const imgW = currentImageEl.naturalWidth
  const imgH = currentImageEl.naturalHeight

  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0))
  x1 = Math.min(imgW, Math.round(x1)); y1 = Math.min(imgH, Math.round(y1))
  const zw = x1 - x0, zh = y1 - y0
  if (zw < 10 || zh < 10) return

  showProgress('Доиск…', 'Вырезаем зону')
  await tick()

  const zoneCanvas = document.createElement('canvas')
  zoneCanvas.width = zw; zoneCanvas.height = zh
  const zc = zoneCanvas.getContext('2d')
  const srcImg = showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl)
  zc.drawImage(srcImg, x0, y0, zw, zh, 0, 0, zw, zh)

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
    const dilateK = Number(paramDilate.value)
    const minPct  = Number(paramMinArea.value) / 1000
    const epsilon = Number(paramEpsilon.value)

    const zoneRooms = await detectRoomsLocal(zoneCanvas, {
      threshold:   tManual || null,
      dilateK,
      minAreaFrac: minPct,
      epsilon,
    })

    const translated = zoneRooms.map(r => ({
      ...r,
      polygon: r.polygon.map(([px, py]) => [px + x0, py + y0]),
      areaPx:  r.areaPx,
    }))

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
  if (!currentImageB64) return 'none'
  return `${currentImageEl?.naturalWidth}x${currentImageEl?.naturalHeight}_${currentImageB64.slice(0, 80)}`
}

async function saveEdits() {
  const hash = imageHash()
  const deletedIds = originalRooms
    .filter(o => !rooms.find(r => r.id === o.id))
    .map(o => o.id)

  const addedIds = rooms
    .filter(r => !originalRooms.find(o => o.id === r.id))
    .map(r => r.id)

  const sample = {
    imageHash:  hash,
    savedAt:    new Date().toISOString(),
    mode,
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

  const orig = trainingBadge.style.background
  trainingBadge.style.background = '#d4f8df'
  setTimeout(() => { trainingBadge.style.background = orig }, 800)
}

function tick() { return new Promise(r => setTimeout(r, 0)) }

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
let _wheelAccum   = 0
let _wheelRafId   = null
let _wheelOriginX = 0
let _wheelOriginY = 0
const WHEEL_SENSITIVITY = 0.0008
const WHEEL_MAX_STEP    = 0.18

function _flushWheel() {
  _wheelRafId = null
  if (_wheelAccum === 0) return
  const clamped = Math.max(-WHEEL_MAX_STEP, Math.min(WHEEL_MAX_STEP, _wheelAccum * WHEEL_SENSITIVITY))
  zoomBy(-clamped, _wheelOriginX, _wheelOriginY)
  _wheelAccum = 0
}

document.querySelector('.canvas-wrap').addEventListener('wheel', e => {
  e.preventDefault()
  if (editMode === 'eraser') {
    eraserSize = Math.max(5, Math.min(150, eraserSize - Math.sign(e.deltaY) * 3))
    const sizeEl  = document.getElementById('eraserSizeVal');   if (sizeEl)  sizeEl.textContent  = eraserSize
    const sizeEl2 = document.getElementById('eraserSizeVal2');  if (sizeEl2) sizeEl2.textContent = eraserSize
    const slider  = document.getElementById('eraserSizeSlider');if (slider)  slider.value        = eraserSize
    drawPlan()
    return
  }
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

document.querySelector('.canvas-wrap').addEventListener('gesturestart', e => e.preventDefault(), { passive: false })
document.querySelector('.canvas-wrap').addEventListener('gesturechange', e => {
  e.preventDefault()
  zoomBy((e.scale - 1) * 0.08)
}, { passive: false })

// ── Panning ────────────────────────────────────────────────
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

function clearEraserStrokes() {
  eraserStrokes = []
  rebuildBWCanvas()
}

function applyBWMix(key, val) {
  bwMix[key] = Number(val)
  rebuildBWCanvas()
}
function applyBasicAdj(key, val) {
  basicAdj[key] = Number(val)
  rebuildBWCanvas()
}

// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    if (undoStack.length) { e.preventDefault(); undo() }
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn() }
    if (e.key === '-')                  { e.preventDefault(); zoomOut() }
    if (e.key === '0')                  { e.preventDefault(); resetZoom() }
  }
})

// ── Boot ───────────────────────────────────────────────────
init()
updateTrainingBadge()

// ── Crop ───────────────────────────────────────────────────
let cropRect    = null
let cropRatio   = 'free'
let _cropDrag   = null

const RATIOS = { 'free': null, '4:3': 4/3, '3:4': 3/4, '16:9': 16/9, '1:1': 1 }

function initCropMode() {
  const overlay = document.getElementById('cropOverlay')
  const wrap    = document.querySelector('.canvas-wrap')
  const wrapRect = wrap.getBoundingClientRect()

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

  document.querySelectorAll('.crop-ratio-btn').forEach(btn => {
    btn.onclick = () => {
      cropRatio = btn.dataset.ratio
      document.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.toggle('active', b === btn))
      enforceRatio()
      updateCropBox()
    }
  })

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

  const scaleX = currentImageEl.naturalWidth  / cRect.width
  const scaleY = currentImageEl.naturalHeight / cRect.height

  const offX = cRect.left - wrapRect.left
  const offY = cRect.top  - wrapRect.top

  const bx = (cropRect.x - offX)
  const by = (cropRect.y - offY)
  const bw = cropRect.w
  const bh = cropRect.h

  const ix = Math.round(bx * scaleX)
  const iy = Math.round(by * scaleY)
  const iw = Math.round(bw * scaleX)
  const ih = Math.round(bh * scaleY)

  const off = document.createElement('canvas')
  off.width  = iw
  off.height = ih
  const c = off.getContext('2d')
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, iw, ih)

  const srcImg = showBWBackground ? (currentImageBW || currentImageEl) : (currentImageColor || currentImageEl)
  c.drawImage(srcImg, -ix, -iy, currentImageEl.naturalWidth, currentImageEl.naturalHeight)

  const dataUrl = off.toDataURL('image/jpeg', 0.95)
  const newImg = new Image()
  newImg.onload = () => {
    pushUndo()
    currentImageEl = newImg
    currentImageB64 = dataUrl.split(',')[1]
    currentMime = 'image/jpeg'

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
