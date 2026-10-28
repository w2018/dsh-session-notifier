/**
 * 事件旁听：把 Host 侧的生命周期事件翻译成「需要你动作了」的提醒条目。
 *
 * 两条铁律：
 *   1. 只旁听，绝不改变语义。approval / user-questions 是 waterfall 事件，
 *      我们必须原样 `return next()`；监听器里抛异常会把整条授权链一起炸掉，
 *      所以所有回调都包在 try/catch 里，失败只记一条日志。
 *   2. 只报「真的需要人」的事件。agent/status 的 idle 本身不稀奇（子 agent、
 *      会话初始化都会 idle），必须「先见过 running 再见到 idle」才算一轮结束。
 */

import { basename } from 'node:path'

import { KINDS } from './constants.js'
import { kindAllowed } from './config.js'

const MAX_DETAIL = 180

function messageOf(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message) return error.message
  try {
    return String(error)
  } catch {
    return ''
  }
}

function clip(text, limit = MAX_DETAIL) {
  const value = String(text == null ? '' : text)
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? oneLine.slice(0, limit - 1) + '…' : oneLine
}

/** displayReason 是多语言字典，优先中文，否则 en。 */
function pickReason(reason) {
  if (!reason) return ''
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object') {
    return String(reason.zh || reason['zh-CN'] || reason.en || '')
  }
  return ''
}

/**
 * 会话元信息解析。任何一步拿不到都退化，不抛异常：
 * 会话标题服务是可选依赖，缺了就用 id 前缀当标题。
 */
function createSessionInfo(ctx) {
  return function sessionInfo(sessionId) {
    const result = { sessionId: sessionId || '', title: '', workspace: '', subagent: false }
    if (!sessionId) return result

    let session = null
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
      if (sessions && typeof sessions.get === 'function') session = sessions.get(sessionId)
    } catch {
      session = null
    }

    const header = session && session.header ? session.header : null
    if (header) {
      result.subagent = header.origin === 'subagent' || Boolean(header.parentSession)
      if (header.cwd) result.workspace = basename(String(header.cwd))
    }

    let title = ''
    try {
      const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null
      if (titles && typeof titles.get === 'function' && session) {
        const snapshot = titles.get(session)
        if (snapshot && typeof snapshot.title === 'string') title = snapshot.title
      }
    } catch {
      title = ''
    }

    result.title = clip(title, 60) || '会话 ' + String(sessionId).slice(0, 8)
    return result
  }
}

/**
 * @param {import('cordis').Context} ctx
 * @param {object} deps
 * @param {import('./queue.js').NoticeQueue} deps.queue
 * @param {{ get: () => any }} deps.store
 * @param {{ info: Function, warn: Function }} deps.log
 */
