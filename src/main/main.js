'use strict';

// 主进程：窗口行为、ICS 导入与自动重载、状态推送给渲染进程。

const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { readIcsFile, expandIcs } = require('./ics');
const { summarize, weekNumberFor, weekStartOf, toDateKey, shiftWeek, weekViewFor } = require('./schedule');
const store = require('./store');
const tray = require('./tray');

// 打包后 productName 是中文，这里固定数据目录，保证开发版与安装版共用同一份设置。
// CLASS_CALENDAR_DATA_DIR 可指向别的目录：做截图/演示时用示例数据，不会动到真实课表。
const dataDir = process.env.CLASS_CALENDAR_DATA_DIR;
app.setPath(
  'userData',
  dataDir ? path.resolve(dataDir) : path.join(app.getPath('appData'), 'class-calendar'),
);

// 窗口尺寸 = 卡片尺寸 + 两侧各 10px 的投影留白
// 小卡片本体 480x240，展开视图卡片 880x520
const COMPACT_SIZE = { width: 500, height: 260 };
const EXPANDED_SIZE = { width: 900, height: 540 };
const DEFAULT_MARGIN = 24;

let mainWindow = null;
let settingsWindow = null;
let settings = null;
let schedule = null;
let watcher = null;
let boundsTimer = null;
let compactBounds = null;

function loadPersisted() {
  settings = store.loadSettings();
  schedule = store.loadSchedule();
}

function computePosition(size) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - size.width - DEFAULT_MARGIN,
    y: workArea.y + workArea.height - size.height - DEFAULT_MARGIN,
  };
}

function createMainWindow() {
  // 折叠态沿用上次记住的位置与尺寸（用户可能手动缩放过大卡片）
  const savedCompact = settings.collapsed ? normaliseCompactBounds(settings.window) : null;
  const size = settings.collapsed ? (savedCompact ?? COMPACT_SIZE) : EXPANDED_SIZE;
  const position = savedCompact ?? settings.window ?? computePosition(size);

  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setAlwaysOnTop(settings.layerMode !== 'desktop', 'floating');
  mainWindow.setOpacity(settings.opacity);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 窗口真正显示后再套用一次视图尺寸：
    // 显示前调用的 setBounds 会被 show() 覆盖（透明无边框窗口尤其明显）
    applyViewSize();
    applyLayerMode();
  });

  mainWindow.on('moved', saveBoundsSoon);
  mainWindow.on('resized', saveBoundsSoon);
  mainWindow.on('blur', () => {
    // 桌面层模式：失焦后重新沉到底部，避免一直压在其他窗口上面
    if (settings.layerMode === 'desktop') scheduleLayerRefresh();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 只在折叠状态记录尺寸，避免展开态的临时尺寸覆盖用户设定
function saveBoundsSoon() {
  if (!mainWindow || !settings || !settings.collapsed) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    settings.window = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    compactBounds = settings.window;
    store.saveSettings(settings);
  }, 400);
}

function visibleEvents() {
  const events = schedule?.events ?? [];
  const keywords = String(settings.keywordFilter || '')
    .split(/[,，\s]+/)
    .filter(Boolean);
  return events.filter((event) => {
    if (!settings.showAllDay && event.allDay) return false;
    if (keywords.length && !keywords.some((keyword) => event.title.includes(keyword))) return false;
    return true;
  });
}

// 周课表的行：全学期出现过的上课开始时间，保证网格稳定
function computeSlotRows(events) {
  const byTime = new Map();
  for (const event of events) {
    const time = event.start.slice(11, 16);
    if (!byTime.has(time)) {
      byTime.set(time, { time, periods: new Set(), endTime: event.end.slice(11, 16) });
    }
    const row = byTime.get(time);
    if (event.period) row.periods.add(event.period);
    if (event.end.slice(11, 16) > row.endTime) row.endTime = event.end.slice(11, 16);
  }
  return [...byTime.values()]
    .sort((a, b) => (a.time < b.time ? -1 : 1))
    .map((row) => ({
      time: row.time,
      endTime: row.endTime,
      label: row.periods.size === 1 ? [...row.periods][0] : '',
    }));
}

