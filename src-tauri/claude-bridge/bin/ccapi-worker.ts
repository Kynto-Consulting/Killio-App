import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

type WorkerJob = {
  sessionId: string
  resume: boolean
  model: string
  effort?: string | number
  systemPrompt: string
  prompt: string
}

const [jobPath] = Bun.argv.slice(2)
if (!jobPath) throw new Error('ccapi worker: initial job file is required')
const firstJob = JSON.parse(await readFile(jobPath, 'utf8')) as WorkerJob
const repo = process.env.CCAPI_REPO
if (!repo) throw new Error('ccapi worker: CCAPI_REPO is missing')

const cli = process.env.CCAPI_CLAUDE ?? Bun.which('claude')
if (!cli) throw new Error('ccapi worker: Claude Code CLI was not found')
const args = [
  '--plugin-dir', join(repo, 'plugins/ccapi'),
  '--settings', join(repo, 'server-settings.json'),
  '--setting-sources', 'project,local',
  '--strict-mcp-config',
  '--add-dir', repo,
  '--model', firstJob.model,
  '--system-prompt', firstJob.systemPrompt,
  '--permission-mode', 'bypassPermissions',
  '--tools', '',
  '--print',
  '--verbose',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
]
if (firstJob.effort !== undefined && /^(low|medium|high|xhigh|max)$/.test(String(firstJob.effort)))
  args.push('--effort', String(firstJob.effort))
if (firstJob.resume) args.push('--resume', firstJob.sessionId)
else args.push('--session-id', firstJob.sessionId)

const claude = Bun.spawn([cli, ...args], {
  cwd: process.env.CCAPI_SERVER_DIR ?? process.cwd(),
  env: { ...process.env, CCAPI_WORKER: '1', CCAPI_WORKER_AGENT_ID: firstJob.sessionId },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})
const claudeInput = claude.stdin
if (!claudeInput) throw new Error('ccapi worker: Claude stdin pipe was not created')

const sendPrompt = (job: WorkerJob): void => {
  claudeInput.write(`${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: job.prompt },
    parent_tool_use_id: null,
  })}\n`)
  claudeInput.flush()
}

const stdoutTask = (async () => {
  for await (const chunk of claude.stdout) process.stdout.write(chunk)
})()
const stderrTask = (async () => {
  for await (const chunk of claude.stderr) process.stderr.write(chunk)
})()

const decoder = new TextDecoder()
let pending = ''
const inputTask = (async () => {
  try {
    sendPrompt(firstJob)
    for await (const chunk of process.stdin) {
      pending += decoder.decode(chunk, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line !== '') {
          try {
            sendPrompt(JSON.parse(line) as WorkerJob)
          } catch (error) {
            process.stderr.write(`ccapi worker: invalid queued turn: ${String(error)}\n`)
          }
        }
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    if (pending.trim() !== '') {
      try {
        sendPrompt(JSON.parse(pending) as WorkerJob)
      } catch (error) {
        process.stderr.write(`ccapi worker: invalid final queued turn: ${String(error)}\n`)
      }
    }
  } catch (error) {
    process.stderr.write(`ccapi worker: input ended: ${String(error)}\n`)
  } finally {
    try { claudeInput.end() } catch {}
  }
})()
const exitCode = await claude.exited
process.stdin.destroy()
await inputTask
process.exitCode = exitCode
await Promise.all([stdoutTask, stderrTask])
