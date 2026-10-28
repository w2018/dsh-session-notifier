import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

/**
 * client.js 是浏览器 bundle：它只做一件事——把自己交给
 * window.__ModuleLoader__.load({ id, factory })。这里把那个壳子搭出来，
 * 用假 React 载入 factory，就能对纯逻辑（选会话的优先级）做单测。
 */
function loadClient() {
  const file = join(import.meta.dirname, '..', 'client.js')
  const source = readFileSync(file, 'utf8')

  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options) {
          captured = options
        },
      },
    },
    document: { querySelector: () => null, head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, textContent: '' }) },
    console,
  }

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'client.js 应该调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-session-notifier')

  const fakeReact = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const moduleExports = captured.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  return { exports: moduleExports, id: captured.id }
}

test('模块 id 与包名一致，并导出 apply/inject', () => {
  const { id, exports } = loadClient()
  assert.equal(id, 'dsh-session-notifier')
  assert.equal(typeof exports.apply, 'function')
  // 跨 realm 拿到的数组原型不同，deepEqual 会误判，这里比内容。
  assert.equal(Array.from(exports.inject).join(','), 'slots')
})

test('有会话 id 时优先按会话打开', () => {
  const { exports } = loadClient()
  const target = exports.pickOpenTarget(
    { uiWorkspace: { openSession() {} }, sessions: { subagentAddress: () => null } },
    { sessionId: 's1' },
  )
  assert.equal(target.kind, 'session')
  assert.equal(target.sessionId, 's1')
})

test('没有 uiWorkspace 时退化为「只聚焦」', () => {
  const { exports } = loadClient()
  const target = exports.pickOpenTarget({ uiWorkspace: null, sessions: null }, { sessionId: 's1' })
  assert.equal(target.kind, 'none')
  assert.equal(target.sessionId, 's1')
})

test('子会话 id 会带上 subagentAddress 作为兜底', () => {
  const { exports } = loadClient()
  const address = { parentSessionId: 'p1', runId: 'r1' }
  const target = exports.pickOpenTarget(
    { uiWorkspace: { openSession() {} }, sessions: { subagentAddress: () => address } },
    { sessionId: 's2' },
  )
  assert.equal(target.kind, 'session')
  assert.deepEqual(target.subagentAddress, address)
})

test('subagentAddress 抛异常时不影响按会话打开', () => {
  const { exports } = loadClient()
  const target = exports.pickOpenTarget(
    {
      uiWorkspace: { openSession() {} },
      sessions: {
        subagentAddress() {
          throw new Error('boom')
        },
      },
    },
    { sessionId: 's3' },
  )
  assert.equal(target.kind, 'session')
  assert.equal(target.subagentAddress, null)
})

test('测试提醒（无会话）只关提示条', () => {
  const { exports } = loadClient()
  const target = exports.pickOpenTarget({ uiWorkspace: { openSession() {} }, sessions: null }, { sessionId: '' })
  assert.equal(target.kind, 'none')
})

test('payload 缺字段也不抛', () => {
  const { exports } = loadClient()
  assert.equal(exports.pickOpenTarget({}, undefined).kind, 'none')
  assert.equal(exports.pickOpenTarget({ uiWorkspace: { openSession() {} } }, {}).kind, 'none')
})

// ── returnToApp：点通知/点提示条到底做了什么 ──────────────────────────

function ctxWith(services) {
  return {
    get(key) {
      return services[key] || null
    },
  }
}

test('returnToApp 会选中提醒所属的会话', () => {
  const { exports } = loadClient()
  const opened = []
  const ok = exports.returnToApp(ctxWith({ uiWorkspace: { openSession: (id) => opened.push(id) } }), {
    sessionId: 'sess-42',
  })
  assert.equal(ok, true)
  assert.deepEqual(opened, ['sess-42'])
})

