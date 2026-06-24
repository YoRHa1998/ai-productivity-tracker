## ADDED Requirements

### Requirement: 会话维度用量累加

系统 SHALL 在唯一用量汇聚点 `recordUsage` 内,于「整体用量采集开关开启」时,除既有「AI 工具 × 自然日」聚合外,额外按 `sessionId` 维度持久化每个会话的 token 用量。累加项 MUST 包含 token 细分(input / output / cacheRead / cacheCreation / total)、对话轮次(turns)、工具调用次数(toolCalls)、source、model(best-effort)、会话标题(title,best-effort)、首次活跃时间(firstAt)与最近活跃时间(lastAt)。会话记录的存储 key MUST 以 source 前缀消歧(`${source}:${sessionId}`),token `total` 口径 MUST 与 `AiUsageTokens` 一致(input + output + cacheCreation,剔除 cacheRead)。

#### Scenario: 开关开启时按会话累加 token

- **WHEN** 整体用量采集开关为开启,且 `recordUsage` 收到一条携带非空 `sessionId` 的 `AiUsageEvent`
- **THEN** 系统在会话维度 store 中为该 `${source}:${sessionId}` 累加 token 细分、turns、toolCalls,刷新 lastAt,并在首次出现时记录 firstAt

#### Scenario: 同一会话多轮累计

- **WHEN** 同一 `sessionId` 在不同时间产生多条用量事件(含跨自然日)
- **THEN** 该会话记录的 token 与 turns 跨事件累加,firstAt 保持最早、lastAt 更新为最近,不被自然日切分拆开

#### Scenario: 缺会话标识的事件不入会话维度

- **WHEN** `recordUsage` 收到一条 `sessionId` 为空的事件
- **THEN** 系统跳过会话维度累加(不创建空 key 记录),既有按日聚合不受影响

#### Scenario: 全局开关关闭时不写会话维度

- **WHEN** 整体用量采集开关为关闭
- **THEN** 系统不写入会话维度数据(与既有 `ai-usage.json` 写入同生命周期)

### Requirement: 会话标题 best-effort 采集

系统 SHALL 以会话**首条用户输入**为素材,best-effort 采集人类可读的会话标题(title)并落入对应会话记录。各采集链路 MUST 在能解析到首条用户输入时(Claude 的 user 行、Codex 的 user_message、Cursor 经 transcript 取首条 user 行)提取其文本,在采集点截断到上限(默认 80 字符、压成一行)后通过 `AiUsageEvent` 携带。`title` 一旦写入 MUST NOT 被后续轮覆盖(标题恒为会话第一句)。系统 SHALL NOT 依赖各 IDE/CLI 工具私有数据库里的原生会话标题。系统 SHALL 额外支持可选 `jiraKey`:采集点解析到 Jira issue key 时携带作为可下钻的附加标签,解析不到时安全留空。`title` 与 `jiraKey` 均为可选,缺失时 MUST NOT 阻断会话维度累加。

#### Scenario: 用首条用户输入作会话标题

- **WHEN** 一个会话产生首条用户输入,采集链路解析出其文本
- **THEN** 该会话记录保存截断后的 title,看板据此展示接近原生会话标题的人类可读标识

#### Scenario: 标题不被后续轮覆盖

- **WHEN** 同一会话在首条输入之后继续产生更多轮次
- **THEN** 会话记录的 title 保持为首条输入的截断片段,不被后续轮改写

#### Scenario: 命中 Jira 上下文附带可下钻标签

- **WHEN** 一个会话发生在含 Jira issue key 的需求上下文,采集点解析出 `jiraKey`
- **THEN** 该会话记录保存 `jiraKey`,看板在标题旁展示可点击下钻需求详情的徽标

#### Scenario: 无标题无 Jira 时回退标识

- **WHEN** 一个会话既未采到首条输入文本、又不含 Jira issue key
- **THEN** 该会话 title 与 jiraKey 均留空,看板回退展示短会话 ID + 工具 + 时间窗

### Requirement: 会话维度保留上限治理

