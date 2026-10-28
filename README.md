# dsh-session-notifier

> DSH 插件：会话在跑、有人在等你的时候，提醒你一声。

DeepSeek-Harness 的痛点很具体：交代一件事就去干别的了，回来才发现会话早就跑完、或者一直卡在「等你点允许」。这个插件把「需要你动作」的节点挑出来，用**系统通知**（浏览器 Notification）+ **页内提示条**提醒你。

## 提醒哪些节点

| 节点 | 触发来源 | 默认 |
| --- | --- | --- |
| 一轮任务跑完 | `agent/status`：先见过 `running` 再见到 `idle` | ✅ |
| 等你点允许（授权） | `approval/request`（waterfall，只旁听不改判） | ✅ |
| 弹窗提问等你回答 | `user-questions/request` | ✅ |
| 需要登录 / 重新授权 | `deepseek-account/model-sign-in-required`、`authorization/settled` = failed | ✅ |
| 任务出错 | `agent/error`、`api-session/error` | ✅ |
| 子任务结束 | `subagent/end` | ❌（一次长任务可能几十个子任务） |

## 设计要点

- **Host 只筛不弹。** 浏览器才有 `Notification` API，且权限必须由页面申请；Host 绕过它去调系统通知既要写平台分支又拿不到授权，更容易静默失败。
- **拉而不是推。** Client 拿着 `cursor` 每 2 秒拉 `/api/session-notifier/state?since=N`，断线/刷新天然补齐，不需要 SSE 的连接管理。首次拉只对齐 cursor，避免刷新页面重放旧提醒。
- **只旁听授权链。** `approval/request`、`user-questions/request` 是 waterfall 事件，监听器一律 `try/catch` 包住并原样 `return next()`——插件自己的 bug 绝不能把授权流程卡死。
- **不做「初始 idle」误报。** `agent/status` 的 `idle` 在会话初始化、子 agent 结束时都会来，必须见过 `running` 才算一轮结束；子会话（`header.origin === 'subagent'`）不报「完成」。
- **保存即生效。** 运行态配置在 `$DSH_HOME/storages/session-notifier/settings.json`，`cordis.patch.yml` 只是首次安装的默认值。

## 设置

设置 → **会话提醒**：

- 总开关 + 六个节点开关
- 前台策略：`smart`（后台才弹系统通知，推荐）/ `always`（始终**只**弹系统通知）/ `never`（只弹页内条）

> 三种策略**互斥**，不叠加：走了系统通知就不再弹页内提示条 —— 否则用户会被
> 同一条提醒打扰两遍。只有系统通知发不出去（权限未授予、浏览器不支持
> `Notification`）时才退回页内提示条兜底。
- 提示音（内置音效 + 音量滑杆 + 试听）、标签页标题未读计数、提示条停留秒数
- 免打扰时段（支持跨零点，如 `23:00` → `08:00`）
- 「申请系统通知权限」按钮、实时权限状态、**发一条测试提醒**

### 提示音

**只有系统通知才响，页内提示条不响。** 页内条本来就摆在眼前，再响一声纯属多余；
而系统通知往往发生在窗口被切走的时候，声音才是「回来看看」的信号。

音效是包内自带的 `assets/mambo.wav`，由 Host 的 `GET /api/session-notifier/sound`
端点回二进制，Client 用单个复用的 `<audio>` 播放（连续提醒不会叠成噪音）。
不用 `Notification` 自带的 `silent: false`：那是浏览器/系统的默认音，换不掉，
各平台行为也不一致 —— 所以系统通知一律 `silent: true`，音效完全由插件掌控。

音量走 `soundVolume`（0–1，默认 0.8）；`sound: false` 时两者都不出声。

> 系统通知需要站点权限。localhost 属安全上下文，一般能申请到；被拒绝时脚本改不回来 —— 页内提示条会兜住，同时在地址栏的站点设置里可以改回去。

### 点通知回到那个会话

点系统通知（或点页内提示条）不只是把窗口提到前面：它会调用宿主的
`uiWorkspace.openSession(sessionId)`，直接**选中提醒所属的那个会话**。所以从别的
标签页 / 别的窗口回来，落在的是刚跑完的那个对话，而不是上一次停留的地方。

`window.focus()` 只在浏览器允许脚本聚焦时才有效，因此它只是附带动作，不承担
「回到哪」的责任。子会话会先用 `sessions.subagentAddress()` 换出地址再打开。

## 安装

在装了 DSH 的环境里：

1. 把本目录放到任意位置；
2. 用 `plugin_manager` 的 `install_bundle`，`target` 填本目录绝对路径；
3. 重启一次 `dsh web`（新接管的客户端 bundle 需要重新加载）。

## 目录结构

```
index.js          Host 半身：装配 store / queue / watcher / 路由
client.js         Client 半身：页内提示条（shell.overlay）+ 设置页（settings.section）
lib/constants.js  类别标签与 BACKEND_VERSION
lib/config.js     默认值 + normalize（非法值一律兜底）
lib/store.js      settings.json 原子读写，白名单字段
lib/queue.js      有界环形队列 + 单调 seq
lib/watcher.js    事件旁听 → 提醒条目
lib/routes.js     /api/session-notifier/*
test/             node --test 单测（纯逻辑 + 假 ctx 驱动事件）
```

## 开发

```bash
node --test "test/*.test.js"
```

`BACKEND_VERSION`（`lib/constants.js`）与 `client.js` 里的 `EXPECTED_BACKEND_VERSION` 必须一致：不一致时设置页会直接提示「请重启一次 DSH」，而不是让用户对着一个点不动的开关。

## License

MIT
