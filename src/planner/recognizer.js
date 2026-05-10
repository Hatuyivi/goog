// recognizer.js — локальный CV-пайплайн распознавания помещений
// Чистые функции: нет DOM-зависимостей, нет IPC, нет глобального состояния.
// Подключается до planner.js:  <script src="recognizer.js"></script>

// ── Обучение: фильтрация по площади ───────────────────────
function computeLocalLearning(trainingData, currentHash) {
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

// ── Обучение: фильтрация по форме ─────────────────────────
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

  keptShapes.sort((a, b) => a.c - b.c)
  const compactThresh = keptShapes[Math.floor(keptShapes.length * 0.10)].c * 0.80

  keptShapes.sort((a, b) => a.a - b.a)
  const aspectThresh  = keptShapes[Math.floor(keptShapes.length * 0.90)].a * 1.30

  const trueFiltered = deletedShapes.filter(s => s.c < compactThresh || s.a > aspectThresh).length
  const accuracy = trueFiltered / deletedShapes.length

  if (accuracy < MIN_ACCURACY) return null

  return {
    compactThresh,
    aspectThresh,
    accuracy: Math.round(accuracy * 100),
    sampleCount: localSamples.length,
  }
}

// ── Основной CV-пайплайн ───────────────────────────────────
async function detectRoomsLocal(imageEl, opts) {
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

  const gray = new Uint8Array(W * H)
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114) | 0
  }

  let mean = 0
  for (let i = 0; i < gray.length; i++) mean += gray[i]
  mean /= gray.length
  let variance = 0
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) ** 2
  const stddev = Math.sqrt(variance / gray.length)
  const needsCLAHE = stddev < 40

  // CLAHE — выравнивание гистограммы с ограничением контраста
  if (needsCLAHE) {
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

  const _iSum  = new Float64Array((W+1) * (H+1))
  const _iSum2 = new Float64Array((W+1) * (H+1))

  // Адаптивный порог Саувола (через интегральные образы)
  function sauvolaThreshold(gray, W, H, windowR, k) {
    const iSum  = _iSum
    const iSum2 = _iSum2
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
        const T = localMean * (1 + k * (localStd / 128 - 1))
        bin[y*W+x] = gray[y*W+x] > T ? 1 : 0
      }
    }
    return bin
  }

  const wallEst = Math.max(2, Math.min(40, Math.round(Math.min(W, H) * 0.01)))
  const windowR = Math.max(7, wallEst * 3)
  const K_SAUVOLA = 0.2

  // Автодетект: план vs фото
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
    isPhoto = blockCount > 0 && (blockVarSum / blockCount) > 12
  }

  // Бинаризация
  let bin1, bin2
  if (opts.threshold == null && isPhoto) {
    bin1 = sauvolaThreshold(gray, W, H, windowR,     K_SAUVOLA)
    bin2 = sauvolaThreshold(gray, W, H, windowR + 8, K_SAUVOLA - 0.05)
  } else {
    const T = opts.threshold != null ? opts.threshold : otsu(gray)
    const T_loose = Math.max(T - 30, 80)
    bin1 = new Uint8Array(W * H)
    bin2 = new Uint8Array(W * H)
    for (let i = 0; i < gray.length; i++) {
      bin1[i] = gray[i] > T       ? 1 : 0
      bin2[i] = gray[i] > T_loose ? 1 : 0
    }
  }

  // Эрозия (утолщение стен)
  for (let i = 0; i < opts.dilateK; i++) { bin1 = erode4(bin1, W, H); bin2 = erode4(bin2, W, H) }
  bin2 = erode4(bin2, W, H)

  // Заливка связных областей
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

  const total   = W * H
  const minArea = total * opts.minAreaFrac
  const maxArea = total * 0.70

  function filterRegions(regions, fillRatioMin) {
    return regions.filter(r => {
      if (r.touchesBorder) return false
      if (r.area < minArea || r.area > maxArea) return false
      const bboxArea = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1)
      if (bboxArea > 0 && r.area / bboxArea < fillRatioMin) return false
      return true
    })
  }

  const cand1 = filterRegions(regions1, 0.30)
  const cand2 = filterRegions(regions2, 0.20)

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

  const inv   = 1 / scale
  const rooms = []
  for (let i = 0; i < merged.length; i++) {
    const r = merged[i]
    const isFromLoose = !cand1.includes(r)
    const labelsMap   = isFromLoose ? labels2 : labels1

    const poly = traceContour(labelsMap, r.label, W, H, r)
    if (poly.length < 4) continue
    const simp0 = rdp(poly, opts.epsilon || 2)
    if (simp0.length < 3) continue
    const simp1 = snapToRightAngles(simp0)
    const simp  = cleanJaggedEdges(simp1)
    if (simp.length < 3) continue

    let perim = 0
    for (let k = 0; k < simp.length; k++) {
      const [x1,y1] = simp[k], [x2,y2] = simp[(k+1)%simp.length]
      perim += Math.hypot(x2-x1, y2-y1)
    }
    const compactness = perim > 0 ? (4 * Math.PI * r.area) / (perim * perim) : 1
    const bboxW = r.maxX - r.minX + 1, bboxH = r.maxY - r.minY + 1
    const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH))

    rooms.push({
      id:          `r${i+1}`,
      label:       `Помещение ${i+1}`,
      areaPx:      Math.round(r.area * inv * inv),
      compactness: Math.round(compactness * 100) / 100,
      aspect,
      polygon:     simp.map(([x,y]) => [Math.round(x*inv), Math.round(y*inv)]),
    })
  }
  return rooms
}

