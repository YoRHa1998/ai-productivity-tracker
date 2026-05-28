/**
 * echarts 按需注册入口。
 *
 * 在这里集中 `use(...)`,所有图表组件 import 此模块即获得已注册的 chart core。
 * 这样 manualChunks 才能把 echarts 拆出来共享。
 */

import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart, PieChart, RadarChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent,
  RadarComponent
} from 'echarts/components'

// 仅注册当前 UI 真正使用到的 chart / component,显式控制 bundle 体积.
// v1.0.0-rc.23 复盘报告新增 RadarChart(雷达图)+ BarChart(阶段时间线条形)+ RadarComponent 坐标系。
use([
  CanvasRenderer,
  LineChart,
  PieChart,
  RadarChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent,
  RadarComponent
])

export { default as VChart } from 'vue-echarts'
export type { ECOption } from './types'
