import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createHandler } from '../lib/routes.js'
import { NoticeQueue } from '../lib/queue.js'
import { SettingsStore } from '../lib/store.js'

/** 最小的 req/res 替身：只需要 url/method/on 和 writeHead/end。 */
function fakeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers || null
    },
    end(chunk) {
      res.body = chunk == null ? '' : String(chunk)
    },
  }
  return res
}

async function call(handler, method, url, body) {
  const res = fakeRes()
  await handler(fakeReq(method, url, body), res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.status, json, res }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sn-routes-'))
  const queue = new NoticeQueue(20)
  const store = new SettingsStore({}, { dir })
  const handler = createHandler({ queue, store, log: { info() {}, warn() {} } })
  return { dir, queue, store, handler, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('GET /state 返回空队列与设置', async () => {
  const s = setup()
  try {
    const out = await call(s.handler, 'GET', '/api/session-notifier/state?since=0')
    assert.equal(out.status, 200)
    assert.equal(out.json.ok, true)
    assert.equal(out.json.backend, 1)
    assert.deepEqual(out.json.items, [])
    assert.equal(out.json.cursor, 0)
    assert.equal(out.json.settings.enabled, true)
  } finally {
    s.done()
  }
})

test('GET /state?since=N 只给新条目', async () => {
  const s = setup()
  try {
    s.queue.push({ kind: 'turn', sessionId: 's1' })
    s.queue.push({ kind: 'approval', sessionId: 's1' })
    const out = await call(s.handler, 'GET', '/api/session-notifier/state?since=1')
    assert.equal(out.json.items.length, 1)
    assert.equal(out.json.items[0].kind, 'approval')
    assert.equal(out.json.cursor, 2)
  } finally {
    s.done()
  }
})

test('POST /settings 保存并回传生效值', async () => {
  const s = setup()
  try {
    const out = await call(s.handler, 'POST', '/api/session-notifier/settings', { settings: { sound: false } })
    assert.equal(out.status, 200)
    assert.equal(out.json.settings.sound, false)
    assert.equal(s.store.get().sound, false)

    // 空 patch 报 400 而不是静默成功
    const bad = await call(s.handler, 'POST', '/api/session-notifier/settings', {})
    assert.equal(bad.status, 400)
    assert.equal(bad.json.ok, false)
  } finally {
    s.done()
  }
})

test('坏 JSON body 落 500 且带错误信息', async () => {
  const s = setup()
  try {
    const out = await call(s.handler, 'POST', '/api/session-notifier/settings', '{oops')
    assert.equal(out.status, 500)
    assert.equal(out.json.ok, false)
    assert.ok(out.json.error)
  } finally {
    s.done()
  }
})

test('POST /settings/reset 回到默认', async () => {
  const s = setup()
  try {
    await call(s.handler, 'POST', '/api/session-notifier/settings', { sound: false })
    const out = await call(s.handler, 'POST', '/api/session-notifier/settings/reset', {})
    assert.equal(out.status, 200)
    assert.equal(out.json.settings.sound, true)
    assert.deepEqual(out.json.overrides, {})
  } finally {
    s.done()
  }
})

test('POST /test 入队一条测试提醒', async () => {
  const s = setup()
  try {
    const out = await call(s.handler, 'POST', '/api/session-notifier/test', {})
    assert.equal(out.status, 200)
    assert.equal(out.json.item.kind, 'turn')
    assert.equal(out.json.item.test, true)
    assert.equal(s.queue.size(), 1)
  } finally {
    s.done()
  }
})

test('POST /clear 清空队列', async () => {
  const s = setup()
  try {
    s.queue.push({ kind: 'turn' })
    const out = await call(s.handler, 'POST', '/api/session-notifier/clear', {})
    assert.equal(out.status, 200)
    assert.equal(s.queue.size(), 0)
    assert.equal(out.json.cursor, 1, 'cursor 不清零，避免重放')
  } finally {
    s.done()
  }
})

test('GET /sound 回包内提示音，且带缓存头', async () => {
  const s = setup()
  try {
    const out = await call(s.handler, 'GET', '/api/session-notifier/sound')
    assert.equal(out.status, 200)
    assert.equal(out.res.headers['content-type'], 'audio/wav')
    assert.ok(out.res.headers['cache-control'].includes('max-age'), '缺缓存头会让浏览器每次重下 100KB')
    assert.equal(out.res.body.slice(0, 4), 'RIFF')
  } finally {
    s.done()
  }
})

test('HEAD /sound 只回头不回体', async () => {
  const s = setup()
  try {
    const out = await call(s.handler, 'HEAD', '/api/session-notifier/sound')
    assert.equal(out.status, 200)
    assert.equal(out.res.body, '')
    assert.ok(Number(out.res.headers['content-length']) > 1024)
  } finally {
    s.done()
  }
})

test('未知端点 404，方法不匹配也 404', async () => {
  const s = setup()
  try {
    const unknown = await call(s.handler, 'GET', '/api/session-notifier/nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.ok, false)

    const wrongMethod = await call(s.handler, 'GET', '/api/session-notifier/test')
    assert.equal(wrongMethod.status, 404)
  } finally {
    s.done()
  }
})

test('尾斜杠和不带前缀都能落到正确端点', async () => {
  const s = setup()
  try {
    const trailing = await call(s.handler, 'GET', '/api/session-notifier/settings/')
    assert.equal(trailing.status, 200)
    assert.equal(trailing.json.ok, true)
  } finally {
    s.done()
  }
})
