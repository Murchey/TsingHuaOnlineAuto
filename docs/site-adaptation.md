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

0.3.2 继续补齐旧版学生页：

- 对话填空 19（`LIB-FILL-BLANK-DIALOGUE-EXERCISE-CS-STUDY`）：`dialogueContents` 中 `type=2` 的项是空格，`fillBlanks[].id` 对应 `doRecord.answer[id].content`，页面可编辑元素 id 为 `a-<blankId>`。题目自带 `audioScript` 时，按空位相邻文本在原文中定位并逐字还原；只有原文无法完整解析时才交给 AI。
- 分类拖拽 11（`LIB-DRAG-DROP-MANY-EXERCISE-CS-STUDY`）：`drag[]` 是目标区，`dragged[]` 是待分类项，`doRecord.answer[targetId].choiceIds` 保存分配。适配器先重置目标桶，再按 AI 结果调用原站 `drag({ previousContainer, container, item })` 与 `answerChange()`。
- 组合题 14/15/16/25：子题继承父题 `audioScript`，听力类子题无需重复 ASR。
- 页面偶发只渲染题干、不渲染作答控件时，`exerciseStatus` 会停在 0。适配器在 Angular Zone 内最多三次调用原站 `loadDoRecord()`；仍不可用时抛出 `NEEDS_RELOAD`，控制器在 `sessionStorage` 写入续跑标记后 `location.reload()`。面板启动后轮询发现练习并自动继续，最多 3 次，避免刷新死循环。
- 未经过 Rechallenge 却被右箭头带回已完成页面时，控制器以 `PAGE_CYCLE` 停止；真正的 Rechallenge 会清空“已见页面”集合，允许目标重做。
- 站点重置某关答案但保留 `submitNum`（服务器上没有任何完整作答）时，已校验 checkpoint 会自动清理并重新作答；服务器记录完全消失仍以 `RECORD_CHANGED` 暂停。
- MiMo ASR 使用 `/chat/completions`，user content 仅含 `input_audio`；OpenAI 兼容 ASR 仍走 multipart `/audio/transcriptions`。

0.4.4 修复填空 id 不一致：Unit 2 Clothing Goal 1 Vocabulary A 的 `fillBlanks` 中 group 16 为 `9becedc3-67c8-f378-ee0e-79102a0e5230`，但 `exercise.content` 的 type 2 项、DOM 输入框和 `exercise/submit` 实际使用 `...f377...`。旧逻辑按 `fillBlanks` 生成 answer/stem，提交返回 501“作答记录与习题不匹配”，belt 空位无法得分。`legacy-data.ts` 新增 `contentBlankIds`，按 group 取 content 项 id；type 19 同样按 group 对齐 dialogue 空位。图片题另保留 17 个已验证答案（T-shirt … pants），避免视觉歧义导致 6/7/8/11/13/14/15 错位。`fill()` 在精确 id 不存在时按渲染顺序取第 n 个 contenteditable，并把值别名到期望记录 id。

0.4.3 优化视频处理：Chivox 已占用多个硬件 AudioContext，继续 `new AudioContext()` 可能抛错；改用 `new OfflineAudioContext(1, 1, 16000)` 的 `decodeAudioData`，浏览器原生重采样到 16 kHz，`videoToPcm` 只做单声道下混，不再做逐样本插值。Base64 编码改为每 32 KB `String.fromCharCode.apply`，5.6 MB 分块不再长时间占用主线程。媒体下载使用独立 `MEDIA_TIMEOUT_MS=600000`，并限制 200 MB 与 20 分钟，超限抛出 `MEDIA_TOO_LARGE`/`VIDEO_TOO_LONG` 明确提示手动作答。`LegacyAdapter.onProgress` 由控制器绑定面板消息，依次显示“正在下载视频题目资源…”“视频已下载（N MB），正在处理音轨…”“正在转写视频音频第 i/n 段…”；分块间 `yieldMainThread()`，组合题共用视频通过 `videoJobs` 并发去重。

0.4.2 修复看图填词/标注题：旧版 type 3 的 `fillBlanks[].group` 是图片中的编号，`content.paragraphs` 只有空位而没有句子文本。`legacy-data.ts` 现在保留 `extension.blanks[].group`；`aiTask` 把 `number` 写入空位 JSON，并识别“仅有空位、无周围句子”的图片标注题（`imageOnlyBlanks`）。`cropImage` 自动把原图裁成左侧/中部/右侧 3 张重叠放大图（3x），让编号线端点更清晰；提示词要求模型先读取图片词库、为每个编号写 `observations`，再返回 `words` 和 `fill`；`validateAiValue` 用 `result.words` 校验答案必须来自词库、重复次数不能超过词库本身，失败自动重试一次。`answerWithAi` 对 MiMo 设置 `thinking: {type:"disabled"}` 与 `max_completion_tokens: 4000`，避免深度思考耗尽预算导致 content 为空。

