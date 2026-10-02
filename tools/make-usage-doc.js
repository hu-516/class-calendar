#!/usr/bin/env node
'use strict';

// 生成「单文件版」使用说明：把 docs/使用说明.html 里的图片内嵌成 base64，
// 输出到 dist/使用说明.html，方便和安装包一起拷贝（一个文件即可阅读/打印）。
//
// 用法：node tools/make-usage-doc.js

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'docs', '使用说明.html');
const target = path.join(root, 'dist', '使用说明.html');

let html = fs.readFileSync(source, 'utf8');
let inlined = 0;

html = html.replace(/src="(images\/[^"]+)"/g, (match, relative) => {
  const file = path.join(root, 'docs', relative);
  if (!fs.existsSync(file)) {
    console.warn(`跳过缺失的图片：${relative}`);
    return match;
  }
  const base64 = fs.readFileSync(file).toString('base64');
  inlined += 1;
  return `src="data:image/png;base64,${base64}"`;
});

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, html);
console.log(`已生成 ${target}（内嵌 ${inlined} 张图片，${Math.round(html.length / 1024)} KB）`);
