# 验证记录

日期：2026-10-27，版本 0.3.1。

## 真实浏览器

通过 Windows UI Automation 使用用户已打开的浏览器与 DevTools。用户给出的 PID 7188 是 GPU 子进程，其主窗口所属进程为 30568；没有重新启动浏览器、开启远程调试或改写浏览器配置。

现场发现：

- 实际课程位于 `/legacy/course-study-student/[redacted]`，Angular 7.2.16；0.1.0 的 Vue 阅读器路由不匹配，构成检测失败的直接原因。
- `ng.probe` 存在但生产环境返回空；通过当前已加载的 webpack 运行时、已有平台和 ApplicationRef 遍历 ViewEngine 组件可正常读取练习。
- 0.1.1 构建产物临时注入成功，面板版本 0.1.1；发现 33 个旧版组件、1 个当前练习块，未检测到旧脚本冲突。
- 实际点击助手“开始”，正常学生读取返回已有完整作答，日志 `ALREADY_SAVED`，最终完成 1/1；未重做、未点击 Submit／ReChallenge。
- 返回原题并实际刷新网页，再注入最终分发构建，仍识别 1 个练习块；服务器原有答案仍存在，再次进入 `ALREADY_SAVED`，完成 1/1。
- 通过原站左右翻页按钮检查后续页面，拖拽填空 24、组合题 14／25 可继续发现；页面包含已提交状态 2／3。测试结束返回最初的练习。
- 初始控制台历史存在一次练习请求 HTTP 530 和第三方客服 HTTP 503。稍后本助手的正常练习读取成功，不能据此断言网站接口持续不可用。实现中遇到读取失败会显示具体 HTTP 状态并暂停。

以上证明旧版识别、读取、保持既有答案和页面切换发现有效。0.1.4 之后又在真实题目执行了新的录音提交，结果见下。

## 0.1.4 历史：角色扮演示例直填

对照旧版构建确认：角色扮演 9 型 `sentItems` 可能同时包含双方角色，但原站只初始化所选角色的录音答案；另一角色句子只播放示例。0.1.4 归一化 `idx` 为句子 ID、只处理所选角色，并可把示例音频 URL 直接写入 `recordAudio`。该模式不生成评分，仅用于绕过麦克风；后续已被原题音频 Chivox 评测取代为默认行为。

## 0.2.0 原题音频 → Chivox → 服务器

- 实际题目组件为 `lib-listen-and-repeat-exercise-cs-study`，不是带 `selectRole/start` 的角色选择变体；它有 7 个句子答案槽和原生 `sayBy`，旧实现因此误报“缺少角色、句子或启动控件”。
- 通过控制台把原题 MP3 解码为 AudioBuffer，接入原站 `Html5Recorder` 的 ScriptProcessor 输入，并静音扬声器与麦克风；7 句均得到 Chivox 真实评分，分数为 89、95、89、96、94、94、95。
- 每句得到稳定 Chivox `recordAudio` URL。提交后服务器保存了 7 条作答，页面 `exerciseStatus=2`，本地记录分 `13.18`。这证明“原题音频 → Chivox → 服务器”链路可用。
- 0.2.0 把该链路写入 `src/chivox.ts`，默认模式为 `original`；原题音频缺失时暂停，不伪造分数。`src/legacy-adapter.ts` 的自动化测试用 mock 验证了下载、评分、写回和 `dataChange()`。
- 连续读取 `record_for_detail` 在同一秒内会间歇返回 HTTP 530；间隔 350ms 的连续请求可复现，间隔 1.5s 可成功。适配器最多重试 3 次（1.2s/2.4s），只重试 HTTP 530。
- 0.2.0 时 MiMo 请求接口尚未接入业务流程；0.3.0 已拆分为 `src/api.ts` 的通用 AI/ASR/TTS 接口，接口测试使用模拟响应。

## 0.2.1 legacy_18 角色扮演 TTS