// 校名：优先用设置值，其次从课表文件名推断（「课表-示例大学.ics」-> 示例大学）
function resolveSchoolName() {
  if (settings.schoolName) return settings.schoolName;
  const filePath = settings.icsPath;
  if (!filePath) return '我的课表';
  const base = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const parts = base.split(/[-—_]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : base;
}

// CLASS_CALENDAR_NOW 仅用于开发/冒烟验证时固定“当前时间”
function currentNow() {
  return process.env.CLASS_CALENDAR_NOW
    ? new Date(process.env.CLASS_CALENDAR_NOW)
    : new Date();
}

// 学期信息：开学第一周周一（手动设置优先）与总周数
function termInfo() {
  const termStartMonday = settings.weekStartOverride || schedule?.meta?.termStartMonday || null;
  const lastStart = schedule?.meta?.lastStart ?? null;
  const totalWeeks =
    termStartMonday && lastStart
      ? weekNumberFor(lastStart.slice(0, 10), termStartMonday)
      : (schedule?.meta?.totalWeeks ?? null);
  return { termStartMonday, totalWeeks };
}

// 指定周（offset 周）的课表视图，供周课表翻页
function weekView(offset = 0) {
  const { termStartMonday, totalWeeks } = termInfo();
  const now = currentNow();
  const baseWeekStart = weekStartOf(toDateKey(now));
  const weekStartKey = shiftWeek(baseWeekStart, offset);
  const events = visibleEvents();
  return {
    offset,
    ...weekViewFor(events, { termStartMonday, totalWeeks }, weekStartKey, now),
    slotRows: computeSlotRows(events),
    todayKey: toDateKey(now),
  };
}

function buildState() {
  const events = visibleEvents();
  const now = currentNow();
  const { termStartMonday, totalWeeks } = termInfo();
  return {
    events,
    totalEvents: schedule?.events?.length ?? 0,
    meta: schedule?.meta ?? null,
    warnings: schedule?.warnings ?? [],
    source: schedule?.source ?? null,
    schoolName: resolveSchoolName(),
    termStartMonday,
    termStartIsOverride: Boolean(settings.weekStartOverride),
    totalWeeks,
    settings,
    slotRows: computeSlotRows(events),
    summary: summarize(events, now, {
      termStartMonday,
      totalWeeks,
    }),
    now: now.toISOString(),
  };
}

function broadcastState() {
  const payload = buildState();
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('app:state', payload);
  }
}

function notify(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:notice', { message, at: new Date().toISOString() });
}

function applyCollapsed(collapsed) {
  // 展开前先记住折叠态的位置，收起时好还原
  if (!collapsed) rememberCompactBounds();
  settings.collapsed = collapsed;
  store.saveSettings(settings);
  applyViewSize();
}

// 折叠态窗口的位置与尺寸（含用户手动调整过的），以及边界兜底
function normaliseCompactBounds(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return null;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(360, Math.round(bounds.width || COMPACT_SIZE.width)),
    height: Math.max(200, Math.round(bounds.height || COMPACT_SIZE.height)),
  };
}

function rememberCompactBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  compactBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

// ---- 层级模式：desktop = 沉在桌面底部不挡其他应用；top = 置顶悬浮 ----

let layerTimer = null;

function pushToBottom() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let hwnd;
  try {
    hwnd = mainWindow.getNativeWindowHandle().readBigUInt64LE(0).toString();
  } catch {
    return; // 取不到句柄时按普通层级处理，不影响使用
  }
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      // asar 里的文件没法直接用 PowerShell 执行，打包后从 resources 目录取
      app.isPackaged
        ? path.join(process.resourcesPath, 'win32-layer.ps1')
        : path.join(__dirname, 'win32-layer.ps1'),
      '-Hwnd',
      hwnd,
      '-Action',
      'bottom',
    ],
    { windowsHide: true, timeout: 5000 },
    () => {
      /* 失败就退化成普通窗口层级，不打扰用户 */
    },
  );
}

function scheduleLayerRefresh() {
  clearTimeout(layerTimer);
  layerTimer = setTimeout(pushToBottom, 400);
}

