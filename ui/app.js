import hljs from '../vendor/highlight.min.js'
import { createMinimap } from './minimap.js'

const isEditor = document.documentElement.dataset.mode === 'editor' && !!orca.document
const app = document.getElementById('app')

const S = {
  wsPath: null,
  data: null,
  mode: 'local',
  loading: false,
  error: null,
  files: new Map(),
  fullFiles: new Set(),
  viewedFiles: {},
  viewedChanges: new Set(),
  comments: [],
  expanded: new Set(),
  collapsed: new Set(),
  closedDirs: new Set(),
  hideViewed: false,
  minimap: true,
  gen: 0,
  find: { open: false, query: '', caseSensitive: false, matches: [], index: -1 },
  filter: '',
  treeOpen: true,
  current: null,
  selection: null,
  composer: null,
  editing: null,
  targets: [],
  targetId: null,
  note: '',
  sending: false
}

const PREFS_KEY = 'ui:prefs'

// ---------- helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'html') el.innerHTML = value
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'style') el.style.cssText = value
    else el.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

const request = (name, input = {}, timeoutMs = 60000) =>
  orca.plugin.request(name, { path: S.wsPath ?? undefined, ...input }, { timeoutMs })

function toast(text) {
  const el = h('div', { class: 'toast' }, text)
  document.body.append(el)
  setTimeout(() => el.remove(), 2600)
}

function savePrefs() {
  orca.storage.set(PREFS_KEY, { mode: S.mode, hideViewed: S.hideViewed, minimap: S.minimap }).catch(() => {})
}

const kids = (...items) => items.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---------- syntax highlighting ----------

const EXT_LANG = {
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby', ru: 'ruby', erb: 'ruby', jbuilder: 'ruby',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', sql: 'sql',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', m: 'objectivec', mm: 'objectivec',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  graphql: 'graphql', gql: 'graphql', ini: 'ini', toml: 'ini', lua: 'lua', diff: 'diff', patch: 'diff'
}
const NAME_LANG = { Gemfile: 'ruby', Rakefile: 'ruby', Podfile: 'ruby', Fastfile: 'ruby', Dockerfile: 'bash', Makefile: 'makefile', Justfile: 'makefile', justfile: 'makefile' }

function languageFor(path) {
  const name = path.split('/').pop()
  if (NAME_LANG[name]) return NAME_LANG[name]
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const lang = EXT_LANG[ext]
  return lang && hljs.getLanguage(lang) ? lang : null
}

function splitHighlighted(html) {
  const lines = []
  const stack = []
  let current = ''
  const re = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g
  let m
  while ((m = re.exec(html))) {
    const tok = m[0]
    if (tok === '\n') {
      lines.push(current + '</span>'.repeat(stack.length))
      current = stack.join('')
    } else if (tok.startsWith('<span')) {
      stack.push(tok)
      current += tok
    } else if (tok === '</span>') {
      stack.pop()
      current += tok
    } else current += tok
  }
  lines.push(current + '</span>'.repeat(stack.length))
  return lines
}

function highlightBlock(texts, lang) {
  if (!lang || !texts.length || texts.some((t) => t.length > 3000)) return texts.map(escapeHtml)
  try {
    return splitHighlighted(hljs.highlight(texts.join('\n'), { language: lang, ignoreIllegals: true }).value)
  } catch {
    return texts.map(escapeHtml)
  }
}

function highlightHunk(lines, lang) {
  const oldIdx = []
  const newIdx = []
  lines.forEach((l, i) => {
    if (l.t !== '+') oldIdx.push(i)
    if (l.t !== '-') newIdx.push(i)
  })
  const oldHtml = highlightBlock(oldIdx.map((i) => lines[i].s), lang)
  const newHtml = highlightBlock(newIdx.map((i) => lines[i].s), lang)
  const out = new Array(lines.length)
  newIdx.forEach((i, k) => (out[i] = newHtml[k]))
  oldIdx.forEach((i, k) => {
    if (lines[i].t === '-') out[i] = oldHtml[k]
  })
  return out
}

// ---------- state helpers ----------

const fileMeta = (path) => S.data?.files.find((f) => f.path === path)

function isFileViewed(f) {
  if (S.viewedFiles[f.path] === f.hash) return true
  return f.changeKeys.length > 0 && f.changeKeys.every((k) => S.viewedChanges.has(k))
}
const isStale = (f) => !!S.viewedFiles[f.path] && S.viewedFiles[f.path] !== f.hash && !isFileViewed(f)
const isCollapsed = (f) => S.collapsed.has(f.path) || (isFileViewed(f) && !S.expanded.has(f.path))
const fileId = (path) => 'f-' + path.replace(/[^a-zA-Z0-9]/g, '_')

function visibleFiles() {
  const q = S.filter.trim().toLowerCase()
  return (S.data?.files ?? []).filter((f) => {
    if (S.hideViewed && isFileViewed(f)) return false
    return !q || f.path.toLowerCase().includes(q)
  })
}

// ---------- loading ----------

function workspaceFromDocument(doc) {
  try {
    return JSON.parse(doc.content.kind === 'text' ? doc.content.text : '{}').workspacePath ?? null
  } catch {
    return null
  }
}

async function resolveWorkspace() {
  if (isEditor) {
    S.wsPath = workspaceFromDocument(await orca.document.get())
    return
  }
  const ws = await orca.plugin.request('review.context', {})
  S.wsPath = ws?.path ?? null
}

