/**
 * dsh-bell-notify — 宿主半边。
 *
 * 职责四件：
 *
 * 1. **观察"跑完了"**：监听 `api-session/status(sessionId, running)`，只在
 *    `running: true → false` 这一次跳变上记一笔。要求先见过 `true`，是为了
 *    避免启动时把"本来就是空闲"的会话误报成刚跑完。
 * 2. **发 Windows 原生通知**：优先 Electron 的 `Notification`（走 DSH 自己的
 *    应用身份，托盘里显示的是 DSH 而不是 PowerShell）；Electron 不可用时
 *    回退到 WinRT toast。两种方式都是**操作系统通知**，出现在 Windows
 *    通知中心，而不是网页里的一个气泡。
 * 3. **推给浏览器**：通过 SSE 把事件推给页面，让铃铛能显示红点、并在通知
 *    真的发不出去时由客户端兜底。用 SSE 而不是轮询，是因为窗口最小化时
 *    Chromium 会把 `setInterval` 降频（后台 5 分钟后最慢到 1 次/分钟），
 *    而人恰恰是在离开窗口时才需要通知。
 * 4. **存开关**：`enabled` 决定要不要记录与通知。
 *
 * 刻意的取舍：
 * - **通知失败要留痕**。每条事件带 `delivered` 字段，null 表示系统通知没发
 *   出去；客户端据此决定是否兜底弹网页通知。绝不静默吞掉。
 * - **不持久化 enabled**。页面加载时客户端会把自己记的值 PUT 回来，宿主以
 *    客户端为准。省掉一份状态文件，也不会出现"宿主观点的开关和界面不一致"。
 * - **缓冲区有上限**。SSE 断线期间的补偿靠客户端按 `since` 拉取，但补不了
 *   无限久 —— 超过 20 条就丢最旧的，通知本来也不该补发昨天的。
 *
 * @module dsh-bell-notify
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

/** 开关与补偿拉取。 */
const ROUTE_STATE = '/plugins/dsh-bell/state'
const ROUTE_PENDING = '/plugins/dsh-bell/pending'
/** SSE 长连接。 */
const ROUTE_STREAM = '/plugins/dsh-bell/stream'
/** 手动发一条测试通知，用来验证系统通知能不能弹出来。 */
const ROUTE_TEST = '/plugins/dsh-bell/test'

/** 未读事件缓冲区上限。 */
const MAX_PENDING = 20
/** 心跳间隔：让中间的代理和 Chromium 都别把连接当死的关掉。 */
const HEARTBEAT_MS = 25000
/** 请求体上限。 */
const MAX_BODY_BYTES = 16 * 1024
/**
 * PowerShell toast 的硬上限。它要起一个进程（PowerShell 5.1 冷启动可能一两秒），
 * 卡住了不能一直挂着 —— 但因为它跑在后台、事件已经先推走了，这个超时只影响
 * delivered 字段什么时候回填，不影响用户看到通知的速度。
 */
const TOAST_TIMEOUT_MS = 8000
/**
 * toast 用的 AppID，按优先级排列。
 *
 * AppID 决定通知顶部显示的名字与图标 —— 用 PowerShell 的 AppID，Windows 就会把
 * 通知归到"Windows PowerShell"名下。所以优先用 DSH 自己的身份。
 */
const TOAST_APP_ID_DSH = 'electron.app.DeepSeek Harness'
/**
 * Windows PowerShell 5.1 自带的已注册 AppID。
 *
 * 兜底用：它一定存在，所以即使 DSH 换了 AppID 也还有一条路。代价是通知会显示
 * 成 PowerShell。
 */
const TOAST_APP_ID_FALLBACK = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * 插件入口。
 *
 * @param {object} ctx cordis 上下文。
 */
