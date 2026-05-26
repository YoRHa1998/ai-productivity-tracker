<script setup lang="ts">
/**
 * 极光背景层。
 *
 * 纯 CSS(无 JS):4 个 radial-gradient 光斑 + 极慢漂移 keyframe + 顶部 grain 噪点。
 * fixed 定位 + pointer-events:none + z-index 0,挂在 AppShell 之外,主内容压在上面。
 *
 * 性能:transform/opacity 动画(GPU 友好),光斑 filter:blur(120px) 浏览器合成层独立绘制,
 * 60fps 稳定;不引入额外 JS 监听。
 *
 * 主题适配:深浅模式都用同一组光斑,但浅色模式整体透明度调低(在 style 内 :root[data-theme] 覆盖)。
 */
</script>

<template>
  <div class="aipt-bg" aria-hidden="true">
    <div class="aipt-bg__blob aipt-bg__blob--1"></div>
    <div class="aipt-bg__blob aipt-bg__blob--2"></div>
    <div class="aipt-bg__blob aipt-bg__blob--3"></div>
    <div class="aipt-bg__blob aipt-bg__blob--4"></div>
    <div class="aipt-bg__grid"></div>
    <div class="aipt-bg__noise"></div>
  </div>
</template>

<style scoped>
.aipt-bg {
  position: fixed;
  inset: 0;
  z-index: var(--aipt-z-bg);
  pointer-events: none;
  overflow: hidden;
  /* 顶部渐变改成偏蓝的深色,移除原紫底,跟新主色匹配 */
  background: radial-gradient(ellipse at 50% 0%, #0a1326 0%, var(--aipt-bg) 60%);
}

:root[data-theme='light'] .aipt-bg {
  background: radial-gradient(ellipse at 50% 0%, #ffffff 0%, var(--aipt-bg) 65%);
}

.aipt-bg__blob {
  position: absolute;
  border-radius: 50%;
  /* 整体透明度调低,饱和度降低,让淡蓝主色更突出且不晃眼 */
  filter: blur(120px) saturate(120%);
  opacity: 0.42;
  will-change: transform;
}

:root[data-theme='light'] .aipt-bg__blob {
  opacity: 0.24;
  filter: blur(150px) saturate(110%);
}

.aipt-bg__blob--1 {
  width: 620px;
  height: 620px;
  background: radial-gradient(circle, var(--aipt-aurora-1) 0%, transparent 70%);
  top: -180px;
  left: -120px;
  animation: aipt-bg-float-1 26s var(--aipt-easing-inout) infinite;
}

.aipt-bg__blob--2 {
  width: 540px;
  height: 540px;
  background: radial-gradient(circle, var(--aipt-aurora-2) 0%, transparent 70%);
  top: 20%;
  right: -120px;
  animation: aipt-bg-float-2 32s var(--aipt-easing-inout) infinite;
}

.aipt-bg__blob--3 {
  width: 480px;
  height: 480px;
  background: radial-gradient(circle, var(--aipt-aurora-3) 0%, transparent 70%);
  bottom: -160px;
  left: 25%;
  animation: aipt-bg-float-3 28s var(--aipt-easing-inout) infinite;
  opacity: 0.26;
}

.aipt-bg__blob--4 {
  width: 460px;
  height: 460px;
  background: radial-gradient(circle, var(--aipt-aurora-4) 0%, transparent 70%);
  bottom: 10%;
  right: 20%;
  animation: aipt-bg-float-4 34s var(--aipt-easing-inout) infinite;
  opacity: 0.28;
}

@keyframes aipt-bg-float-1 {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(60px, 80px) scale(1.1);
  }
}

@keyframes aipt-bg-float-2 {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(-90px, 50px) scale(1.08);
  }
}

@keyframes aipt-bg-float-3 {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(100px, -40px) scale(0.95);
  }
}

@keyframes aipt-bg-float-4 {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(-60px, -70px) scale(1.06);
  }
}

/* 极弱网格:科技感骨架,深色下可见 */
.aipt-bg__grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
  background-size: 48px 48px;
  background-position: -1px -1px;
  mask-image: radial-gradient(ellipse at center, #000 30%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse at center, #000 30%, transparent 80%);
}

:root[data-theme='light'] .aipt-bg__grid {
  background-image:
    linear-gradient(rgba(20, 23, 42, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(20, 23, 42, 0.04) 1px, transparent 1px);
}

/* SVG 纹理噪点(base64 内联,~700 bytes),给玻璃一点颗粒感 */
.aipt-bg__noise {
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
  opacity: 0.05;
  mix-blend-mode: overlay;
}

@media (prefers-reduced-motion: reduce) {
  .aipt-bg__blob {
    animation: none;
  }
}
</style>
