import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDiff, type DiffFile } from './diff.ts'

type Workspace = { id: string; name: string; path: string; branch: string | null }
type Mode = 'local' | 'committed'
type Pr = { number: number; url: string; title: string; baseRefName: string }
type Comment = {
  id: string
  file: string
  side: 'new' | 'old'
  startLine: number
  endLine: number
  snippet: string
  body: string
}
type ReviewState = {
  files: Record<string, string>
  changes: Record<string, 1>
  comments: Comment[]
}
type Target = { kind: 'chat' | 'terminal' | 'new'; id: string; label: string; state?: string }

const REVIEW_DIR = '.pr-review'
const FULL_CONTEXT = 1_000_000
// The worker runs outside any Orca terminal, so the CLI cannot infer a sender.
const SENDER = 'pr-review'
const ORCA_CLI = [
  process.env.ORCA_CLI_COMMAND,
  '/Applications/Orca.app/Contents/Resources/bin/orca'
].find((candidate): candidate is string => !!candidate && existsSync(candidate))

function run(cmd: string, args: string[], cwd: string, okCodes = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException & { code?: unknown }).code ?? 1) : 0
        if (!error || okCodes.includes(Number(code))) resolve(stdout)
        else reject(Object.assign(new Error(`${cmd} ${args[0]}: ${stderr || error.message}`.trim()), { code: 'action_failed' }))
      }
    )
  })
}

const git = (cwd: string, args: string[], okCodes?: number[]) =>
  run('git', ['-c', 'core.quotepath=off', ...args], cwd, okCodes)

async function orcaCli(args: string[], cwd: string): Promise<any> {
  if (!ORCA_CLI) throw Object.assign(new Error('Orca CLI not found'), { code: 'unavailable' })
  const out = await run(ORCA_CLI, [...args, '--json'], cwd)
  const parsed = JSON.parse(out)
  if (parsed.ok === false) throw Object.assign(new Error(parsed.error?.message ?? 'orca failed'), { code: 'action_failed' })
  return parsed.result
}