export function apply(ctx) {
  const note = (message) => {
    try {
      if (typeof ctx.logger === 'function') ctx.logger('dsh-bell-notify').info(message)
    } catch {
      /* 日志打不出去不是功能故障 */
    }
  }

  /** @param {(fn: Function, label: string) => void} mount */
  const mount = (fn, label) => ctx.effect(fn, label)

  /** 开关。默认关 —— 通知这种东西，默认不打扰。 */
  let enabled = false
  /** 单调递增的事件序号，客户端拿它做"从哪继续"。 */
  let seq = 0
  /** 未读事件（按 seq 升序）。 */
  const pending = []
  /** 正在跑的会话集合。 */
  const running = new Set()
  /** sessionId → 会话标题，来自 api-session/added。 */
  const titles = new Map()
  /** 连着的事件流响应。 */
  const streams = new Set()

  /* ─────────────────── 1. 发 Windows 通知 ─────────────────── */

  /**
   * 走 Electron 原生 Notification。
   *
   * 桌面版里宿主跑在 Electron 主进程，`require('electron')` 能拿到 Notification，
   * 弹出来的是带 DSH 应用身份的系统通知 —— 这是最理想的一条路。
   * 纯 `dsh web` 下没有 Electron，这里会抛 MODULE_NOT_FOUND，交给下一层。
   *
   * @param {string} title 标题。
   * @param {string} body 正文。
   * @returns {boolean} 是否成功。
   */
  const notifyElectron = (title, body) => {
    try {
      const require = createRequire(import.meta.url)
      const electron = require('electron')
      const Native = electron && electron.Notification
      if (!Native) return false
      if (typeof Native.isSupported === 'function' && !Native.isSupported()) return false
      const instance = new Native({ title, body, silent: false })
      if (typeof instance.show === 'function') instance.show()
      return true
    } catch {
      return false
    }
  }

  /**
   * 走 Windows 的 WinRT toast（PowerShell 5.1）。
   *
   * 这是没有任何依赖的兜底：WinRT 类型程序集在 Win10/11 自带，PowerShell 5.1
   * 的 AppID 又是系统预注册的，所以不用自己写注册表。
   *
   * 正文通过环境变量传，避免把用户内容拼进命令行 —— 既躲开了引号地狱，
   * 也堵住了命令注入。XML 转义在 PowerShell 里做。
   *
   * @param {string} title 标题。
   * @param {string} body 正文。
   * @returns {Promise<boolean>} 是否成功。
   */
  const notifyPowerShell = (title, body) => new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const script = [
      // WinRT 类型必须按命名空间逐个显式加载。只加载 ToastNotificationManager
      // 是不够的 —— 后面 new XmlDocument 会报 "Cannot find type"。
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
      '$t = [System.Security.SecurityElement]::Escape($env:DSH_BELL_TITLE)',
      '$b = [System.Security.SecurityElement]::Escape($env:DSH_BELL_BODY)',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      "$x.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>\")",
      '$o = New-Object Windows.UI.Notifications.ToastNotification($x)',
      // 逐个 AppID 试：DSH 的身份优先，失败就退回 PowerShell 的（一定能用）。
      '$ok = $false',
      `foreach ($id in @('${TOAST_APP_ID_DSH}','${TOAST_APP_ID_FALLBACK}')) {`,
      '  try {',
      '    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($o)',
      '    $ok = $true; break',
      '  } catch { }',
      '}',
      'if (-not $ok) { exit 1 }',
    ].join('; ')

    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, DSH_BELL_TITLE: title, DSH_BELL_BODY: body },
        windowsHide: true,
        stdio: 'ignore',
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        finish(false)
      }, TOAST_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()

      child.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code === 0)
      })
    } catch {
      finish(false)
    }
  })

  /**
   * 发一条系统通知，返回实际走通的方式。
   *
   * `DSH_BELL_DISABLE_TOAST=1` 时直接跳过。两个用处：无头服务器上本就不该
   * 弹通知；以及让自动化测试不必每跑一次就放六七条 toast 出来。
   *
   * @param {string} title 标题。
   * @param {string} body 正文。
   * @returns {Promise<string|null>} 'electron' | 'powershell' | 'skipped' | null（都失败）。
   */
  const deliver = async (title, body) => {
    if (process.env.DSH_BELL_DISABLE_TOAST === '1') return 'skipped'
    if (notifyElectron(title, body)) return 'electron'
    if (process.platform === 'win32' && await notifyPowerShell(title, body)) return 'powershell'
    return null
  }

  /* ─────────────────── 2. 观察会话状态 ─────────────────────── */

  /** 把一条事件推给所有连着的页面。不传就推最后一条。 */
  const broadcast = (event) => {
    const payload = event || pending[pending.length - 1]
    if (!payload) return
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of streams) {
      try {
        res.write(frame)
      } catch {
        streams.delete(res)
      }
    }
  }

  /**
   * 取会话标题。
   *
   * 先看 `api-session/added` 缓存（免费），没有再问 `sessionQuery.readTitle`
   * （权威但要走一次查询）。缓存只覆盖本次进程启动后新增的会话，所以不能只靠它。
   *
   * @param {string} sessionId 会话 id。
   * @returns {Promise<string>} 标题；取不到时空串。
   */
  const titleOf = async (sessionId) => {
    const cached = titles.get(sessionId)
    if (typeof cached === 'string' && cached.trim().length > 0) return cached.trim()

    const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
    if (!query || typeof query.readTitle !== 'function') return ''
    try {
      const snapshot = await query.readTitle(sessionId)
      return snapshot && typeof snapshot.title === 'string' ? snapshot.title.trim() : ''
    } catch {
      return ''
    }
  }

  /** 手写 sleep。宿主定时器服务未必注入，而且这里只需要一个短延迟。 */
  const delay = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
  })

  /**
   * 从表层事件里挑"结论那一条"：从后往前，第一条**未被中断**且有正文的
   * `assistant/message`。
   *
   * 为什么跳过 `interrupted: true`：那是回合被中途打断时落下的**残片**，
     * 文本往往是半句话，拿它当结论只会误导。
   *
   * 为什么不再"优先不含工具调用的那条"：一轮若以工具调用收尾（被打断、撞到上限），
     * 那条助手消息的正文确实是过场话；但更早的纯文本同样是过场话，而且更旧。
     * 与其替用户猜一个陈旧的结论，不如如实呈现"模型最后说了什么" —— 没有结论就是没有结论。
   *
   * @param {object[]} events 表层事件。
   * @returns {string} 结论文本；没有就空串。
   */
  const pickConclusion = (events) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!event || event.type !== 'assistant/message') continue
      if (event.interrupted === true) continue
      const content = Array.isArray(event.message?.content) ? event.message.content : []
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text.length > 0) return text
    }
    return ''
  }

  /**
   * 取模型这一轮输出的结论。
   *
   * `readSurface` 返回"当前模型表层"——按模型历史顺序排列的事件。
     *
   * 这里不是"读一次就完事"，而是**带重试地读到稳定为止**，因为有两个真实的失败模式：
   *
   * 1. **读早了**。`api-session/status` 在 agent 转 idle 时触发，而最后一条
   *    `assistant/message` 未必已经落进表层。这时候读到的是上一轮的中间文本 ——
     *    表现出来就是"弹窗内容不是模型的输出结论"。
   * 2. **读失败**。官方 README 明说 `readSurface` 要回放并校验整个日志，大历史可能好几秒；
     *    它不接受 `AbortSignal`，一旦卡住就只能靠超时。旧实现读失败时静默退到通用文案，
   *    用户看到的就是"模型跑完了一个任务"，而不是真正的结论。
     *
   * 策略：在宽限期内多读几遍，**取事件数最多的那一份** —— 后读到的包含更完整的历史，
   * 说明这一轮的收尾消息已经落表。不能用"最后一条是不是 assistant/message"来判断：
   * 中途快照同样以 assistant/message 结尾，两者分不开（这一点是测试逼出来的）。
     * 宽限期过后仍未拿到文本，就用手头最好的那份 —— 通知宁可带一份稍旧的结论，也不能不发。
     *
     * @param {string} sessionId 会话 id。
     * @returns {Promise<string>} 结论文本；取不到时空串。
     */
  const lastAssistantText = async (sessionId) => {
    const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
    if (!query || typeof query.readSurface !== 'function') return ''

    const TOTAL_MS = 4000      // 总预算：通知不该为读日志无限期等待
    const ATTEMPT_MS = 1200    // 单次尝试上限：卡住的 readSurface 不能拖死轮询
    const POLL_MS = 150
    const GRACE_MS = 900       // 宽限期：在这段时间内多读几遍，取"最新"的那份

    const deadline = Date.now() + TOTAL_MS
    const graceEnd = Date.now() + GRACE_MS
    let best = { text: '', size: -1 }

    while (Date.now() < deadline) {
      // 单次尝试也要有上限：否则一次永不返回的 readSurface 会把整个循环卡死。
      let attempt = null
      try {
        attempt = await Promise.race([
          query.readSurface(sessionId).catch(() => null),
          delay(ATTEMPT_MS).then(() => null),
        ])
      } catch {
        attempt = null
      }

      if (attempt) {
        const events = Array.isArray(attempt.events) ? attempt.events : []
        const text = pickConclusion(events)
        // 取"事件更多"的那一份：后读到的包含更完整的历史，说明这一轮的收尾消息
        // 已经落进表层。用"最后一条是不是 assistant/message"来判断是不够的 ——
        // 中途快照同样以 assistant/message 结尾，两者分不开。
        if (text.length > 0 && events.length > best.size) best = { text, size: events.length }
      }

      if (Date.now() >= graceEnd || Date.now() >= deadline) break
      await delay(POLL_MS)
    }

    return best.text
  }

  /** 压平空白并截断，给通知正文用。 */
  const summarize = (text, limit = 180) => {
    const flat = String(text || '').replace(/\s+/g, ' ').trim()
    if (flat.length <= limit) return flat
    return `${flat.slice(0, limit)}…`
  }

  mount(() => {
    const offStatus = ctx.on('api-session/status', (sessionId, isRunning) => {
      if (isRunning) {
        running.add(sessionId)
        return
      }
      // 只有"刚才确实在跑"才算跑完。启动时那批 running=false 不会误报。
      if (!running.delete(sessionId)) return
      if (!enabled) return

      seq += 1
      const event = {
        seq,
        sessionId,
        // 先占位，标题与正文在后台补齐后同一条事件再推一次。
        title: titles.get(sessionId) || '',
        body: '',
        // 先标 pending 就推：客户端立刻能亮红点，不必等系统通知发完。
        // PowerShell 兜底最坏要 4 秒，把它挡在事件前面会让提示明显迟滞。
        delivered: 'pending',
      }
      pending.push(event)
      while (pending.length > MAX_PENDING) pending.shift()
      broadcast(event)

      // 后台补齐标题与模型输出，再发通知；结果回填同一条事件后推第二次。
      // 客户端按 seq 认更新，所以同一 seq 出现两次是设计内的。
      void (async () => {
        const [title, body] = await Promise.all([
          titleOf(sessionId),
          lastAssistantText(sessionId),
        ])
        event.title = title
        event.body = summarize(body)

        // 标题是通知的第一行，正文是第二行 —— 也就是"哪个会话"+"模型说了什么"。
        // 两者都拿不到时才退回通用文案，绝不让通知变成空白。
        const heading = title || TITLE_DEFAULT
        const content = event.body || BODY_FALLBACK

        const how = await deliver(heading, content)
        event.delivered = how || 'failed'
        broadcast(event)
        if (!how) note(`toast failed for ${sessionId}`)
      })()
        .catch((error) => {
          event.delivered = 'failed'
          broadcast(event)
          note(`notify pipeline failed for ${sessionId}: ${String((error && error.message) || error)}`)
        })
    })

    // 标题缓存。拿不到就退回固定文案，不影响通知本身。
    const offAdded = ctx.on('api-session/added', (summary) => {
      if (!summary || typeof summary !== 'object') return
      const id = summary.id ?? summary.sessionId
      if (typeof id !== 'string' || id.length === 0) return
      if (typeof summary.title === 'string' && summary.title.length > 0) {
        titles.set(id, summary.title)
      }
    })

    return () => {
      offStatus()
      offAdded()
    }
  }, 'dsh-bell-notify: session watchers')

  /* ─────────────────────── 3. 路由 ─────────────────────── */

  /** 只接受同源发起的写请求。 */
  const isTrustedWrite = (req) => {
    const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
    if (site === 'cross-site') return false
    const method = String(req.method || 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') return true
    const origin = String((req.headers && req.headers.origin) || '')
    if (origin.length === 0) return true
    try {
      const host = String((req.headers && req.headers.host) || '')
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  /** 用原生 req/res 读 JSON 请求体（不引入任何依赖）。 */
  const readJsonBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
  })

  /** 发一段 JSON。 */
  const sendJson = (res, code, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /* ── 开关 ── */
  const stateHandler = async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase()
    try {
      if (!isTrustedWrite(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
        return
      }
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, { ok: true, enabled, seq })
        return
      }
      if (method !== 'PUT' && method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (typeof body.enabled === 'boolean') {
        const was = enabled
        enabled = body.enabled
        // 刚打开时把旧账清掉：不然重开一次铃铛会连弹昨天攒下的一串。
        if (enabled && !was) pending.length = 0
        note(`enabled = ${enabled}`)
      }
      sendJson(res, 200, { ok: true, enabled, seq })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
  }

  /* ── 补偿拉取 ── */
  const pendingHandler = async (req, res) => {
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const sinceRaw = Number(url.searchParams.get('since'))
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0
    // since 落在缓冲区之前（断线太久）就只给现有的，客户端按最大 seq 继续。
    const events = pending.filter((item) => item.seq > since)
    sendJson(res, 200, { ok: true, seq, events })
  }

  /* ── 手动测试 ── */
  const testHandler = async (req, res) => {
    if (String(req.method || 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      if (!isTrustedWrite(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
        return
      }
      const delivered = await deliver(TITLE_DEFAULT, BODY_TEST)
      note(`test toast: ${delivered || 'failed'}`)
      sendJson(res, 200, { ok: true, delivered })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
  }

  /* ── SSE 长连接 ── */
  const streamHandler = async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关掉 Nginx 一类反代对 SSE 的缓冲，否则事件会被攒住不发。
      'x-accel-buffering': 'no',
    })
    // 立刻回一段注释帧：让 EventSource 的 onopen 尽快触发，也顺便证明链路是通的。
    res.write(': connected\n\n')
    streams.add(res)

    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(timer)
        streams.delete(res)
      }
    }, HEARTBEAT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    const cleanup = () => {
      clearInterval(timer)
      streams.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  mount(() => {
    const fiber = ctx.inject(['webServer'], (child) => {
      const disposers = []
      const add = (route, handler, label) => {
        try {
          disposers.push(child.webServer.register({ kind: 'exact', path: route, handler }))
          note(`route registered: ${label} ${route}`)
        } catch (error) {
          // HMR 重入会抛 duplicate exact route；旧 handler 功能等价，记一笔就够。
          note(`route registration failed: ${label} ${route}: ${String((error && error.message) || error)}`)
        }
      }
      add(ROUTE_STATE, stateHandler, 'state')
      add(ROUTE_PENDING, pendingHandler, 'pending')
      add(ROUTE_STREAM, streamHandler, 'stream')
      add(ROUTE_TEST, testHandler, 'test')
      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* 已经卸掉就算了 */
          }
        }
        for (const res of streams) {
          try {
            res.end()
          } catch {
            /* 同上 */
          }
        }
        streams.clear()
      }
    })

    return () => {
      try {
        void fiber.dispose()
      } catch {
        /* 同上 */
      }
    }
  }, 'dsh-bell-notify: routes')
}

/** 通知标题。 */
const TITLE_DEFAULT = '任务完成'
/** 拿不到会话标题时的正文。 */
const BODY_FALLBACK = '模型跑完了一个任务'
/** 测试通知的正文。 */
const BODY_TEST = '这是一条测试通知 —— 铃铛工作正常'

export {
  BODY_FALLBACK,
  BODY_TEST,
  MAX_PENDING,
  ROUTE_PENDING,
  ROUTE_STATE,
  ROUTE_STREAM,
  ROUTE_TEST,
  TITLE_DEFAULT,
}