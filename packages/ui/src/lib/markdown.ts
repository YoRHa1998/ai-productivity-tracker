import MarkdownIt from 'markdown-it'

/**
 * v1.0.0-rc.23 复盘报告 markdown 渲染封装。
 *
 * 配置原则:
 * - `html: false`:禁用 raw HTML(防 XSS;LLM 推理产物视为不可信文本)
 * - `linkify: true`:自动把 URL 文本变 link
 * - `breaks: true`:单换行也作为 <br>(对话式文本更直观)
 * - `disable: ['image']`:禁用 ![alt](url) 图片渲染(避免 LLM 引入外部图片造成跟踪 / 加载失败)
 *
 * 安全口径:LLM 即便在文本中粘贴 `<script>` / `javascript:` 也不会造成 XSS,
 * 渲染产物仅含合法 markdown 子集 → HTML(p / strong / em / ul / li / blockquote / code / pre / a)。
 */
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false
})
md.disable(['image'])

/**
 * 把 a 标签强制加上 target=_blank + rel=noopener noreferrer,避免 LLM 写的链接劫持父页面。
 */
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const targetIdx = token.attrIndex('target')
  if (targetIdx < 0) {
    token.attrPush(['target', '_blank'])
  } else {
    token.attrs![targetIdx][1] = '_blank'
  }
  const relIdx = token.attrIndex('rel')
  if (relIdx < 0) {
    token.attrPush(['rel', 'noopener noreferrer'])
  } else {
    token.attrs![relIdx][1] = 'noopener noreferrer'
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/**
 * 把 markdown / plain text 渲染为 HTML 字符串,空 / 非字符串输入返回空串。
 *
 * 不带 sanitize 二次处理(`html: false` + 禁 image 已等价 sanitize):上层组件
 * 用 `v-html` 直接绑定本函数返回值即可,不会引入 XSS。
 */
export function renderMarkdown(text: unknown): string {
  if (typeof text !== 'string') return ''
  if (!text.trim()) return ''
  return md.render(text)
}

/**
 * 渲染单行(强制按 inline 解析,不会输出 <p> 包裹)。
 * 用于列表项 / 卡片标题等不希望出现块级元素的场景。
 */
export function renderMarkdownInline(text: unknown): string {
  if (typeof text !== 'string') return ''
  if (!text.trim()) return ''
  return md.renderInline(text)
}