系统 SHALL 对会话维度数据施加保留上限,避免单文件无限膨胀。每次写盘前 MUST 裁剪:删除 lastAt 早于保留天数(默认 30 天)的会话,并按 lastAt 倒序截断到最大条数(默认 1000 条)。

#### Scenario: 过期会话被裁剪

- **WHEN** 写盘时存在 lastAt 早于保留天数阈值的会话记录
- **THEN** 系统在持久化前删除这些过期会话

#### Scenario: 超出条数上限按最近保留

- **WHEN** 会话记录条数超过最大条数上限
- **THEN** 系统按 lastAt 倒序保留最近的记录,丢弃更早的记录

### Requirement: 会话用量查询端点

系统 SHALL 提供同源 HTTP 端点 `GET /ai-productivity/session-usage`,供看板查询会话维度用量。该端点 SHALL 支持时间范围(from / to)、工具(source)过滤,以及排序(默认按 token 合计倒序,可按最近活跃)与条数限制(默认 50),并在服务端完成排序与截断后返回。该端点 MUST 归入 panel-origin 放行集合(同源免 token)。

#### Scenario: 默认按 token 倒序返回 Top 会话

- **WHEN** 看板请求 `GET /ai-productivity/session-usage` 不带排序参数
- **THEN** 系统返回按 token 合计倒序、截断到默认条数的会话列表

#### Scenario: 按工具与时间范围过滤

- **WHEN** 请求带 `source` 与 `from`/`to` 参数
- **THEN** 系统只返回该工具、且活跃时间落在范围内的会话记录

#### Scenario: 同源放行

- **WHEN** 看板从 daemon 同源发起该 GET 请求
- **THEN** 端点按 panel-origin 规则放行,无需额外 token

### Requirement: 看板会话用量明细展示

看板「AI 用量」页面 SHALL 在既有按日卡片与趋势图之外,新增「会话 Top N」明细区,按 token 合计倒序展示每个会话的会话标题、工具、model、时间窗、对话轮次与 token 细分及合计,并支持工具筛选、时间范围与排序切换。当无可展示数据时 SHALL 呈现引导空态。

#### Scenario: 展示最烧 token 的会话

- **WHEN** 用户打开「AI 用量」页面且存在会话维度数据
- **THEN** 页面在明细区按 token 合计倒序展示会话,token 最高的会话排在最前,以会话标题作为人类可读标识

#### Scenario: 命中 Jira 的会话可下钻

- **WHEN** 某会话记录带有 `jiraKey`
- **THEN** 页面在会话标题旁展示可点击徽标,点击可跳转到对应需求详情

#### Scenario: 空态引导

- **WHEN** 会话维度暂无数据(如采集开关未开启或尚无会话)
- **THEN** 明细区展示引导文案,提示开启采集后将按会话展示 token 明细

### Requirement: 用量指示条与排序展示模式

看板 SHALL 提供可复用的用量指示条:条长按用量相对当前列表最大值归一化(最大值满格、其余按比例),颜色按高低分三档——比值达到危险阈值(默认最大值的 66%)显示红色、达到警示阈值(默认 33%)显示橙色、否则显示绿色。该展示模式 MUST 同时应用于「AI 用量」会话列表与「用量测算」记录列表。两类列表 SHALL 支持按用量高→低 / 低→高排序,默认按用量合计降序(最高在前)。

#### Scenario: 用量条长度与颜色反映高低

- **WHEN** 列表渲染多条用量记录
- **THEN** 每条展示一根用量条,长度与其用量占列表最大值的比例一致,且按比例落入绿/橙/红三档配色

#### Scenario: 按用量排序

- **WHEN** 用户切换排序方向为「用量高→低」或「低→高」
- **THEN** 列表按用量合计重新排序,默认进入页面时为高→低

#### Scenario: 两个页面一致呈现

- **WHEN** 用户分别查看「AI 用量」会话列表与「用量测算」记录列表
- **THEN** 两处均以相同的用量条 + 排序模式呈现每条记录的消耗轻重
