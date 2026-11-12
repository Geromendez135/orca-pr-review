import { createHash } from 'node:crypto'

export type LineKind = ' ' | '+' | '-'
export type DiffLine = { t: LineKind; o: number | null; n: number | null; s: string }
/** A run of removed and added lines with no context between them. `start`/`end` index `lines`. */
export type Change = { key: string; start: number; end: number }
export type Hunk = { header: string; lines: DiffLine[]; changes: Change[] }
export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed'
export type DiffFile = {
  path: string
  oldPath: string | null
  status: FileStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: Hunk[]
  truncated: boolean
  hash: string
}

const MAX_LINES_PER_FILE = 8000

const sha = (text: string, size = 16): string =>
  createHash('sha1').update(text).digest('hex').slice(0, size)

function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = body[i + 1]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' }
      bytes.push(...Buffer.from(map[next] ?? next, 'utf8'))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

const stripPrefix = (raw: string): string | null => {
  const value = unquote(raw.trim())
  if (value === '/dev/null') return null
  return value.replace(/^[ab]\//, '')
}

function pathsFromDiffGit(line: string): { a: string; b: string } {
  const rest = line.slice('diff --git '.length)
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/)
  if (quoted) return { a: stripPrefix(quoted[1]) ?? '', b: stripPrefix(quoted[2]) ?? '' }
  const half = rest.indexOf(' b/')
  return { a: rest.slice(2, half), b: rest.slice(half + 3) }
}

function finishFile(file: DiffFile): DiffFile {
  const seen = new Map<string, number>()
  const keys: string[] = []
  for (const hunk of file.hunks) {
    let i = 0
    while (i < hunk.lines.length) {
      if (hunk.lines[i].t === ' ') {
        i++
        continue
      }
      const start = i
      while (i < hunk.lines.length && hunk.lines[i].t !== ' ') i++
      const body = hunk.lines
        .slice(start, i)
        .map((l) => l.t + l.s)
        .join('\n')
      const base = sha(`${file.path}\0${body}`)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      const key = count === 0 ? base : `${base}-${count}`
      hunk.changes.push({ key, start, end: i - 1 })
      keys.push(key)
    }
  }
  file.hash = sha(`${file.status}\0${file.oldPath ?? ''}\0${file.binary}\0${keys.join(',')}`)
  return file
}

/** Parses `git diff` unified output (with `-M`). */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: Hunk | null = null
  let oldLine = 0
  let newLine = 0
  let lineCount = 0

  const lines = text.split('\n')
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    if (line.startsWith('diff --git ')) {
      if (file) files.push(finishFile(file))
      const { a, b } = pathsFromDiffGit(line)
      file = {
        path: b || a,
        oldPath: a && a !== b ? a : null,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        truncated: false,
        hash: ''
      }
      if (file.oldPath) file.status = 'renamed'
      hunk = null
      lineCount = 0
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.oldPath = unquote(line.slice('rename from '.length))
        file.status = 'renamed'
      } else if (line.startsWith('rename to ')) file.path = unquote(line.slice('rename to '.length))
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true
      else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4))
        if (p === null) file.status = 'added'
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4))
        if (p === null) file.status = 'deleted'
        else file.path = p
      }
    }
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = { header: line, lines: [], changes: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('\\')) continue
    const kind = line[0]
    if (kind !== ' ' && kind !== '+' && kind !== '-') {
      if (line === '' && idx === lines.length - 1) continue
      if (line !== '') continue
    }
    const t: LineKind = kind === '+' || kind === '-' ? kind : ' '
    if (t === '+') file.additions++
    if (t === '-') file.deletions++
    if (lineCount >= MAX_LINES_PER_FILE) {
      file.truncated = true
      if (t !== '+') oldLine++
      if (t !== '-') newLine++
      continue
    }
    lineCount++
    hunk.lines.push({
      t,
      o: t === '+' ? null : oldLine,
      n: t === '-' ? null : newLine,
      s: line.slice(1)
    })
    if (t !== '+') oldLine++
    if (t !== '-') newLine++
  }
  if (file) files.push(finishFile(file))
  return files
}