async function load({ keepScroll = false } = {}) {
  const gen = ++S.gen
  S.loading = true
  S.error = null
  renderTop()
  if (!S.data) {
    renderTree()
    renderDiffs()
    renderTray()
  }
  const scroller = document.querySelector('.diffs')
  const scrollTop = keepScroll && scroller ? scroller.scrollTop : 0
  try {
    if (!S.wsPath) await resolveWorkspace()
    if (gen !== S.gen) return
    if (!S.wsPath) {
      S.data = null
      S.error = 'Focus a Git workspace to review its changes.'
    } else {
      const data = await request('review.load', { mode: S.mode }, 120000)
      if (gen !== S.gen) return
      S.wsPath = data.workspace.path
      S.data = data
        S.viewedFiles = data.viewedFiles
      S.viewedChanges = new Set(data.viewedChanges)
      S.comments = data.comments
      S.files.clear()
      S.selection = null
      S.composer = null
      loadTargets()
      queueMicrotask(prefetchAll)
    }
  } catch (error) {
    if (gen !== S.gen) return
    S.files.clear()
    S.error = error?.message ?? String(error)
    console.error(`[pr-review] load failed: ${S.error}`)
  }
  S.loading = false
  render()
  if (keepScroll) document.querySelector('.diffs')?.scrollTo({ top: scrollTop })
}

async function loadTargets() {
  const gen = S.gen
  try {
    const targets = await request('review.targets')
    if (gen !== S.gen) return
    S.targets = targets
    if (!targets.some((t) => key(t) === S.targetId)) {
      S.targetId = key(targets.find((t) => t.kind === 'chat' && t.state !== 'done') ?? targets.find((t) => t.kind === 'chat') ?? targets[0])
    }
    renderTray()
  } catch {}
}
const key = (t) => (t ? `${t.kind}:${t.id}` : null)

const cacheKey = (path) => (S.fullFiles.has(path) ? `${path}\0full` : path)

async function ensureFile(path) {
  const cached = cacheKey(path)
  if (S.files.has(cached)) return S.files.get(cached)
  const gen = S.gen
  const pending = request('review.file', { mode: S.mode, file: path, full: S.fullFiles.has(path) })
    .then((detail) => {
      if (gen !== S.gen) return
      S.files.set(cached, detail)
      renderFile(path)
      if (S.find.query) scheduleFind()
      return detail
    })
    .catch((error) => {
      if (gen !== S.gen) return
      S.files.set(cached, { error: error?.message ?? String(error) })
      renderFile(path)
    })
  S.files.set(cached, { pending: true })
  return pending
}

// ---------- viewed actions ----------

async function setFileViewed(f, viewed) {
  if (viewed) {
    S.viewedFiles[f.path] = f.hash
    S.expanded.delete(f.path)
  } else {
    delete S.viewedFiles[f.path]
    const keys = f.changeKeys.filter((k) => S.viewedChanges.has(k))
    keys.forEach((k) => S.viewedChanges.delete(k))
    if (keys.length) request('review.setChangeViewed', { keys, viewed: false }).catch(showError)
  }
  renderFile(f.path)
  renderTree()
  renderTop()
  await request('review.setFileViewed', { files: [{ file: f.path, hash: f.hash }], viewed }).catch(showError)
  if (viewed) advanceFrom(f.path)
}

function advanceFrom(path) {
  const section = document.getElementById(fileId(path))
  const scroller = document.querySelector('.diffs')
  if (!section || !scroller) return
  if (section.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
    scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
  }
}

async function setChangeViewed(f, changeKey, viewed) {
  if (viewed) S.viewedChanges.add(changeKey)
  else {
    S.viewedChanges.delete(changeKey)
    if (S.viewedFiles[f.path]) {
      delete S.viewedFiles[f.path]
      request('review.setFileViewed', { files: [{ file: f.path, hash: f.hash }], viewed: false }).catch(showError)
    }
  }
  if (isFileViewed(f)) S.expanded.add(f.path)
  renderFile(f.path)
  renderTree()
  renderTop()
  await request('review.setChangeViewed', { keys: [changeKey], viewed }).catch(showError)
}

function showError(error) {
  toast(error?.message ?? String(error))
}

// ---------- comments ----------

function persistComments() {
  request('review.saveComments', { comments: S.comments }).catch(showError)
  renderTray()
}

function selectionInfo(path) {
  const detail = S.files.get(cacheKey(path))
  const sel = S.selection
  if (!detail?.rows || !sel || sel.file !== path) return null
  const lo = Math.min(sel.a, sel.b)
  const hi = Math.max(sel.a, sel.b)
  const rows = detail.rows.slice(lo, hi + 1).filter(Boolean)
  const newNums = rows.filter((r) => r.n !== null).map((r) => r.n)
  const side = newNums.length ? 'new' : 'old'
  const nums = side === 'new' ? newNums : rows.map((r) => r.o).filter((n) => n !== null)
  return {
    lo,
    hi,
    side,
    startLine: Math.min(...nums),
    endLine: Math.max(...nums),
    snippet: rows.map((r) => `${r.t}${r.s}`).join('\n')
  }
}

function addComment(path, body, info) {
  if (!body.trim()) return
  S.comments.push({
    id: Math.random().toString(36).slice(2, 10),
    file: path,
    side: info.side,
    startLine: info.startLine,
    endLine: info.endLine,
    snippet: info.snippet,
    body: body.trim()
  })
  S.selection = null
  S.composer = null
  persistComments()
  renderFile(path)
  renderTree()
}

