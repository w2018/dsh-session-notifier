import assert from 'node:assert/strict'
import test from 'node:test'

import { deepMerge, resolveConfig, kindAllowed, parseClock, DEFAULTS } from '../lib/config.js'

test('默认值：除子任务外全部开启', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.nodes.turnComplete, true)
  assert.equal(cfg.nodes.approval, true)
  assert.equal(cfg.nodes.question, true)
  assert.equal(cfg.nodes.auth, true)
  assert.equal(cfg.nodes.error, true)
  assert.equal(cfg.nodes.subagent, false)
  assert.equal(cfg.foreground, 'smart')
})

test('patch 值可以关掉某个节点，但不影响其它默认', () => {
  const cfg = resolveConfig({ nodes: { approval: false } })
  assert.equal(cfg.nodes.approval, false)
  assert.equal(cfg.nodes.question, true)
})

test('可被 JSON 字符串形式的 false 关掉（手改配置的容错）', () => {
  const cfg = resolveConfig({ enabled: false })
  assert.equal(cfg.enabled, false)
  assert.equal(kindAllowed(cfg, 'turn'), false)
  assert.equal(kindAllowed(cfg, 'approval'), false)
})

test('非法 foreground 退回 smart', () => {
  assert.equal(resolveConfig({ foreground: 'sometimes' }).foreground, 'smart')
  assert.equal(resolveConfig({ foreground: 'ALWAYS' }).foreground, 'always')
})

test('数值裁剪到安全范围', () => {
  assert.equal(resolveConfig({ toastSeconds: 999 }).toastSeconds, 60)
  assert.equal(resolveConfig({ toastSeconds: 0 }).toastSeconds, 2)
  assert.equal(resolveConfig({ toastSeconds: 'abc' }).toastSeconds, DEFAULTS.toastSeconds)
  assert.equal(resolveConfig({ dedupeMs: -5 }).dedupeMs, 0)
  assert.equal(resolveConfig({ dedupeMs: 99999 }).dedupeMs, 60000)
})

test('免打扰时段：非法时间退回默认，跨零点也能存', () => {
  const cfg = resolveConfig({ quietHours: { enabled: true, start: '25:00', end: '08:00' } })
  assert.equal(cfg.quietHours.start, DEFAULTS.quietHours.start)
  assert.equal(cfg.quietHours.end, '08:00')
  assert.equal(cfg.quietHours.enabled, true)
})

test('parseClock', () => {
  assert.equal(parseClock('00:00'), 0)
  assert.equal(parseClock('23:59'), 1439)
  assert.equal(parseClock('7:05'), 425)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('abc'), null)
  assert.equal(parseClock(null), null)
})

test('kindAllowed 认类别而不是内部节点名', () => {
  const cfg = resolveConfig({ nodes: { subagent: true } })
  assert.equal(kindAllowed(cfg, 'subagent'), true)
  assert.equal(kindAllowed(cfg, 'turn'), true)
  assert.equal(kindAllowed(cfg, 'unknown-kind'), false)
})

test('deepMerge 不动原对象，数组整体覆盖', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] }
  const out = deepMerge(base, { nested: { y: 9 }, list: [3] })
  assert.deepEqual(out, { a: 1, nested: { x: 1, y: 9 }, list: [3] })
  assert.deepEqual(base, { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] })
})

test('deepMerge 忽略 undefined，不把默认值打穿', () => {
  const out = deepMerge({ a: 1, b: 2 }, { a: undefined })
  assert.deepEqual(out, { a: 1, b: 2 })
})
