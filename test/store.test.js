import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SettingsStore } from '../lib/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sn-store-'))
}

test('没有文件时用 patch 默认值', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore({ nodes: { subagent: false } }, { dir })
    assert.equal(store.get().enabled, true)
    assert.equal(store.get().nodes.subagent, false)
    assert.equal(store.getOverrides().nodes, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('save 落盘后立即可读，且只存覆盖项', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore({}, { dir })
    const result = store.save({ sound: false, nodes: { error: false } })
    assert.equal(result.ok, true)
    assert.equal(store.get().sound, false)
    assert.equal(store.get().nodes.error, false)

    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.deepEqual(onDisk, { sound: false, nodes: { error: false } })

    // 新实例读同一文件：持久化确实生效。
    const reopened = new SettingsStore({}, { dir })
    assert.equal(reopened.get().sound, false)
    assert.equal(reopened.get().nodes.error, false)
    assert.equal(reopened.get().nodes.turnComplete, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('save 只接受白名单字段，垃圾字段被丢弃', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore({}, { dir })
    const result = store.save({ sound: false, evil: 'x', __proto__: { polluted: true } })
    assert.equal(result.ok, true)
    assert.equal('evil' in store.getOverrides(), false)
    assert.equal(Object.keys(store.getOverrides()).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空 patch 视为错误，不写文件', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore({}, { dir })
    const result = store.save({})
    assert.equal(result.ok, false)
    assert.match(result.error, /没有可保存的字段/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset 清空覆盖项回到默认', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore({}, { dir })
    store.save({ sound: false })
    const result = store.reset()
    assert.equal(result.ok, true)
    assert.equal(store.get().sound, true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.deepEqual(onDisk, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件被手改坏：不抛异常，退到默认并回调告警', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'settings.json'), '{ this is not json', 'utf8')
    const warnings = []
    const store = new SettingsStore({}, { dir, onWarn: (m) => warnings.push(m) })
    assert.equal(store.get().enabled, true)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /settings\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空文件当默认值处理，不告警', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'settings.json'), '   \n', 'utf8')
    const warnings = []
    const store = new SettingsStore({}, { dir, onWarn: (m) => warnings.push(m) })
    assert.equal(store.get().enabled, true)
    assert.equal(warnings.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reload 能吃到外部改动', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore({}, { dir })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ toastSeconds: 20 }), 'utf8')
    store.reload()
    assert.equal(store.get().toastSeconds, 20)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patch 里给了非法值也被 normalize 兜住', () => {
  const dir = tempDir()
  try {
    const store = new SettingsStore({ foreground: 'nonsense', toastSeconds: -1 }, { dir })
    assert.equal(store.get().foreground, 'smart')
    assert.equal(store.get().toastSeconds, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