async function send(comments, note) {
  const target = S.targets.find((t) => key(t) === S.targetId)
  if (!target) return toast('Pick who should get the comments')
  S.sending = true
  renderTray()
  try {
    await request('review.send', { target, comments, note, baseRef: S.data?.base?.ref }, 120000)
    const sent = new Set(comments.map((c) => c.id))
    S.comments = S.comments.filter((c) => !sent.has(c.id))
    S.note = ''
    persistComments()
    for (const path of new Set(comments.map((c) => c.file))) renderFile(path)
    renderTree()
    toast(`Sent to ${target.label}`)
  } catch (error) {
    showError(error)
  }
  S.sending = false
  renderTray()
}

// ---------- rendering: top bar ----------

function renderTop() {
  const top = document.querySelector('.top')
  if (!top) return
  const d = S.data
  const files = d?.files ?? []
  const viewed = files.filter(isFileViewed).length
  const pct = files.length ? Math.round((viewed / files.length) * 100) : 0
  const pr = d?.pr
  top.replaceChildren(...kids(
    h('div', { class: 'title' },
      pr
        ? [h('a', { title: pr.url, onclick: () => orca.shell?.openExternal(pr.url) }, `#${pr.number}`), h('strong', { title: pr.title }, pr.title)]
        : h('strong', {}, d?.workspace?.name ?? 'PR Review')
    ),
    d
      ? h('div', { class: 'meta', title: `${d.workspace.branch} ← ${d.base.ref} @ ${d.base.mergeBase}` },
          `${d.workspace.branch ?? ''} vs ${d.base.ref} (${d.base.mergeBase}) · ${files.length} files`)
      : null,
    h('div', { class: 'controls' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'What to compare' },
        h('button', { class: S.mode === 'local' ? 'on' : '', title: 'Commits plus uncommitted changes', onclick: () => setMode('local') }, 'With local'),
        h('button', { class: S.mode === 'committed' ? 'on' : '', title: 'Only what is committed on the branch', onclick: () => setMode('committed') }, 'Committed')
      ),
      h('button', { onclick: () => load({ keepScroll: true }), disabled: S.loading, title: 'Reload the diff' }, S.loading ? 'Loading…' : 'Refresh'),
      !isEditor ? h('button', { onclick: openTab, title: 'Open the review in an editor tab' }, 'Open in tab') : null,
      h('button', { class: S.minimap ? 'on' : '', title: 'Show or hide the minimap', onclick: toggleMinimap }, 'Minimap'),
      h('button', { title: 'Find in files (⌘F)', onclick: openFind }, 'Find'),
      h('div', { class: 'spacer' }),
      files.length
        ? h('div', { class: 'progress', title: `${viewed} of ${files.length} files viewed` },
            h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` })),
            `${viewed}/${files.length} viewed`)
        : null
    )
  ))
}

function toggleMinimap() {
  S.minimap = !S.minimap
  document.querySelector('.main')?.classList.toggle('no-minimap', !S.minimap)
  savePrefs()
  renderTop()
}

async function prefetchAll() {
  const run = S.gen
  const queue = (S.data?.files ?? []).filter((f) => !f.binary).slice(0, 150).map((f) => f.path)
  const worker = async () => {
    while (queue.length && run === S.gen) {
      const path = queue.shift()
      if (!S.files.has(cacheKey(path))) await ensureFile(path)
    }
  }
  await Promise.all([worker(), worker(), worker()])
}

function setMode(mode) {
  if (S.mode === mode) return
  S.mode = mode
  savePrefs()
  load()
}

async function openTab() {
  try {
    await request('review.openTab')
  } catch (error) {
    showError(error)
  }
}

// ---------- rendering: tree ----------

function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] })
      node = node.dirs.get(part)
    }
    node.files.push(f)
  }
  const compress = (node) => {
    for (const [k, child] of node.dirs) {
      let c = child
      while (c.files.length === 0 && c.dirs.size === 1) {
        const [only] = c.dirs.values()
        only.name = `${c.name}/${only.name}`
        c = only
      }
      node.dirs.set(k, c)
      compress(c)
    }
  }
  compress(root)
  return root
}

function treeOrder(files) {
  const out = []
  const walk = (node) => {
    for (const dir of [...node.dirs.values()].sort((x, y) => x.name.localeCompare(y.name))) walk(dir)
    out.push(...node.files)
  }
  walk(buildTree(files))
  return out
}

function renderTree() {
  const list = document.querySelector('.tree-list')
  if (!list) return
  const files = visibleFiles()
  const rows = []
  const walk = (node, depth) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const dir of dirs) {
      const closed = S.closedDirs.has(dir.path)
      rows.push(
        h('div', { class: 'node dir', style: `padding-left:${8 + depth * 12}px`, onclick: () => { closed ? S.closedDirs.delete(dir.path) : S.closedDirs.add(dir.path); renderTree() } },
          h('span', { class: 'chev' }, closed ? '▸' : '▾'),
          h('span', { class: 'name', title: dir.path }, dir.name))
      )
      if (!closed) walk(dir, depth + 1)
    }
    for (const f of node.files) {
      const viewed = isFileViewed(f)
      const count = S.comments.filter((c) => c.file === f.path).length
      rows.push(
        h('div', { class: `node file-node${viewed ? ' viewed' : ''}${S.current === f.path ? ' current' : ''}`, style: `padding-left:${8 + depth * 12}px`, onclick: () => jumpTo(f.path) },
          h('input', { type: 'checkbox', checked: viewed, title: viewed ? 'Viewed' : 'Mark as viewed', onclick: (e) => { e.stopPropagation(); setFileViewed(f, e.target.checked) } }),
          h('span', { class: `badge ${f.status}`, title: f.status }, f.status[0].toUpperCase()),
          h('span', { class: 'name', title: f.path }, f.path.split('/').pop()),
          isStale(f) ? h('span', { class: 'dot-stale', title: 'Changed since you viewed it' }) : null,
          count ? h('span', { class: 'stat', title: `${count} comment(s)` }, `💬${count}`) : null,
          h('span', { class: 'stat' }, f.binary ? 'bin' : `+${f.additions} −${f.deletions}`))
      )
    }
  }
  walk(buildTree(files), 0)
  list.replaceChildren(...kids(...(rows.length ? rows : [h('div', { class: 'empty' }, S.data ? 'No files match.' : '')])))
}

function jumpTo(path) {
  S.collapsed.delete(path)
  const f = fileMeta(path)
  if (f && isFileViewed(f)) S.expanded.add(path)
  if (S.hideViewed && f && isFileViewed(f)) {
    S.hideViewed = false
    renderDiffs()
  } else renderFile(path)
  S.current = path
  renderTree()
  const section = document.getElementById(fileId(path))
  const scroller = document.querySelector('.diffs')
  if (section && scroller) scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
  if (document.querySelector('.main')?.classList.contains('narrow')) {
    S.treeOpen = false
    document.querySelector('.tree')?.classList.add('closed')
  }
}

// ---------- rendering: diffs ----------

let observer = null

function renderDiffs() {
  const scroller = document.querySelector('.diffs')
  if (!scroller) return
  observer?.disconnect()
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const path = entry.target.dataset.path
        if (!S.files.has(cacheKey(path))) ensureFile(path)
      }
    },
    { root: scroller, rootMargin: '1200px 0px' }
  )
  const files = treeOrder(visibleFiles())
  if (!S.data) {
    scroller.replaceChildren(...kids(h('div', { class: 'empty' }, S.loading ? 'Loading the diff…' : S.error ?? '')))
    return
  }
  if (!files.length) {
    scroller.replaceChildren(...kids(h('div', { class: 'empty' }, S.data.files.length ? 'Every file is viewed. 🎉' : 'No changes against the base branch.')))
    return
  }
  scroller.replaceChildren(...kids(...files.map(fileSection)))
}

function fileSection(f) {
  const section = h('section', { class: 'file', id: fileId(f.path), 'data-path': f.path })
  fillSection(section, f)
  observer?.observe(section)
  return section
}

function renderFile(path) {
  const section = document.getElementById(fileId(path))
  const f = fileMeta(path)
  if (section && f) fillSection(section, f)
}

function fillSection(section, f) {
  const viewed = isFileViewed(f)
  const collapsed = isCollapsed(f)
  section.classList.toggle('collapsed', collapsed)
  const toggle = () => {
    if (collapsed) {
      S.collapsed.delete(f.path)
      if (viewed) S.expanded.add(f.path)
    } else {
      S.expanded.delete(f.path)
      if (!viewed) S.collapsed.add(f.path)
    }
    renderFile(f.path)
  }
  const head = h('div', { class: 'file-head' },
    h('span', { class: 'chev', onclick: toggle, title: collapsed ? 'Expand' : 'Collapse' }, collapsed ? '▸' : '▾'),
    h('span', { class: `badge ${f.status}`, title: f.status }, f.status[0].toUpperCase()),
    h('span', { class: 'path', onclick: toggle, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path },
      h('bdi', {}, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)),
    isStale(f) ? h('span', { class: 'dot-stale', title: 'Changed since you viewed it' }) : null,
    h('span', { class: 'stat' }, f.binary ? 'binary' : [h('span', { class: 'a' }, `+${f.additions}`), ' ', h('span', { class: 'd' }, `−${f.deletions}`)]),
    canShowFull(f) ? h('button', { class: `ghost${S.fullFiles.has(f.path) ? ' on' : ''}`, title: S.fullFiles.has(f.path) ? 'Show only the changed parts' : 'Show the whole file, with the changes in place', onclick: () => toggleFull(f) }, S.fullFiles.has(f.path) ? 'Changes only' : 'Full file') : null,
    f.status !== 'deleted' ? h('button', { class: 'ghost', title: 'Open the file in an editor tab', onclick: () => request('review.openFile', { file: f.path }).catch(showError) }, 'Open') : null,
    h('label', { class: viewed ? 'on' : '', title: 'Mark the whole file as viewed' },
      h('input', { type: 'checkbox', checked: viewed, onchange: (e) => setFileViewed(f, e.target.checked) }), 'Viewed')
  )
  const children = [head]
  if (!collapsed) children.push(fileBody(f))
  section.replaceChildren(...kids(...children))
  paintFind(section)
}

const canShowFull = (f) => !f.binary && f.status !== 'added' && f.status !== 'deleted'

function toggleFull(f) {
  if (S.fullFiles.has(f.path)) S.fullFiles.delete(f.path)
  else S.fullFiles.add(f.path)
  if (S.selection?.file === f.path) S.selection = null
  if (S.composer?.file === f.path) S.composer = null
  S.collapsed.delete(f.path)
  if (isFileViewed(f)) S.expanded.add(f.path)
  renderFile(f.path)
}

function fileBody(f) {
  const full = S.fullFiles.has(f.path)
  const detail = S.files.get(cacheKey(f.path))
  if (f.binary) return h('div', { class: 'note' }, 'Binary file changed.')
  if (!detail || detail.pending) {
    if (!detail) queueMicrotask(() => ensureFile(f.path))
    return h('div', { class: 'note' }, 'Loading…')
  }
  if (detail.error) return h('div', { class: 'note warn' }, detail.error)
  if (!detail.hunks.length) return h('div', { class: 'note' }, f.status === 'renamed' ? 'Renamed without changes.' : 'No textual changes.')

  const lang = languageFor(f.path)
  const table = h('table', { class: 'diff' }, h('colgroup', {}, h('col', { class: 'num' }), h('col', { class: 'num' }), h('col', {})))
  const rows = []
  const sel = S.selection?.file === f.path ? S.selection : null
  const lo = sel ? Math.min(sel.a, sel.b) : -1
  const hi = sel ? Math.max(sel.a, sel.b) : -1
  const comments = S.comments.filter((c) => c.file === f.path)
  const placed = new Set()
  let rowIndex = 0

  const commentRowsFor = (line) => {
    const out = []
    for (const c of comments) {
      if (placed.has(c.id)) continue
      const hit = c.side === 'new' ? line.n !== null && line.t !== '-' && line.n === c.endLine : line.t === '-' && line.o === c.endLine
      if (!hit) continue
      placed.add(c.id)
      out.push(commentRow(f, c))
    }
    return out
  }

  const lineRow = (line, html, idx, extraClass = '') => {
    const cls = (line.t === '+' ? 'add' : line.t === '-' ? 'del' : 'ctx') + extraClass + (idx >= lo && idx <= hi ? ' sel' : '')
    return h('tr', { class: cls, 'data-row': idx },
      h('td', { class: 'num', 'data-row': idx, title: 'Click or drag to select lines; shift-click extends' }, line.o ?? ''),
      h('td', { class: 'num', 'data-row': idx }, line.n ?? ''),
      h('td', { class: 'code' }, h('span', { class: 'mk' }, line.t === ' ' ? '' : line.t), h('span', { html: html || ' ' })))
  }

  for (const hunk of detail.hunks) {
    if (!full) table.append(h('tbody', {}, h('tr', { class: 'hunk' }, h('td', { colspan: 3 }, hunk.header))))
    const html = highlightHunk(hunk.lines, lang)
    const changeAt = new Map(hunk.changes.map((c) => [c.start, c]))
    let body = h('tbody', {})
    let i = 0
    while (i < hunk.lines.length) {
      const change = changeAt.get(i)
      if (!change) {
        const line = hunk.lines[i]
        rows[rowIndex] = line
        body.append(lineRow(line, html[i], rowIndex), ...commentRowsFor(line))
        if (S.composer?.file === f.path && S.composer.hi === rowIndex) body.append(composerRow(f))
        rowIndex++
        i++
        continue
      }
      table.append(body)
      const viewedChange = S.viewedChanges.has(change.key)
      const chg = h('tbody', { class: `chg${viewedChange ? ' viewed' : ''}` })
      const btn = h('button', {
        class: 'chg-btn',
        title: viewedChange ? 'Show this change as a diff again' : 'Mark this change as viewed: it shows as the final code',
        onclick: (e) => { e.stopPropagation(); setChangeViewed(f, change.key, !viewedChange) }
      }, viewedChange ? '↺ Show diff' : '✓ Viewed')
      let first = true
      let removed = 0
      for (let j = change.start; j <= change.end; j++) {
        const line = hunk.lines[j]
        rows[rowIndex] = line
        if (viewedChange && line.t === '-') {
          removed++
          rowIndex++
          continue
        }
        const tr = viewedChange ? lineRow({ ...line, t: ' ', o: null }, html[j], rowIndex, ' viewed') : lineRow(line, html[j], rowIndex)
        if (first) {
          tr.querySelector('td.code').append(btn)
          first = false
        }
        chg.append(tr, ...commentRowsFor(line))
        if (S.composer?.file === f.path && S.composer.hi === rowIndex) chg.append(composerRow(f))
        rowIndex++
      }
      if (first) {
        chg.append(h('tr', { class: 'viewed-del' }, h('td', { colspan: 3, style: 'position:relative' }, `${removed} removed line${removed === 1 ? '' : 's'} · viewed`, btn)))
      }
      table.append(chg)
      body = h('tbody', {})
      i = change.end + 1
    }
    table.append(body)
  }
  detail.rows = rows

  table.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('td.num')
    if (!cell) return
    e.preventDefault()
    const idx = Number(cell.dataset.row)
    if (e.shiftKey && S.selection?.file === f.path) S.selection.b = idx
    else S.selection = { file: f.path, a: idx, b: idx }
    paintSelection(table)
    const move = (ev) => {
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('tr[data-row]')
      if (over && table.contains(over)) {
        S.selection.b = Number(over.dataset.row)
        paintSelection(table)
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const info = selectionInfo(f.path)
      if (!info) return
      S.composer = { file: f.path, hi: info.hi }
      renderFile(f.path)
      document.querySelector('tr.composer textarea')?.focus()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  const wrap = h('div', {})
  const outdated = comments.filter((c) => !placed.has(c.id))
  if (outdated.length) {
    wrap.append(h('table', { class: 'diff' }, h('tbody', {}, outdated.map((c) => commentRow(f, c, full ? 'line no longer in the diff' : 'line outside the changed parts; use Full file')))))
  }
  wrap.append(table)
  if (detail.truncated) wrap.append(h('div', { class: 'note warn' }, 'This diff is long, so only its first lines are shown. Open the file to see the rest.'))
  return wrap
}

function paintSelection(table) {
  const sel = S.selection
  const lo = Math.min(sel.a, sel.b)
  const hi = Math.max(sel.a, sel.b)
  for (const tr of table.querySelectorAll('tr[data-row]')) {
    const idx = Number(tr.dataset.row)
    tr.classList.toggle('sel', idx >= lo && idx <= hi)
  }
}

function composerRow(f) {
  const info = selectionInfo(f.path)
  if (!info) return null
  const range = info.startLine === info.endLine ? `L${info.startLine}` : `L${info.startLine}–${info.endLine}`
  const textarea = h('textarea', { placeholder: 'Comment for the agent… (⌘↩ adds it, ⇧⌘↩ sends now)' })
  const cancel = () => {
    S.selection = null
    S.composer = null
    renderFile(f.path)
  }
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (e.shiftKey) sendNow()
      else addComment(f.path, textarea.value, info)
    }
  })
  const sendNow = () => {
    if (!textarea.value.trim()) return
    addComment(f.path, textarea.value, info)
    send([S.comments[S.comments.length - 1]], '')
  }
  return h('tr', { class: 'composer' }, h('td', { colspan: 3 },
    h('div', { class: 'composer-box' },
      textarea,
      h('div', { class: 'row' },
        h('span', { class: 'where' }, `${range}${info.side === 'old' ? ' (old)' : ''}`),
        h('button', { onclick: cancel }, 'Cancel'),
        h('button', { onclick: sendNow, title: 'Send only this comment now' }, 'Send now'),
        h('button', { class: 'primary', onclick: () => addComment(f.path, textarea.value, info) }, 'Add comment')))))
}

function commentRow(f, c, outdated = false) {
  const range = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–${c.endLine}`
  if (S.editing === c.id) {
    const textarea = h('textarea', {}, c.body)
    const save = () => {
      c.body = textarea.value.trim() || c.body
      S.editing = null
      persistComments()
      renderFile(f.path)
    }
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
      if (e.key === 'Escape') { S.editing = null; renderFile(f.path) }
    })
    queueMicrotask(() => textarea.focus())
    return h('tr', { class: 'comment' }, h('td', { colspan: 3 }, h('div', { class: 'composer-box' }, textarea,
      h('div', { class: 'row' }, h('button', { onclick: () => { S.editing = null; renderFile(f.path) } }, 'Cancel'), h('button', { class: 'primary', onclick: save }, 'Save')))))
  }
  return h('tr', { class: 'comment' }, h('td', { colspan: 3 },
    h('div', { class: 'comment-box' },
      h('div', { class: 'body' }, h('div', { class: 'where' }, `💬 ${range}${c.side === 'old' ? ' (old)' : ''}${outdated ? ` · ${outdated}` : ''} · not sent yet`), c.body),
      h('button', { class: 'ghost', onclick: () => { S.editing = c.id; renderFile(f.path) } }, 'Edit'),
      h('button', { class: 'ghost', onclick: () => { S.comments = S.comments.filter((x) => x.id !== c.id); persistComments(); renderFile(f.path); renderTree() } }, 'Delete'))))
}

// ---------- rendering: tray ----------

function renderTray() {
  const tray = document.querySelector('.tray')
  if (!tray) return
  const count = S.comments.length
  if (!S.data) {
    tray.replaceChildren(...kids())
    tray.style.display = 'none'
    return
  }
  tray.style.display = ''
  const select = h('select', { 'aria-label': 'Send comments to', onchange: (e) => { S.targetId = e.target.value } },
    S.targets.map((t) => h('option', { value: key(t), selected: key(t) === S.targetId }, t.label)))
  const note = h('textarea', { placeholder: 'Overall note (optional)', oninput: (e) => { S.note = e.target.value } }, S.note)
  tray.replaceChildren(...kids(
    count || S.note ? note : null,
    h('div', { class: 'row' },
      h('strong', {}, count ? `${count} comment${count === 1 ? '' : 's'} ready` : 'Select line numbers to comment'),
      h('span', { class: 'spacer' }),
      count ? h('button', { class: 'ghost', onclick: (e) => {
        if (e.currentTarget.dataset.armed !== '1') {
          e.currentTarget.dataset.armed = '1'
          e.currentTarget.textContent = `Delete ${count}?`
          return
        }
        const paths = new Set(S.comments.map((c) => c.file))
        S.comments = []
        persistComments()
        paths.forEach(renderFile)
        renderTree()
      } }, 'Clear') : null,
      !count && !S.note ? h('button', { class: 'ghost', onclick: () => { S.note = ' '; renderTray(); document.querySelector('.tray textarea')?.focus() } }, 'Add note') : null,
      select,
      h('button', { class: 'ghost', title: 'Reload the agent list', onclick: loadTargets }, '↻'),
      h('button', { class: 'primary', disabled: S.sending || (!count && !S.note.trim()), onclick: () => send([...S.comments], S.note) }, S.sending ? 'Sending…' : 'Send to agent'))
  ))
}

// ---------- find ----------

const findEls = {}

function findBar() {
  const input = h('input', { type: 'search', placeholder: 'Find in files', 'aria-label': 'Find in files', spellcheck: 'false' })
  const count = h('span', { class: 'find-count' })
  const caseBtn = h('button', { class: 'ghost find-case', title: 'Match case', 'aria-pressed': 'false' }, 'Aa')
  const prev = h('button', { class: 'ghost', title: 'Previous match (⇧↩)', 'aria-label': 'Previous match' }, '↑')
  const next = h('button', { class: 'ghost', title: 'Next match (↩)', 'aria-label': 'Next match' }, '↓')
  const close = h('button', { class: 'ghost', title: 'Close (Esc)', 'aria-label': 'Close find' }, '✕')
  const bar = h('div', { class: 'find-bar', role: 'search' }, input, count, caseBtn, prev, next, close)
  input.addEventListener('input', () => { S.find.query = input.value; S.find.index = -1; scheduleFind(true) })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1) }
    if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  })
  caseBtn.addEventListener('click', () => {
    S.find.caseSensitive = !S.find.caseSensitive
    caseBtn.classList.toggle('on', S.find.caseSensitive)
    caseBtn.setAttribute('aria-pressed', String(S.find.caseSensitive))
    S.find.index = -1
    scheduleFind(true)
  })
  prev.addEventListener('click', () => stepFind(-1))
  next.addEventListener('click', () => stepFind(1))
  close.addEventListener('click', closeFind)
  Object.assign(findEls, { bar, input, count })
  return bar
}

