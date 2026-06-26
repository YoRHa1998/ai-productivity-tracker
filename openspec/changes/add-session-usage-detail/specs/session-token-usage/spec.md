## MODIFIED Requirements

### Requirement: 会话标题 best-effort 采集

系统 SHALL 以会话**首条用户输入**为素材,best-effort 采集人类可读的会话标题(title)并落入对应会话记录。各采集链路 MUST 在能解析到首条用户输入时(Claude 的 user 行、Codex 的 user_message、Cursor 经 transcript 取首条 user 行)提取其文本,经去标签 / 压成一行清洗后**完整记录**(不再截断到 80 字符),仅在防御异常超长输入时施加一个较大的安全上限(默认 4000 字符)后通过 `AiUsageEvent` 携带。`title` 一旦写入 MUST NOT 被后续轮覆盖(标题恒为会话第一句)。逐轮明细的名称素材 MUST 同口径(去标签 / 压一行 / 完整记录 / 大安全上限)记录该轮用户输入。系统 SHALL NOT 依赖各 IDE/CLI 工具私有数据库里的原生会话标题。系统 SHALL 额外支持可选 `jiraKey`:采集点解析到 Jira issue key 时携带作为可下钻的附加标签,解析不到时安全留空。`title` 与 `jiraKey` 均为可选,缺失时 MUST NOT 阻断会话维度累加。看板列表行 MAY 对完整标题做单行省略展示,完整内容在会话详情弹窗呈现。

#### Scenario: 用首条用户输入作会话标题

- **WHEN** 一个会话产生首条用户输入,采集链路解析出其文本
- **THEN** 该会话记录保存去标签后的完整 title(不截断到 80 字符),看板据此展示人类可读标识

#### Scenario: 标题完整记录不截断到 80 字符

- **WHEN** 会话首条用户输入清洗后长度超过 80 字符且未达安全上限
- **THEN** 会话记录保存其完整内容,不在 80 字符处截断

#### Scenario: 异常超长输入按安全上限兜底

- **WHEN** 会话首条用户输入清洗后长度超过安全上限(默认 4000 字符)
- **THEN** 系统按安全上限截断,防止单条标题撑爆落盘文件

#### Scenario: 标题不被后续轮覆盖

- **WHEN** 同一会话在首条输入之后继续产生更多轮次
- **THEN** 会话记录的 title 保持为首条输入的完整片段,不被后续轮改写

#### Scenario: 命中 Jira 上下文附带可下钻标签

- **WHEN** 一个会话发生在含 Jira issue key 的需求上下文,采集点解析出 `jiraKey`
- **THEN** 该会话记录保存 `jiraKey`,看板在标题旁展示可点击下钻需求详情的徽标

#### Scenario: 无标题无 Jira 时回退标识

- **WHEN** 一个会话既未采到首条输入文本、又不含 Jira issue key
- **THEN** 该会话 title 与 jiraKey 均留空,看板回退展示短会话 ID + 工具 + 时间窗