function applyLayerMode() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const pinned = settings.layerMode === 'top';
  mainWindow.setAlwaysOnTop(pinned, 'floating');
  if (pinned) mainWindow.moveTop();
  else scheduleLayerRefresh();
}

// 按当前折叠状态把窗口调整到对应尺寸，并保证不超出工作区
function applyViewSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const current = mainWindow.getBounds();
  let target;

  if (settings.collapsed) {
    // 收起时回到展开前记住的位置：展开时窗口被推进屏幕内，直接用当前位置会漂移
    const compact = normaliseCompactBounds(compactBounds ?? settings.window);
    target = {
      x: compact?.x ?? current.x,
      y: compact?.y ?? current.y,
      width: compact?.width ?? COMPACT_SIZE.width,
      height: compact?.height ?? COMPACT_SIZE.height,
    };
  } else {
    target = { x: current.x, y: current.y, ...EXPANDED_SIZE };
  }

  const maxX = Math.max(workArea.x, workArea.x + workArea.width - target.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - target.height);
  target.x = Math.min(Math.max(target.x, workArea.x), maxX);
  target.y = Math.min(Math.max(target.y, workArea.y), maxY);
  mainWindow.setBounds(target);
}

function importIcsFile(filePath) {
  const { text, encoding, bytes } = readIcsFile(filePath);
  const { events, meta, warnings } = expandIcs(text);
  schedule = {
    events,
    meta,
    warnings,
    source: { path: filePath, importedAt: new Date().toISOString(), encoding, bytes },
  };
  store.saveSchedule(schedule);
  settings.icsPath = filePath;
  store.saveSettings(settings);
  watchIcs(filePath);
  broadcastState();
  return schedule;
}

// 监听原始 .ics：重新导出并被覆盖后自动重载
function watchIcs(filePath) {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  const reloadTimer = { id: null };
  try {
    watcher = fs.watch(filePath, { persistent: false }, () => {
      clearTimeout(reloadTimer.id);
      reloadTimer.id = setTimeout(() => {
        try {
          importIcsFile(filePath);
          notify('课表已根据文件更新重新加载');
        } catch (error) {
          notify(`课表重载失败，继续使用上一次数据：${error.message}`);
        }
      }, 300);
    });
  } catch {
    notify('无法监听课表文件，改动后请手动重新导入');
  }
}

function reloadFromDisk() {
  const filePath = settings.icsPath;
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    importIcsFile(filePath);
  } catch (error) {
    notify(`课表文件无法读取：${error.message}`);
  }
}

async function chooseAndImport() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择课表文件',
    filters: [{ name: '课表日历', extensions: ['ics', 'ifb'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  try {
    return importIcsFile(result.filePaths[0]);
  } catch (error) {
    notify(`导入失败：${error.message}`);
    return null;
  }
}

// ---- 设置窗口 ----

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 480,
    minHeight: 480,
    title: '课程日程表 · 设置',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

// ---- 开机自启 ----

function applyAutostart() {
  // 开发模式（未打包）下要显式告诉系统用 electron.exe + 项目目录启动
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.autostart) });
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: Boolean(settings.autostart),
    path: process.execPath,
    args: [path.resolve(__dirname, '..', '..')],
  });
}

function clearSchedule() {
  schedule = null;
  try {
    fs.rmSync(store.paths().schedule, { force: true });
  } catch {
    /* 删不掉就只清内存，界面照样变成空状态 */
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  broadcastState();
}

// ---- 托盘 ----

function trayContext() {
  return {
    settings,
    isVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    onToggleVisible: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        applyLayerMode();
      }
      tray.refreshTray(trayContext());
    },
    onShow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show();
      mainWindow.focus();
      applyLayerMode();
      tray.refreshTray(trayContext());
    },
    onImport: () => chooseAndImport(),
    onReload: () => reloadFromDisk(),
    onOpenSettings: () => openSettingsWindow(),
    onSetLayerMode: (mode) => {
      settings.layerMode = mode;
      store.saveSettings(settings);
      applyLayerMode();
      broadcastState();
      tray.refreshTray(trayContext());
    },
    onSetAutostart: (enabled) => {
      settings.autostart = enabled;
      store.saveSettings(settings);
      applyAutostart();
      broadcastState();
      tray.refreshTray(trayContext());
    },
    onQuit: () => app.quit(),
  };
}