function openFind() {
  if (!findEls.bar) return
  const selected = String(window.getSelection?.() ?? '').trim()
  if (selected && !selected.includes('\n')) {
    findEls.input.value = selected
    S.find.query = selected
  }
  S.find.open = true
  findEls.bar.classList.add('open')
  findEls.input.focus()
  findEls.input.select()
  scheduleFind(true)
}

function closeFind() {
  S.find.open = false
  S.find.query = ''
  S.find.matches = []
  S.find.index = -1
  findEls.input.value = ''
  findEls.bar.classList.remove('open')
  for (const mark of document.querySelectorAll('mark.find-hit')) mark.replaceWith(...mark.childNodes)
  updateFindCount()
}

let findTimer = 0
function scheduleFind(jump = false) {
  clearTimeout(findTimer)
  findTimer = setTimeout(() => runFind(jump), 120)
}

function runFind(jump) {
  const raw = S.find.query
  const needle = S.find.caseSensitive ? raw : raw.toLowerCase()
  const previous = S.find.matches[S.find.index]
  const matches = []
  if (needle) {
    for (const f of treeOrder(visibleFiles())) {
      const detail = S.files.get(cacheKey(f.path))
      if (!detail?.hunks) continue
      let row = 0
      for (const hunk of detail.hunks) {
        const hidden = new Set()
        for (const c of hunk.changes) {
          if (!S.viewedChanges.has(c.key)) continue
          for (let j = c.start; j <= c.end; j++) if (hunk.lines[j].t === '-') hidden.add(j)
        }
        hunk.lines.forEach((line, j) => {
          if (!hidden.has(j)) {
            const hay = S.find.caseSensitive ? line.s : line.s.toLowerCase()
            for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
              matches.push({ path: f.path, row, start: at, end: at + needle.length })
            }
          }
          row++
        })
      }
    }
  }
  S.find.matches = matches
  if (previous && !jump) {
    S.find.index = matches.findIndex((m) => m.path === previous.path && m.row === previous.row && m.start === previous.start)
  }
  if (S.find.index < 0 && matches.length && jump) S.find.index = firstMatchBelowViewport()
  for (const section of document.querySelectorAll('section.file')) paintFind(section)
  updateFindCount()
  if (jump && S.find.index >= 0) revealMatch(S.find.index)
}

