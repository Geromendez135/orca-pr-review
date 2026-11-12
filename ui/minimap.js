const WIDTH = 96
const SCALE = 0.1
const CHAR_W = 0.85
const MAX_CHARS = 110

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function textRuns(text) {
  const runs = []
  let col = 0
  let start = -1
  const limit = Math.min(text.length, MAX_CHARS)
  for (let i = 0; i < limit; i++) {
    const ch = text[i]
    const width = ch === '\t' ? 2 : 1
    if (ch === ' ' || ch === '\t') {
      if (start >= 0) runs.push([start, col - start])
      start = -1
    } else if (start < 0) start = col
    col += width
  }
  if (start >= 0) runs.push([start, col - start])
  return runs
}

function rowKind(tr) {
  const c = tr.classList
  if (c.contains('composer')) return 'composer'
  if (c.contains('comment')) return 'comment'
  if (c.contains('hunk')) return 'hunk'
  if (c.contains('viewed-del')) return 'viewed-del'
  if (c.contains('add')) return 'add'
  if (c.contains('del')) return 'del'
  return 'ctx'
}

/** A VS Code style overview of the diff pane: one tiny block per character, scaled 1:10. */
export function createMinimap(scroller, canvas) {
  const ctx = canvas.getContext('2d')
  let rows = []
  let colors = {}
  let contentHeight = 0
  let hover = false
  let drag = null
  let frame = 0
  let rebuildTimer = 0

  function readColors() {
    colors = {
      fg: cssVar('--fg'),
      muted: cssVar('--muted-fg'),
      card: cssVar('--card'),
      border: cssVar('--border'),
      addBg: cssVar('--add-num'),
      delBg: cssVar('--del-num'),
      addFg: cssVar('--add-fg'),
      delFg: cssVar('--del-fg'),
      sel: cssVar('--sel-bg'),
      viewed: cssVar('--viewed-bar'),
      comment: cssVar('--mod-fg'),
      bg: cssVar('--bg')
    }
  }

  function rebuild() {
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop
    const next = []
    for (const section of scroller.querySelectorAll('section.file')) {
      const head = section.querySelector('.file-head')
      const top = section.getBoundingClientRect().top - origin
      next.push({
        kind: 'head',
        y: top,
        h: head?.offsetHeight ?? 30,
        label: (section.dataset.path ?? '').split('/').pop(),
        collapsed: section.classList.contains('collapsed')
      })
      for (const tr of section.querySelectorAll('tr')) {
        const rect = tr.getBoundingClientRect()
        if (!rect.height) continue
        const kind = rowKind(tr)
        const code = tr.querySelector('td.code span:nth-child(2)')
        next.push({
          kind,
          y: rect.top - origin,
          h: rect.height,
          runs: code ? textRuns(code.textContent ?? '') : [],
          viewed: tr.classList.contains('viewed'),
          sel: tr.classList.contains('sel')
        })
      }
    }
    rows = next
    contentHeight = scroller.scrollHeight
    schedule()
  }

  function scheduleRebuild() {
    clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(rebuild, 120)
  }

  function geometry() {
    const canvasH = canvas.clientHeight
    const mapH = contentHeight * SCALE
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight)
    const top = mapH <= canvasH ? 0 : (scroller.scrollTop / maxScroll) * (mapH - canvasH)
    const sliderY = scroller.scrollTop * SCALE - top
    const sliderH = Math.max(12, scroller.clientHeight * SCALE)
    return { canvasH, mapH, maxScroll, top, sliderY, sliderH }
  }

  function firstRowAt(y) {
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].y + rows[mid].h < y) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function draw() {
    frame = 0
    const dpr = window.devicePixelRatio || 1
    const cssH = canvas.clientHeight
    if (canvas.width !== WIDTH * dpr || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = WIDTH * dpr
      canvas.height = Math.round(cssH * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, WIDTH, cssH)
    const g = geometry()
    const labels = []
    const lineH = Math.max(1, 20 * SCALE * 0.7)

    for (let i = firstRowAt(g.top / SCALE); i < rows.length; i++) {
      const row = rows[i]
      const y = row.y * SCALE - g.top
      if (y > g.canvasH) break
      const h = Math.max(1, row.h * SCALE)
      if (row.kind === 'head') {
        ctx.fillStyle = colors.card
        ctx.fillRect(0, y, WIDTH, Math.max(2, h))
        ctx.fillStyle = colors.border
        ctx.fillRect(0, y, WIDTH, 1)
        labels.push({ y, text: row.label, collapsed: row.collapsed })
        continue
      }
      if (row.kind === 'hunk') {
        ctx.fillStyle = colors.border
        ctx.fillRect(0, y + h / 2, WIDTH, 1)
        continue
      }
      if (row.kind === 'comment' || row.kind === 'composer') {
        ctx.fillStyle = colors.comment
        ctx.globalAlpha = 0.35
        ctx.fillRect(0, y, WIDTH, h)
        ctx.globalAlpha = 1
        ctx.fillRect(WIDTH - 4, y, 4, h)
        continue
      }
      if (row.kind === 'add' || row.kind === 'del') {
        ctx.fillStyle = row.kind === 'add' ? colors.addBg : colors.delBg
        ctx.fillRect(0, y, WIDTH, h)
      }
      if (row.sel) {
        ctx.fillStyle = colors.sel
        ctx.fillRect(0, y, WIDTH, h)
      }
      if (row.viewed || row.kind === 'viewed-del') {
        ctx.fillStyle = colors.viewed
        ctx.fillRect(0, y, 2, h)
      }
      ctx.fillStyle = row.kind === 'add' ? colors.addFg : row.kind === 'del' ? colors.delFg : colors.fg
      ctx.globalAlpha = row.kind === 'ctx' ? 0.45 : 0.85
      for (const [x, len] of row.runs) ctx.fillRect(4 + x * CHAR_W, y + 0.3, len * CHAR_W, lineH)
      ctx.globalAlpha = 1
    }

    ctx.font = '600 9px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'
    ctx.textBaseline = 'top'
    for (const label of labels) {
      const width = Math.min(WIDTH - 4, ctx.measureText(label.text).width + 6)
      ctx.fillStyle = colors.bg
      ctx.globalAlpha = 0.85
      ctx.fillRect(2, label.y + 1, width, 11)
      ctx.globalAlpha = label.collapsed ? 0.6 : 1
      ctx.fillStyle = colors.fg
      ctx.fillText(label.text, 5, label.y + 2, WIDTH - 10)
      ctx.globalAlpha = 1
    }

    ctx.fillStyle = colors.fg
    ctx.globalAlpha = drag ? 0.24 : hover ? 0.18 : 0.12
    ctx.fillRect(0, g.sliderY, WIDTH, g.sliderH)
    ctx.globalAlpha = drag || hover ? 0.5 : 0.3
    ctx.fillRect(0, g.sliderY, WIDTH, 1)
    ctx.fillRect(0, g.sliderY + g.sliderH - 1, WIDTH, 1)
    ctx.globalAlpha = 1
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  function scrollToSlider(sliderY) {
    const g = geometry()
    if (g.mapH <= g.canvasH) {
      scroller.scrollTop = sliderY / SCALE
      return
    }
    const ratio = SCALE - (g.mapH - g.canvasH) / g.maxScroll
    scroller.scrollTop = ratio > 0 ? sliderY / ratio : (sliderY / (g.canvasH - g.sliderH)) * g.maxScroll
  }

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const y = e.clientY - canvas.getBoundingClientRect().top
    const g = geometry()
    if (y >= g.sliderY && y <= g.sliderY + g.sliderH) {
      drag = { grab: y - g.sliderY }
    } else {
      scroller.scrollTop = (y + g.top) / SCALE - scroller.clientHeight / 2
      drag = { grab: g.sliderH / 2 }
    }
    schedule()
    const move = (ev) => scrollToSlider(ev.clientY - canvas.getBoundingClientRect().top - drag.grab)
    const up = () => {
      drag = null
      schedule()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    scroller.scrollTop += e.deltaY
  }, { passive: false })
  canvas.addEventListener('mouseenter', () => { hover = true; schedule() })
  canvas.addEventListener('mouseleave', () => { hover = false; schedule() })

  scroller.addEventListener('scroll', schedule, { passive: true })
  new MutationObserver(scheduleRebuild).observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  new MutationObserver(() => { readColors(); scheduleRebuild() }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  new ResizeObserver(scheduleRebuild).observe(scroller)
  new ResizeObserver(schedule).observe(canvas)
  readColors()
  scheduleRebuild()

  return { refresh: scheduleRebuild, width: WIDTH }
}
