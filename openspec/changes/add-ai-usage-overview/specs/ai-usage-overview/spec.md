## ADDED Requirements

### Requirement: 整体用量采集开关

系统 SHALL 提供一个全局「AI 整体用量采集」开关,控制是否采集各 AI 工具的整体用量。开关状态 SHALL 持久化到本机数据根目录,跨 daemon 重启保持。默认值 SHALL 为关闭(opt-in),以避免在用户未知情时采集数据。

#### Scenario: 默认关闭

- **WHEN** 用户首次安装并启动 daemon,从未设置过开关
- **THEN** 整体用量采集处于关闭状态,系统不写入任何整体用量数据

#### Scenario: 开启采集并持久化

- **WHEN** 用户在「AI 用量」页面把监控开关切换为开启
- **THEN** 系统把开启状态写入本机配置文件,且后续 daemon 重启后仍为开启

#### Scenario: 关闭采集后停止写入

- **WHEN** 监控开关处于关闭状态,且任意 AI 工具产生新的对话/ token 消耗
- **THEN** 系统不记录任何整体用量数据(采集旁路短路)

### Requirement: 跨需求无差别采集整体用量

当采集开关开启时,系统 SHALL 采集各 AI 工具(Cursor / Claude Code / Codex)的整体用量,且 SHALL NOT 要求会话所在分支包含 Jira issue key。`main`、`bugfix-*`、个人实验分支,以及不在 git 仓库内的会话,其 token 与对话次数都 SHALL 计入整体用量。整体用量采集 SHALL 独立于既有「需求维度」采集,既有 watcher 的需求采集行为 SHALL 保持不变。

#### Scenario: 非 Jira 分支也计入

- **WHEN** 采集开启,用户在 `main` 分支用 Claude Code 完成一轮对话
- **THEN** 该轮的 token 与对话次数计入 Claude Code 的整体用量,即使没有任何需求被记录

#### Scenario: 非 git 仓库的 Cursor 会话也计入

- **WHEN** 采集开启,用户在一个非 git 目录用 Cursor 完成一轮对话
- **THEN** 该轮用量计入 Cursor 的整体用量(不因缺少 git 仓库/分支而被丢弃)

#### Scenario: 不影响需求维度采集

- **WHEN** 采集开启,用户在 `feature/INSTANT-1234-x` 分支完成一轮对话
- **THEN** 该轮既按既有逻辑写入需求 INSTANT-1234 的 iteration,又计入对应 AI 的整体用量,二者互不干扰

#### Scenario: 区分 AI 工具来源

- **WHEN** 同一天分别用 Cursor、Claude Code、Codex 各产生若干对话
- **THEN** 整体用量按 Cursor / Claude Code / Codex 三个维度分别累计,不混淆

### Requirement: 按 AI 工具与自然日聚合丰富用量

系统 SHALL 把整体用量按 `AI 工具 × 自然日` 维度聚合存储。每个 (工具, 日期) SHALL 记录至少:合计 token、token 细分(input / output / cacheRead / cacheCreation)、对话次数、会话数。当来源可提供时,系统 SHALL 额外记录 model、provider 维度的细分。采集层 SHALL 采集这些丰富维度并落盘(即便 v1 看板不全部展示)。缺失的维度字段 SHALL 安全降级(记 0 或跳过),SHALL NOT 阻断主采集流程。聚合 SHALL 累加幂等——同一来源事件重复处理(如 daemon 重启后重读)SHALL NOT 导致重复计数。自然日 SHALL 按用户本机时区划分。

#### Scenario: 当天多轮累加并保留 token 细分

- **WHEN** 用户当天用 Codex 完成 5 轮对话,累计 input 9000 / output 1000 / cacheRead 8000 / cacheCreation 2000 token
- **THEN** Codex 当天记录对话次数为 5,并分别累计 input / output / cacheRead / cacheCreation 与合计 token

#### Scenario: 来源不提供某维度时降级

- **WHEN** 某次采集事件无法解析出 model 或 toolCalls 维度
- **THEN** 系统照常累计 token 与对话次数,缺失维度记 0 或跳过,不报错、不丢整条事件

#### Scenario: 跨天分桶

- **WHEN** 用户的对话跨越本机时区的午夜
- **THEN** 午夜前的用量计入前一天,午夜后的用量计入后一天

#### Scenario: 重启不重复计数

- **WHEN** daemon 重启后重新扫描已处理过的会话文件
- **THEN** 已计入的 token 与对话次数不被重复累加

### Requirement: 整体用量查询端点

系统 SHALL 提供同源 HTTP 端点,供看板读取按 AI、按日聚合后的整体用量以及当前采集开关状态;并 SHALL 提供端点切换采集开关。查询响应 SHALL 至少包含:每个 AI 工具的当天用量、近 N 天的按日序列、采集开关状态。这些端点 SHALL 走看板 panel-origin 放行(免 token),与既有看板端点一致。

#### Scenario: 读取聚合用量

- **WHEN** 看板请求整体用量查询端点
- **THEN** 系统返回各 AI 工具的当天 token / 对话次数、近 N 天按日序列,以及当前开关状态

#### Scenario: 切换开关

- **WHEN** 看板请求切换开关端点把采集设为开启
- **THEN** 系统持久化新状态并在响应中返回更新后的开关状态,采集链路即时生效

#### Scenario: 关闭时仍可查询历史

- **WHEN** 采集开关为关闭,看板请求查询端点
- **THEN** 系统返回开关为关闭状态,并照常返回此前已采集的历史用量

### Requirement: AI 用量看板页面

系统 SHALL 在看板侧边栏新增「AI 用量」菜单项,点击进入独立页面。页面顶部 SHALL 以卡片并排展示各 AI 工具的整体用量及一个监控开关;v1 卡片 SHALL 至少展示当天合计 token 与对话次数(更丰富的细分维度虽已采集入库,v1 可暂不全部上屏)。页面底部 SHALL 展示用量趋势图表,直观呈现近 N 天各 AI 的消耗。页面视觉风格 SHALL 复用既有设计 token 与 glass 卡片体系,与其它看板页面保持一致。

#### Scenario: 菜单进入页面

- **WHEN** 用户点击侧边栏「AI 用量」菜单项
- **THEN** 看板导航到 AI 用量页面并高亮该菜单项

#### Scenario: 卡片展示各 AI 当天用量

- **WHEN** AI 用量页面加载完成且已有采集数据
- **THEN** 页面顶部为每个 AI 工具渲染一张卡片,展示其当天 token 与对话次数

#### Scenario: 页面内切换开关

- **WHEN** 用户在页面上切换监控开关
- **THEN** 开关状态即时通过查询/切换端点更新,UI 反映最新状态

#### Scenario: 底部趋势图表

- **WHEN** 存在近 N 天的按日用量数据
- **THEN** 页面底部以图表展示各 AI 的 token / 对话次数随日期变化的趋势

#### Scenario: 空态

- **WHEN** 采集从未开启或尚无任何用量数据
- **THEN** 页面展示友好的空态提示,引导用户开启监控,而非报错或空白
