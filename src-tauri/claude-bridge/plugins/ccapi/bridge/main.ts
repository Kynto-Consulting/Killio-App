import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createBridge, type PersistedResumeCandidate } from './app.ts'
import { startAnthropicUpstreamProxy, upstreamBaseUrl } from './upstream.ts'
import type { ContextManagement } from '../src/api.ts'
import type { AgentEvent, WorkerJob } from '../src/wire.ts'

const env = (name: string, fallback: string): string => process.env[name] ?? fallback
const token = process.env.CCAPI_TOKEN
const internalToken = process.env.CCAPI_INTERNAL_TOKEN
if (!token || !internalToken) {
  console.error('ccapi bridge: CCAPI_TOKEN and CCAPI_INTERNAL_TOKEN are required')
  process.exit(1)
}

const exposeThinking = env('CCAPI_EXPOSE_THINKING', 'requested')
if (exposeThinking !== 'requested' && exposeThinking !== 'always' && exposeThinking !== 'never') {
  console.error(`ccapi bridge: CCAPI_EXPOSE_THINKING must be requested, always or never (got ${exposeThinking})`)
  process.exit(1)
}

const stateHome = process.env.XDG_STATE_HOME ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ccapi', 'state') : join(process.env.HOME ?? '.', '.local', 'state'))
const logPath = env('CCAPI_LOG', join(stateHome, 'ccapi', 'requests.jsonl'))
const resumeStatePath = join(stateHome, 'ccapi', 'resume-sessions.json')
const workerJobsDir = join(stateHome, 'ccapi', 'worker-jobs')
const bridgePort = Number(env('CCAPI_PORT', '18787'))
const externalProvider = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
  .some(name => process.env[name] === '1')
const anthropicUpstreamBase = externalProvider ? undefined : upstreamBaseUrl(
  process.env.CCAPI_UPSTREAM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL, bridgePort,
)
const workerContextManagement = new Map<string, ContextManagement | undefined>()
await mkdir(dirname(logPath), { recursive: true })
await mkdir(dirname(resumeStatePath), { recursive: true })
await mkdir(workerJobsDir, { recursive: true })

const loadResumeCandidates = (): PersistedResumeCandidate[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resumeStatePath, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((candidate): candidate is PersistedResumeCandidate =>
      typeof candidate === 'object' && candidate !== null &&
      typeof (candidate as PersistedResumeCandidate).sessionId === 'string' &&
      typeof (candidate as PersistedResumeCandidate).resumeKey === 'string' &&
      Array.isArray((candidate as PersistedResumeCandidate).history) &&
      (candidate as PersistedResumeCandidate).history.every(key => typeof key === 'string') &&
      Array.isArray((candidate as PersistedResumeCandidate).tools) &&
      (candidate as PersistedResumeCandidate).tools.every(key => typeof key === 'string') &&
      typeof (candidate as PersistedResumeCandidate).toolNames === 'object' &&
      (candidate as PersistedResumeCandidate).toolNames !== null &&
      Array.isArray((candidate as PersistedResumeCandidate).eagerTools) &&
      (candidate as PersistedResumeCandidate).eagerTools.every(key => typeof key === 'string') &&
      typeof (candidate as PersistedResumeCandidate).at === 'number',
    )
  } catch {
    return []
  }
}

