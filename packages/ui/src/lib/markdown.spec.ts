import { describe, expect, it } from 'vitest'

import { renderMarkdown, renderMarkdownInline } from './markdown'

describe('renderMarkdown', () => {
  it('渲染粗体 / 列表 / 引用', () => {
    const out = renderMarkdown(`**bold** 和列表:

- a
- b

> 引用一行`)
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>a</li>')
    expect(out).toContain('<blockquote>')
  })

  it('禁用 raw html(防 XSS):<script> 被 escape 为 &lt;script&gt; 不可执行', () => {
    const out = renderMarkdown(`<script>alert(1)</script>正常文本`)
    // raw html 被禁用 → 标签字符被 escape 成实体,浏览器不会当 HTML 解析
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&lt;/script&gt;')
    expect(out).toContain('正常文本')
  })

  it('禁用 image:![alt](url) 不渲染 <img>(可降级为 a 链接,但不会发起加载)', () => {
    const out = renderMarkdown(`![照片](https://evil.example.com/track.gif)`)
    expect(out).not.toContain('<img')
    // disable('image') 后 markdown-it 把 ! 当字面字符,后续 [照片](url) 仍按 link 渲染
    // 但 <img> 被禁用 = 浏览器不会主动加载 url(不存在 tracking pixel 风险)
  })

  it('linkify:把裸 URL 自动变 a 标签 + target=_blank + rel=noopener', () => {
    const out = renderMarkdown('参考 https://example.com 文档')
    expect(out).toContain('<a')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('breaks=true:单换行渲染为 <br>', () => {
    const out = renderMarkdown('第一行\n第二行')
    expect(out).toContain('第一行')
    expect(out).toContain('<br')
    expect(out).toContain('第二行')
  })

  it('显式 a 标签也被强制添加 target=_blank + rel=noopener(覆盖 link_open 规则)', () => {
    const out = renderMarkdown('[click](https://x.example.com)')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('空 / 非字符串输入返回空串', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   ')).toBe('')
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown(undefined)).toBe('')
    expect(renderMarkdown(123)).toBe('')
  })

  it('javascript: 链接被 markdown-it validateLink 拒绝渲染为 a 标签(降级为纯文本)', () => {
    const out = renderMarkdown('[evil](javascript:alert(1))')
    // markdown-it 默认 validateLink 不允许 javascript: 协议 → 整段不构成 link,作为纯文本保留
    expect(out).not.toContain('href="javascript:')
    expect(out).not.toContain('<a ')
  })

  it('代码块 / 行内 code 正常输出 <pre>/<code>', () => {
    const out = renderMarkdown('行内 `x` 与代码块:\n\n```\nfoo()\n```')
    expect(out).toContain('<code>x</code>')
    expect(out).toContain('<pre>')
    expect(out).toContain('foo()')
  })
})

describe('renderMarkdownInline', () => {
  it('inline 模式不输出 <p> 包裹', () => {
    const out = renderMarkdownInline('**bold**')
    expect(out).toBe('<strong>bold</strong>')
    expect(out).not.toContain('<p>')
  })

  it('空 / 非字符串输入返回空串', () => {
    expect(renderMarkdownInline('')).toBe('')
    expect(renderMarkdownInline(undefined)).toBe('')
  })
})
