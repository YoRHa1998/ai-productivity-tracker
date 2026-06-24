## MODIFIED Requirements

### Requirement: 会话用量查询端点

系统 SHALL 提供同源 HTTP 端点 `GET /ai-productivity/session-usage`,供看板查询会话维度用量。该端点 SHALL 支持时间范围(from / to)、工具(source)、所属项目(project)过滤,排序(默认按 token 合计倒序,可按最近活跃)与条数限制(默认 50),并在服务端完成排序与截断后返回。该端点 SHALL 额外支持可选的「按会话 key 集合」精确过滤参数 `keys`:每个 key 为 `${source}:${sessionId}` 形式,可一次传入多个;当提供 `keys` 时,系统 MUST 仅返回 key 命中集合内的会话记录,且该过滤 MUST 在排序与条数截断之前施加(使按指定 sessionId 集合反查不被 top-N 截断挤掉);`keys` 为空 / 缺省时 MUST NOT 施加该过滤(向后兼容)。`keys` 过滤 MUST 与既有 source / 时间范围 / project 过滤可叠加生效。该端点 MUST 归入 panel-origin 放行集合(同源免 token)。

#### Scenario: 默认按 token 倒序返回 Top 会话

- **WHEN** 看板请求 `GET /ai-productivity/session-usage` 不带排序参数
- **THEN** 系统返回按 token 合计倒序、截断到默认条数的会话列表

#### Scenario: 按工具与时间范围过滤

- **WHEN** 请求带 `source` 与 `from`/`to` 参数
- **THEN** 系统只返回该工具、且活跃时间落在范围内的会话记录

#### Scenario: 按会话 key 集合精确反查

- **WHEN** 请求带 `keys=["cursor:abc","codex:def"]`
- **THEN** 系统仅返回 key 为 `cursor:abc` 与 `codex:def` 的会话记录,且不被未过滤前的 top-N 截断挤掉;对集合内不存在的 key 安全忽略(不报错)

#### Scenario: keys 缺省向后兼容

- **WHEN** 请求未携带 `keys` 参数(或为空)
- **THEN** 查询不施加 key 集合过滤,返回结果与本能力上线前一致

#### Scenario: 同源放行

- **WHEN** 看板从 daemon 同源发起该 GET 请求
- **THEN** 端点按 panel-origin 规则放行,无需额外 token