const bridge = createBridge({
  token,
  noToken: env('CCAPI_NO_TOKEN', '0') === '1',
  internalToken,
  maxConcurrent: Number(env('CCAPI_MAX_CONCURRENT', '4')),
  queueSize: Number(env('CCAPI_QUEUE_SIZE', '16')),
  toolWaitMs: Number(env('CCAPI_TOOL_WAIT_MINUTES', '10')) * 60_000,
  exposeThinking,
  longPollMs: 20_000,
  maxParked: Number(env('CCAPI_MAX_PARKED', '32')),
  debugBodies: env('CCAPI_DEBUG_BODIES', 'true') === 'true',
  resumeCandidates: loadResumeCandidates(),
  setWorkerContextManagement: (sessionId, contextManagement) => {
    workerContextManagement.set(sessionId, contextManagement)
  },
  saveResumeCandidates: candidates => {
    try {
      writeFileSync(resumeStatePath, JSON.stringify(candidates), 'utf8')
    } catch (err) {
      console.error(`ccapi bridge: could not persist resumable sessions: ${String(err)}`)
    }
  },
  log: entry => {
    appendFile(logPath, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`).catch(err => {
      console.error(`ccapi bridge: could not write the request log: ${String(err)}`)
    })
    if (entry.event === 'request_start') {
      const resumeInfo = entry.route === 'cache'
        ? `cache hit (${String(entry.cachedSessionId ?? 'Haiku')})`
        : entry.route === 'continue'
        ? 'continue (tool result)'
        : entry.resumed === true
        ? `resume ${Math.round(Number(entry.resumeSimilarity) * 100)}% (${String(entry.resumeOverlapMessages)}/${String(entry.resumeInputMessages)} input; delta ${String(entry.resumeDeltaMessages)}; session ${String(entry.resumeHistoryMessages)})`
        : `fresh (${String(entry.resumeMissReason ?? 'no prior match')})`
      console.log(`ccapi request ${String(entry.convId)} · ${String(entry.model)} · ${resumeInfo}`)
    } else if (entry.route === 'resume' || entry.route === 'fresh' || entry.route === 'continue' || entry.route === 'cache') {
      const resumeInfo = entry.route === 'cache'
        ? `cache hit (${String(entry.cachedSessionId ?? 'Haiku')})`
        : entry.route === 'continue'
        ? 'continue'
        : entry.resumed === true ? `resume ${Math.round(Number(entry.resumeSimilarity) * 100)}%` : `fresh (${String(entry.resumeMissReason ?? 'no prior match')})`
      console.log(`ccapi done ${String(entry.convId)} · ${resumeInfo} · ${String(entry.stopReason ?? 'unknown')} · ${String(entry.ms ?? '?')} ms`)
    } else if (entry.event === 'resume_fallback') {
      console.log(`ccapi resume failed for ${String(entry.failedSessionId)}; retrying fresh as ${String(entry.sessionId)}`)
    }
  },
})

const internalHeaders = { 'x-ccapi-internal': internalToken, 'content-type': 'application/json' }
const forwardUpstreamEvent = async (event: AgentEvent): Promise<void> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/internal/events`, {
    method: 'POST', headers: internalHeaders, body: JSON.stringify([event]),
  })
  if (!response.ok) console.error(`ccapi bridge: could not forward upstream ${event.kind} event (${response.status})`)
}
const runner = process.env.CCAPI_WORKER_RUNNER
const bun = process.env.CCAPI_BUN ?? Bun.which('bun')
type WarmWorker = {
  child: ReturnType<typeof Bun.spawn>
  sessionId: string
  runtimeKey: string
  file: string
  activeConvId?: string
  busy: boolean
  idlePromise?: Promise<void>
  resolveIdle?: () => void
  lastUsed: number
  stderr: string
  upstream?: ReturnType<typeof startAnthropicUpstreamProxy>
  upstreamStopped?: boolean
}
const warmWorkers = new Map<string, WarmWorker>()
const idleWorkerLimit = Number(env('CCAPI_IDLE_WORKERS', '8'))
const idleSeconds = Number(env('CCAPI_WORKER_IDLE_SECONDS', '300'))
const maxIdleWorkers = Number.isFinite(idleWorkerLimit) ? Math.max(0, idleWorkerLimit) : 8
const workerIdleMs = (Number.isFinite(idleSeconds) ? Math.max(10, idleSeconds) : 300) * 1000
const stopWorkerUpstream = (worker: WarmWorker): void => {
  if (!worker.upstream || worker.upstreamStopped) return
  worker.upstreamStopped = true
  worker.upstream.stop(true)
}

const reportWorkerExit = async (worker: WarmWorker, exitCode: number): Promise<void> => {
  if (warmWorkers.get(worker.sessionId) === worker) warmWorkers.delete(worker.sessionId)
  await rm(worker.file, { force: true }).catch(() => undefined)
  const convId = worker.activeConvId
  worker.activeConvId = undefined
  worker.busy = false
  worker.resolveIdle?.()
  worker.resolveIdle = undefined
  worker.idlePromise = undefined
  stopWorkerUpstream(worker)
  workerContextManagement.delete(worker.sessionId)
  if (!convId) return
  await fetch(`http://127.0.0.1:${server.port}/internal/worker-exit`, {
    method: 'POST', headers: internalHeaders,
    body: JSON.stringify({ convId, exitCode, stderr: worker.stderr.slice(-4000) }),
  }).catch(err => console.error(`ccapi bridge: worker report failed: ${String(err)}`))
}

const watchWorker = (worker: WarmWorker): void => {
  const stdout = worker.child.stdout
  if (stdout) void (async () => {
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    const consumeLine = (line: string) => {
      try {
        const event = JSON.parse(line) as { type?: unknown }
        if (event.type === 'result' && worker.busy) {
          worker.busy = false
          worker.lastUsed = Date.now()
          worker.activeConvId = undefined
          worker.resolveIdle?.()
          worker.resolveIdle = undefined
          worker.idlePromise = undefined
          console.log(`ccapi worker idle ${worker.sessionId}`)
          trimIdleWorkers()
        }
      } catch {}
    }
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let newline = pending.indexOf('\n')
        while (newline >= 0) {
          consumeLine(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
          newline = pending.indexOf('\n')
        }
      }
      pending += decoder.decode()
      if (pending.trim() !== '') consumeLine(pending)
    } catch (error) {
      worker.stderr += `\nstdout reader: ${String(error)}`
    } finally {
      reader.releaseLock()
    }
  })()
  const stderr = worker.child.stderr
  if (stderr) void (async () => {
    const reader = stderr.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        worker.stderr = (worker.stderr + decoder.decode(value, { stream: true })).slice(-8000)
      }
    } catch (error) {
      worker.stderr += `\nstderr reader: ${String(error)}`
    } finally {
      reader.releaseLock()
    }
  })()
  void worker.child.exited.then(code => reportWorkerExit(worker, code))
}

