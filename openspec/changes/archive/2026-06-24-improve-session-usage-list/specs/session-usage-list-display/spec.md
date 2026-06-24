## ADDED Requirements

### Requirement: 会话标题去标签展示

系统 SHALL 在展示会话标题时,只呈现用户真实输入内容,剥离 IDE 注入的包裹标签。当首条用户输入文本含 `<user_query>...</user_query>` 包裹时,系统 MUST 提取其内部正文作为标题素材;无该包裹时,系统 MUST 移除已知噪声标签块(如 `<timestamp>`、`<cursor_commands>`、`<system_reminder>`、`<attached_files>` 等,含其内容)并剥离其余残留的尖括号标签标记,保留标签之间的可读文本。该清洗 MUST 在采集写入侧与展示读取侧双侧生效,使既有已落盘的「带标签脏标题」在展示时同样被清洗(无需数据迁移),且清洗 MUST 幂等。清洗后仍按既有上限折行压一行并截断。

#### Scenario: 提取 user_query 正文

- **WHEN** 会话首条用户输入为 `<timestamp>...</timestamp> <user_query> 你好</user_query>`
- **THEN** 会话标题展示为 `你好`,不含任何 `<timestamp>` / `<user_query>` 标签

#### Scenario: 剥离噪声标签块

- **WHEN** 首条用户输入含 `<timestamp>` 等噪声标签块但无 `<user_query>` 包裹
- **THEN** 标题移除噪声标签块及其内容,仅保留用户可读文本

#### Scenario: 清洗历史脏标题

- **WHEN** 会话记录中已落盘的 `title` 仍带包裹标签(在本能力上线前写入)
- **THEN** 看板展示该会话时对标题做幂等清洗,呈现去标签后的内容,且不改写落盘数据

#### Scenario: 不误删正常含尖括号文本

- **WHEN** 用户真实输入(经 user_query 提取后)本身包含成对尖括号片段(如代码泛型)
- **THEN** 系统在已取到 user_query 正文的情况下不再做全局标签剥离,保留该正文内容

### Requirement: 会话用量条绝对阈值配色

看板会话用量列表 SHALL 按会话有效用量合计(total)的**绝对值**为用量条配色,分三档:`total` 达到危险阈值(默认 300K)显示红色、达到警示阈值(默认 150K)显示橙色、否则显示绿色。该配色 MUST 与用量条长度的归一化分母无关(即便条很短,只要绝对量达阈值即显对应颜色)。阈值 MUST 为可覆盖的默认常量。颜色 MUST 取既有设计 token(`--aipt-usage-low/mid/high`),不写死色值。「用量测算」记录列表的既有相对比值配色行为 MUST NOT 受影响。

#### Scenario: 大于等于 300K 显红

- **WHEN** 某会话 total ≥ 300K
- **THEN** 该会话用量条显示红色(`--aipt-usage-high`)

#### Scenario: 150K 到 300K 显橙

- **WHEN** 某会话 total 在 150K(含)到 300K(不含)之间
- **THEN** 该会话用量条显示橙色(`--aipt-usage-mid`)

#### Scenario: 小于 150K 显绿

- **WHEN** 某会话 total < 150K
- **THEN** 该会话用量条显示绿色(`--aipt-usage-low`)

#### Scenario: 绝对配色不受条长分母影响

- **WHEN** 某会话条长占总和比例很小、但其 total ≥ 300K
- **THEN** 该会话用量条仍显示红色

#### Scenario: 用量测算页配色不变

- **WHEN** 用户查看「用量测算」记录列表
- **THEN** 其用量条仍按相对当前列表最大值的比值分档配色,行为与本能力上线前一致

### Requirement: 会话用量条按列表总和占比

看板会话用量列表 SHALL 按「各会话有效用量合计占当前列表总和的比例」决定用量条长度:条长百分比 = 该会话 total ÷ 当前列表所有会话 total 之和。当列表仅有 1 个会话时其条长 MUST 占满 100%;当有多个会话时各条 MUST 按各自占总和的比例渲染(例如比例 5:3:2 → 50% / 30% / 20%)。列表总和为 0 或空列表时条长 MUST 安全归零。

#### Scenario: 单会话占满

- **WHEN** 列表中仅有 1 个会话
- **THEN** 该会话用量条长度为 100%

#### Scenario: 多会话按比例

- **WHEN** 列表中有 3 个会话,total 比例为 5:3:2
- **THEN** 三条用量条长度分别为 50%、30%、20%

#### Scenario: 空列表或全零安全

- **WHEN** 列表为空或所有会话 total 之和为 0
- **THEN** 用量条长度归零,不产生非法宽度

### Requirement: 会话所属项目与分支记录

系统 SHALL 在会话维度记录中持久化该会话所属的项目名(projectName)与分支(branch),均为 best-effort 可选字段。各采集链路 MUST 在能解析到时填入:项目名取业务仓库 `package.json` 的 name(失败回退仓库目录名),分支取采集点已持有的当前分支。两字段 MUST 经会话用量查询视图透传给看板。缺失时(如非仓库会话 / 解析失败 / 上线前的历史记录)MUST 安全留空且 MUST NOT 阻断会话维度的 token 累加。看板会话行 SHALL 在已有元信息旁轻量展示非空的项目名与分支。

#### Scenario: 仓库会话记录项目与分支

- **WHEN** 会话发生在某 git 业务仓库内,采集点解析出 gitRoot 与分支
- **THEN** 该会话记录保存 projectName(取 package.json name 或目录名)与 branch,并经查询视图返回,看板会话行展示它们

#### Scenario: 非仓库会话安全留空

- **WHEN** 会话不在 git 仓库内或无法解析项目 / 分支
- **THEN** 该会话 projectName 与 branch 留空,token 累加正常进行,看板对空字段不渲染对应标签

#### Scenario: 历史记录字段留空兼容

- **WHEN** 看板查询到本能力上线前写入、无 projectName / branch 的旧会话记录
- **THEN** 系统正常返回该记录,对应字段为空,不报错