// ── Пороговые алгоритмы ────────────────────────────────────

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

// ── Морфология ─────────────────────────────────────────────

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

// ── Трассировка контуров ───────────────────────────────────

function traceContour(labels, label, W, H, region) {
  let sx = -1, sy = -1
  outer: for (let y = region.minY; y <= region.maxY; y++) {
    for (let x = region.minX; x <= region.maxX; x++) {
      if (labels[y * W + x] === label) { sx = x; sy = y; break outer }
    }
  }
  if (sx < 0) return []

  const isLabel = (x, y) =>
    x >= 0 && x < W && y >= 0 && y < H && labels[y * W + x] === label

  const dx = [ 1, 1, 0,-1,-1,-1, 0, 1]
  const dy = [ 0, 1, 1, 1, 0,-1,-1,-1]

  const poly = [[sx, sy]]
  let cx = sx, cy = sy
  let backDir = 4

  const maxSteps = Math.max(
    (region.maxX - region.minX + region.maxY - region.minY + 4) * 8,
    (region.maxX - region.minX + 1) * (region.maxY - region.minY + 1) * 2
  )
  for (let step = 0; step < maxSteps; step++) {
    let found = false
    for (let i = 1; i <= 8; i++) {
      const d = (backDir + i) % 8
      const nx = cx + dx[d], ny = cy + dy[d]
      if (isLabel(nx, ny)) {
        cx = nx; cy = ny
        backDir = (d + 4) % 8
        poly.push([cx, cy])
        found = true
        break
      }
    }
    if (!found) break
    if (cx === sx && cy === sy && poly.length > 2) break
  }
  return poly
}

// ── Упрощение полигонов (RDP + снаппинг) ──────────────────

function rdp(points, eps) {
  const n = points.length
  if (n < 3 || eps <= 0) return points.slice()

  function angleDeg(prev, cur, next) {
    const ax = cur[0] - prev[0], ay = cur[1] - prev[1]
    const bx = next[0] - cur[0],  by = next[1] - cur[1]
    const dot   = ax*bx + ay*by
    const cross  = ax*by - ay*bx
    return Math.abs(Math.atan2(Math.abs(cross), dot) * 180 / Math.PI)
  }

  const angleThr = Math.max(15, 60 - eps * 2)

  const isCorner = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur  = points[i]
    const next = points[(i + 1) % n]
    if (angleDeg(prev, cur, next) > angleThr) isCorner[i] = 1
  }

  const corners = []
  for (let i = 0; i < n; i++) if (isCorner[i]) corners.push(i)
  if (corners.length < 2) return rdpSegment(points, 0, n - 1, eps)

  const keep = new Uint8Array(n)
  for (const ci of corners) keep[ci] = 1

  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % corners.length]
    const seg = []
    let idx = a
    while (idx !== b) { seg.push(idx); idx = (idx + 1) % n }
    seg.push(b)
    if (seg.length < 3) continue
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

function snapToRightAngles(points, snapThr) {
  snapThr = snapThr || 15
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

      if (lenA < 2 || lenB < 2) continue

      const uax = ax / lenA, uay = ay / lenA
      const ubx = bx / lenB, uby = by / lenB

      const dot   = uax * ubx + uay * uby
      const cross = uax * uby - uay * ubx
      const turnDeg = Math.abs(Math.atan2(Math.abs(cross), dot) * 180 / Math.PI)

      if (Math.abs(turnDeg - 90) > snapThr) continue

      const perpAx = -uay, perpAy = uax
      const bAlongPerp = ubx * perpAx + uby * perpAy
      const sign = bAlongPerp >= 0 ? 1 : -1

      const newX = next[0] - lenB * sign * perpAx
      const newY = next[1] - lenB * sign * perpAy

      const shift   = Math.hypot(newX - cur[0], newY - cur[1])
      const minEdge = Math.min(lenA, lenB)
      if (shift > minEdge * 0.35) continue

      result[i] = [Math.round(newX), Math.round(newY)]
      anySnapped = true
    }
    if (!anySnapped) break
  }

  const deduped = []
  for (let i = 0; i < n; i++) {
    const prev = result[(i - 1 + n) % n]
    const cur  = result[i]
    if (Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) >= 1) deduped.push(cur)
  }
  return deduped.length >= 3 ? deduped : points.slice()
}

