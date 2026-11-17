// Точка сборки: сцена + физика + робот + сенсоры + арены + главный цикл
// + интерпретатор скетчей (виртуальная плата arduinoApi.js).
import * as CANNON from 'cannon-es';
import { SceneRig } from './world/scene.js';
import { SandboxArena, LineArena, MazeArena, EightArena, KegelArena } from './world/arenas.js';
import { Robot, DEFAULT_MOUNTS } from './robot/robot.js';
import { SensorSuite } from './robot/sensors.js';
import { tokenize } from './arduino/lexer.js';
import { parse } from './arduino/parser.js';
import { SketchRuntime } from './arduino/interpreter.js';
import { Board } from './arduino/arduinoApi.js';
import { EXAMPLES } from './sketches/examples.js';
import { createEditor } from './ui/editor.js';
import { createBuilder } from './ui/builder.js';
import { createArenaEditor } from './ui/arenaEditor.js';
import { syncGizmos } from './ui/gizmo.js';
import { createTelemetry } from './ui/telemetry.js';
import { installHelp } from './ui/help.js';
import { installSettings } from './ui/settings.js';
import { installAccount } from './ui/account.js';
import { makeDropdown } from './ui/dropdown.js';

const PHYS_H = 1 / 120;      // фиксированный шаг физики
const MAX_SUBSTEPS = 12;

const LS = {
  arena: 'roboarena3d.arena',
  speed: 'roboarena3d.speed',
  sketch: 'roboarena3d.sketch',
  editorWidth: 'roboarena3d.editor.width',
  editorHidden: 'roboarena3d.editor.hidden',
};

// Скетч «из коробки» — тот же, что в меню «Примеры» для песочницы.
const DEFAULT_SKETCH = EXAMPLES.sandbox.code;

function $(id) { return document.getElementById(id); }

// ── Глобальное состояние приложения ──
const app = {
  rig: null,
  world: null,
  robot: null,
  sensors: null,
  arena: null,
  board: null,    // виртуальная плата
  runtime: null,  // активный SketchRuntime
  editor: null,   // CodeMirror-обёртка
  paused: false,  // пауза (заморозка шага физики и часов платы)
  simSpeed: 1,
  running: false, // скетч запущен
  _acc: 0,
  _lastT: 0,
};

// ── Загрузка/сохранение настроек ──
function loadSettings() {
  try { app.simSpeed = parseFloat(localStorage.getItem(LS.speed)) || 1; } catch { /* пусто */ }
}
function saveSettings() {
  try {
    localStorage.setItem(LS.speed, String(app.simSpeed));
    localStorage.setItem(LS.arena, $('arena-select').value);
  } catch { /* пусто */ }
}