0.4.1 修复闯关结果弹窗：站点的第二个按钮文本由分数决定，可能是 `Review` 或 `Continue`；`Continue` 触发 `closeChallengeModal(3/4)` → `reChallengeChange` → `loadPage()`，会刷新目录/解锁下一关，而右上角关闭只发出 2，不等价。适配器现在优先查找并点击 `Continue`/`继续` 按钮，等待弹窗关闭和目录刷新；课程页顶部的 `button.btn`“继续学习”（`continueStudy()` → `router.navigate(course.continueKey)`，带 `dis-continue-btn` 时跳过）也会优先点击；只有没有 Continue 时才沿用 Rechallenge/关闭逻辑。失败弹窗如果只有 Continue（例如已有 `lastScore`），也会点击 Continue，不再误报“未找到 Rechallenge 按钮”。

控制器把 `PAGE_CHANGED`/`STALE_PAGE` 与 `NEEDS_RELOAD` 一并纳入自动恢复：写入 `sessionStorage` 续跑标记后 `location.reload()`，面板重新 `discover()` 当前练习并自动开始，最多 3 次。

0.4.0 处理视频题：旧版 `exercise.video` 是资源 ID，`LIB-EXERCISE-RES-SHOW` 以 `type=1` 渲染，`getResUrl(id,1)` 解析为 MP4（第 3447e 题为 `vod.tsinghuaelt.com` 签名 URL，21 MB、140.959 秒，页面直接 `fetch` 返回 200）。适配器用 `fetchMedia`（优先 GM `arraybuffer`）下载视频，`AudioContext.decodeAudioData` 在浏览器内解码 MP4 音轨，重采样为 16 kHz 单声道 PCM，再写入 WAV；因 MiMo ASR 只接受 wav/mp3 且 Base64 上限 10 MB，按 5.6 MB PCM 分块调用现有 `transcribeAudio`，拼接转写。组合题 14/15/16/25 的子题继承父题 `video`，同一视频只转写一次。填空提示新增 `blankText`：克隆叶子组件 DOM，把 `id="a-<blankId>"` 的 contenteditable 替换为 `[[BLANK:<blankId>]]`，让模型看到空位在句中的准确位置；否则单空题容易被模型填成其他步骤。全流程不依赖 ffmpeg、wasm 或外部 CDN。

0.3.9 修复 type 10 一对一匹配的 AI 结果校验：模型常返回右侧选项原文、`a/b/c` 标签、`1/2/3` 序号或按位置排列的数组，适配器先用 `id` 精确匹配，再用去掉标签的原文、标签、序号和唯一包含关系反查 `dragged[].id`；首次校验失败会把目标与选项清单附在重试提示中，并允许题目存在未使用的干扰选项。

0.3.8 处理看图写话与听力+图片：旧版 `exercise.image` 是逗号分隔的资源 ID，页面渲染为 `lib-exercise-res-show > .show-img > img`。适配器从叶子作答组件向上找到最近的含图包装层，优先收集已渲染图片的绝对 URL；没有 DOM 图片时才回退到资源 ID，并用 `getResUrl(id, 3)` 解析。图片下载后按字节识别 MIME、转 base64，按 OpenAI/MiMo 兼容的 `image_url: { url: "data:<mime>;base64,..." }` 发送，最多 4 张。听力题仍先 ASR（或使用题目 `audioScript`），再把转写、整页文本和图片一起交给模型；图片读取失败只提示模型按文本作答，不暂停整块练习。

## 新版 Vue

公开首页及其第一方资源：`/assets/textbook-reader-BwTC3IPT.js`、`/assets/src-CRr8PyXj.js`、`/assets/router-l05bPN5G.js`、`/assets/runtime-core.esm-bundler-DDWTrPxX.js`。文件名可能变化。

学生路由 `/course_center/reader/{student_course|public_course|textbook}/{id}`，支持 hash 路由。访问生产根 VNode，识别 `UnitExercisePreview`，限定学生／游客、用户模式和非教师审阅；不依赖开发构建专有组件标记。

正常加载回调 `onLoadExercise(contentId)` 的学生分支读取 `/question/echo/content/{contentId}/answer`，字段为 `questionVOList/questionAnswerItemVOList/answerCount`。答案权限由网站决定，接口没有提供答案时暂停。

单／多选通过原生 input；填空等待 `data-te-fill-blank-container-inited` 后按空位 ID 输入并失焦；问答使用 textarea setter 与 input/change；提交点击 `.exercise-actions` 中 Submit。录音通过原站按钮和 SDK 获取真实音频结果，不覆盖评分。

## 共用状态与维护

执行读取、整块预检、填写／录音、提交、重新读取核对。修改前检查取消信号、当前路由、当前组件和旧脚本冲突。未知题型或答案缺失在预检时暂停。

提交前写入只含标识、结构及作答一致性指纹、提交次数、状态和时间的本地记录。指纹用于一致性检查，不是密码学认证。未知结果保持待核对状态，不自动重试。Web Locks 防止同配置多标签并发。诊断不包含题目／答案／Cookie，旧版路由中的账号段脱敏。

真实验证与未验证范围详见 `validation.md`；构建和合成测试不等于真实提交、上传或评分通过。