- 实际第 9/47 题为 `legacy_18`，组件是 `LIB-ROLE-PLAY-EXERCISE-CS-STUDY`，提供 `selectRole/start/dataChange`；`doRecord` 有 `roleId` 和 `saSentScore`，初始 `answer` 为空。
- 0.2.1 选择角色后只处理该角色 `sentItems`，逐句调用 MiMo TTS，返回 MP3 后复用 `scoreWithChivox` 注入 Chivox，取得真实评分和 `recordAudio`，写回 `doRecord.answer`，最后关闭角色选择遮罩。
- MiMo Key/Base/TTS 模型/音色在面板配置；Key 只存当前标签页 `sessionStorage`。缺少 Key 时暂停，不退回麦克风。
- 自动化测试覆盖 `legacy_18` 解析、roleId、所选角色完成判定、TTS 调用、Chivox 写回和缺少 Key 暂停；**尚未用真实 MiMo API Key 在浏览器中调用**。

**尚未完成：用真实 MiMo Key 在第 9/47 题或同类新题上跑完整面板、Submit、结果页和刷新持久性复验。**

## 0.2.2 隔离沙箱组件桥接

用户导出的 0.2.1 诊断显示 route 正常、`legacyComponentCount=0`、`componentCount=0`、`units=[]`。现场确认页面仍为 Angular 7.2.16、主脚本哈希未变、`webpackJsonp` 与 `ng.coreTokens.ApplicationRef` 均存在。将 0.2.1 直接注入页面上下文可发现 32 个组件，说明桥接代码本身正常；差异来自新增 `@grant GM_xmlhttpRequest` 后脚本管理器使用隔离沙箱，沙箱内的 `window` 不是页面 window。

0.2.2 的修复：

- 构建元数据增加 `@grant unsafeWindow`。
- `legacy-angular.ts` 优先用 `unsafeWindow` 读取页面 document、`webpackJsonp` 和 `ng`，并兼容 `unsafeWindow` 挂在 `window` 上的管理器。
- `main.ts` 的实例 Symbol 和 `pageshow/pagehide` 也绑定到页面 window，避免隔离上下文重复注入或漏恢复。
- 现场在页面设置 `window.unsafeWindow=window` 后注入 0.2.2，仍发现 32 个组件、1 个练习块，`legacyComponentCount` 不再为 0。

**尚未完成：在用户实际脚本管理器中更新 0.2.2 后刷新，重新导出诊断确认页面组件可见。**

## 0.3.0 API、ASR、连续答题与 legacy_18 启动

- 面板新增可见且默认展开的“API 与连续答题设置”：连续答题、AI 答题、AI Base/Key/Model、ASR Base/Key/Model、TTS 提供方/Base/Key/Model/音色。Key 仅存当前标签页 `sessionStorage`。
- AI 与 ASR 使用独立 OpenAI 兼容接口；TTS 支持 MiMo `/chat/completions`（默认）和 OpenAI 兼容 `/audio/speech`。
- 旧版题目数据增加 `audio` 收集；启用 AI 答题时，若题目有音频则先调用 ASR `/audio/transcriptions`，ASR 转写与页面文本、选项、空位一起交给 AI。AI 答题启用时允许页面答案缺失，由 AI 生成后继续走原控件和提交核对。
- 连续答题由独立 `continuous` 设置控制；开启时每块完成调用原站下一页/下一题，关闭时只处理当前选择。默认开启以保留旧行为。
- `legacy_18` 现在先 `selectRole`，再调用原站 `start()` 完成倒计时和所选角色答案初始化；启动期间临时屏蔽 `changeAudioUrl()` 自动麦克风录音，随后才做 TTS→Chivox，避免未启动就灌音导致提交失败。
- 自动化测试 80 项通过；AI/ASR/TTS 使用模拟请求和模拟评分，未调用真实第三方 API。

### 0.3.0 后台实测

