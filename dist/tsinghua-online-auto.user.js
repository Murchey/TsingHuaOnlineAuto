// ==UserScript==
// @name         清华社英语在线练习助手
// @namespace    local.tsinghua-online-auto
// @version      0.2.0
// @description  日常练习填写、原题音频 Chivox 评测、真实麦克风录音、MiMo API 接口预留、提交核对及故障诊断
// @match        https://www.tsinghuaelt.com/*
// @match        https://tsinghuaelt.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      api.xiaomimimo.com
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
    recordingSeconds: 10,
    rolePlayAudioMode: "original",
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
  function taskFor(q, record) {
    const raw = q.answer !== "" && q.answer != null ? q.answer : record?.answer;
    const answer = parse(raw);
    const extension = parse(q.extension);
    if (["oral_simple_speak", "oral_follow_along", "oral_vocabulary_learning", "legacy_9"].includes(q.type)) {
      return { question: q, kind: "recording" };
    }
    if (["choice_single", "choice_multiple", "judge_basic"].includes(q.type)) {
      const selected = q.type === "choice_multiple" ? answer : raw;
      const values = Array.isArray(selected) ? selected : [selected];
      const options = q.type === "judge_basic" ? ["1", "0"] : Array.isArray(extension) ? extension.map((o) => String(object(o).idx)) : [];
      if (!options.length || new Set(options).size !== options.length || !values.length || q.type !== "choice_multiple" && values.length !== 1 || values.some((v) => typeof v !== "string" || !options.includes(v)) || new Set(values).size !== values.length) {
        throw new Halt("NO_ANSWER", `题目 ${q.id} 的答案缺失或与选项不匹配`);
      }
      return { question: q, kind: "choice", value: q.type === "choice_multiple" ? values : values[0] };
    }
    if (q.type === "fill_base") {
      if (!Array.isArray(answer) || !answer.length) throw new Halt("NO_ANSWER", `填空题 ${q.id} 没有答案`);
      const doc = new DOMParser().parseFromString(q.stem || "", "text/html");
      const ids = [...doc.querySelectorAll("span.zty-exercise-item-fill-blank[id]")].map((el) => el.id);
      if (!ids.length || new Set(ids).size !== ids.length || ids.length !== answer.length) {
        throw new Halt("AMBIGUOUS", `填空题 ${q.id} 的空位与答案数量不一致`);
      }
      const value = ids.map((idx) => {
        const matches = answer.map(object).filter((a2) => a2.idx === idx);
        if (matches.length !== 1) throw new Halt("AMBIGUOUS", `填空题 ${q.id} 的空位标识无法唯一匹配`);
        const a = matches[0];
        const val = typeof a.standardAnswer === "string" && a.standardAnswer.trim() ? a.standardAnswer : a.val;
        required(val, q.id);
        const selected = text(val.split(/[;；]/)[0]);
        required(selected, q.id);
        return { idx, answer: selected };
      });
      return { question: q, kind: "fill", value };
    }
    if (["essay_writing", "essay_translate", "essay_questions_answers"].includes(q.type)) {
      const value = text(typeof answer === "string" ? answer : object(answer).answer);
      required(value, q.id);
      return { question: q, kind: "writing", value: { answer: value, annex: [] } };
    }
    throw new Halt("UNSUPPORTED", `暂不支持题型 ${q.type}（题目 ${q.id}），已暂停`);
  }
  function planTasks(data) {
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
    return qs.map((q) => taskFor(q, records.find((r) => String(r.questionId) === String(q.id))));
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
    if (q.type === "fill_base") return Array.isArray(v) ? v.map(object).map((a) => ({ idx: a.idx, answer: a.answer })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
    if (q.type.startsWith("essay_")) return { answer: String(object(v).answer ?? "").replace(/\r\n/g, "\n").trim() };
    if (q.type === "oral_simple_speak") return { audio: audioId(object(v).audio) };
    if (q.type === "legacy_9") return Array.isArray(v) ? v.map(object).map((a) => ({ idx: a.idx, audio: audioId(String(a.audio || "")) })).sort((a, b) => String(a.idx).localeCompare(String(b.idx))) : v;
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
    if (q.type === "oral_simple_speak") return typeof object(v).audio === "string" && !!object(v).audio;
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
      if (window.XMLHttpRequest?.name === "myXMLHttpRequest" || window.WebSocket?.name === "myWebSocket") {
        return "检测到旧版脚本的网络钩子，请停用旧脚本并刷新后运行";
      }
      const w = window;
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
    async fill(unit, task, signal) {
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

  // src/legacy-angular.ts
  var runtime;
  var application;
  function runInLegacyZone(job) {
    if (application?._zone?.run) application._zone.run(job);
    else job();
  }
  function legacyComponents() {
    const w = window;
    if (document.querySelector("app-root")?.getAttribute("ng-version") !== "7.2.16" || !document.querySelector("app-course-study-student") || !w.ng?.coreTokens?.ApplicationRef) return [];
    try {
      let walk2 = function(view) {
        if (!view || seen.has(view) || seen.size > 3e4) return;
        seen.add(view);
        for (const node of view.nodes || []) {
          if (node?.componentView) {
            if (node.renderElement instanceof HTMLElement && node.componentView.component) {
              result.push({ component: node.componentView.component, root: node.renderElement });
            }
            walk2(node.componentView);
          }
          for (const child of node?.viewContainer?._embeddedViews || []) walk2(child);
        }
      };
      var walk = walk2;
      if (!runtime) {
        if (!Array.from(document.scripts).some((s) => /\/main\.4c93dc9c6da8077cd693\.js(?:\?|$)/.test(s.src)) || !Array.isArray(w.webpackJsonp)) return [];
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
    if ([14, 15, 16, 25].includes(type) && Array.isArray(e.exerciseList)) {
      q.children = e.exerciseList.map(legacyQuestion);
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
    } else if ([6, 7, 8].includes(type)) {
      q.type = "essay_questions_answers";
      q.answer = text(e.answer);
    } else if (type === 9) {
      q.type = "legacy_9";
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
    } else if (type === 20) {
      q.type = "oral_simple_speak";
    }
    return q;
  }
  function normalizeExercise(value) {
    const root = object(value);
    if (root.type != null && root.id != null) return root;
    for (const key2 of ["exercise", "object", "item", "data"]) {
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
  function legacyValue(q, record) {
    const a = object(record).answer;
    if (q.type === "fill_base") return Object.entries(object(a)).map(([idx, v]) => ({
      idx,
      answer: object(q.extension).legacyType === 24 ? object(v).choiceId : object(v).content
    }));
    if (q.type.startsWith("essay_")) return { answer: a, annex: [] };
    if (q.type === "oral_simple_speak") return { audio: typeof a === "string" ? a : "" };
    if (q.type === "legacy_9") {
      const answers = object(a);
      return Object.entries(answers).map(([idx, value]) => ({ idx, audio: object(value).recordAudio || "" }));
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
      const rolePlay = task.question.type === "legacy_9";
      const matches = this.components().filter(({ component: c, root }) => unit.root.contains(root) && root.isConnected && typeof c.doRecordChange?.emit === "function" && shown(root) && (String(c.exercise?.id) === String(task.question.id) || rolePlay && (Number(c.exercise?.type) === 9 || typeof c.selectRole === "function" || typeof c.start === "function" || typeof c.playVadio === "function")));
      const usable = matches.filter(({ component: c }) => ![14, 15, 16, 25].includes(Number(c.exercise?.type)));
      if (!usable.length) throw new Halt("QUESTION_DOM", "旧版作答组件未就绪，请等待题目加载");
      const ranked = usable.map((entry) => {
        const c = entry.component;
        let score = 0;
        if (rolePlay) {
          if (Number(c.exercise?.type) === 9) score += 5;
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
    async fill(unit, task, signal) {
      check(signal);
      const { component: c, root } = this.leaf(unit, task);
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
        if (c.exercise.type === 24) {
          if (typeof c.drag !== "function" || typeof c.delAnswer !== "function") throw new Halt("QUESTION_DOM", "拖拽控件已变化");
          if (new Set(items.map((i) => i.answer)).size !== items.length) throw new Halt("AMBIGUOUS", "拖拽答案存在重复选项，已暂停");
          this.run(unit, () => {
            for (const { idx } of items) if (c.doRecord.answer[idx]?.choiceId) c.delAnswer(idx);
            for (const { idx, answer } of items) c.drag({ previousContainer: { id: answer, data: {} }, container: { id: idx, data: {} } });
          });
        } else {
          const fields = items.map((item) => {
            const matches = [...root.querySelectorAll('[contenteditable="true"]')].filter((e) => e.id === `a-${item.idx}`);
            if (matches.length !== 1) throw new Halt("QUESTION_DOM", `填空 ${item.idx} 未找到唯一输入框`);
            return { item, field: matches[0] };
          });
          for (const { item, field } of fields) {
            check(signal);
            field.focus();
            field.innerText = item.answer;
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.blur();
          }
        }
      } else if (task.kind === "writing") {
        const fields = root.querySelectorAll("textarea");
        if (fields.length !== 1) throw new Halt("QUESTION_DOM", "问答输入框不唯一或尚未加载");
        const field = fields[0];
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, object(task.value).answer);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.blur();
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
      const { component: c, root } = this.leaf(unit, task);
      if (![9, 20].includes(Number(c.exercise.type))) throw new Halt("UNSUPPORTED", "此旧版评测题尚未适配，请手动作答");
      if (Number(c.exercise.type) === 9) return this.recordRolePlay(unit, task, settings, signal, c, root);
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
      const service = c.getWebUrlService ?? c.webUrlService;
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
    async next(unit, signal) {
      check(signal);
      this.assertContext(unit);
      const right = [...document.querySelectorAll(".page-next")].find((el) => !!el.querySelector('img[src*="tx_page_right"]') && shown(el));
      if (!right || right.getAttribute("aria-disabled") === "true" || right.classList.contains("disabled")) return void 0;
      const oldKey = unit.key;
      right.click();
      await until(() => {
        const found = this.discover()[0];
        return found && found.key !== oldKey ? found : void 0;
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
    fill(unit, task, signal) {
      return this.active.fill(unit, task, signal);
    }
    record(unit, task, settings, signal) {
      return this.active.record(unit, task, settings, signal);
    }
    submit(unit, signal) {
      return this.active.submit(unit, signal);
    }
    next(unit, signal) {
      return this.active.next?.(unit, signal) || Promise.resolve(void 0);
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
    constructor(adapter, store, withLock = browserLock) {
      this.adapter = adapter;
      this.store = store;
      this.withLock = withLock;
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
    emit() {
      this.listeners.forEach((fn) => fn());
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
          let index = 0;
          while (index < units.length) {
            const unit = units[index++];
            check(signal);
            this.adapter.assertContext(unit);
            await this.runUnit(unit, settings, signal);
            this.update({ unitsDone: this.progress.unitsDone + 1 });
            if (!settings.allLoaded && this.adapter.next) {
              const next = await this.adapter.next(unit, signal);
              if (next) {
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
          return;
        }
        if (old.phase === "pending") {
          throw new Halt("PENDING_SUBMIT", "上次提交结果尚不能确认，已阻止再次提交；请在网页核查后重置本地记录");
        }
        throw new Halt("RECORD_CHANGED", "服务器作答记录与本地记录不一致，请核查后重置本地记录");
      }
      if (completedOnServer(data)) {
        this.update({ completed: leaves(data.questionVOList).length, total: leaves(data.questionVOList).length });
        this.report("ALREADY_SAVED", "服务器已有完整作答记录，保持现有结果");
        return;
      }
      this.update({ phase: "解析", total: leaves(data.questionVOList).length });
      let tasks;
      try {
        tasks = planTasks(data);
      } catch (error) {
        this.update({ pending: leaves(data.questionVOList).map((q) => ({
          questionId: String(q.id),
          type: q.type,
          reason: error instanceof Halt ? error.message : "解析失败"
        })) });
        throw error;
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
        const value = task.kind === "recording" ? await this.adapter.record(unit, task, settings, signal) : await this.adapter.fill(unit, task, signal);
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
.panel{width:min(365px,calc(100vw - 36px));max-height:85vh;overflow:auto;background:white;border:1px solid #dbe0e9;border-radius:14px;box-shadow:0 8px 38px #1c183d33}.header{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:#f6f1fb;border-radius:14px 14px 0 0}.header strong{font-size:15px}.header button{padding:0 8px;font-size:19px}.body{padding:14px 16px}.hint{font-size:12px;color:#697285;margin:8px 0}.status{font-weight:650;color:#67369b}.message{overflow-wrap:anywhere;white-space:pre-wrap;font-size:13px;min-height:42px}.progress{margin:8px 0;width:100%;accent-color:#6c37a5}.row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:9px 0}select{width:100%;border:1px solid #d6dce7;border-radius:7px;padding:7px;background:white;color:inherit}input[type=number]{width:65px;border:1px solid #d6dce7;border-radius:5px;padding:3px}label{font-size:13px}input[type=checkbox]{accent-color:#6c37a5}details{border-top:1px solid #edf0f4;margin-top:10px;padding-top:8px}summary{cursor:pointer;font-size:12px;color:#697285}.logs{max-height:150px;overflow:auto;margin:7px 0;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#aa3040}.mini{border-radius:25px;background:#6c37a5;color:white;padding:10px 16px;box-shadow:0 4px 20px #33174933}.hidden{display:none!important}.actions button{flex:1}.pending{font-size:12px;color:#aa3040;max-height:70px;overflow:auto}.toolbar button{font-size:12px;padding:4px 8px}
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
          <div class="row"><label><input id="all" type="checkbox"> 处理本章节全部已加载练习块</label></div>
          <div class="row"><label>口语录音时长 <input id="seconds" type="number" min="3" max="180" step="1"> 秒</label></div>
          <div class="row"><label>角色扮演/跟读录音来源<select id="rolePlayMode">
            <option value="original">原题音频 → Chivox 评测（生成评分）</option>
            <option value="sample">原题音频直填（不评分）</option>
            <option value="microphone">真实麦克风</option>
          </select></label></div>
          <p class="hint">有原题音频时默认灌入原站 Chivox，生成真实评分；缺少音频会暂停。MiMo TTS 接口已预留，尚未接入录音流程。跟读和单词题遵循页面时长。</p>
          <progress id="progress" class="progress" value="0" max="1"></progress><div class="hint" id="counts"></div>
          <div class="actions row"><button class="primary" id="start">开始</button><button id="pause">暂停</button><button id="stop">停止</button></div>
          <div id="pending" class="pending"></div>
          <div class="toolbar row"><button id="refresh">重新检测</button><button id="export">导出诊断</button><button id="reset">重置本练习记录</button></div>
          <details><summary>运行日志</summary><div class="logs" id="logs"></div></details>
          <p class="hint">收起后可点右下角按钮，或按 Alt+Shift+T 恢复。</p>
        </div>
      </section>`;
      this.shadow.append(frame);
      this.el("version").textContent = false ? "dev" : "0.2.0";
      this.input("all").checked = this.settings.allLoaded;
      this.input("seconds").value = String(this.settings.recordingSeconds);
      this.el("rolePlayMode").value = this.settings.rolePlayAudioMode;
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
          this.settings = {
            ...defaults,
            allLoaded: this.input("all").checked,
            recordingSeconds: Number.isFinite(raw) ? Math.min(180, Math.max(3, raw)) : defaults.recordingSeconds,
            rolePlayAudioMode: ["original", "sample", "microphone"].includes(mode) ? mode : defaults.rolePlayAudioMode
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
      const p = this.controller.progress, busy = this.controller.busy;
      this.el("status").textContent = `${labels[p.status]}${p.phase ? " · " + p.phase : ""}`;
      if (message) this.el("message").textContent = p.message;
      this.el("counts").textContent = `题目 ${p.completed}/${p.total} · 练习块 ${p.unitsDone}/${p.unitsTotal}${p.type ? " · " + p.type : ""}`;
      const progress = this.el("progress");
      progress.max = Math.max(p.total, 1);
      progress.value = p.completed;
      for (const id2 of ["units", "seconds", "all", "rolePlayMode", "refresh", "reset"]) this.el(id2).disabled = busy;
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
        version: false ? "dev" : "0.2.0",
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
  var Store = class {
    constructor(storage = localStorage) {
      this.storage = storage;
    }
    settings() {
      try {
        const raw = JSON.parse(this.storage.getItem(prefix + "settings") || "{}");
        const mode = ["original", "sample", "microphone"].includes(raw.rolePlayAudioMode) ? raw.rolePlayAudioMode : raw.rolePlayExampleAudio === false ? "microphone" : defaults.rolePlayAudioMode;
        return {
          allLoaded: raw.allLoaded === true,
          recordingSeconds: typeof raw.recordingSeconds === "number" && Number.isFinite(raw.recordingSeconds) ? Math.min(180, Math.max(3, raw.recordingSeconds)) : defaults.recordingSeconds,
          rolePlayAudioMode: mode,
          timeoutMs: defaults.timeoutMs,
          intervalMs: defaults.intervalMs
        };
      } catch {
        return { ...defaults };
      }
    }
    saveSettings(settings) {
      this.write(prefix + "settings", settings);
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
  var page = window;
  function boot() {
    if (window.top !== window.self) return;
    if (page[key]) {
      page[key].reveal();
      return;
    }
    const adapter = new AdaptiveAdapter(), store = new Store();
    const panel = new Panel(new Controller(adapter, store), adapter, store);
    page[key] = panel;
    panel.mount();
    window.addEventListener("pagehide", () => {
      panel.dispose();
      delete page[key];
    }, { once: true });
  }
  window.addEventListener("pageshow", (event) => {
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
