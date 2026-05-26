/**
 * echarts 按需注册入口。
 *
 * 在这里集中 `use(...)`,所有图表组件 import 此模块即获得已注册的 chart core。
 * 这样 manualChunks 才能把 echarts 拆出来共享。
 */

import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent
} from 'echarts/components'

// 仅注册当前 UI 真正使用到的 chart / component,显式控制 bundle 体积.
// 后续若新增 ActivityHeatmap / Bar / Scatter 等,再补回 import + use 注册.
use([
  CanvasRenderer,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent
])

export { default as VChart } from 'vue-echarts'
export type { ECOption } from './types'