- 使用新加的 `scripts/browser-console-bg.ps1`，通过 UI Automation ValuePattern + PostMessage 在后台执行 DevTools 命令，没有激活 Chrome、切换前台或影响游戏窗口。
- 临时注入 0.3.0 后：31 个旧版组件、1 个练习块；面板版本 0.3.0，API 与连续答题设置可见，`continuous=true`，TTS Key 已存在（长度 51），AI/ASR Key 为空。
- 第 9/47 题已是提交状态；第 10/47 题是待作答 type 8 写作题，页面答案为空。由于 AI Key 未配置，完整连续答题会按设计在此暂停，不能宣称已经流畅挂完整课程。
- 当前浏览器安装的正式面板仍是 0.2.1；临时注入的 0.3.0 会在刷新后消失，必须手动更新用户脚本。

**尚未完成：在实际脚本管理器中更新 0.3.0、重新导出诊断确认组件可见；用真实 AI/ASR/TTS Key 验证各类 API 调用；在真实听力题和新的 legacy_18 题上完成 Submit→结果页→刷新持久性验收。**

## 0.3.1 type 8 口语简答与目标闯关

- 第 10/47 题实际为 `LIB-ORAL-BRIEF-EXERCISE-CS-STUDY`，页面无 textarea，只有录音按钮；此前误判为写作题，已修正为 `legacy_8` recording。
- 后台真实测试：AI 生成口语回答 → MiMo TTS → 原站 VOD 上传 → Submit → 重新读取核对成功，面板显示“已完成 1/1”，该题页面得分 5。
- 但目标闯关结果为 55/70，弹出“闯关失败”结果框。失败框遮挡右箭头，右箭头点击会反复触发结果框；脚本现在检测并抛出 `GOAL_FAILED` 暂停。
- 当前目标需要 Rechallenge 重做以提高其他任务分数；自动 Rechallenge 尚未实现，以免未经确认重置目标记录。
- 浏览器正式安装仍是旧版本；0.3.1 需要在脚本管理器中更新。AI/ASR/TTS 真实调用已在临时页面通过 AI/TTS JSON 与 VOD 验证；ASR multipart 在临时页面受 CORS 限制，正式 GM 环境待验证。

## 0.3.2 对话填空、分类拖拽、组合题与自动恢复

- 第 7/47 题 type 19 对话填空：从题目自带 `audioScript` 逐空还原 6 个答案，写入原站可编辑空格，Submit 后重新读取逐题核对成功。
- 第 8/47 题 type 9 跟读：7 句原题音频注入 Chivox，Submit 后核对成功。
- 第 9/47 题 type 18 角色扮演：MiMo TTS 合成所选角色台词，Chivox 评分并写回 `recordAudio`，Submit 后核对成功。
- 第 10-12、14/47 题 type 8 口语简答：AI 生成回答 → TTS → 原站 VOD 上传，Submit 后核对成功（同一题重复验证两次）。
- 第 11/47 题 type 11 分类拖拽：AI 将 12 个运动分到 3 个目标区，调用原站 `drag` 与 `answerChange`，Submit 后核对成功。
- 第 13/47 题 type 15 组合题：3 个填空子题继承父题 `audioScript`，AI 生成答案后一次整块提交，核对成功。
- 站点偶发只渲染题干不渲染作答控件：本次现场通过手动刷新恢复。适配器新增 `NEEDS_RELOAD`、`sessionStorage` 续跑标记与 3 次刷新上限，面板刷新后自动开始；已有单元测试，真实自动刷新尚未在一次全自动运行中触发。
- 观察到 Goal 2 Listening 的 A→B→C→D→A 循环，未捕获可见的“闯关失败／成功”弹窗，自动 Rechallenge 未触发。已增加 `PAGE_CYCLE` 保护：未 Rechallenge 却回到已完成页面即停止，避免反复提交；该关卡的评分或循环原因仍需排查。
- MiMo ASR：`/audio/transcriptions` 返回 HTTP 404，已改为 `/chat/completions` + `input_audio`（请求结构有单元测试）。临时注入页通过本地代理验证 MiMo TTS HTTP 200；正式 GM 环境待验收。

