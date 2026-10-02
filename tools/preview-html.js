#!/usr/bin/env node
'use strict';

// 用 Electron 渲染一个 HTML 文件并整页截图，用于检查文档排版（尤其是要交付的说明文档）。
//
// 用法：
//   node_modules\electron\dist\electron.exe tools\preview-html.js --file docs\使用说明.html --out shot.png [--width 900] [--max-height 8000]

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

function parseArgs(argv) {
  const args = { width: 900, maxHeight: 8000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'width' || key === 'max-height') args[key === 'width' ? 'width' : 'maxHeight'] = Number(argv[++i]);
    else if (key === 'file' || key === 'out') args[key] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

app.whenReady().then(async () => {
  if (!args.file || !args.out) {
    console.error('用法：electron tools/preview-html.js --file <html> --out <png>');
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: args.width,
    height: 900,
    show: true,
    autoHideMenuBar: true,
    webPreferences: { offscreen: false },
  });

  await win.loadFile(path.resolve(args.file));
  const height = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
  const targetHeight = Math.min(Math.max(height + 24, 400), args.maxHeight);
  win.setContentSize(args.width, targetHeight);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), image.toPNG());
  console.log(`已保存 ${args.out}（${args.width}x${targetHeight}）`);
  app.quit();
});
