'use strict';

// 渲染进程：把主进程推来的课表状态画成界面（解析与筛选都在主进程完成）。

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let state = null;
let weekView = null;
let clockOffset = 0;
let noticeTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function now() {
  return new Date(Date.now() - clockOffset);
}

function dayIndexOf(dateKey) {
  return (new Date(`${dateKey}T00:00:00`).getDay() + 6) % 7;
}

function timeText(localIso) {
  return localIso.slice(11, 16);
}

function monthDayText(dateKey) {
  const [, month, day] = dateKey.split('-');
  return `${Number(month)}.${Number(day)}`;
}

function monthDayOf(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

// 课程行副标题：教室 + 教师（教室来自 ICS 的 LOCATION）
function subtitleOf(event) {
  const parts = [event.room, event.teacher].filter(Boolean);
  return parts.length ? parts.join(' · ') : event.location || '';
}

function formatCountdown(from, to) {
  const minutes = Math.round((new Date(to) - from) / 60000);
  if (minutes <= 0) return '即将开始';
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分后` : `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
}

function renderHeader() {
  const current = now();
  document.getElementById('schoolName').textContent = state?.schoolName ?? '我的课表';
  document.getElementById('headDate').textContent = state?.summary?.todayKey
    ? monthDayText(state.summary.todayKey)
    : monthDayOf(current);
  document.getElementById('headWeekday').textContent = WEEKDAY_SHORT[current.getDay()];
  const weekLabel = document.getElementById('weekLabel');
  weekLabel.textContent = state?.summary?.weekLabel ?? '';
  weekLabel.title = state?.termStartMonday
    ? `第一周周一：${state.termStartMonday}${state.termStartIsOverride ? '（手动设置）' : '（自动推断）'}\n点击修改`
    : '点击设置开学第一周的周一';
}

function renderSummary() {
  const text = document.getElementById('summaryLine');
  const chip = document.getElementById('summaryChip');
  const summary = state?.summary;
  if (!summary) {
    text.textContent = '';
    chip.textContent = '';
    return;
  }

  const { displayDay, current, next } = summary;
  if (!displayDay) {
    text.textContent = '最近没有安排课程';
    chip.textContent = '';
    return;
  }

  text.textContent = `${displayDay.label}有 ${displayDay.events.length} 门课`;

  if (current.length) {
    chip.textContent = `正在上课 · ${timeText(current[0].end)} 下课`;
  } else if (displayDay.isToday && next) {
    chip.textContent = `下一节 ${timeText(next.start)} · ${formatCountdown(now(), new Date(next.start))}`;
  } else {
    chip.textContent = '';
  }
}

function renderCourses() {
  const list = document.getElementById('courseList');
  const hint = document.getElementById('emptyHint');
  const events = state?.summary?.displayDay?.events ?? [];
  const currentTime = now();

  list.replaceChildren();
  hint.hidden = events.length > 0;
  if (!events.length) {
    hint.textContent = state?.totalEvents
      ? '最近没有安排课程'
      : '还没有导入课表，鼠标移到卡片上点「导入」选择 ICS 文件';
  }

  for (const event of events) {
    const row = el('li', 'course');
    const start = new Date(event.start);
    const end = new Date(event.end);
    if (currentTime >= start && currentTime < end) row.classList.add('course--current');
    else if (end <= currentTime) row.classList.add('course--past');

    row.appendChild(el('span', 'course__bar'));

    const info = el('div', 'course__info');
    info.appendChild(el('span', 'course__title', event.title));
    const subtitle = subtitleOf(event);
    if (subtitle) info.appendChild(el('span', 'course__sub', subtitle));
    row.appendChild(info);

    const times = el('div', 'course__times');
    times.appendChild(el('span', 'course__start', timeText(event.start)));
    times.appendChild(el('span', 'course__end', timeText(event.end)));
    row.appendChild(times);

    list.appendChild(row);
  }
}

function renderWeekGrid() {
  const grid = document.getElementById('weekGrid');
  const range = document.getElementById('weekRange');
  const hint = document.getElementById('weekHint');
  const backBtn = document.getElementById('backToWeekBtn');
  grid.replaceChildren();

  if (!state?.events?.length) {
    range.textContent = '周课表';
    hint.textContent = '';
    backBtn.hidden = true;
    return;
  }

  // 优先用主进程给的「指定周」数据，没有时退回本周
  const view = weekView ?? {
    weekStart: state.summary.weekStart,
    weekEnd: state.summary.weekStart,
    label: state.summary.weekLabel,
    isCurrentWeek: true,
    events: state.summary.week,
    count: state.summary.week.length,
  };
  const slotRows = weekView?.slotRows ?? state.slotRows ?? [];
  const todayIndex = view.isCurrentWeek ? dayIndexOf(state.summary.todayKey) : -1;
  const weekStartDate = new Date(`${view.weekStart}T00:00:00`);
  const weekEndDate = new Date(`${view.weekEnd}T00:00:00`);

  range.textContent = `${monthDayOf(weekStartDate)} - ${monthDayOf(weekEndDate)} · ${view.label || ''}`;
  hint.textContent = view.count
    ? state.totalWeeks
      ? `共 ${state.totalWeeks} 周`
      : ''
    : '这周没有课';
  backBtn.hidden = view.isCurrentWeek;

  grid.appendChild(el('div', 'grid-head', ''));
  WEEKDAY_LABELS.forEach((label, index) => {
    const head = el('div', 'grid-head', label);
    if (index === todayIndex) head.classList.add('grid-head--today');
    grid.appendChild(head);
  });

  const currentTime = now();
  for (const row of slotRows) {
    const timeCell = el('div', 'grid-time');
    timeCell.appendChild(el('span', null, row.time));
    if (row.label) timeCell.appendChild(el('span', null, row.label));
    grid.appendChild(timeCell);

    for (let index = 0; index < 7; index += 1) {
      const cell = el('div', 'grid-cell');
      if (index === todayIndex) cell.classList.add('grid-cell--today');

      const matches = view.events.filter(
        (event) =>
          dayIndexOf(event.start.slice(0, 10)) === index && timeText(event.start) === row.time,
      );
      for (const event of matches) {
        const item = el('div', 'slot-item');
        if (
          view.isCurrentWeek &&
          currentTime >= new Date(event.start) &&
          currentTime < new Date(event.end)
        ) {
          item.classList.add('slot-item--current');
        }
        item.appendChild(el('div', 'slot-item__title', event.title));
        const meta = [event.room, event.teacher].filter(Boolean).join(' · ');
        if (meta) item.appendChild(el('div', 'slot-item__meta', meta));
        cell.appendChild(item);
      }
      grid.appendChild(cell);
    }
  }
}

function renderStatus() {
  const status = document.getElementById('status');
  const courses = state?.meta?.courses?.length ?? 0;
  if (state?.totalEvents) {
    const fileName = state.source?.path ? state.source.path.split(/[\\/]/).pop() : '';
    status.textContent = `${courses} 门课 · ${state.totalEvents} 节`;
    status.title = fileName ? `${fileName}\n${state.source?.path ?? ''}` : '';
  } else {
    status.textContent = '未导入课表';
  }
}

function renderLayout() {
  const collapsed = state?.settings?.collapsed !== false;
  const pinned = state?.settings?.layerMode === 'top';
  document.getElementById('compactView').hidden = !collapsed;
  document.getElementById('weekView').hidden = collapsed;
  const button = document.getElementById('expandBtn');
  document.getElementById('expandBtnText').textContent = collapsed ? '展开' : '收起';
  document.getElementById('expandBtnIcon').textContent = collapsed ? '▾' : '▴';
  button.title = collapsed ? '展开完整周课表' : '收起，回到今日卡片';
  const pin = document.getElementById('pinBtn');
  pin.classList.toggle('head__pin--active', pinned);
  pin.title = pinned ? '已置顶，点击取消（放回桌面层）' : '置顶显示（始终浮在其他窗口之上）';
  // 没有数据时底部常显，否则用户找不到「导入」
  document.getElementById('foot').classList.toggle('foot--always', !state?.totalEvents);
}

function render() {
  if (!state) return;
  clockOffset = Date.now() - Date.parse(state.now);
  renderLayout();
  renderHeader();
  renderSummary();
  renderCourses();
  renderWeekGrid();
  renderStatus();
}

// ---- 周课表翻页 ----

async function loadWeek(offset) {
  try {
    weekView = await window.api.getWeek(offset);
    renderWeekGrid();
  } catch {
    /* 读取失败时保持当前视图 */
  }
}

function showNotice(message) {
  const status = document.getElementById('status');
  clearTimeout(noticeTimer);
  status.textContent = message;
  status.classList.add('foot__notice');
  document.getElementById('foot').classList.add('foot--always');
  noticeTimer = setTimeout(() => {
    status.classList.remove('foot__notice');
    document.getElementById('foot').classList.toggle('foot--always', !state?.totalEvents);
    renderStatus();
  }, 5000);
}

document.getElementById('expandBtn').addEventListener('click', async () => {
  const collapsed = state?.settings?.collapsed !== false;
  state = await window.api.setCollapsed(!collapsed);
  render();
});

document.getElementById('pinBtn').addEventListener('click', async () => {
  const pinned = state?.settings?.layerMode === 'top';
  state = await window.api.updateSettings({ layerMode: pinned ? 'desktop' : 'top' });
  render();
  showNotice(pinned ? '已取消置顶，放回桌面层' : '已置顶，会浮在其他窗口之上');
});

document.getElementById('importBtn').addEventListener('click', async () => {
  state = await window.api.importIcs();
  render();
});

document.getElementById('settingsBtn').addEventListener('click', () => window.api.openSettings());

document.getElementById('prevWeekBtn').addEventListener('click', () => {
  loadWeek((weekView?.offset ?? 0) - 1);
});

document.getElementById('nextWeekBtn').addEventListener('click', () => {
  loadWeek((weekView?.offset ?? 0) + 1);
});

document.getElementById('backToWeekBtn').addEventListener('click', () => loadWeek(0));

document.getElementById('closeBtn').addEventListener('click', () => window.api.quit());

// 开学日期编辑：点右上角「第 N 周」打开面板
const termEditor = document.getElementById('termEditor');
const termInput = document.getElementById('termStartInput');

function toggleTermEditor(show) {
  const visible = show ?? termEditor.hidden;
  termEditor.hidden = !visible;
  if (visible) {
    termInput.value = state?.termStartMonday ?? state?.summary?.weekStart ?? '';
    termInput.focus();
  }
}

document.getElementById('weekLabel').addEventListener('click', (event) => {
  event.stopPropagation();
  toggleTermEditor();
});

termEditor.addEventListener('click', (event) => event.stopPropagation());

document.addEventListener('click', () => {
  if (!termEditor.hidden) toggleTermEditor(false);
});

document.getElementById('termSaveBtn').addEventListener('click', async () => {
  if (!termInput.value) return;
  state = await window.api.updateSettings({ weekStartOverride: termInput.value });
  toggleTermEditor(false);
  render();
  showNotice(`开学第一周周一已设为 ${termInput.value}`);
});

document.getElementById('termAutoBtn').addEventListener('click', async () => {
  state = await window.api.updateSettings({ weekStartOverride: null });
  toggleTermEditor(false);
  render();
  showNotice('已改回按课表自动推断开学日期');
});

window.api.onState((payload) => {
  state = payload;
  render();
  // 课表数据变了（导入/自动重载/改设置）后刷新当前查看的那一周
  loadWeek(weekView?.offset ?? 0);
});

window.api.onNotice((payload) => showNotice(payload.message));

setInterval(() => {
  if (!state) return;
  renderHeader();
  renderSummary();
  renderCourses();
}, 1000);

(async () => {
  state = await window.api.getState();
  render();
  await loadWeek(0);
})();
