# usage-benchmark Specification

## Purpose

TBD - created by archiving change add-token-usage-benchmark. Update Purpose after archive.

## Requirements

### Requirement: 启动用量测算会话

系统 SHALL 允许用户启动一个「用量测算会话」,启动时必须指定一个非空的 AI 工具集合(`cursor` / `claude-code` / `codex` 的任意非空子集),可选填一条文本标签。同一时刻至多存在一个进行中的测算会话。

#### Scenario: 多选工具成功启动

- **WHEN** 当前无进行中的测算会话,用户以 `sources=["cursor","codex"]`、`label="优化前"` 启动测算
- **THEN** 系统创建一个进行中的会话,记录 `startedAt`、所选 `sources`、`label`,各工具的累加值初始化为 0,并返回该进行中会话

#### Scenario: 未选择任何工具

- **WHEN** 用户以空 `sources` 启动测算
- **THEN** 系统拒绝启动并返回错误,不创建会话

#### Scenario: 已有进行中会话时再次启动

- **WHEN** 已存在一个进行中的测算会话,用户再次发起启动
- **THEN** 系统拒绝启动并返回错误,既有进行中会话保持不变

### Requirement: 窗口内按选定工具累加用量

测算会话进行期间,系统 SHALL 把流经统一用量汇聚点 `recordUsage` 的归一化用量事件,在事件来源属于会话 `sources` 时累加进当前会话,累加内容包括 token 细分(input / output / cacheRead / cacheCreation / total)、对话次数(turns)与去重后的会话标识(sessionId)。来源不在 `sources` 内的事件 MUST 不计入。系统 MUST 仅记录结构化元数据,不得记录对话正文、工具参数或模型输入输出。

#### Scenario: 选中工具的事件被累加

- **WHEN** 存在进行中会话且 `sources=["cursor","codex"]`,产生一条 `source=cursor` 的用量事件,token total=500、turns 视为 1 次
- **THEN** 该会话 `cursor` 的 token 细分相应增加、turns +1、sessionId 计入去重列表

#### Scenario: 未选中工具的事件被忽略

- **WHEN** 存在进行中会话且 `sources=["cursor"]`,产生一条 `source=codex` 的用量事件
- **THEN** 该会话的累加值保持不变

#### Scenario: 无进行中会话时不累加

- **WHEN** 不存在进行中会话,产生任意用量事件
- **THEN** 不向任何测算会话累加,且不产生测算相关写盘

### Requirement: 测算独立于整体用量监控开关

测算采集 SHALL 独立于「AI 整体用量」全局监控开关:存在进行中测算会话时,采集链路必须照常把事件送达 `recordUsage`,即便整体用量监控处于关闭状态。同时整体用量聚合文件(`ai-usage.json`)的写入语义 MUST 保持不变——仅在整体用量监控开启时写入。

#### Scenario: 仅开测算、全局监控关闭

- **WHEN** 整体用量监控关闭,但存在进行中的测算会话,产生选中工具的用量事件
- **THEN** 该事件计入测算会话,且整体用量聚合文件不被写入

#### Scenario: 既无测算也未开监控

- **WHEN** 整体用量监控关闭且无进行中测算会话
- **THEN** 采集链路短路,不产生整体用量或测算的写盘

### Requirement: 结束测算并落盘记录

系统 SHALL 允许用户结束当前进行中的测算会话,结束时定格各工具累加值,记录 `endedAt`、时长与跨选中工具的合计(grandTotal),将其作为一条历史测算记录持久化到本机,并清空进行中会话。

#### Scenario: 正常结束

- **WHEN** 存在进行中会话,用户结束记录
- **THEN** 系统生成一条含时间窗、时长、各工具 token 细分与合计的历史记录持久化保存,进行中会话被清空,并返回该记录

#### Scenario: 无进行中会话时结束

- **WHEN** 不存在进行中会话,用户发起结束
- **THEN** 系统返回明确错误,不产生历史记录

### Requirement: 取消进行中的测算会话

系统 SHALL 允许用户取消当前进行中的测算会话,取消后该会话被丢弃且不写入历史记录。

#### Scenario: 取消进行中会话

- **WHEN** 存在进行中会话,用户取消记录
- **THEN** 进行中会话被清空,历史记录不新增

### Requirement: 查看与删除测算记录

系统 SHALL 提供查询接口返回当前进行中会话(若有)与全部历史测算记录;并允许按记录标识删除指定历史记录。删除不存在的记录 MUST 表现为幂等无操作。测算数据 MUST 持久化在本机,daemon 重启后进行中会话与历史记录均不丢失。

#### Scenario: 查询返回当前与历史

- **WHEN** 用户请求查询测算数据
- **THEN** 系统返回进行中会话(无则为空)与按结束时间倒序的历史测算记录列表

#### Scenario: 删除指定记录

- **WHEN** 用户按 id 删除一条已存在的历史记录
- **THEN** 该记录从历史列表移除,其余记录不受影响

#### Scenario: 删除不存在的记录

- **WHEN** 用户按一个不存在的 id 发起删除
- **THEN** 系统返回成功且历史列表不变

#### Scenario: daemon 重启后恢复进行中会话

- **WHEN** 存在进行中会话且 daemon 重启
- **THEN** 重启后该进行中会话仍存在,后续选中工具的事件继续累加进该会话

### Requirement: 看板「用量测算」页面

看板 SHALL 提供独立的「用量测算」菜单与页面,支持以秒表方式开始(含工具多选与可选标签)、查看进行中记录的实时时长与滚动用量、结束或取消记录,并以列表展示历史测算记录、支持选中多条做并排对比与图表可视化、支持删除记录。

#### Scenario: 秒表式起停

- **WHEN** 用户在页面勾选工具并点击「开始记录」,随后点击「结束记录」
- **THEN** 页面在记录期间展示进行中状态(计时与滚动用量),结束后该记录出现在历史列表中

#### Scenario: 对比多条记录

- **WHEN** 用户在历史列表中选中两条及以上测算记录进行对比
- **THEN** 页面并排展示这些记录的各工具 token 细分与合计,并以图表可视化对比