function status(msg, isError = false) {
  const el = $('compile-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ── Сборка мира ──
function buildWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
  // NaiveBroadphase: тел мало, а SAP в этой сборке даёт фантомные пары (робот «взлетает»)
  world.broadphase = new CANNON.NaiveBroadphase();
  world.allowSleep = false;
  world.solver.iterations = 20;
  world.defaultContactMaterial.friction = 0.4;
  world.defaultContactMaterial.restitution = 0.05;
  app.world = world;
}

function buildArena(name) {
  if (app.arena) app.arena.dispose();
  let arena;
  if (name === 'sandbox') arena = new SandboxArena();
  else if (name === 'line') arena = new LineArena();
  else if (name === 'maze') arena = new MazeArena();
  else if (name === 'eight') arena = new EightArena();
  else if (name === 'kegely') arena = new KegelArena();
  else return false; // неизвестная арена
  arena.build(app.rig.scene, app.world);
  app.arena = arena;
  app.sensors.groundSampler = (x, z) => arena.sample(x, z);
  // датчик цвета: RGB пола + меши для луча вниз (просьба 14)
  app.sensors.groundColor = (x, z) => arena.colorAt(x, z);
  app.sensors.colorMeshes = () => (arena._meshes || []).filter((m) => !m.userData.holeVolume); // Н9-2: дырки не поверхности
  app.sensors.isFloorMesh = (m) => m === arena._floorMesh;
  applyContactMaterials(arena);
  if (arenaEd) arenaEd.reload(arena); // пользовательские препятствия этой арены
  return true;
}

// Пересобрать песочницу с новым размером поля (размер меняется в редакторе арены)
app.rebuildSandbox = () => {
  if (!app.arena || app.arena.name !== 'sandbox') return;
  stopSketch();
  buildArena('sandbox');
  _judgeRowEls = null; // новая арена — пересобрать строки судейства
  resetRobot();
  status('песочница пересобрана');
};

// Пересобрать ТЕКУЩУЮ арену (импорт файла арены в редакторе: LS-ключи уже
// перезаписаны, нужно заново прочитать объекты/краску/маршрут и сбросить робота)
app.rebuildArena = () => {
  if (!app.arena) return;
  stopSketch();
  buildArena(app.arena.name);
  _judgeRowEls = null;
  resetRobot();
};

// Контактные материалы — после каждой сборки арены (материалы создаются заново).
// Пол/рампа/ящики: корпус и колёса — трение 0, привод кинематический (скорость
// задаётся напрямую каждый шаг), а трение солвера против навязанной скорости даёт
// фантомный отрыв корпуса (воспроизводится минимальным тестом). Стены — трение
// 0.5: без него корпус при ударе скользит вверх по стене и встаёт «на нос».
function applyContactMaterials(arena) {
  const gm = arena.groundMat;
  const cm = (a, b, opts) => app.world.addContactMaterial(new CANNON.ContactMaterial(a, b, opts));
  cm(app.robot.matSlick, gm, { friction: 0, restitution: 0 });
  cm(app.robot.matChassis, gm, { friction: 0, restitution: 0 });
  cm(gm, gm, { friction: 0.4, restitution: 0.05 });
  if (arena.wallPhysMat) {
    cm(app.robot.matSlick, arena.wallPhysMat, { friction: 0.5, restitution: 0 });
    cm(app.robot.matChassis, arena.wallPhysMat, { friction: 0.5, restitution: 0 });
  }
}

function resetRobot() {
  const sp = app.arena.startPose;
  app.robot.resetTo(sp.x, sp.z, sp.yawDeg);
  app.arena.reset();
  if (app.arena.judge) app.arena.judge.reset();
  hideBanner();
}

// ── Панель судейства и баннер ──
let _judgeRowEls = null;
let _judgeEventKey = '';
let arenaEd = null; // редактор арены: после каждой сборки арены подгружает свои препятствия

function renderJudge() {
  const j = app.arena && app.arena.judge;
  if (!j) return;
  $('judge-title').textContent = 'Судейство — ' + j.title;
  if (!_judgeRowEls || _judgeRowEls.arena !== app.arena) {
    const rows = $('judge-rows');
    rows.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'row';
    t.innerHTML = 'Время: <b>0.0 с</b>';
    const p = document.createElement('div');
    p.className = 'hint';
    rows.append(t, p);
    _judgeRowEls = { arena: app.arena, time: t.querySelector('b'), prog: p };
  }
  _judgeRowEls.time.textContent = j.time.toFixed(1) + ' с';
  _judgeRowEls.prog.textContent = j.progressText;

  const key = j.events.length + ':' + (j.events.length ? j.events[j.events.length - 1].text : '');
  if (key !== _judgeEventKey) {
    _judgeEventKey = key;
    const ev = $('judge-events');
    ev.innerHTML = '';
    for (const e of j.events.slice(-6)) {
      const d = document.createElement('div');
      d.textContent = `${e.t.toFixed(1)} с — ${e.text}`;
      if (e.kind === 'bad') d.className = 'bad';
      else if (e.kind === 'good' || e.kind === 'finish') d.className = 'good';
      ev.appendChild(d);
    }
  }

  const banner = $('banner');
  if (j.finished && j.result && !banner.dataset.shown) {
    banner.dataset.shown = '1';
    $('banner-title').textContent = '🏁 ' + j.title;
    $('banner-text').textContent = j.result;
    banner.classList.add('show');
  }
}

function hideBanner() {
  const banner = $('banner');
  banner.dataset.shown = '';
  banner.classList.remove('show');
}

// ── Serial-монитор ──
function appendSerial(text, cls) {
  const log = $('serial-log');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  log.appendChild(span);
  while (log.childNodes.length > 500) log.removeChild(log.firstChild);
  if ($('serial-autoscroll').checked) log.scrollTop = log.scrollHeight;
}

// ── Главный цикл ──
function stepOnce() {
  app.robot.prePhysics(PHYS_H);
  app.world.step(PHYS_H);
  app.robot.postPhysics(PHYS_H);
  app.sensors.postPhysics(PHYS_H);
  app.robot.updateServo(PHYS_H);
  if (app.board) app.board.advance(PHYS_H); // часы платы + разрешение delay()
  if (app.arena.judge) app.arena.judge.update(PHYS_H, app.robot, app.sensors);
}

function tick(t) {
  requestAnimationFrame(tick);
  if (!app._lastT) app._lastT = t;
  let dt = (t - app._lastT) / 1000;
  app._lastT = t;
  if (dt > 0.05) dt = 0.05;

  // физика фиксированными шагами (пауза или открытый редактор — не шагаем,
  // в редакторе модель/полигон «замораживаются» вместе со временем)
  if (!app.paused && !app.editing) {
    app._acc += dt * app.simSpeed;
    let n = Math.floor(app._acc / PHYS_H);
    if (n > MAX_SUBSTEPS) { n = MAX_SUBSTEPS; app._acc = PHYS_H; }
    else app._acc -= n * PHYS_H;
    for (let i = 0; i < n; i++) stepOnce();
  }

  app.arena.syncMeshes();
  app.robot.syncMeshes();
  syncGizmos(); // стрелки гизмо следуют за объектом каждый кадр (физика/перетаскивание)
  arenaEd?.onFrame?.(); // Н22-2: маркеры размера — видимость по камере каждый кадр
  if (app.telemetry) app.telemetry.tick(dt); // графики телеметрии (свой темп сэмплов)
  renderJudge();
  app.rig.update(dt);
  app.rig.render();
}

// ── Скетч: старт/стоп ──
function startSketch() {
  if (app.editing) return; // в редакторе робота/арены запуск запрещён
  if (app.runtime) stopSketch();
  const src = app.editor.getValue();
  let program;
  try {
    const lex = tokenize(src);
    if (lex.errors.length) {
      const e = lex.errors[0];
      const pos = e.line ? ` (строка ${e.line}${e.col ? ':' + e.col : ''})` : '';
      status('ошибка компиляции: ' + e.message + pos, true);
      appendSerial('⚠ Ошибка компиляции: ' + e.message + pos + '\n', 'err');
      return;
    }
    program = parse(lex.tokens);
  } catch (e) {
    const pos = e.line ? ` (строка ${e.line}${e.col ? ':' + e.col : ''})` : '';
    status('ошибка компиляции: ' + e.message + pos, true);
    appendSerial('⚠ Ошибка компиляции: ' + e.message + pos + '\n', 'err');
    return;
  }
  resetRobot();
  app.board.reset();
  const rt = new SketchRuntime(program, app.board.api, {
    onError: (msg) => {
      status(msg, true);
      appendSerial('⚠ ' + msg + '\n', 'err');
      teardownSketch(); // фатальная ошибка — вернуть UI в исходное состояние
    },
  });
  app.board.attachRuntime(rt);
  app.runtime = rt;
  app.running = true;
  app.paused = false;
  applyPauseUI();
  $('btn-pause').disabled = false;
  hideBanner();
  if (app.arena.judge) app.arena.judge.start();
  $('btn-stop').disabled = false;
  $('btn-start').disabled = true;
  status('скетч выполняется…');
  appendSerial('── ▶ Старт ──\n', 'sys');
  rt.start();
}

// ПН10-5: пауза видна на самой кнопке — оранжевая подсветка .active и иконка
// «плей» (нажатие возобновит выполнение), иначе кнопка выглядит неизменной.
function applyPauseUI() {
  const b = $('btn-pause');
  b.classList.toggle('active', app.paused);
  const use = b.querySelector('use');
  if (use) use.setAttribute('href', app.paused ? '#i-play' : '#i-pause');
}

function teardownSketch() {
  if (app.runtime) {
    app.runtime.stop();
    app.runtime = null;
  }
  app.board.detachRuntime();
  app.board.reset();
  app.running = false;
  app.paused = false;
  applyPauseUI();
  $('btn-pause').disabled = true;
  if (app.arena.judge) app.arena.judge.stop();
  $('btn-stop').disabled = true;
  $('btn-start').disabled = false;
}

function stopSketch() {
  if (app.runtime) appendSerial('── ⏹ Стоп ──\n', 'sys');
  teardownSketch();
  status('остановлено');
}

// ── Инициализация ──
function boot() {
  loadSettings();

  app.rig = new SceneRig($('viewport-pane'));
  buildWorld();

  const savedMounts = loadMounts();
  app.robot = new Robot(app.world, app.rig.scene, savedMounts);
  app.sensors = new SensorSuite(app.robot, app.world, app.rig.scene);
  app.telemetry = createTelemetry({ app }); // графики движения/датчиков (правый низ)

  // Н3: робот перевернулся о большую преграду — сообщаем и пишем в судейство
  app.robot.onTumble = () => {
    status('робот перевернулся — «Сброс» вернёт на старт', true);
    const j = app.arena && app.arena.judge;
    if (j) j.events.push({ t: j.time, text: 'робот перевернулся', kind: 'bad' });
  };

  // контактные материалы настраиваются в buildArena → applyContactMaterials()
  buildArena('sandbox');

  resetRobot();
  app.rig.setMode('orbit');

  // ── Виртуальная плата ──
  app.board = new Board({ robot: app.robot, sensors: app.sensors });
  app.board.serialSink = (text) => appendSerial(text);

  // ── Редактор (CodeMirror 5) + автосохранение + импорт/экспорт ──
  let savedSketch = null;
  try { savedSketch = localStorage.getItem(LS.sketch); } catch { /* пусто */ }
  app.editor = createEditor($('editor-host'), {
    value: savedSketch !== null && savedSketch.trim() !== '' ? savedSketch : DEFAULT_SKETCH,
    onchange: (v) => {
      try { localStorage.setItem(LS.sketch, v); } catch { /* пусто */ }
    },
  });
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      app.editor.setValue(String(rd.result));
      try { localStorage.setItem(LS.sketch, String(rd.result)); } catch { /* пусто */ }
      status('открыт: ' + f.name);
    };
    rd.readAsText(f);
  });
  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('btn-export').addEventListener('click', () => {
    const blob = new Blob([app.editor.getValue()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sketch.ino';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ── Изменение размера редактора кода (перетаскивание границы) ──
  const mainEl = $('main');
  const resizer = $('pane-resize');
  const clampEdW = (w) => Math.max(280, Math.min(window.innerWidth - 360, w));
  let edW = clampEdW(parseInt(localStorage.getItem(LS.editorWidth) || '', 10) || 400);
  const applyEdW = () => {
    // ширина — через CSS-переменную: правило body.edit-mode #main должно
    // уметь перекрыть её (инлайн grid-template-columns перебил бы его)
    mainEl.style.setProperty('--edw', edW + 'px');
    resizer.style.left = edW + 'px'; // ручка 10px по центру границы
  };
  applyEdW();
  let edDrag = false;
  resizer.addEventListener('pointerdown', (e) => {
    edDrag = true;
    resizer.classList.add('drag');
    try { resizer.setPointerCapture(e.pointerId); } catch { /* синтетика */ }
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!edDrag) return;
    edW = clampEdW(e.clientX);
    applyEdW(); // канвас подгоняет ResizeObserver в scene.js (Н8-1)
  });
  const edDragEnd = () => {
    if (!edDrag) return;
    edDrag = false;
    resizer.classList.remove('drag');
    try { localStorage.setItem(LS.editorWidth, String(edW)); } catch { /* пусто */ }
  };
  resizer.addEventListener('pointerup', edDragEnd);
  resizer.addEventListener('pointercancel', edDragEnd);
  window.addEventListener('resize', () => { edW = clampEdW(edW); applyEdW(); });

  // ── Скрытие редактора кода кнопкой в тулбаре, рядом с «глазом» судейства
  // (ПН9-1). Прячет только колонку кода (#editor-pane вместе с serial-монитором,
  // который живёт внутри неё); судейство (#judge в вьюпорте) не трогается.
  // Анимация: уход через .closing (codeOut), скрытие колонки — после конца;
  // появление — CSS-анимация codeIn при снятии display:none.
  const codePane = $('editor-pane');
  const codeBtn = $('btn-code-eye');
  const codeSeq = { n: 0 };
  const codeHidden = () => localStorage.getItem(LS.editorHidden) === '1';
  const collapseCode = (seq) => { // конец анимации ухода
    if (codeSeq.n !== seq) return; // успели показать снова
    codePane.classList.remove('closing');
    document.body.classList.add('code-hidden');
    // размер канваса подхватит ResizeObserver в scene.js (Н8-1)
  };
  const applyCodeVis = (animate = true) => {
    const hidden = codeHidden();
    codeBtn.classList.toggle('off', hidden);
    const seq = ++codeSeq.n;
    if (hidden) {
      if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        codePane.classList.add('closing');
        setTimeout(() => collapseCode(seq), 190); // codeOut .18s
      } else {
        collapseCode(seq);
      }
    } else {
      document.body.classList.remove('code-hidden');
      codePane.classList.remove('closing');
      if (app.editor && app.editor.refresh) {
        setTimeout(() => app.editor.refresh(), 60); // CodeMirror после показа
      }
    }
  };
  codeBtn.addEventListener('click', () => {
    try { localStorage.setItem(LS.editorHidden, codeHidden() ? '0' : '1'); } catch { /* пусто */ }
    applyCodeVis();
  });
  applyCodeVis(false);

  // ── Оверлеи: сборка, арена и справка ──
  const builder = createBuilder({
    app, // rig/сцена вьюпорта: редактор модели работает в главной камере
    robot: app.robot,
    sensors: app.sensors,
    onMountsChange: () => app.board.refreshDevices(), // пины устройств могли поменяться
  });
  // Режим редактора: окно кода и serial скрывается, их место занимает окно
  // редактора (панель у левого края вьюпорта). Редакторы взаимоисключающие.
  // Пока редактор открыт — время замирает (tick не шагает физику) и запуск
  // скетча/смена полигона заблокированы. Вызов строго ПОСЛЕ смены состояния:
  // при открытии класс ставится до первой отрисовки, при закрытии панель
  // доигрывает анимацию ухода на своём месте (геометрию держит .closing в CSS).
  const syncEditMode = () => {
    const editing = builder.active || arenaEd.isOpen;
    app.editing = editing;
    document.body.classList.toggle('edit-mode', editing);
    $('btn-start').disabled = editing || app.running;
    $('btn-reset').disabled = editing;
    $('btn-pause').disabled = editing || !app.running;
    $('arena-select').disabled = editing;
  };
  $('btn-builder').addEventListener('click', () => {
    if (builder.active) {
      builder.close();
      $('btn-builder').classList.remove('active');
    } else {
      if (arenaEd.isOpen) { // редакторы взаимоисключающие: один вьюпорт — один инструмент
        arenaEd.close();
        $('btn-arena-edit').classList.remove('active');
      }
      builder.open();
      $('btn-builder').classList.add('active');
    }
    syncEditMode();
  });
  arenaEd = createArenaEditor({ app });
  $('btn-arena-edit').addEventListener('click', () => {
    if (arenaEd.isOpen) {
      arenaEd.close();
      $('btn-arena-edit').classList.remove('active');
    } else {
      if (builder.active) {
        builder.close();
        $('btn-builder').classList.remove('active');
      }
      arenaEd.open();
      $('btn-arena-edit').classList.add('active');
    }
    syncEditMode();
  });
  // Жесты на вьюпорте: сначала редактор робота, затем редактор арены,
  // иначе — штатная орбита камеры.
  app.rig.inputGuard = (e) => {
    if (builder && builder.active) return builder.guard(e);
    if (arenaEd && arenaEd.isOpen) return arenaEd.guard(e);
    return false;
  };
  arenaEd.reload(app.arena); // препятствия для арены, собранной при инициализации мира
  const help = installHelp();
  $('btn-help').addEventListener('click', help.open);

  // ── Горячие клавиши редакторов (просьба 13): G — режим, Q/E — поворот,
  // Del — удалить, Ctrl+S — сохранить, Esc — снять выбор/закрыть меню ──
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const tag = t && t.tagName;
    if (t && t.isContentEditable) return;
    if (t && t.closest && t.closest('.CodeMirror')) return;
    // Н14-2: фокус в числе/селекте редактора раньше «съедал» Ctrl+C/V/D/G —
    // копирование срабатывало через раз. Теперь сочетания с Ctrl/Cmd проходят
    // к редакторам и оттуда; текстовый ввод (и выделенный текст) не трогаем.
    const textFocus = tag === 'TEXTAREA' || tag === 'SELECT'
      || (tag === 'INPUT' && !/^(number|range|color|checkbox|radio|button|submit)$/.test(t.type || 'text'));
    const hasTextSel = t && typeof t.selectionStart === 'number' && t.selectionStart !== t.selectionEnd;
    if ((textFocus || hasTextSel) && !(e.ctrlKey || e.metaKey)) return;
    if (builder.active) {
      if (builder.handleKey(e)) e.preventDefault();
    } else if (arenaEd.isOpen) {
      if (arenaEd.handleKey(e)) e.preventDefault();
    }
  });

  // ── Настройки: тема, язык, реализм, судейство ──
  installSettings({ app });

  // ── Аккаунт: вход / регистрация (отдельно или участник класса) / профиль ──
  // Данные — в localStorage этого браузера (см. src/account/accounts.js).
  const accountUi = installAccount({ app });

  // ── Serial ──
  $('serial-clear').addEventListener('click', () => { $('serial-log').textContent = ''; });

  // ── UI ──
  $('speed-select').value = String(app.simSpeed);
  let savedArena = null;
  try { savedArena = localStorage.getItem(LS.arena); } catch { /* пусто */ }
  const arenaName = ['line', 'maze', 'sandbox'].includes(savedArena) ? savedArena : 'sandbox';
  $('arena-select').value = arenaName;
  if (arenaName !== 'sandbox') {
    buildArena(arenaName);
    _judgeRowEls = null; // новая арена — пересобрать строки судейства
    resetRobot();
  }
  $('arena-select').addEventListener('change', (e) => {
    const name = e.target.value;
    if (buildArena(name)) {
      _judgeRowEls = null;
      stopSketch();
      resetRobot();
      status('арена: ' + app.arena.title);
      saveSettings();
    } else {
      status('арена «' + e.target.selectedOptions[0].text + '» пока не готова', true);
      e.target.value = app.arena.name;
    }
  });
  $('speed-select').addEventListener('change', (e) => {
    app.simSpeed = parseFloat(e.target.value) || 1;
    saveSettings();
  });
  // Н8-4: анимированные списки «полигонов» и «скорости» — поверх тех же
  // <select> (они остаются источником значения и события change)
  makeDropdown($('arena-select'));
  makeDropdown($('speed-select'));
  $('btn-start').addEventListener('click', startSketch);
  $('btn-stop').addEventListener('click', stopSketch);
  $('btn-reset').addEventListener('click', () => {
    stopSketch();
    resetRobot();
    status('сброс');
  });

  // Примеры скетчей — подставить в редактор (не перезаписываем до выбора).
  // Н5: у примера может быть своя арена (ex.arena) — переключаемся на неё,
  // чтобы пример сразу ехал по своему полигону.
  $('examples-select').addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key) return;
    const ex = EXAMPLES[key];
    e.target.value = '';
    if (!ex) return;
    if (ex.arena) {
      const sel = $('arena-select');
      const has = sel && Array.from(sel.options).some((o) => o.value === ex.arena);
      if (has && sel.value !== ex.arena) {
        sel.value = ex.arena;
        sel.dispatchEvent(new Event('change'));
      }
    }
    app.editor.setValue(ex.code);
    try { localStorage.setItem(LS.sketch, ex.code); } catch { /* пусто */ }
    status('загружен пример: ' + ex.title);
  });

  // Пауза: заморозить шаг физики и часы платы; скетч подвиснет на ближайшем delay
  $('btn-pause').addEventListener('click', () => {
    if (!app.running) return;
    app.paused = !app.paused;
    applyPauseUI(); // ПН10-5: подсветка + иконка плей/пауза
    status(app.paused ? 'пауза' : 'скетч выполняется…');
  });

  // Отладочный мост для проверки физики из консоли
    window.__APP = {
    app,
    account: accountUi,
    debug: {
      drive(l, r) { app.robot.setMotorTargets(l, r); },
      stop() { app.robot.setMotorTargets(0, 0); },
      step(n) {
        for (let i = 0; i < n; i++) stepOnce();
        app.arena.syncMeshes();
        app.robot.syncMeshes();
      },
      reset: resetRobot,
      sampleGround: (x, z) => app.arena.sample(x, z),
      sonarCm: () => app.sensors.readSonarCm(),
      line: (i) => app.sensors.readLine(i),
      bumper: () => app.sensors.bumperPressed(),
      encoders() { return [app.robot.encoderTicks(0), app.robot.encoderTicks(1)]; },
      robot: () => app.robot,
      arena: () => app.arena,
      sensors: () => app.sensors,
      renderJudge, hideBanner,
    },
  };

  requestAnimationFrame(tick);
  status('готов');
}

