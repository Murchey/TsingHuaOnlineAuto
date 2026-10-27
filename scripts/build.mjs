import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const metadata = `// ==UserScript==
// @name         清华社英语在线练习助手
// @namespace    local.tsinghua-online-auto
// @version      ${version}
// @description  日常练习填写、真实麦克风录音、提交核对及故障诊断
// @match        https://www.tsinghuaelt.com/*
// @match        https://tsinghuaelt.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// @license      GPL-3.0-only
// ==/UserScript==`;

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'], outfile: 'dist/tsinghua-online-auto.user.js',
  bundle: true, format: 'iife', target: 'chrome110', charset: 'utf8',
  legalComments: 'none', banner: { js: metadata },
  define: { __APP_VERSION__: JSON.stringify(version) },
});
await writeFile('dist/tsinghua-online-auto.meta.js', metadata + '\n');
console.log(`Built dist/tsinghua-online-auto.user.js v${version}`);