function firstMatchBelowViewport() {
  const scroller = document.querySelector('.diffs')
  const top = scroller.getBoundingClientRect().top
  for (let i = 0; i < S.find.matches.length; i++) {
    const m = S.find.matches[i]
    const tr = document.getElementById(fileId(m.path))?.querySelector(`tr[data-row="${m.row}"]`)
    if (tr && tr.getBoundingClientRect().bottom >= top) return i
  }
  return 0
}

function stepFind(direction) {
  const total = S.find.matches.length
  if (!total) return
  S.find.index = S.find.index < 0 ? (direction > 0 ? 0 : total - 1) : (S.find.index + direction + total) % total
  revealMatch(S.find.index)
}

function revealMatch(index) {
  const m = S.find.matches[index]
  if (!m) return
  const f = fileMeta(m.path)
  if (f && isCollapsed(f)) {
    S.collapsed.delete(f.path)
    if (isFileViewed(f)) S.expanded.add(f.path)
    renderFile(f.path)
  }
  for (const section of document.querySelectorAll('section.file')) paintFind(section)
  updateFindCount()
  const mark = document.querySelector('mark.find-hit.current')
  const scroller = document.querySelector('.diffs')
  if (mark && scroller) {
    const box = mark.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (box.top < view.top + 40 || box.bottom > view.bottom - 20) {
      scroller.scrollTop += box.top - view.top - scroller.clientHeight / 3
    }
  }
}

