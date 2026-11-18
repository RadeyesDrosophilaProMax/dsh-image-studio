import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * In-app image studio backend.
 *
 * Serves the Studio panel's three routes and talks to the local Stable
 * Diffusion WebUI (AUTOMATIC1111). The WebUI is started on demand in low-VRAM
 * mode, hidden, and left resident afterwards.
 *
 * @module @local/dsh-studio
 */

export const name = 'sd-studio'

const IMAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')
const PROBE_MS = 3000
const POLL_MS = 2000

/** Read one JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write a JSON response. */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Whether the WebUI answers on its API port. */
async function findLive(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/sdapi/v1/options`, { signal: AbortSignal.timeout(PROBE_MS) })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

/** Spawn the WebUI hidden, logging next to the install. */
function launch(settings) {
  const logDir = path.join(settings.installDir, 'tmp')
  mkdirSync(logDir, { recursive: true })
  const fd = openSync(path.join(logDir, 'studio-sd.log'), 'a')
  const child = spawn(settings.pythonPath, [
    'launch.py',
    '--api',
    '--nowebui',
    '--lowvram',
    '--port', String(settings.port),
    '--skip-install',
    '--skip-version-check',
    '--skip-python-version-check',
  ], {
    cwd: settings.installDir,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' },
  })
  child.on('error', () => {})
  child.unref()
  try {
    closeSync(fd)
  } catch {
    // The child owns the handle.
  }
}

/** Resolve the WebUI, starting it once when needed. */
function createStarter(settings) {
  let pending
  return async function ensure() {
    if (await findLive(settings.baseUrl)) return settings.baseUrl
    if (pending === undefined) {
      launch(settings)
      const deadline = Date.now() + settings.readyTimeoutMs
      pending = (async () => {
        while (Date.now() < deadline) {
          if (await findLive(settings.baseUrl)) return settings.baseUrl
          await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        }
        throw new Error(`SD WebUI 启动超时（${Math.round(settings.readyTimeoutMs / 1000)} 秒）`)
      })().finally(() => { pending = undefined })
    }
    return await pending
  }
}

/** Stop the WebUI processes that belong to this install. */
async function stopProcesses(settings) {
  const root = settings.installDir.replaceAll("'", "''")
  const script = `$root = '${root}'; `
    + 'Get-CimInstance Win32_Process | '
    + "Where-Object { ($_.Name -eq 'python.exe' -or $_.Name -eq 'pythonw.exe') "
    + "-and $_.CommandLine -like '*launch.py*' "
    + "-and $_.CommandLine -like ('*' + $root + '*') } | "
    + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 20000,
    })
  } catch {
    // Already stopped is the desired state.
  }
}

export function apply(ctx, config = {}) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const settings = {
    baseUrl: 'http://127.0.0.1:' + (Number.isFinite(raw.port) ? raw.port : 7860),
    pythonPath: raw.pythonPath ?? '',
    installDir: raw.installDir ?? '',
    port: Number.isFinite(raw.port) ? raw.port : 7860,
    readyTimeoutMs: Number.isFinite(raw.readyTimeoutMs) ? raw.readyTimeoutMs : 240000,
    timeoutMs: Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : 180000,
    steps: Number.isFinite(raw.defaultSteps) ? raw.defaultSteps : 20,
    width: Number.isFinite(raw.defaultWidth) ? raw.defaultWidth : 512,
    height: Number.isFinite(raw.defaultHeight) ? raw.defaultHeight : 512,
    wechatPush: raw.wechatPush !== false,
    translateMode: ['auto', 'cloud', 'local'].includes(raw.translateMode) ? raw.translateMode : 'local',
    translateLocalUrl: typeof raw.translateLocalUrl === 'string' ? raw.translateLocalUrl : 'http://127.0.0.1:1234/v1',
  }
  const ensure = createStarter(settings)
  const state = { starting: false }

  /** Normalize raw model output into a clean tag list. */
  const cleanTags = (raw) => raw
    .replace(/[\r\n]+/g, ',')
    .split(',')
    .map((part) => part.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '' && /[A-Za-z]/.test(part))
    .map((part) => part.replace(/^(tags?|prompt)\s*[:：]\s*/i, ''))
    .join(', ')
    .slice(0, 600)

  /** Translate with the harness LLM route (needs network for cloud routes). */
  const translateWithCloud = async (text, system) => {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用')
    let selection
    try {
      selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : undefined
    } catch {
      selection = undefined
    }
    let provider = typeof selection?.provider === 'string' && selection.provider !== '' ? selection.provider : 'deepseek-account'
    let model = typeof selection?.model === 'string' && selection.model !== '' ? selection.model : 'deepseek-flash'
    if (provider === 'api') {
      provider = 'deepseek-account'
      model = 'deepseek-flash'
    }
    let output = ''
    let failure
    for await (const chunk of llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 900,
      temperature: 0,
    })) {
      if (chunk.type === 'text-delta') output += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = chunk.reason.failure
    }
    if (failure !== undefined) throw new Error(failure.message)
    return output
  }

  /** Translate with the local llama.cpp server, so translation works offline. */
  const translateWithLocal = async (text, system) => {
    const url = settings.translateLocalUrl
    if (typeof url !== 'string' || url === '') throw new Error('未配置本地翻译地址')
    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        max_tokens: 300,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`本地服务 HTTP ${response.status}`)
    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('本地服务没有返回内容')
    return content
  }

  /** Translate a Chinese description, cloud first and local as the offline fallback. */
  const translateText = async (text) => {
    const system = 'Translate the Chinese image description into English Danbooru tags for Stable Diffusion. '
      + 'Keep EVERY concrete detail: number of people, hair color, eye color, clothing, pose, location, time of day, lighting, art style. '
      + 'Never invent a subject, location or outfit that the description does not mention, and never copy tags from these instructions. '
      + 'Reply with only comma-separated lowercase English tags, no sentences, no quotes, no explanations.'
    const order = settings.translateMode === 'local'
      ? ['local']
      : settings.translateMode === 'cloud'
        ? ['cloud']
        : ['cloud', 'local']
    const failures = []
    for (const source of order) {
      try {
        const raw = source === 'cloud'
          ? await translateWithCloud(text, system)
          : await translateWithLocal(text, system)
        const tags = cleanTags(raw)
        if (tags === '' || /[\u3400-\u9fff]/.test(tags)) throw new Error('结果不可用')
        return { tags, source }
      } catch (error) {
        failures.push(`${source === 'cloud' ? '云端' : '本地'}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`翻译失败（${failures.join('；')}）。离线时请直接用英文提示词。`)
  }

  /** Deliver a generated image to the current chat channel (QQ first, then WeChat). */
  const deliverImage = async (agent, signal, file) => {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (tools === undefined || typeof tools.get !== 'function') {
      return { channel: 'none', result: { skipped: '没有可用的推送工具' } }
    }
    // Channel guards only accept files inside the session workspace, so mirror
    // the generated PNG there before handing it to any chat tool.
    let pushPath = file
    try {
      const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      if (workingDirectory !== undefined && typeof workingDirectory.ensure === 'function' && agent !== undefined) {
        const cwd = await workingDirectory.ensure(agent, signal)
        const targetDir = path.join(cwd, 'generated')
        await mkdir(targetDir, { recursive: true })
        const target = path.join(targetDir, path.basename(file))
        await writeFile(target, await readFile(file))
        pushPath = target
      }
    } catch {
      pushPath = file
    }

    const attempts = []
    const qqSend = tools.get('qqbot_send_file')
    if (qqSend !== undefined) {
      try {
        const result = await qqSend.execute({ file_path: pushPath }, { agent, signal })
        attempts.push({ channel: 'qq', result })
        if (!(result !== null && typeof result === 'object' && result.ok === false)) {
          return { channel: 'qq', result, attempts }
        }
      } catch (error) {
        attempts.push({ channel: 'qq', error: error instanceof Error ? error.message : String(error) })
      }
    }
    const wechatSend = tools.get('send_wechat')
    if (wechatSend !== undefined) {
      try {
        const result = await wechatSend.execute({ file_path: pushPath }, { agent, signal })
        attempts.push({ channel: 'wechat', result })
        return { channel: 'wechat', result, attempts }
      } catch (error) {
        attempts.push({ channel: 'wechat', error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { channel: 'none', result: { skipped: '没有可用的推送工具' }, attempts }
  }

  /** Run one txt2img generation and store the PNG. */
  const runGeneration = async (input, signal) => {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (prompt === '') throw new Error('prompt 不能为空')
    state.starting = true
    const base = await ensure()
    state.starting = false

    const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback)
    const width = clamp(input.width, 256, 1024, settings.width)
    const height = clamp(input.height, 256, 1024, settings.height)
    const steps = clamp(input.steps, 4, 50, settings.steps)
    const seed = Number.isFinite(input.seed) ? input.seed : -1
    const negative = typeof input.negative_prompt === 'string' && input.negative_prompt.trim() !== ''
      ? input.negative_prompt.trim()
      : 'lowres, bad anatomy, worst quality, low quality, watermark, signature'

    const started = Date.now()
    const response = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        negative_prompt: negative,
        steps,
        width,
        height,
        cfg_scale: 7,
        sampler_name: 'DPM++ 2M',
        seed,
        batch_size: 1,
        n_iter: 1,
      }),
      signal: signal ?? AbortSignal.timeout(settings.timeoutMs),
    })
    if (!response.ok) throw new Error(`SD WebUI 返回 HTTP ${response.status}`)
    const data = await response.json()
    const encoded = Array.isArray(data.images) ? data.images[0] : undefined
    if (typeof encoded !== 'string' || encoded === '') throw new Error('SD WebUI 没有返回图片')

    let info = {}
    try {
      info = JSON.parse(data.info ?? '{}')
    } catch {
      info = {}
    }

    await mkdir(IMAGE_DIR, { recursive: true })
    const fileName = `${randomUUID().replaceAll('-', '')}.png`
    await writeFile(path.join(IMAGE_DIR, fileName), Buffer.from(encoded, 'base64'))

    return {
      url: `/studio/img/${fileName}`,
      file: path.join(IMAGE_DIR, fileName),
      seed: Number.isFinite(info.seed) ? info.seed : seed,
      model: typeof info.sd_model_name === 'string' ? info.sd_model_name : 'current',
      width,
      height,
      steps,
      elapsedMs: Date.now() - started,
      prompt,
    }
  }

  // Model-facing tool: one call, Chinese accepted (auto-translated).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.get('tools')
      if (tools === undefined || typeof tools.register !== 'function') return
      toolsCtx.effect(() => tools.register({
        name: 'generate_image',
        description: 'Generate a picture with the local Stable Diffusion WebUI on this machine. '
          + 'Write the prompt in Chinese or English: Chinese is translated into English tags automatically. '
          + 'Call it immediately when the user asks for a picture; never ask for confirmation or more details, '
          + 'derive a good prompt from the request and use the defaults. '
          + 'One call is enough; it returns the image URL and must be shown to the user.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', description: 'What the picture should show. Chinese or English.' },
            width: { type: 'integer', description: 'Default 512, keep 512 on small GPUs.' },
            height: { type: 'integer', description: 'Default 512.' },
            steps: { type: 'integer', description: 'Sampling steps, default 20.' },
            seed: { type: 'integer', description: 'Fixed seed for reproducibility; omit for random.' },
          },
          required: ['prompt'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              url: { type: 'string' },
              seed: { type: 'integer' },
              model: { type: 'string' },
              elapsedMs: { type: 'integer' },
            },
            required: ['url', 'seed', 'model', 'elapsedMs'],
          },
          render: (_args, value) => [{ type: 'text', text: `图片已生成：![生成图片](${value.url})` }],
        },
        timeoutMs: settings.readyTimeoutMs + settings.timeoutMs + 5000,
        async execute(args, exec) {
          let prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
          if (prompt === '') throw new Error('prompt 不能为空')
          if (/[\u3400-\u9fff]/.test(prompt)) prompt = (await translateText(prompt)).tags
          const result = await runGeneration({ ...args, prompt }, exec.signal)
          let origin = ''
          try {
            origin = typeof ctx.get === 'function' ? (ctx.get('webServer')?.getOrigin?.() ?? '') : ''
          } catch {
            origin = ''
          }
          const url = origin === '' ? result.url : `${origin}${result.url}`
          if (settings.wechatPush) {
            let delivery
            try {
              delivery = await deliverImage(exec.agent, exec.signal, result.file)
            } catch (error) {
              delivery = { channel: 'none', result: { error: error instanceof Error ? error.message : String(error) } }
            }
            try {
              await writeFile(
                path.join(path.dirname(fileURLToPath(import.meta.url)), 'push.log'),
                `${JSON.stringify({ at: new Date().toISOString(), channel: delivery.channel, result: delivery.result, attempts: delivery.attempts })}\n`,
                { flag: 'a' },
              )
            } catch {
              // Logging is best effort.
            }
          }
          return { url, seed: result.seed, model: result.model, elapsedMs: result.elapsedMs }
        },
      }), 'sd-studio generate_image')
    })
  }

  // Deterministic path for chat clients that cannot rely on model tool calls:
  // `/draw <prompt>` generates and pushes the image itself.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands', 'tools'], (commandCtx) => {
      const commands = commandCtx.get('commands')
      const toolsService = commandCtx.get('tools')
      if (commands === undefined || typeof commands.register !== 'function') return
      commandCtx.effect(() => commands.register({
        name: 'draw',
        description: '用本地生图模型画一张图并直接发送（提示词可用中文）',
        input: { hint: '<画面描述>' },
        handler: async (invocation) => {
          try {
            let prompt = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
            if (prompt === '') return { kind: 'error', text: '用法：/draw 画面描述' }
            if (/[\u3400-\u9fff]/.test(prompt)) prompt = (await translateText(prompt)).tags
            const result = await runGeneration({ prompt }, invocation.signal)

            let pushed = false
            let channel = 'none'
            try {
              const delivery = await deliverImage(invocation.agent, invocation.signal, result.file)
              channel = delivery.channel
              pushed = delivery.channel !== 'none'
            } catch {
              pushed = false
            }
            return {
              kind: 'success',
              text: pushed
                ? `已生成并发送（${channel === 'qq' ? 'QQ' : '微信'}）：${prompt}`
                : `已生成，但推送失败：${prompt}`,
            }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }), 'sd-studio draw command')
    })
  }

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (httpCtx) => {
    const webServer = httpCtx.get('webServer')
    if (webServer === undefined) return

    const route = (pathname, handler) => {
      httpCtx.effect(() => webServer.register({ kind: 'exact', path: pathname, handler }), `sd-studio ${pathname}`)
    }

    route('/studio/api/status', async (_req, res) => {
      try {
        const live = await findLive(settings.baseUrl)
        let model = ''
        if (live) {
          try {
            const options = await (await fetch(`${settings.baseUrl}/sdapi/v1/options`, { signal: AbortSignal.timeout(PROBE_MS) })).json()
            model = typeof options.sd_model_checkpoint === 'string' ? options.sd_model_checkpoint : ''
          } catch {
            model = ''
          }
        }
        sendJson(res, 200, { ok: true, running: live, starting: state.starting, model })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) })
      }
    })

    route('/studio/api/start', async (_req, res) => {
      try {
        if (await findLive(settings.baseUrl)) {
          sendJson(res, 200, { ok: true, running: true })
          return
        }
        if (settings.installDir === '' || settings.pythonPath === '') {
          sendJson(res, 400, { ok: false, error: '请先在插件配置里设置 installDir 与 pythonPath（Stable Diffusion WebUI 的安装目录与 Python 解释器）' })
          return
        }
        if (!state.starting) {
          state.starting = true
          ensure().catch(() => {}).finally(() => { state.starting = false })
        }
        sendJson(res, 200, { ok: true, running: false, starting: true })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) })
      }
    })

    route('/studio/api/stop', async (_req, res) => {
      try {
        await stopProcesses(settings)
        state.starting = false
        sendJson(res, 200, { ok: true, running: false })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) })
      }
    })

    route('/studio/api/translate', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') {
          sendJson(res, 400, { ok: false, error: 'text 不能为空' })
          return
        }
        const result = await translateText(text)
        sendJson(res, 200, { ok: true, tags: result.tags, source: result.source })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    route('/studio/api/generate', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          sendJson(res, 400, { ok: false, error: 'prompt 不能为空' })
          return
        }
        state.starting = true
        const base = await ensure()
        state.starting = false

        const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback)
        const width = clamp(body.width, 256, 1024, settings.width)
        const height = clamp(body.height, 256, 1024, settings.height)
        const steps = clamp(body.steps, 4, 50, settings.steps)
        const seed = Number.isFinite(body.seed) ? body.seed : -1
        const negative = typeof body.negative_prompt === 'string' && body.negative_prompt.trim() !== ''
          ? body.negative_prompt.trim()
          : 'lowres, bad anatomy, worst quality, low quality, watermark, signature'

        const started = Date.now()
        const response = await fetch(`${base}/sdapi/v1/txt2img`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt,
            negative_prompt: negative,
            steps,
            width,
            height,
            cfg_scale: 7,
            sampler_name: 'DPM++ 2M',
            seed,
            batch_size: 1,
            n_iter: 1,
          }),
          signal: AbortSignal.timeout(settings.timeoutMs),
        })
        if (!response.ok) throw new Error(`SD WebUI 返回 HTTP ${response.status}`)
        const data = await response.json()
        const encoded = Array.isArray(data.images) ? data.images[0] : undefined
        if (typeof encoded !== 'string' || encoded === '') throw new Error('SD WebUI 没有返回图片')

        let info = {}
        try {
          info = JSON.parse(data.info ?? '{}')
        } catch {
          info = {}
        }

        await mkdir(IMAGE_DIR, { recursive: true })
        const fileName = `${randomUUID().replaceAll('-', '')}.png`
        await writeFile(path.join(IMAGE_DIR, fileName), Buffer.from(encoded, 'base64'))

        sendJson(res, 200, {
          ok: true,
          url: `/studio/img/${fileName}`,
          seed: Number.isFinite(info.seed) ? info.seed : seed,
          model: typeof info.sd_model_name === 'string' ? info.sd_model_name : 'current',
          width,
          height,
          steps,
          elapsedMs: Date.now() - started,
        })
      } catch (error) {
        state.starting = false
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    route('/studio/api/reveal', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const name = path.basename(typeof body.url === 'string' ? body.url : '')
        if (!/^[a-z0-9]{16,64}\.png$/.test(name)) {
          sendJson(res, 400, { ok: false, error: '无效的图片地址' })
          return
        }
        const file = path.join(IMAGE_DIR, name)
        const info = await stat(file)
        if (!info.isFile()) throw new Error('文件不存在')
        // Explorer returns a non-zero exit code even on success, so fire and forget.
        const child = spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
        sendJson(res, 200, { ok: true, path: file })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    route('/studio/api/img2img', async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          sendJson(res, 400, { ok: false, error: 'prompt 不能为空' })
          return
        }
        let base64 = ''
        if (typeof body.image === 'string' && body.image !== '') {
          base64 = body.image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
        } else if (typeof body.imageName === 'string' && /^[a-z0-9]{16,64}\.png$/.test(path.basename(body.imageName))) {
          base64 = (await readFile(path.join(IMAGE_DIR, path.basename(body.imageName)))).toString('base64')
        }
        if (base64 === '') {
          sendJson(res, 400, { ok: false, error: '缺少参考图' })
          return
        }

        state.starting = true
        const base = await ensure()
        state.starting = false

        const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback)
        const width = clamp(body.width, 256, 1024, settings.width)
        const height = clamp(body.height, 256, 1024, settings.height)
        const steps = clamp(body.steps, 4, 50, settings.steps)
        const denoise = Number.isFinite(body.denoise) ? Math.min(0.95, Math.max(0.05, body.denoise)) : 0.6
        const seed = Number.isFinite(body.seed) ? body.seed : -1
        const negative = typeof body.negative_prompt === 'string' && body.negative_prompt.trim() !== ''
          ? body.negative_prompt.trim()
          : 'lowres, bad anatomy, worst quality, low quality, watermark, signature'

        const started = Date.now()
        const response = await fetch(`${base}/sdapi/v1/img2img`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            init_images: [base64],
            denoising_strength: denoise,
            prompt,
            negative_prompt: negative,
            steps,
            width,
            height,
            cfg_scale: 7,
            sampler_name: 'DPM++ 2M',
            seed,
            batch_size: 1,
            n_iter: 1,
          }),
          signal: AbortSignal.timeout(settings.timeoutMs),
        })
        if (!response.ok) throw new Error(`SD WebUI 返回 HTTP ${response.status}`)
        const data = await response.json()
        const encoded = Array.isArray(data.images) ? data.images[0] : undefined
        if (typeof encoded !== 'string' || encoded === '') throw new Error('SD WebUI 没有返回图片')

        let info = {}
        try {
          info = JSON.parse(data.info ?? '{}')
        } catch {
          info = {}
        }

        await mkdir(IMAGE_DIR, { recursive: true })
        const fileName = `${randomUUID().replaceAll('-', '')}.png`
        await writeFile(path.join(IMAGE_DIR, fileName), Buffer.from(encoded, 'base64'))

        sendJson(res, 200, {
          ok: true,
          url: `/studio/img/${fileName}`,
          seed: Number.isFinite(info.seed) ? info.seed : seed,
          model: typeof info.sd_model_name === 'string' ? info.sd_model_name : 'current',
          width,
          height,
          steps,
          denoise,
          elapsedMs: Date.now() - started,
        })
      } catch (error) {
        state.starting = false
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    route('/studio/api/clear', async (_req, res) => {
      try {
        await mkdir(IMAGE_DIR, { recursive: true })
        const names = await readdir(IMAGE_DIR)
        let deleted = 0
        for (const name of names) {
          if (!/^[a-z0-9]{16,64}\.png$/.test(name)) continue
          await rm(path.join(IMAGE_DIR, name), { force: true })
          deleted += 1
        }
        sendJson(res, 200, { ok: true, deleted })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    httpCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/studio/img',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1')
          const fileName = path.basename(url.pathname)
          if (!/^[a-z0-9]{16,64}\.png$/.test(fileName)) {
            res.statusCode = 400
            res.end('bad name')
            return
          }
          const data = await readFile(path.join(IMAGE_DIR, fileName))
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': data.length,
            'Cache-Control': 'public, max-age=86400',
          })
          res.end(data)
        } catch {
          res.statusCode = 404
          res.end('not found')
        }
      },
    }), 'sd-studio images')
  })
}