const stateKey = (path: string) => `ws:${createHash('sha1').update(path).digest('hex').slice(0, 20)}`
const shortBranch = (branch: string | null | undefined) => (branch ?? '').replace(/^refs\/heads\//, '')

export default function activate(orca: OrcaWorkerApi): void {
  const prCache = new Map<string, { at: number; pr: Pr | null }>()
  const diffCache = new Map<string, { mergeBase: string; untracked: Set<string>; files: DiffFile[] }>()

  async function readState(path: string): Promise<ReviewState> {
    const value = (await orca.storage.get(stateKey(path))) as Partial<ReviewState> | null
    return { files: value?.files ?? {}, changes: value?.changes ?? {}, comments: value?.comments ?? [] }
  }

  async function writeState(path: string, state: ReviewState): Promise<void> {
    await orca.storage.set(stateKey(path), state as never)
  }

  async function listWorkspaces(): Promise<Workspace[]> {
    const { workspaces } = await orca.host.call('workspace.list', {})
    return workspaces.filter((w) => w.kind === 'worktree' && (w.hostId ?? 'local') === 'local')
  }

  async function focusedWorkspace(): Promise<Workspace | null> {
    const ctx = await orca.host.call('workspace.readContext', {})
    if (!ctx) return null
    const all = await listWorkspaces()
    const sameBranch = all.filter((w) => shortBranch(w.branch) === shortBranch(ctx.branch))
    return sameBranch.find((w) => w.name === ctx.displayName) ?? sameBranch[0] ?? null
  }

  async function workspaceFor(input: { path?: string } | undefined): Promise<Workspace> {
    if (input?.path) {
      const found = (await listWorkspaces()).find((w) => w.path === input.path)
      if (found) return found
      return { id: '', name: input.path.split('/').pop() ?? input.path, path: input.path, branch: null }
    }
    const ws = await focusedWorkspace()
    if (!ws) throw Object.assign(new Error('No Git workspace is focused'), { code: 'not_permitted' })
    return ws
  }

  async function pullRequest(path: string): Promise<Pr | null> {
    const cached = prCache.get(path)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.pr
    let pr: Pr | null = null
    try {
      const out = await run('gh', ['pr', 'view', '--json', 'number,url,title,baseRefName'], path)
      pr = JSON.parse(out)
    } catch {
      pr = null
    }
    prCache.set(path, { at: Date.now(), pr })
    return pr
  }

  async function resolveBase(path: string): Promise<{ ref: string; mergeBase: string; pr: Pr | null }> {
    const setting = String((await orca.settings.get('baseBranch')) ?? '').trim()
    const pr = await pullRequest(path)
    const candidates: string[] = []
    const name = setting || pr?.baseRefName
    if (name) candidates.push(name.startsWith('origin/') ? name : `origin/${name}`, name)
    try {
      candidates.push((await git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim())
    } catch {}
    candidates.push('origin/main', 'origin/master', 'main', 'master')
    for (const ref of candidates) {
      try {
        const mergeBase = (await git(path, ['merge-base', 'HEAD', ref])).trim()
        if (mergeBase) return { ref, mergeBase, pr }
      } catch {}
    }
    throw Object.assign(new Error('Could not find a base branch. Set one in Settings → Plugins → PR Review.'), {
      code: 'action_failed'
    })
  }

  async function computeDiff(path: string, mode: Mode): Promise<{ base: Awaited<ReturnType<typeof resolveBase>>; files: DiffFile[] }> {
    const base = await resolveBase(path)
    const exclude = `:(exclude)${REVIEW_DIR}`
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', base.mergeBase]
    if (mode === 'committed') args.push('HEAD')
    args.push('--', '.', exclude)
    const files = parseDiff(await git(path, args))
    const untracked: string[] = []
    if (mode === 'local') {
      untracked.push(
        ...(await git(path, ['ls-files', '--others', '--exclude-standard', '-z']))
          .split('\0')
          .filter((p) => p && !p.startsWith(`${REVIEW_DIR}/`))
          .slice(0, 300)
      )
      for (const file of untracked) {
        const out = await git(path, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], [0, 1])
        files.push(...parseDiff(out))
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    diffCache.set(`${path}\0${mode}`, { mergeBase: base.mergeBase, untracked: new Set(untracked), files })
    return { base, files }
  }

  async function cachedDiff(path: string, mode: Mode) {
    const key = `${path}\0${mode}`
    if (!diffCache.has(key)) await computeDiff(path, mode)
    return diffCache.get(key)!
  }

  async function fullFileDiff(path: string, mode: Mode, file: DiffFile): Promise<DiffFile> {
    const cached = await cachedDiff(path, mode)
    if (file.binary || file.status === 'added' || file.status === 'deleted' || cached.untracked.has(file.path)) return file
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', `-U${FULL_CONTEXT}`, cached.mergeBase]
    if (mode === 'committed') args.push('HEAD')
    args.push('--', ...(file.oldPath ? [file.oldPath, file.path] : [file.path]))
    return parseDiff(await git(path, args)).find((f) => f.path === file.path) ?? file
  }

  async function ensureReviewDir(path: string): Promise<string> {
    const dir = join(path, REVIEW_DIR)
    await mkdir(dir, { recursive: true })
    try {
      const exclude = (await git(path, ['rev-parse', '--git-path', 'info/exclude'])).trim()
      const excludePath = exclude.startsWith('/') ? exclude : join(path, exclude)
      const current = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : ''
      if (!current.split('\n').includes(`/${REVIEW_DIR}/`)) {
        await mkdir(join(excludePath, '..'), { recursive: true })
        await appendFile(excludePath, `${current.endsWith('\n') || !current ? '' : '\n'}/${REVIEW_DIR}/\n`)
      }
    } catch (error) {
      orca.log(`could not update info/exclude: ${String(error)}`)
    }
    return dir
  }

  async function targets(ws: Workspace): Promise<Target[]> {
    const found: Target[] = []
    try {
      const ps = await orcaCli(['worktree', 'ps'], ws.path)
      const row = (ps.worktrees ?? []).find((w: any) => w.path === ws.path)
      for (const agent of row?.agents ?? []) {
        const match = String(agent.paneKey ?? '').match(/^structured-agent-session-([^:]+):/)
        if (!match) continue
        found.push({
          kind: 'chat',
          id: match[1],
          label: `Chat: ${agent.conversationName || agent.displayName || agent.agentType || 'agent'}`,
          state: agent.state
        })
      }
    } catch (error) {
      orca.log(`worktree ps failed: ${String(error)}`)
    }
    try {
      const list = await orcaCli(['terminal', 'list'], ws.path)
      for (const term of list.terminals ?? []) {
        if (term.worktreePath !== ws.path || !term.agentIdentity || !term.connected) continue
        found.push({ kind: 'terminal', id: term.handle, label: `Terminal: ${term.title || term.agentIdentity}` })
      }
    } catch (error) {
      orca.log(`terminal list failed: ${String(error)}`)
    }
    found.push({ kind: 'new', id: 'claude', label: 'New Claude chat' })
    return found
  }

  function renderComments(ws: Workspace, comments: Comment[], note: string, baseRef: string): string {
    const parts = [
      `Review comments on the changes in this workspace (branch ${shortBranch(ws.branch) || 'unknown'}, compared with ${baseRef}).`,
      'Address each one. Line numbers refer to the current file unless a comment says "old". No reply message is needed; just make the changes.'
    ]
    if (note.trim()) parts.push('', note.trim())
    comments.forEach((c, index) => {
      const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`
      const where = `${c.file}:${range}${c.side === 'old' ? ' (old, removed lines)' : ''}`
      parts.push('', `${index + 1}. ${where}`, '```diff', c.snippet, '```', c.body.trim())
    })
    return parts.join('\n')
  }

  orca.panels.handle('review.context', async () => {
    const ws = await focusedWorkspace()
    return ws as never
  })

  orca.panels.handle('review.load', async (input: any) => {
    const ws = await workspaceFor(input)
    const mode: Mode = input?.mode === 'committed' ? 'committed' : 'local'
    const { base, files } = await computeDiff(ws.path, mode)
    const state = await readState(ws.path)
    return {
      workspace: ws,
      mode,
      base: { ref: base.ref, mergeBase: base.mergeBase.slice(0, 11) },
      pr: base.pr,
      files: files.map((f) => ({
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        binary: f.binary,
        additions: f.additions,
        deletions: f.deletions,
        hash: f.hash,
        changeKeys: f.hunks.flatMap((h) => h.changes.map((c) => c.key))
      })),
      viewedFiles: state.files,
      viewedChanges: Object.keys(state.changes),
      comments: state.comments
    } as never
  })

  orca.panels.handle('review.file', async (input: any) => {
    const ws = await workspaceFor(input)
    const mode: Mode = input?.mode === 'committed' ? 'committed' : 'local'
    const found = (await cachedDiff(ws.path, mode)).files.find((f) => f.path === input.file)
    if (!found) throw Object.assign(new Error(`No diff for ${input.file}; refresh`), { code: 'conflict' })
    const file = input.full ? await fullFileDiff(ws.path, mode, found) : found
    return { path: file.path, hash: file.hash, truncated: file.truncated, binary: file.binary, hunks: file.hunks } as never
  })

  orca.panels.handle('review.setFileViewed', async (input: any) => {
    const ws = await workspaceFor(input)
    const state = await readState(ws.path)
    for (const entry of input.files as { file: string; hash: string }[]) {
      if (input.viewed) state.files[entry.file] = entry.hash
      else delete state.files[entry.file]
    }
    await writeState(ws.path, state)
    return { ok: true }
  })

  orca.panels.handle('review.setChangeViewed', async (input: any) => {
    const ws = await workspaceFor(input)
    const state = await readState(ws.path)
    for (const key of input.keys as string[]) {
      if (input.viewed) state.changes[key] = 1
      else delete state.changes[key]
    }
    await writeState(ws.path, state)
    return { ok: true }
  })

  orca.panels.handle('review.resetViewed', async (input: any) => {
    const ws = await workspaceFor(input)
    const state = await readState(ws.path)
    await writeState(ws.path, { ...state, files: {}, changes: {} })
    return { ok: true }
  })

  orca.panels.handle('review.saveComments', async (input: any) => {
    const ws = await workspaceFor(input)
    const state = await readState(ws.path)
    state.comments = input.comments
    await writeState(ws.path, state)
    orca.panels.post('review.commentsChanged', { path: ws.path, comments: state.comments } as never)
    return { ok: true }
  })

  orca.panels.handle('review.targets', async (input: any) => {
    const ws = await workspaceFor(input)
    return (await targets(ws)) as never
  })

  orca.panels.handle('review.send', async (input: any) => {
    const ws = await workspaceFor(input)
    const comments = input.comments as Comment[]
    if (!comments.length && !String(input.note ?? '').trim()) {
      throw Object.assign(new Error('Nothing to send'), { code: 'invalid_params' })
    }
    const body = renderComments(ws, comments, String(input.note ?? ''), String(input.baseRef ?? 'the base branch'))
    const target = input.target as Target
    if (target.kind === 'chat') {
      await orcaCli(
        ['orchestration', 'send', '--to', `orca_session_id:${target.id}`, '--from', SENDER, '--type', 'status',
         '--subject', `PR review: ${comments.length} comment${comments.length === 1 ? '' : 's'}`, '--body', body],
        ws.path
      )
    } else if (target.kind === 'terminal') {
      await orcaCli(['terminal', 'send', '--terminal', target.id, '--text', body, '--enter'], ws.path)
    } else {
      await orcaCli(['agent', 'launch', '--agent', target.id, '--worktree', `path:${ws.path}`, '--prompt', body, '--focus'], ws.path)
    }
    const dir = await ensureReviewDir(ws.path)
    await writeFile(join(dir, `sent-${new Date().toISOString().replace(/[:.]/g, '-')}.md`), body)
    return { ok: true, sentTo: target.label }
  })

  orca.panels.handle('review.openTab', async (input: any) => {
    const ws = await workspaceFor(input)
    if (!ws.id) throw Object.assign(new Error('Workspace not found in Orca'), { code: 'not_permitted' })
    const dir = await ensureReviewDir(ws.path)
    const file = join(dir, 'Review.prreview')
    await writeFile(file, `${JSON.stringify({ workspacePath: ws.path }, null, 2)}\n`)
    await orca.host.call('editor.open', { workspaceId: ws.id, path: `${REVIEW_DIR}/Review.prreview` })
    return { ok: true }
  })

  orca.panels.handle('review.openFile', async (input: any) => {
    const ws = await workspaceFor(input)
    if (!ws.id) throw Object.assign(new Error('Workspace not found in Orca'), { code: 'not_permitted' })
    await orca.host.call('editor.open', { workspaceId: ws.id, path: input.file })
    return { ok: true }
  })
}
