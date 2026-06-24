## MODIFIED Requirements

### Requirement: 会话标题去标签展示

系统 SHALL 在展示会话标题时,只呈现用户真实输入内容,剥离 IDE 注入的包裹标签,并跳过无意义素材取首条真实输入。当首条用户输入文本含 `<user_query>...</user_query>` 包裹时,系统 MUST 提取其内部正文作为标题素材;无该包裹时,系统 MUST 移除已知噪声标签块(如 `<timestamp>`、`<cursor_commands>`、`<system_reminder>`、`<attached_files>` 等,含其内容)并剥离其余残留的尖括号标签标记,保留标签之间的可读文本。采集侧逐条扫描候选用户输入时,若某条素材经上述清洗后为空、或清洗后仅为纯占位文本(如 `[Image]` / `[图片]` 等已知图片占位)且无其它可读正文,系统 MUST 跳过该条并继续向后取下一条用户输入作为标题素材;直至取到首条「清洗后非空且非纯占位」的真实输入,或扫描完候选范围仍取不到时安全留空(展示侧回退到工具名 + 短会话 ID)。该清洗与跳过逻辑 MUST 在采集写入侧与展示读取侧双侧生效,使既有已落盘的「带标签脏标题 / 纯占位标题」在展示时同样被清洗(无需数据迁移),且 MUST 幂等。清洗后仍按既有上限折行压一行并截断。

#### Scenario: 提取 user_query 正文

- **WHEN** 会话首条用户输入为 `<timestamp>...</timestamp> <user_query> 你好</user_query>`
- **THEN** 会话标题展示为 `你好`,不含任何 `<timestamp>` / `<user_query>` 标签

#### Scenario: 剥离噪声标签块

- **WHEN** 首条用户输入含 `<timestamp>` 等噪声标签块但无 `<user_query>` 包裹
- **THEN** 标题移除噪声标签块及其内容,仅保留用户可读文本

#### Scenario: 跳过清洗后为空的首条素材

- **WHEN** 会话首条用户输入清洗后为空(纯标签 / 纯噪声),而后续存在一条真实文本输入 `修复登录 bug`
- **THEN** 系统跳过空素材,取 `修复登录 bug` 作为标题,而非退化为短会话 ID

#### Scenario: 跳过纯图片占位素材

- **WHEN** 会话首条用户输入清洗后仅为 `[Image]`(图片占位、无其它可读正文),而后续存在真实文本输入
- **THEN** 系统跳过 `[Image]`,取后续真实输入作为标题

#### Scenario: 仅有占位无后续真实输入时安全留空

- **WHEN** 会话全部候选用户输入清洗后均为空或纯占位
- **THEN** 会话标题留空,展示侧回退为 `Cursor · <短会话ID>` 等兜底标识

#### Scenario: 清洗历史脏标题

- **WHEN** 会话记录中已落盘的 `title` 仍带包裹标签或为纯占位文本(在本能力上线前写入)
- **THEN** 看板展示该会话时对标题做幂等清洗,呈现去标签后的内容(纯占位则视为空走兜底),且不改写落盘数据

#### Scenario: 不误删正常含尖括号文本

- **WHEN** 用户真实输入(经 user_query 提取后)本身包含成对尖括号片段(如代码泛型)
- **THEN** 系统在已取到 user_query 正文的情况下不再做全局标签剥离,保留该正文内容

### Requirement: 会话所属项目与分支记录

系统 SHALL 在会话维度记录中持久化该会话所属的项目名(projectName)与分支(branch),均为 best-effort 可选字段,并在看板会话行稳定展示非空值。各采集链路(Cursor hook / Claude transcript-watcher / Codex watcher)MUST 在能解析到时填入:项目名取业务仓库 `package.json` 的 name(失败回退仓库目录名),分支取采集点已持有的当前分支。两字段 MUST 经会话用量查询视图(`SessionUsageView`)透传给看板。看板会话行 SHALL 在已有元信息旁轻量展示非空的项目名与分支(各自独立标签);字段为空时 MUST NOT 渲染对应标签。缺失时(如非仓库会话 / 解析失败 / 上线前的历史记录)MUST 安全留空且 MUST NOT 阻断会话维度的 token 累加。

