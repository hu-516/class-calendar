'use strict';

// 托盘图标与右键菜单。

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

let tray = null;

function buildMenu(context) {
  const { settings, isVisible } = context;
  return Menu.buildFromTemplate([
    {
      label: isVisible() ? '隐藏组件' : '显示组件',
      click: () => context.onToggleVisible(),
    },
    { type: 'separator' },
    { label: '导入课表…', click: () => context.onImport() },
    { label: '重新载入课表', click: () => context.onReload() },
    { label: '打开设置…', click: () => context.onOpenSettings() },
    { type: 'separator' },
    {
      label: '置顶显示（浮在其他窗口之上）',
      type: 'checkbox',
      checked: settings.layerMode === 'top',
      click: (item) => context.onSetLayerMode(item.checked ? 'top' : 'desktop'),
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: Boolean(settings.autostart),
      click: (item) => context.onSetAutostart(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => context.onQuit() },
  ]);
}

function createTray(context) {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('课程日程表');
  refreshTray(context);

  // 左键单击显示/隐藏，右键弹出菜单
  tray.on('click', () => context.onToggleVisible());
  tray.on('double-click', () => context.onShow());
  return tray;
}

function refreshTray(context) {
  if (!tray) return;
  tray.setContextMenu(buildMenu(context));
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, refreshTray, destroyTray };