function updateFindCount() {
  if (!findEls.count) return
  const total = S.find.matches.length
  findEls.count.textContent = !S.find.query ? '' : total ? `${S.find.index >= 0 ? S.find.index + 1 : '?'} of ${total}` : 'No results'
  findEls.count.classList.toggle('none', !!S.find.query && !total)
}

function markRange(el, start, end, className) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const pieces = []
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.nodeValue.length
    const from = Math.max(start, offset)
    const to = Math.min(end, offset + len)
    if (from < to) pieces.push([node, from - offset, to - offset])
    offset += len
    if (offset >= end) break
  }
  for (const [node, from, to] of pieces) {
    const target = from > 0 ? node.splitText(from) : node
    if (to - from < target.nodeValue.length) target.splitText(to - from)
    const mark = document.createElement('mark')
    mark.className = className
    target.replaceWith(mark)
    mark.append(target)
  }
}

function paintFind(section) {
  for (const mark of section.querySelectorAll('mark.find-hit')) mark.replaceWith(...mark.childNodes)
  section.normalize()
  if (!S.find.query || !S.find.matches.length) return
  const path = section.dataset.path
  const current = S.find.matches[S.find.index]
  const byRow = new Map()
  for (const m of S.find.matches) {
    if (m.path !== path) continue
    if (!byRow.has(m.row)) byRow.set(m.row, [])
    byRow.get(m.row).push(m)
  }
  for (const [row, list] of byRow) {
    const code = section.querySelector(`tr[data-row="${row}"] td.code span:nth-child(2)`)
    if (!code) continue
    for (const m of [...list].reverse()) markRange(code, m.start, m.end, m === current ? 'find-hit current' : 'find-hit')
  }
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (mod && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    e.stopPropagation()
    openFind()
  } else if (mod && e.key.toLowerCase() === 'g' && S.find.open) {
    e.preventDefault()
    stepFind(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape' && S.find.open && document.activeElement === document.body) {
    closeFind()
  }
}, true)

