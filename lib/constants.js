/**
 * dsh-session-notifier —— 运行态常量
 *
 * BACKEND_VERSION 只在「热重载换不掉」的改动时递增：路由表 / 事件契约 /
 * 队列载荷结构。设置页拿它和前端期望值比对，不一致就提示「后端是旧代码，
 * 需要重启一次 DSH」，而不是让用户对着一个永远点不动的开关。
 */
export const BACKEND_VERSION = 1

/** 事件类别。Host 只打标签，是否真的提醒由 Client 按设置判定。 */
export const KINDS = Object.freeze({
  TURN: 'turn',
  APPROVAL: 'approval',
  QUESTION: 'question',
  AUTH: 'auth',
  ERROR: 'error',
  SUBAGENT: 'subagent',
})

export const ALL_KINDS = Object.freeze(Object.values(KINDS))
