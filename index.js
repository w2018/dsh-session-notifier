/**
 * dsh-session-notifier —— Host 半身
 *
 * 职责：旁听会话生命周期事件（见 lib/watcher.js），把「需要你动作了」的节点
 * 塞进内存队列（lib/queue.js），再通过 /api/session-notifier/* 交给浏览器侧
 * （client.js）去弹系统通知 / 页内提示条。
 *
 * 为什么通知不由 Host 直接弹：DSH 的 web 端跑在浏览器里，"系统通知"只有浏览器的
 * Notification API 且必须由页面申请权限；Host 绕过它去调 OS 通知既要平台分支又
 * 拿不到用户授权，反而更容易静默失败。
 *
 * 配置：patch 给默认值，设置页写 $DSH_HOME/storages/session-notifier/settings.json，
 * 保存即生效（不用重启 DSH）。
 */

import { BACKEND_VERSION } from './lib/constants.js'
import { NoticeQueue } from './lib/queue.js'
import { SettingsStore } from './lib/store.js'
import { createHandler } from './lib/routes.js'
import { installWatchers } from './lib/watcher.js'

export const name = 'session-notifier'
export const inject = ['webServer']

function createLogger(ctx) {
  const inner = ctx && ctx.logger ? ctx.logger : null
  const wrap = (level) => (message) => {
    const text = '[session-notifier] ' + message
    try {
      if (inner && typeof inner[level] === 'function') inner[level](text)
      else console[level === 'warn' ? 'warn' : 'log'](text)
    } catch {
      /* 日志本身不该拖垮插件 */
    }
  }
  return { info: wrap('info'), warn: wrap('warn') }
}

export function apply(ctx, config = {}) {
  const log = createLogger(ctx)

  const store = new SettingsStore(config, {
    onWarn: (message) => log.warn(message),
  })
  const queue = new NoticeQueue(config && config.queueSize ? config.queueSize : 60)

  const watchers = installWatchers(ctx, { queue, store, log })
  log.info(
    '已启动（后端 v' + BACKEND_VERSION + '，提醒节点：' +
      Object.entries(store.get().nodes)
        .filter(([, on]) => on)
        .map(([node]) => node)
        .join(', ') +
      '）',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/api/session-notifier', handler: createHandler({ queue, store, log }) }),
    'session-notifier: api routes',
  )

  ctx.effect(
    () => () => {
      try {
        watchers.dispose()
      } catch {
        /* 卸载时尽力而为 */
      }
    },
    'session-notifier: teardown',
  )

  // 刻意不注册成 Service：这个插件不需要被别的插件调用，占一个全局键名
  // 只会增加与别人重名的风险。对外只留 HTTP 端点。
}
