# 当前站点适配记录

检查日期：2026-10-27。站点同时保留新版 Vue 阅读器与旧版 Angular 学习页。不能用公开首页技术栈推断登录课程版本。

## 旧版 Angular：本次现场修复

实际路径 `/legacy/course-study-student/{textbook}/{course}/{user}/{key}`，`app-root[ng-version="7.2.16"]`，当前第一方资源 `/legacy/main.4c93dc9c6da8077cd693.js`。旧版路由、组件及真实已提交习题已检查；完整响应不进仓库。

旧版生产环境 `ng.probe` 不提供组件，DOM 没有 Ivy 的 `__ngContext__`。适配器从当前已加载 webpack runtime 取得已运行的浏览器平台和 ApplicationRef，通过 `hostView/_view`、`componentView`、`viewContainer._embeddedViews` 遍历。桥接仅在指定版本、已挂载学生课程根、已缓存平台模块存在时运行；不启动新应用，不改写网站业务模块或网络。未知构建停止识别并给出诊断提示。

`app-course-task-stu` 的 `courseId/pageId` 确定当前练习；`role=4/status=1/flag=1或2` 且章节未关闭时允许运行。`exerciseStatus=1` 为可作答，2／3 为结果页，已有完整服务器记录直接跳过。

读取使用该组件的原生 HttpClient：`POST /tsenglish/exercise/record_for_detail?courseId=...&pageId=...&userId=...`，空对象请求体。与站点自身 `loadDoRecord()` 相同的学生读取；保留现有签名拦截器和会话，不手工生成签名。不会调用会覆盖本地编辑的 `loadDoRecord()`。返回 `object.exercise/doRecord/submitNum` 归一化为通用题目及作答记录。

旧版题目、选项及空位通常使用 UUID，不是纯数字。解析及本地恢复校验均支持这些标识。单／多选按 ID 调用原站 `answerChange`；普通填空和问答使用输入事件；24 型拖拽填空按 `fillBlanks[].id/answer` 与 `dragged[].id` 匹配，再调用原有删除和拖放事件处理器。在 Angular Zone 中执行组件回调。匹配不唯一时暂停。

提交只点击当前块唯一可见的 Submit 按钮。站点自行处理提交、签名和结果；脚本通过前述正常读取再次核对 `submitNum` 与逐题作答内容，失败不自动重发。20 型普通录音使用网站真实 MP3Recorder 和上传流程。

角色扮演/跟读 9 型有两种实际组件：带 `selectRole/start` 的角色选择变体，以及 `lib-listen-and-repeat-exercise-cs-study` 整段跟读变体。两种都从 `getWebUrlService.getResUrl(sentItem.audio, 2)` 解析原题 MP3。0.2.0 默认执行“原题音频 → Chivox 评测”：页面 `fetch` 下载音频，在录音器自己的 AudioContext 中解码，静音麦克风和扬声器，把 BufferSource 连接到 `Html5Recorder.node`，再通过 `speechService.startSentence(text, duration)` 触发原站评测。Chivox 返回真实分数和稳定 `recordAudio` 后写回 `doRecord.answer` 并触发 `dataChange()`。

角色选择变体只处理所选角色句子；跟读变体处理全部句子。原题缺少音频时暂停，不伪造分数。面板另保留“原题音频直填（不评分）”和“真实麦克风”排障模式。TTS、AI、ASR 分别使用独立设置；TTS 默认 MiMo，也可切换 OpenAI 兼容接口。其他旧版评测变体继续暂停。

`legacy_18` 是角色扮演题型：`LIB-ROLE-PLAY-EXERCISE-CS-STUDY` 提供 `selectRole/start/dataChange`，`doRecord` 含 `roleId` 和 `saSentScore`。0.2.1 选择角色后只处理该角色的 `sentItems`，逐句调用 MiMo TTS（`mimo-v2.5-tts`，可配置模型/音色/Base/Key），把返回的 MP3 解码后交给同一个 `scoreWithChivox` 录音注入器，取得真实评分和 Chivox `recordAudio`，写回 `doRecord.answer`，先调用原站 `start()` 完成角色选择和倒计时，启动阶段临时屏蔽 `changeAudioUrl()` 的自动麦克风录音；随后逐句 TTS→Chivox，最后关闭角色选择遮罩并触发 `dataChange()`。TTS Key 只保存在当前标签页会话；缺少 Key 时暂停，不退回麦克风。

