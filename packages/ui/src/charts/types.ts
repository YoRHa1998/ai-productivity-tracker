/**
 * echarts 配置项类型别名(简化使用)。
 * 直接 import EChartsOption 会引入完整定义文件,体积较大;实际使用中我们的
 * 配置都是手写 JSON,用宽松 Record 类型 + 局部断言即可。
 */
import type { ComposeOption } from 'echarts/core'
import type {
  BarSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
  RadarSeriesOption
} from 'echarts/charts'
import type {
  GridComponentOption,
  TooltipComponentOption,
  LegendComponentOption,
  TitleComponentOption,
  DatasetComponentOption,
  RadarComponentOption
} from 'echarts/components'

export type ECOption = ComposeOption<
  | LineSeriesOption
  | PieSeriesOption
  | RadarSeriesOption
  | BarSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | TitleComponentOption
  | DatasetComponentOption
  | RadarComponentOption
>