function loadMounts() {
  try {
    const raw = localStorage.getItem('roboarena3d.mounts');
    if (raw) {
      const m = JSON.parse(raw);
      // лёгкая валидация: битый конфиг не должен ломать робота
      const okNum = (v) => typeof v === 'number' && isFinite(v);
      const valid = Array.isArray(m.line) && m.line.length === 3
        && m.line.every((p) => okNum(p.x) && okNum(p.z))
        && okNum(m.sonar?.x) && okNum(m.sonar?.z) && okNum(m.sonar?.height) && okNum(m.sonar?.pitchDeg)
        && okNum(m.bumper?.z) && okNum(m.bumper?.width)
        && okNum(m.servo?.x) && okNum(m.servo?.z);
      if (!valid) return null;
      // миграция v1 → v2: нет карты устройств — собрать из штатной раскладки
      if (!Array.isArray(m.devices) || !m.devices.length) {
        m.devices = JSON.parse(JSON.stringify(DEFAULT_MOUNTS.devices));
      }
      // миграция v3: 3D-детали редактора модели (оставляем только валидные)
      if (!Array.isArray(m.parts)) m.parts = [];
      m.parts = m.parts.filter((p) => p && (p.shape === 'box' || p.shape === 'cyl'));
      // миграция v4: корпус/колёса (появились позже — старые конфиги их не знают)
      if (!m.chassis || typeof m.chassis !== 'object') {
        m.chassis = JSON.parse(JSON.stringify(DEFAULT_MOUNTS.chassis));
      }
      if (!m.wheels || typeof m.wheels !== 'object') {
        m.wheels = JSON.parse(JSON.stringify(DEFAULT_MOUNTS.wheels));
      }
      return m;
    }
  } catch { /* пусто */ }
  return null; // Robot применит DEFAULT_MOUNTS
}

boot();
