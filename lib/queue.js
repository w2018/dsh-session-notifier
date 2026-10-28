/**
 * 提醒队列：一个有界环形缓冲 + 单调递增 seq。
 *
 * 为什么是「拉」而不是「推」：Client 半身是浏览器 bundle，和 Host 之间只有
 * HTTP。SSE 也能用，但 DSH 的 web 服务在移动端/后台标签页会断流，重连补齐
 * 逻辑一样得写；倒不如让 Client 拿着 cursor 来拉，重连天然补齐、无需状态。
 *
 * 语义：
 *   - push() 分配 seq，超过容量时丢最老的；
 *   - since(cursor) 返回 seq > cursor 的全部条目；
 *   - 不同标签页各拉各的，互不影响（没有 ack，队列只靠容量滚动）。
 */

const DEFAULT_CAPACITY = 60

export class NoticeQueue {
  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(8, Math.trunc(capacity) || DEFAULT_CAPACITY)
    /** @type {Array<object>} */
    this.items = []
    this.seq = 0
    /** @type {Set<Function>} */
    this.listeners = new Set()
  }

  /** 分配 seq 并入队，返回完整条目。 */
  push(notice) {
    this.seq += 1
    const item = Object.assign({}, notice, { seq: this.seq, at: Date.now() })
    this.items.push(item)
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity)
    }
    for (const listener of this.listeners) {
      try {
        listener(item)
      } catch {
        /* 订阅者自己炸了不该影响入队 */
      }
    }
    return item
  }

  /** seq > cursor 的条目（保持旧 → 新）。 */
  since(cursor) {
    const from = Number(cursor)
    if (!Number.isFinite(from) || from <= 0) return this.items.slice()
    return this.items.filter((item) => item.seq > from)
  }

  get cursor() {
    return this.seq
  }

  size() {
    return this.items.length
  }

  clear() {
    this.items = []
  }

  /** 供 Host 内部使用（目前只有测试用）；返回退订函数。 */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
