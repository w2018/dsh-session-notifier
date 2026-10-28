/**
 * /api/session-notifier/* HTTP 端点。
 *
 * Client 半身是浏览器 bundle，只能走 HTTP；这里就用 DSH 自己的 webServer
 * 前缀路由（同源，跟着宿主走端口、走鉴权），不另开监听。
 *
 *   GET  /state?since=N   → { ok, backend, settings, permissionHint, cursor, items }
 *   GET  /status          → { ok, backend, listeners, running, queued }  （自检用）
 *   GET  /settings        → { ok, settings, defaults, overrides }
 *   POST /settings        → 保存（局部更新即可）
 *   POST /settings/reset  → 回到默认
 *   POST /test            → 推一条测试提醒
 *   POST /clear           → 清空队列
 */

import { BACKEND_VERSION } from './constants.js'
import { DEFAULTS } from './config.js'

const MAX_BODY = 64 * 1024

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {object} deps
 * @param {import('./queue.js').NoticeQueue} deps.queue
 * @param {import('./store.js').SettingsStore} deps.store
 * @param {{ info: Function, warn: Function }} deps.log
 */
export function createHandler(deps) {
  const { queue, store, log } = deps

  return async function handler(req, res) {
    let pathname = '/'
    let query = () => null
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      pathname = decodeURIComponent(url.pathname || '/')
      query = (name) => url.searchParams.get(name)
    } catch {
      sendJson(res, 400, { ok: false, error: '请求地址不合法' })
      return
    }

    // prefix 路由拿到的是完整路径，先剥掉自己的前缀再匹配。
    const rest = pathname.replace(/^\/api\/session-notifier/, '') || '/'
    const route = rest.replace(/\/+$/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()

    try {
      if (route === '/state' && method === 'GET') {
        const since = Number(query('since'))
        const items = queue.since(Number.isFinite(since) ? since : 0)
        sendJson(res, 200, {
          ok: true,
          backend: BACKEND_VERSION,
          cursor: queue.cursor,
          settings: store.get(),
          items,
        })
        return
      }

      if (route === '/settings' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          backend: BACKEND_VERSION,
          settings: store.get(),
          defaults: DEFAULTS,
          overrides: store.getOverrides(),
        })
        return
      }

      if (route === '/settings' && method === 'POST') {
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const patch = body && typeof body === 'object' && body.settings ? body.settings : body
        const result = store.save(patch || {})
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.error })
          return
        }
        sendJson(res, 200, {
          ok: true,
          backend: BACKEND_VERSION,
          settings: result.settings,
          overrides: result.overrides,
        })
        return
      }

      if (route === '/settings/reset' && method === 'POST') {
        const result = store.reset()
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.error })
          return
        }
        sendJson(res, 200, { ok: true, backend: BACKEND_VERSION, settings: result.settings, overrides: {} })
        return
      }

      if (route === '/test' && method === 'POST') {
        const item = queue.push({
          kind: 'turn',
          sessionId: '',
          title: '测试提醒',
          workspace: '',
          detail: '看到这条就说明通道是通的',
          test: true,
        })
        sendJson(res, 200, { ok: true, backend: BACKEND_VERSION, item, cursor: queue.cursor })
        return
      }

      if (route === '/clear' && method === 'POST') {
        queue.clear()
        sendJson(res, 200, { ok: true, backend: BACKEND_VERSION, cursor: queue.cursor })
        return
      }

      sendJson(res, 404, { ok: false, error: '未知端点：' + route })
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      log.warn('处理 ' + route + ' 失败：' + message)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}