## 自动验证

执行 `npm run check`：TypeScript 类型检查、esbuild 用户脚本构建、Vitest 共 114 项全部通过。使用合成题目与模拟响应，不将真实课程数据作为 fixture。

覆盖：

- 题型、选项重排、空位顺序、答案缺失和重复、问答换行、组合子题。
- 新版生产 Vue VNode、选择和文字输入事件、填空延迟与失焦同步。
- 旧版真实格式路由、UUID 拖拽答案、正常读取 POST、页面原有提交事件、重新读取确认和 UUID 本地恢复。
- type 19 对话填空的原文还原、AI 回退、控件写入；type 11 分类拖拽的 AI 校验、原站拖拽调用；type 15 子题继承父题原文。
- 页面控件缺失时自动刷新续跑、刷新次数上限、`PAGE_CYCLE` 循环保护、站点重置答案后自动重做。
- MiMo Chat Completions ASR 请求结构、GM 请求超时。
- 旧版 HTTP 530、已提交跳过、缺失答案与未支持角色扮演暂停、关闭课程和过期页面。
- 旧版角色扮演/跟读多角色数据、仅所选角色完成判定、原题音频下载与 Chivox 写回、无音频时暂停、不调用 `playVadio()`。
- 通用 AI/ASR/TTS 请求封装、MiMo/OpenAI TTS、Base64 音频解码、JSON 答案解析、缺少 Key 与 API 错误处理；legacy_18 先启动角色流程再 TTS→Chivox（模拟）。
- AI 答题允许页面答案缺失、听力音频收集与 ASR 转写上下文、连续答题开关（模拟）。
- 单次提交、双击互斥、提交前持久化、失败／超时、迟到成功、刷新恢复和存储损坏。
- 麦克风拒绝、暂停清理；设备与录音服务使用模拟，不代表真实麦克风成功。
- 面板早期／晚期挂载、恢复与重复注入、诊断脱敏。
- 分发 `.user.js` 在 JSDOM 中运行真实 Vue 生产构建，完成合成单选提交和核对；另在按已验证 ViewEngine 结构搭建的旧版 fixture 中确认检测及跳过既有答案。

## 待验收

安装 0.3.2 后，先在真实脚本管理器刷新并导出诊断，确认 `legacyComponentCount` 大于 0。重点验证：真实 GM 环境下 `NEEDS_RELOAD` 自动刷新与续跑；MiMo ASR 在真实听力题中的返回；分类拖拽 11 的 AI 结果是否与关卡期望一致；Goal 2 Listening 的 A→B→C→D→A 循环是否与评分门槛有关。已提交过的练习不能重复提交，应另选题目。


## 0.3.8 看图写话与听力+图片

- 新增图片收集：从叶子组件向上查找最近的 `lib-exercise-res-show img`，兼容组合题共享图片；DOM 没有图片时回退到 `exercise.image` 资源 ID 并调用 `getResUrl(id, 3)`。
- 图片下载后按 PNG/JPEG/GIF/WebP 字节头识别 MIME，转 base64；最多随请求发送 4 张，单张上限 8 MB。请求格式与 MiMo 官方文档一致：`image_url: { url: "data:<mime>;base64,..." }`。
- 听力+图片：先使用题目 `audioScript` 或 ASR 转写，再把转写、整页文本、选项/空位和图片一起交给多模态模型；提示词要求以图片中的文字和页面文本为准。
- 图片解析或下载失败时提示模型“图片读取失败，只依据文本作答”，不暂停练习；若模型不支持图片并返回 HTTP 400/413/415/422，自动重试一次纯文本请求。
- 自动验证：`npm run check` 类型检查、构建和 Vitest 共 129 项通过；覆盖多模态请求体、图片字节 MIME、data URI、听力+图片先 ASR、资源 ID 回退和图片失败降级。
- **待真实验收：** 在正式脚本管理器中用已配置的 MiMo 视觉模型（`mimo-v2.6-flash`/pro）对真实看图写话和听力+图片题各提交一次，确认模型实际读取了图片而非仅凭文本猜测。


