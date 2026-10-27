import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const vueSource = readFileSync(require.resolve('vue/dist/vue.global.prod.js'), 'utf8');
const script = readFileSync('dist/tsinghua-online-auto.user.js', 'utf8');

describe('built userscript in an isolated production Vue application', () => {
  it('has no required CDN libraries and uses a separate identity from the legacy script', () => {
    expect(script).toContain('// @grant        GM_xmlhttpRequest');
    expect(script).toContain('// @grant        unsafeWindow');
    expect(script).toContain('// @connect      api.xiaomimimo.com');
    expect(script).toContain('// @connect      *');
    expect(script).toContain('// @inject-into  page');
    expect(script).not.toMatch(/\/\/ @require\s/);
    expect(script).not.toContain('update.greasyfork.org/scripts/452423');
  });
  it('executes the distributed script against production Vue VNodes and verifies a block submission', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
      url: 'https://www.tsinghuaelt.com/course_center/reader/student_course/12',
      runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    try {
      w.eval(vueSource);
      w.eval(`
        const {createApp, defineComponent, h, reactive} = Vue;
        const q = {id:101,type:'choice_single',stem:'Choose blue.',extension:[{idx:'a',val:'Red'},{idx:'b',val:'Blue'}],answer:'b'};
        window.testServer = {questionVOList:[q],answerCount:0,questionAnswerItemVOList:[]};
        const current = reactive({...q,doRecord:''});
        const Leaf = defineComponent({name:'SingleChoiceCourseDo',props:['exercise','status'],
          setup(p){return ()=>h('div',{class:'choices'},p.exercise.extension.map(o=>h('input',{
            type:'radio',name:'q101',value:o.idx,checked:p.exercise.doRecord===o.idx,
            onChange:e=>{p.exercise.doRecord=e.target.value}
          })))}});
        const Adapt = defineComponent({name:'AdaptExerciseCourseDo',props:['exercise','status'],
          setup(p){return ()=>h('div',{class:'exercise-view'},[h(Leaf,{exercise:p.exercise,status:p.status})])}});
        const Unit = defineComponent({name:'UnitExercisePreview',
          props:['catalogId','contentId','mode','readerType','userType','textbookInfo','onLoadExercise'],
          setup(){return ()=>h('div',{class:'unit-exercise-preview'},[
            h(Adapt,{exercise:current,status:10}),
            h('div',{class:'exercise-actions'},[h('button',{onClick:()=>{
              testServer.answerCount++;
              testServer.questionAnswerItemVOList=[{questionId:101,userAnswer:current.doRecord}];
            }},'Submit')])
          ])}
        });
        createApp({render(){return h(Unit,{catalogId:20,contentId:30,mode:'user',readerType:'student_course',
          userType:6,textbookInfo:{learnMode:1},onLoadExercise:async()=>JSON.parse(JSON.stringify(testServer))})}}).mount('#app');
        Object.defineProperty(navigator,'locks',{value:{request:async(_key,_options,job)=>job({})}});
      `);
      expect(w.document.querySelector('.unit-exercise-preview')).not.toHaveProperty('__vueParentComponent');
      w.eval(script);
      const host = w.document.querySelector('tsinghua-exercise-helper')!;
      expect(host).toBeTruthy();
      const shadow = host.shadowRoot!;
      expect((shadow.getElementById('start') as HTMLButtonElement).disabled).toBe(false);
      (shadow.getElementById('start') as HTMLButtonElement).click();
      const deadline = Date.now() + 3_000;
      while (!shadow.getElementById('status')!.textContent!.includes('已完成') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 30));
      }
      expect(shadow.getElementById('status')!.textContent).toContain('已完成');
      expect(w.eval('testServer.answerCount')).toBe(1);
      expect(w.eval('testServer.questionAnswerItemVOList[0].userAnswer')).toBe('b');
      expect(shadow.getElementById('message')!.textContent).toContain('重新读取核对');
      w.eval(script);
      expect(w.document.querySelectorAll('tsinghua-exercise-helper')).toHaveLength(1);
      const checkpoint = w.localStorage.getItem('thoa:v1:/course_center/reader/student_course/12:20:30')!;
      expect(JSON.parse(checkpoint).phase).toBe('verified');
      expect(checkpoint).not.toContain('Blue');
    } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); }
  });
  it('detects a legacy ViewEngine exercise in the installed bundle and preserves saved answers', async () => {
    const dom = new JSDOM('<app-root ng-version="7.2.16"><app-course-study-student><app-course-task-stu><button>ReChallenge</button></app-course-task-stu></app-course-study-student></app-root><script src="https://www.tsinghuaelt.com/legacy/main.4c93dc9c6da8077cd693.js"></script>', {
      url: 'https://www.tsinghuaelt.com/legacy/course-study-student/10/20/30/test-key', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    try {
      w.eval(`
        const token = {};
        window.ng = {coreTokens:{ApplicationRef:token},probe:()=>null};
        const exercise={id:'legacy-uuid',type:24,fillBlanks:[{id:'blank-uuid',answer:'option-uuid'}],dragged:[{id:'option-uuid'}]};
        const task={role:4,status:1,flag:1,exerciseStatus:3,courseId:20,pageId:'page-uuid',userId:30,exercise,
          loadDoRecord(){},http:{post(){return{subscribe({next}){next({status:true,object:{exercise,submitNum:1,
            doRecord:{type:24,answer:{'blank-uuid':{choiceId:'option-uuid'}}}}});return{unsubscribe(){}}}}}}};
        const app={_views:[{_view:{nodes:[{renderElement:document.querySelector('app-course-task-stu'),
          componentView:{component:task,nodes:[]}}]}}]};
        const runtime=()=>{};
        runtime.c={ZYjt:{exports:{i:()=>({_modules:[{injector:{get:t=>t===token?app:null}}]})}}};
        window.webpackJsonp=[];
        webpackJsonp.push=([,modules,execute])=>{for(const id of execute)modules[id[0]]({}, {}, runtime)};
        Object.defineProperty(navigator,'locks',{value:{request:async(_key,_options,job)=>job({})}});
        window.rechallengeClicks=0;
        document.querySelector('button').onclick=()=>rechallengeClicks++;
      `);
      w.eval(script);
      const shadow = w.document.querySelector('tsinghua-exercise-helper')!.shadowRoot!;
      expect((shadow.getElementById('start') as HTMLButtonElement).disabled).toBe(false);
      expect(shadow.getElementById('units')!.textContent).toContain('旧版');
      (shadow.getElementById('start') as HTMLButtonElement).click();
      const deadline = Date.now() + 2_000;
      while (!shadow.getElementById('status')!.textContent!.includes('已完成') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      expect(shadow.getElementById('logs')!.textContent).toContain('ALREADY_SAVED');
      expect(w.eval('rechallengeClicks')).toBe(0);
      const panel = w.eval("window[Symbol.for('tsinghua-online-auto.instance')]") as { diagnostics(): { route: string } };
      expect(panel.diagnostics().route).toBe('/legacy/course-study-student/[redacted]');
    } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); }
  });
});
