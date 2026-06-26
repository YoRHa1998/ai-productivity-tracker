## ADDED Requirements

### Requirement: 会话逐轮明细持久化

系统 SHALL 在会话维度记录(`SessionUsageRecord`)内持久化逐轮明细数组,在 `accumulateSessionUsage` 每次累加(对应一条携带非空 `sessionId` 的 `AiUsageEvent`、即一轮)时追加一项明细。每项明细 MUST 包含:该轮事件时间戳(at)、本轮 token 细分(input / output / cacheRead / cacheCreation)与有效用量合计(total,口径与 `AiUsageTokens` 一致)、本轮工具调用次数(toolCalls)、本轮模型(model,best-effort)、本轮名称素材(title,取该轮用户输入,经去标签 / 压一行清洗,best-effort 完整记录)。逐轮明细数组 MUST 受条数上限护栏约束:每会话明细条数超过上限(默认 500)时,系统 MUST 按时间保留最近的若干项,而会话级 `turns` 计数 MUST 继续反映真实累计总轮数(不被明细裁剪影响)。逐轮明细字段 MUST 为加性可选 schema:本能力上线前写入、无明细数组的旧记录 MUST 安全兜底为空且 MUST NOT 报错。

#### Scenario: 每轮追加一项明细

- **WHEN** 某 `${source}:${sessionId}` 会话连续产生 3 条携带 token / model 的用量事件
- **THEN** 该会话记录的逐轮明细数组追加 3 项,每项保存该轮的 at、token 细分与合计、toolCalls、model 与名称素材,且会话级 turns 为 3

#### Scenario: 明细条数超上限按最近保留

- **WHEN** 某会话累计轮次超过明细条数上限(默认 500)
- **THEN** 逐轮明细数组只保留最近的若干项,而会话级 turns 仍累加为真实总轮数

#### Scenario: 历史记录无明细安全兜底

- **WHEN** 系统读取本能力上线前写入、无逐轮明细数组的旧会话记录
- **THEN** 系统将其逐轮明细视为空,正常返回会话级数据,不报错

### Requirement: 会话逐轮明细查询端点

系统 SHALL 提供同源 HTTP 端点 `GET /ai-productivity/session-usage/detail`,按会话 key(`key=${source}:${sessionId}`)返回单个会话的头部信息(会话标题 / 项目 / 分支 / model / token 合计 / 时间窗)与逐轮明细列表。逐轮明细列表 MUST 按时间升序返回,每项 MUST 携带该轮名称、模型、token 合计与细分、并在端点 / 视图层推导出该轮时长(durationMs)与该轮占本会话总量的比例(ratio)。该轮时长 MUST 由相邻两轮事件时间戳之差推导(`turn[i].durationMs = at[i+1] - at[i]`),最后一轮无后继时 durationMs MUST 留空(展示侧呈现「—」)。当 key 不存在或该会话无逐轮明细时,端点 MUST 返回 `200` 与空明细列表(MUST NOT 返回 404 或报错)。该端点 MUST 归入 panel-origin 放行集合(同源免 token)。

#### Scenario: 按会话 key 返回逐轮明细

- **WHEN** 看板请求 `GET /ai-productivity/session-usage/detail?key=cursor:abc` 且该会话有 4 轮明细
- **THEN** 端点返回会话头部 + 按时间升序的 4 项逐轮明细,每项含名称、模型、token 合计/细分、推导时长与占比

#### Scenario: 末轮时长留空

- **WHEN** 端点返回某会话的逐轮明细列表
- **THEN** 除最后一轮外每轮 durationMs 为相邻轮时间戳之差,最后一轮 durationMs 留空(展示「—」)

#### Scenario: 无明细会话返回空列表

- **WHEN** 请求的会话 key 不存在或为上线前无明细的历史会话
- **THEN** 端点返回 `200` 与空逐轮明细列表,不返回 404

#### Scenario: 同源放行

- **WHEN** 看板从 daemon 同源发起该 GET 请求
- **THEN** 端点按 panel-origin 规则放行,无需额外 token

### Requirement: 会话详情弹窗逐轮展示

看板「会话用量明细」列表的每个会话行 SHALL 可点击打开会话详情弹窗(`ElDialog`)。弹窗 MUST 展示该会话头部标识,并逐轮(`v-for`)展示每一轮对话的:名称(该轮用户输入)、时长、本轮 token 消耗、模型。弹窗 MUST 为每一轮渲染一根用量进度条,其长度按「本轮 token 合计 ÷ 本会话 token 合计」归一化,其颜色按本轮 token 合计的**绝对值**分三档(危险阈值默认 300K 红 / 警示阈值默认 150K 橙 / 否则绿),复用既有用量条与绝对配色逻辑及设计 token(`--aipt-usage-low/mid/high`)。弹窗 MUST 标注每轮时长为「相邻轮事件间隔(含空闲)」的近似口径说明。当会话无逐轮明细时,弹窗 MUST 呈现空态提示(如「该会话无逐轮明细」)而非报错。会话行已有的跳转 Jira 徽标点击 MUST `@click.stop` 防止冒泡触发弹窗。

#### Scenario: 点击会话行打开详情弹窗

- **WHEN** 用户点击「会话用量明细」中某条会话行
- **THEN** 打开详情弹窗,逐轮展示每一轮的名称、时长、本轮 token、模型,并为每轮渲染占本会话比例的进度条

#### Scenario: 每轮进度条按绝对量配色

- **WHEN** 弹窗中某一轮本轮 token 合计 ≥ 300K
- **THEN** 该轮进度条显示红色(`--aipt-usage-high`),长度按该轮占本会话合计比例渲染

#### Scenario: 时长口径说明

- **WHEN** 用户查看详情弹窗的每轮时长
- **THEN** 弹窗呈现口径说明,标明时长为相邻轮事件间隔的近似(含用户空闲),末轮时长显示「—」

#### Scenario: 无明细空态

- **WHEN** 用户点击一条上线前无逐轮明细的历史会话行
- **THEN** 弹窗呈现「该会话无逐轮明细」空态提示,不报错

#### Scenario: 下钻徽标不误触发弹窗

- **WHEN** 用户点击会话行内的 Jira 下钻徽标
- **THEN** 仅触发需求详情跳转(`@click.stop`),不打开会话详情弹窗
