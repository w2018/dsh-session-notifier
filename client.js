/**
 * dsh-session-notifier —— Client 半身（浏览器 bundle）
 *
 * 落点：
 *   1. shell.overlay —— 页内提示条（系统通知失败/被拒时的兜底，也用来做「无声」模式）
 *   2. settings.section —— 设置页里的「会话提醒」分区
 *
 * 模块 id 必须与 package.json 的 name 逐字一致：DSH 客户端模块加载器按 row.id
 * 取 bundle。
 *
 * 为什么不在这里直接监听会话事件：浏览器侧拿不到 Host 的 agent/status 等事件，
 * 只能通过 /api/session-notifier/state 拉。Host 侧已经把「需要人」的节点筛好了。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-notifier',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const PLUGIN_ID = 'dsh-session-notifier'
    const SLOT_OVERLAY = 'shell.overlay'
    const SLOT_SETTINGS = 'settings.section'
    const API = '/api/session-notifier'
    /** 与 index.js 的 BACKEND_VERSION 对齐：不一致说明后端还是旧代码，得重启一次。 */
    const EXPECTED_BACKEND_VERSION = 1
    const POLL_MS = 2000

    const NODE_LABELS = {
      turnComplete: '一轮任务跑完',
      approval: '等你点允许（授权）',
      question: '弹窗提问等你回答',
      auth: '需要登录 / 重新授权',
      error: '任务出错',
      subagent: '子任务结束',
    }

    const KIND_TO_NODE = {
      turn: 'turnComplete',
      approval: 'approval',
      question: 'question',
      auth: 'auth',
      error: 'error',
      subagent: 'subagent',
    }

    const KIND_TEXT = {
      turn: '任务完成',
      approval: '等待授权',
      question: '等你回答',
      auth: '需要登录',
      error: '出错了',
      subagent: '子任务结束',
    }

    // ── 样式 ────────────────────────────────────────────────────────
    // 必须带 data-plugin 归属标记：DSH 的 claimStyles 靠它认领/卸载样式。
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]')) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PLUGIN_ID)
      style.textContent = [
        '.sn-toasts { position: fixed; right: 18px; bottom: 18px; display: flex; flex-direction: column; gap: 10px; z-index: 60; pointer-events: none; }',
        '.sn-toast { pointer-events: auto; display: flex; flex-direction: column; gap: 4px; width: 300px; padding: 11px 13px; border-radius: 11px; background: rgba(28,30,36,0.96); color: #f2f3f5; box-shadow: 0 10px 30px rgba(0,0,0,0.34); border: 1px solid rgba(255,255,255,0.1); font-size: 12.5px; line-height: 1.5; cursor: pointer; animation: sn-in 160ms ease-out; }',
        '@keyframes sn-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }',
        '.sn-toast[data-kind="approval"], .sn-toast[data-kind="question"] { border-color: rgba(255,180,60,0.5); }',
        '.sn-toast[data-kind="error"] { border-color: rgba(255,90,90,0.55); }',
        '.sn-toast[data-kind="auth"] { border-color: rgba(120,160,255,0.55); }',
        '.sn-toast-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; opacity: .78; }',
        '.sn-toast-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .85; }',
        '.sn-toast-title { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.sn-toast-detail { opacity: .82; word-break: break-word; }',
        '.sn-toast-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; opacity: .55; margin-top: 2px; }',
        '.sn-root { display: flex; flex-direction: column; gap: 18px; font-size: 13px; max-width: 860px; }',
        '.sn-head { display: flex; flex-direction: column; gap: 4px; }',
        '.sn-title { font-size: 16px; font-weight: 600; }',
        '.sn-sub { font-size: 12px; opacity: .6; line-height: 1.6; }',
        '.sn-card { border: 1px solid rgba(127,127,127,0.22); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }',
        '.sn-card-title { font-size: 13px; font-weight: 600; opacity: .9; }',
        '.sn-row { display: grid; grid-template-columns: 210px 1fr; gap: 8px 14px; align-items: center; }',
        '.sn-label { font-size: 12.5px; opacity: .82; }',
        '.sn-hint { font-size: 11.5px; opacity: .55; line-height: 1.55; }',
        '.sn-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12.5px; }',
        '.sn-switch input { width: 15px; height: 15px; accent-color: #4084ff; cursor: pointer; }',
        '.sn-input, .sn-select { height: 30px; padding: 0 8px; box-sizing: border-box; border-radius: 8px; font: inherit; font-size: 12.5px; color: inherit; background: rgba(127,127,127,0.06); border: 1px solid rgba(127,127,127,0.28); }',
        '.sn-input:focus, .sn-select:focus { outline: none; border-color: rgba(127,127,127,0.55); }',
        '.sn-input[type="time"] { width: 108px; }',
        '.sn-range { width: 190px; accent-color: #4084ff; cursor: pointer; }',
        '.sn-range:disabled { opacity: .45; cursor: default; }',
        '.sn-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
        '.sn-btn { height: 28px; padding: 0 12px; border-radius: 8px; font-size: 12.5px; cursor: pointer; border: 1px solid rgba(127,127,127,0.4); background: transparent; color: inherit; }',
        '.sn-btn:hover:not(:disabled) { background: rgba(127,127,127,0.1); }',
        '.sn-btn:disabled { opacity: .45; cursor: default; }',
        '.sn-btn[data-variant="primary"] { border-color: transparent; background: rgba(64,132,255,0.9); color: #fff; }',
        '.sn-btn[data-variant="primary"]:hover:not(:disabled) { background: rgba(64,132,255,1); }',
        '.sn-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 5px; font-size: 11px; line-height: 1; background: rgba(127,127,127,0.16); font-weight: 400; }',
        '.sn-badge[data-kind="ok"] { color: #2e7d32; background: rgba(46,125,50,0.14); }',
        '.sn-badge[data-kind="off"] { color: #c62828; background: rgba(198,40,40,0.14); }',
        '.sn-badge[data-kind="warn"] { color: #c77c00; background: rgba(199,124,0,0.14); }',
        '.sn-err { font-size: 12px; color: #d9534f; }',
      ].join('\n')
      document.head.appendChild(style)
    }

    // ── HTTP ────────────────────────────────────────────────────────
    async function api(pathname, options) {
      const res = await fetch(API + pathname, options)
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        throw new Error('返回的不是 JSON：' + text.slice(0, 120))
      }
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || '请求失败（HTTP ' + res.status + '）')
      }
      return data
    }

    function postJson(pathname, body) {
      return api(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    // ── 免打扰判定 ──────────────────────────────────────────────────
    function parseClock(value) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
      if (!m) return null
      const hours = Number(m[1])
      const minutes = Number(m[2])
      if (hours > 23 || minutes > 59) return null
      return hours * 60 + minutes
    }

    function inQuietHours(quiet, now) {
      if (!quiet || quiet.enabled !== true) return false
      const start = parseClock(quiet.start)
      const end = parseClock(quiet.end)
      if (start === null || end === null) return false
      const d = now || new Date()
      const minutes = d.getHours() * 60 + d.getMinutes()
      if (start === end) return false
      // 跨零点：23:00 → 08:00 这种区间 start > end。
      return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
    }

    // ── 提示音 ──────────────────────────────────────────────────────
    // 用包内 assets/mambo.wav（Host 通过 /sound 端点回二进制）。不用
    // Notification 自带的 silent:false 音效：那是浏览器/系统的默认提示音，
    // 换不成我们自己的，而且各平台行为不一致。
    const SOUND_URL = API + '/sound'
    let soundEl = null
    let unlocked = false

    /** 复用同一个 <audio>：连续提醒不会叠加成一片噪音，也不会攒一堆解码器。 */
    function ensureSoundEl() {
      if (!soundEl) {
        soundEl = new window.Audio(SOUND_URL)
        soundEl.preload = 'auto'
      }
      return soundEl
    }

    /**
     * 浏览器默认禁止无手势的自动播放。提醒往往是在用户没碰页面时触发的，
     * 首次 play() 会被拒（NotAllowedError），于是「第一次提醒没声音」。
     * 所以在第一次真实手势里静音播一下再暂停，把这个元素解锁；
     * 之后哪怕页面在后台，也能照常出声。
     */
    function unlockSound() {
      if (unlocked || typeof window === 'undefined' || typeof window.Audio !== 'function') return
      unlocked = true
      try {
        const el = ensureSoundEl()
        const prev = el.volume
        el.volume = 0
        const played = el.play()
        const settle = () => {
          try {
            el.pause()
            el.currentTime = 0
          } catch {
            /* 忽略 */
          }
          el.volume = prev
        }
        if (played && typeof played.then === 'function') played.then(settle, () => { unlocked = false })
        else settle()
      } catch {
        unlocked = false
      }
    }

    function playSound(volume) {
      try {
        if (typeof window === 'undefined' || typeof window.Audio !== 'function') return
        const el = ensureSoundEl()
        el.volume = typeof volume === 'number' && volume >= 0 && volume <= 1 ? volume : 0.8
        el.currentTime = 0
        const played = el.play()
        if (played && typeof played.catch === 'function') {
          // 被自动播放策略拦下：等用户下次动一下页面再解锁。
          played.catch(() => {
            unlocked = false
          })
        }
      } catch {
        /* 音频不可用就算了，声音是锦上添花 */
      }
    }

    // ── 系统通知 ────────────────────────────────────────────────────
    function notificationState() {
      if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
      return window.Notification.permission // granted | denied | default
    }

    /**
     * @param {object} notice 队列里的一条提醒
     * @param {Function} onClick 点击后回到会话
     *
     * 系统通知一律 silent: true，音效完全由插件自己放 mambo.wav。
     * 不这么做就会响两声：一声系统的默认音、一声我们的；而且系统的那个
     * 换不掉、各平台行为还不一致，「关掉音效」这个开关也就名不副实了。
     */
    function showSystemNotification(notice, onClick) {
      if (notificationState() !== 'granted') return false
      try {
        const title = (KIND_TEXT[notice.kind] || '会话提醒') + ' · ' + (notice.title || '会话')
        const body = [notice.detail || '', notice.workspace ? '工作区：' + notice.workspace : '']
          .filter(Boolean)
          .join('\n')
        const n = new window.Notification(title, {
          body,
          tag: 'dsh-session-notifier-' + notice.kind + '-' + (notice.sessionId || 'global'),
          renotify: true,
          silent: true,
        })
        // 点击后的落点交给 activateNotice（选中该会话）；这里不再自己 focus，
        // 否则会和它重复，且容易让人以为 focus 就是「回来」的全部。
        n.onclick = () => {
          if (typeof onClick === 'function') onClick()
          n.close()
        }
        setTimeout(() => {
          try {
            n.close()
          } catch {
            /* 已关闭 */
          }
        }, 12000)
        return true
      } catch {
        return false
      }
    }

    // ── 点通知 / 点提示条 → 回到对应会话 ───────────────────────────
    /**
     * 决定「点这一条该打开什么」。纯函数，方便单测覆盖优先级。
     *
     * 有 SessionId 就按 SessionId 打开，同时把它的 SubagentAddress 一起带出去：
     * 子会话按 SessionId 打开可能被宿主拒掉，returnToApp 会拿这个地址兜底。
     */
    function pickOpenTarget(services, notice) {
      const sessionId = notice && notice.sessionId ? String(notice.sessionId) : ''
      const workspace = services && services.uiWorkspace
      const canOpen = Boolean(workspace && typeof workspace.openSession === 'function')
      if (!canOpen || !sessionId) return { kind: 'none', sessionId, subagentAddress: null }

      const sessions = services && services.sessions
      let subagentAddress = null
      if (sessions && typeof sessions.subagentAddress === 'function') {
        try {
          subagentAddress = sessions.subagentAddress(sessionId) || null
        } catch {
          subagentAddress = null
        }
      }

      return { kind: 'session', sessionId, subagentAddress }
    }

    /**
     * 「返回应用界面」的落地方式必须是「选中那个会话」，而不是只 window.focus()：
     * 浏览器在后台标签页/被其他窗口遮挡时，focus() 往往被策略忽略，或者只把窗口
     * 提到前面却停在别的会话上，用户回来还得自己找。
     *
     * uiWorkspace.openSession 正是宿主自己「选中会话并展示对话」的动作。
     */
    function returnToApp(ctx, notice) {
      const services = {
        uiWorkspace: ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null,
        sessions: ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null,
      }
      const target = pickOpenTarget(services, notice)
      let opened = false
      const workspace = services.uiWorkspace

      if (target.kind === 'session') {
        try {
          workspace.openSession(target.sessionId)
          opened = true
        } catch {
          opened = false
        }
      }
      // 子会话：直接给 SessionId 打不开时，换成它的 SubagentAddress 再试一次。
      if (!opened && target.subagentAddress && workspace) {
        try {
          workspace.openSession(target.subagentAddress)
          opened = true
        } catch {
          /* 打不开就只聚焦窗口 */
        }
      }

      try {
        window.focus()
      } catch {
        /* 部分环境不允许脚本聚焦 */
      }

      badge.reset()
      return opened
    }

    /** 提示条和系统通知共用同一个「点我回哪儿去」的实现，由 apply() 注入 ctx。 */
    let activateNotice = () => {}


    const badge = {
      count: 0,
      base: null,
      sync() {
        if (typeof document === 'undefined') return
        if (this.base === null) this.base = document.title || ''
        if (this.count > 0) {
          const stripped = (this.base || '').replace(/^\(\d+\)\s*/, '')
          document.title = '(' + this.count + ') ' + stripped
        } else {
          document.title = (this.base || '').replace(/^\(\d+\)\s*/, '')
        }
      },
      bump() {
        this.count += 1
        this.sync()
      },
      reset() {
        this.count = 0
        this.sync()
      },
    }

    // ── 页内提示条 ──────────────────────────────────────────────────
    function ToastStack() {
      const [items, setItems] = useState([])
      const timers = useRef(new Map())

      const remove = useCallback((id) => {
        setItems((list) => list.filter((item) => item.id !== id))
        const timer = timers.current.get(id)
        if (timer) {
          clearTimeout(timer)
          timers.current.delete(id)
        }
      }, [])

      useEffect(() => {
        const onPush = (event) => {
          const detail = (event && event.detail) || {}
          const id = 'sn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
          const seconds = Number(detail.seconds) > 0 ? Number(detail.seconds) : 8
          setItems((list) => list.concat([Object.assign({}, detail, { id })]).slice(-3))
          const timer = setTimeout(() => remove(id), seconds * 1000)
          timers.current.set(id, timer)
        }
        window.addEventListener('dsh-session-notifier:toast', onPush)
        return () => {
          window.removeEventListener('dsh-session-notifier:toast', onPush)
          for (const timer of timers.current.values()) clearTimeout(timer)
          timers.current.clear()
        }
      }, [remove])

      if (!items.length) return null

      return h(
        'div',
        { className: 'sn-toasts' },
        items.map((item) =>
          h(
            'div',
            {
              key: item.id,
              className: 'sn-toast',
              'data-kind': item.kind || 'turn',
              onClick: () => {
                activateNotice(item)
                remove(item.id)
              },
            },
            h(
              'div',
              { className: 'sn-toast-head' },
              h('span', { className: 'sn-toast-dot' }),
              h('span', null, KIND_TEXT[item.kind] || '提醒'),
              item.workspace ? h('span', null, '· ' + item.workspace) : null,
            ),
            h('div', { className: 'sn-toast-title' }, item.title || '会话'),
            item.detail ? h('div', { className: 'sn-toast-detail' }, item.detail) : null,
            h('div', { className: 'sn-toast-foot' }, h('span', null, item.sessionId ? '点击回到这个会话' : '点击关闭')),
          ),
        ),
      )
    }

    function emitToast(payload) {
      if (typeof window === 'undefined') return
      window.dispatchEvent(new window.CustomEvent('dsh-session-notifier:toast', { detail: payload }))
    }

    /** 这个模式下，本次提醒是否该走系统通知。 */
    function wantsSystem(mode, background) {
      const strategy = mode === 'always' || mode === 'never' ? mode : 'smart'
      return strategy === 'always' || (strategy === 'smart' && background === true)
    }

    /**
     * 一次提醒到底走哪几路。纯函数，单测直接覆盖。
     *
     * 判断只依赖一个事实：系统通知到底发出去没有（systemShown）。
     * 「该不该走系统通知」是 wantsSystem 的事，在调用方那一步就定好了，
     * 这里再判一次只会让两处条件各自漂移。
     *
     * - 发出去了 → 只算系统通知这一路：不弹页内条（否则等于提醒两遍），并响音效。
     * - 没发出去 → 退回页内提示条兜底；页内条就摆在眼前，不发声。
     *
     * 音效只跟系统通知走是用户拍板的规矩：应用内通知不播放音效。
     */
    function planDelivery(mode, background, systemShown) {
      if (systemShown === true) return { toast: false, sound: true }
      return { toast: true, sound: false }
    }

    // ── 轮询 + 展示决策 ─────────────────────────────────────────────
    function startWatcher(ctx) {
      let cursor = 0
      let stopped = false
      let timer = null
      let settings = null
      let permissionAsked = false

      // 首次拉只对齐 cursor：刷新页面不该把队列里积压的旧提醒重放一遍。
      let firstPull = true

      async function pull() {
        if (stopped) return
        try {
          const data = await api('/state?since=' + cursor)
          settings = data.settings || settings
          const items = Array.isArray(data.items) ? data.items : []
          // 先推进 cursor 再展示：万一展示逻辑抛异常，也不会把同一条无限重放。
          const nextCursor = Number(data.cursor)
          if (Number.isFinite(nextCursor)) cursor = nextCursor
          if (firstPull) {
            firstPull = false
            return
          }
          for (const notice of items) handleNotice(notice, settings)
        } catch {
          /* 后端还没起来/重启中：静默重试 */
        }
      }

      function handleNotice(notice, cfg) {
        if (!notice || !cfg) return
        if (cfg.enabled === false) return
        const node = KIND_TO_NODE[notice.kind]
        if (node && cfg.nodes && cfg.nodes[node] === false) return
        if (inQuietHours(cfg.quietHours)) return

        const background =
          typeof document !== 'undefined' &&
          (document.hidden === true || (typeof document.hasFocus === 'function' && !document.hasFocus()))

        const mode = cfg.foreground || 'smart'

        let shownSystem = false
        if (wantsSystem(mode, background)) {
          shownSystem = showSystemNotification(notice, () => activateNotice(notice))
        }

        const plan = planDelivery(mode, background, shownSystem)
        // 声音只跟系统通知走：页内提示条不发声（用户拍板）。
        if (plan.sound && cfg.sound !== false) playSound(cfg.soundVolume)
        if (plan.toast) {
          emitToast({
            kind: notice.kind,
            sessionId: notice.sessionId,
            title: notice.title,
            detail: notice.detail,
            workspace: notice.workspace,
            seconds: Number(cfg.toastSeconds) || 8,
          })
        }

        if (cfg.titleBadge && background) badge.bump()

        // 权限还是 default 时顺手问一次：用户点了允许，后续就有真系统通知了。
        if (!permissionAsked && notificationState() === 'default') {
          permissionAsked = true
          try {
            const result = window.Notification.requestPermission()
            if (result && typeof result.then === 'function') result.catch(() => {})
          } catch {
            /* 无手势时可能被拒，忽略 */
          }
        }
      }

      const onFocus = () => badge.reset()
      const onGesture = () => unlockSound()
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', onFocus)
        // 捕获阶段挂一次性的手势监听：用户在页面里点一下/敲一下就把音频解锁，
        // 之后后台来的提醒才响得出来。
        window.addEventListener('pointerdown', onGesture, { capture: true, passive: true })
        window.addEventListener('keydown', onGesture, { capture: true, passive: true })
      }

      pull()
      timer = setInterval(pull, POLL_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()

      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            stopped = true
            if (timer) clearInterval(timer)
            if (typeof window !== 'undefined') {
              window.removeEventListener('focus', onFocus)
              window.removeEventListener('pointerdown', onGesture, { capture: true })
              window.removeEventListener('keydown', onGesture, { capture: true })
            }
          },
          'session-notifier: poller',
        )
      }
    }

    // ── 设置页 ──────────────────────────────────────────────────────
    function SettingsPage() {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const [permission, setPermission] = useState(notificationState())

      const load = useCallback(() => {
        setError('')
        api('/settings')
          .then((res) => {
            setData(res)
            setDraft(res.settings)
            if (res.backend !== EXPECTED_BACKEND_VERSION) {
              setError('后端版本是 v' + res.backend + '，界面期望 v' + EXPECTED_BACKEND_VERSION + '：请重启一次 DSH。')
            }
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
      }, [])

      useEffect(load, [load])

      const patch = useCallback((next) => {
        setDraft((current) => Object.assign({}, current, next))
      }, [])

      const patchNode = useCallback((node, value) => {
        setDraft((current) => Object.assign({}, current, { nodes: Object.assign({}, current.nodes, { [node]: value }) }))
      }, [])

      const patchQuiet = useCallback((next) => {
        setDraft((current) =>
          Object.assign({}, current, { quietHours: Object.assign({}, current.quietHours, next) }),
        )
      }, [])

      const save = useCallback(() => {
        if (!draft) return
        setBusy(true)
        setError('')
        setNote('')
        postJson('/settings', { settings: draft })
          .then((res) => {
            setData((current) => Object.assign({}, current, res))
            setDraft(res.settings)
            setNote('已保存，立即生效')
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
          .finally(() => setBusy(false))
      }, [draft])

      const reset = useCallback(() => {
        setBusy(true)
        setError('')
        setNote('')
        postJson('/settings/reset', {})
          .then((res) => {
            setData((current) => Object.assign({}, current, res))
            setDraft(res.settings)
            setNote('已恢复默认')
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
          .finally(() => setBusy(false))
      }, [])

      const sendTest = useCallback(() => {
        setError('')
        postJson('/test', {})
          .then(() => setNote('测试提醒已入队，2 秒内出现'))
          .catch((err) => setError(String(err && err.message ? err.message : err)))
      }, [])

      const askPermission = useCallback(() => {
        if (!('Notification' in window)) {
          setPermission('unsupported')
          return
        }
        try {
          const result = window.Notification.requestPermission()
          if (result && typeof result.then === 'function') {
            result.then((value) => setPermission(value)).catch(() => setPermission(notificationState()))
          } else {
            setPermission(notificationState())
          }
        } catch {
          setPermission(notificationState())
        }
      }, [])

      if (!draft) {
        return h(
          'div',
          { className: 'sn-root' },
          h('div', { className: 'sn-head' }, h('div', { className: 'sn-title' }, '会话提醒')),
          error ? h('div', { className: 'sn-err' }, error) : h('div', { className: 'sn-sub' }, '正在读取设置…'),
        )
      }

      const permissionText =
        permission === 'granted'
          ? '已允许，会弹真正的系统通知'
          : permission === 'denied'
            ? '已被浏览器拒绝，只能用页内提示条（在地址栏的站点设置里可以改回来）'
            : permission === 'unsupported'
              ? '当前环境（非安全上下文或无通知支持）不支持系统通知，只能用页内提示条'
              : '还没授权，点右边的按钮申请'

      return h(
        'div',
        { className: 'sn-root' },
        h(
          'div',
          { className: 'sn-head' },
          h('div', { className: 'sn-title' }, '会话提醒'),
          h(
            'div',
            { className: 'sn-sub' },
            '会话在后台跑完、等你点允许、弹窗问你问题时，用系统通知 + 页内提示条提醒你。',
            '设置保存在 ', h('code', null, '$DSH_HOME/storages/session-notifier/settings.json'), '，保存即生效。',
          ),
        ),

        error ? h('div', { className: 'sn-err' }, error) : null,

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '总开关'),
          h(
            'label',
            { className: 'sn-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled !== false,
              onChange: (e) => patch({ enabled: e.target.checked }),
            }),
            '启用会话提醒',
          ),
          h('div', { className: 'sn-hint' }, '关掉后 Host 不再收集提醒，页面也不再弹任何东西。'),
        ),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '提醒哪些节点'),
          Object.keys(NODE_LABELS).map((node) =>
            h(
              'label',
              { key: node, className: 'sn-switch' },
              h('input', {
                type: 'checkbox',
                checked: draft.nodes && draft.nodes[node] !== false,
                onChange: (e) => patchNode(node, e.target.checked),
              }),
              NODE_LABELS[node],
            ),
          ),
          h(
            'div',
            { className: 'sn-hint' },
            '「子任务结束」默认关：一次长任务可能带几十个子任务，全弹会很吵。',
          ),
        ),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '弹在哪'),
          h(
            'div',
            { className: 'sn-row' },
            h('span', { className: 'sn-label' }, '前台策略'),
            h(
              'select',
              {
                className: 'sn-select',
                value: draft.foreground || 'smart',
                onChange: (e) => patch({ foreground: e.target.value }),
              },
              h('option', { value: 'smart' }, 'smart —— 窗口在后台才弹系统通知（推荐）'),
              h('option', { value: 'always' }, 'always —— 始终只弹系统通知'),
              h('option', { value: 'never' }, 'never —— 只弹页内提示条'),
            ),
            h(
              'div',
              { className: 'sn-hint' },
              '三种模式互斥：走系统通知时不再弹页内提示条；只有系统通知发不出去（未授权或浏览器不支持）时才退回页内提示条兜住。',
            ),
          ),
          h(
            'div',
            { className: 'sn-inline' },
            h(
              'button',
              { className: 'sn-btn', type: 'button', disabled: busy, onClick: askPermission },
              '申请系统通知权限',
            ),
            h(
              'span',
              { className: 'sn-badge', 'data-kind': permission === 'granted' ? 'ok' : permission === 'denied' ? 'off' : 'warn' },
              permission,
            ),
            h('span', { className: 'sn-hint' }, permissionText),
          ),
        ),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '声音 / 未读计数 / 停留时长'),
          h(
            'label',
            { className: 'sn-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.sound !== false,
              onChange: (e) => patch({ sound: e.target.checked }),
            }),
            '弹系统通知时播放音效',
          ),
          h(
            'div',
            { className: 'sn-row' },
            h('span', { className: 'sn-label' }, '音量'),
            h('input', {
              className: 'sn-range',
              type: 'range',
              min: 0,
              max: 1,
              step: 0.05,
              value: draft.soundVolume === undefined ? 0.8 : draft.soundVolume,
              disabled: draft.sound === false,
              onChange: (e) => patch({ soundVolume: Number(e.target.value) }),
            }),
            h('div', { className: 'sn-hint' }, '音效为内置「曼波」；页内提示条不发声。'),
          ),
          h(
            'div',
            { className: 'sn-inline' },
            h(
              'button',
              { className: 'sn-btn', type: 'button', onClick: () => playSound(draft.soundVolume) },
              '试听',
            ),
            h('span', { className: 'sn-hint' }, '只在这个设置页播放，不影响提醒。'),
          ),
          h(
            'label',
            { className: 'sn-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.titleBadge !== false,
              onChange: (e) => patch({ titleBadge: e.target.checked }),
            }),
            '标签页标题显示未读条数',
          ),
          h(
            'div',
            { className: 'sn-row' },
            h('span', { className: 'sn-label' }, '提示条停留'),
            h('input', {
              className: 'sn-input',
              type: 'number',
              min: 2,
              max: 60,
              value: draft.toastSeconds,
              style: { width: '96px' },
              onChange: (e) => patch({ toastSeconds: Number(e.target.value) }),
            }),
            h('div', { className: 'sn-hint' }, '单位秒，2–60。'),
          ),
        ),

        h(
          'div',
          { className: 'sn-card' },
          h('div', { className: 'sn-card-title' }, '免打扰时段'),
          h(
            'label',
            { className: 'sn-switch' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(draft.quietHours && draft.quietHours.enabled),
              onChange: (e) => patchQuiet({ enabled: e.target.checked }),
            }),
            '在这段时间内不提醒',
          ),
          h(
            'div',
            { className: 'sn-inline' },
            h('input', {
              className: 'sn-input',
              type: 'time',
              value: (draft.quietHours && draft.quietHours.start) || '23:00',
              onChange: (e) => patchQuiet({ start: e.target.value }),
            }),
            h('span', { className: 'sn-hint' }, '到'),
            h('input', {
              className: 'sn-input',
              type: 'time',
              value: (draft.quietHours && draft.quietHours.end) || '08:00',
              onChange: (e) => patchQuiet({ end: e.target.value }),
            }),
            h('span', { className: 'sn-hint' }, '（跨零点，比如 23:00 到 08:00，直接这么填）'),
          ),
        ),

        h(
          'div',
          { className: 'sn-inline' },
          h(
            'button',
            { className: 'sn-btn', type: 'button', 'data-variant': 'primary', disabled: busy, onClick: save },
            busy ? '保存中…' : '保存',
          ),
          h('button', { className: 'sn-btn', type: 'button', disabled: busy, onClick: reset }, '恢复默认'),
          h('button', { className: 'sn-btn', type: 'button', disabled: busy, onClick: sendTest }, '发一条测试提醒'),
          h('button', { className: 'sn-btn', type: 'button', disabled: busy, onClick: load }, '重新读取'),
          note ? h('span', { className: 'sn-hint' }, note) : null,
        ),

        data && data.overrides && Object.keys(data.overrides).length
          ? h('div', { className: 'sn-hint' }, '当前有 ' + Object.keys(data.overrides).length + ' 项自定义值（其余用插件默认）。')
          : h('div', { className: 'sn-hint' }, '当前全部使用插件默认值。'),
      )
    }

    // ── 装配 ────────────────────────────────────────────────────────
    const inject = ['slots']

    function apply(ctx) {
      injectStyles()

      // 点通知 / 点提示条的共同出口：绑定 ctx 之后，两者行为一致。
      activateNotice = (notice) => {
        try {
          return returnToApp(ctx, notice)
        } catch {
          return false
        }
      }

      const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null
      if (!slots) {
        console.warn('[session-notifier] slots 服务不可用，界面跳过（Host 侧仍在收集提醒）')
        return
      }

      slots.inject(SLOT_OVERLAY, function () {
        return slots.register({ name: SLOT_OVERLAY, id: PLUGIN_ID, order: 90 }, ToastStack)
      })

      slots.inject(SLOT_SETTINGS, function () {
        return slots.register(
          {
            name: SLOT_SETTINGS,
            id: PLUGIN_ID,
            order: 62,
            label: function () {
              return '会话提醒'
            },
          },
          SettingsPage,
        )
      })

      startWatcher(ctx)
    }

    exports.apply = apply
    exports.inject = inject
    exports.SettingsPage = SettingsPage
    exports.ToastStack = ToastStack
    exports.pickOpenTarget = pickOpenTarget
    exports.returnToApp = returnToApp
    exports.planDelivery = planDelivery
    exports.wantsSystem = wantsSystem
    exports.SOUND_URL = SOUND_URL
    exports.playSound = playSound
    exports.unlockSound = unlockSound
    return module.exports
  },
})
