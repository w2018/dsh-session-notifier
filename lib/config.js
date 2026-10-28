/**
 * 配置解析：默认值 + patch 初始值 + 设置页覆盖，三层合并后一律经 normalize，
 * 保证运行态不会因为一个手滑的字符串而整片失效。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { ALL_KINDS } from './constants.js'

export const DEFAULTS = Object.freeze({
  enabled: true,
  nodes: Object.freeze({
    turnComplete: true,
    approval: true,
    question: true,
    auth: true,
    error: true,
    subagent: false,
  }),
  foreground: 'smart',
  sound: true,
  toastSeconds: 8,
  titleBadge: true,
  quietHours: Object.freeze({ enabled: false, start: '23:00', end: '08:00' }),
  dedupeMs: 3000,
})

const FOREGROUND_MODES = ['smart', 'always', 'never']

/** 节点开关 → 事件类别。设置页用的是语义名，事件用短标签。 */
export const NODE_TO_KIND = Object.freeze({
  turnComplete: 'turn',
  approval: 'approval',
  question: 'question',
  auth: 'auth',
  error: 'error',
  subagent: 'subagent',
})

const KIND_TO_NODE = Object.freeze(
  Object.fromEntries(Object.entries(NODE_TO_KIND).map(([node, kind]) => [kind, node])),
)

export function nodeOfKind(kind) {
  return KIND_TO_NODE[kind] || null
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function storageRoot(cfg) {
  const custom = cfg && cfg.storage ? String(cfg.storage.dir || '').trim() : ''
  return custom || join(dshHome(), 'storages', 'session-notifier')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并：数组与标量整体覆盖，普通对象递归。 */
export function deepMerge(base, override) {
  const out = Object.assign({}, isPlainObject(base) ? base : {})
  if (!isPlainObject(override)) return out
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else if (isPlainObject(value)) {
      out[key] = deepMerge({}, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** "23:05" → 1385；非法返回 null。 */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function clock(value, fallback) {
  return parseClock(value) === null ? fallback : String(value).trim()
}

export function resolveConfig(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {})

  cfg.enabled = cfg.enabled !== false

  const nodes = isPlainObject(cfg.nodes) ? cfg.nodes : {}
  const normalizedNodes = {}
  for (const node of Object.keys(NODE_TO_KIND)) {
    normalizedNodes[node] = nodes[node] === undefined ? DEFAULTS.nodes[node] : nodes[node] !== false
  }
  cfg.nodes = normalizedNodes

  const mode = String(cfg.foreground || '').trim().toLowerCase()
  cfg.foreground = FOREGROUND_MODES.includes(mode) ? mode : DEFAULTS.foreground

  cfg.sound = cfg.sound !== false
  cfg.titleBadge = cfg.titleBadge !== false
  cfg.toastSeconds = clamp(cfg.toastSeconds, 2, 60, DEFAULTS.toastSeconds)
  cfg.dedupeMs = clamp(cfg.dedupeMs, 0, 60000, DEFAULTS.dedupeMs)

  const quiet = isPlainObject(cfg.quietHours) ? cfg.quietHours : {}
  cfg.quietHours = {
    enabled: quiet.enabled === true,
    start: clock(quiet.start, DEFAULTS.quietHours.start),
    end: clock(quiet.end, DEFAULTS.quietHours.end),
  }

  return cfg
}

/** 这个类别当前是否被允许提醒（Host 侧用 master + 节点开关做粗过滤）。 */
export function kindAllowed(cfg, kind) {
  if (!cfg || cfg.enabled !== true) return false
  const node = nodeOfKind(kind)
  if (!node) return false
  return cfg.nodes[node] !== false
}

export { ALL_KINDS }