export function installWatchers(ctx, deps) {
  const { queue, store, log } = deps
  const sessionInfo = createSessionInfo(ctx)
  const disposers = []

  /** 每个会话的运行态：是否见过 running、何时开始、本次是否已提醒。 */
  const running = new Map()
  /** 防抖：(kind + sessionId) → 上次提醒时间。 */
  const lastNotified = new Map()

  function listen(event, handler) {
    if (typeof ctx.on !== 'function') return
    const off = (() => {
      try {
        return ctx.on(event, handler, { global: true })
      } catch {
        try {
          return ctx.on(event, handler)
        } catch {
          return null
        }
      }
    })()
    if (typeof off === 'function') disposers.push(off)
  }

  function emit(kind, payload) {
    let cfg
    try {
      cfg = store.get()
    } catch {
      return null
    }
    if (!kindAllowed(cfg, kind)) return null

    const key = kind + '|' + (payload.sessionId || '') + '|' + (payload.dedupe || '')
    const now = Date.now()
    const dedupe = Number(cfg.dedupeMs) || 0
    const previous = lastNotified.get(key)
    if (dedupe > 0 && previous && now - previous < dedupe) return null
    lastNotified.set(key, now)
    if (lastNotified.size > 200) {
      for (const [k, at] of lastNotified) {
        if (now - at > 60000) lastNotified.delete(k)
      }
    }

    // dedupe 只是内部分组键，不进载荷（前端不该看见它）。
    const { dedupe: _ignored, ...rest } = payload
    return queue.push(Object.assign({ kind }, rest))
  }

  // ── 一轮任务结束 ────────────────────────────────────────────────
  // agent/status 是 emit 事件，payload = { agent, status }。agent.id 就是 SessionId。
  listen('agent/status', (payload) => {
    try {
      const agent = payload && payload.agent
      const status = payload ? payload.status : ''
      const sessionId = agent && (agent.id || (agent.session && agent.session.id))
      if (!sessionId) return

      if (status === 'running') {
        running.set(String(sessionId), { since: Date.now() })
        return
      }
      if (status !== 'idle') return

      const state = running.get(String(sessionId))
      if (!state) return // 没见过 running：启动时的初始 idle，不该报。
      running.delete(String(sessionId))

      const info = sessionInfo(String(sessionId))
      if (info.subagent) return // 子任务走 subagent/end，别重复吵。

      emit(KINDS.TURN, {
        sessionId: String(sessionId),
        title: info.title,
        workspace: info.workspace,
        detail: '这一轮已经跑完，可以回来看了',
        durationMs: Math.max(0, Date.now() - state.since),
      })
    } catch (error) {
      log.warn('agent/status 处理失败：' + messageOf(error))
    }
  })

  // ── 等待授权（waterfall：必须透传）─────────────────────────────
  listen('approval/request', (req, next) => {
    try {
      const agent = req && req.agent
      const sessionId = agent && (agent.id || (agent.session?.id))
      const info = sessionInfo(sessionId ? String(sessionId) : '')
      const tool = req && req.toolName ? String(req.toolName) : '某个工具'
      const reason = pickReason(req && (req.displayReason || req.reason))
      emit(KINDS.APPROVAL, {
        sessionId: info.sessionId,
        title: info.title,
        workspace: info.workspace,
        detail: clip('等待你允许：「' + tool + '」' + (reason ? ' —— ' + reason : '')),
      })
    } catch (error) {
      log.warn('approval/request 旁听失败：' + messageOf(error))
    }
    return typeof next === 'function' ? next() : undefined
  })

  // ── 弹窗提问（waterfall：必须透传）─────────────────────────────
  listen('user-questions/request', (request, next) => {
    try {
      const agent = request && request.agent
      const sessionId = agent && (agent.id || (agent.session?.id))
      const info = sessionInfo(sessionId ? String(sessionId) : '')
      const questions = Array.isArray(request && request.questions) ? request.questions : []
      const first = questions[0] || {}
      const count = questions.length
      const head = clip(first.question || first.header || '有件事想问你', 100)
      emit(KINDS.QUESTION, {
        sessionId: info.sessionId,
        title: info.title,
        workspace: info.workspace,
        detail: count > 1 ? clip(head + '（共 ' + count + ' 个问题）') : head,
      })
    } catch (error) {
      log.warn('user-questions/request 旁听失败：' + messageOf(error))
    }
    return typeof next === 'function' ? next() : undefined
  })

  // ── 报错 ───────────────────────────────────────────────────────
  listen('agent/error', (payload) => {
    try {
      const agent = payload && payload.agent
      const sessionId = agent && (agent.id || (agent.session?.id))
      const info = sessionInfo(sessionId ? String(sessionId) : '')
      emit(KINDS.ERROR, {
        sessionId: info.sessionId,
        title: info.title,
        workspace: info.workspace,
        detail: clip(messageOf(payload && payload.error) || '任务出错了'),
      })
    } catch (error) {
      log.warn('agent/error 处理失败：' + messageOf(error))
    }
  })

  listen('api-session/error', (sessionId, message) => {
    try {
      const info = sessionInfo(sessionId ? String(sessionId) : '')
      emit(KINDS.ERROR, {
        sessionId: info.sessionId,
        title: info.title,
        workspace: info.workspace,
        detail: clip(message || '请求出错了'),
      })
    } catch (error) {
      log.warn('api-session/error 处理失败：' + messageOf(error))
    }
  })

  // ── 需要登录 ───────────────────────────────────────────────────
  listen('deepseek-account/model-sign-in-required', () => {
    try {
      emit(KINDS.AUTH, {
        sessionId: '',
        title: 'DeepSeek 账号',
        workspace: '',
        detail: '需要重新登录才能继续用模型',
        dedupe: 'sign-in',
      })
    } catch (error) {
      log.warn('model-sign-in-required 处理失败：' + messageOf(error))
    }
  })

  // ── 授权流程失败（成功/取消不打扰）────────────────────────────
  listen('authorization/settled', (key, settlement) => {
    try {
      if (settlement !== 'failed') return
      emit(KINDS.AUTH, {
        sessionId: '',
        title: '账号授权',
        workspace: '',
        detail: clip('授权失败：' + (pickReason(key) || '凭据没有生效，需要重新授权')),
        dedupe: 'authorize-failed',
      })
    } catch (error) {
      log.warn('authorization/settled 处理失败：' + messageOf(error))
    }
  })

  // ── 子任务结束（默认关，因为一次任务可能带来几十条）──────────
  listen('subagent/end', (info) => {
    try {
      const run = info || {}
      const meta = sessionInfo(run.id ? String(run.id) : '')
      const label = run.provider ? String(run.provider) : '子任务'
      const stop = run.stopReason && run.stopReason.kind ? String(run.stopReason.kind) : ''
      emit(KINDS.SUBAGENT, {
        sessionId: meta.sessionId,
        title: meta.title,
        workspace: meta.workspace,
        detail: clip(label + ' 已结束' + (stop ? '（' + stop + '）' : '')),
      })
    } catch (error) {
      log.warn('subagent/end 处理失败：' + messageOf(error))
    }
  })

  return {
    dispose() {
      for (const off of disposers) {
        try {
          off()
        } catch {
          /* 卸载时尽力而为 */
        }
      }
      disposers.length = 0
      running.clear()
      lastNotified.clear()
    },
    /** 测试与诊断用：当前看到多少个在跑的会话。 */
    runningCount() {
      return running.size
    },
    /** 诊断用：真的挂上了几个监听器（拿不到 ctx.on 时会是 0）。 */
    listenerCount() {
      return disposers.length
    },
  }
}