// ---------- layout ----------

function render() {
  if (!app.querySelector('.top')) {
    const tree = h('div', { class: 'tree' },
      h('div', { class: 'tree-head' },
        h('button', { class: 'ghost tree-toggle', title: 'Show or hide files', onclick: () => { S.treeOpen = !S.treeOpen; tree.classList.toggle('closed', !S.treeOpen) } }, 'Files'),
        h('input', { type: 'search', placeholder: 'Filter files', oninput: (e) => { S.filter = e.target.value; renderTree(); renderDiffs() } }),
        h('label', { title: 'Hide viewed files', style: 'display:inline-flex;gap:4px;align-items:center;font-size:12px;white-space:nowrap' },
          h('input', { type: 'checkbox', checked: S.hideViewed, onchange: (e) => { S.hideViewed = e.target.checked; savePrefs(); renderTree(); renderDiffs() } }), 'Hide viewed')),
      h('div', { class: 'tree-list' }))
    const splitter = h('div', { class: 'splitter', title: 'Drag to resize' })
    const diffs = h('div', { class: 'diffs' })
    const minimap = h('canvas', { class: 'minimap', 'aria-label': 'Minimap: click or drag to scroll' })
    const main = h('div', { class: `main${S.minimap ? '' : ' no-minimap'}` }, tree, splitter, diffs, minimap, findBar())
    createMinimap(diffs, minimap)
    app.replaceChildren(...kids(h('div', { class: 'top' }), h('div', { class: 'banner-slot' }), main, h('div', { class: 'tray' })))
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const move = (ev) => document.documentElement.style.setProperty('--tree-w', `${Math.max(160, Math.min(ev.clientX, window.innerWidth - 240))}px`)
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    diffs.addEventListener('scroll', trackCurrent, { passive: true })
    new ResizeObserver(() => main.classList.toggle('narrow', main.clientWidth < 640)).observe(main)
  }
  document.querySelector('.banner-slot').replaceChildren(...kids(S.error && S.data ? h('div', { class: 'banner' }, S.error) : ''))
  renderTop()
  renderTree()
  renderDiffs()
  renderTray()
}