function registerIpc() {
  ipcMain.handle('app:state', () => buildState());
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));
  ipcMain.handle('schedule:import', async () => {
    await chooseAndImport();
    return buildState();
  });
  ipcMain.handle('schedule:reload', () => {
    reloadFromDisk();
    return buildState();
  });
  ipcMain.handle('settings:update', (_event, patch) => {
    settings = { ...settings, ...patch };
    store.saveSettings(settings);
    if (patch.opacity !== undefined && mainWindow) mainWindow.setOpacity(settings.opacity);
    if (patch.layerMode !== undefined) applyLayerMode();
    if (patch.autostart !== undefined) applyAutostart();
    broadcastState();
    tray.refreshTray(trayContext());
    return buildState();
  });
  ipcMain.handle('settings:open', () => {
    openSettingsWindow();
    return true;
  });
  ipcMain.handle('app:reveal-data', () => {
    shell.openPath(store.paths().dir);
    return true;
  });
  ipcMain.handle('schedule:clear', () => {
    clearSchedule();
    return buildState();
  });
  ipcMain.handle('week:get', (_event, offset) => weekView(Number(offset) || 0));
  ipcMain.handle('window:set-collapsed', (_event, collapsed) => {
    applyCollapsed(Boolean(collapsed));
    return buildState();
  });
  ipcMain.handle('window:hide', () => mainWindow?.hide());
  ipcMain.handle('app:quit', () => app.quit());
}

