# 糖果梦工具箱

Vue 3 纯前端工具站，当前包含：

- Base64 加解密
- JSON 格式化、压缩、校验

## 性能原则

- Vue 3 + Vite，首期不接服务器，不请求业务 API。
- 不引入 UI 组件库、图标库、远程字体或远程 CDN。
- 大文本不放进 Vue 响应式状态，textarea 使用 DOM ref 读取和写入。
- 大文本处理优先走 Web Worker，失败时自动回退到主线程。
- 输入内容不写入 localStorage，避免大文本输入造成同步存储卡顿。

## 本地预览

```bash
npm install
npm run dev
```

默认地址是 `http://localhost:4173/`。
