import assert from 'node:assert/strict'
import test from 'node:test'

import { NoticeQueue } from '../lib/queue.js'
import { resolveConfig } from '../lib/config.js'
import { installWatchers } from '../lib/watcher.js'

/**
 * 假的 Host 上下文：记录注册了哪些监听，测试里手动触发。
 */
function fakeCtx(options = {}) {
  const listeners = new Map()
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) || []
        listeners.set(event, current.filter((fn) => fn !== handler))
      }
    },
    get(key) {
      if (key === 'sessions' && options.sessions !== undefined) return options.sessions
      if (key === 'sessionTitle' && options.titles !== undefined) return options.titles
      return undefined
    },
  }
  return {
    ctx,
    listeners,
    fire(event, ...args) {
      const list = listeners.get(event) || []
      return Promise.all(list.map((handler) => handler(...args)))
    },
  }
}

function harness(overrides, options = {}) {
  const queue = new NoticeQueue(20)
  const cfg = resolveConfig(overrides || {})
  const store = { get: () => cfg }
  const logs = []
  const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
  const fake = fakeCtx(options)
  const watchers = installWatchers(fake.ctx, { queue, store, log })
  return { queue, cfg, watchers, fake, logs }
}

const agentOf = (id) => ({ id })

test('先 running 后 idle 才算一轮结束', async () => {
  const { queue, fake } = harness()
  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'idle' })
  assert.equal(queue.size(), 0, '从没见过 running 的 idle 不该报')

  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'running' })
  assert.equal(queue.size(), 0, 'running 事件本身不提醒')

  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'idle' })
  assert.equal(queue.size(), 1)
  const item = queue.since(0)[0]
  assert.equal(item.kind, 'turn')
  assert.equal(item.sessionId, 's1')
})

test('idle 之后再来一次 idle 不重复提醒', async () => {
  const { queue, fake } = harness()
  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'running' })
  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'idle' })
  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'idle' })
  assert.equal(queue.size(), 1)
})

test('子会话（origin=subagent）不报「任务完成」', async () => {
  const sessions = {
    get: (id) => (id === 'child' ? { header: { origin: 'subagent', parentSession: 'parent' } } : undefined),
  }
  const { queue, fake } = harness({}, { sessions })
  await fake.fire('agent/status', { agent: agentOf('child'), status: 'running' })
  await fake.fire('agent/status', { agent: agentOf('child'), status: 'idle' })
  assert.equal(queue.size(), 0)
})

test('会话标题走 sessionTitle 服务，拿不到就退化', async () => {
  const session = { header: { cwd: 'D:\\Harness_Work\\demo' } }
  const sessions = { get: () => session }
  const titles = { get: () => ({ title: '重构 runner' }) }
  const { queue, fake } = harness({}, { sessions, titles })
  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'running' })
  await fake.fire('agent/status', { agent: agentOf('s1'), status: 'idle' })
  const item = queue.since(0)[0]
  assert.equal(item.title, '重构 runner')
  assert.equal(item.workspace, 'demo')

  const second = harness({}, {})
  await second.fake.fire('agent/status', { agent: agentOf('abcdefghijkl'), status: 'running' })
  await second.fake.fire('agent/status', { agent: agentOf('abcdefghijkl'), status: 'idle' })
  assert.equal(second.queue.since(0)[0].title, '会话 abcdefgh')
})

test('approval/request 必须透传 next 的返回值，且旁听出提醒', async () => {
  const { queue, fake, logs } = harness()
  const sentinel = { kind: 'allow' }
  let called = 0
  const results = await fake.fire(
    'approval/request',
    { agent: agentOf('s1'), toolName: 'bash', displayReason: { en: 'write files', zh: '写文件' } },
    () => {
      called += 1
      return Promise.resolve(sentinel)
    },
  )
  assert.equal(called, 1, 'next 必须被调用一次')
  assert.deepEqual(results[0], sentinel, 'waterfall 结果要原样返回')
  assert.equal(queue.size(), 1)
  const item = queue.since(0)[0]
  assert.equal(item.kind, 'approval')
  assert.match(item.detail, /bash/)
  assert.match(item.detail, /写文件/)
  assert.equal(logs.filter(([level]) => level === 'warn').length, 0)
})

test('approval 旁听自身出错也不能阻断授权链', async () => {
  const { queue, fake, logs } = harness()
  const sentinel = { kind: 'deny' }
  const evilQueue = {
    push() {
      queue.push.call(queue, { kind: 'approval' })
      throw new Error('queue exploded')
    },
  }
  const fake2 = fakeCtx()
  installWatchers(fake2.ctx, { queue: evilQueue, store: { get: () => resolveConfig({}) }, log: { info() {}, warn: (m) => logs.push(['warn', m]) } })
  const results = await fake2.fire(
    'approval/request',
    { agent: agentOf('s1'), toolName: 'bash' },
    () => Promise.resolve(sentinel),
  )
  assert.deepEqual(results[0], sentinel, '自己的异常不能影响授权结果')
  assert.equal(logs.some(([level, m]) => level === 'warn' && /approval/.test(m)), true)
  void fake
})