const stopWarmWorker = async (worker: WarmWorker): Promise<void> => {
  if (warmWorkers.get(worker.sessionId) === worker) warmWorkers.delete(worker.sessionId)
  if (worker.busy) return
  try { worker.child.stdin?.end() } catch {}
  const timeout = setTimeout(() => {
    try { worker.child.kill() } catch {}
  }, 10_000)
  await worker.child.exited
  clearTimeout(timeout)
  stopWorkerUpstream(worker)
  workerContextManagement.delete(worker.sessionId)
}

function trimIdleWorkers(): void {
  const idle = [...warmWorkers.values()].filter(worker => !worker.busy).sort((a, b) => a.lastUsed - b.lastUsed)
  const now = Date.now()
  while (idle.length > 0 && (idle.length > maxIdleWorkers || now - idle[0]!.lastUsed >= workerIdleMs)) {
    const worker = idle.shift()!
    console.log(`ccapi worker evict ${worker.sessionId}`)
    void stopWarmWorker(worker)
  }
}

const runWorker = async (job: WorkerJob): Promise<void> => {
  if (!runner) {
    console.error('ccapi bridge: CCAPI_WORKER_RUNNER is missing')
    return
  }
  let worker = warmWorkers.get(job.sessionId)
  if (worker && worker.busy) {
    const ready = worker.idlePromise
      ? await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), 5_000)
          worker!.idlePromise!.then(() => { clearTimeout(timer); resolve(true) })
        })
      : false
    if (!ready || worker.busy) {
      await fetch(`http://127.0.0.1:${server.port}/internal/worker-exit`, {
        method: 'POST', headers: internalHeaders,
        body: JSON.stringify({ convId: job.convId, exitCode: 1, stderr: 'session process did not become idle in time' }),
      }).catch(() => undefined)
      return
    }
  }
  if (worker && worker.runtimeKey !== job.runtimeKey) {
    await stopWarmWorker(worker)
    worker = undefined
  }
  workerContextManagement.set(job.sessionId, job.contextManagement)
  if (worker) {
    worker.busy = true
    worker.activeConvId = job.convId
    worker.idlePromise = new Promise(resolve => { worker!.resolveIdle = resolve })
    try {
      const stdin = worker.child.stdin
      if (!stdin) throw new Error('worker stdin is unavailable')
      stdin.write(`${JSON.stringify(job)}\n`)
      stdin.flush()
      console.log(`ccapi worker reuse ${job.sessionId}`)
      return
    } catch (error) {
      worker.busy = false
      worker.activeConvId = undefined
      worker.stderr += `\nstdin write failed: ${String(error)}`
      await stopWarmWorker(worker)
    }
  }
  const file = join(workerJobsDir, `${job.convId}.json`)
  await writeFile(file, JSON.stringify(job), 'utf8')
  const upstream = anthropicUpstreamBase ? startAnthropicUpstreamProxy(anthropicUpstreamBase, {
    contextManagement: () => workerContextManagement.get(job.sessionId),
    onCompaction: content => forwardUpstreamEvent({ kind: 'compaction', agentId: job.sessionId, content }),
    onCompactionPause: () => forwardUpstreamEvent({ kind: 'compaction-pause', agentId: job.sessionId }),
    onUsage: iterations => forwardUpstreamEvent({ kind: 'usage-iterations', agentId: job.sessionId, iterations }),
  }) : undefined
  try {
    if (!bun) throw new Error('Bun executable was not found')
    const child = Bun.spawn(
      [bun, runner, file],
      {
        cwd: process.env.CCAPI_SERVER_DIR ?? process.cwd(),
        env: {
          ...process.env,
          ...(upstream ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}` } : {}),
          CCAPI_WORKER: '1', CCAPI_WORKER_CONV_ID: job.convId, CCAPI_WORKER_AGENT_ID: job.sessionId,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    worker = {
      child, sessionId: job.sessionId, runtimeKey: job.runtimeKey,
      file, activeConvId: job.convId, busy: true, lastUsed: Date.now(), stderr: '', upstream,
    }
    worker.idlePromise = new Promise(resolve => { worker!.resolveIdle = resolve })
    warmWorkers.set(job.sessionId, worker)
    watchWorker(worker)
  } catch (error) {
    upstream?.stop(true)
    workerContextManagement.delete(job.sessionId)
    await rm(file, { force: true }).catch(() => undefined)
    await fetch(`http://127.0.0.1:${server.port}/internal/worker-exit`, {
      method: 'POST', headers: internalHeaders,
      body: JSON.stringify({ convId: job.convId, exitCode: 1, stderr: String(error) }),
    }).catch(err => console.error(`ccapi bridge: worker report failed: ${String(err)}`))
  }
}

const workerLoop = async (): Promise<void> => {
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/internal/next-worker`, { headers: internalHeaders })
      if (response.status === 200) void runWorker(await response.json() as WorkerJob)
      else if (response.status !== 204) await Bun.sleep(1000)
    } catch (err) {
      console.error(`ccapi bridge: worker queue poll failed: ${String(err)}`)
      await Bun.sleep(1000)
    }
  }
}

// idleTimeout 0: non-stream answers and long-polls can stay silent for minutes.
const server = Bun.serve({ hostname: '127.0.0.1', port: bridgePort, idleTimeout: 0, fetch: req => bridge.fetch(req) })
setInterval(() => bridge.sweep(Date.now()), 5_000)
setInterval(trimIdleWorkers, 5_000)
console.log(`ccapi bridge listening on http://127.0.0.1:${server.port}`)
void workerLoop()
