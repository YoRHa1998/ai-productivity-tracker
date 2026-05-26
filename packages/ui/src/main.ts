import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

// UnoCSS runtime CSS(按需生成,vite 插件注入虚拟模块)
import 'virtual:uno.css'

// 设计系统:tokens(CSS 变量) → glass(玻璃材质) → element-overrides(EP 暗色适配)
import './styles/tokens.css'
import './styles/glass.css'
import './styles/element-overrides.css'

import App from './App.vue'
import { router } from './router'

const app = createApp(App)
app.use(ElementPlus)
app.use(router)
app.mount('#app')