function cleanJaggedEdges(points, devEps) {
  devEps = devEps || 3
  const n = points.length
  if (n < 4) return points.slice()

  const cornerThrRad = 30 * Math.PI / 180

  const isCorner = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur  = points[i]
    const next = points[(i + 1) % n]
    const ax = cur[0] - prev[0], ay = cur[1] - prev[1]
    const bx = next[0] - cur[0], by = next[1] - cur[1]
    const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by)
    if (lenA < 1 || lenB < 1) { isCorner[i] = 1; continue }
    const dot   = (ax * bx + ay * by) / (lenA * lenB)
    const cross = (ax * by - ay * bx) / (lenA * lenB)
    const turn  = Math.abs(Math.atan2(Math.abs(cross), dot))
    if (turn > cornerThrRad) isCorner[i] = 1
  }

  const corners = []
  for (let i = 0; i < n; i++) if (isCorner[i]) corners.push(i)

  if (corners.length < 2) return points.slice()

  const keep = new Uint8Array(n)
  for (const ci of corners) keep[ci] = 1

  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % corners.length]
    const [x1, y1] = points[a]
    const [x2, y2] = points[b]
    const segLen = Math.hypot(x2 - x1, y2 - y1)

    let idx = (a + 1) % n
    while (idx !== b) {
      const [px, py] = points[idx]
      const dist = segLen > 0
        ? Math.abs((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1) / segLen
        : Math.hypot(px - x1, py - y1)

      if (dist > devEps) keep[idx] = 1
      idx = (idx + 1) % n
    }
  }

  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])

  return out.length >= 3 ? out : points.slice()
}

// ── Геометрия полигонов ────────────────────────────────────

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

function bboxOverlap(a, b) {
  const axMin = Math.min(...a.map(p => p[0])), axMax = Math.max(...a.map(p => p[0]))
  const ayMin = Math.min(...a.map(p => p[1])), ayMax = Math.max(...a.map(p => p[1]))
  const bxMin = Math.min(...b.map(p => p[0])), bxMax = Math.max(...b.map(p => p[0]))
  const byMin = Math.min(...b.map(p => p[1])), byMax = Math.max(...b.map(p => p[1]))
  return axMin < bxMax && axMax > bxMin && ayMin < byMax && ayMax > byMin
}

function unionPolygonsConvexHull(a, b) {
  const pts = [...a, ...b]
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

function clipPolyByOffsetEdge(poly, ax, ay, bx, by, offset) {
  const len = Math.hypot(bx - ax, by - ay)
  if (len < 0.001) return poly
  const nx = -(by - ay) / len
  const ny =  (bx - ax) / len
  const mx = ax + nx * offset
  const my = ay + ny * offset
  const ex = bx + nx * offset
  const ey = by + ny * offset
  return clipPolygonByEdge(poly, ex, ey, mx, my)
}

function mergeOverlappingRooms(roomList) {
  if (!roomList.length) return roomList

  const polys = roomList.map(r => r.polygon.map(p => [...p]))
  const n = polys.length

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!bboxOverlap(polys[i], polys[j])) continue

      const inter = intersectPolygons(polys[i], polys[j])
      if (!inter.length) continue

      const interArea = polygonArea(inter)
      if (interArea < 2) continue

      const areaI = polygonArea(polys[i])
      const areaJ = polygonArea(polys[j])
      if (areaI < 2 || areaJ < 2) continue

      const smaller = Math.min(areaI, areaJ)
      if (interArea / smaller > 0.85) {
        if (areaI < areaJ) polys[i] = []; else polys[j] = []
        continue
      }

      let bestEdge = -1, bestDepth = -Infinity, bestLen = 0
      for (let e = 0; e < polys[i].length; e++) {
        const [ax, ay] = polys[i][e]
        const [bx, by] = polys[i][(e + 1) % polys[i].length]
        const dx = bx - ax, dy = by - ay
        let depth = 0, count = 0
        for (const [px, py] of polys[j]) {
          const d = dx * (py - ay) - dy * (px - ax)
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

      const avgDepth = bestDepth / polys[j].length
      const half = avgDepth / 2

      const newI = clipPolyByOffsetEdge(polys[i], ax, ay, bx, by, -half)
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