## 0.3.9 匹配题 10 AI 结果校验

- 现场题目：Unit 1 Sports / Goal 4 / Before You Watch / A，三组运动与描述一对一匹配；日志报 `AI_ANSWER ... 目标 484e3b4d-...`。
- 根因判断：模型常把右侧描述原文、`a/b/c` 标签、`1/2/3` 序号或按位置排列的数组写入 `answer`，而旧校验只接受 `dragged[].id`；另外旧校验强制使用全部选项，存在干扰项时会误判。
- 修复：`validateAiValue` 对 type 10 接受 UUID、选项原文、a/b/c 标签、序号、`{id/choiceId/itemId/value/answer}` 对象、`answers/choiceIds` 数组、按位置排列的数组及 `{目标ID: 选项ID}` 映射；统一反查为选项 UUID。首次失败自动带上目标/选项清单重试一次。
- 错误信息现在包含目标 UUID 和模型返回值片段，下一次失败可直接定位是模型漏项、重复还是返回了无法匹配的文本。
- 自动验证：新增文本/标签反查 + 重试、额外干扰项未使用两项用例；`npm run check` 全部通过。
- **待真实验收：** 更新 0.3.9 后在该题重新运行，确认三次拖拽写入并提交成功。


## 0.4.0 视频题：音轨 ASR 与带空位原句的 AI 填空

- 真实页面：`.../6a917a118334d27c2dc3447e`，`APP-COURSE-TASK-STU` type 15，exercise id `cb3c63da-f8dc-9220-87f6-294488624c24`，video `f0dac4036cc371ef955a7511979f0102`，4 个 type 3 子题（First / Then / After that / Finally）。
- 视频解析：`LIB-EXERCISE-RES-SHOW` 的 `resId` 为该 video，`type=1`；`getResUrl(id,1)` 返回 `https://vod.tsinghuaelt.com/.../*.mp4?auth_key=...`，HEAD 200，`content-length: 21089103`，`content-type: video/mp4`，时长 140.959 秒。
- 音轨提取：浏览器 `fetch(videoUrl)` 直接下载（CORS 允许），`AudioContext.decodeAudioData` 解码成功（48 kHz、双声道），重采样为 16 kHz 单声道 WAV（约 4.5 MB）。
- MiMo ASR：`mimo-v2.5-asr` 返回 200，usage 中 `audio_tokens: 875`、`seconds: 140`；转写完整覆盖 cheese-rolling 的 First / Then / After that / Finally 四个步骤。
- LLM：把转写、页面文本、4 个空位和空位原句一起交给 `mimo-v2.6-flash`，返回：
  - First → `the competitors come together at the top of`
  - Then → `someone pushes a very large wheel of cheese down the hill`
  - After that → `the competitors run after it`
  - Finally → `the first person to arrive at the bottom wins`
- 关键修正：只给空位 ID 和 `contentString` 时，单空题会把 First 填成最后一步；克隆叶子 DOM 并写入 `[[BLANK:<id>]]` 后，First 返回正确结果。
- 自动验证：新增 video 数据收集/组合继承、视频 URL 解析与下载、视频音轨解码到 WAV、MiMo ASR 请求体、带空位原句提示等测试；`npm run check` 共 119 项通过。
- **待真实验收：** 将 0.4.0 安装到脚本管理器后，在该题点击开始，确认 4 个空位写入并 Submit 成功。当前页面内等价 JS 流程已实测通过，但尚未通过正式 userscript 面板完成一次提交。


## 0.4.1 Continue 按钮与 PAGE_CHANGED 自动恢复

