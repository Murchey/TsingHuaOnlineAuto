# 旧脚本 0.4.4.23 分析

检查日期：2026-10-27。输入为用户提供的 `清华社视听说修改版 - 自动答题-0.4.4.23.txt`，约 380 KB。保留原始文件，未改写其内容或已安装扩展。

## 两套页面必须分别适配

0.1.1 现场确认用户课程仍在 Angular 7.2.16 的 `/legacy/course-study-student/...`。此前只检查公开 Vue 首页，不能据此断言旧选择器在用户课程中全部失效。`lib-*` 组件仍存在。`0.1.0` 没识别到该旧版路由，是本助手检测失败的直接原因。

旧脚本第 595–925 行以 `.lib-*`、`.wy-course-*`、`.lib-single-box` 等旧 DOM 为基础，第 961 行使用 `$('.page-next')[1].click()`；新版 Vue 阅读器使用 `.unit-exercise-preview`、`.exercise-actions`、`.choices`、`span.zty-exercise-item-fill-blank-do` 等结构，并按内容块一次提交多道题。

第 429–458 行监听 `/tsenglish/resource/getUploadToken`、`/tsenglish/exercise/recordDetail`、`/tsenglish/exercise/submit`。新版 Vue 阅读器的学生读取和提交方法分别调用 `/question/echo/content/{contentId}/answer` 与 `/question/submit/answer`，旧记录拦截无法提供新版数据。

现场旧版任务组件当前正常读取为 `/tsenglish/exercise/record_for_detail`，已经不等于旧脚本匹配的 `recordDetail`；旧选择器仍存在也不能证明旧数据拦截继续有效。新版与旧版均需按实际页面独立验证。

## 面板不出现的候选原因

1. **初始化异常会阻止注册面板回调。** 第 972 行先执行 `initHook()`，第 973 行才注册 `window.load`。前者访问 `unsafeWindow`，并改写 `Aliplayer`、`chivox`、`XMLHttpRequest`、`WebSocket`。对象不存在、属性不可重定义或脚本环境不兼容，都可能在注册回调前抛错。元数据声明了 GM 方法，但没有显式声明 `unsafeWindow`；是否因此失败取决于具体管理器环境，需要控制台确认。
2. **错过 load 事件。** 只调用 `window.addEventListener('load', pageFullyLoaded)`，没有检查 `document.readyState`。如果管理器或外部依赖导致脚本在 load 后注入，面板不会再挂载。SPA 切换路由也不会重发整个页面的 load。
3. **挂载和可见性。** 第 979 行将面板插在 `body` 后，第 1073 行直接隐藏面板且无恢复入口；没有挂载存活检查或 SPA 重建处理。
4. **外部依赖。** 依赖 `https://cdn.staticfile.org/jquery/3.5.1/jquery.min.js`。本次直接请求返回 HTTP 200、JavaScript 内容，不能把此次故障确定为 CDN 故障；浏览器内请求是否成功仍未验证。

**当前已查看登录页控制台，但尚未复现原 0.4.4.23 脚本自己的启动异常，不能把上述候选之一宣布为该旧脚本面板消失的唯一原因。现场网站本身也有练习 HTTP 530、Angular 布局异常及客服 HTTP 503 历史日志。**

## 新版对应处理

- 不依赖外部脚本，不改写网站播放器、SDK、XHR 或 WebSocket。
- 面板独立于题目识别挂载；支持早期注入、晚于 load 注入、路由变化及面板恢复。
- 使用 Shadow DOM 隔离样式，提供收起按钮、键盘恢复入口与本地诊断导出。
- 新版访问生产 Vue 根 VNode；旧版访问已挂载的 Angular ViewEngine 组件。两套适配独立选择，未知版本明确提示。
- 旧脚本面板或已知网络钩子仍存在时，提示停用并刷新后再运行，避免两个自动化流程同时提交。
