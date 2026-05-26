<script setup lang="ts">
import AppShell from './layout/AppShell.vue'
import { useTheme } from './composables/useTheme'

// 顶层引入一次,初始化 <html data-theme> 与系统主题监听
useTheme()
</script>

<template>
  <AppShell />
</template>

<style>
/*
 * 全局基础样式已迁到 src/styles/tokens.css(html/body/#app reset 与字体)。
 * App.vue 不再持有任何视觉规则,改由 AppShell + tokens + glass 共同表达。
 */
</style>
