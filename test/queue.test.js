import assert from 'node:assert/strict'
import test from 'node:test'

import { NoticeQueue } from '../lib/queue.js'

test('seq 单调递增，since 只给新条目', () => {
  const q = new NoticeQueue(10)
  q.push({ kind: 'turn' })
  q.push({ kind: 'approval' })
  assert.equal(q.cursor, 2)

  const all = q.since(0)
  assert.equal(all.length, 2)
  assert.deepEqual(all.map((i) => i.seq), [1, 2])

  const tail = q.since(1)
  assert.equal(tail.length, 1)
  assert.equal(tail[0].kind, 'approval')
})

test('非数字 cursor 视为从头拉', () => {
  const q = new NoticeQueue(10)
  q.push({ kind: 'turn' })
  assert.equal(q.since(undefined).length, 1)
  assert.equal(q.since('abc').length, 1)
})

test('超过容量丢最老的，cursor 不倒退', () => {
  const q = new NoticeQueue(8)
  for (let i = 0; i < 20; i += 1) q.push({ kind: 'turn', n: i })
  assert.equal(q.size(), 8)
  assert.equal(q.cursor, 20)
  const kept = q.since(0)
  assert.equal(kept[0].seq, 13)
  assert.equal(kept[kept.length - 1].seq, 20)
})

test('clear 清空条目但保留 cursor（避免客户端把旧条目重放）', () => {
  const q = new NoticeQueue(10)
  q.push({ kind: 'turn' })
  q.push({ kind: 'turn' })
  q.clear()
  assert.equal(q.size(), 0)
  assert.equal(q.cursor, 2)
  assert.equal(q.since(0).length, 0)
})

test('订阅者抛异常不影响入队', () => {
  const q = new NoticeQueue(10)
  const seen = []
  q.subscribe(() => {
    throw new Error('boom')
  })
  q.subscribe((item) => seen.push(item.seq))
  assert.doesNotThrow(() => q.push({ kind: 'turn' }))
  assert.deepEqual(seen, [1])
})

test('push 带上 at 时间戳且不覆盖传入的 seq（自己分配）', () => {
  const q = new NoticeQueue(10)
  const item = q.push({ kind: 'turn', seq: 999 })
  assert.equal(item.seq, 1)
  assert.equal(typeof item.at, 'number')
  assert.ok(item.at > 0)
})