test('按会话打开被拒时改用 subagentAddress 重试', () => {
  const { exports } = loadClient()
  const address = { parentSessionId: 'p1', runId: 'r1' }
  const opened = []
  const ok = exports.returnToApp(
    ctxWith({
      uiWorkspace: {
        openSession(target) {
          if (typeof target === 'string') throw new Error('subagent needs address')
          opened.push(target)
        },
      },
      sessions: { subagentAddress: () => address },
    }),
    { sessionId: 'sess-sub' },
  )
  assert.equal(ok, true)
  assert.deepEqual(opened, [address])
})

test('没有 uiWorkspace 时 returnToApp 不抛，返回 false', () => {
  const { exports } = loadClient()
  assert.equal(exports.returnToApp(ctxWith({}), { sessionId: 'x' }), false)
  assert.equal(exports.returnToApp(undefined, { sessionId: 'x' }), false)
})

test('测试提醒没有会话 id 时不打开任何会话', () => {
  const { exports } = loadClient()
  const opened = []
  const ok = exports.returnToApp(ctxWith({ uiWorkspace: { openSession: (id) => opened.push(id) } }), {})
  assert.equal(ok, false)
  assert.deepEqual(opened, [])
})

// ── planDelivery：三种前台策略必须互斥，不能叠加 ──────────────────────

/**
 * planDelivery 的结果对象是在 vm 沙箱里创建的字面量，原型与宿主 realm 不同，
 * deepStrictEqual 会因此误判，所以只比关心的两个字段。
 */
function same(actual, expected) {
  assert.equal(actual.toast, expected.toast, 'toast 不一致：' + JSON.stringify(actual))
  assert.equal(actual.beep, expected.beep, 'beep 不一致：' + JSON.stringify(actual))
}

test('always + 系统通知发出去了 → 不再弹页内条、不再响铃', () => {
  const { exports } = loadClient()
  // 前台、后台都一样：always 就是「只走系统通知」。
  same(exports.planDelivery('always', false, true), { toast: false, beep: false })
  same(exports.planDelivery('always', true, true), { toast: false, beep: false })
})

test('always 但系统通知发不出去 → 退回页内条兜底', () => {
  const { exports } = loadClient()
  same(exports.planDelivery('always', false, false), { toast: true, beep: true })
})

test('smart 只在后台且系统通知成功时才让位', () => {
  const { exports } = loadClient()
  same(exports.planDelivery('smart', true, true), { toast: false, beep: false })
  // 前台不发系统通知 → 弹页内条
  same(exports.planDelivery('smart', false, false), { toast: true, beep: true })
  // 后台但权限没给 → 页内条兜底
  same(exports.planDelivery('smart', true, false), { toast: true, beep: true })
})

test('never 永远只弹页内条', () => {
  const { exports } = loadClient()
  same(exports.planDelivery('never', false, false), { toast: true, beep: true })
  same(exports.planDelivery('never', true, true), { toast: true, beep: true })
})

test('foreground 取值缺失时按 smart 处理', () => {
  const { exports } = loadClient()
  same(exports.planDelivery(undefined, true, true), { toast: false, beep: false })
  same(exports.planDelivery(undefined, false, false), { toast: true, beep: true })
  // 脏配置（比如手改 settings.json 写错）也当 smart，别把提醒吃掉。
  same(exports.planDelivery('ALWAYS!', true, true), { toast: false, beep: false })
  same(exports.planDelivery('ALWAYS!', false, false), { toast: true, beep: true })
})

test('wantsSystem 与 planDelivery 口径一致', () => {
  const { exports } = loadClient()
  assert.equal(exports.wantsSystem('always', false), true)
  assert.equal(exports.wantsSystem('always', true), true)
  assert.equal(exports.wantsSystem('smart', false), false)
  assert.equal(exports.wantsSystem('smart', true), true)
  assert.equal(exports.wantsSystem('never', true), false)
  // 想发系统通知时，发成功就一定不弹页内条；反之必弹。
  for (const mode of ['smart', 'always', 'never']) {
    for (const bg of [true, false]) {
      const wants = exports.wantsSystem(mode, bg)
      assert.equal(exports.planDelivery(mode, bg, wants).toast, !wants)
    }
  }
})