// 冒烟验证：自动导入指定 ICS、按需展开视图，把渲染结果打印出来再退出
async function runSmokeTest() {
  if (process.env.CLASS_CALENDAR_ICS) {
    try {
      importIcsFile(process.env.CLASS_CALENDAR_ICS);
    } catch (error) {
      console.log(`[smoke] 导入失败：${error.message}`);
    }
  }
  if (process.env.CLASS_CALENDAR_VIEW === 'expanded') applyCollapsed(false);
  else if (process.env.CLASS_CALENDAR_VIEW === 'compact') applyCollapsed(true);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    const text = await mainWindow.webContents.executeJavaScript('document.body.innerText');
    const blocks = await mainWindow.webContents.executeJavaScript(
      'document.querySelectorAll(".slot-item").length',
    );
    // 顺带验证「开学日期」编辑面板能否被点开
    const termEditor = await mainWindow.webContents.executeJavaScript(`(() => {
      const label = document.getElementById('weekLabel');
      const editor = document.getElementById('termEditor');
      label.click();
      const opened = !editor.hidden;
      const value = document.getElementById('termStartInput').value;
      const rect = label.getBoundingClientRect();
      label.click();
      return {
        opened,
        value,
        labelText: label.textContent,
        labelRect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    })()`);
    // 验证置顶开关：点一次钉子 → 置顶，再点一次 → 回到桌面层
    const pinBefore = mainWindow.isAlwaysOnTop();
    await mainWindow.webContents.executeJavaScript("document.getElementById('pinBtn').click()");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const pinAfterClick = mainWindow.isAlwaysOnTop();
    await mainWindow.webContents.executeJavaScript("document.getElementById('pinBtn').click()");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const pinAfterSecondClick = mainWindow.isAlwaysOnTop();
    const headerProbe = await mainWindow.webContents.executeJavaScript(`(() => {
      const rectOf = (id) => {
        const node = document.getElementById(id);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          display: style.display, visibility: style.visibility, opacity: style.opacity,
        };
      };
      return {
        headRight: rectOf('pinBtn') ? document.querySelector('.head__right').children.length : -1,
        pinBtn: rectOf('pinBtn'),
        expandBtn: rectOf('expandBtn'),
        weekLabel: rectOf('weekLabel'),
        footButtons: [...document.querySelectorAll('.foot__actions button')].map((b) => b.textContent.trim()),
      };
    })()`);
    // 验证周课表翻页：展开 → 下一周 → 回到本周 → 收起
    const weekProbe = await mainWindow.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const click = (id) => document.getElementById(id).click();
      const rangeOf = () => document.getElementById('weekRange').textContent;
      click('expandBtn');
      await wait(500);
      const current = rangeOf();
      click('nextWeekBtn');
      await wait(500);
      const next = rangeOf();
      const backVisible = !document.getElementById('backToWeekBtn').hidden;
      const cells = document.querySelectorAll('.slot-item').length;
      click('backToWeekBtn');
      await wait(500);
      const restored = rangeOf();
      click('expandBtn');
      await wait(300);
      return { current, next, backVisible, cells, restored };
    })()`);
    console.log('[smoke] 窗口区域:', JSON.stringify(mainWindow.getBounds()));
    console.log('[smoke] 头部布局:', JSON.stringify(headerProbe));
    console.log('[smoke] 周次翻页:', JSON.stringify(weekProbe));
    console.log('[smoke] 周课表课程块:', blocks);
    console.log('[smoke] 开学日期面板:', JSON.stringify(termEditor));
    console.log(
      '[smoke] 置顶开关: ' +
        JSON.stringify({ pinBefore, pinAfterClick, pinAfterSecondClick, layerMode: settings.layerMode }),
    );
    console.log(`[smoke] 渲染文本:\n${text}`);
    if (process.env.CLASS_CALENDAR_SHOT) {
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.CLASS_CALENDAR_SHOT, image.toPNG());
      console.log('[smoke] 已保存窗口截图:', process.env.CLASS_CALENDAR_SHOT);
    }
    // 回归验证：贴着屏幕右边缘时，展开再收起必须回到原位
    const positionProbe = await (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const work = screen.getPrimaryDisplay().workArea;
      const original = mainWindow.getBounds();
      const nearRight = {
        x: work.x + work.width - original.width - 4,
        y: original.y,
        width: original.width,
        height: original.height,
      };
      mainWindow.setBounds(nearRight);
      await wait(400);
      applyCollapsed(false);
      await wait(700);
      const expanded = mainWindow.getBounds();
      applyCollapsed(true);
      await wait(700);
      const collapsedAgain = mainWindow.getBounds();
      mainWindow.setBounds(original);
      return {
        compactX: nearRight.x,
        expandedX: expanded.x,
        restoredX: collapsedAgain.x,
        restored: collapsedAgain.x === nearRight.x && collapsedAgain.y === nearRight.y,
      };
    })();
    console.log('[smoke] 贴右边缘展开收起:', JSON.stringify(positionProbe));
    if (process.env.CLASS_CALENDAR_SETTINGS_SHOT) {
      const win = openSettingsWindow();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const settingsProbe = await win.webContents.executeJavaScript(`({
        api: ['openSettings', 'clearSchedule', 'revealDataDir', 'updateSettings'].every(
          (name) => typeof window.api[name] === 'function',
        ),
        termStart: document.getElementById('termStart').value,
        opacity: document.getElementById('opacity').value,
        layerMode: document.getElementById('layerMode').value,
        autostart: document.getElementById('autostart').checked,
      })`);
      console.log('[smoke] 设置窗口:', JSON.stringify(settingsProbe));
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CLASS_CALENDAR_SETTINGS_SHOT, image.toPNG());
      console.log('[smoke] 已保存设置窗口截图:', process.env.CLASS_CALENDAR_SETTINGS_SHOT);
    }
  } catch (error) {
    console.log(`[smoke] 读取渲染结果失败：${error.message}`);
  }
  app.quit();
}

app.whenReady().then(() => {
  loadPersisted();
  registerIpc();
  createMainWindow();
  tray.createTray(trayContext());
  applyAutostart();
  reloadFromDisk();
  if (process.env.CLASS_CALENDAR_VIEW === 'expanded') applyCollapsed(false);
  else if (process.env.CLASS_CALENDAR_VIEW === 'compact') applyCollapsed(true);

  if (process.env.CLASS_CALENDAR_SMOKE === '1') {
    mainWindow.once('ready-to-show', () => {
      runSmokeTest();
    });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