- 站点代码：挑战结果弹窗第二个按钮文本为 `score < fullScore && !lastScore ? "Review" : "Continue"`；点击 Continue 调用 `closeChallengeModal(3/4)`，父组件 `reChallengeChange(n)` 在 `n !== 1` 时执行 `courseStudyService.reChallenge.next(n)` 与 `loadPage()`。右上角关闭只发出 2，不能保证目录/下一关刷新，因此旧脚本只关闭弹窗会卡住。
- 修复：`next()` 先检查可见挑战弹窗；存在 Continue/继续按钮时优先点击，等待弹窗关闭并留出 1 秒让 `loadPage()` 刷新，然后重新 `discover()`；若返回新 unit 直接继续，否则再走右箭头/目录树。失败弹窗只有 Continue 时不再错误寻找 Rechallenge。
- PAGE_CHANGED：控制器现在把 `PAGE_CHANGED`/`STALE_PAGE` 与 `NEEDS_RELOAD` 一样处理，调用 `store.requestResume()` 后自动 `location.reload()`；面板恢复后重新检测当前练习并继续，最多 3 次，超过后显示 `RELOAD_LIMIT`。
- 自动验证：新增“成功弹窗点击 Continue”“失败弹窗只有 Continue 时点击 Continue”“页面顶部继续学习按钮”“PAGE_CHANGED 自动刷新并续跑”四项用例；`npm run check` 共 122 项通过。
- **待真实验收：** 更新 0.4.1 后，在真实闯关成功弹窗点击 Continue 的页面上确认自动进入下一关；当前代码级测试已覆盖按钮优先级与 PAGE_CHANGED 恢复。


## 0.4.2 看图填词/标注题词库约束

- 真实页面：`.../6a917a118334d27c2dc344a4`，Unit 2 Clothing / Vocabulary A，`APP-COURSE-TASK-STU` type 3，17 个空位（group 1-17），图片 `66dbf1873c9484188ca5a533`（1000×385）；图片右下蓝框有 18 个词（含重复 hat），17 个编号线指向衣物。
- 旧问题：页面可见文本只有说明和空行，词库在图片里；空位 JSON 没有 number，模型不知道哪个空位对应图片哪个编号，容易自创词或错位。
- 修复：保留 `fillBlanks[].group`，空位 JSON 增加 `number`；图片标注题提示先读词库、写 observations、再按编号填词；返回值包含 `words`，校验答案来自词库且重复次数不超过词库词频。
- MiMo 实测：默认深度思考开启时，3000 tokens 全部用于 reasoning，content 为空；设置 `thinking:{type:"disabled"}` 后同一图片题返回完整 JSON（734 completion tokens，17 个答案 + words）。
- 图片放大验证：整图直接作答在右侧 13-17 有错位；按左/中/右裁切放大后，左侧 1-4、中部 5-12 和右半 13-17 的编号跟随明显更准确。脚本现在自动生成 3 张重叠放大图（`cropImage`）随请求发送；若浏览器无法裁切则回退到整图。
- 自动验证：新增图片标注词库校验、自创词重试、MiMo thinking 关闭/4000 tokens 三项用例；`npm run check` 共 125 项通过。
- **待真实验收：** 更新 0.4.2 后在 344a4 题运行一次，确认 17 个空位按图片词库写入并 Submit 成功；当前接口级流程已验证。

## 0.4.3 视频解码、Base64、下载与进度

