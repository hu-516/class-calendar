'use strict';

// 本地持久化：设置与课表数据都存在 Electron 的 userData 目录（%APPDATA%\class-calendar）。

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  window: null, // { x, y, width, height }
  collapsed: true,
  opacity: 1, // 默认完全不透明，与设计稿一致；可在设置里调低
  layerMode: 'desktop', // 'desktop' 只放桌面不挡其他应用（默认）| 'top' 置顶悬浮
  autostart: false,
  icsPath: null,
  schoolName: '', // 卡片左上角名称，留空则从课表文件名推断
  showAllDay: false,
  keywordFilter: '',
  weekStartOverride: null,
};

const MAX_BACKUPS = 5;

function paths() {
  const dir = app.getPath('userData');
  return {
    dir,
    settings: path.join(dir, 'settings.json'),
    schedule: path.join(dir, 'schedule.json'),
    backupDir: path.join(dir, 'backup'),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(paths().settings, {}) };
}

function saveSettings(settings) {
  writeJson(paths().settings, settings);
  return settings;
}

function loadSchedule() {
  return readJson(paths().schedule, null);
}

// 导入新数据前备份上一份，只保留最近若干份
function pruneBackups(backupDir) {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith('schedule-'))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
      fs.unlinkSync(path.join(backupDir, name));
    }
  } catch {
    // 备份清理失败不影响主流程
  }
}

function saveSchedule(payload) {
  const target = paths();
  const previous = readJson(target.schedule, null);
  if (previous) {
    fs.mkdirSync(target.backupDir, { recursive: true });
    writeJson(path.join(target.backupDir, `schedule-${Date.now()}.json`), previous);
    pruneBackups(target.backupDir);
  }
  writeJson(target.schedule, payload);
  return payload;
}

module.exports = {
  DEFAULT_SETTINGS,
  paths,
  loadSettings,
  saveSettings,
  loadSchedule,
  saveSchedule,
};
