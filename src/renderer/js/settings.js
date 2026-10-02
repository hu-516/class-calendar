'use strict';

// 设置窗口：读写 settings，改动即时保存并同步到悬浮卡片。

let state = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('toast--show'), 2200);
}

async function save(patch, message = '已保存') {
  state = await window.api.updateSettings(patch);
  render();
  showToast(message);
}

function render() {
  const settings = state?.settings ?? {};
  const meta = state?.meta ?? null;

  $('icsPath').textContent = settings.icsPath ?? '未导入';
  $('summaryLine').textContent = state?.totalEvents
    ? `${state.schoolName} · ${meta?.courses?.length ?? 0} 门课 · ${state.totalEvents} 节课 · ${state.totalWeeks ?? '?'} 周`
    : '未导入课表';
  $('fileMeta').textContent = state?.source
    ? `编码 ${state.source.encoding} · ${(state.source.bytes / 1024).toFixed(1)} KB · 导入于 ${new Date(state.source.importedAt).toLocaleString('zh-CN')}`
    : '';

  $('termStart').value = state?.termStartMonday ?? '';
  $('schoolName').value = settings.schoolName ?? '';
  $('showAllDay').checked = Boolean(settings.showAllDay);
  $('keywordFilter').value = settings.keywordFilter ?? '';
  $('opacity').value = String(Math.round((settings.opacity ?? 1) * 100));
  $('opacityValue').textContent = `${Math.round((settings.opacity ?? 1) * 100)}%`;
  $('layerMode').value = settings.layerMode ?? 'desktop';
  $('autostart').checked = Boolean(settings.autostart);

  $('dataMeta').textContent = meta
    ? `课表文件：${meta.sourceEventCount} 条事件 → 展开 ${meta.occurrenceCount} 节课；` +
      `去重 ${meta.duplicatesRemoved}，调课覆盖 ${meta.exceptionCount}，全天 ${meta.allDayCount}`
    : '当前没有课表数据。';
}

$('importBtn').addEventListener('click', async () => {
  state = await window.api.importIcs();
  render();
  showToast('课表已导入');
});

$('reloadBtn').addEventListener('click', async () => {
  state = await window.api.reload();
  render();
  showToast('已重新载入');
});

$('termStart').addEventListener('change', () => {
  const value = $('termStart').value;
  if (value) save({ weekStartOverride: value }, `第一周周一改为 ${value}`);
});

$('termAuto').addEventListener('click', () => save({ weekStartOverride: null }, '已改回自动推断'));

$('schoolName').addEventListener('change', () => save({ schoolName: $('schoolName').value.trim() }));

$('showAllDay').addEventListener('change', () => save({ showAllDay: $('showAllDay').checked }));

$('keywordFilter').addEventListener('change', () => save({ keywordFilter: $('keywordFilter').value.trim() }));

$('opacity').addEventListener('input', () => {
  $('opacityValue').textContent = `${$('opacity').value}%`;
});
$('opacity').addEventListener('change', () => save({ opacity: Number($('opacity').value) / 100 }));

$('layerMode').addEventListener('change', () =>
  save({ layerMode: $('layerMode').value }, $('layerMode').value === 'top' ? '已置顶显示' : '已放回桌面层'),
);

$('autostart').addEventListener('change', () =>
  save({ autostart: $('autostart').checked }, $('autostart').checked ? '已开启开机自启' : '已关闭开机自启'),
);

$('revealBtn').addEventListener('click', () => window.api.revealDataDir());

$('clearBtn').addEventListener('click', async () => {
  if (!window.confirm('确定清空当前课表数据？导入过的备份仍保留在数据目录。')) return;
  state = await window.api.clearSchedule();
  render();
  showToast('课表数据已清空');
});

window.api.onState((payload) => {
  state = payload;
  render();
});

window.api.onNotice((message) => showToast(message?.message ?? message));

(async () => {
  const info = await window.api.getAppInfo();
  $('version').textContent = `v${info.version} · Electron ${info.electron}`;
  state = await window.api.getState();
  render();
})();