- OfflineAudioContext 实测：`new OfflineAudioContext(1,1,16000).decodeAudioData(mp4)` 返回 `sampleRate=16000`、`channels=2`、`length=48669`、`duration=3.0418125`，证明浏览器已原生重采样，后续只做单声道下混。
- Base64：改为 32 KB `String.fromCharCode.apply`；100 KB 单测输出与 `Buffer.from(bytes).toString('base64')` 完全一致。
- 媒体预算：`fetchMedia` 使用 600 秒独立超时；超过 200 MB 抛 `MEDIA_TOO_LARGE`，视频超过 20 分钟抛 `VIDEO_TOO_LONG`，均提示改手动作答；超时映射为 `MEDIA_TIMEOUT`。
- 进度：控制器把 `adapter.onProgress` 绑定到面板 message；视频依次显示下载、已下载大小/处理音轨、第 i/n 段转写；分块间让出主线程；`videoJobs` 对共用视频的并发任务去重。
- 自动验证：新增 OfflineAudioContext 构造参数/16 kHz 断言、32 KB Base64 一致性、媒体超时提示、视频进度消息等用例；`npm run check` 共 127 项通过。


## 0.4.4 Unit 2 Clothing Goal 1 图片题与填空 id 修复

- 真实页面：Unit 2 Clothing > Goal 1 > Vocabulary A（page `6a917a118334d27c2dc344a4`），type 3，17 个空位；图片 `66dbf1873c9484188ca5a533`。
- 站点数据不一致：`fillBlanks` group 16 的 id 为 `9becedc3-67c8-f378-ee0e-79102a0e5230`，但 `exercise.content` type 2 项、DOM 输入框和 `exercise/submit` 使用 `...f377...`。旧逻辑提交返回 501“作答记录与习题不匹配”，belt 空位丢失。
- 正确映射（服务端 17/17 全部 score=2，总分 34）：T-shirt、jeans、socks、sneakers、hat、coat、handbag、gloves、blouse、skirt、suit、shoes、shirt、tie、jacket、belt、pants。
- 旧视觉映射在 6/7/8/11/13/14/15 共 7 个空位错误，只得 20/34；修复后 34/34，增加 14 分。用户之前 Goal 分数 58，理论上可到 72（达到 70 门槛）。
- 修复：`contentBlankIds` 按 group 使用 content id；type 19 也按 group 对齐；该题加入已验证 17 答案；`fill()` 精确 id 失败时按顺序回退并别名到期望记录 id。
- 自动验证：新增“content id 优先于 stale fillBlanks id + 已知图片答案”用例；`npm run check` 共 128 项通过。
- **待真实验收：** 更新 0.4.4 后重做 Goal 1，确认 Vocabulary A 34/34 且 Goal 总分达到 70 以上；若最后 Conversation 填空仍低分，再单独检查该 task 的答案。

## 0.4.5 Type 24 拖拽填空与自动 Release

- 真实页面：Unit 3 Lifestyles > Goal 1 > Language Expansion: Compound Adjectives > A（page `6a917a118334d27c2dc344f4`），type 24，8 个空位，8 个 dragged 选项，所有 `fillBlanks[].answer` 为空。
- 旧错误：`legacyQuestion` 在 type 24 上要求每个 `fillBlanks[].answer` 非空且属于 `dragged`，页面无官方答案时直接抛 `NO_ANSWER`。
- 修复：仅拒绝“非空但不在选项中的答案”；提示词增加 `拖拽选项`（id + a-h 文本）和 `拖拽空位句子`（从 `drag[].content` 提取左侧形容词），AI 返回选项 id；校验时支持选项原文、a-h 标签、唯一包含关系反查 id。
- 真实 AI 结果：fast-paced→b、homemade→h、heartwarming→e、lifelong→g、stress-free→c、homegrown→f、overworked→a、low-calorie→d，8/8 匹配正确。
- 新增 `.github/workflows/release.yml`：push main 或手动触发，`npm ci` → `npm run check` → 读取版本/短 SHA → 创建或更新 Release，上传 `dist/tsinghua-online-auto.user.js` 和 `.meta.js`。
- 自动验证：新增 type 24 无官方答案 + AI 文本/标签反查用例；`npm run check` 共 129 项通过。
- **待真实验收：** 更新 0.4.5 后在 344f4 运行一次，确认 8 个拖拽匹配提交成功；若 type 24 页面仍有布局差异，导出该题数据继续适配。
