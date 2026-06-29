## 1. 统一时间筛选状态

- [x] 1.1 在 `AiUsageTab.vue` 新增 `rangeDays = ref<1 | 7 | 30>(...)` 与持久化键 `aipt:ai-usage:range-days`,实现 `readPersistedRange()`(非法/读不到回退默认 `7`)与对应 `watch` 写盘(try/catch 静默降级)
- [x] 1.2 删除常量 `const DAYS = 14`,所有引用改用 `rangeDays.value`
- [x] 1.3 删除会话模块本地 `sessionRangeDays` ref,`sessionFromIso()` 改读 `rangeDays.value`
- [x] 1.4 新增 `rangeLabel` computed(`1→当天 / 7→近 7 天 / 30→近 30 天`)

## 2. 三模块联动

- [x] 2.1 `load()` 改为 `fetchAiUsage(rangeDays.value)`
- [x] 2.2 汇总卡片 `todayCards` 改为对 `data.series` 各 source 的 `tokenOf` 与 `turns` 求和(范围合计),不再读 `data.today`
- [x] 2.3 `cardTokenUnit` 改用 `rangeLabel`(合并缓存读取时追加「(含缓存读取)」),趋势图 `chartSubtitle` 中写死的「近 14 天」改为随 `rangeLabel` 动态
- [x] 2.4 新增 `watch(rangeDays, ...)`:复位 `currentPage = 1`,串行触发 `load()` + `loadProjectOptions()` + `loadSessions()`;确认与既有 `watch([sessionSource, ...])` 不产生重复请求

## 3. 模板与样式

- [x] 3.1 在页面 header(`.aip-usage__heading-actions` 区或紧随 header 的筛选行)新增 `ElRadioGroup` + 三个 `ElRadioButton`(当天 / 近 7 天 / 近 30 天)绑定 `rangeDays`
- [x] 3.2 删除会话明细板块内的「时间范围」`ElSelect`(及其多余样式),保留 AI 平台 / 所属项目 / 排序下拉
- [x] 3.3 更新页面副标题文案(原「当天与近 14 天」)使其不再写死天数,与统一筛选语义一致

## 4. 验证与回归

- [ ] 4.1 手动验证:切换三档,卡片(范围合计 + 单位文案)、趋势图(天数 + 副标题)、会话列表(`from` + 项目下拉)三块同步刷新;刷新页面后选择被持久化
- [ ] 4.2 验证「当天」档:卡片数值等于原 today 口径、趋势图单点正常渲染、会话列表 `from` = 今天 00:00
- [x] 4.3 跑回归:`pnpm test && pnpm lint && pnpm format:check && pnpm typecheck`
- [x] 4.4 `pnpm --filter @ai-productivity-tracker/ui build` 构建看板产物,daemon 静态托管下刷新自检
