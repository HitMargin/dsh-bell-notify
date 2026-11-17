/**
 * dsh-bell-notify — 浏览器半边。
 *
 * 在侧栏底部（`sidebar.footer.action`，设置/账户旁边）挂一个铃铛。
 *
 * 分工很重要：**发通知是宿主的事**（走 Electron/WinRT，弹的是真正的 Windows
 * 系统通知，落在通知中心）。客户端只负责三件事：
 *
 * 1. 让用户开关它，并把状态同步给宿主；
 * 2. 显示红点，让人知道"刚才有东西跑完了"；
 * 3. **兜底**：宿主明确报告系统通知没发出去时（`delivered: null`，比如非
 *    Windows 环境或 WinRT 不可用），才由这里弹网页通知。
 *
 * 刻意的取舍：
 * - **用 SSE 而不是轮询**。窗口最小化时 Chromium 会把 `setInterval` 降频
 *   （后台 5 分钟后最慢到 1 次/分钟），而人恰恰是在离开窗口时才需要通知。
 *   SSE 由网络驱动，不受定时器节流影响。断线时 EventSource 自己重连。
 * - **重连可能漏事件**，所以挂载时和重新可见时各补拉一次。`since` 是宿主
 *   的单调递增序号，补拉幂等；客户端按 seq 去重。
 * - **开关存在 localStorage**，页面重载后自动 PUT 回宿主。宿主不持久化开关，
 *   两边不会打架。
 *
 * @module dsh-bell-notify/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-bell-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 必须等于 host 包名：模块表按包身份对账。 */
    const name = 'dsh-bell-notify'

    /** 必须与 index.js 里的路由常量一致。 */
    const ROUTE_STATE = '/plugins/dsh-bell/state'
    const ROUTE_PENDING = '/plugins/dsh-bell/pending'
    const ROUTE_STREAM = '/plugins/dsh-bell/stream'
    const ROUTE_TEST = '/plugins/dsh-bell/test'

    /** 语言域命名空间。 */
    const NS = 'dsh-bell-notify'

    const STORE_KEY = 'dsh-bell-notify:enabled'
    /** 红点停留多久后自动消失。 */
    const DOT_MS = 6000

    const DICT = {
      zh: {
        label: '任务完成提醒',
        onHint: '模型跑完任务时发 Windows 系统通知（点一下关闭）',
        offHint: '开启后，模型跑完任务时发 Windows 系统通知',
        notifyTitle: '任务完成',
        notifyBody: '模型跑完了一个任务',
        testing: '正在发测试通知',
      },
      en: {
        label: 'Task done alert',
        onHint: 'Show a Windows notification when the model finishes (click to turn off)',
        offHint: 'Show a Windows notification when the model finishes',
        notifyTitle: 'Task done',
        notifyBody: 'The model finished a task',
        testing: 'Sending a test notification',
      },
    }

    const CSS = `
.${NS}-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.${NS}-root:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.${NS}-root:active {
  background: var(--dsw-alias-interactive-bg-active, transparent);
}
.${NS}-root[data-on="true"] {
  color: var(--dsw-alias-brand-primary, currentColor);
}
.${NS}-icon {
  width: 15px;
  height: 15px;
  display: block;
}
.${NS}-slash {
  transition: opacity 120ms ease;
}
.${NS}-root[data-on="true"] .${NS}-slash {
  opacity: 0;
}
.${NS}-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary, #e5484d);
  pointer-events: none;
}
.${NS}-busy {
  animation: ${NS}-pulse 700ms ease-in-out infinite;
}
@keyframes ${NS}-busy {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .${NS}-root { transition: none; }
  .${NS}-busy { animation: none; }
}
`

    /** 挂样式表，返回卸载函数。 */
    function mountStyles() {
      const id = `${NS}-style`
      const previous = document.getElementById(id)
      if (previous && typeof previous.remove === 'function') previous.remove()
      const tag = document.createElement('style')
      tag.id = id
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (typeof tag.remove === 'function') tag.remove()
        else if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /** 读开关。localStorage 在隐私模式下会抛，一律按"关"处理。 */
    function readEnabled() {
      try {
        return window.localStorage.getItem(STORE_KEY) === '1'
      } catch {
        return false
      }
    }

    /** 写开关。 */
    function writeEnabled(value) {
      try {
        window.localStorage.setItem(STORE_KEY, value ? '1' : '0')
      } catch {
        /* 存不下就不存，本次会话内仍然生效 */
      }
    }

    /**
     * 兜底用的网页通知。只在宿主报告"系统通知没发出去"时调用。
     *
     * @param {string} body 正文。
     */
    function fallbackNotify(body) {
      if (typeof window.Notification === 'undefined') return
      if (window.Notification.permission !== 'granted') return
      try {
        new window.Notification(body, { body, tag: 'dsh-bell-notify' })
      } catch {
        /* 弹不出来就算了，红点还在 */
      }
    }

    /**
     * 铃铛本体。
     *
     * @param {(key: string) => string} t 语言域绑定。
     * @returns {object} React 组件。
     */
    function makeControl(t) {
      return function BellControl() {
        const [on, setOn] = React.useState(readEnabled)
        const [dot, setDot] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        /** 已处理过的最大 seq，用来去重（SSE 与补拉可能重叠）。 */
        const lastSeq = React.useRef(0)
        const sourceRef = React.useRef(null)
        const onRef = React.useRef(on)
        onRef.current = on
        const dotTimer = React.useRef(null)

        const flashDot = React.useCallback(() => {
          setDot(true)
          if (dotTimer.current) clearTimeout(dotTimer.current)
          dotTimer.current = setTimeout(() => setDot(false), DOT_MS)
        }, [])

        /* ── 收到事件 ── */
        const accept = React.useCallback((events) => {
          if (!Array.isArray(events) || events.length === 0) return
          for (const item of events) {
            if (!item || typeof item.seq !== 'number') continue
            // 兜底通知的正文：模型输出优先，标题只是"哪个会话"而非"说了什么"。
            const body = typeof item.body === 'string' && item.body.trim().length > 0
              ? item.body.trim()
              : (typeof item.title === 'string' && item.title.trim().length > 0
                ? item.title.trim()
                : t('notifyBody'))

            if (item.seq > lastSeq.current) {
              lastSeq.current = item.seq
              flashDot()
              // delivered 由宿主给：'pending' 时系统通知还在发，等后续同 seq 的更新帧。
              if (item.delivered === 'failed') fallbackNotify(body)
            } else if (item.seq === lastSeq.current) {
              // 同一 seq 的后续帧：只是补发通知通道的结果，不重复亮点。
              if (item.delivered === 'failed') fallbackNotify(body)
            }
          }
        }, [flashDot, t])

        /* ── 补拉一次（挂载时、重新可见时） ── */
        const catchUp = React.useCallback(async () => {
          if (!onRef.current) return
          try {
            const res = await fetch(`${ROUTE_PENDING}?since=${lastSeq.current}`, { cache: 'no-store' })
            if (!res.ok) return
            const data = await res.json()
            if (data && data.ok) accept(data.events)
          } catch {
            /* 拉不到就算了，SSE 还在推 */
          }
        }, [accept])

        /* ── 同步开关给宿主 ── */
        const pushState = React.useCallback(async (value) => {
          try {
            await fetch(ROUTE_STATE, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: value }),
            })
          } catch {
            /* 宿主没起路由时静默：铃铛本身仍可用，只是宿主不会记录事件 */
          }
        }, [])

        /* ── 挂载：同步开关 + 建 SSE + 补拉 ── */
        React.useEffect(() => {
          void pushState(onRef.current)

          // SSE：宿主主动推。EventSource 断线会自己重连，不用手动重试。
          if (typeof window.EventSource === 'function') {
            try {
              const es = new window.EventSource(ROUTE_STREAM)
              sourceRef.current = es
              es.addEventListener('message', (event) => {
                if (!onRef.current) return
                try {
                  accept([JSON.parse(event.data)])
                } catch {
                  /* 半截帧直接丢 */
                }
              })
            } catch {
              /* 没有 EventSource 就只剩补拉 */
            }
          }

          void catchUp()

          const onVisible = () => {
            if (document.visibilityState === 'visible') void catchUp()
          }
          document.addEventListener('visibilitychange', onVisible)

          return () => {
            document.removeEventListener('visibilitychange', onVisible)
            if (dotTimer.current) clearTimeout(dotTimer.current)
            const es = sourceRef.current
            sourceRef.current = null
            if (es && typeof es.close === 'function') es.close()
          }
        }, [accept, catchUp, pushState])

        /* ── 点击 ── */
        const onClick = React.useCallback(async () => {
          const next = !onRef.current
          setOn(next)
          writeEnabled(next)
          void pushState(next)
          if (!next) return

          // 刚打开：清掉去重游标补拉一次，再发一条测试通知。
          // 测试通知是这条链路唯一的"眼见为实"—— 用户点完立刻知道行不行。
          lastSeq.current = 0
          void catchUp()

          setBusy(true)
          try {
            await fetch(ROUTE_TEST, { method: 'POST' })
          } catch {
            /* 测试发不出去不影响开关本身 */
          } finally {
            setTimeout(() => setBusy(false), 400)
          }
        }, [catchUp, pushState])

        const hint = on ? t('onHint') : t('offHint')

        return h('button', {
          type: 'button',
          className: `${NS}-root`,
          'data-on': on ? 'true' : 'false',
          'data-bell-owned': 'true',
          'aria-pressed': on,
          'aria-label': t('label'),
          title: busy ? t('testing') : hint,
          onClick,
        },
          h('svg', {
            className: `${NS}-icon${busy ? ` ${NS}-busy` : ''}`,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.7',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'aria-hidden': 'true',
          },
            h('path', { d: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9' }),
            h('path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }),
            h('path', { className: `${NS}-slash`, d: 'M3 3l18 18', 'stroke-width': '1.6' }),
          ),
          dot ? h('span', { className: `${NS}-dot` }) : null,
        )
      }
    }

    return {
      name,
      inject: ['slots', 'locale'],

      /**
       * 客户端插件入口。
       *
       * @param {object} ctx 浏览器侧 cordis 上下文。
       */
      apply(ctx) {
        // HMR 会重跑 apply 而不先卸载旧实例：先拆掉上一份，避免 slot 重复注册。
        try {
          if (typeof window.__BELL_NOTIFY_DISPOSE__ === 'function') window.__BELL_NOTIFY_DISPOSE__()
        } catch {
          /* 旧实例已经烂了也不影响新实例 */
        }

        const disposers = []
        const own = (fn, label) => {
          const dispose = ctx.effect(fn, label)
          disposers.push(typeof dispose === 'function' ? dispose : () => {})
        }
        window.__BELL_NOTIFY_DISPOSE__ = () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              /* 逐个拆，坏一个不影响其余 */
            }
          }
        }

        own(() => ctx.locale.register(NS, DICT), `${NS}: dictionaries`)
        const t = ctx.locale.bind(NS)
        own(() => mountStyles(), `${NS}: styles`)
        // 侧栏底部动作槽：设置/账户旁边。
        own(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: NS,
          order: 10,
          label: () => t('label'),
        }, makeControl(t))), `${NS}: footer bell`)
      },
    }
  },
})