0.2.2 起脚本同时申请 `GM_xmlhttpRequest` 和 `unsafeWindow`。用户脚本管理器在授予 GM API 后可能把脚本放入隔离沙箱；沙箱内的 `window.webpackJsonp` 与 `window.ng` 不等于页面对象，直接访问会得到 0 个组件。`legacy-angular.ts` 现在优先使用 `unsafeWindow`（并兼容其挂在 `window.unsafeWindow` 的情况）读取页面 document、`ng.coreTokens.ApplicationRef` 和 webpack runtime。诊断仍会显示组件数；若仍为 0，应检查脚本管理器是否提供 `unsafeWindow`。

0.3.0 的 API 设置不再绑定 MiMo：AI Chat 与 ASR 使用独立 OpenAI 兼容 Base/Key/Model；TTS 提供 MiMo 和 OpenAI `/audio/speech` 两种提供方，默认 MiMo。听力题从练习数据提取 `audio/audios/audioList/listenAudio` 等资源，经 `getResUrl` 下载后调用 ASR `/audio/transcriptions`，转写文本与页面文本、选项、空位一起交给 AI。AI 答题启用时允许页面答案缺失，由 AI 生成后仍走原有控件与提交核对。连续答题是独立设置，开启后每块完成调用原站下一页/下一题。

type 8 实际为 `LIB-ORAL-BRIEF-EXERCISE-CS-STUDY` 口语简答，不是 textarea 写作。其 `doRecord.answer` 是 VOD 音频 ID，`ossOrVod=2`。0.3.1 使用 AI 生成 2-4 句英语回答，TTS 合成 MP3，再调用原站 `vodUploadService.vodStartUpload({name, blob}, true)`，通过 `onVodComplete` 取 ID 并写回 `doRecord`。页面结果出现“闯关失败”弹窗时，`next()` 抛出 `GOAL_FAILED` 并暂停，避免右箭头被弹窗吞掉后卡住；自动 Rechallenge 尚未启用。

## 新版 Vue

公开首页及其第一方资源：`/assets/textbook-reader-BwTC3IPT.js`、`/assets/src-CRr8PyXj.js`、`/assets/router-l05bPN5G.js`、`/assets/runtime-core.esm-bundler-DDWTrPxX.js`。文件名可能变化。

学生路由 `/course_center/reader/{student_course|public_course|textbook}/{id}`，支持 hash 路由。访问生产根 VNode，识别 `UnitExercisePreview`，限定学生／游客、用户模式和非教师审阅；不依赖开发构建专有组件标记。

正常加载回调 `onLoadExercise(contentId)` 的学生分支读取 `/question/echo/content/{contentId}/answer`，字段为 `questionVOList/questionAnswerItemVOList/answerCount`。答案权限由网站决定，接口没有提供答案时暂停。

单／多选通过原生 input；填空等待 `data-te-fill-blank-container-inited` 后按空位 ID 输入并失焦；问答使用 textarea setter 与 input/change；提交点击 `.exercise-actions` 中 Submit。录音通过原站按钮和 SDK 获取真实音频结果，不覆盖评分。

## 共用状态与维护

执行读取、整块预检、填写／录音、提交、重新读取核对。修改前检查取消信号、当前路由、当前组件和旧脚本冲突。未知题型或答案缺失在预检时暂停。

提交前写入只含标识、结构及作答一致性指纹、提交次数、状态和时间的本地记录。指纹用于一致性检查，不是密码学认证。未知结果保持待核对状态，不自动重试。Web Locks 防止同配置多标签并发。诊断不包含题目／答案／Cookie，旧版路由中的账号段脱敏。

真实验证与未验证范围详见 `validation.md`；构建和合成测试不等于真实提交、上传或评分通过。
