/**
 * settings.json 读写。
 *
 * 为什么要一个文件而不是直接改 cordis.patch.yml：patch 是「安装时的初始值」，
 * 改它要重启 DSH 才生效；而设置页要求「保存即生效」，所以运行态配置落在
 * $DSH_HOME/storages/session-notifier/settings.json，patch 只做默认值来源。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { deepMerge, resolveConfig, storageRoot } from './config.js'

/** 只接受这些键，防止前端塞进来一堆垃圾字段污染配置文件。 */
const WRITABLE = [
  'enabled',
  'nodes',
  'foreground',
  'sound',
  'soundVolume',
  'toastSeconds',
  'titleBadge',
  'quietHours',
  'dedupeMs',
]

export class SettingsStore {
  /**
   * @param {object} baseConfig cordis patch 里给的初始配置
   * @param {object} [opts]
   * @param {string} [opts.dir] 覆盖存储目录（测试用）
   * @param {(msg: string) => void} [opts.onWarn]
   */
  constructor(baseConfig, opts = {}) {
    this.base = resolveConfig(baseConfig || {})
    this.dir = opts.dir || storageRoot(baseConfig)
    this.file = join(this.dir, 'settings.json')
    this.onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : () => {}
    this.overrides = readJsonSafe(this.file, {}, this.onWarn)
    this.current = resolveConfig(deepMerge(this.base, this.overrides))
  }

  get() {
    return this.current
  }

  /** 当前落盘的覆盖项（不含 patch 默认值），设置页需要它判断「是否被改过」。 */
  getOverrides() {
    return JSON.parse(JSON.stringify(this.overrides))
  }

  /** 写入覆盖项：先落盘再换内存，写盘失败则整体不生效。 */
  save(patch) {
    const incoming = sanitizePatch(patch)
    if (!Object.keys(incoming).length) {
      return { ok: false, error: '没有可保存的字段' }
    }
    const nextOverrides = deepMerge(this.overrides, incoming)
    const next = resolveConfig(deepMerge(this.base, nextOverrides))
    try {
      writeJsonAtomic(this.file, nextOverrides)
    } catch (error) {
      return { ok: false, error: '写入配置失败：' + messageOf(error) }
    }
    this.overrides = nextOverrides
    this.current = next
    return { ok: true, settings: next, overrides: this.getOverrides() }
  }

  /** 清空覆盖值，回到 patch 默认值。 */
  reset() {
    const previous = this.readFileRaw()
    try {
      writeJsonAtomic(this.file, {})
    } catch (error) {
      return { ok: false, error: '写入配置失败：' + messageOf(error) }
    }
    this.overrides = {}
    this.current = resolveConfig(this.base)
    return { ok: true, settings: this.current, overrides: {}, previous }
  }

  /**
   * 外部（用户手改 settings.json）之后的重新加载。
   * 设置页保存走 save()；这里只用于「检测到文件被改动」这种边缘场景。
   */
  reload() {
    this.overrides = readJsonSafe(this.file, {}, this.onWarn)
    this.current = resolveConfig(deepMerge(this.base, this.overrides))
    return this.current
  }

  readFileRaw() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function sanitizePatch(patch) {
  const out = {}
  if (!patch || typeof patch !== 'object') return out
  for (const key of WRITABLE) {
    if (patch[key] !== undefined) out[key] = patch[key]
  }
  return out
}

function readJsonSafe(file, fallback, onWarn) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      onWarn('读取设置失败（用默认值继续）：' + messageOf(error))
    }
    return fallback
  }
  if (!raw.trim()) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch (error) {
    // 文件被手改坏了：不要抛，退到默认值，并如实告知用户。
    onWarn('settings.json 不是合法 JSON，已忽略：' + messageOf(error))
    return fallback
  }
}

/** 先写 .tmp 再 rename：断电/崩溃不会留下半截 JSON。 */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}