let trackTimer = null
function trackCurrent() {
  if (trackTimer) return
  trackTimer = setTimeout(() => {
    trackTimer = null
    const scroller = document.querySelector('.diffs')
    const top = scroller.getBoundingClientRect().top + 20
    let current = null
    for (const section of scroller.querySelectorAll('section.file')) {
      if (section.getBoundingClientRect().top <= top) current = section.dataset.path
      else break
    }
    current ??= scroller.querySelector('section.file')?.dataset.path ?? null
    if (current !== S.current) {
      S.current = current
      for (const node of document.querySelectorAll('.node.file-node')) node.classList.toggle('current', node.querySelector('.name')?.title === current)
    }
  }, 80)
}

// ---------- boot ----------

async function boot() {
  try {
    const prefs = await orca.storage.get(PREFS_KEY)
    if (prefs?.mode) S.mode = prefs.mode
    if (typeof prefs?.hideViewed === 'boolean') S.hideViewed = prefs.hideViewed
    if (typeof prefs?.minimap === 'boolean') S.minimap = prefs.minimap
  } catch {}
  render()
  await load()
  if (isEditor) {
    orca.document.onDidChange((doc) => {
      const next = workspaceFromDocument(doc)
      if (next && next !== S.wsPath) {
        S.wsPath = next
        load()
      }
    })
  } else {
    let lastKey = null
    orca.on('workspace.changed', ({ context }) => {
      const next = context ? `${context.branch}\0${context.displayName}` : null
      if (lastKey === null) { lastKey = next; return }
      if (next === lastKey) return
      lastKey = next
      S.wsPath = null
      S.data = null
      S.expanded.clear()
      S.collapsed.clear()
      load()
    })
  }
  orca.plugin.on('review.commentsChanged', (payload) => {
    if (payload?.path !== S.wsPath || S.composer || S.editing) return
    const before = JSON.stringify(S.comments)
    if (JSON.stringify(payload.comments) === before) return
    S.comments = payload.comments
    renderDiffs()
    renderTree()
    renderTray()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.data && !S.composer && !S.editing) load({ keepScroll: true })
  })
}

boot()
