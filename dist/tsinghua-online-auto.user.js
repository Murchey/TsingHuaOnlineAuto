// ==UserScript==
// @name         清华社英语在线练习助手
// @namespace    local.tsinghua-online-auto
// @version      0.3.6
// @description  日常练习连续答题、AI/ASR/TTS 可配置接口、oral-brief VOD 上传、原题音频 Chivox 评测、unsafeWindow 桥接
// @match        https://www.tsinghuaelt.com/*
// @match        https://tsinghuaelt.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.xiaomimimo.com
// @connect      *
// @sandbox      raw
// @inject-into  page
// @noframes
// @license      GPL-3.0-only
// ==/UserScript==
"use strict";
(() => {
  // src/model.ts
  var defaults = {
    allLoaded: false,
    continuous: true,
    autoRechallenge: true,
    recordingSeconds: 10,
    rolePlayAudioMode: "original",
    aiAnswers: false,
    aiApiKey: "",
    aiApiBase: "https://api.openai.com/v1",
    aiModel: "gpt-4.1-mini",
    asrApiKey: "",
    asrApiBase: "https://api.openai.com/v1",
    asrModel: "whisper-1",
    ttsProvider: "mimo",
    ttsApiKey: "",
    ttsApiBase: "https://api.xiaomimimo.com/v1",
    ttsModel: "mimo-v2.5-tts",
    ttsVoice: "mimo_default",
    timeoutMs: 3e4,
    intervalMs: 350
  };
  var Halt = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "Halt";
    }
  };

  // src/async.ts
  function check(signal) {
    if (signal.aborted) throw new Halt("CANCELLED", "操作已暂停或停止");
  }
  function sleep(ms, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        done();
        reject(new Halt("CANCELLED", "操作已暂停或停止"));
      };
      const timer = setTimeout(() => {
        done();
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  function bounded(job, ms, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        done();
        reject(new Halt("CANCELLED", "操作已暂停或停止"));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Halt("TIMEOUT", "等待页面响应超时，请核查网络和登录状态"));
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
      job.then((v) => {
        done();
        resolve(v);
      }, (e) => {
        done();
        reject(e);
      });
    });
  }
  async function until(read, timeout, signal) {
    const deadline = Date.now() + timeout;
    do {
      check(signal);
      const value = read();
      if (value !== void 0) return value;
      await sleep(100, signal);
    } while (Date.now() < deadline);
    throw new Halt("PAGE_TIMEOUT", "页面控件未就绪或录音未完成，请检查页面提示");
  }

  // src/answers.ts
  function parse(value) {
    if (typeof value !== "string" || !/^[\[{]/.test(value.trim())) return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  function object(value) {
    const v = parse(value);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  function leaves(questions) {
    return questions.flatMap((q) => q.children?.length ? leaves(q.children) : [q]);
  }
  function text(html) {
    if (typeof html !== "string") return "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
    doc.querySelectorAll("p,div,li").forEach((el) => el.append("\n"));
    return (doc.body.textContent || "").replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
  }
  function required(value, id2) {
    if (typeof value !== "string" || !value.trim()) throw new Halt("NO_ANSWER", `题目 ${id2} 没有可解析的答案`);
  }
  function taskFor(q, record, allowMissing = false) {
    const raw = q.answer !== "" && q.answer != null ? q.answer : record?.answer;
    const answer = parse(raw);
    const extension = parse(q.extension);
    if (["oral_simple_speak", "oral_follow_along", "oral_vocabulary_learning", "legacy_8", "legacy_9", "legacy_18"].includes(q.type)) {
      return { question: q, kind: "recording" };
    }
    if (["choice_single", "choice_multiple", "judge_basic"].includes(q.type)) {
      const selected = q.type === "choice_multiple" ? answer : raw;
      const values = Array.isArray(selected) ? selected : [selected];
      const options = q.type === "judge_basic" ? ["1", "0"] : Array.isArray(extension) ? extension.map((o) => String(object(o).idx)) : [];
      if (!options.length || new Set(options).size !== options.length) {
        throw new Halt("NO_ANSWER", `题目 ${q.id} 的选项缺失或重复`);
      }
      if (allowMissing && (raw == null || raw === "")) {
        return { question: q, kind: "choice", value: q.type === "choice_multiple" ? [] : "" };
      }
      if (!values.length || q.type !== "choice_multiple" && values.length !== 1 || values.some((v) => typeof v !== "string" || !options.includes(v)) || new Set(values).size !== values.length) {
        throw new Halt("NO_ANSWER", `题目 ${q.id} 的答案缺失或与选项不匹配`);
      }
      return { question: q, kind: "choice", value: q.type === "choice_multiple" ? values : values[0] };
    }
    if (q.type === "legacy_22") {
      const items = object(q.extension).items;
      if (!Array.isArray(items) || !items.length) throw new Halt("DATA_SHAPE", `判断题 ${q.id} 的句子缺失`);
      const saved = Array.isArray(answer) ? answer.map(object) : [];
      return { question: q, kind: "fill", value: items.map((item) => {
        const idx = String(object(item).id);
        const match = saved.find((entry) => String(entry.idx) === idx);
        return { idx, answer: match && typeof match.val === "string" ? match.val : "" };
      }) };
    }
    if (q.type === "legacy_11") {
      const targets = object(q.extension).targets;
      if (!Array.isArray(targets) || !targets.length) throw new Halt("DATA_SHAPE", `分类题 ${q.id} 的目标缺失`);
      return { question: q, kind: "fill", value: targets.map((target) => ({ idx: String(object(target).id), answers: [] })) };
    }
    if (q.type === "fill_base") {
      const doc = new DOMParser().parseFromString(q.stem || "", "text/html");
      const ids = [...doc.querySelectorAll("span.zty-exercise-item-fill-blank[id]")].map((el) => el.id);
      const answers = Array.isArray(answer) ? answer : [];
      if (!ids.length || new Set(ids).size !== ids.length || !allowMissing && answers.length !== ids.length) {
        throw new Halt("AMBIGUOUS", `填空题 ${q.id} 的空位与答案数量不一致`);
      }
      const value = ids.map((idx) => {
        const matches = answers.map(object).filter((a2) => a2.idx === idx);
        if (matches.length !== 1) {
          if (allowMissing) return { idx, answer: "" };
          throw new Halt("AMBIGUOUS", `填空题 ${q.id} 的空位标识无法唯一匹配`);
        }
        const a = matches[0];
        const val = typeof a.standardAnswer === "string" && a.standardAnswer.trim() ? a.standardAnswer : a.val;
        if (allowMissing && (typeof val !== "string" || !val.trim())) return { idx, answer: "" };
        required(val, q.id);
        const selected = text(val.split(/[;；]/)[0]);
        required(selected, q.id);
        return { idx, answer: selected };
      });
      return { question: q, kind: "fill", value };
    }
    if (["essay_writing", "essay_translate", "essay_questions_answers"].includes(q.type)) {
      const value = text(typeof answer === "string" ? answer : object(answer).answer);
      if (!allowMissing) required(value, q.id);
      return { question: q, kind: "writing", value: { answer: value, annex: [] } };
    }
    throw new Halt("UNSUPPORTED", `暂不支持题型 ${q.type}（题目 ${q.id}），已暂停`);
  }
  function planTasks(data, options = {}) {
    const qs = leaves(data.questionVOList);
    if (!qs.length) throw new Halt("EMPTY", "当前练习没有题目，或题目尚未加载");
    const ids = qs.map((q) => String(q.id));
    if (ids.some((id2) => !/^[\w-]{1,128}$/.test(id2)) || new Set(ids).size !== ids.length) {
      throw new Halt("AMBIGUOUS", "题目标识缺失或重复，无法安全匹配");
    }
    const records = data.questionAnswerItemVOList || [];
    if (new Set(records.map((r) => String(r.questionId))).size !== records.length) {
      throw new Halt("AMBIGUOUS", "作答记录中出现重复题目标识");
    }
    return qs.map((q) => taskFor(q, records.find((r) => String(r.questionId) === String(q.id)), options.allowMissing === true));
  }
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + stable(v)).join(",") + "}";
    return JSON.stringify(value) ?? "null";
  }
  function hash(value) {
    let n = 14695981039346656037n;
    for (const c of stable(value)) n = BigInt.asUintN(64, (n ^ BigInt(c.codePointAt(0))) * 1099511628211n);
    return n.toString(16);
  }
  function fingerprint(data) {
    return hash(leaves(data.questionVOList).map((q) => [String(q.id), q.type, q.stem, q.instruction, parse(q.extension)]));
  }
  function audioId(value) {
    if (typeof value !== "string") return "";
    try {
      const u = new URL(value);
      return u.origin + u.pathname;
    } catch {
      return value;
    }
  }
  function canonical(q, value) {
    const v = q.type === "choice_single" || q.type === "judge_basic" ? value : parse(value);
    if (q.type === "choice_multiple") return Array.isArray(v) ? [...v].sort() : v;
    if (q.type === "legacy_22") return Array.isArray(v) ? v.map(object).map((a) => ({ idx: a.idx, answer: a.answer })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
    if (q.type === "legacy_11") return Array.isArray(v) ? v.map(object).map((group) => ({
      idx: group.idx,
      answers: Array.isArray(group.answers) ? group.answers.map(String).sort() : []
    })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
    if (q.type === "fill_base") return Array.isArray(v) ? v.map(object).map((a) => ({ idx: a.idx, answer: a.answer })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
    if (q.type.startsWith("essay_")) return { answer: String(object(v).answer ?? "").replace(/\r\n/g, "\n").trim() };
    if (q.type === "oral_simple_speak" || q.type === "legacy_8") return { audio: audioId(object(v).audio) };
    if (q.type === "legacy_9") return Array.isArray(v) ? v.map(object).map((a) => ({ idx: a.idx, audio: audioId(String(a.audio || "")) })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
    if (q.type === "legacy_18") {
      const r = object(v);
      return { roleId: String(r.roleId || ""), answers: Array.isArray(r.answers) ? r.answers.map(object).map((a) => ({ idx: a.idx, audio: audioId(String(a.audio || "")) })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : [] };
    }
    if (q.type === "oral_follow_along" || q.type === "oral_vocabulary_learning") return Array.isArray(v) ? v.map(object).map((a) => ({ idx: a.idx, audio: audioId(object(a.answer).audio) })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
    return v;
  }
  function hasCompleteResponse(q, value) {
    const v = q.type === "choice_single" || q.type === "judge_basic" ? value : parse(value);
    if (q.type === "choice_single" || q.type === "choice_multiple" || q.type === "judge_basic") {
      const options = q.type === "judge_basic" ? ["0", "1"] : Array.isArray(parse(q.extension)) ? parse(q.extension).map((o) => object(o).idx) : [];
      const selected = q.type === "choice_multiple" ? v : [v];
      return Array.isArray(selected) && selected.length > 0 && new Set(selected).size === selected.length && selected.every((s) => typeof s === "string" && options.includes(s));
    }
    if (q.type.startsWith("essay_")) return typeof object(v).answer === "string" && !!String(object(v).answer).trim();
    if (q.type === "oral_simple_speak" || q.type === "legacy_8") return typeof object(v).audio === "string" && !!object(v).audio;
    if (q.type === "legacy_9") {
      const items = object(q.extension).sentItems;
      if (!Array.isArray(items) || !items.length || !Array.isArray(v) || !v.length) return false;
      const answers = v.map(object);
      if (answers.some((a) => typeof a.audio !== "string" || !a.audio)) return false;
      const itemById = new Map(items.map((item) => [String(object(item).idx), object(item)]));
      if (itemById.size !== items.length) return false;
      const answeredIds = new Set(answers.map((a) => String(a.idx)));
      if (answeredIds.size !== answers.length || [...answeredIds].some((idx) => !itemById.has(idx))) return false;
      if (items.every((item) => answeredIds.has(String(object(item).idx)))) return true;
      const roleIds = new Set([...answeredIds].map((idx) => String(itemById.get(idx)?.roleId ?? "")));
      if (roleIds.size !== 1) return false;
      const roleId = [...roleIds][0];
      const expected = items.filter((item) => String(object(item).roleId ?? "") === roleId);
      return expected.length > 0 && expected.every((item) => answeredIds.has(String(object(item).idx)));
    }
    if (q.type === "legacy_18") {
      const items = object(q.extension).sentItems;
      const record = object(v), answers = Array.isArray(record.answers) ? record.answers.map(object) : [];
      const roleId = String(record.roleId || "");
      if (!roleId || !Array.isArray(items) || !items.length || !answers.length) return false;
      if (answers.some((a) => typeof a.audio !== "string" || !a.audio)) return false;
      const itemById = new Map(items.map((item) => [String(object(item).idx), object(item)]));
      if (itemById.size !== items.length) return false;
      const answeredIds = new Set(answers.map((a) => String(a.idx)));
      if (answeredIds.size !== answers.length || [...answeredIds].some((idx) => !itemById.has(idx))) return false;
      const expected = items.filter((item) => String(object(item).roleId ?? "") === roleId);
      return expected.length > 0 && expected.every((item) => answeredIds.has(String(object(item).idx)));
    }
    if (q.type === "legacy_22") {
      const items = object(q.extension).items, options = object(q.extension).options;
      const itemIds = new Set((Array.isArray(items) ? items : []).map((item) => String(object(item).id)));
      const optionIds = new Set((Array.isArray(options) ? options : []).map((option) => String(object(option).id)));
      if (!itemIds.size || !optionIds.size || !Array.isArray(v) || v.length !== itemIds.size) return false;
      const answers = v.map(object), seen = /* @__PURE__ */ new Set();
      return answers.every((entry) => {
        const idx = String(entry.idx);
        if (!itemIds.has(idx) || seen.has(idx)) return false;
        seen.add(idx);
        return typeof entry.answer === "string" && optionIds.has(entry.answer);
      });
    }
    if (q.type === "legacy_11") {
      const items = object(q.extension).items;
      const ids = new Set((Array.isArray(items) ? items : []).map((item) => String(object(item).id)));
      if (!ids.size || !Array.isArray(v)) return false;
      const seen = /* @__PURE__ */ new Set();
      for (const group of v.map(object)) {
        const answers = Array.isArray(group.answers) ? group.answers.map(String) : [];
        if (!answers.length) return false;
        for (const id2 of answers) {
          if (!ids.has(id2) || seen.has(id2)) return false;
          seen.add(id2);
        }
      }
      return seen.size === ids.size;
    }
    if (q.type === "fill_base" || q.type === "oral_follow_along" || q.type === "oral_vocabulary_learning") {
      const ext = parse(q.extension);
      const ids = q.type === "fill_base" ? [...new DOMParser().parseFromString(q.stem || "", "text/html").querySelectorAll("span.zty-exercise-item-fill-blank[id]")].map((el) => el.id) : q.type === "oral_follow_along" ? object(ext).sentItems : ext;
      const expected = Array.isArray(ids) ? ids.map((i) => typeof i === "string" ? i : object(i).idx) : [];
      if (!expected.length || new Set(expected).size !== expected.length || !Array.isArray(v) || v.length !== expected.length) return false;
      return expected.every((idx) => {
        const matches = v.map(object).filter((a2) => a2.idx === idx);
        if (matches.length !== 1) return false;
        const a = matches[0];
        return q.type === "fill_base" ? typeof a.answer === "string" && !!a.answer.trim() : typeof object(a.answer).audio === "string" && !!object(a.answer).audio;
      });
    }
    return false;
  }
  function answerHashes(data, values) {
    return Object.fromEntries(leaves(data.questionVOList).map((q) => [String(q.id), hash(canonical(q, values.get(String(q.id))))]));
  }
  function isSaved(data, baseline, expected, mark) {
    if (fingerprint(data) !== mark || (data.answerCount || 0) <= baseline) return false;
    const qs = leaves(data.questionVOList);
    const records = data.questionAnswerItemVOList || [];
    return qs.length === Object.keys(expected).length && qs.every((q) => {
      const matches = records.filter((r) => String(r.questionId) === String(q.id));
      return matches.length === 1 && matches[0].userAnswer != null && hash(canonical(q, matches[0].userAnswer)) === expected[String(q.id)];
    });
  }

  // src/vue.ts
  var nameOf = (c) => c.type?.__name || c.type?.name || "";
  function components(doc = document) {
    const result = [];
    const visited = /* @__PURE__ */ new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object" || visited.has(node) || visited.size > 4e4) return;
      visited.add(node);
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const v = node;
      if (v.component && !v.component.isUnmounted) {
        result.push(v.component);
        walk(v.component.subTree);
      }
      walk(v.children);
      walk(v.suspense?.activeBranch);
    };
    for (const el of doc.querySelectorAll("#app,[data-v-app]")) {
      const root = el;
      walk(root._vnode || root.__vue_app__?._container?._vnode);
      const instance = root.__vue_app__?._instance;
      if (instance) walk({ component: instance });
    }
    return [...new Set(result)];
  }
  function elementOf(c) {
    const el = c.subTree?.el || c.vnode?.el;
    if (el instanceof HTMLElement) return el;
    return void 0;
  }

  // src/adapter.ts
  var leafNames = /* @__PURE__ */ new Set([
    "SingleChoiceCourseDo",
    "FillBlankCourseDo",
    "WritingCourseDo",
    "OralBriefCourseDo",
    "ListenAndRepeatCourseDo",
    "WordsCourseDo"
  ]);
  function routePath() {
    return (location.hash.startsWith("#/") ? location.hash.slice(1) : location.pathname).split("?")[0];
  }
  function allowedRoute() {
    return /^\/course_center\/reader\/(student_course|public_course|textbook)\/[^/]+\/?$/.test(routePath());
  }
  function id(value) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  function shown(el) {
    for (let p = el; p; p = p.parentElement) {
      if (p.hidden || p.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(p);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function enabled(el) {
    return shown(el) && !el.closest('[disabled],[aria-disabled="true"],.ant-btn-loading,.disabled,.ly-button-disabled');
  }
  function dataShape(value) {
    const d = object(value);
    if (!Array.isArray(d.questionVOList) || d.answerCount !== void 0 && (!Number.isInteger(d.answerCount) || Number(d.answerCount) < 0) || d.questionAnswerItemVOList !== void 0 && !Array.isArray(d.questionAnswerItemVOList)) {
      throw new Halt("DATA_SHAPE", "习题数据格式已变化，已暂停；请导出诊断");
    }
    return JSON.parse(JSON.stringify(d));
  }
  var TsinghuaAdapter = class {
    discover() {
      if (!allowedRoute()) return [];
      const units = components().filter((c) => nameOf(c) === "UnitExercisePreview").flatMap((c) => {
        const root = elementOf(c);
        const catalogId = id(c.props.catalogId), contentId = id(c.props.contentId);
        if (!root?.isConnected || !root.matches(".unit-exercise-preview") || !shown(root) || !/^\d+$/.test(catalogId) || !/^\d+$/.test(contentId)) return [];
        return [{
          key: `${routePath()}:${catalogId}:${contentId}`,
          catalogId,
          contentId,
          root,
          title: `章节 ${catalogId} · 练习 ${contentId}`
        }];
      });
      const keys = units.map((u) => u.key);
      if (new Set(keys).size !== keys.length) throw new Halt("DUPLICATE_UNIT", "页面出现重复练习块，已暂停");
      return units.sort((a, b) => a.root === b.root ? 0 : a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    }
    instance(unit) {
      const candidates = components().filter((c) => nameOf(c) === "UnitExercisePreview" && id(c.props.catalogId) === unit.catalogId && id(c.props.contentId) === unit.contentId && elementOf(c) === unit.root);
      if (candidates.length !== 1) throw new Halt("STALE_PAGE", "练习页面发生变化，请重新选择练习");
      return candidates[0];
    }
    assertContext(unit) {
      if (!allowedRoute() || !unit.key.startsWith(routePath() + ":") || !unit.root.isConnected || !shown(unit.root)) {
        throw new Halt("PAGE_CHANGED", "当前页面或课程已改变，已暂停");
      }
      const { props } = this.instance(unit);
      const textbook = object(props.textbookInfo);
      if (props.mode !== "user" || ![6, 8].includes(Number(props.userType)) || !["student_course", "public_course", "textbook"].includes(String(props.readerType)) || props.interactionMode === "teacher_student_review" || Number(textbook.courseStatus) === -1 || Number(textbook.publicCourseStatus) === -1) {
        throw new Halt("NOT_PRACTICE", "仅支持学生日常练习，不处理考试、教师预览或已关闭课程");
      }
      if (props.currentCatalogId != null && id(props.currentCatalogId) !== unit.catalogId) {
        throw new Halt("CATALOG_CHANGED", "当前练习不属于正在学习的章节");
      }
      const conflict = this.conflict();
      if (conflict) throw new Halt("SCRIPT_CONFLICT", conflict);
    }
    conflict() {
      if (document.querySelector(".yunPanel")) return "检测到旧版 Yun 答题面板，请停用旧脚本并刷新后运行";
      const w = globalThis.unsafeWindow ?? window.unsafeWindow ?? window;
      if (w.XMLHttpRequest?.name === "myXMLHttpRequest" || w.WebSocket?.name === "myWebSocket") {
        return "检测到旧版脚本的网络钩子，请停用旧脚本并刷新后运行";
      }
      if (w.yunAiRecorder || w.yunPlayer) return "检测到旧版脚本的播放器或录音钩子，请停用旧脚本并刷新";
      return null;
    }
    async load(unit, signal) {
      check(signal);
      this.assertContext(unit);
      const callback = this.instance(unit).props.onLoadExercise;
      if (typeof callback !== "function") throw new Halt("NO_LOADER", "页面未提供练习读取方法");
      try {
        const value = await bounded(Promise.resolve(callback(Number(unit.contentId))), 3e4, signal);
        check(signal);
        this.assertContext(unit);
        return dataShape(value);
      } catch (error) {
        if (error instanceof Halt) throw error;
        const e = object(error);
        if ([401, 403].includes(Number(e.status)) || [401, 403].includes(Number(object(e.data).code))) {
          throw new Halt("LOGIN", "登录已失效或无课程权限，请重新登录");
        }
        throw new Halt("LOAD_FAILED", "读取练习失败，请检查网络和页面提示");
      }
    }
    leaf(unit, q) {
      const matches = components().filter((c) => leafNames.has(nameOf(c)) && id(object(c.props.exercise).id) === String(q.id) && !!(c.subTree?.el || c.vnode?.el) && unit.root.contains(c.subTree?.el || c.vnode?.el));
      if (matches.length !== 1) throw new Halt("QUESTION_DOM", `题目 ${q.id} 的作答组件未就绪或不唯一`);
      if (Number(matches[0].props.status) !== 10) throw new Halt("READ_ONLY", `题目 ${q.id} 当前不是可作答状态`);
      return matches[0];
    }
    scope(unit, q) {
      const leaf = this.leaf(unit, q);
      const el = elementOf(leaf);
      if (el) return el;
      const indexed = [...unit.root.querySelectorAll("[data-child-question-id],[id]")].filter((el2) => el2.dataset.childQuestionId === String(q.id) || el2.id === `do_${q.id}`);
      const stem = indexed.find((el2) => el2.id === `do_${q.id}`);
      if (q.type === "fill_base" && stem) return stem;
      const nested = indexed.filter((el2) => el2.dataset.childQuestionId === String(q.id));
      if (nested.length === 1) return nested[0];
      const wrapper = components().filter((c) => nameOf(c) === "AdaptExerciseCourseDo" && id(object(c.props.exercise).id) === String(q.id)).map(elementOf).filter((el2) => !!el2 && unit.root.contains(el2));
      if (wrapper.length === 1) return wrapper[0];
      throw new Halt("QUESTION_DOM", `无法确定题目 ${q.id} 的填写区域`);
    }
    local(unit, q) {
      return object(this.leaf(unit, q).props.exercise).doRecord;
    }
    control(unit, signal) {
      check(signal);
      this.assertContext(unit);
    }
    async fill(unit, task, _settings, signal) {
      this.control(unit, signal);
      const scope = this.scope(unit, task.question);
      if (task.kind === "choice") {
        const selected = new Set(Array.isArray(task.value) ? task.value : [task.value]);
        const inputs = [...scope.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
        if (!inputs.length || [...selected].some((v) => inputs.filter((el) => el.value === v).length !== 1)) {
          throw new Halt("CHOICE_DOM", "选项控件与答案标识不匹配");
        }
        for (const input of inputs) {
          this.control(unit, signal);
          if (!enabled(input)) throw new Halt("DISABLED", "选项控件不可操作");
          const desired = selected.has(input.value);
          if (input.type === "checkbox" ? input.checked !== desired : desired && !input.checked) input.click();
        }
      } else if (task.kind === "fill") {
        await until(() => scope.dataset.teFillBlankContainerInited === "1" || scope.querySelector('[data-te-fill-blank-container-inited="1"]') ? true : void 0, 5e3, signal);
        for (const value of task.value) {
          this.control(unit, signal);
          const fields = [...scope.querySelectorAll('span.zty-exercise-item-fill-blank-do[contenteditable="true"]')].filter((el) => el.id === value.idx);
          if (fields.length !== 1 || !enabled(fields[0])) throw new Halt("FILL_DOM", "填空控件未找到或存在重复标识");
          const field = fields[0];
          field.focus();
          field.textContent = value.answer;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
          field.blur();
        }
      } else if (task.kind === "writing") {
        const fields = scope.matches("textarea") ? [scope] : [...scope.querySelectorAll("textarea")];
        if (fields.length !== 1 || !enabled(fields[0])) throw new Halt("WRITING_DOM", "问答输入框未找到或不唯一");
        const field = fields[0];
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, object(task.value).answer);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
        field.blur();
      } else throw new Halt("WRONG_HANDLER", "录音题需要录音处理器");
      return until(() => {
        this.control(unit, signal);
        const value = this.local(unit, task.question);
        return stable(canonical(task.question, value)) === stable(canonical(task.question, task.value)) ? value : void 0;
      }, 5e3, signal);
    }
    async record(unit, task, settings, signal) {
      this.control(unit, signal);
      if (!navigator.mediaDevices?.getUserMedia) throw new Halt("NO_MIC", "浏览器不支持麦克风录音");
      const permission = navigator.mediaDevices.getUserMedia({ audio: true });
      void permission.then((stream2) => stream2.getTracks().forEach((t) => t.stop()), () => {
      });
      let stream;
      try {
        stream = await bounded(permission, settings.timeoutMs, signal);
      } catch (e) {
        if (e instanceof Halt) throw e;
        throw new Halt("MIC_DENIED", "麦克风授权失败，请在网站设置中允许麦克风");
      }
      stream.getTracks().forEach((t) => t.stop());
      const q = task.question;
      const scope = this.scope(unit, q);
      const extension = parse(q.extension);
      const items = q.type === "oral_follow_along" ? object(extension).sentItems : q.type === "oral_vocabulary_learning" ? extension : [null];
      if (!Array.isArray(items) || !items.length) throw new Halt("RECORDING_DOM", "录音题的句子或单词列表为空");
      if (q.type !== "oral_simple_speak" && (new Set(items.map((i) => object(i).idx)).size !== items.length || items.some((i) => typeof object(i).idx !== "string" || !object(i).idx))) {
        throw new Halt("RECORDING_DOM", "录音项目标识缺失或重复");
      }
      for (let index = 0; index < items.length; index++) {
        this.control(unit, signal);
        const rows = q.type === "oral_follow_along" ? [...scope.querySelectorAll(".dialogue-view-item")] : q.type === "oral_vocabulary_learning" ? [...scope.querySelectorAll(".word-item")] : [scope];
        if (rows.length !== items.length) throw new Halt("RECORDING_DOM", "录音按钮与句子数量不匹配");
        const row = rows[index];
        const find = (recording) => [...row.querySelectorAll("img")].find((img) => img.getAttribute("src")?.split("?")[0].endsWith(recording ? "/recording.gif" : "/record.png"));
        const stop = () => {
          const button = find(true);
          if (button) button.click();
        };
        const initial = find(false);
        if (!initial || !enabled(initial)) throw new Halt("RECORDING_DOM", "录音按钮未就绪或被禁用");
        const previous = stable(this.local(unit, q));
        let stopped = false;
        signal.addEventListener("abort", stop, { once: true });
        try {
          initial.click();
          await until(() => {
            this.control(unit, signal);
            return find(true) ? true : void 0;
          }, settings.timeoutMs, signal);
          const duration = q.type === "oral_simple_speak" ? settings.recordingSeconds * 1e3 : q.type === "oral_vocabulary_learning" ? 5e3 : Math.min((Number(object(items[index]).audioTime) < 6 ? (Number(object(items[index]).audioTime) || 0) + 3 : Number(object(items[index]).audioTime) * 1.5) * 1e3, 18e4);
          const deadline = Date.now() + duration;
          while (Date.now() < deadline && find(true)) {
            this.control(unit, signal);
            await sleep(150, signal);
          }
          this.control(unit, signal);
          stop();
          stopped = true;
          await until(() => {
            this.control(unit, signal);
            const value = parse(this.local(unit, q));
            if (stable(value) === previous) return void 0;
            const audio = q.type === "oral_simple_speak" ? object(value) : object((Array.isArray(value) ? value.map(object) : []).find((v) => v.idx === object(items[index]).idx)?.answer);
            return typeof audio.audio === "string" && audio.audio ? true : void 0;
          }, settings.timeoutMs, signal);
        } finally {
          signal.removeEventListener("abort", stop);
          if (!stopped) stop();
        }
      }
      return this.local(unit, q);
    }
    async submit(unit, signal) {
      this.control(unit, signal);
      const buttons = [...unit.root.querySelectorAll(".exercise-actions button")].filter((b) => /^(Submit|提交)$/i.test(b.textContent?.trim() || "") && enabled(b));
      if (buttons.length !== 1) throw new Halt("SUBMIT_DOM", "没有唯一可用的日常练习提交按钮");
      buttons[0].click();
    }
  };

  // src/chivox.ts
  var numberValue = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  async function scoreWithChivox(speech, text2, audio, timeoutMs, signal) {
    const recorder = speech.chivoxRecorder, service = speech.speechService;
    if (!recorder?.context || !recorder.node || !recorder.inputPoint || typeof service?.startSentence !== "function" || typeof recorder.record !== "function") {
      throw new Halt("SPEECH_INIT", "原站 Chivox 录音器尚未初始化，请刷新页面后重试");
    }
    if (service.observer) {
      try {
        service.stop();
      } catch {
      }
      await sleep(250, signal);
    }
    if (service.observer) throw new Halt("SPEECH_BUSY", "原站语音评测仍在运行，请稍后重试");
    const context = recorder.context;
    let audioBuffer;
    try {
      audioBuffer = await context.decodeAudioData(audio.slice(0));
    } catch {
      throw new Halt("TTS_AUDIO", "TTS 音频无法由浏览器解码");
    }
    const originalRecord = recorder.record.bind(recorder), originalGain = recorder.inputPoint.gain.value;
    let source, silent;
    let subscription, finished = false;
    const restore = () => {
      recorder.record = originalRecord;
      try {
        recorder.inputPoint.gain.value = originalGain;
      } catch {
      }
      try {
        source?.stop();
      } catch {
      }
      try {
        source?.disconnect();
      } catch {
      }
      try {
        recorder.node.disconnect();
      } catch {
      }
      try {
        silent?.disconnect();
      } catch {
      }
      try {
        recorder.node.connect(context.destination);
      } catch {
      }
    };
    recorder.record = function(options) {
      const onStart = options?.onStart;
      options = { ...options, onStart: (...args) => {
        try {
          if (!finished && !signal.aborted) {
            recorder.inputPoint.gain.value = 0;
            try {
              recorder.node.disconnect();
            } catch {
            }
            const mute = context.createGain();
            silent = mute;
            mute.gain.value = 0;
            mute.connect(context.destination);
            recorder.node.connect(mute);
            const player = context.createBufferSource();
            source = player;
            player.buffer = audioBuffer;
            player.connect(recorder.node);
            player.onended = () => setTimeout(() => {
              if (!finished) {
                try {
                  service.stop();
                } catch {
                }
              }
            }, 800);
            player.start();
          }
        } catch (error) {
          finished = true;
          throw error;
        }
        if (typeof onStart === "function") onStart(...args);
      } };
      return originalRecord(options);
    };
    try {
      const result = await bounded(new Promise((resolve, reject) => {
        subscription = service.startSentence(text2, Math.max(8e3, Math.round(audioBuffer.duration * 1e3) + 5e3)).subscribe({ next: resolve, error: reject });
      }), Math.max(3e4, timeoutMs), signal);
      finished = true;
      const recordAudio = typeof result?.recordAudio === "string" ? result.recordAudio : "";
      if (!recordAudio) throw new Halt("SPEECH_SCORE", "Chivox 没有返回录音地址");
      return {
        score: numberValue(result.score),
        accuracy: numberValue(result.accuracy),
        fluency: numberValue(result.fluency),
        senseGroup: numberValue(result.senseGroup),
        speed: numberValue(result.speed),
        stress: numberValue(result.stress),
        integrity: numberValue(result.integrity),
        rhythm: numberValue(result.rhythm),
        pron: numberValue(result.pron),
        recordAudio,
        words: Array.isArray(result.words) ? result.words : [],
        ccode: result.ccode ?? {},
        result: String(result.result ?? "")
      };
    } catch (error) {
      finished = true;
      try {
        service.stop();
      } catch {
      }
      if (error instanceof Halt) throw error;
      const message = typeof error === "string" ? error : error?.errMessage;
      throw new Halt("SPEECH_SCORE", `Chivox 评测失败${typeof message === "string" && message ? `：${message.slice(0, 160)}` : ""}`);
    } finally {
      subscription?.unsubscribe();
      restore();
    }
  }

  // src/api.ts
  function baseUrl(value) {
    return value.trim().replace(/\/+$/, "");
  }
  function endpoint(base, path) {
    const value = baseUrl(base);
    return value.endsWith(path) ? value : value + path;
  }
  function timeoutOf(settings) {
    return Math.min(18e4, Math.max(6e4, settings.timeoutMs));
  }
  function authHeaders(key2, json = true) {
    return { ...json ? { "Content-Type": "application/json" } : {}, "api-key": key2, Authorization: `Bearer ${key2}` };
  }
  function failure(status, text2) {
    let message = "";
    try {
      const parsed = JSON.parse(text2);
      message = typeof parsed.error?.message === "string" ? parsed.error.message : typeof parsed.message === "string" ? parsed.message : "";
    } catch {
    }
    return new Halt("API_ERROR", `API 请求失败（HTTP ${status}）${message ? `：${message.slice(0, 180)}` : ""}`);
  }
  function gmRequest(options, timeout, signal) {
    const gm = globalThis.GM_xmlhttpRequest;
    if (typeof gm !== "function") throw new Halt("API_GM", "当前脚本管理器没有提供 GM_xmlhttpRequest");
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Halt("CANCELLED", "操作已暂停或停止"));
        return;
      }
      let settled = false, request2, timer;
      const cleanup = () => {
        if (timer !== void 0) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const done = (fn) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const abort = () => {
        try {
          request2?.abort?.();
        } catch {
        }
        done(() => reject(new Halt("CANCELLED", "操作已暂停或停止")));
      };
      timer = setTimeout(() => {
        try {
          request2?.abort?.();
        } catch {
        }
        done(() => reject(new Halt("API_TIMEOUT", "API 请求超时（脚本管理器未在规定时间内返回）")));
      }, timeout);
      request2 = gm({
        method: options.method || "POST",
        url: options.url,
        headers: options.headers,
        data: options.data,
        responseType: options.responseType || "text",
        timeout,
        onload: (response) => done(() => response.status >= 200 && response.status < 300 ? resolve(response) : reject(failure(response.status, response.responseText || ""))),
        onerror: () => done(() => reject(new Halt("API_NETWORK", "API 网络请求失败，请检查网络或脚本管理器授权"))),
        ontimeout: () => done(() => reject(new Halt("API_TIMEOUT", "API 请求超时")))
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async function request(options, settings, signal) {
    const timeout = timeoutOf(settings);
    try {
      return await gmRequest(options, timeout, signal);
    } catch (error) {
      if (signal.aborted || error instanceof Halt && error.code !== "API_GM") throw error;
    }
    try {
      const init = { method: options.method || "POST", headers: options.headers, body: options.data, signal };
      const response = await bounded(fetch(options.url, init), timeout, signal);
      if (!response.ok) throw failure(response.status, await response.text());
      if (options.responseType === "arraybuffer") return { status: response.status, response: await response.arrayBuffer() };
      return { status: response.status, responseText: await response.text() };
    } catch (error) {
      if (error instanceof Halt) throw error;
      throw new Halt("API_CORS", "浏览器直接访问 API 失败；请使用支持 GM_xmlhttpRequest 的脚本管理器，或检查 API Base");
    }
  }
  function contentObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function parseJsonObject(text2) {
    const clean = text2.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Halt("AI_RESPONSE", "AI 返回内容中没有 JSON 对象");
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch {
      throw new Halt("AI_RESPONSE", "AI 返回的 JSON 无法解析");
    }
  }
  function encodeBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  }
  function decodeBase64(value) {
    const clean = value.replace(/^data:[^,]*,/i, "").replace(/\s+/g, "");
    if (!clean) throw new Halt("TTS_RESPONSE", "TTS 返回了空音频");
    let binary;
    try {
      binary = atob(clean);
    } catch {
      throw new Halt("TTS_RESPONSE", "TTS 返回的音频不是有效 Base64");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }
  async function synthesizeSpeech(text2, settings, signal) {
    const value = text2.trim();
    if (!value) throw new Halt("TTS_TEXT", "当前句子没有可合成的文本");
    if (!settings.ttsApiKey.trim()) throw new Halt("TTS_CONFIG", "请在面板填写 TTS API Key");
    if (settings.ttsProvider === "openai") {
      const response2 = await request({
        url: endpoint(settings.ttsApiBase, "/audio/speech"),
        headers: authHeaders(settings.ttsApiKey),
        responseType: "arraybuffer",
        data: JSON.stringify({
          model: settings.ttsModel || "tts-1",
          input: value,
          voice: settings.ttsVoice || "alloy",
          response_format: "mp3"
        })
      }, settings, signal);
      if (!(response2.response instanceof ArrayBuffer) || !response2.response.byteLength) throw new Halt("TTS_RESPONSE", "OpenAI TTS 没有返回音频");
      return response2.response;
    }
    const response = await request({
      url: endpoint(settings.ttsApiBase, "/chat/completions"),
      headers: authHeaders(settings.ttsApiKey),
      data: JSON.stringify({
        model: settings.ttsModel || "mimo-v2.5-tts",
        messages: [{ role: "assistant", content: value }],
        audio: { format: "mp3", voice: settings.ttsVoice || "mimo_default" },
        stream: false
      })
    }, settings, signal);
    const parsed = JSON.parse(response.responseText || "{}");
    const audio = parsed?.choices?.[0]?.message?.audio;
    const data = typeof audio?.data === "string" ? audio.data : typeof audio?.audio === "string" ? audio.audio : "";
    if (!data) throw new Halt("TTS_RESPONSE", "MiMo TTS 响应中缺少 message.audio.data");
    return decodeBase64(data);
  }
  var SYSTEM = "你是英语课程作答助手。只返回一个 JSON 对象，不要 Markdown、解释或额外文字。严格使用题目提供的选项 ID 和空位 ID。";
  async function answerWithAi(prompt, settings, signal) {
    if (!settings.aiApiKey.trim()) throw new Halt("AI_CONFIG", "请在面板填写 AI API Key");
    const response = await request({
      url: endpoint(settings.aiApiBase, "/chat/completions"),
      headers: authHeaders(settings.aiApiKey),
      data: JSON.stringify({ model: settings.aiModel, messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt }
      ], temperature: 0.2, stream: false })
    }, settings, signal);
    const parsed = JSON.parse(response.responseText || "{}");
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Halt("AI_RESPONSE", "AI API 没有返回 message.content");
    return parseJsonObject(content);
  }
  async function transcribeAudio(audio, filename, settings, signal) {
    if (!settings.asrApiKey.trim()) throw new Halt("ASR_CONFIG", "听力题需要 ASR：请在面板填写 ASR API Key");
    const mimo = /mimo/i.test(settings.asrModel) || /xiaomimimo\.com/i.test(settings.asrApiBase);
    if (mimo) {
      const format = (/\.(mp3|wav|m4a|aac)(?:\?|$)/i.exec(filename)?.[1] || "mp3").toLowerCase();
      const response2 = await request({
        url: endpoint(settings.asrApiBase, "/chat/completions"),
        headers: authHeaders(settings.asrApiKey),
        data: JSON.stringify({ model: settings.asrModel, stream: false, messages: [{ role: "user", content: [
          { type: "input_audio", input_audio: { data: encodeBase64(audio), format } }
        ] }] })
      }, settings, signal);
      const parsed2 = contentObject(JSON.parse(response2.responseText || "{}"));
      const choice = contentObject(Array.isArray(parsed2.choices) ? parsed2.choices[0] : {});
      const content = contentObject(choice.message).content;
      const text3 = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof contentObject(part).text === "string" ? String(contentObject(part).text) : "").join("") : "";
      if (!text3.trim()) throw new Halt("ASR_RESPONSE", "MiMo ASR 没有返回转写文本");
      return text3.trim();
    }
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/mpeg" }), filename);
    form.append("model", settings.asrModel);
    const response = await request({
      url: endpoint(settings.asrApiBase, "/audio/transcriptions"),
      headers: authHeaders(settings.asrApiKey, false),
      data: form
    }, settings, signal);
    const parsed = contentObject(JSON.parse(response.responseText || "{}"));
    const text2 = typeof parsed.text === "string" ? parsed.text : Array.isArray(parsed.results) ? contentObject(parsed.results[0]).text : contentObject(parsed.result).text;
    if (typeof text2 !== "string" || !text2.trim()) throw new Halt("ASR_RESPONSE", "ASR 没有返回转写文本");
    return text2.trim();
  }

  // src/legacy-angular.ts
  var runtime;
  var application;
  function runInLegacyZone(job) {
    if (application?._zone?.run) application._zone.run(job);
    else job();
  }
  function legacyComponents() {
    const w = globalThis.unsafeWindow ?? window.unsafeWindow ?? window;
    const doc = w.document;
    if (!doc?.querySelector("app-root") || doc.querySelector("app-root")?.getAttribute("ng-version") !== "7.2.16" || !doc.querySelector("app-course-study-student") || !w.ng?.coreTokens?.ApplicationRef) return [];
    try {
      let walk2 = function(view) {
        if (!view || seen.has(view) || seen.size > 3e4) return;
        seen.add(view);
        for (const node of view.nodes || []) {
          if (node?.componentView) {
            if (node.renderElement?.nodeType === 1 && node.componentView.component) {
              result.push({ component: node.componentView.component, root: node.renderElement });
            }
            walk2(node.componentView);
          }
          for (const child of node?.viewContainer?._embeddedViews || []) walk2(child);
        }
      };
      var walk = walk2;
      if (!runtime) {
        if (!Array.from(doc.scripts).some((s) => /\/main\.4c93dc9c6da8077cd693\.js(?:\?|$)/.test(s.src)) || !Array.isArray(w.webpackJsonp)) return [];
        const key2 = "thoa-read-runtime-" + Math.random().toString(36).slice(2);
        w.webpackJsonp.push([[], { [key2]: (_m, _e, r) => {
          runtime = r;
        } }, [[key2]]]);
      }
      if (!runtime?.c.ZYjt || typeof runtime.c.ZYjt.exports.i !== "function") return [];
      const platform = runtime.c.ZYjt.exports.i();
      const apps = (platform._modules || []).map((m) => m.injector.get(w.ng.coreTokens.ApplicationRef, null)).filter(Boolean);
      application = apps[0];
      const result = [], seen = /* @__PURE__ */ new Set();
      for (const app of apps) for (const v of app._views || []) walk2(v._view);
      return result;
    } catch {
      return [];
    }
  }

  // src/legacy-data.ts
  function legacyQuestion(exercise) {
    const e = normalizeExercise(exercise), type = Number(e.type);
    const q = { id: String(e.id || ""), type: `legacy_${type}`, instruction: String(e.contentString || "") };
    const audio = collectAudioIds(e);
    if (audio.length) q.audio = audio;
    if ([14, 15, 16, 25].includes(type) && Array.isArray(e.exerciseList)) {
      const parentScript = text(typeof e.audioScript === "string" ? e.audioScript : "");
      q.children = e.exerciseList.map((child) => {
        const question = legacyQuestion(child);
        const ext = object(question.extension);
        if (parentScript && question.extension && !Array.isArray(question.extension)) {
          question.extension = { ...ext, audioScript: parentScript };
        }
        return question;
      });
      return q;
    }
    if (type === 1 || type === 2) {
      q.type = type === 1 ? "choice_single" : "choice_multiple";
      q.answer = e.answer;
      q.extension = Array.isArray(e.choices) ? e.choices.map((c) => ({ idx: object(c).id, val: object(c).content })) : [];
    } else if ([3, 5, 17, 24].includes(type)) {
      q.type = "fill_base";
      const blanks = Array.isArray(e.fillBlanks) ? e.fillBlanks.map(object) : [];
      if (blanks.some((b) => typeof b.id !== "string" || !/^[\w-]+$/.test(b.id))) throw new Halt("DATA_SHAPE", "旧版填空标识格式异常");
      q.stem = blanks.map((b) => `<span class="zty-exercise-item-fill-blank" id="${b.id}"></span>`).join("");
      q.answer = blanks.map((b) => ({ idx: b.id, val: b.answer }));
      q.extension = { legacyType: type, options: Array.isArray(e.dragged) ? e.dragged.map((d) => object(d).id) : [] };
      if (type === 24) {
        const ids = q.extension.options;
        if (new Set(ids).size !== ids.length || blanks.some((b) => typeof b.answer !== "string" || !ids.includes(b.answer))) {
          throw new Halt("NO_ANSWER", "拖拽填空的答案缺失或无法唯一匹配选项");
        }
      }
    } else if ([6, 7].includes(type)) {
      q.type = "essay_questions_answers";
      q.answer = text(e.answer);
    } else if (type === 8) {
      q.type = "legacy_8";
      q.answer = text(e.answer);
    } else if (type === 9 || type === 18) {
      q.type = type === 9 ? "legacy_9" : "legacy_18";
      const roles = arrayField(e, "roles", "roleList");
      const sentItems = arrayField(e, "sentItems", "sentenceItems", "items");
      q.extension = {
        roles: roles.map((r) => ({ id: object(r).id, name: object(r).name })),
        sentItems: sentItems.map((s) => ({
          idx: object(s).id,
          roleId: object(s).roleId,
          audioTime: object(s).audioTime,
          audio: object(s).audio ?? object(s).audioUrl ?? object(s).resId,
          text: richText(object(s).styleText ?? object(s).text ?? object(s).content)
        }))
      };
    } else if (type === 11) {
      const targets = arrayField(e, "drag").map((value) => {
        const target = object(value);
        return { id: String(target.id ?? ""), text: richText(target.styleContent) || String(target.content ?? "") };
      });
      const items = arrayField(e, "dragged").map((value) => {
        const item = object(value);
        return { id: String(item.id ?? ""), text: richText(item.styleContent) || String(item.content ?? "") };
      });
      if (!targets.length || targets.some((t) => !t.id) || !items.length || items.some((i) => !i.id)) {
        throw new Halt("DATA_SHAPE", "旧版分类拖拽题的目标或选项缺失");
      }
      q.type = "legacy_11";
      q.extension = { legacyType: 11, targets, items };
    } else if (type === 22) {
      const items = arrayField(e, "sentItems", "sentenceItems", "items").map((value) => {
        const item = object(value);
        return {
          id: String(item.id ?? ""),
          text: richText(item.styleText ?? item.text ?? item.content),
          answer: String(item.answer ?? item.optionId ?? "")
        };
      });
      const options = arrayField(e, "options", "choices").map((value) => {
        const option = object(value);
        return {
          id: String(option.id ?? ""),
          text: String(option.text ?? "") || richText(option.styleContent ?? option.content) || String(option.content ?? option.name ?? "")
        };
      });
      if (!items.length || items.some((item) => !item.id) || !options.length || options.some((option) => !option.id)) {
        throw new Halt("DATA_SHAPE", "旧版判断题缺少句子或判断选项");
      }
      q.type = "legacy_22";
      q.answer = items.map((item) => ({ idx: item.id, val: item.answer }));
      q.extension = { legacyType: 22, items, options };
    } else if (type === 19) {
      q.type = "fill_base";
      const blanks = Array.isArray(e.fillBlanks) ? e.fillBlanks.map(object) : [];
      if (!blanks.length || blanks.some((b) => typeof b.id !== "string" || !/^[\w-]+$/.test(b.id))) {
        throw new Halt("DATA_SHAPE", "旧版对话填空标识格式异常");
      }
      const parsed = dialogueData(e);
      q.stem = blanks.map((b) => '<span class="zty-exercise-item-fill-blank" id="' + String(b.id) + '"></span>').join("");
      q.answer = blanks.map((b) => {
        const plain = typeof b.answer === "string" ? b.answer : "";
        const standard = typeof b.standardAnswer === "string" ? b.standardAnswer : "";
        return { idx: b.id, val: plain || standard };
      });
      q.extension = {
        legacyType: 19,
        dialogue: parsed.items,
        blanks: parsed.blanks,
        audioScript: text(typeof e.audioScript === "string" ? e.audioScript : "")
      };
    } else if (type === 20) {
      q.type = "essay_questions_answers";
      q.answer = text(e.answer);
    }
    return q;
  }
  function normalizeExercise(value) {
    const root = object(value);
    if (root.type != null && root.id != null) return root;
    for (const key2 of ["exercise", "object", "item", "data", "choices"]) {
      const nested = object(root[key2]);
      if (nested.type != null || nested.id != null) return normalizeExercise(nested);
    }
    return root;
  }
  function arrayField(e, ...keys) {
    if (!Object.keys(e).length) return [];
    for (const key2 of keys) {
      if (Array.isArray(e[key2])) return e[key2];
      if (e[key2] && typeof e[key2] === "object") return Object.values(e[key2]);
    }
    for (const key2 of ["exercise", "object", "item", "data"]) {
      const nested = object(e[key2]);
      const found = arrayField(nested, ...keys);
      if (found.length) return found;
    }
    return [];
  }
  function collectAudioIds(value) {
    const out = [], seen = /* @__PURE__ */ new Set(), queue = [value];
    const add = (v) => {
      if (v == null) return;
      if (typeof v === "string") {
        if (v.trim()) out.push(v.trim());
        return;
      }
      if (Array.isArray(v)) {
        for (const item of v) add(item);
        return;
      }
      if (typeof v !== "object") return;
      const nested = object(v);
      for (const key2 of ["id", "resId", "url", "audioUrl", "path"]) {
        if (nested[key2] !== void 0) add(nested[key2]);
      }
    };
    while (queue.length && seen.size < 50) {
      const e = object(queue.shift());
      if (!Object.keys(e).length || seen.has(e)) continue;
      seen.add(e);
      for (const key2 of ["audio", "audios", "audioList", "audioUrl", "listenAudio", "sound", "soundUrl"]) add(e[key2]);
      for (const key2 of ["exercise", "object", "item", "data"]) {
        const nested = e[key2];
        if (Array.isArray(nested)) queue.push(...nested);
        else if (nested && typeof nested === "object") queue.push(nested);
      }
    }
    return [...new Set(out)];
  }
  function richText(value) {
    if (typeof value === "string") return text(value);
    const v = object(value);
    if (typeof v.text === "string") return text(v.text);
    const paragraphs = Array.isArray(v.paragraphs) ? v.paragraphs : [];
    const chunks = [];
    for (const p of paragraphs) {
      const items = Array.isArray(object(p).contentItems) ? object(p).contentItems : [];
      for (const item of items) {
        const t = object(item).text;
        if (typeof t === "string") chunks.push(t);
      }
    }
    return chunks.join(" ").trim();
  }
  function dialogueData(e) {
    const items = [], blanks = [];
    for (const raw of arrayField(e, "dialogueContents")) {
      const dialogue = object(raw), parts = [];
      const paragraphs = Array.isArray(object(dialogue.content).paragraphs) ? object(dialogue.content).paragraphs : [];
      for (const paragraph of paragraphs) {
        const contentItems = Array.isArray(object(paragraph).contentItems) ? object(paragraph).contentItems : [];
        for (let index = 0; index < contentItems.length; index++) {
          const item = object(contentItems[index]);
          if (Number(item.type) === 2) {
            const idx = typeof item.id === "string" ? item.id : "";
            if (!idx) continue;
            const before = object(contentItems[index - 1]).text, after = object(contentItems[index + 1]).text;
            blanks.push({
              idx,
              before: typeof before === "string" ? before : "",
              after: typeof after === "string" ? after : ""
            });
            parts.push("[[" + idx + "]]");
          } else if (typeof item.text === "string") parts.push(item.text);
        }
      }
      items.push({ role: String(dialogue.role ?? ""), text: parts.join("") });
    }
    return { items, blanks };
  }
  function normalizeText(value) {
    let out = "";
    const map = [];
    let space = false;
    for (let index = 0; index < value.length; index++) {
      let ch = value[index];
      if (/[‘’]/.test(ch)) ch = "'";
      else if (/[“”]/.test(ch)) ch = '"';
      else if (/[‐-―]/.test(ch)) ch = "-";
      else if (ch === " ") ch = " ";
      if (/\s/.test(ch)) {
        if (space) continue;
        ch = " ";
        space = true;
      } else space = false;
      for (const piece of ch.toLowerCase()) {
        out += piece;
        map.push(index);
      }
    }
    return { text: out, map };
  }
  function scriptFillAnswers(q) {
    const ext = object(q.extension);
    const script = typeof ext.audioScript === "string" ? ext.audioScript : "";
    const blanks = Array.isArray(ext.blanks) ? ext.blanks.map(object) : [];
    if (!script || !blanks.length) return null;
    const source = normalizeText(script), answers = [];
    for (const blank of blanks) {
      const idx = typeof blank.idx === "string" ? blank.idx : "";
      const before = typeof blank.before === "string" ? blank.before : "";
      const after = typeof blank.after === "string" ? blank.after : "";
      const prefix2 = normalizeText(before), suffix = normalizeText(after);
      if (!idx) return null;
      const from = prefix2.text ? source.text.indexOf(prefix2.text) : 0;
      if (from < 0) return null;
      const start = from + prefix2.text.length;
      const end = suffix.text ? source.text.indexOf(suffix.text, start) : source.text.length;
      if (end < 0 || end <= start) return null;
      const answer = script.slice(source.map[start] ?? script.length, source.map[end] ?? script.length);
      const cleaned = answer.replace(/^[\s:：,，.。;；!！?？]+|[\s:：,，.。;；!！?？]+$/g, "");
      if (!cleaned) return null;
      answers.push({ idx, answer: cleaned });
    }
    return answers.length === blanks.length ? answers : null;
  }
  function legacyValue(q, record) {
    if (q.type === "legacy_22") {
      return Object.entries(object(object(record).answer)).map(([idx, value]) => ({
        idx,
        answer: String(object(value).id ?? "")
      }));
    }
    if (q.type === "legacy_11") {
      return Object.entries(object(object(record).answer)).map(([idx, value]) => ({
        idx,
        answers: Array.isArray(object(value).choiceIds) ? object(value).choiceIds.map(String) : []
      }));
    }
    const a = object(record).answer;
    if (q.type === "fill_base") return Object.entries(object(a)).map(([idx, v]) => ({
      idx,
      answer: object(q.extension).legacyType === 24 ? object(v).choiceId : object(v).content
    }));
    if (q.type.startsWith("essay_")) return { answer: a, annex: [] };
    if (q.type === "oral_simple_speak" || q.type === "legacy_8") return { audio: typeof a === "string" ? a : "" };
    if (q.type === "legacy_9") {
      const answers = object(a);
      return Object.entries(answers).map(([idx, value]) => ({ idx, audio: object(value).recordAudio || "" }));
    }
    if (q.type === "legacy_18") {
      const answers = object(a);
      return { roleId: String(object(record).roleId || ""), answers: Object.entries(answers).map(([idx, value]) => ({ idx, audio: object(value).recordAudio || "" })) };
    }
    return a;
  }
  function legacyData(payload) {
    const p = object(payload);
    const exercise = normalizeExercise(p.exercise);
    if (!exercise.id || !Number.isInteger(p.submitNum) || Number(p.submitNum) < 0) {
      throw new Halt("DATA_SHAPE", "旧版练习数据尚未加载或格式已变化");
    }
    const q = legacyQuestion(exercise), records = [];
    function visit(question, record) {
      if (question.children) for (const child of question.children) visit(child, object(object(record).answer)[String(child.id)]);
      else if (record) records.push({ questionId: question.id, userAnswer: legacyValue(question, record) });
    }
    visit(q, p.doRecord);
    return { questionVOList: [q], answerCount: Number(p.submitNum), questionAnswerItemVOList: records };
  }

  // src/legacy-adapter.ts
  function legacyRoute() {
    return /^\/legacy\/course-study-student\/\d+\/\d+\/\d+\/[\w-]+\/?$/.test(routePath());
  }
  var LegacyAdapter = class {
    constructor(components2 = legacyComponents) {
      this.components = components2;
    }
    rechallengeCounts = /* @__PURE__ */ new Map();
    visited = /* @__PURE__ */ new Set();
    discover() {
      if (!legacyRoute()) return [];
      return this.components().filter(({ component: c, root }) => root.matches("app-course-task-stu") && shown(root) && root.isConnected && typeof c.loadDoRecord === "function" && /^[\w-]+$/.test(String(c.pageId || ""))).map(({ component: c, root }) => ({
        key: `${routePath()}:${c.courseId}:${c.pageId}`,
        catalogId: String(c.courseId),
        contentId: String(c.pageId),
        root,
        title: `旧版 · ${String(c.pageTitle || "当前练习")}（${c.exerciseStatus === 1 ? "待作答" : "已提交/结果页"}）`
      }));
    }
    instance(unit) {
      const matches = this.components().filter(({ component: c, root }) => root === unit.root && String(c.pageId) === unit.contentId && String(c.courseId) === unit.catalogId);
      if (matches.length !== 1) throw new Halt("STALE_PAGE", "旧版练习已切换，请重新检测");
      return matches[0].component;
    }
    assertContext(unit) {
      if (!legacyRoute() || !unit.key.startsWith(routePath() + ":") || !unit.root.isConnected || !shown(unit.root)) {
        throw new Halt("PAGE_CHANGED", "页面或课程发生变化，请重新检测");
      }
      const c = this.instance(unit);
      if (c.role !== 4 || c.status !== 1 || ![1, 2].includes(c.flag) || [2, 4, 5].includes(c.data?.isVisiable)) throw new Halt("NOT_PRACTICE", "仅处理开放课程中的学生日常练习");
      const conflict = this.conflict();
      if (conflict) throw new Halt("SCRIPT_CONFLICT", conflict);
    }
    conflict() {
      return new TsinghuaAdapter().conflict();
    }
    async load(unit, signal) {
      check(signal);
      this.assertContext(unit);
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(attempt === 1 ? 1200 : 2400, signal);
        try {
          return await this.loadOnce(unit, signal);
        } catch (error) {
          if (!(error instanceof Halt) || error.code !== "LOAD_FAILED" || !/HTTP 530/.test(error.message)) throw error;
          last = error;
        }
      }
      throw last ?? new Halt("LOAD_FAILED", "旧版练习接口读取失败，已暂停，请检查网络后重试");
    }
    async loadOnce(unit, signal) {
      check(signal);
      this.assertContext(unit);
      const c = this.instance(unit);
      const source = c.http?.post(`/tsenglish/exercise/record_for_detail?courseId=${encodeURIComponent(c.courseId)}&pageId=${encodeURIComponent(c.pageId)}&userId=${encodeURIComponent(c.userId)}`, {});
      if (typeof source?.subscribe !== "function") throw new Halt("NO_LOADER", "无法访问旧版页面的正常练习读取方法");
      let subscription;
      try {
        const response = await bounded(new Promise((resolve, reject) => {
          subscription = source.subscribe({ next: resolve, error: reject });
        }), 3e4, signal);
        check(signal);
        this.assertContext(unit);
        const p = object(response);
        if (p.status === false) throw new Halt("LOAD_FAILED", "网站返回练习读取失败，请检查网页提示");
        return legacyData(p.object);
      } catch (error) {
        if (error instanceof Halt) throw error;
        const status = Number(object(error).status);
        throw new Halt(
          [401, 403].includes(status) ? "LOGIN" : "LOAD_FAILED",
          [401, 403].includes(status) ? "登录失效或无课程权限，请重新登录" : `旧版练习接口读取失败${status ? `（HTTP ${status}）` : ""}，已暂停，请检查网络后重试`
        );
      } finally {
        subscription?.unsubscribe();
      }
    }
    editable(unit) {
      this.assertContext(unit);
      const c = this.instance(unit);
      if (c.exerciseStatus !== 1 || c.submitLoading) throw new Halt("READ_ONLY", "当前为已提交的结果页；保持现有结果，请手动选择待作答练习");
      return c;
    }
    leaf(unit, task) {
      this.editable(unit);
      const rolePlay = task.question.type === "legacy_9" || task.question.type === "legacy_18";
      const matches = this.components().filter(({ component: c, root }) => unit.root.contains(root) && root.isConnected && typeof c.doRecordChange?.emit === "function" && shown(root) && (String(c.exercise?.id) === String(task.question.id) || rolePlay && ([9, 18].includes(Number(c.exercise?.type)) || typeof c.selectRole === "function" || typeof c.start === "function" || typeof c.playVadio === "function")));
      const usable = matches.filter(({ component: c }) => ![14, 15, 16, 25].includes(Number(c.exercise?.type)));
      if (!usable.length) throw new Halt("QUESTION_DOM", "旧版作答组件未就绪，请等待题目加载");
      const ranked = usable.map((entry) => {
        const c = entry.component;
        let score = 0;
        if (rolePlay) {
          if ([9, 18].includes(Number(c.exercise?.type))) score += 5;
          if (typeof c.selectRole === "function") score += 4;
          if (typeof c.start === "function") score += 4;
          if (typeof c.playVadio === "function") score += 4;
        } else if (!entry.root.tagName.startsWith("LIB-ADAP-")) score += 2;
        score += entry.root.tagName.startsWith("LIB-") ? 1 : 0;
        return { ...entry, score };
      }).sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best || ranked.length > 1 && best.score === ranked[1].score) {
        throw new Halt("QUESTION_DOM", "旧版作答组件未就绪或存在重复，请重新检测");
      }
      if (best.component.status !== 1) throw new Halt("READ_ONLY", "题目不处于可作答状态");
      return best;
    }
    run(unit, job) {
      this.editable(unit);
      runInLegacyZone(job);
    }
    async fill(unit, task, settings, signal) {
      check(signal);
      await this.ready(unit, signal);
      const { component: c, root } = await this.leafOrReload(unit, task, signal);
      task = await this.aiTask(task, root, c, settings, signal);
      if (task.kind === "choice") {
        if (typeof c.answerChange !== "function") throw new Halt("QUESTION_DOM", "旧版选择题控件已变化");
        const expected = Array.isArray(task.value) ? task.value : [task.value];
        const current = Array.isArray(c.doRecord.answer) ? c.doRecord.answer : [c.doRecord.answer];
        const ids = c.exercise.choices.map((o) => o.id);
        if (new Set(ids).size !== ids.length || expected.some((id2) => !ids.includes(id2))) throw new Halt("AMBIGUOUS", "选项无法唯一匹配");
        this.run(unit, () => {
          if (task.question.type === "choice_single") c.answerChange(task.value);
          else for (const id2 of ids) if (expected.includes(id2) !== current.includes(id2)) c.answerChange(id2);
        });
      } else if (task.kind === "fill") {
        const items = task.value;
        if (task.question.type === "legacy_22") {
          if (typeof c.selectOption !== "function") throw new Halt("QUESTION_DOM", "判断题控件已变化");
          const pairs = items.map((value) => {
            const pair = object(value);
            return { idx: String(pair.idx), answer: String(pair.answer ?? "") };
          });
          this.run(unit, () => {
            const record = object(c.doRecord);
            if (!record.answer || typeof record.answer !== "object" || Array.isArray(record.answer)) record.answer = {};
            const answers = record.answer;
            for (const pair of pairs) if (!answers[pair.idx]) answers[pair.idx] = { id: "", score: 0 };
            for (const pair of pairs) c.selectOption(pair.idx, pair.answer);
          });
        } else if (task.question.type === "legacy_11") {
          if (typeof c.drag !== "function") throw new Halt("QUESTION_DOM", "分类拖拽控件已变化");
          const groups = items.map((value) => {
            const group = object(value);
            return { idx: String(group.idx), answers: Array.isArray(group.answers) ? group.answers.map(String) : [] };
          });
          this.run(unit, () => {
            const record = object(c.doRecord);
            if (!record.answer || typeof record.answer !== "object" || Array.isArray(record.answer)) record.answer = {};
            const answers = record.answer;
            for (const group of groups) answers[group.idx] = { ...object(answers[group.idx]), id: group.idx, choiceIds: [], score: 0 };
          });
          const boxes = new Map(groups.flatMap((group) => group.answers).map((id2) => [
            id2,
            root.querySelector('[class~="' + id2 + '"]') ?? document.createElement("div")
          ]));
          this.run(unit, () => {
            for (const group of groups) for (const id2 of group.answers) {
              c.drag({
                previousContainer: { id: id2, data: [] },
                container: { id: group.idx, data: [] },
                item: { element: { nativeElement: boxes.get(id2) } }
              });
            }
            if (typeof c.answerChange === "function") c.answerChange();
            else c.doRecordChange.emit(c.doRecord);
          });
        } else if (c.exercise.type === 24) {
          if (typeof c.drag !== "function" || typeof c.delAnswer !== "function") throw new Halt("QUESTION_DOM", "拖拽控件已变化");
          if (new Set(items.map((i) => i.answer)).size !== items.length) throw new Halt("AMBIGUOUS", "拖拽答案存在重复选项，已暂停");
          this.run(unit, () => {
            for (const { idx } of items) if (c.doRecord.answer[idx]?.choiceId) c.delAnswer(idx);
            for (const { idx, answer } of items) c.drag({ previousContainer: { id: answer, data: {} }, container: { id: idx, data: {} } });
          });
        } else {
          this.run(unit, () => {
            const record = object(c.doRecord);
            if (!record.answer || typeof record.answer !== "object" || Array.isArray(record.answer)) record.answer = {};
            const answers = record.answer;
            for (const { idx } of items) {
              if (!answers[idx] || typeof answers[idx] !== "object") answers[idx] = { id: idx, score: 0, content: "" };
            }
          });
          const fields = items.map((item) => {
            const matches = [...root.querySelectorAll('[contenteditable="true"]')].filter((e) => e.id === `a-${item.idx}`);
            if (matches.length !== 1) throw new Halt("QUESTION_DOM", `填空 ${item.idx} 未找到唯一输入框`);
            return { item, field: matches[0] };
          });
          for (const { item, field } of fields) {
            check(signal);
            field.focus();
            field.innerText = item.answer ?? "";
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.blur();
          }
        }
      } else if (task.kind === "writing") {
        const fields = root.querySelectorAll("textarea");
        if (fields.length !== 1) throw new Halt("QUESTION_DOM", "问答输入框不唯一或尚未加载");
        const field = fields[0], answer = object(task.value).answer;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, answer);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.blur();
        if (String(c.doRecord.answer ?? "") !== String(answer)) {
          this.run(unit, () => {
            c.doRecord.answer = answer;
            if (typeof c.dataChange === "function") c.dataChange();
            else c.doRecordChange.emit(c.doRecord);
          });
        }
      }
      await sleep(80, signal);
      this.editable(unit);
      const actual = legacyValue(task.question, c.doRecord);
      if (stable(canonical(task.question, actual)) !== stable(canonical(task.question, task.value))) {
        throw new Halt("FILL_UNCONFIRMED", "网页尚未接收填写结果，已暂停");
      }
      return actual;
    }
    async record(unit, task, settings, signal) {
      await this.ready(unit, signal);
      const { component: c, root } = await this.leafOrReload(unit, task, signal);
      if (![8, 9, 18, 20].includes(Number(c.exercise.type))) throw new Halt("UNSUPPORTED", "此旧版评测题尚未适配，请手动作答");
      if (Number(c.exercise.type) === 8) return this.recordOralBrief(unit, task, settings, signal, c);
      if (Number(c.exercise.type) === 9) return this.recordRolePlay(unit, task, settings, signal, c, root);
      if (Number(c.exercise.type) === 18) return this.recordRolePlayTts(unit, task, settings, signal, c);
      if (!navigator.mediaDevices?.getUserMedia) throw new Halt("MICROPHONE", "浏览器未提供麦克风");
      let cancelled = false;
      try {
        const stream = await bounded(navigator.mediaDevices.getUserMedia({ audio: true }).then((stream2) => {
          if (cancelled) stream2.getTracks().forEach((t) => t.stop());
          return stream2;
        }), settings.timeoutMs, signal);
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        throw new Halt("MICROPHONE", "麦克风权限被拒绝、取消或设备不可用");
      } finally {
        cancelled = true;
      }
      this.editable(unit);
      check(signal);
      const start = root.querySelector('img[title="录音"]');
      if (!start) throw new Halt("RECORD_CONTROL", "未找到真实录音控件");
      const before = c.doRecord.answer;
      try {
        start.click();
        await until(() => c.isStart && c.recorder?.state === "recording" ? true : void 0, 8e3, signal);
        await sleep(settings.recordingSeconds * 1e3, signal);
        this.editable(unit);
        const stop = root.querySelector('img[title="停止"]');
        if (!stop) throw new Halt("RECORD_CONTROL", "未找到停止录音控件");
        stop.click();
        await until(
          () => !c.isStart && typeof c.doRecord.answer === "string" && c.doRecord.answer && c.doRecord.answer !== before ? true : void 0,
          settings.timeoutMs,
          signal
        );
        return legacyValue(task.question, c.doRecord);
      } finally {
        if (c.recorder?.state === "recording") {
          clearTimeout(c.timer);
          c.recorder.reset();
          c.isStart = false;
        }
      }
    }
    async recordOralBrief(unit, task, settings, signal, c) {
      const q = task.question;
      let answer = typeof q.answer === "string" ? q.answer.trim() : "";
      if (settings.aiAnswers) {
        if (!settings.aiApiKey.trim()) throw new Halt("AI_CONFIG", "口语简答题需要 AI 生成回答，请填写 AI API Key");
        let transcript = "";
        if (q.audio?.length && settings.asrApiKey.trim()) {
          try {
            transcript = await this.transcribeQuestionAudio(c, q.audio, settings, signal);
          } catch (error) {
            if (error instanceof Halt && error.code === "CANCELLED") throw error;
          }
        }
        const prompt = `你是英语口语考试助手。请根据题目写一个自然、简洁、适合朗读的英语回答，2-4 句。只返回 JSON：{"answer":"..."}。
题目: ${q.instruction || q.stem || ""}
页面文本:
${(q.stem || "").slice(0, 3e3)}
听力转写: ${transcript || "（无）"}`;
        const result = object(await answerWithAi(prompt, settings, signal));
        answer = typeof result.answer === "string" ? result.answer.trim() : "";
        if (!answer) throw new Halt("AI_ANSWER", "AI 没有返回口语简答题答案");
      }
      if (!answer) throw new Halt("NO_ANSWER", "口语简答题没有页面答案；请启用 AI 答题或手动填写");
      const audio = await synthesizeSpeech(answer, settings, signal);
      const id2 = await this.uploadOralAudio(c, audio, settings, signal);
      this.run(unit, () => {
        c.doRecord.answer = id2;
        c.doRecord.ossOrVod = 2;
        if (typeof c.dataChange === "function") c.dataChange();
        else c.doRecordChange.emit(c.doRecord);
      });
      await sleep(80, signal);
      this.editable(unit);
      return legacyValue(task.question, c.doRecord);
    }
    async uploadOralAudio(c, audio, settings, signal) {
      const upload = c.vodUploadService;
      if (typeof upload?.vodStartUpload !== "function" || typeof upload?.onVodComplete?.subscribe !== "function" || typeof upload?.onVodError?.subscribe !== "function") {
        throw new Halt("ORAL_DOM", "原站 VOD 上传服务尚未初始化，请刷新页面后重试");
      }
      let completeSub, errorSub;
      try {
        return await bounded(new Promise((resolve, reject) => {
          completeSub = upload.onVodComplete.subscribe((result) => {
            const id2 = object(result).id;
            if (typeof id2 === "string" && id2) resolve(id2);
            else reject(new Halt("UPLOAD_FAILED", "VOD 上传完成但没有返回音频 ID"));
          });
          errorSub = upload.onVodError.subscribe((error) => {
            const message = typeof error === "string" ? error : String(object(error).message || "");
            reject(new Halt("UPLOAD_FAILED", `VOD 上传失败${message ? `：${message.slice(0, 160)}` : ""}`));
          });
          upload.vodStartUpload({
            name: `thoa-${Date.now()}.mp3`,
            blob: new Blob([audio], { type: "audio/mpeg" })
          }, true);
        }), Math.max(6e4, settings.timeoutMs), signal);
      } finally {
        completeSub?.unsubscribe();
        errorSub?.unsubscribe();
      }
    }
    async recordRolePlay(unit, task, settings, signal, c, root) {
      const taskExt = object(task.question.extension);
      const nativeExt = object(legacyRoleExtension(c.exercise));
      const nativeItems = Array.isArray(nativeExt.sentItems) ? nativeExt.sentItems : [];
      const taskItems = Array.isArray(taskExt.sentItems) ? taskExt.sentItems : [];
      const items = (nativeItems.length ? nativeItems : taskItems).map((value) => {
        const item = object(value);
        return { ...item, id: item.id ?? item.idx };
      });
      const roles = (Array.isArray(nativeExt.roles) && nativeExt.roles.length ? nativeExt.roles : Array.isArray(taskExt.roles) ? taskExt.roles : []).map(object);
      const roleStart = root.querySelector(".lib-role-select-start button");
      const selectableRolePlay = typeof c.selectRole === "function" && (typeof c.start === "function" || !!roleStart);
      const listenRepeat = typeof c.sayBy === "function";
      if (!items.length || !selectableRolePlay && !listenRepeat) {
        throw new Halt("RECORDING_DOM", "未识别角色扮演/跟读组件：缺少角色、句子或原生作答回调");
      }
      let target = items;
      if (selectableRolePlay) {
        if (!roles.length) throw new Halt("RECORDING_DOM", "角色扮演题没有可选角色");
        const roleId = c.doRecord?.roleId || roles.find((role) => items.some((item) => String(item.roleId) === String(role.id)))?.id || roles[0].id;
        if (!roleId) throw new Halt("RECORDING_DOM", "角色扮演题没有可选角色");
        target = items.filter((item) => String(item.roleId) === String(roleId));
        if (!target.length) throw new Halt("RECORDING_DOM", "所选角色没有可录音句子");
        this.run(unit, () => c.selectRole(roleId));
      }
      if (target.some((item) => !item.id) || new Set(target.map((item) => String(item.id))).size !== target.length) {
        throw new Halt("RECORDING_DOM", "待录音句子的标识缺失、重复或无法匹配");
      }
      const answers = () => object(object(c.doRecord).answer);
      const done = (item) => {
        const answer = object(answers()[String(item.id)]);
        return typeof answer.recordAudio === "string" && !!answer.recordAudio;
      };
      const complete = () => target.every(done);
      if (complete()) return legacyValue(task.question, c.doRecord);
      if (settings.rolePlayAudioMode === "original" || settings.rolePlayAudioMode === "sample") {
        if (settings.rolePlayAudioMode === "original") {
          const speech = this.speechAssessment();
          for (const item of target) {
            if (done(item)) continue;
            const result = await this.scoreOriginalItem(c, item, speech, settings, signal);
            check(signal);
            this.editable(unit);
            this.run(unit, () => {
              const record = object(c.doRecord);
              if (!record.answer || typeof record.answer !== "object" || Array.isArray(record.answer)) record.answer = {};
              const current = record.answer;
              const id2 = String(item.id);
              current[id2] = { ...roleAnswer(), ...object(current[id2]), ...result };
              if (typeof c.dataChange === "function") c.dataChange();
              else c.doRecordChange.emit(record);
            });
            await sleep(80, signal);
          }
        } else {
          const urls = await Promise.all(target.map((item) => this.resolveAudioUrl(c, item, settings, signal)));
          check(signal);
          this.editable(unit);
          this.run(unit, () => {
            const record = object(c.doRecord);
            if (!record.answer || typeof record.answer !== "object" || Array.isArray(record.answer)) record.answer = {};
            const current = record.answer;
            const targetIds = new Set(target.map((item) => String(item.id)));
            for (const id2 of Object.keys(current)) {
              if (!targetIds.has(id2) && !object(current[id2]).recordAudio) delete current[id2];
            }
            target.forEach((item, index) => {
              const id2 = String(item.id);
              current[id2] = { ...roleAnswer(), ...object(current[id2]), recordAudio: urls[index] };
            });
            if (typeof c.dataChange === "function") c.dataChange();
            else c.doRecordChange.emit(record);
          });
        }
        await sleep(80, signal);
        this.editable(unit);
        if (!complete()) throw new Halt("AUDIO_RESOLVE", "音频已处理，但网页未接收跟读作答，请导出诊断");
        return legacyValue(task.question, c.doRecord);
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Halt("MICROPHONE", "浏览器未提供麦克风");
      let cancelled = false;
      try {
        const stream = await bounded(navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
          if (cancelled) s.getTracks().forEach((t) => t.stop());
          return s;
        }), settings.timeoutMs, signal);
        stream.getTracks().forEach((t) => t.stop());
      } catch (error) {
        if (error instanceof Halt && error.code === "CANCELLED") throw error;
        throw new Halt("MICROPHONE", "麦克风权限被拒绝、取消或设备不可用");
      } finally {
        cancelled = true;
      }
      this.editable(unit);
      if (selectableRolePlay) {
        if (roleStart) roleStart.click();
        else this.run(unit, () => c.start());
        const budget = Math.min(6e5, items.reduce((total, item) => {
          const seconds = Number(item.audioTime);
          return total + Math.max(3, Math.min(45, Number.isFinite(seconds) && seconds > 0 ? seconds : 9)) * 1e3;
        }, 0) + 3e4);
        try {
          await until(() => complete() ? true : void 0, budget, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const missing = target.filter((item) => !done(item)).map((item) => String(item.id));
          throw new Halt("RECORD_TIMEOUT", `等待角色扮演录音超时（未完成句子：${missing.join("、")}），请检查麦克风和页面提示`);
        }
      } else {
        sessionStorage.setItem("tsinghua-english-lib-audio", "0");
        for (const item of target) {
          check(signal);
          if (done(item)) continue;
          this.run(unit, () => c.sayBy(item));
          const seconds = Number(item.audioTime);
          const budget = Math.max(3, Math.min(45, Number.isFinite(seconds) && seconds > 0 ? seconds : 9)) * 1e3 + 3e4;
          try {
            await until(() => done(item) ? true : void 0, budget, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            throw new Halt("RECORD_TIMEOUT", `等待句子 ${String(item.id)} 录音超时，请检查麦克风和页面提示`);
          }
        }
      }
      return legacyValue(task.question, c.doRecord);
    }
    async startRolePlaySession(unit, c, signal) {
      if (typeof c.start !== "function") return;
      const answerCount = Object.keys(object(object(c.doRecord).answer)).length;
      if (answerCount > 0 && c.showSelectRole === false && c.isClose === true) return;
      if (c.showSelectRole === true && c.isClose === false) {
        await until(() => c.showSelectRole === false && c.isClose === true ? true : void 0, 1e4, signal);
        return;
      }
      const originalChange = c.changeAudioUrl;
      this.run(unit, () => {
        c.changeAudioUrl = () => {
        };
        c.start();
      });
      try {
        await until(() => {
          const ready = c.showSelectRole === false && c.isClose === true;
          const initialized = Object.keys(object(object(c.doRecord).answer)).length > 0;
          return ready && initialized ? true : void 0;
        }, 1e4, signal);
      } catch {
        throw new Halt("ROLE_START", "角色扮演启动超时，请检查页面角色选择和倒计时");
      } finally {
        this.run(unit, () => {
          c.changeAudioUrl = originalChange;
        });
      }
    }
    async recordRolePlayTts(unit, task, settings, signal, c) {
      const taskExt = object(task.question.extension);
      const nativeExt = object(legacyRoleExtension(c.exercise));
      const nativeItems = Array.isArray(nativeExt.sentItems) ? nativeExt.sentItems : [];
      const taskItems = Array.isArray(taskExt.sentItems) ? taskExt.sentItems : [];
      const items = (nativeItems.length ? nativeItems : taskItems).map((value) => {
        const item = object(value);
        return { ...item, id: item.id ?? item.idx };
      });
      const roles = (Array.isArray(nativeExt.roles) && nativeExt.roles.length ? nativeExt.roles : Array.isArray(taskExt.roles) ? taskExt.roles : []).map(object);
      if (!items.length || !roles.length || typeof c.selectRole !== "function") {
        throw new Halt("RECORDING_DOM", "legacy_18 缺少角色、句子或角色选择控件");
      }
      const roleId = c.doRecord?.roleId || roles.find((role) => items.some((item) => String(item.roleId) === String(role.id)))?.id || roles[0].id;
      if (!roleId) throw new Halt("RECORDING_DOM", "legacy_18 没有可选角色");
      const target = items.filter((item) => String(item.roleId) === String(roleId));
      if (!target.length || target.some((item) => !item.id) || new Set(target.map((item) => String(item.id))).size !== target.length) {
        throw new Halt("RECORDING_DOM", "legacy_18 所选角色句子标识缺失、重复或无法匹配");
      }
      this.run(unit, () => c.selectRole(roleId));
      if (!target.every((item) => {
        const answer = object(object(object(c.doRecord).answer)[String(item.id)]);
        return typeof answer.recordAudio === "string" && !!answer.recordAudio;
      })) await this.startRolePlaySession(unit, c, signal);
      const answers = () => object(object(c.doRecord).answer);
      const done = (item) => {
        const answer = object(answers()[String(item.id)]);
        return typeof answer.recordAudio === "string" && !!answer.recordAudio;
      };
      if (target.every(done)) return legacyValue(task.question, c.doRecord);
      if (!settings.ttsApiKey.trim()) {
        throw new Halt("TTS_CONFIG", "legacy_18 需要 TTS：请先在面板的 API 设置中填写 TTS API Key");
      }
      const speech = this.speechAssessment();
      for (const item of target) {
        check(signal);
        if (done(item)) continue;
        const text2 = richText(item.styleText ?? item.text ?? item.content);
        if (!text2) throw new Halt("TTS_TEXT", `句子 ${String(item.id)} 没有可合成文本`);
        const audio = await synthesizeSpeech(text2, settings, signal);
        const result = await scoreWithChivox(speech, text2, audio, settings.timeoutMs, signal);
        check(signal);
        this.editable(unit);
        this.run(unit, () => {
          const record = object(c.doRecord);
          if (!record.answer || typeof record.answer !== "object" || Array.isArray(record.answer)) record.answer = {};
          const current = record.answer;
          const id2 = String(item.id);
          current[id2] = { ...roleAnswer(), ...object(current[id2]), ...result };
          if (typeof c.dataChange === "function") c.dataChange();
          else c.doRecordChange.emit(record);
        });
        await sleep(80, signal);
      }
      this.run(unit, () => {
        if (typeof c.selectNowRole === "function") c.selectNowRole();
        c.showSelectRole = false;
        c.showTime = false;
        c.isClose = true;
        if (typeof c.dataChange === "function") c.dataChange();
        else c.doRecordChange.emit(c.doRecord);
      });
      if (!target.every(done)) throw new Halt("TTS_SCORE", "TTS 已处理，但网页未接收角色扮演作答，请导出诊断");
      return legacyValue(task.question, c.doRecord);
    }
    // The legacy page sometimes renders before its own record request finishes, which
    // leaves the exercise in the initial read-only state with no inputs. Re-run the
    // site's own loader inside Angular's zone, then reopen an empty result record.
    async ready(unit, signal) {
      this.assertContext(unit);
      const c = this.instance(unit);
      if (Number(c.exerciseStatus) === 1) return c;
      if (Number(c.exerciseStatus) === 0 && typeof c.loadDoRecord === "function") {
        for (let attempt = 0; attempt < 3; attempt++) {
          runInLegacyZone(() => c.loadDoRecord());
          try {
            await until(() => Number(c.exerciseStatus) !== 0 ? true : void 0, 6e3, signal);
            break;
          } catch (error) {
            if (signal.aborted || error instanceof Halt && error.code !== "PAGE_TIMEOUT") throw error;
            if (attempt < 2) await sleep(1200, signal);
          }
        }
      }
      if (Number(c.exerciseStatus) === 0) {
        throw new Halt("NEEDS_RELOAD", "练习作答控件未渲染（页面偶发空白，需要刷新）");
      }
      if (Number(c.exerciseStatus) === 2 && this.emptyRecord(c)) {
        runInLegacyZone(() => {
          if (typeof c.retry === "function") c.retry();
          else {
            c.exerciseStatus = 1;
            c.doRecord = { type: c.exercise?.type };
          }
        });
        await until(() => Number(c.exerciseStatus) === 1 ? true : void 0, 5e3, signal);
      }
      if (Number(c.exerciseStatus) !== 1) throw new Halt("READ_ONLY", "当前为已提交的结果页；保持现有结果，请手动选择待作答练习");
      return c;
    }
    // A rendered-but-empty exercise may still lack its controls. One native reload of the
    // record is cheap; if that fails the controller refreshes the page and resumes.
    async leafOrReload(unit, task, signal) {
      try {
        return this.leaf(unit, task);
      } catch (error) {
        if (!(error instanceof Halt) || error.code !== "QUESTION_DOM") throw error;
        const c = this.instance(unit);
        if (String(c.exercise?.id ?? "") !== String(task.question.id)) throw error;
        if (typeof c.loadDoRecord === "function") {
          runInLegacyZone(() => c.loadDoRecord());
          try {
            await until(() => {
              try {
                this.leaf(unit, task);
                return true;
              } catch {
                return void 0;
              }
            }, 4e3, signal);
          } catch {
            throw new Halt("NEEDS_RELOAD", "练习作答控件未渲染（页面偶发空白，需要刷新）");
          }
        }
        return this.leaf(unit, task);
      }
    }
    emptyRecord(c) {
      if (c.isEmptyDoRecord === true) return true;
      const record = object(c.doRecord), answers = record.answer;
      if (answers == null) return true;
      if (typeof answers === "string") return !answers.trim();
      if (Array.isArray(answers)) return answers.length === 0;
      const values = Object.values(object(answers));
      if (!values.length) return true;
      return values.every((value) => {
        const entry = object(value);
        const content = entry.content ?? entry.recordAudio ?? entry.choiceId ?? entry.answer;
        if (typeof content === "string") return !content.trim();
        if (Array.isArray(content)) return content.length === 0;
        return content == null;
      });
    }
    hasTaskAnswers(task) {
      const value = task.value;
      if (task.kind === "choice") return Array.isArray(value) ? value.length > 0 : typeof value === "string" && !!value.trim();
      if (task.kind === "fill") {
        const items = Array.isArray(value) ? value.map(object) : [];
        if (!items.length) return false;
        return items.every((item) => Array.isArray(item.answers) ? item.answers.length > 0 : typeof item.answer === "string" && !!item.answer.trim());
      }
      if (task.kind === "writing") return typeof object(value).answer === "string" && !!String(object(value).answer).trim();
      return false;
    }
    async aiTask(task, root, c, settings, signal) {
      const ext = object(task.question.extension);
      if (task.kind === "fill" && Number(ext.legacyType) === 19) {
        const scripted = scriptFillAnswers(task.question);
        if (scripted) return { ...task, value: scripted };
      }
      if (task.kind !== "recording" && this.hasTaskAnswers(task)) return task;
      if (task.kind === "recording") return task;
      if (!settings.aiApiKey.trim()) {
        if (settings.aiAnswers) throw new Halt("AI_CONFIG", "已启用 AI 答题，但未填写 AI API Key");
        throw new Halt("NO_ANSWER", "题目没有可解析的答案，且未配置 AI API Key");
      }
      const q = task.question;
      const script = typeof ext.audioScript === "string" ? ext.audioScript : "";
      const dialogue = Array.isArray(ext.dialogue) ? ext.dialogue.map((line) => {
        const entry = object(line);
        return `${String(entry.role || "")}: ${String(entry.text || "")}`;
      }) : [];
      const transcript = script || (q.audio?.length ? await this.transcribeQuestionAudio(c, q.audio, settings, signal) : "");
      const options = Array.isArray(q.extension) ? q.extension.map((option) => ({
        id: String(object(option).idx),
        text: text(object(option).val)
      })) : [];
      const blanks = Array.isArray(task.value) ? task.value.map(object).map((blank) => ({ idx: String(blank.idx) })) : [];
      const pageRoot = root.closest("app-course-task-stu") ?? root;
      const pageText = (pageRoot.innerText || pageRoot.textContent || root.innerText || root.textContent || "").slice(0, 8e3);
      const judge = Number(ext.legacyType) === 22 ? {
        items: (Array.isArray(ext.items) ? ext.items : []).map((item) => ({ id: String(object(item).id), text: String(object(item).text ?? "") })),
        options: (Array.isArray(ext.options) ? ext.options : []).map((option) => ({ id: String(object(option).id), text: String(object(option).text ?? "") }))
      } : null;
      const catalog = Number(ext.legacyType) === 11 ? {
        targets: (Array.isArray(ext.targets) ? ext.targets : []).map((target) => ({ id: String(object(target).id), text: String(object(target).text ?? "") })),
        items: (Array.isArray(ext.items) ? ext.items : []).map((item) => ({ id: String(object(item).id), text: String(object(item).text ?? "") }))
      } : null;
      const schema = task.kind === "choice" ? '{"choice":["选项ID", ...]}' : task.kind === "fill" ? Number(ext.legacyType) === 11 ? '{"fill":[{"idx":"目标ID","answers":["项目ID", ...]}]}' : '{"fill":[{"idx":"空位ID","answer":"答案"}]}' : '{"answer":"完整答案文本"}';
      const prompt = `你正在完成清华社英语旧版练习。只返回一个 JSON 对象，不要 Markdown。
题型: ${q.type}（${task.kind}）
题目说明: ${q.instruction || ""}
对话（[[空位ID]] 为待填空格）: ${dialogue.length ? "\n" + dialogue.join("\n") : "（无）"}
页面可见文本（含词库/图片说明）:
${pageText}
选项: ${JSON.stringify(options)}
空位: ${JSON.stringify(blanks)}
${catalog ? `分类目标: ${JSON.stringify(catalog.targets)}
待分类项: ${JSON.stringify(catalog.items)}` : ""}
${judge ? `判断题句子: ${JSON.stringify(judge.items)}
判断选项: ${JSON.stringify(judge.options)}` : ""}
听力转写: ${transcript || "（无）"}
返回格式: ${schema}
${q.type === "fill_base" && object(q.extension).legacyType === 24 ? "拖拽填空的 answer 必须使用选项中的 ID。" : ""}
${q.type === "fill_base" && object(q.extension).legacyType === 19 ? "对话填空必须逐字摘录听力原文中的片段，保留原词，不要改写或翻译。" : ""}
${Number(ext.legacyType) === 11 ? "每个待分类项必须且只能放入一个目标，全部项目都要分配。" : ""}
${Number(ext.legacyType) === 22 ? "判断题每条句子必须选择一个判断选项 ID，使用选项的 id 字段；不要返回 T/F/NI 字母或 true/false，除非该字母本身就是选项 id。" : ""}
${task.kind === "fill" ? "若页面出现词库或选项框，填空答案必须从词库中选择原样文本，不要自创词。" : ""}
必须严格回答当前题目。`;
      const result = await answerWithAi(prompt, settings, signal);
      try {
        return { ...task, value: this.validateAiValue(task, result) };
      } catch (error) {
        if (Number(ext.legacyType) === 22 && error instanceof Halt && error.code === "AI_ANSWER") {
          const allowed = (Array.isArray(ext.options) ? ext.options : []).map((option) => {
            const entry = object(option);
            return { id: String(entry.id), text: String(entry.text ?? "") };
          });
          const retry = await answerWithAi(
            `${prompt}

上一次返回不符合要求：${JSON.stringify(result).slice(0, 800)}
只能使用这些选项 id：${JSON.stringify(allowed)}
请重新返回 {"fill":[{"idx":"句子ID","answer":"选项ID"}]}。`,
            settings,
            signal
          );
          return { ...task, value: this.validateAiValue(task, retry) };
        }
        throw error;
      }
    }
    async transcribeQuestionAudio(c, audioIds, settings, signal) {
      if (!settings.asrApiKey.trim()) throw new Halt("ASR_CONFIG", "听力题需要 ASR：请先在面板填写 ASR API Key");
      const transcripts = [];
      for (let index = 0; index < audioIds.length; index++) {
        const url = await this.resolveAudioUrl(c, { id: `audio-${index}`, audio: audioIds[index] }, settings, signal);
        let audio;
        try {
          audio = await bounded(fetch(url, { credentials: "omit" }).then((response) => {
            if (!response.ok) throw new Halt("ASR_AUDIO", `听力音频下载失败（HTTP ${response.status}）`);
            return response.arrayBuffer();
          }), settings.timeoutMs, signal);
        } catch (error) {
          if (error instanceof Halt) throw error;
          throw new Halt("ASR_AUDIO", "听力音频下载失败，请检查网络或登录状态");
        }
        transcripts.push(await transcribeAudio(audio, `question-${index}.mp3`, settings, signal));
      }
      return [...new Set(transcripts.filter(Boolean))].join("\n");
    }
    validateAiValue(task, value) {
      const result = object(value), q = task.question;
      if (task.kind === "choice") {
        const options = Array.isArray(q.extension) ? q.extension.map((option) => String(object(option).idx)) : [];
        const selected = Array.isArray(result.choice) ? result.choice.map(String) : [];
        if (!selected.length || selected.some((id2) => !options.includes(id2)) || new Set(selected).size !== selected.length || q.type !== "choice_multiple" && selected.length !== 1) {
          throw new Halt("AI_ANSWER", "AI 返回的选项不符合当前选择题");
        }
        return q.type === "choice_multiple" ? selected : selected[0];
      }
      if (task.kind === "fill" && Number(object(q.extension).legacyType) === 22) {
        const ext = object(q.extension);
        const options = (Array.isArray(ext.options) ? ext.options : []).map(object);
        const items = Array.isArray(task.value) ? task.value.map(object) : [];
        const raw = [result.fill, result.judge, result.answers].find(Array.isArray);
        const rows = (raw || []).map((entry) => typeof entry === "object" && entry !== null ? object(entry) : { answer: entry });
        const byId = new Map(rows.map((row) => [String(row.idx ?? ""), row.answer ?? row.value]));
        const text2 = (value2) => typeof value2 === "string" ? value2.trim().toLowerCase().replace(/[.。!！]/g, "") : typeof value2 === "boolean" ? value2 ? "true" : "false" : "";
        const match = (value2) => {
          const rawValue = text2(value2);
          if (!rawValue) return void 0;
          const exact = options.find((option) => String(option.id) === String(value2).trim());
          if (exact) return String(exact.id);
          const sameText = options.find((option) => text2(option.text) === rawValue);
          if (sameText) return String(sameText.id);
          const pick = (aliases) => {
            const hit = options.find((option) => aliases.includes(text2(option.text)));
            return hit ? String(hit.id) : void 0;
          };
          if (["t", "true", "yes", "正确", "对", "√"].includes(rawValue)) return pick(["t", "true", "yes", "正确"]);
          if (["f", "false", "no", "错误", "错", "×"].includes(rawValue)) return pick(["f", "false", "no", "错误"]);
          if (["ni", "no information", "not given", "未提及"].includes(rawValue)) return pick(["ni", "no information", "not given"]);
          return void 0;
        };
        if (!options.length || !items.length) throw new Halt("AI_ANSWER", "判断题选项或句子为空");
        return items.map((item, index) => {
          const idx = String(item.idx);
          const resolved = match(byId.get(idx)) ?? (rows.length === items.length ? match(rows[index]?.answer ?? rows[index]?.value) : void 0);
          if (!resolved) throw new Halt("AI_ANSWER", `AI 返回的判断题答案缺失或不是有效选项（句子 ${idx}）`);
          return { idx, answer: resolved };
        });
      }
      if (task.kind === "fill" && Number(object(q.extension).legacyType) === 11) {
        const ext = object(q.extension);
        const itemIds = new Set((Array.isArray(ext.items) ? ext.items : []).map((item) => String(object(item).id)));
        const targets = Array.isArray(task.value) ? task.value.map(object) : [];
        const fill = Array.isArray(result.fill) ? result.fill.map(object) : [];
        const byId = new Map(fill.map((entry) => [
          String(entry.idx),
          Array.isArray(entry.answers) ? entry.answers.map(String) : []
        ]));
        const seen = /* @__PURE__ */ new Set();
        const value2 = targets.map((target) => {
          const idx = String(target.idx), answers = byId.get(idx) ?? [];
          if (!answers.length) throw new Halt("AI_ANSWER", `AI 返回的分类目标 ${idx} 为空`);
          for (const id2 of answers) {
            if (!itemIds.has(id2) || seen.has(id2)) throw new Halt("AI_ANSWER", "AI 返回的分类项缺失、重复或不属于本题");
            seen.add(id2);
          }
          return { idx, answers };
        });
        if (seen.size !== itemIds.size) throw new Halt("AI_ANSWER", "AI 返回的分类没有覆盖全部选项");
        return value2;
      }
      if (task.kind === "fill") {
        const blanks = Array.isArray(task.value) ? task.value.map(object) : [];
        const fill = Array.isArray(result.fill) ? result.fill.map(object) : [];
        const byId = new Map(fill.map((item) => [String(item.idx), String(item.answer ?? "").trim()]));
        const dragOptions = object(q.extension).legacyType === 24 ? object(q.extension).options : null;
        if (!blanks.length || blanks.some((blank) => {
          const answer = byId.get(String(blank.idx));
          return !answer || Array.isArray(dragOptions) && !dragOptions.includes(answer);
        })) throw new Halt("AI_ANSWER", "AI 返回的填空答案缺失、为空或不符合空位/选项");
        return blanks.map((blank) => ({ idx: String(blank.idx), answer: byId.get(String(blank.idx)) }));
      }
      if (task.kind === "writing") {
        const answer = typeof result.answer === "string" ? result.answer.trim() : "";
        if (!answer) throw new Halt("AI_ANSWER", "AI 返回的主观题答案为空");
        return { answer, annex: [] };
      }
      return task.value;
    }
    speechAssessment() {
      const found = this.components().find(({ component: c }) => c.chivoxRecorder?.context && typeof c.speechService?.startSentence === "function");
      if (!found) throw new Halt("SPEECH_INIT", "原站 Chivox 语音评测组件尚未初始化，请刷新页面后重试");
      return found.component;
    }
    async scoreOriginalItem(c, item, speech, settings, signal) {
      const source = item.audio ?? item.audioUrl ?? item.resId;
      if (typeof source !== "string" || !source.trim()) {
        throw new Halt("ORIGINAL_AUDIO", `句子 ${String(item.id)} 没有原题音频，请切换为真实麦克风模式`);
      }
      const text2 = richText(item.styleText ?? item.text ?? item.content);
      if (!text2) throw new Halt("ORIGINAL_AUDIO", `句子 ${String(item.id)} 没有可评测文本`);
      const url = await this.resolveAudioUrl(c, item, settings, signal);
      let audio;
      try {
        audio = await bounded(fetch(url, { credentials: "omit" }).then((response) => {
          if (!response.ok) throw new Halt("ORIGINAL_AUDIO", `原题音频下载失败（HTTP ${response.status}）`);
          return response.arrayBuffer();
        }), settings.timeoutMs, signal);
      } catch (error) {
        if (error instanceof Halt) throw error;
        throw new Halt("ORIGINAL_AUDIO", "原题音频下载失败，请检查网络或登录状态");
      }
      return scoreWithChivox(speech, text2, audio, settings.timeoutMs, signal);
    }
    async resolveAudioUrl(c, item, settings, signal) {
      const raw = item.audio ?? item.audioUrl ?? item.resId;
      if (typeof raw === "string") {
        const direct = absoluteAudio(raw);
        if (direct) return direct;
      }
      if (typeof raw !== "string" || !raw.trim()) {
        throw new Halt("AUDIO_RESOLVE", `角色扮演句子 ${String(item.id)} 缺少音频`);
      }
      const service = c.getWebUrlService ?? c.webUrlService ?? this.components().map(({ component }) => component.getWebUrlService ?? component.webUrlService).find((value) => typeof value?.getResUrl === "function");
      const source = typeof service?.getResUrl === "function" ? service.getResUrl(raw, 2) : void 0;
      if (typeof source?.subscribe !== "function") {
        throw new Halt("AUDIO_RESOLVE", "页面未提供音频解析服务，请关闭“角色扮演使用音频”后重试");
      }
      let subscription;
      try {
        const response = await bounded(new Promise((resolve, reject) => {
          subscription = source.subscribe({ next: resolve, error: reject });
        }), settings.timeoutMs, signal);
        const url = object(response).url;
        if (typeof url === "string" && url.trim()) return new URL(url, location.href).href;
        throw new Halt("AUDIO_RESOLVE", `角色扮演句子 ${String(item.id)} 的音频地址为空`);
      } catch (error) {
        if (error instanceof Halt) throw error;
        const status = Number(object(error).status);
        throw new Halt("AUDIO_RESOLVE", `角色扮演音频解析失败${status ? `（HTTP ${status}）` : ""}，请检查网络或关闭音频模式`);
      } finally {
        subscription?.unsubscribe();
      }
    }
    async submit(unit, signal) {
      check(signal);
      this.editable(unit);
      const buttons = [...unit.root.querySelectorAll("button")].filter((b) => /^Submit$/i.test(b.textContent?.trim() || "") && !b.disabled && shown(b));
      if (buttons.length !== 1) throw new Halt("SUBMIT_CONTROL", "无法唯一识别旧版 Submit 按钮，已暂停");
      buttons[0].click();
    }
    challengeModal() {
      const modal = [...document.querySelectorAll(".ant-modal-wrap")].find((el) => shown(el) && /闯关|Rechallenge|Review/.test(el.innerText || el.textContent || ""));
      return modal ? { modal, text: modal.innerText || modal.textContent || "" } : null;
    }
    goalFailure() {
      const found = this.challengeModal();
      if (!found || !/闯关失败/.test(found.text)) return null;
      const score = /本次成绩[:：]\s*(\d+)\s*分/.exec(found.text)?.[1];
      return `目标闯关未通过${score ? `（${score}分）` : ""}，请手动 Rechallenge 或调整答案后重试`;
    }
    async next(unit, signal, settings, beforeRechallenge) {
      check(signal);
      this.assertContext(unit);
      this.visited.add(unit.key);
      const failed = this.goalFailure();
      if (failed) return this.rechallenge(unit, signal, failed, settings, beforeRechallenge);
      const successModal = this.challengeModal();
      if (successModal && /闯关成功/.test(successModal.text)) {
        this.rechallengeCounts.delete(unit.key);
        successModal.modal.querySelector(".ant-modal-close")?.click();
        await sleep(300, signal);
      }
      const right = [...document.querySelectorAll(".page-next")].find((el) => !!el.querySelector('img[src*="tx_page_right"]') && shown(el));
      if (!right || right.getAttribute("aria-disabled") === "true" || right.classList.contains("disabled")) {
        return this.catalogNext(unit, signal);
      }
      const oldKey = unit.key;
      right.click();
      try {
        await until(() => {
          const failure2 = this.goalFailure();
          if (failure2) throw new Halt("GOAL_FAILURE_DETECTED", failure2);
          const found2 = this.discover()[0];
          return found2 && found2.key !== oldKey ? found2 : void 0;
        }, 2e4, signal);
      } catch (error) {
        if (error instanceof Halt && error.code === "GOAL_FAILURE_DETECTED") {
          return this.rechallenge(unit, signal, error.message, settings, beforeRechallenge);
        }
        throw error;
      }
      const found = this.discover()[0];
      if (found && this.visited.has(found.key)) {
        const moved = await this.catalogNext(unit, signal);
        if (moved && !this.visited.has(moved.key)) return moved;
      }
      if (found) this.visited.add(found.key);
      return found;
    }
    // Walk the course catalog in display order and open the next clickable page after the
    // current one. Locked pages (isClick=false) are skipped, so a failed goal still stops.
    async catalogNext(unit, signal) {
      const c = this.instance(unit);
      const list = c.courseStudyService?.catalogList?.[c.courseId];
      if (!list) return void 0;
      const pages = [];
      const walk = (node) => {
        const children = Array.isArray(node.children) ? node.children : [];
        for (const raw of children) {
          const child = object(raw);
          if (typeof child.key === "string" && child.pageId) {
            pages.push({ key: child.key, click: child.isClick !== false, vis: Number(child.isVisiable ?? 1) });
          }
          if (Array.isArray(child.children) && child.children.length) walk(child);
        }
      };
      walk(object(list));
      const current = routePath().split("/").filter(Boolean).pop() || "";
      const index = pages.findIndex((page2) => page2.key === current);
      if (index < 0) return void 0;
      const next = pages.slice(index + 1).find((page2) => page2.click && page2.vis !== 2);
      if (!next) return void 0;
      runInLegacyZone(() => {
        void c.router?.navigate?.(
          ["/course-study-student", String(c.textbookId), String(c.courseId), String(c.userId), next.key]
        );
      });
      try {
        await until(() => {
          const found2 = this.discover()[0];
          return found2 && found2.key !== unit.key ? found2 : void 0;
        }, 2e4, signal);
      } catch {
        return void 0;
      }
      const found = this.discover()[0];
      if (found) this.visited.add(found.key);
      return found;
    }
    async rechallenge(unit, signal, reason, settings, beforeRechallenge) {
      if (!settings?.autoRechallenge) throw new Halt("GOAL_FAILED", reason);
      const count = (this.rechallengeCounts.get(unit.key) || 0) + 1;
      if (count > 2) throw new Halt("GOAL_RETRY_LIMIT", `${reason}；已自动 Rechallenge 2 次，暂停`);
      const modal = this.challengeModal();
      if (!modal) throw new Halt("GOAL_FAILED", reason);
      const again = [...modal.modal.querySelectorAll("button")].find((button) => /rechallenge/i.test(button.textContent || ""));
      if (!again) throw new Halt("GOAL_FAILED", `${reason}；未找到 Rechallenge 按钮`);
      this.rechallengeCounts.set(unit.key, count);
      this.visited.clear();
      beforeRechallenge?.();
      again.click();
      await until(() => {
        const found = this.discover()[0];
        return found && found.key !== unit.key ? found : void 0;
      }, 2e4, signal);
      return this.discover()[0];
    }
  };
  function roleAnswer() {
    return {
      score: 0,
      accuracy: 0,
      fluency: 0,
      senseGroup: 0,
      speed: 0,
      stress: 0,
      integrity: 0,
      rhythm: 0,
      pron: 0,
      recordAudio: "",
      words: [],
      ccode: {},
      result: ""
    };
  }
  function absoluteAudio(value) {
    const raw = value.trim();
    if (!raw) return "";
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("/") || /\.(mp3|wav|m4a|aac)(\?|#|$)/i.test(raw)) {
      try {
        return new URL(raw, location.href).href;
      } catch {
        return raw;
      }
    }
    return "";
  }
  function legacyRoleExtension(exercise) {
    const e = object(exercise);
    const findArray = (keys) => {
      for (const key2 of keys) {
        const value = e[key2];
        if (Array.isArray(value)) return value;
        if (value && typeof value === "object") return Object.values(value);
      }
      for (const key2 of ["exercise", "object", "item", "data"]) {
        const found = findArrayAt(e[key2], keys);
        if (found.length) return found;
      }
      return [];
    };
    const roles = findArray(["roles", "roleList"]);
    const sentItems = findArray(["sentItems", "sentenceItems", "items"]);
    return { roles, sentItems };
  }
  function findArrayAt(value, keys) {
    const e = object(value);
    if (!Object.keys(e).length) return [];
    for (const key2 of keys) {
      const current = e[key2];
      if (Array.isArray(current)) return current;
      if (current && typeof current === "object") return Object.values(current);
    }
    for (const key2 of ["exercise", "object", "item", "data"]) {
      const found = findArrayAt(e[key2], keys);
      if (found.length) return found;
    }
    return [];
  }

  // src/adaptive-adapter.ts
  var AdaptiveAdapter = class {
    modern = new TsinghuaAdapter();
    legacy = new LegacyAdapter();
    get active() {
      return legacyRoute() ? this.legacy : this.modern;
    }
    discover() {
      return this.active.discover();
    }
    assertContext(unit) {
      return this.active.assertContext(unit);
    }
    load(unit, signal) {
      return this.active.load(unit, signal);
    }
    fill(unit, task, settings, signal) {
      return this.active.fill(unit, task, settings, signal);
    }
    record(unit, task, settings, signal) {
      return this.active.record(unit, task, settings, signal);
    }
    submit(unit, signal) {
      return this.active.submit(unit, signal);
    }
    next(unit, signal, settings, beforeRechallenge) {
      return this.active.next?.(unit, signal, settings, beforeRechallenge) || Promise.resolve(void 0);
    }
    conflict() {
      return this.active.conflict();
    }
  };

  // src/controller.ts
  var browserLock = async (key2, job) => {
    if (!navigator.locks) throw new Halt("NO_LOCK", "此浏览器未提供多标签页互斥锁，请使用新版 Chromium");
    await navigator.locks.request("thoa:" + key2, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Halt("BUSY_TAB", "另一个标签页正在处理此课程，请先在那里停止");
      await job();
    });
  };
  function completedOnServer(data) {
    const records = data.questionAnswerItemVOList || [];
    const qs = leaves(data.questionVOList);
    return (data.answerCount || 0) > 0 && qs.length > 0 && qs.every((q) => {
      const rs = records.filter((r) => String(r.questionId) === String(q.id));
      if (rs.length !== 1) return false;
      return hasCompleteResponse(q, rs[0].userAnswer);
    });
  }
  var Controller = class {
    constructor(adapter, store, withLock = browserLock, reload = () => location.reload()) {
      this.adapter = adapter;
      this.store = store;
      this.withLock = withLock;
      this.reload = reload;
    }
    progress = {
      status: "idle",
      message: "请选择当前练习后开始",
      phase: "",
      type: "",
      completed: 0,
      total: 0,
      unitsDone: 0,
      unitsTotal: 0,
      pending: []
    };
    logs = [];
    abort;
    active = false;
    stopStatus = "paused";
    listeners = /* @__PURE__ */ new Set();
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    // A disposed or broken panel must never turn a worked run into an unhandled rejection.
    emit() {
      this.listeners.forEach((fn) => {
        try {
          fn();
        } catch {
        }
      });
    }
    update(value) {
      Object.assign(this.progress, value);
      this.emit();
    }
    report(code, message, error = false) {
      this.logs.push({ time: (/* @__PURE__ */ new Date()).toISOString(), level: error ? "error" : "info", code, message });
      this.logs = this.logs.slice(-120);
      this.update({ message });
    }
    get busy() {
      return this.active;
    }
    pause(stopped = false) {
      if (!this.active) {
        this.update({ status: stopped ? "stopped" : "paused" });
        return;
      }
      this.stopStatus = stopped ? "stopped" : "paused";
      this.update({ status: "pausing", message: "正在中断等待；已发出的提交会在下次运行时重新核对" });
      this.abort?.abort();
    }
    reset(unit) {
      if (this.active) throw new Halt("BUSY", "请先停止任务再重置记录");
      this.store.clear(unit.key);
      this.report("RESET", "本练习的本地提交记录已重置");
    }
    async start(selected, settings) {
      if (this.active) return;
      this.active = true;
      this.abort = new AbortController();
      this.stopStatus = "paused";
      const signal = this.abort.signal;
      this.update({ status: "running", completed: 0, total: 0, unitsDone: 0, unitsTotal: 0, pending: [], type: "", phase: "检查" });
      try {
        await this.withLock(selected.key.split(":").slice(0, -2).join(":"), async () => {
          check(signal);
          this.adapter.assertContext(selected);
          let units = settings.allLoaded ? this.adapter.discover().filter((u) => u.catalogId === selected.catalogId) : [selected];
          if (!units.some((u) => u.key === selected.key)) throw new Halt("STALE_PAGE", "所选练习已离开页面");
          this.update({ unitsTotal: units.length });
          const seen = new Set(units.map((entry) => entry.key));
          let index = 0;
          while (index < units.length) {
            const unit = units[index++];
            check(signal);
            this.adapter.assertContext(unit);
            await this.runUnit(unit, settings, signal);
            this.update({ unitsDone: this.progress.unitsDone + 1 });
            if (settings.continuous && this.adapter.next) {
              const next = await this.adapter.next(unit, signal, settings, () => {
                this.store.clearCourse(unit.key);
                seen.clear();
              });
              if (next) {
                if (seen.has(next.key)) {
                  throw new Halt("PAGE_CYCLE", "练习在未 Rechallenge 的情况下回到已完成的页面，已停止以避免重复提交");
                }
                seen.add(next.key);
                units.push(next);
                this.update({ unitsTotal: units.length });
              }
            }
          }
        });
        check(signal);
        this.update({ status: "done", phase: "完成", message: "所选练习已完成并重新读取核对" });
      } catch (error) {
        const halt = error instanceof Halt ? error : new Halt("UNEXPECTED", "运行异常，已暂停；请导出诊断并检查页面");
        if (signal.aborted) {
          const status = this.stopStatus;
          this.update({ status, message: status === "stopped" ? "已停止" : "已暂停，可继续重新核对" });
        } else if (halt.code === "NEEDS_RELOAD") {
          if (this.store.requestResume()) {
            this.report("RELOAD", "页面作答控件未渲染，正在自动刷新并继续", true);
            this.reload();
          } else {
            this.update({ status: "paused" });
            this.report("RELOAD_LIMIT", `${halt.message}；已自动刷新 3 次仍未恢复，请手动刷新页面`, true);
          }
        } else {
          this.update({ status: "paused" });
          this.report(halt.code, halt.message, true);
        }
      } finally {
        this.active = false;
        this.emit();
      }
    }
    async runUnit(unit, settings, signal) {
      this.update({ phase: "读取", message: `正在读取${unit.title}`, completed: 0 });
      let data = await this.adapter.load(unit, signal);
      const old = this.store.read(unit.key);
      if (old) {
        if (isSaved(data, old.baseline, old.expected, old.fingerprint)) {
          this.store.save({ ...old, phase: "verified", updatedAt: Date.now() });
          this.update({ completed: Object.keys(old.expected).length, total: Object.keys(old.expected).length });
          this.report("RECONCILED", "已核对服务器上的提交记录，跳过重复提交");
          this.store.resetResume();
          return;
        }
        if (old.phase === "pending") {
          throw new Halt("PENDING_SUBMIT", "上次提交结果尚不能确认，已阻止再次提交；请在网页核查后重置本地记录");
        }
        const answered = leaves(data.questionVOList).some((question) => {
          const record = (data.questionAnswerItemVOList || []).find((entry) => String(entry.questionId) === String(question.id));
          return !!record && hasCompleteResponse(question, record.userAnswer);
        });
        if (answered || (data.answerCount || 0) <= 0) {
          throw new Halt("RECORD_CHANGED", "服务器作答记录与本地记录不一致，请核查后重置本地记录");
        }
        this.store.clear(unit.key);
      }
      if (completedOnServer(data)) {
        this.update({ completed: leaves(data.questionVOList).length, total: leaves(data.questionVOList).length });
        this.report("ALREADY_SAVED", "服务器已有完整作答记录，保持现有结果");
        this.store.resetResume();
        return;
      }
      this.update({ phase: "解析", total: leaves(data.questionVOList).length });
      let tasks;
      try {
        tasks = planTasks(data, { allowMissing: settings.aiAnswers });
      } catch (error) {
        if (error instanceof Halt && ["NO_ANSWER", "AMBIGUOUS"].includes(error.code) && settings.aiApiKey.trim()) {
          tasks = planTasks(data, { allowMissing: true });
          this.report("AI_FALLBACK", "部分题目没有可解析的答案，已改用 AI 生成");
        } else {
          this.update({ pending: leaves(data.questionVOList).map((q) => ({
            questionId: String(q.id),
            type: q.type,
            reason: error instanceof Halt ? error.message : "解析失败"
          })) });
          throw error;
        }
      }
      const mark = fingerprint(data), values = /* @__PURE__ */ new Map();
      for (const task of tasks) {
        check(signal);
        this.adapter.assertContext(unit);
        this.update({
          phase: task.kind === "recording" ? "录音" : "填写",
          type: task.question.type,
          message: `正在处理题目 ${task.question.id}`
        });
        const value = task.kind === "recording" ? await this.adapter.record(unit, task, settings, signal) : await this.adapter.fill(unit, task, settings, signal);
        check(signal);
        values.set(String(task.question.id), value);
        this.update({ completed: values.size });
        await sleep(settings.intervalMs, signal);
      }
      const latest = await this.adapter.load(unit, signal);
      if (fingerprint(latest) !== mark || (latest.answerCount || 0) !== (data.answerCount || 0)) {
        throw new Halt("DATA_CHANGED", "题目或服务器作答记录在运行期间发生变化，已暂停");
      }
      data = latest;
      const checkpoint = {
        version: 1,
        key: unit.key,
        fingerprint: mark,
        baseline: data.answerCount || 0,
        expected: answerHashes(data, values),
        phase: "pending",
        updatedAt: Date.now()
      };
      check(signal);
      this.adapter.assertContext(unit);
      this.update({ phase: "提交", message: "正在提交当前练习块" });
      this.store.save(checkpoint);
      await this.adapter.submit(unit, signal);
      this.update({ phase: "核对", message: "正在重新读取服务器作答记录" });
      const deadline = Date.now() + settings.timeoutMs;
      do {
        check(signal);
        this.adapter.assertContext(unit);
        const saved = await bounded(this.adapter.load(unit, signal), Math.max(1, deadline - Date.now()), signal);
        if (isSaved(saved, checkpoint.baseline, checkpoint.expected, checkpoint.fingerprint)) {
          check(signal);
          this.store.save({ ...checkpoint, phase: "verified", updatedAt: Date.now() });
          this.report("VERIFIED", "提交成功，已重新读取并逐题核对作答记录");
          this.store.resetResume();
          return;
        }
        await sleep(Math.min(1e3, Math.max(1, deadline - Date.now())), signal);
      } while (Date.now() < deadline);
      throw new Halt("UNCONFIRMED", "提交结果未能确认，已保留待核对记录并停止；不会自动重复提交");
    }
  };

  // src/panel.ts
  var labels = {
    idle: "待开始",
    running: "运行中",
    pausing: "正在暂停",
    paused: "已暂停",
    stopped: "已停止",
    done: "已完成"
  };
  var styles = `
:host{all:initial!important;position:fixed!important;right:18px!important;bottom:18px!important;z-index:2147483647!important;display:block!important;color-scheme:light!important;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif!important;color:#263044!important}
*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;border:1px solid #d6dce7;border-radius:7px;background:#fff;color:#263044;padding:5px 11px}button:hover{background:#edf1fa}button:disabled{opacity:.45;cursor:default}.primary{background:#6c37a5;color:white;border-color:#6c37a5}.primary:hover{background:#572a89}
.panel{width:min(365px,calc(100vw - 36px));max-height:85vh;overflow:auto;background:white;border:1px solid #dbe0e9;border-radius:14px;box-shadow:0 8px 38px #1c183d33}.header{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:#f6f1fb;border-radius:14px 14px 0 0}.header strong{font-size:15px}.header button{padding:0 8px;font-size:19px}.body{padding:14px 16px}.hint{font-size:12px;color:#697285;margin:8px 0}.status{font-weight:650;color:#67369b}.message{overflow-wrap:anywhere;white-space:pre-wrap;font-size:13px;min-height:42px}.progress{margin:8px 0;width:100%;accent-color:#6c37a5}.row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:9px 0}select{width:100%;border:1px solid #d6dce7;border-radius:7px;padding:7px;background:white;color:inherit}input[type=number]{width:65px;border:1px solid #d6dce7;border-radius:5px;padding:3px}label{font-size:13px}input[type=checkbox]{accent-color:#6c37a5}details{border-top:1px solid #edf0f4;margin-top:10px;padding-top:8px}summary{cursor:pointer;font-size:12px;color:#697285}.logs{max-height:150px;overflow:auto;margin:7px 0;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#aa3040}.mini{border-radius:25px;background:#6c37a5;color:white;padding:10px 16px;box-shadow:0 4px 20px #33174933}.hidden{display:none!important}.actions button{flex:1}.pending{font-size:12px;color:#aa3040;max-height:70px;overflow:auto}.toolbar button{font-size:12px;padding:4px 8px}input[type=text],input[type=password]{width:100%;border:1px solid #d6dce7;border-radius:5px;padding:5px;margin:3px 0}details label{display:block;margin:6px 0}h4{margin:10px 0 2px;font-size:12px;color:#67369b}
`;
  var Panel = class {
    constructor(controller, adapter, store) {
      this.controller = controller;
      this.adapter = adapter;
      this.store = store;
      this.settings = store.settings();
      this.host.id = "tsinghua-online-auto";
      const style = document.createElement("style");
      style.textContent = styles;
      this.shadow.append(style);
      const frame = document.createElement("div");
      frame.innerHTML = `
      <button class="mini hidden" id="mini" title="展开练习助手（Alt+Shift+T）">练习助手</button>
      <section class="panel" id="panel" aria-label="清华社练习助手">
        <header class="header"><strong>清华社 · 练习助手 <small id="version"></small></strong><button id="collapse" title="收起">−</button></header>
        <div class="body"><div class="status" id="status" role="status" aria-live="polite"></div>
          <p class="message" id="message"></p>
          <label for="units">当前练习</label><select id="units" aria-label="当前练习"></select>
          <div class="row"><label><input id="all" type="checkbox"> 处理当前页全部已加载练习块</label></div>
          <div class="row"><label><input id="continuous" type="checkbox"> 完成后自动进入下一题/下一页</label></div>
          <div class="row"><label><input id="autoRechallenge" type="checkbox"> 目标未通过时自动 Rechallenge（最多 2 次）</label></div>
          <div class="row"><label>口语录音时长 <input id="seconds" type="number" min="3" max="180" step="1"> 秒</label></div>
          <div class="row"><label>角色扮演/跟读录音来源<select id="rolePlayMode">
            <option value="original">原题音频 → Chivox 评测（生成评分）</option>
            <option value="sample">原题音频直填（不评分）</option>
            <option value="microphone">真实麦克风</option>
          </select></label></div>
          <p class="hint">type 9 有原题音频时默认灌入原站 Chivox 生成评分；type 18 角色扮演使用 MiMo TTS 合成台词后再评测。跟读和单词题遵循页面时长。</p>
          <details open><summary>API 与连续答题设置</summary>
            <div class="row"><label><input id="aiAnswers" type="checkbox"> 用 AI API 生成旧版题目答案（听力题先走 ASR）</label></div>
            <h4>AI 答题 API（OpenAI 兼容）</h4>
            <label>API Key <input id="aiApiKey" type="password" autocomplete="off"></label>
            <label>API Base <input id="aiApiBase" type="text"></label>
            <label>模型 <input id="aiModel" type="text"></label>
            <h4>ASR 语音识别 API（OpenAI 兼容）</h4>
            <label>API Key <input id="asrApiKey" type="password" autocomplete="off"></label>
            <label>API Base <input id="asrApiBase" type="text"></label>
            <label>模型 <input id="asrModel" type="text"></label>
            <h4>TTS 语音合成 API</h4>
            <label>提供方 <select id="ttsProvider">
              <option value="mimo">MiMo（推荐）</option>
              <option value="openai">OpenAI 兼容 /audio/speech</option>
            </select></label>
            <label>API Key <input id="ttsApiKey" type="password" autocomplete="off"></label>
            <label>API Base <input id="ttsApiBase" type="text"></label>
            <label>模型 <input id="ttsModel" type="text"></label>
            <label>音色 <input id="ttsVoice" type="text"></label>
            <p class="hint">所有 API Key 只保存在当前标签页会话。听力题若检测到题目音频且已启用 AI 答题，会先调用 ASR。TTS 默认 MiMo，legacy_18 缺少配置时暂停。</p>
          </details>
          <progress id="progress" class="progress" value="0" max="1"></progress><div class="hint" id="counts"></div>
          <div class="actions row"><button class="primary" id="start">开始</button><button id="pause">暂停</button><button id="stop">停止</button></div>
          <div id="pending" class="pending"></div>
          <div class="toolbar row"><button id="refresh">重新检测</button><button id="export">导出诊断</button><button id="reset">重置本练习记录</button></div>
          <details><summary>运行日志</summary><div class="logs" id="logs"></div></details>
          <p class="hint">收起后可点右下角按钮，或按 Alt+Shift+T 恢复。</p>
        </div>
      </section>`;
      this.shadow.append(frame);
      this.el("version").textContent = false ? "dev" : "0.3.6";
      this.input("all").checked = this.settings.allLoaded;
      this.input("seconds").value = String(this.settings.recordingSeconds);
      this.el("rolePlayMode").value = this.settings.rolePlayAudioMode;
      this.input("continuous").checked = this.settings.continuous;
      this.input("autoRechallenge").checked = this.settings.autoRechallenge;
      this.input("aiAnswers").checked = this.settings.aiAnswers;
      this.input("aiApiKey").value = this.settings.aiApiKey;
      this.input("aiApiBase").value = this.settings.aiApiBase;
      this.input("aiModel").value = this.settings.aiModel;
      this.input("asrApiKey").value = this.settings.asrApiKey;
      this.input("asrApiBase").value = this.settings.asrApiBase;
      this.input("asrModel").value = this.settings.asrModel;
      this.el("ttsProvider").value = this.settings.ttsProvider;
      this.input("ttsApiKey").value = this.settings.ttsApiKey;
      this.input("ttsApiBase").value = this.settings.ttsApiBase;
      this.input("ttsModel").value = this.settings.ttsModel;
      this.input("ttsVoice").value = this.settings.ttsVoice;
      this.el("collapse").addEventListener("click", () => {
        this.el("panel").classList.add("hidden");
        this.el("mini").classList.remove("hidden");
      });
      this.el("mini").addEventListener("click", () => this.reveal());
      this.el("refresh").addEventListener("click", () => this.refresh(true));
      this.el("export").addEventListener("click", () => this.download());
      this.el("start").addEventListener("click", () => {
        const unit = this.selected();
        if (!unit) {
          this.controller.report("NO_UNIT", "请打开教材或课程的日常练习页后重新检测", true);
          return;
        }
        try {
          const raw = Number(this.input("seconds").value);
          const mode = this.el("rolePlayMode").value;
          const provider = this.el("ttsProvider").value;
          this.settings = {
            ...defaults,
            allLoaded: this.input("all").checked,
            continuous: this.input("continuous").checked,
            autoRechallenge: this.input("autoRechallenge").checked,
            recordingSeconds: Number.isFinite(raw) ? Math.min(180, Math.max(3, raw)) : defaults.recordingSeconds,
            rolePlayAudioMode: ["original", "sample", "microphone"].includes(mode) ? mode : defaults.rolePlayAudioMode,
            aiAnswers: this.input("aiAnswers").checked,
            aiApiKey: this.input("aiApiKey").value.trim(),
            aiApiBase: this.input("aiApiBase").value.trim() || defaults.aiApiBase,
            aiModel: this.input("aiModel").value.trim() || defaults.aiModel,
            asrApiKey: this.input("asrApiKey").value.trim(),
            asrApiBase: this.input("asrApiBase").value.trim() || defaults.asrApiBase,
            asrModel: this.input("asrModel").value.trim() || defaults.asrModel,
            ttsProvider: ["mimo", "openai"].includes(provider) ? provider : defaults.ttsProvider,
            ttsApiKey: this.input("ttsApiKey").value.trim(),
            ttsApiBase: this.input("ttsApiBase").value.trim() || defaults.ttsApiBase,
            ttsModel: this.input("ttsModel").value.trim() || defaults.ttsModel,
            ttsVoice: this.input("ttsVoice").value.trim() || defaults.ttsVoice
          };
          this.input("seconds").value = String(this.settings.recordingSeconds);
          this.store.saveSettings(this.settings);
          void this.controller.start(unit, this.settings);
        } catch (e) {
          this.error(e);
        }
      });
      this.el("pause").addEventListener("click", () => this.controller.pause());
      this.el("stop").addEventListener("click", () => this.controller.pause(true));
      this.el("reset").addEventListener("click", () => {
        const unit = this.selected();
        if (!unit || this.controller.busy) return;
        if (!window.confirm("请先在网页核查作答是否已保存。重置本地记录后可能再次提交本练习，是否继续？")) return;
        try {
          this.controller.reset(unit);
        } catch (e) {
          this.error(e);
        }
      });
      this.unsubscribe = this.controller.subscribe(() => this.render());
      this.render();
    }
    host = document.createElement("tsinghua-exercise-helper");
    shadow = this.host.attachShadow({ mode: "open" });
    units = [];
    settings;
    disposed = false;
    timer;
    observer;
    unsubscribe;
    keydown = (e) => {
      if (e.altKey && e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        this.reveal();
      }
    };
    el(id2) {
      return this.shadow.getElementById(id2);
    }
    input(id2) {
      return this.el(id2);
    }
    error(e) {
      this.controller.report(e instanceof Halt ? e.code : "PANEL_ERROR", e instanceof Halt ? e.message : "页面检测异常，请导出诊断", true);
    }
    selected() {
      return this.units.find((u) => u.key === this.el("units").value);
    }
    reveal() {
      this.el("panel").classList.remove("hidden");
      this.el("mini").classList.add("hidden");
    }
    mount() {
      const attach = () => {
        if (!this.disposed && document.body && !this.host.isConnected) document.body.append(this.host);
      };
      attach();
      this.observer = new MutationObserver(attach);
      this.observer.observe(document.documentElement || document, { childList: true, subtree: true });
      document.addEventListener("keydown", this.keydown);
      this.refresh();
      this.timer = setInterval(() => {
        if (!this.controller.busy) this.refresh();
      }, 3e3);
      void this.resume();
    }
    // The legacy site sometimes needs a reload to render an exercise's controls. When the
    // controller requests one, it leaves this flag so the refreshed page continues by itself.
    async resume() {
      if (!this.store.takeResume()) return;
      for (let attempt = 0; attempt < 60 && !this.disposed; attempt++) {
        this.refresh();
        if (this.units.length) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (this.disposed || !this.units.length || this.controller.busy) return;
      this.controller.report("RESUME", "页面已自动刷新，继续上次作答", false);
      void this.controller.start(this.units[0], this.settings);
    }
    refresh(manual = false) {
      if (this.controller.busy) return;
      try {
        const previous = this.el("units").value;
        this.units = this.adapter.discover();
        const select = this.el("units");
        const keys = this.units.map((u) => `${u.key}=${u.title}`).join("|");
        if (select.dataset.keys !== keys) {
          select.replaceChildren();
          select.dataset.keys = keys;
          for (const unit of this.units) {
            const option = document.createElement("option");
            option.value = unit.key;
            option.textContent = unit.title;
            select.append(option);
          }
          if (!this.units.length) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "未检测到可用练习";
            select.append(option);
          }
        }
        const visible = this.units.find((u) => {
          const r = u.root.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight;
        });
        select.value = this.units.some((u) => u.key === previous) ? previous : (visible || this.units[0])?.key || "";
        const conflict = this.adapter.conflict();
        if (manual) this.controller.report(conflict ? "SCRIPT_CONFLICT" : "DETECTED", conflict || (this.units.length ? `检测到 ${this.units.length} 个练习块` : this.noUnitMessage()), !!conflict);
        else if (this.controller.progress.status === "idle") {
          this.el("message").textContent = conflict || (this.units.length ? "已检测到日常练习，可以开始" : this.noUnitMessage());
        }
        this.render(false);
      } catch (e) {
        if (manual) this.error(e);
      }
    }
    noUnitMessage() {
      if (legacyRoute()) return "已进入旧版课程。请打开习题；若仍未检测到，请刷新网页并导出诊断（旧版组件尚未就绪或网站版本已变化）。";
      if (!allowedRoute()) return "助手已运行。请进入课程或教材的日常练习页；考试页面不会执行。";
      if (!components().length) return "面板已加载，但无法访问页面组件。请确认脚本在页面环境运行，并刷新网页。";
      return "正在等待练习组件。请展开含习题的章节，或点击重新检测。";
    }
    render(message = true) {
      if (this.disposed) return;
      const p = this.controller.progress, busy = this.controller.busy;
      this.el("status").textContent = `${labels[p.status]}${p.phase ? " · " + p.phase : ""}`;
      if (message) this.el("message").textContent = p.message;
      this.el("counts").textContent = `题目 ${p.completed}/${p.total} · 练习块 ${p.unitsDone}/${p.unitsTotal}${p.type ? " · " + p.type : ""}`;
      const progress = this.el("progress");
      progress.max = Math.max(p.total, 1);
      progress.value = p.completed;
      for (const id2 of ["units", "seconds", "all", "continuous", "autoRechallenge", "aiAnswers", "aiApiKey", "aiApiBase", "aiModel", "asrApiKey", "asrApiBase", "asrModel", "ttsProvider", "ttsApiKey", "ttsApiBase", "ttsModel", "ttsVoice", "rolePlayMode", "refresh", "reset"]) this.el(id2).disabled = busy;
      this.el("start").disabled = busy || !this.units.length;
      this.el("start").textContent = p.status === "paused" || p.status === "stopped" ? "继续" : "开始";
      this.el("pause").disabled = !busy;
      this.el("stop").disabled = !busy;
      this.el("pending").textContent = p.pending.map((t) => `题 ${t.questionId} · ${t.type}：${t.reason}`).join("\n");
      const logs = this.el("logs");
      logs.replaceChildren();
      for (const log of this.controller.logs.slice(-35)) {
        const line = document.createElement("div");
        if (log.level === "error") line.className = "error";
        line.textContent = `${log.time.slice(11, 19)} [${log.code}] ${log.message}`;
        logs.append(line);
      }
    }
    diagnostics() {
      let units = [], componentCount = 0;
      try {
        units = this.adapter.discover().map((u) => ({ catalogId: u.catalogId, contentId: u.contentId }));
        componentCount = components().length;
      } catch {
      }
      return {
        version: false ? "dev" : "0.3.6",
        generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        route: routePath().replace(/(\/legacy\/course-study-student)\/.*/, "$1/[redacted]"),
        allowedRoute: allowedRoute() || legacyRoute(),
        readyState: document.readyState,
        platform: legacyRoute() ? "legacy-angular" : "modern-vue",
        legacyComponentCount: legacyComponents().length,
        componentCount,
        units,
        scriptConflict: this.adapter.conflict(),
        browser: { microphone: !!navigator.mediaDevices?.getUserMedia, webLocks: !!navigator.locks, secureContext: window.isSecureContext },
        progress: { ...this.controller.progress },
        logs: this.controller.logs
      };
    }
    download() {
      const url = URL.createObjectURL(new Blob([JSON.stringify(this.diagnostics(), null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "tsinghua-helper-diagnostics.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    }
    dispose() {
      this.disposed = true;
      this.controller.pause(true);
      this.unsubscribe();
      clearInterval(this.timer);
      this.observer?.disconnect();
      document.removeEventListener("keydown", this.keydown);
      this.host.remove();
    }
  };

  // src/storage.ts
  var prefix = "thoa:v1:";
  function settingString(value, fallback, max) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
  }
  var Store = class {
    constructor(storage = localStorage, session = typeof sessionStorage === "undefined" ? localStorage : sessionStorage) {
      this.storage = storage;
      this.session = session;
    }
    settings() {
      try {
        const raw = JSON.parse(this.storage.getItem(prefix + "settings") || "{}");
        const mode = ["original", "sample", "microphone"].includes(raw.rolePlayAudioMode) ? raw.rolePlayAudioMode : raw.rolePlayExampleAudio === false ? "microphone" : defaults.rolePlayAudioMode;
        const provider = ["mimo", "openai"].includes(raw.ttsProvider) ? raw.ttsProvider : defaults.ttsProvider;
        return {
          allLoaded: raw.allLoaded === true,
          continuous: raw.continuous !== false,
          autoRechallenge: raw.autoRechallenge !== false,
          recordingSeconds: typeof raw.recordingSeconds === "number" && Number.isFinite(raw.recordingSeconds) ? Math.min(180, Math.max(3, raw.recordingSeconds)) : defaults.recordingSeconds,
          rolePlayAudioMode: mode,
          aiAnswers: raw.aiAnswers === true,
          aiApiKey: this.readSession(prefix + "aiApiKey"),
          aiApiBase: settingString(raw.aiApiBase, defaults.aiApiBase, 300),
          aiModel: settingString(raw.aiModel, defaults.aiModel, 120),
          asrApiKey: this.readSession(prefix + "asrApiKey"),
          asrApiBase: settingString(raw.asrApiBase, defaults.asrApiBase, 300),
          asrModel: settingString(raw.asrModel, defaults.asrModel, 120),
          ttsProvider: provider,
          ttsApiKey: this.readSession(prefix + "ttsApiKey") || this.readSession(prefix + "mimoApiKey"),
          ttsApiBase: settingString(raw.ttsApiBase ?? raw.mimoApiBase, defaults.ttsApiBase, 300),
          ttsModel: settingString(raw.ttsModel ?? raw.mimoTtsModel, defaults.ttsModel, 120),
          ttsVoice: settingString(raw.ttsVoice ?? raw.mimoTtsVoice, defaults.ttsVoice, 120),
          timeoutMs: defaults.timeoutMs,
          intervalMs: defaults.intervalMs
        };
      } catch {
        return {
          ...defaults,
          aiApiKey: this.readSession(prefix + "aiApiKey"),
          asrApiKey: this.readSession(prefix + "asrApiKey"),
          ttsApiKey: this.readSession(prefix + "ttsApiKey") || this.readSession(prefix + "mimoApiKey")
        };
      }
    }
    saveSettings(settings) {
      const { aiApiKey, asrApiKey, ttsApiKey, ...persisted } = settings;
      this.write(prefix + "settings", persisted);
      try {
        this.session.setItem(prefix + "aiApiKey", aiApiKey);
        this.session.setItem(prefix + "asrApiKey", asrApiKey);
        this.session.setItem(prefix + "ttsApiKey", ttsApiKey);
      } catch {
        throw new Halt("STORAGE_WRITE", "无法保存 API Key 到当前会话，请检查浏览器存储设置");
      }
    }
    readSession(key2) {
      try {
        return this.session.getItem(key2) || "";
      } catch {
        return "";
      }
    }
    read(key2) {
      try {
        const raw = this.storage.getItem(prefix + key2);
        if (!raw) return void 0;
        const c = JSON.parse(raw);
        if (c.version !== 1 || c.key !== key2 || !["pending", "verified"].includes(c.phase) || typeof c.fingerprint !== "string" || !Number.isInteger(c.baseline) || c.baseline < 0 || !c.expected || Array.isArray(c.expected) || typeof c.expected !== "object" || !Object.entries(c.expected).length || Object.entries(c.expected).some(([k, v]) => !/^[\w-]{1,128}$/.test(k) || !/^[0-9a-f]+$/.test(v))) throw Error();
        return c;
      } catch {
        throw new Halt("STORAGE_READ", "本地提交记录无法读取；请先在网页核查作答结果，再重置记录");
      }
    }
    save(checkpoint) {
      this.write(prefix + checkpoint.key, checkpoint);
    }
    clearCourse(unitKey) {
      const parts = unitKey.split(":");
      parts.pop();
      const keyPrefix = prefix + parts.join(":") + ":";
      try {
        for (let index = this.storage.length - 1; index >= 0; index--) {
          const key2 = this.storage.key(index);
          if (key2?.startsWith(keyPrefix)) this.storage.removeItem(key2);
        }
      } catch {
        throw new Halt("STORAGE_WRITE", "无法清理目标旧记录，请检查浏览器存储设置");
      }
    }
    // The site intermittently renders an exercise without its answer controls. A reload
    // repairs it, so remember only the intent to resume, plus a bounded retry budget.
    requestResume(now = Date.now()) {
      const saved = this.resumeState();
      const state = saved && now - saved.since < 10 * 6e4 ? saved : { count: 0, since: now, requested: false };
      if (state.count >= 3) return false;
      try {
        this.session.setItem(prefix + "resume", JSON.stringify({ count: state.count + 1, since: state.since, requested: true }));
        return true;
      } catch {
        return false;
      }
    }
    takeResume() {
      const state = this.resumeState();
      if (!state?.requested) return false;
      try {
        this.session.setItem(prefix + "resume", JSON.stringify({ ...state, requested: false }));
      } catch {
      }
      return true;
    }
    resetResume() {
      try {
        this.session.removeItem(prefix + "resume");
      } catch {
      }
    }
    resumeState() {
      try {
        const value = JSON.parse(this.session.getItem(prefix + "resume") || "null");
        if (!value || typeof value !== "object" || typeof value.count !== "number" || typeof value.since !== "number") return null;
        return { count: value.count, since: value.since, requested: value.requested === true };
      } catch {
        return null;
      }
    }
    clear(key2) {
      try {
        this.storage.removeItem(prefix + key2);
      } catch {
        throw new Halt("STORAGE_WRITE", "无法重置本地记录，请检查浏览器存储设置");
      }
    }
    write(key2, value) {
      try {
        this.storage.setItem(key2, JSON.stringify(value));
      } catch {
        throw new Halt("STORAGE_WRITE", "无法保存本地进度，已暂停以避免重复提交");
      }
    }
  };

  // src/main.ts
  var key = Symbol.for("tsinghua-online-auto.instance");
  var hostWindow = globalThis.unsafeWindow ?? window.unsafeWindow ?? window;
  var page = hostWindow;
  function boot() {
    if (hostWindow.top !== hostWindow.self) return;
    if (page[key]) {
      page[key].reveal();
      return;
    }
    const adapter = new AdaptiveAdapter(), store = new Store();
    const panel = new Panel(new Controller(adapter, store), adapter, store);
    page[key] = panel;
    panel.mount();
    hostWindow.addEventListener("pagehide", () => {
      panel.dispose();
      delete page[key];
    }, { once: true });
  }
  hostWindow.addEventListener("pageshow", (event) => {
    if (event.persisted) boot();
  });
  if (document.documentElement) boot();
  else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        boot();
      }
    });
    observer.observe(document, { childList: true });
  }
})();