#### Scenario: 仓库会话记录并展示项目与分支

- **WHEN** 会话发生在某 git 业务仓库内,采集点解析出 gitRoot 与分支
- **THEN** 该会话记录保存 projectName(取 package.json name 或目录名)与 branch,经查询视图返回,且看板会话行在元信息区展示项目名与分支两个标签

#### Scenario: 三采集链路均填充

- **WHEN** 同一仓库分别经 Cursor、Claude Code、Codex 产生会话
- **THEN** 三类来源的会话记录在能解析到 gitRoot / branch 时均填入 projectName 与 branch

#### Scenario: 非仓库会话安全留空

- **WHEN** 会话不在 git 仓库内或无法解析项目 / 分支
- **THEN** 该会话 projectName 与 branch 留空,token 累加正常进行,看板对空字段不渲染对应标签

#### Scenario: 历史记录字段留空兼容

- **WHEN** 看板查询到本能力上线前写入、无 projectName / branch 的旧会话记录
- **THEN** 系统正常返回该记录,对应字段为空,不报错

## ADDED Requirements

### Requirement: 会话用量列表筛选与排序

看板会话用量板块 SHALL 提供下拉式(非平铺单选)的筛选与排序交互,并支持按所属项目筛选。排序 MUST 拆分为两个独立维度:「排序依据」=【用量高低】(对应查询 `sort=total`)或【记录时间】(对应 `sort=lastAt`),与「方向」=【升序】(`dir=asc`)或【降序】(`dir=desc`),默认【用量高低】+【降序】。筛选 MUST 提供三项下拉:「AI 平台」(全部 / Cursor / Claude / Codex)、「所属项目」(全部 / 当前数据中出现的项目名集合)、「时间范围」(近 7 天 / 近 30 天)。会话用量查询视图(`querySessions`)与 `/ai-productivity/session-usage` 端点 MUST 支持可选 `project` 过滤参数,按会话 `projectName` 精确匹配,使按项目筛选不受 top-N 截断影响;`project` 为空 / 缺省时不施加项目过滤(向后兼容)。「所属项目」下拉的可选项 MUST 由当前时间范围内的会话集合动态派生(无项目名的会话不产生选项),且当无任何带项目名的会话时该下拉 MAY 隐藏或仅含「全部」。任一筛选 / 排序变更 MUST 即时重查并刷新列表。

#### Scenario: 按记录时间排序

- **WHEN** 用户选择「排序依据=记录时间」「方向=降序」
- **THEN** 列表以会话最近活跃时间(lastAt)倒序返回并渲染

#### Scenario: 排序依据与方向独立组合

- **WHEN** 用户选择「排序依据=用量高低」「方向=升序」
- **THEN** 列表以有效用量合计(total)升序返回(用量低→高)

#### Scenario: 按所属项目筛选(服务端)

- **WHEN** 用户在「所属项目」下拉选择某项目名 `acme-web`
- **THEN** 端点以 `project=acme-web` 查询,仅返回 projectName 为 `acme-web` 的会话,且不被未过滤前的 top-N 截断挤掉

#### Scenario: 项目下拉选项动态派生

- **WHEN** 当前时间范围内会话涉及项目 `acme-web` 与 `acme-api`,另有部分会话无项目名
- **THEN** 「所属项目」下拉提供【全部 / acme-web / acme-api】选项,无项目名的会话不产生选项

#### Scenario: project 参数缺省向后兼容

- **WHEN** 请求未携带 `project` 参数(或为空)
- **THEN** 查询不施加项目过滤,返回结果与本能力上线前一致

#### Scenario: AI 平台与时间范围下拉筛选

- **WHEN** 用户选择「AI 平台=Cursor」「时间范围=近 30 天」
- **THEN** 列表仅返回近 30 天内 source 为 cursor 的会话
