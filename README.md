# dsh-bell-notify · 任务完成提醒

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件：在侧栏左下角（设置与账户旁边）加一个铃铛。
**打开它，模型每跑完一个任务就弹一条 Windows 系统通知**——不是网页里的气泡，是落在 Windows
通知中心的那种。

适合的场景：任务跑几分钟，你切去干别的，跑完了不想一直盯着窗口。

## 通知长什么样

**标题 = 会话标题**，**正文 = 模型这一轮最后输出的文本**。

比如你在「重构登录模块」这个会话里让它改代码，跑完后弹出的就是：

```
重构登录模块
已完成：把 session 校验抽成独立函数，并补了单元测试。
```

标题取自会话标题（先看 `api-session/added` 缓存，没有再问 `sessionQuery.readTitle`），
正文取 `readSurface()` 返回的模型表层里**最后一条未被中断**的 `assistant/message` 文本
（跳过 `interrupted: true` 的残片——那是回合被打断时的半句话）。

正文超过 180 字会截断加省略号：系统通知里塞一整篇回答没有意义。

### 为什么正文可能不是"结论"（以及怎么治）

这一版之前，正文取的是"`readSurface()` 里最后一条 `assistant/message` 的文本"，看起来天经地义，
实际有两个坑：

**① 读早了。** `api-session/status` 在 agent 转 idle 时触发，而最后一条 `assistant/message`
未必已经落进表层。这时读到的是**上一轮的中间文本**——表现出来就是"弹窗内容不是模型的输出结论"。

**② 读失败被静默吞掉。** 官方 README 明说 `readSurface` 要回放并校验整个日志，大历史可能好几秒，
而它不接受 `AbortSignal`。旧实现读失败就退到通用文案，用户看到的是"模型跑完了一个任务"。

现在的做法：

- **在 900ms 宽限期内多读几遍，取事件数最多的那一份**。后读到的历史更完整，说明这一轮的收尾消息
  已经落表。用"最后一条是不是 assistant/message"来判断是不行的——**中途快照同样以它结尾**，
  两者分不开（这一点是被测试逼出来的，我最初的写法就栽在这里）。
- **单次读取有 1.2 秒上限**，一次永不返回的 `readSurface` 不会拖死整个轮询。
- **跳过 `interrupted: true` 的消息**：那是回合被打断时落下的残片，文本往往是半句话。
- 宽限期后仍拿不到，就用手头最好的那份——通知宁可带一份稍旧的结论，也不能不发。

`test/content.test.mjs` 里第 8、9 条专门钉这两点：让前两次读到上一轮文本、第三次才出现结论，
断言最终取到的是结论；再让最后一条带 `interrupted`，断言不会拿它当结论。

## 用法

| 铃铛 | 含义 |
| --- | --- |
| 灰色、带一道斜杠 | 关（默认）。什么都不发 |
| 高亮、无斜杠 | 开。跑完就弹通知 |
| 右上角红点 | 刚才有任务跑完了（通知发不出去时的兜底信号） |

**点一下打开**，同时会立刻弹一条测试通知——这是这条链路唯一的"眼见为实"，点完马上知道行不行。
再点一下关掉。

打开时若系统通知权限被拒，铃铛会留一个红点提示。

## 它怎么判断"跑完了"

宿主监听 `api-session/status(sessionId, running)`，只在 **`running: true → false`** 这一次跳变上记一笔。

要求先见过 `true`，是为了避免启动时把"本来就是空闲"的会话误报成刚跑完——不然每次开 DSH
都会莫名其妙弹一堆通知。

## 通知是怎么发出来的

两条路，按优先级：

| 顺序 | 通道 | 通知顶部显示 | 说明 |
| --- | --- | --- | --- |
| 1 | Electron 原生 `Notification` | DeepSeek Harness | 宿主跑在 Electron 主进程时走这条，最正统 |
| 2 | WinRT toast（PowerShell 5.1） | DeepSeek Harness | 兜底。用 DSH 的 AppID `electron.app.DeepSeek Harness` |

两条都失败时，事件会带上 `delivered: failed`，客户端再弹一次网页通知兜底。

### 为什么要绕这么大一圈

AppID 决定通知归属。我最初图省事用了 PowerShell 自带的 AppID，结果通知顶部显示的是
**Windows PowerShell**——功能没问题，但看起来像是 PowerShell 在说话。现在优先用 DSH 自己的
AppID，显示名和图标都对得上。

WinRT 类型还得按命名空间逐个显式加载，漏一个（比如 `Windows.Data.Xml.Dom.XmlDocument`）就会报
`Cannot find type`——这些都踩过并记在代码注释里了。

## 为什么用 SSE 而不是轮询

窗口最小化时，Chromium 会把 `setInterval` 降频（后台 5 分钟后最慢到 1 次/分钟）。
而人恰恰是在离开窗口时才需要通知——轮询在最该工作的时候最不可靠。

SSE 由网络驱动，不受定时器节流影响。`EventSource` 断线会自己重连；重连期间可能漏事件，
所以挂载时和每次重新可见时都会按 `since` 补拉一次（幂等，客户端按 `seq` 去重）。

## 事件顺序

```
模型跑完  →  记事件、立刻推 SSE（红点马上亮）
          →  后台发系统通知
          →  结果回填同一条事件，再推一次
```

通知本身在你看到红点之前就已经弹出来了；投递结果只是回填给客户端判断要不要兜底。

## 关掉

- 铃铛点一下（不再弹通知，但插件仍在）
- 或插件页停用 `dsh-bell-notify`

## 开发

```bash
node --check index.js && node --check client.js
node test/smoke.mjs         # 客户端：模块外壳、slot 注册、开关两种渲染
node test/host.test.mjs     # 宿主：转场判定、四条路由、开关、since 游标、跨站拦截
node test/content.test.mjs  # 通知内容：标题=会话标题、正文=模型结论、读早了要重试、残片跳过、截断
node test/toast-live.mjs    # 手动：真的弹一条通知（会出现在屏幕上）
```

测试默认设 `DSH_BELL_DISABLE_TOAST=1`，不会弹真通知；`toast-live.mjs` 是例外。

`DSH_BELL_DISABLE_TOAST=1` 也适合无头服务器——本来就不该弹通知。

> host 半边（`index.js`）改完**要重启应用**才生效。

## 许可

本项目基于 [MIT](LICENSE) 协议开源，Copyright (c) 2026 HitMargin。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)