test('user-questions/request 取第一个问题并报告总数', async () => {
  const { queue, fake } = harness()
  const answer = { answers: [] }
  const results = await fake.fire(
    'user-questions/request',
    {
      agent: agentOf('s1'),
      questions: [{ id: 'q1', question: '选哪个方案？' }, { id: 'q2', question: '要不要覆盖？' }],
    },
    () => Promise.resolve(answer),
  )
  assert.deepEqual(results[0], answer)
  const item = queue.since(0)[0]
  assert.equal(item.kind, 'question')
  assert.match(item.detail, /选哪个方案/)
  assert.match(item.detail, /共 2 个问题/)
})

test('节点开关能关掉某一类提醒', async () => {
  const { queue, fake } = harness({ nodes: { approval: false } })
  await fake.fire('approval/request', { agent: agentOf('s1'), toolName: 'bash' }, () => Promise.resolve(null))
  assert.equal(queue.size(), 0)

  await fake.fire('user-questions/request', { agent: agentOf('s1'), questions: [{ question: 'q' }] }, () => Promise.resolve(null))
  assert.equal(queue.size(), 1, '别的类别不受影响')
})

test('总开关关掉后什么都收不到', async () => {
  const { queue, fake } = harness({ enabled: false })
  await fake.fire('agent/error', { agent: agentOf('s1'), error: new Error('boom') })
  await fake.fire('api-session/error', 's1', '请求失败')
  await fake.fire('deepseek-account/model-sign-in-required')
  assert.equal(queue.size(), 0)
})

test('agent/error 带上错误消息', async () => {
  const { queue, fake } = harness()
  await fake.fire('agent/error', { agent: agentOf('s1'), error: { message: '模型返回 401' } })
  const item = queue.since(0)[0]
  assert.equal(item.kind, 'error')
  assert.match(item.detail, /401/)
})

test('api-session/error 是位置参数 (sessionId, message)', async () => {
  const { queue, fake } = harness()
  await fake.fire('api-session/error', 's1', '网络断了')
  const item = queue.since(0)[0]
  assert.equal(item.kind, 'error')
  assert.equal(item.sessionId, 's1')
  assert.match(item.detail, /网络断了/)
})

test('需要登录 / 授权失败才提醒，授权成功不打扰', async () => {
  const { queue, fake } = harness()
  await fake.fire('deepseek-account/model-sign-in-required')
  assert.equal(queue.size(), 1)
  assert.equal(queue.since(0)[0].kind, 'auth')

  queue.clear()
  await fake.fire('authorization/settled', 'deepseek', 'failed')
  assert.equal(queue.size(), 1)
  assert.equal(queue.since(0)[0].kind, 'auth')

  queue.clear()
  await fake.fire('authorization/settled', 'deepseek', 'authorized')
  assert.equal(queue.size(), 0, '授权成功不需要提醒')
})

test('子任务结束默认关，打开后才提醒', async () => {
  const off = harness()
  await off.fake.fire('subagent/end', { id: 'child', provider: 'explore', stopReason: { kind: 'completed' } })
  assert.equal(off.queue.size(), 0)

  const on = harness({ nodes: { subagent: true } })
  await on.fake.fire('subagent/end', { id: 'child', provider: 'explore', stopReason: { kind: 'completed' } })
  const item = on.queue.since(0)[0]
  assert.equal(item.kind, 'subagent')
  assert.match(item.detail, /explore/)
  assert.match(item.detail, /completed/)
})

test('同一会话同类提醒在 dedupeMs 内只发一次', async () => {
  const { queue, fake } = harness({ dedupeMs: 60000 })
  await fake.fire('api-session/error', 's1', '第一次')
  await fake.fire('api-session/error', 's1', '第二次')
  assert.equal(queue.size(), 1)

  await fake.fire('api-session/error', 's2', '另一个会话')
  assert.equal(queue.size(), 2, '不同会话互不防抖')
})

test('dedupeMs=0 时不做防抖', async () => {
  const { queue, fake } = harness({ dedupeMs: 0 })
  await fake.fire('api-session/error', 's1', 'a')
  await fake.fire('api-session/error', 's1', 'b')
  assert.equal(queue.size(), 2)
})

test('dispose 之后不再收到提醒', async () => {
  const { queue, fake, watchers } = harness()
  await fake.fire('api-session/error', 's1', '之前')
  assert.equal(queue.size(), 1)
  watchers.dispose()
  await fake.fire('api-session/error', 's1', '之后')
  assert.equal(queue.size(), 1)
})

test('事件 payload 缺字段也不炸', async () => {
  const { queue, fake, logs } = harness()
  await fake.fire('agent/status', {})
  await fake.fire('agent/error', undefined)
  await fake.fire('subagent/end', undefined)
  await fake.fire('approval/request', undefined, () => Promise.resolve('ok'))
  assert.equal(logs.filter(([level]) => level === 'warn').length, 0)
  assert.ok(queue.size() >= 1)
})
