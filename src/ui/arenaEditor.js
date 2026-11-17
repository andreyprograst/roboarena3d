// Редактор арены — прямо в 3D-вьюпорте. Панель — только плашки:
// ➕ Объект · 🖌 Рисовать · 💾 Сохранить (+ 📏 Поле у песочницы и
// 🚩 Маршрут у Линии/Лабиринта) — просьба «плашки только по добавлению,
// рисованию и сохранению». Каждая плашка открывает выпадающее меню.
// Клик по объекту открывает ОТДЕЛЬНОЕ окно редактирования: размеры, цвет,
// XYZ относительно центра арены и повороты числами (просьбы 5, 9, 10).
// Двойной клик по выбранному объекту — стрелки ↔ кольца (просьба 12).
// Горячие клавиши: G — режим, Q/E — поворот, Del — удалить, Ctrl+S —
// сохранить, Esc — снять выбор (просьба 13).
// Кисть рисует по полу И по объектам; на объектах — по ячейке грани
// (атлас), размер кисти постоянный в мм на любой грани (просьба 1).
// Препятствия и краска сохраняются в localStorage по имени арены.
import * as THREE from 'three';
import { saveRoute, clearRoute, loadRoute, loadArenaSize, saveArenaSize, ARENA_SIZE_LIMITS, brushFromHit, remapBoxAtlasUV, makeWedgeGeometry, loadLights, saveLights, clearLights, LIGHT_LIMITS, loadArenaColors, saveArenaColors, clearArenaColors, ARENA_COLOR_DEFAULTS, hexCss } from '../world/arenas.js';
import { TransformGizmo } from './gizmo.js';
import { hideAnimated, showAnimated } from './anim.js';
import { isoBox, isoCyl, isoCone, isoBall, isoWedge } from './icons.js';
import { startGhostDrag, ghostAteClick } from './ghost.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const PROP_TYPES = {
  crate:  { label: 'Ящик',       shape: 'box',  sx: 0.10, sz: 0.10, h: 0.10, color: 0xb08948, wall: false },
  block:  { label: 'Блок',       shape: 'box',  sx: 0.20, sz: 0.20, h: 0.10, color: 0x8a8f98, wall: false },
  wall:   { label: 'Стена 40×5', shape: 'box',  sx: 0.40, sz: 0.05, h: 0.10, color: 0x6b7383, wall: true },
  wallv:  { label: 'Стена 5×40', shape: 'box',  sx: 0.05, sz: 0.40, h: 0.10, color: 0x6b7383, wall: true },
  wall80: { label: 'Стена 80×5', shape: 'box',  sx: 0.80, sz: 0.05, h: 0.10, color: 0x6b7383, wall: true },
  curb:   { label: 'Бордюр',     shape: 'box',  sx: 0.30, sz: 0.03, h: 0.02, color: 0xb8bec9, wall: false },
  wedge:  { label: 'Рампа',      shape: 'wedge', sx: 0.30, sz: 0.15, h: 0.08, color: 0x7d8494, wall: false },
  ramp10: { label: 'Планка 10°', shape: 'box',  sx: 0.40, sz: 0.20, h: 0.07, color: 0x7d8494, wall: false, rotZ: 10 * Math.PI / 180 },
  plat:   { label: 'Платформа',  shape: 'box',  sx: 0.40, sz: 0.20, h: 0.08, color: 0x9aa2b1, wall: false },
  barrel: { label: 'Бочонок',    shape: 'cyl',  r: 0.05, hgt: 0.12, color: 0xa4693a, wall: false },
  cone:   { label: 'Конус',      shape: 'cone', r: 0.04, hgt: 0.12, color: 0xd95f2b, wall: false },
  ball:   { label: 'Шар',        shape: 'ball', r: 0.06, color: 0xc9564c, wall: false },
};

// 3D-пиктограммы для чипов выбора объектов
const CHIP_ICON = {
  crate: isoBox, block: isoBox, wall: isoBox, wallv: isoBox, wall80: isoBox,
  curb: isoBox, wedge: isoWedge, ramp10: isoWedge, plat: isoBox,
  barrel: isoCyl, cone: isoCone, ball: isoBall,
};

const SHAPE_NAME = { box: 'Блок', cyl: 'Цилиндр', cone: 'Конус', ball: 'Шар', wedge: 'Рампа' };

// «Круглые» формы: габарит по полу — радиус, а не sx/sz
const isRound = (s) => s === 'ball' || s === 'cyl' || s === 'cone';

// Старый формат сохранений (2D-редактор): {type:'crate', x, z} → параметры типа
function legacyToProp(p) {
  const t = PROP_TYPES[p.type] || PROP_TYPES.crate;
  return { shape: t.shape, x: p.x, z: p.z, sx: t.sx, sz: t.sz, h: t.h, r: t.r || 0.05, hgt: t.hgt || 0.1, color: t.color, wall: !!t.wall, pinned: true };
}

export function createArenaEditor({ app }) {
  const propsKey = (name) => 'roboarena3d.props.' + name;
  const paintKey = (name) => 'roboarena3d.paint.' + name;
  // Н29-2a: единый контурный значок внутри текстовой кнопки (стиль тулбара)
  const bi = (id) => `<svg class="bi"><use href="#i-${id}"/></svg>`;

  // ── Панель поверх вьюпорта: только плашки ──
  const pane = document.getElementById('viewport-pane');
  const panel = document.createElement('div');
  panel.id = 'arena-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <h4>Редактор арены</h4>
    <div class="ap-title" id="ap-title"></div>
    <div class="plate-row">
      <button id="ap-add" class="plate" title="Добавить объект"><span class="ic"><svg><use href="#i-plus"/></svg></span><span>Объект</span></button>
      <button id="ap-paint" class="plate" title="Рисовать по полу и объектам"><span class="ic"><svg><use href="#i-brush"/></svg></span><span>Рисовать</span></button>
      <button id="ap-save" class="plate" title="Сохранить всё"><span class="ic"><svg><use href="#i-save"/></svg></span><span>Сохранить</span></button>
    </div>
    <div class="plate-row" id="ap-extra-row">
      <button id="ap-field" class="plate" title="Размер и цвета поля" style="display:none"><span class="ic"><svg><use href="#i-field"/></svg></span><span>Поле</span></button>
      <button id="ap-route" class="plate" title="Маршрут и правила" style="display:none"><span class="ic"><svg><use href="#i-flag"/></svg></span><span>Маршрут</span></button>
      <button id="ap-light" class="plate" title="Источники света" style="display:none"><span class="ic"><svg><use href="#i-bulb"/></svg></span><span>Свет</span></button>
    </div>
    <div class="ap-hint" id="ap-count"></div>
    <input type="file" id="ap-texfile" accept="image/*" style="display:none">
  `;
  pane.appendChild(panel);

  // ── Выпадающие меню плашек (поверх панели, к вьюпорту) ──
  const addPop = document.createElement('div');
  addPop.id = 'ap-addpop';
  addPop.className = 'pop';
  addPop.style.display = 'none';
  addPop.innerHTML = `
    <div class="ap-sec">Добавить объект</div>
    <div class="chip-grid" style="grid-template-columns:repeat(3,1fr)">
      ${Object.entries(PROP_TYPES).map(([k, t]) =>
        `<button class="chip type-chip" data-t="${k}" title="${t.label}">${CHIP_ICON[k]('#' + t.color.toString(16).padStart(6, '0'))}<span>${t.label}</span></button>`).join('')}
    </div>
  `;
  pane.appendChild(addPop);

  const paintPop = document.createElement('div');
  paintPop.id = 'ap-paintpop';
  paintPop.className = 'pop';
  paintPop.style.display = 'none';
  paintPop.innerHTML = `
    <div class="ap-sec">Рисование</div>
    <label class="ap-lbl">Инструмент
      <select id="ap-tool" style="flex:1">
        <option value="brush">Кисть (пол и объекты)</option>
        <option value="rect">Прямоугольник</option>
        <option value="circle">Круг</option>
        <option value="line">Линия</option>
        <option value="fill">Заливка (грань)</option>
        <option value="eraser">Ластик</option>
        <option value="image">Картинка</option>
      </select>
    </label>
    <label class="ap-lbl">Кисть
      <input type="color" id="ap-color" value="#222222">
      <input type="range" id="ap-size" min="5" max="200" value="30" title="Толщина линии / радиус, мм">
      <span class="ap-val" id="ap-size-val">30 мм</span>
    </label>
    <label class="ap-lbl"><input type="checkbox" id="ap-fill" checked> заливка фигур</label>
    <!-- Н15-7: кнопка картинки во всю ширину, как в окне «Поле» (ap-col) -->
    <div class="ap-row ap-col">
      <button id="ap-img">${bi('image')} Картинка…</button>
      <input type="file" id="ap-file" accept="image/*" style="display:none">
    </div>
  `;
  pane.appendChild(paintPop);

  const savePop = document.createElement('div');
  savePop.id = 'ap-savepop';
  savePop.className = 'pop';
  savePop.style.display = 'none';
  savePop.innerHTML = `
    <div class="ap-sec">Сохранение</div>
    <div class="ap-row"><button id="ap-saveall" class="primary">${bi('save')} Сохранить всё</button></div>
    <div class="ap-sec">Файл</div>
    <!-- Н15-7: экспорт/импорт во всю ширину, как в окне «Поле» (ap-col) -->
    <div class="ap-row ap-col">
      <button id="ap-export">${bi('download')} Экспорт</button>
      <button id="ap-import">${bi('upload')} Импорт</button>
    </div>
    <input type="file" id="ap-json" accept=".json,application/json" style="display:none">
  `;
  pane.appendChild(savePop);

  const fieldPop = document.createElement('div');
  fieldPop.id = 'ap-fieldpop';
  fieldPop.className = 'pop';
  fieldPop.style.display = 'none';
  // Н10-1: окно «Поле» есть на КАЖДОЙ арене; Н29-3: размер поля тоже на любой
  // арене; Н29-4: фон пола/бортов/заднего плана; очистка краски/объектов везде
  fieldPop.innerHTML = `
    <div class="ap-sec">Поле</div>
    <!-- Н15-8: два поля в две колонки, каждое под своей подписью — раньше
         inputs стояли в одну flex-строку с общей подписью и переносились
         на разные уровни -->
    <div id="ap-fieldsize">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0">
        <label class="ap-lbl" style="display:block;margin:0">Ширина, м
          <input type="number" id="ap-fw" min="2" max="8" step="0.5" style="width:100%;margin-top:3px">
        </label>
        <label class="ap-lbl" style="display:block;margin:0">Глубина, м
          <input type="number" id="ap-fd" min="2" max="8" step="0.5" style="width:100%;margin-top:3px">
        </label>
      </div>
      <div class="ap-row"><button id="ap-fapply" class="primary">Применить</button></div>
    </div>
    <div class="ap-sec">Фон и цвета</div>
    <div class="num-row"><span class="lb">Платформа (пол)</span><input type="color" id="ap-cfloor" title="Цвет пола арены"></div>
    <div class="num-row"><span class="lb">Стены (борта)</span><input type="color" id="ap-cwall" title="Цвет бортов по периметру"></div>
    <div class="num-row"><span class="lb">Задний план</span><input type="color" id="ap-cbg" title="Цвет фона сцены и тумана"></div>
    <div class="ap-row"><button id="ap-creset" title="Вернуть цвета по умолчанию">${bi('reset')} Сбросить цвета</button></div>
    <div class="ap-sec">Очистка</div>
    <!-- Н12-5: кнопки очистки закреплены стопкой (ap-col) — раньше две
         подписи не влезали в строку 240px и переносились, а «Точно?» (57px)
         собирала их в одну: кнопки прыгали. Полная ширина у каждой — размер
         не зависит от надписи вовсе. -->
    <div class="ap-row ap-col">
      <button id="ap-clearpaint" title="Стереть краску пола и всех объектов">${bi('reset')} Стереть краску</button>
      <button id="ap-clearprops" title="Удалить все объекты арены">${bi('trash')} Убрать объекты</button>
    </div>
  `;
  pane.appendChild(fieldPop);

  const routePop = document.createElement('div');
  routePop.id = 'ap-routepop';
  routePop.className = 'pop';
  routePop.style.display = 'none';
  routePop.innerHTML = `
    <div class="ap-sec">Маршрут и правила</div>
    <div class="ap-row">
      <button id="ap-rmode">${bi('flag')} Правка: выкл</button>
      <button id="ap-rrst">${bi('reset')} Сброс</button>
    </div>
    <div class="ap-row">
      <button id="ap-rcpadd" title="Включить: клик по полю ставит новый чекпоинт">${bi('plus')} Чекпоинт</button>
      <button id="ap-rcpdel" title="Убрать последний чекпоинт">${bi('minus')} Чекпоинт</button>
    </div>
    <label class="ap-lbl">Лимит времени, с <input type="number" id="ap-rtime" min="0" max="600" style="width:64px"></label>
    <label class="ap-lbl"><span id="ap-rmaxlbl" style="min-width:110px">Макс. сходов</span> <input type="number" id="ap-rmax" min="0" max="50" style="width:64px"></label>
    <label class="ap-lbl" id="ap-rcps-row"><input type="checkbox" id="ap-rcps" checked> требовать все чекпоинты</label>
    <div class="ap-sec" style="margin-top:6px">Точные координаты</div>
    <div class="num-row" id="ap-rst-row"><span class="lb">Старт</span><span class="ax">X</span><input type="number" id="ap-rsx" step="0.05" title="X точки старта, м"><span class="ax">Z</span><input type="number" id="ap-rsz" step="0.05" title="Z точки старта, м"></div>
    <div class="num-row" id="ap-rstrot-row"><span class="lb">Поворот старта</span><input type="number" id="ap-rsrot" step="15" min="-180" max="180" title="Куда смотрит робот на старте (0 — вдоль −Z)"><span class="ax">°</span></div>
    <div class="num-row" id="ap-rfx-row" style="display:none"><span class="lb">Финиш</span><span class="ax">X</span><input type="number" id="ap-rfx" step="0.05" title="X финиша, м"><span class="ax">Z</span><input type="number" id="ap-rfz" step="0.05" title="Z финиша, м"></div>
    <div class="num-row" id="ap-rexit-row" style="display:none"><span class="lb">Выход</span><span class="ax">X</span><input type="number" id="ap-rex" step="0.05" title="X зоны выхода, м"><span class="ax">Z</span><input type="number" id="ap-rez" step="0.05" title="Z зоны выхода, м"></div>
    <div class="num-row" id="ap-rcp-row" style="display:none"><span class="lb">Чекпоинт №</span><select id="ap-rcpsel"></select></div>
    <div class="num-row" id="ap-rcpxyz-row" style="display:none"><span class="lb">Позиция</span><span class="ax">X</span><input type="number" id="ap-rcpx" step="0.05" title="X выбранного чекпоинта, м"><span class="ax">Z</span><input type="number" id="ap-rcpz" step="0.05" title="Z выбранного чекпоинта, м"></div>
    <div class="ap-row"><button id="ap-rfin">${bi('flag')} Отдельный финиш: нет</button></div>
    <div class="ap-row"><button id="ap-rsave" class="primary">${bi('save')} Сохранить правила</button></div>
  `;
  pane.appendChild(routePop);

  // ── Н29-2b: источники света ──
  const lightPop = document.createElement('div');
  lightPop.id = 'ap-lightpop';
  lightPop.className = 'pop';
  lightPop.style.display = 'none';
  lightPop.innerHTML = `
    <div class="ap-sec">Источники света</div>
    <div class="ap-row"><button id="ap-ladd" class="primary">${bi('plus')} Источник</button></div>
    <div class="ap-hint" style="margin:2px 0 6px">Лампы освещают сцену. Датчик света реагирует на них и на общее освещение арены.</div>
    <div id="ap-llist"></div>
  `;
  pane.appendChild(lightPop);

  // ── Отдельное окно редактирования выбранного объекта ──
  const editWin = document.createElement('div');
  editWin.id = 'arena-edit';
  editWin.className = 'eedit';
  editWin.style.display = 'none';
  editWin.innerHTML = `
    <h5 id="ae-title">Объект</h5>
    <div id="ae-body"></div>
    <div class="ap-row" id="ae-group-row" style="display:none">
      <button id="ae-group" title="Скрепить выделенные (Shift+клик) объекты: дальше выделяются и двигаются как один">${bi('link')} Объединить</button>
      <button id="ae-ungroup" title="Развязать постоянную группу">${bi('unlink')} Разгруппировать</button>
    </div>
    <div class="ap-row">
      <button id="ae-dup" title="Дублировать объект (Ctrl+D)">${bi('copy')} Копия</button>
      <button id="ae-del">${bi('trash')} Удалить</button>
    </div>
  `;
  pane.appendChild(editWin);

  const $ap = (root, id) => root.querySelector('#' + id);
  const el = {
    title: $ap(panel, 'ap-title'), count: $ap(panel, 'ap-count'),
    add: $ap(panel, 'ap-add'), paint: $ap(panel, 'ap-paint'), save: $ap(panel, 'ap-save'),
    field: $ap(panel, 'ap-field'), route: $ap(panel, 'ap-route'),
    light: $ap(panel, 'ap-light'),
    texfile: $ap(panel, 'ap-texfile'),
    tool: $ap(paintPop, 'ap-tool'), color: $ap(paintPop, 'ap-color'),
    size: $ap(paintPop, 'ap-size'), sizeVal: $ap(paintPop, 'ap-size-val'), fill: $ap(paintPop, 'ap-fill'),
    img: $ap(paintPop, 'ap-img'), file: $ap(paintPop, 'ap-file'),
    saveall: $ap(savePop, 'ap-saveall'),
    export: $ap(savePop, 'ap-export'), import: $ap(savePop, 'ap-import'), json: $ap(savePop, 'ap-json'),
    fw: $ap(fieldPop, 'ap-fw'), fd: $ap(fieldPop, 'ap-fd'), fapply: $ap(fieldPop, 'ap-fapply'),
    fieldSize: $ap(fieldPop, 'ap-fieldsize'),
    cfloor: $ap(fieldPop, 'ap-cfloor'), cwall: $ap(fieldPop, 'ap-cwall'), cbg: $ap(fieldPop, 'ap-cbg'),
    creset: $ap(fieldPop, 'ap-creset'),
    clearpaint: $ap(fieldPop, 'ap-clearpaint'), clearprops: $ap(fieldPop, 'ap-clearprops'),
    rmode: $ap(routePop, 'ap-rmode'), rrst: $ap(routePop, 'ap-rrst'),
    rcpadd: $ap(routePop, 'ap-rcpadd'), rcpdel: $ap(routePop, 'ap-rcpdel'),
    rtime: $ap(routePop, 'ap-rtime'), rmax: $ap(routePop, 'ap-rmax'),
    rmaxlbl: $ap(routePop, 'ap-rmaxlbl'), rcpsRow: $ap(routePop, 'ap-rcps-row'), rcps: $ap(routePop, 'ap-rcps'),
    rfin: $ap(routePop, 'ap-rfin'), rsave: $ap(routePop, 'ap-rsave'),
    // Н22-6: точные координаты маршрута
    rsx: $ap(routePop, 'ap-rsx'), rsz: $ap(routePop, 'ap-rsz'), rsrot: $ap(routePop, 'ap-rsrot'),
    rfx: $ap(routePop, 'ap-rfx'), rfz: $ap(routePop, 'ap-rfz'),
    rex: $ap(routePop, 'ap-rex'), rez: $ap(routePop, 'ap-rez'),
    rcpsel: $ap(routePop, 'ap-rcpsel'), rcpx: $ap(routePop, 'ap-rcpx'), rcpz: $ap(routePop, 'ap-rcpz'),
    rstRow: $ap(routePop, 'ap-rst-row'), rstrotRow: $ap(routePop, 'ap-rstrot-row'),
    rfxRow: $ap(routePop, 'ap-rfx-row'), rexitRow: $ap(routePop, 'ap-rexit-row'),
    rcpRow: $ap(routePop, 'ap-rcp-row'), rcpxyzRow: $ap(routePop, 'ap-rcpxyz-row'),
    ladd: $ap(lightPop, 'ap-ladd'), llist: $ap(lightPop, 'ap-llist'),
    aeTitle: $ap(editWin, 'ae-title'), aeBody: $ap(editWin, 'ae-body'),
    aeDel: $ap(editWin, 'ae-del'), aeDup: $ap(editWin, 'ae-dup'),
    aeGroupRow: $ap(editWin, 'ae-group-row'), aeGroup: $ap(editWin, 'ae-group'), aeUngroup: $ap(editWin, 'ae-ungroup'),
  };

  let openFlag = false;      // редактор активен
  let paintOn = false;       // режим рисования (плашка 🖌)
  let paintTool = 'brush';   // brush | rect | circle | line | eraser | image
  let shapeDrag = false;     // тянем фигуру (превью на полу или на объекте)
  let shapeStart = null;     // точка начала фигуры {x,z}
  let shapeSnap = null;      // снимок пола перед тягой фигуры
  let shapeObj = null;       // фигура на объекте: { isProp, target, mesh, B }
  let shapeObjSt = null;     // { canvas, snap } — канвас объекта и снимок для превью
  let handles = [];          // handle'и препятствий текущей арены
  let handlesArena = null;
  let selected = -1;
  const selSet = new Set();  // Н9-2: группа выделенных (включая primary=selected) — Shift+клик
  let groupSnap = null;      // снимок позиций группы на время перетаскивания
  let gzGroup = null;        // то же для перетаскивания гизмо
  let clip = null;           // Н9-3: буфер обмена { props: [desc], origin: {x,z} }
  let stampMode = null;      // Н9-4: тип-ключ штампа («ставить много до ПКМ»)
  let lastMouse = null;      // Н9-3/8: последняя точка курсора на полу
  let rmbDown = null;        // Н9-4: {x,y} нажатия ПКМ — клик без драга выходит из штампа
  let ghostMesh = null;      // Н9-8: призрачный предпросмотр под курсором
  let pasteMode = false;     // Н12-4: призрачная вставка буфера (ставим кликами до ПКМ)
  let pasteGhost = null;     // Н12-4: призрак содержимого буфера под курсором
  let dragging = false;      // тащим объект
  let dragKind = 'xz';       // плоскость драга под камеру: 'xz' (сверху) | 'vert' (сбоку)
  let lockElev = 0;          // ПН10-4 → Н22-7: высота захвата больше не замораживает драг (поиск опоры живой)
  let lockAxis = null;       // ПН10-4: 'x'|'z' — горизонтальная ось, запертая вертикальной плоскостью
  let lockVal = 0;           // ПН10-4: её зафиксированное значение
  let painting = false;      // красим/стираем кистью
  const hPlane = new THREE.Plane(); // плоскость перетаскивания под камеру
  let stampImg = null;       // загруженная картинка
  let objPaintDirty = false; // красили по объекту — сохранить при отпускании
  let vDrag = false;         // Shift+тащить — подъём/спуск объекта
  const vPlane = new THREE.Plane();
  // ── Н20: undo/redo расстановки (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) ──
  // Н20-3: снапшот — { p: расстановка, a: краска }. Расстановка меняется через
  // save(), краска через savePaint()/loadFor — там и ловим диффы. Маршрут
  // (persistRoute) в откат по-прежнему не входит.
  let undoStack = [];
  let redoStack = [];
  let lastSer = null;        // сериализация расстановки на момент последнего save()/загрузки
  let lastPSer = null;       // сериализация краски; null — ещё не измеряли (лениво)
  let undoBatch = false;     // Н20-3: идёт составная операция — pushSnapshot молчит
  const UNDO_MAX = 40;       // глубина истории (~40 шагов — с запасом)
  let routeMode = false;     // правка маршрута: тащим маркеры старта/чекпоинтов
  let routeDrag = null;      // { kind: 'start'|'cp'|'exit', i }
  let gzDrag = false;        // тащим стрелку/кольцо гизмо
  let lastStroke = null;     // { handle|mesh, B } — конец прошлого мазка по объекту
  let lastFloor = null;      // { x, z } — конец прошлого мазка по полу
  let lastPaintH = null;     // объект, который красили последним (для фиксации tex)
  let openPop = null;        // открытое меню плашки

  const raycaster = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hitPoint = new THREE.Vector3();
  const off3 = new THREE.Vector3();

  function canvasEl() { return app.rig.renderer.domElement; }

  // ── Меню плашек ──
  // Поповеры и окно редактирования открываются ПОД панелью (просьба 7):
  // панель компактная, окно — на свободном месте вьюпорта под ней.
  function placeUnderPanel(elPop) {
    elPop.style.left = panel.offsetLeft + 'px';
    elPop.style.top = (panel.offsetTop + panel.offsetHeight + 8) + 'px';
  }
  function togglePop(elPop) {
    if (openPop === elPop) {
      closePop();
      if (elPop === addPop && stampMode) setStamp(null); // Н9-4: ➕ гасит штамп
      return;
    }
    closePop();
    // режимы-плашки взаимоисключающие (ПН9-5): открыли другую плашку —
    // рисование гаснет, иначе кисть «невидимо» оставалась активной
    if (paintOn && elPop !== paintPop) paintOn = false;
    if (stampMode && elPop !== addPop) setStamp(null); // Н9-4: другой режим гасит штамп
    hideAnimated(editWin); // окна не налезают друг на друга (просьба 6): поповер закрывает окно редактирования
    openPop = elPop;
    placeUnderPanel(elPop);
    showAnimated(elPop);
    syncPlateSel();
  }
  function closePop() {
    if (openPop) { hideAnimated(openPop); openPop = null; }
    syncPlateSel();
  }
  // Подсветка плашек (ПН9-5): горит плашка открытого поповера; 🖌 горит,
  // пока включено рисование, даже если окно закрыли крестиком.
  function syncPlateSel() {
    // Н9-4: в штампе ➕ горит даже с закрытым меню — индикатор режима
    el.add.classList.toggle('sel', openPop === addPop || !!stampMode);
    el.paint.classList.toggle('sel', paintOn || openPop === paintPop);
    el.save.classList.toggle('sel', openPop === savePop);
    el.field.classList.toggle('sel', openPop === fieldPop);
    el.route.classList.toggle('sel', openPop === routePop);
    el.light.classList.toggle('sel', openPop === lightPop);
  }

  // Кнопка ✕ на каждом поповере и окне редактирования (просьба 6): окно
  // всегда можно закрыть одним кликом, не ищя плашку-переключатель.
  function addCloseBtn(win, onClose) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pop-x';
    x.innerHTML = '<svg><use href="#i-close"/></svg>';
    x.title = 'Закрыть';
    x.addEventListener('click', (ev) => { ev.stopPropagation(); onClose(); });
    win.appendChild(x);
  }
  addCloseBtn(addPop, closePop);
  addCloseBtn(paintPop, () => { if (paintOn) el.paint.click(); else closePop(); });
  addCloseBtn(savePop, closePop);
  addCloseBtn(fieldPop, closePop);
  addCloseBtn(routePop, closePop);
  addCloseBtn(lightPop, closePop);
  addCloseBtn(editWin, () => setSelect(-1));

  // Н23-1: клик по любой кнопке меню сбрасывает выделение — окно
  // редактирования/гизмо не должны «висеть» над открытым поповером
  el.add.addEventListener('click', () => { setSelect(-1); togglePop(addPop); });
  el.paint.addEventListener('click', () => {
    paintOn = !paintOn;
    setSelect(-1); // Н23-1 (откат Н22-5): кнопки меню сбрасывают выделение
    if (paintOn) togglePop(paintPop);
    else closePop();
    syncPlateSel();
  });
  el.save.addEventListener('click', () => { setSelect(-1); togglePop(savePop); });
  el.field.addEventListener('click', () => { setSelect(-1); togglePop(fieldPop); });
  el.route.addEventListener('click', () => { setSelect(-1); togglePop(routePop); });
  el.light.addEventListener('click', () => { setSelect(-1); renderLightList(); togglePop(lightPop); });

  // видимость условных плашек. Н10-1: «📏 Поле» теперь на КАЖДОЙ арене —
  // внутри него очистка краски/объектов; Н29-3: размер поля тоже настраивается
  // на ЛЮБОЙ арене (трассы масштабируются под новый размер). 🚩 — арены с
  // судейским маршрутом (Н5: проверяем возможности судьи, а не имя арены).
  function syncPlates() {
    const a = app.arena;
    // Н19-5: судья есть у каждой арены (песочница — судья «Линии» с пустой
    // трассой), поэтому 🚩 Маршрут показываем везде
    const isRoute = !!a && !!a.judge;
    el.field.style.display = '';
    el.route.style.display = isRoute ? '' : 'none';
    el.light.style.display = ''; // Н29-2b: источники света доступны на любой арене
    $ap(panel, 'ap-extra-row').style.display = '';
    el.fieldSize.style.display = a ? '' : 'none'; // Н29-3: размер любой арены
    if (a) {
      el.fw.value = a.sizeW; el.fd.value = a.sizeD;
    }
    syncRulesUI();
    syncColorsUI(); // Н29-4: показать текущие цвета пола/бортов/фона
  }

  // клик по чипу типа — сразу добавить объект; перетаскивание чипа на пол
  // (просьба 7) — объект появится в точке отпускания. Н9-4: повторный клик
  // по чипу включает «штамп» — ЛКМ ставит копии до ПКМ/Esc. Н9-8: при драге
  // за курсором едет 3D-призрак объекта.
  addPop.querySelectorAll('.type-chip').forEach((btn) => {
    const tk = btn.dataset.t;
    btn.addEventListener('click', () => {
      if (ghostAteClick()) return;
      setSelect(-1); // Н23-1: выбор типа — тоже кнопка меню, выделение сбрасывается
      if (stampMode === tk) { setStamp(null); return; }
      setStamp(tk);
      // Н15-3: сам объект НЕ ставим — раньше копия появлялась в центре карты.
      // Клик только включает штамп: следующий ЛКМ по полу поставит объект туда,
      // куда пользователь показывает.
    });
    btn.addEventListener('pointerdown', (e) => startGhostDrag(e, PROP_TYPES[tk].label, (ev) => {
      // Н15-4: «вернул карточку обратно в окно» — отпускание над канвасом
      // обязательно, иначе ставился объект там, где пользователь его не хотел
      const at = document.elementFromPoint(ev.clientX, ev.clientY);
      if (at === canvasEl()) {
        const p = floorPoint(ev);
        if (p) addPropOfType(tk, { x: p.x, z: p.z });
      }
      setGhost(null); // драг закончен — 3D-призрак больше не нужен
    }, (ev) => {
      if (!ghostMesh || ghostMesh.userData.tk !== tk) setGhost(tk);
      moveGhost(ev);
    }));
  });

  // ── Н9-4: штамп-режим — «нажал на объект — ставь его много раз до ПКМ» ──
  function setStamp(tk) {
    stampMode = tk || null;
    addPop.querySelectorAll('.type-chip').forEach((b) => b.classList.toggle('sel', b.dataset.t === stampMode));
    syncPlateSel(); // Н9-4: плашка ➕ гаснет/горит вместе с режимом сразу
    if (stampMode) {
      setPaste(false); // Н12-4: штамп и вставка-буфер не работают одновременно
      status2('клик по полю — поставить, ПКМ или Esc — закончить');
    } else {
      // Н12-2: призрак обязан исчезнуть вместе со штампом — раньше после
      // ПКМ-выхода полупрозрачный объект оставался стоять на полу
      setGhost(null);
      status2('');
    }
  }

  // ── Н9-8: призрачный предпросмотр объекта под курсором ──
  function setGhost(tk) {
    if (ghostMesh) {
      app.rig.scene.remove(ghostMesh);
      ghostMesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      ghostMesh = null;
    }
    if (!tk) return;
    const t = PROP_TYPES[tk] || PROP_TYPES.crate;
    let geo;
    if (t.shape === 'ball') geo = new THREE.SphereGeometry(t.r, 16, 10);
    else if (t.shape === 'cyl') geo = new THREE.CylinderGeometry(t.r, t.r, t.hgt, 16);
    else if (t.shape === 'cone') geo = new THREE.CylinderGeometry(0, t.r, t.hgt, 16);
    else if (t.shape === 'wedge') geo = makeWedgeGeometry(t.sx, t.h, t.sz);
    else geo = new THREE.BoxGeometry(t.sx, t.h, t.sz);
    const half = t.shape === 'ball' ? t.r : (t.shape === 'cyl' || t.shape === 'cone') ? t.hgt / 2 : t.h / 2;
    const g = new THREE.Group();
    const gm = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: t.color, transparent: true, opacity: 0.45, depthWrite: false,
    }));
    gm.position.y = half;
    if (t.rotZ) gm.rotation.z = t.rotZ;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 20),
      new THREE.LineBasicMaterial({ color: 0x57a05a, transparent: true, opacity: 0.9 }),
    );
    gm.add(edges);
    g.add(gm);
    g.userData.tk = tk;
    g.visible = false;
    app.rig.scene.add(g);
    ghostMesh = g;
  }

  function moveGhost(e) {
    if (!ghostMesh) return;
    const p = e ? floorPoint(e) : null;
    ghostMesh.visible = !!p;
    if (p) {
      // Н28-2: призрак показывает будущую посадку — поднимается на опору под
      // курсором ровно там, где встанет сам предмет
      const t = PROP_TYPES[ghostMesh.userData.tk] || PROP_TYPES.crate;
      ghostMesh.position.set(p.x, supportUnder(p.x, p.z, t, null), p.z);
    }
  }

  // ── Н12-4: призрачная вставка из буфера — Ctrl+V показывает призрак
  // скопированного, клик ставит копию (сколько угодно раз), ПКМ/Esc — выход.
  function setPaste(on) {
    if (pasteGhost) {
      app.rig.scene.remove(pasteGhost);
      pasteGhost.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      pasteGhost = null;
    }
    pasteMode = !!on && !!clip;
    if (pasteMode) {
      setStamp(null); // вставка и штамп взаимоисключающие
      setSelect(-1); // Н23-1 (откат Н22-5)
      // призрак собираем из описаний буфера: каждый item — полупрозрачный силуэт.
      // Н28-2: предметы силуэта на СВОИХ высотах относительно низа копии —
      // при подъёме призрака на опору (movePasteGhost) он совпадает с тем,
      // что реально поставит pasteAt
      const nonHole = clip.items.filter((it) => !it.desc.hole);
      const minE = nonHole.length ? Math.min(...nonHole.map((it) => it.desc.elev || 0)) : 0;
      const g = new THREE.Group();
      for (const it of clip.items) {
        const d = it.desc;
        let geo;
        if (d.shape === 'ball') geo = new THREE.SphereGeometry(d.r, 16, 10);
        else if (d.shape === 'cyl') geo = new THREE.CylinderGeometry(d.r, d.r, d.hgt, 16);
        else if (d.shape === 'cone') geo = new THREE.CylinderGeometry(0, d.r, d.hgt, 16);
        else if (d.shape === 'wedge') geo = makeWedgeGeometry(d.sx, d.h, d.sz);
        else geo = new THREE.BoxGeometry(d.sx, d.h, d.sz);
        const half = d.shape === 'ball' ? d.r : (d.shape === 'cyl' || d.shape === 'cone') ? d.hgt / 2 : d.h / 2;
        const rel = (!d.hole || d.group) ? (d.elev || 0) - minE : 0; // дырка вне группы — вырез, не предмет
        const gm = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: d.hole ? 0xff8a2a : (d.color || 0x9aa2b1),
          transparent: true, opacity: d.hole ? 0.2 : 0.42, depthWrite: false,
        }));
        gm.position.set(it.dx, half + rel, it.dz);
        if (d.rotX || d.rotY || d.rotZ) gm.rotation.set(d.rotX || 0, d.rotY || 0, d.rotZ || 0);
        gm.add(new THREE.LineSegments(
          new THREE.EdgesGeometry(geo, 20),
          new THREE.LineBasicMaterial({ color: 0x57a05a, transparent: true, opacity: 0.9 }),
        ));
        g.add(gm);
      }
      g.visible = false;
      g.userData.pasteGhost = true; // маркер: призрак вставки в сцене
      app.rig.scene.add(g);
      pasteGhost = g;
      status2('клик — поставить копию, ПКМ или Esc — закончить');
    } else if (on && !clip) {
      status2('сначала скопируйте объект: Ctrl+C');
    }
  }

  function movePasteGhost(e) {
    if (!pasteGhost) return;
    const p = e ? floorPoint(e) : null;
    pasteGhost.visible = !!p;
    if (p) {
      // Н28-2: призрак вставки предсказывает посадку копии на опору —
      // тот же расчёт, что в pasteAt (максимум по предметам копии).
      // Низ копии (самый нижний предмет силуэта, rel=0) встаёт на sup:
      // дети уже подняты на half + (elev - minE), поэтому группа — на sup,
      // а не sup - minE (иначе призрак копии верхнего блока тонул в полу).
      const nonHole = clip.items.filter((it) => !it.desc.hole);
      let sup = 0;
      for (const it of nonHole) sup = Math.max(sup, supportUnder(p.x + it.dx, p.z + it.dz, it.desc, null));
      pasteGhost.position.set(p.x, sup, p.z);
    }
  }

  // поставить одну копию содержимого буфера в точку (клик в режиме вставки);
  // каждая постановка — новые общие id групп, чтобы копии не скреплялись
  // с оригиналом (Н10-2).
  // Н28-2: копия садится НА ОПОРУ под точкой вставки (пол или верх соседа —
  // те же лучи, что при переносе), а не висит на высоте оригинала: копия
  // верхнего блока стопки встаёт на пол/опору, стопка копируется стопкой
  // (взаимные высоты предметов сохраняются). Вклиниваться в стоящее копия
  // не может — место занято, вставки не будет.
  function pasteAt(x, z) {
    const a = app.arena;
    const nonHole = clip.items.filter((it) => !it.desc.hole);
    const minE = nonHole.length ? Math.min(...nonHole.map((it) => it.desc.elev || 0)) : 0;
    // опора: максимум по всем не-дырочным предметам копии — вся копия
    // ставится ЦЕЛИКОМ на самой высокой опоре под её следом
    let sup = 0;
    for (const it of nonHole) sup = Math.max(sup, supportUnder(x + it.dx, z + it.dz, it.desc, null));
    const delta = sup - minE;
    const gidMap = {};
    const added = [];
    for (const it of clip.items) {
      const desc = { ...it.desc };
      // дырка вне группы — вырез, а не предмет: высоту не трогаем (как в settleAt)
      if (!it.desc.hole || it.desc.group) desc.elev = (it.desc.elev || 0) + delta;
      if (desc.group) desc.group = gidMap[desc.group] || (gidMap[desc.group] = newGid());
      const nh = a.addProp({ ...desc, x: x + it.dx, z: z + it.dz });
      handles.push(nh);
      added.push(nh);
      if (it.tex) { nh.prop.tex = it.tex; a.restoreObjTexture(nh); }
    }
    if (pasteBlocked(added)) {
      for (let i = added.length - 1; i >= 0; i--) {
        a.removeProp(added[i]);
        const idx = handles.indexOf(added[i]);
        if (idx >= 0) handles.splice(idx, 1);
      }
      a.updateHolePhysics();
      status2('мешают существующие объекты — копия не вставлена');
      return;
    }
    a.updateHolePhysics();
    save();
    updCount();
    status2('вставлено: ' + clip.items.length + ' — ещё клик — ещё копия, ПКМ/Esc — выйти');
  }

  // Н28-2: пересекается ли хоть один из новых предметов со «старыми»
  // (дырки-вырезы не считаются помехой; соприкосновение вплотную — объём 0 —
  // разрешено: так копия встаёт на опору)
  function pasteBlocked(added) {
    const newSet = new Set(added);
    const boxes = [];
    for (const nh of added) {
      if (nh.prop.hole) continue;
      nh.mesh.updateMatrixWorld(true);
      boxes.push(new THREE.Box3().setFromObject(nh.mesh));
    }
    for (const bb of boxes) {
      for (const oh of handles) {
        if (newSet.has(oh) || oh.prop.hole) continue;
        oh.mesh.updateMatrixWorld(true);
        if (boxOverlapVol(bb, _nbB.setFromObject(oh.mesh)) > 1e-9) return true;
      }
    }
    return false;
  }

  function addPropOfType(typeKey, pos, quiet) {
    if (!app.arena) return;
    const t = PROP_TYPES[typeKey] || PROP_TYPES.crate;
    const a = app.arena;
    const base = typeof a.baseProps === 'function' ? a.baseProps() : [];
    const sp = a.startPose || { x: 0, z: 0 };
    // Н9-2: isRound для всех круглых форм — у конуса нет sx/sz, и старый
    // Math.max(undefined, undefined)/2 давал NaN: конус «не появлялся»
    const ext = isRound(t.shape) ? t.r : Math.max(t.sx || 0, t.sz || 0) / 2;
    const hit2 = (arr) => (bx, bz) => arr.some((b) =>
      Math.abs(b.x - bx) < (b.sx + (t.sx || t.r * 2)) / 2 + 0.02 &&
      Math.abs(b.z - bz) < (b.sz + (t.sz || t.r * 2)) / 2 + 0.02);
    const hitsCustom = hit2(handles.map((h) => h.prop));
    const hitsBase = hit2(base);
    let x = 0, z = 0;
    if (pos) {
      x = pos.x; z = pos.z; // дропнули на пол — ставим где отпустили
    } else for (let ring = 0; ring < 8; ring++) {
      const cand = [];
      if (ring === 0) cand.push([0, 0]);
      else for (let k = 0; k < ring * 6; k++) {
        const ang = (k / (ring * 6)) * Math.PI * 2;
        cand.push([Math.cos(ang) * ring * 0.35, Math.sin(ang) * ring * 0.35]);
      }
      const free = cand.find(([cx, cz]) =>
        !hitsCustom(cx, cz) && !hitsBase(cx, cz) && Math.hypot(sp.x - cx, sp.z - cz) > 0.3);
      if (free) { x = free[0]; z = free[1]; break; }
    }
    x = Math.max(-a.sizeW / 2 + ext, Math.min(a.sizeW / 2 - ext, x));
    z = Math.max(-a.sizeD / 2 + ext, Math.min(a.sizeD / 2 - ext, z));
    const nh = a.addProp({ shape: t.shape, x, z, sx: t.sx || t.r * 2, sz: t.sz || t.r * 2, h: t.h || t.r * 2, r: t.r || 0.05, hgt: t.hgt || t.h || 0.1, color: t.color, wall: t.wall, pinned: true, rotZ: t.rotZ || 0 });
    handles.push(nh);
    // Н28-2: штамп и бросок из палитры — те же правила, что у переноса:
    // предмет садится НА ОПОРУ под курсором (стопка — на вершину стопки),
    // а вклиниться в стоящее нельзя — место занято, предмета не будет.
    // Автоподбор свободного места (без pos) не трогаем — он сам ищет пустое.
    if (pos) {
      settleAt(nh, x, z);
      if (pasteBlocked([nh])) {
        a.removeProp(nh);
        handles.pop();
        a.updateHolePhysics();
        status2('мешает сосед — место занято');
        return;
      }
    }
    // Н26-1: объект, брошенный из палитры/штампа ВНУТРЬ дырки, должен сразу
    // получить вырез — для любых фигур, а не только боксов (шар/цилиндр/
    // конус/клин раньше не резались до следующего события)
    a.updateHolePhysics();
    if (quiet) {
      // Н9-4: штамп ставит копии молча — меню не закрываем, чип с подсветкой
      // показывает активный штамп
      save();
      updCount();
      return;
    }
    closePop();
    setSelect(handles.length - 1);
    save();
    updCount();
    status2(t.label + ' добавлен');
  }

  // ── Гизмо трансформации выбранного объекта ──
  const gizmo = new TransformGizmo(app.rig.camera, canvasEl());
  app.rig.scene.add(gizmo.root);

  function applyBodyFromMesh(h) {
    h.body.quaternion.setFromEuler(h.mesh.rotation.x, h.mesh.rotation.y, h.mesh.rotation.z);
    h.body.position.copy(h.mesh.position);
    // поворот дублируем в prop: resizeProp() пересоздаёт объект из prop-описания,
    // и без этого смена размера сбрасывала бы поворот в ноль
    h.prop.rotX = h.mesh.rotation.x;
    h.prop.rotY = h.mesh.rotation.y;
    h.prop.rotZ = h.mesh.rotation.z;
    if (h.body.wakeUp) h.body.wakeUp();
  }

  gizmo.cb = {
    onStart() {
      // Н9-2: при групповом переносе гизмо тащит всех выделенных.
      // Н19-1: снимок с высотами — члены едут жёстко, без «посадки на опору».
      const h = handles[selected];
      gzGroup = (h && selSet.size > 1)
        ? {
          base: { x: h.prop.x, z: h.prop.z, elev: h.prop.elev || 0 },
          members: [...selSet].filter((j) => j !== selected && handles[j])
            .map((j) => ({ h: handles[j], x: handles[j].prop.x, z: handles[j].prop.z, elev: handles[j].prop.elev || 0 })),
        }
        : null;
    },
    onChange(g) {
      const h = handles[selected];
      if (!h || !app.arena) return;
      const m = h.mesh;
      // тело — та же ориентация, что у меша (порядок XYZ совпадает с cannon);
      // поворот пишем и в prop, чтобы save()/resizeProp() не теряли его
      h.body.quaternion.setFromEuler(m.rotation.x, m.rotation.y, m.rotation.z);
      h.prop.rotX = m.rotation.x;
      h.prop.rotY = m.rotation.y;
      h.prop.rotZ = m.rotation.z;
      if (g.type === 'move' && (g.center || g.axis === 'x' || g.axis === 'z')) {
        settleAt(h, m.position.x, m.position.z); // лечь на опору под собой
        if (gzGroup) {
          const dx = h.prop.x - gzGroup.base.x, dz = h.prop.z - gzGroup.base.z;
          // Н19-1: члены группы — жёстко (forceElev, без поиска опоры): луч
          // вниз ловил пересекающегося соседа и «сгонял» объект с его точки
          const dE = (h.prop.elev || 0) - (gzGroup.base.elev || 0);
          for (const gm of gzGroup.members) settleAt(gm.h, gm.x + dx, gm.z + dz, gm.elev + dE);
        }
      } else {
        h.body.position.copy(m.position);
        // высота меняется и по Y тоже — помечаем prop, иначе save() запишет старую
        h.prop.elev = Math.max(0, m.position.y - app.arena._halfOf(h.prop));
        if (g.type === 'move' && g.axis === 'y') {
          h.prop.manualElev = true; // Н23-3: стрелка Y — ручная высота
        }
        if (h.body.wakeUp) h.body.wakeUp();
      }
      syncEditFields();
    },
    onEnd() { gzGroup = null; if (app.arena) app.arena.updateHolePhysics(); save(); }, // Н9-2: дырка переехала — пересчитать вырезы
  };

  // ── Н9-2: маркеры размера — третий режим по 2-му клику (D/G): перемещение →
  // поворот → размер. На гранях выбранного объекта появляются шарики-маркеры;
  // тянешь маркер — размер меняется с шагом 10 мм (превью масштабом меша,
  // после отпускания объект пересобирается с точными размерами).
  const SIZE_STEP = 0.01; // 10 мм
  const SIZE_MIN = 0.01, SIZE_MAX = 1.0; // те же границы, что в окне редактирования
  let editTool = 'move';     // move | rotate | size
  let sizeDrag = null;       // активный драг маркера
  const snap10 = (v) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(v / SIZE_STEP) * SIZE_STEP));
  // Н24-2: временные составляющие decompose() меша (позиция/поворот/масштаб)
  const _szP = new THREE.Vector3();
  const _szQ = new THREE.Quaternion();
  const _szS = new THREE.Vector3();

  const sizeRoot = new THREE.Group();
  sizeRoot.visible = false;
  app.rig.scene.add(sizeRoot);
  const sizeHandles = [];
  {
    const geo = new THREE.SphereGeometry(0.018, 10, 8);
    const mk = (axis, hex, sign) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: hex, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
      }));
      m.renderOrder = 998;
      m.userData.axis = axis;
      m.userData.sign = sign; // Н19-3: сторона маркера (+1 — «+ось», −1 — «−ось»)
      sizeRoot.add(m);
      sizeHandles.push(m);
    };
    mk('x', 0xe5484d, 1); mk('x', 0xe5484d, -1); // ±X
    mk('z', 0x4dabf7, 1); mk('z', 0x4dabf7, -1); // ±Z
    mk('y', 0x51cf66, 1);                        // +Y (верхняя грань)
    mk('y', 0xb197f2, -1);                       // Н19-3: −Y (ПОД объектом)
  }

  // половины габаритов объекта по осям (в метрах)
  function sizeHalfDims(p) {
    if (p.shape === 'ball') return { x: p.r, y: p.r, z: p.r };
    if (p.shape === 'cyl' || p.shape === 'cone') return { x: p.r, y: p.hgt / 2, z: p.r };
    return { x: (p.sx || 0.1) / 2, y: (p.h || 0.1) / 2, z: (p.sz || 0.1) / 2 };
  }

  function syncSizeHandles() {
    const h = handles[selected];
    if (!h || editTool !== 'size') { sizeRoot.visible = false; return; }
    const m = h.mesh;
    m.updateWorldMatrix(true, false);
    // Н24-2: прежний setFromRotationMatrix(m.matrixWorld) брал кватернион из
    // матрицы R·S — при scale ≠ 1 (во время драга размера) он искажался, и
    // маркеры кренились и слетали с граней. decompose() выделяет чистый
    // поворот корректно при любом масштабе.
    m.matrixWorld.decompose(_szP, _szQ, _szS);
    sizeRoot.position.copy(_szP);
    sizeRoot.quaternion.copy(_szQ);
    const hd = sizeHalfDims(h.prop);
    const ex = hd.x * m.scale.x, ey = hd.y * m.scale.y, ez = hd.z * m.scale.z;
    sizeHandles[0].position.set(ex, 0, 0);
    sizeHandles[1].position.set(-ex, 0, 0);
    sizeHandles[2].position.set(0, 0, ez);
    sizeHandles[3].position.set(0, 0, -ez);
    sizeHandles[4].position.set(0, ey, 0);
    sizeHandles[5].position.set(0, -ey, 0); // Н19-3: маркер под объектом
    // Н24-1: маркеры ВСЕГДА видимы — исчезновение оси вдоль взгляда
    // пользователь называл багом (Н19-3 прятал, Н22-2 ослаблял порог,
    // Н24-1 убрал прятание вовсе). Тянуть ось «на камеру» можно: драг
    // уходит на запасную плоскость ⊥ взгляда (в startSizeDrag).
    for (const sm of sizeHandles) sm.visible = true;
    sizeRoot.visible = true;
  }

  function sizeHit(e) {
    if (editTool !== 'size' || selected < 0 || !sizeRoot.visible) return null;
    sizeRoot.updateMatrixWorld(true);
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    // Raycaster в three не учитывает visible — скрытые оси фильтруем вручную
    const hits = raycaster.intersectObjects(sizeHandles.filter((m) => m.visible), false);
    return hits.length ? hits[0].object : null;
  }

  function startSizeDrag(e, hm) {
    const h = handles[selected];
    if (!h || !app.arena) return;
    const axis = hm.userData.axis;
    const sign = hm.userData.sign || 1;
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    const rd = raycaster.ray.direction;
    const axW = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0)
      .applyQuaternion(h.mesh.quaternion).normalize();
    const n = rd.clone().addScaledVector(axW, -rd.dot(axW));
    if (n.lengthSq() < 1e-8) {
      // Н24-1: ось почти вдоль взгляда — прежний отказ делал жест мёртвым.
      // Плоскость ⊥ взгляда через маркер: драг предсказуемо работает
      // с любого ракурса.
      n.copy(rd);
    }
    n.normalize();
    const hmW = hm.getWorldPosition(new THREE.Vector3());
    // Н19-3: якорь — ПРОТИВОПОЛОЖНАЯ грань: она остаётся на месте, объект
    // растягивается только в сторону маркера, центр уезжает вслед за ним
    const st = sizeHalfDims(h.prop);
    const halfW = (axis === 'x' ? st.x : axis === 'y' ? st.y : st.z) * h.mesh.scale[axis];
    const anchor = h.mesh.position.clone().addScaledVector(axW, -sign * halfW);
    // Н24-2: соседи на момент старта драга — с их «просветом» сравнивается
    // каждый кандидат размера. OBB (SAT), а не AABB: повёрнутый объект имеет
    // раздутый габаритный ящик, и запрет по нему блокировал бы рост в пустоте.
    h.mesh.updateMatrixWorld(true);
    const A0 = obbOf(h);
    const nbs = [];
    for (const oh of handles) {
      if (oh === h || oh.prop.hole) continue;
      if (selSet.has(handles.indexOf(oh))) continue;
      const gp = oh.prop.group, hp = h.prop.group;
      if (gp && hp && gp === hp) continue;
      const bothBall = oh.prop.shape === 'ball' && h.prop.shape === 'ball';
      const nb = {
        obb: bothBall ? null : obbOf(oh),
        c: bothBall ? oh.mesh.position.clone() : null,
        r: bothBall ? oh.prop.r * oh.mesh.scale.x : 0,
        g0: 0,
      };
      nb.g0 = bothBall
        ? A0.c.distanceTo(nb.c) - (A0.he[0] + nb.r) // A0.he[0] = радиус шара на старте
        : obbGap(A0, nb.obb);
      nbs.push(nb);
    }
    sizeDrag = {
      axis, sign, axW,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, hmW),
      start: st,
      anchor,
      nbs,
      goodHalf: Math.max(SIZE_MIN / 2, halfW),
    };
  }

  function moveSizeDrag(e) {
    if (!sizeDrag || selected < 0 || !app.arena) return;
    const h = handles[selected];
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    if (!raycaster.ray.intersectPlane(sizeDrag.plane, hitPoint)) return;
    // Н19-3: одностороннее растяжение от якоря (противоположная грань);
    // sign>0 — маркер на «+»-стороне, sign<0 — на «−»-стороне.
    // t — расстояние от якоря до курсора, т.е. ПОЛНЫЙ новый размер:
    // половина = t/2, тогда грань следует за курсором. Прежнее |t|*2/2
    // удваивало размер: грань улетала вдвое дальше курсора, а первый же
    // кадр драга удваивал объект (маркер стоит на текущей грани).
    const t = hitPoint.clone().sub(sizeDrag.anchor).dot(sizeDrag.axW) * sizeDrag.sign;
    let half = Math.max(SIZE_MIN / 2, snap10(Math.abs(t)) / 2);
    // Н24-2: кандидат применяется, затем сверяется с соседями — рост размера
    // останавливается у чужого тела (пересечение не растёт), уменьшение
    // всегда разрешено. Объект залипает на последнем «законном» размере.
    applySizeHalf(h, half);
    let blocked = false;
    if (sizeOverlapGrew(h)) {
      half = sizeDrag.goodHalf;
      applySizeHalf(h, half);
      blocked = true;
    } else {
      sizeDrag.goodHalf = half;
    }
    syncSizeHandles();
    status2((blocked ? 'мешает сосед — ' : '') + Math.round(half * 2 * 1000) + ' мм');
  }

  // Н24-2: применить кандидата-половину размера к мешу (превью до пересборки
  // в endSizeDrag). Тело бывших веток moveSizeDrag.
  function applySizeHalf(h, half) {
    const st = sizeDrag.start;
    const m = h.mesh;
    if (sizeDrag.axis === 'x') {
      m.scale.x = half / st.x;
      if (h.prop.shape === 'ball') m.scale.y = m.scale.z = m.scale.x; // шар — один размер
      else if (isRound(h.prop.shape)) m.scale.z = m.scale.x; // Ø меняет обе горизонтальные оси
      m.position.x = sizeDrag.anchor.x + sizeDrag.axW.x * half * sizeDrag.sign;
      m.position.z = sizeDrag.anchor.z + sizeDrag.axW.z * half * sizeDrag.sign;
    } else if (sizeDrag.axis === 'z') {
      m.scale.z = half / st.z;
      if (h.prop.shape === 'ball') m.scale.y = m.scale.x = m.scale.z;
      else if (isRound(h.prop.shape)) m.scale.x = m.scale.z;
      m.position.x = sizeDrag.anchor.x + sizeDrag.axW.x * half * sizeDrag.sign;
      m.position.z = sizeDrag.anchor.z + sizeDrag.axW.z * half * sizeDrag.sign;
    } else if (h.prop.shape === 'ball') {
      m.scale.y = half / st.y;
      m.scale.x = m.scale.z = m.scale.y; // шар — один размер
    } else {
      m.scale.y = half / st.y;
    }
    // центр по Y: маркер +Y держит НИЗ на месте (как раньше), маркер −Y
    // держит ВЕРХ (растяжение/сжатие от нижней грани); прочие оси — низ на опоре
    const hd = sizeHalfDims(h.prop);
    if (sizeDrag.axis === 'y') {
      m.position.y = sizeDrag.sign > 0
        ? sizeDrag.anchor.y + hd.y * m.scale.y
        : sizeDrag.anchor.y - hd.y * m.scale.y;
    } else {
      m.position.y = (h.prop.elev || 0) + hd.y * m.scale.y;
    }
  }

  // Н24-2: ориентированный бокс меша (центр, орты, половины габаритов с
  // масштабом) — точная геометрия повёрнутого объекта, без раздутого AABB.
  function obbOf(h) {
    const m = h.mesh;
    m.updateWorldMatrix(true, false);
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    const c = new THREE.Vector3(
      (bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2,
    ).applyMatrix4(m.matrixWorld);
    const ax = [], he = [];
    for (let i = 0; i < 3; i++) {
      const col = new THREE.Vector3().setFromMatrixColumn(m.matrixWorld, i);
      const len = col.length();
      ax.push(col.normalize());
      he.push(((i === 0 ? bb.max.x - bb.min.x : i === 1 ? bb.max.y - bb.min.y : bb.max.z - bb.min.z) / 2) * len);
    }
    return { c, ax, he };
  }

  // Н24-2: минимальный «просвет» двух ориентированных боксов по осям SAT.
  // > 0 — тела пересекаются (это глубина взаимопроникновения), < 0 —
  // разделены (модуль — нижняя оценка зазора). Монотонен по сближению:
  // рост значения = тела сблизились/влезли глубже.
  function obbGap(a, b) {
    const axes = [a.ax[0], a.ax[1], a.ax[2], b.ax[0], b.ax[1], b.ax[2]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const cr = new THREE.Vector3().crossVectors(a.ax[i], b.ax[j]);
        if (cr.lengthSq() > 1e-10) axes.push(cr.normalize());
      }
    }
    const d = new THREE.Vector3().subVectors(b.c, a.c);
    let min = Infinity;
    for (const L of axes) {
      let ra = 0, rb = 0;
      for (let i = 0; i < 3; i++) {
        ra += Math.abs(a.ax[i].dot(L)) * a.he[i];
        rb += Math.abs(b.ax[i].dot(L)) * b.he[i];
      }
      const gp = ra + rb - Math.abs(d.dot(L));
      if (gp < min) min = gp;
    }
    return min;
  }

  // Н24-2: сблизился ли ТЕКУЩИЙ кандидат размера с соседями относительно
  // старта драга (просвет уменьшился). Дырки (пересекаются с целями по
  // задумке), «игнор. коллизии», выделенная группа и своя группа — не в счёт.
  // Шар-к-шару — точная сфера-сфера (куб-прокси OBB шара слишком грубый).
  function sizeOverlapGrew(h) {
    const A = obbOf(h);
    // Н28-3: eps — допуск касания (миллиметровый зазор/пенетрация физики не
    // считаются пересечением). Раньше блокировалось ЛЮБОЕ увеличение
    // минимального зазора: одностороннее растяжение двигает ЦЕНТР к маркеру,
    // зазоры по всем осям с компонентой к соседу растут (становятся менее
    // отрицательными) — рост запрещался даже без настоящего пересечения
    // («нет пересечений, но не даёт менять»). Теперь: сосед УЖЕ пересекался
    // на старте (g0 > eps) — запрещаем только углубление (сжаться наружу
    // можно); иначе — только настоящее новое пересечение (g > eps).
    // Уменьшение зазора ниже лимита не блокируется никогда.
    const eps = 0.002;
    for (const nb of sizeDrag.nbs) {
      const g = nb.obb
        ? obbGap(A, nb.obb)
        : A.c.distanceTo(nb.c) - (A.he[0] + nb.r);
      if (g > (nb.g0 > eps ? nb.g0 + 1e-7 : eps)) return true;
    }
    return false;
  }

  function endSizeDrag() {
    if (!sizeDrag) return;
    const drag = sizeDrag;
    sizeDrag = null;
    if (selected < 0 || !app.arena) return;
    const h = handles[selected];
    const st = drag.start;
    const m = h.mesh;
    let dims;
    if (h.prop.shape === 'ball') {
      dims = { r: snap10(st.x * m.scale.x * 2) / 2 };
    } else if (isRound(h.prop.shape)) {
      dims = { r: snap10(st.x * m.scale.x * 2) / 2, hgt: snap10(st.y * m.scale.y * 2) };
    } else {
      dims = { sx: snap10(st.x * m.scale.x * 2), sz: snap10(st.z * m.scale.z * 2), h: snap10(st.y * m.scale.y * 2) };
    }
    const p = h.prop;
    // Н19-3: превью сдвинуло центр — переносим сдвиг в prop до пересборки
    if (drag.axis === 'x' || drag.axis === 'z') {
      p.x = m.position.x;
      p.z = m.position.z;
    } else if (drag.sign < 0) {
      // маркер под объектом: верхняя грань была якорем, низ уехал
      const hgt = h.prop.shape === 'ball' ? dims.r * 2
        : isRound(h.prop.shape) ? dims.hgt : dims.h;
      p.elev = Math.max(0, drag.anchor.y - hgt);
    }
    handles[selected] = app.arena.resizeProp(h, dims); // точная пересборка
    settleAt(handles[selected], handles[selected].prop.x, handles[selected].prop.z);
    app.arena.updateHolePhysics();
    reattachGizmo(); // Н16-1: меш пересоздан — гизмо на новый
    syncSizeHandles();
    renderEdit();
    save();
    updCount();
  }

  // Н14-3: двойной клик циклит режимы: перенос → кольца поворота → маркеры
  // размера → снова перенос.
  const TOOL_CYCLE = ['move', 'rotate', 'size'];
  // Н16-1/Н16-3: resizeProp() и переключение «дырки» пересоздают меш —
  // перевешиваем гизмо на новый. Н18-1: гизмо нужен и НЕсгруппированной
  // дырке (её снова можно двигать); сгруппированная — только с группой.
  function reattachGizmo() {
    const h = selected >= 0 ? handles[selected] : null;
    if (h && !(h.prop.hole && h.prop.group) && (editTool === 'move' || editTool === 'rotate')) {
      gizmo.attach(h.mesh);
      gizmo.setMode(editTool);
    } else {
      gizmo.detach();
    }
  }
  function cycleEditTool() {
    editTool = TOOL_CYCLE[(TOOL_CYCLE.indexOf(editTool) + 1) % TOOL_CYCLE.length];
    sizeRoot.visible = editTool === 'size';
    const ch = selected >= 0 ? handles[selected] : null;
    if (ch && !(ch.prop.hole && ch.prop.group)) { // Н18-1: см. reattachGizmo
      if (editTool === 'rotate') {
        gizmo.attach(ch.mesh);
        gizmo.setMode('rotate'); // только кольца, стрелок нет
      } else if (editTool === 'move') {
        // Н16-1: в режиме переноса снова видны стрелки (Н12-1 их убирал):
        // объект можно тащить мышкой за тело ИЛИ тянуть стрелками по осям
        gizmo.attach(ch.mesh);
        gizmo.setMode('move');
      } else {
        gizmo.detach(); // размер: маркеры на гранях, гизмо не нужно
      }
    } else {
      gizmo.detach();
    }
    syncSizeHandles();
    status2(editTool === 'size' ? 'маркеры размера: тяните, шаг 10 мм'
      : editTool === 'rotate' ? 'кольца поворота: тяните кольцо или Q/E' : '');
    return true;
  }

  // Н28-2: высота опоры под точкой (wx, wz) для предмета с габаритами p —
  // те же лучи по контуру, что в settleAt (пол + все предметы, кроме
  // skipHandle и дырок). Нужна вставке копий, штампу и призракам-превью.
  function supportUnder(wx, wz, p, skipHandle) {
    const a = app.arena;
    const ext = isRound(p.shape) ? p.r : Math.max(p.sx || 0, p.sz || 0) / 2;
    wx = Math.max(-a.sizeW / 2 + ext, Math.min(a.sizeW / 2 - ext, wx));
    wz = Math.max(-a.sizeD / 2 + ext, Math.min(a.sizeD / 2 - ext, wz));
    let topY = 0.8;
    for (const oh of handles) {
      if (oh === skipHandle || oh.prop.hole) continue;
      topY = Math.max(topY, oh.mesh.position.y + a._halfOf(oh.prop) + 0.5);
    }
    const targets = a._floorMesh ? [a._floorMesh] : [];
    for (const oh of handles) if (oh !== skipHandle && !oh.prop.hole) targets.push(oh.mesh);
    const kx = isRound(p.shape) ? 0 : (p.sx || 0) / 2 * 0.92;
    const kz = isRound(p.shape) ? 0 : (p.sz || 0) / 2 * 0.92;
    const kr = isRound(p.shape) ? ext * 0.92 : 0;
    const probes = [[0, 0]];
    if (isRound(p.shape)) {
      for (let i = 0; i < 8; i++) {
        const an = (Math.PI / 4) * i;
        probes.push([Math.cos(an) * kr, Math.sin(an) * kr]);
      }
    } else {
      probes.push([kx, kz], [-kx, kz], [kx, -kz], [-kx, -kz],
        [kx, 0], [-kx, 0], [0, kz], [0, -kz]);
    }
    let elev = 0;
    for (const [ox, oz] of probes) {
      raycaster.set(new THREE.Vector3(wx + ox, topY, wz + oz), new THREE.Vector3(0, -1, 0));
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length) elev = Math.max(elev, Math.max(0, hits[0].point.y));
    }
    return elev;
  }

  // Поставить объект на опору: пучок лучей вниз по КОНТУРУ опоры (центр +
  // углы/стороны или точки окружности) — по полу и другим объектам (кроме
  // самого объекта). Берём максимум: объект поднимается, как только ЛЮБАЯ
  // точка опоры коснулась соседа — раньше один центр-луч давал наезд углом
  // на стопку до подъёма (Н23-3). forceElev (вертикальный драг при боковой
  // камере) — высота от курсора, без поиска опоры.
  function settleAt(h, wx, wz, forceElev) {
    const a = app.arena;
    const p = h.prop;
    const ext = isRound(p.shape) ? p.r : Math.max(p.sx || 0, p.sz || 0) / 2;
    wx = Math.max(-a.sizeW / 2 + ext, Math.min(a.sizeW / 2 - ext, wx));
    wz = Math.max(-a.sizeD / 2 + ext, Math.min(a.sizeD / 2 - ext, wz));
    if (forceElev !== undefined) {
      p.manualElev = true; // Н23-3: высота задана вручную (вертикальный драг)
      a.moveProp(h, wx, wz, Math.max(0, forceElev));
      return;
    }
    // Н18-2: дырка — объём-вырез, а не предмет: пересадка «на опору» (луч
    // вниз ловит пол или пересекаемый объект) роняла вырез на пол или
    // взгромождала его НА стену — проём уезжал при переносе группы.
    // Держим текущую высоту низа, двигаем только по X/Z.
    if (p.hole) {
      a.moveProp(h, wx, wz, Math.max(0, h.mesh.position.y - a._halfOf(p)));
      return;
    }
    const m = h.mesh;
    // Н28-2: поиск опоры вынесен в supportUnder (общий со вставкой копий,
    // штампом и призраками). Луч стартует над всеми объектами, лучи — по
    // КОНТУРУ опоры: угол, заехавший на стопку, поднимает объект сразу (Н22-7,
    // Н23-3), без наезда и перекрытия.
    const elev = supportUnder(wx, wz, p, h);
    // Пользователь поднял объект по Y — перенос по X/Z (стрелками или мышью)
    // сохраняет высоту, а не роняет её на опору. «Висим в воздухе» = зазор
    // между текущим низом и опорой больше 3 см (шум физики/джиттер меньше).
    // Н23-3: объект, ехавший ПО ОПОРЕ (manualElev не выставлен), СПУСКАЕТСЯ
    // на новую опору, когда прежняя ушла из-под него («поднялся и не
    // спускается» — больше не повторяется). Флаг снимается, как только
    // объект стоит на опоре — дальше он снова едет по ней вверх И вниз.
    const bottom = m.position.y - a._halfOf(p);
    if (bottom > elev + 0.03) {
      if (p.manualElev) elev = bottom; // ручная высота — висим в воздухе
      // иначе: elev уже = новой опоре под новым местом — спуск
    } else {
      p.manualElev = false; // стоит на опоре — едет по ней
    }
    a.moveProp(h, wx, wz, elev);
  }

  function screenToNdc(e) {
    const r = canvasEl().getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  // точка на полу под курсором (или null)
  function floorPoint(e) {
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    return raycaster.ray.intersectPlane(floorPlane, hitPoint) ? hitPoint : null;
  }
  // индекс пользовательского объекта под курсором
  function pickProp(e) {
    if (!handles.length) return -1;
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    const meshes = handles.map((h) => h.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    // Н16-3/Н18-1: сгруппированная дырка — невидимый резак, клики проходят
    // сквозь неё к объектам за ней; НЕсгруппированная видима и кликабельна.
    const hit = hits.find((ht) => {
      const i = meshes.indexOf(ht.object);
      return i >= 0 && handles[i] && !(handles[i].prop.hole && handles[i].prop.group);
    });
    if (!hit) return -1;
    return meshes.indexOf(hit.object);
  }

  // ── Окно редактирования выбранного объекта ──
  // max — потолок размера в мм (ПН9-4: до 1000×1000×1000)
  const numRow = (label, f, v, step = 1, w = 62, max = null) =>
    `<div class="num-row"><span class="lb">${label}</span><input type="number" data-f="${f}" value="${v}" step="${step}"${max !== null ? ` max="${max}"` : ''} style="width:${w}px"></div>`;

  // ── Н10-2: постоянные группы (объединение объектов) ──
  // prop.group — общий id у членов группы. Отличается от временного Shift-
  // выделения (selSet): группа переживает снятие выделения и перезагрузку.
  let groupSeq = 0;
  const newGid = () => 'g' + Date.now().toString(36) + '_' + (++groupSeq);
  function groupMembersOf(gid) {
    const out = [];
    for (let j = 0; j < handles.length; j++) if (handles[j] && handles[j].prop.group === gid) out.push(j);
    return out;
  }
  // Показать «Объединить» (выбрано ≥2 и это ещё не одна целая группа) или
  // «Разгруппировать» (выбран член постоянной группы из ≥2 объектов)
  function groupBtnsSync() {
    const selIdx = [...selSet].filter((j) => handles[j]);
    const gid = selected >= 0 && handles[selected] ? handles[selected].prop.group : null;
    const members = gid ? groupMembersOf(gid) : [];
    const allOneGroup = !!gid && selIdx.length === members.length && members.every((j) => selSet.has(j));
    const canGroup = selIdx.length >= 2 && !allOneGroup;
    const canUngroup = !!(gid && members.length >= 2);
    el.aeGroup.style.display = canGroup ? '' : 'none';
    el.aeUngroup.style.display = canUngroup ? '' : 'none';
    el.aeGroupRow.style.display = (canGroup || canUngroup) ? '' : 'none';
  }
  el.aeGroup.addEventListener('click', () => {
    const idxs = [...selSet].filter((j) => handles[j]);
    if (idxs.length < 2) return;
    const gid = newGid();
    for (const j of idxs) handles[j].prop.group = gid; // Н13-2: призрак дырки больше не прячем
    if (app.arena) app.arena.syncCutStencil(); // Н18-1: дырка группы — невидимый резак
    save();
    renderEdit();
    status2('объединено: ' + idxs.length + ' — клик по любому выделяет всю группу');
  });
  el.aeUngroup.addEventListener('click', () => {
    if (selected < 0 || !handles[selected]) return;
    const gid = handles[selected].prop.group;
    if (!gid) return;
    const members = groupMembersOf(gid);
    for (const j of members) delete handles[j].prop.group;
    if (app.arena) app.arena.syncCutStencil(); // Н18-1: разгруппированная дырка снова видима
    save();
    renderEdit();
    status2('группа разобрана');
  });

  // ── Н11-1: рамка-выделение области ──
  // ЛКМ-драг по пустому месту рисует прямоугольник; при отпускании выбираются
  // все объекты, чья проекция на экран попала в рамку (члены групп подтягивают
  // всю группу; Shift — добавить к уже выделенному).
  const mqDiv = document.createElement('div');
  mqDiv.id = 'ae-marquee';
  mqDiv.style.cssText = 'position:absolute;display:none;z-index:55;border:1px dashed #9fd48a;'
    + 'background:rgba(120,200,120,.12);pointer-events:none;border-radius:2px;';
  pane.appendChild(mqDiv);
  let mqStart = null; // client-координаты угла рамки
  let mqAdd = false;  // Shift: не заменять, а дополнять выделение
  let mqOn = false;   // рамка активна (кнопка зажата)

  function mqShow(x0, y0, x1, y1) {
    const r = pane.getBoundingClientRect();
    mqDiv.style.display = 'block';
    mqDiv.style.left = (Math.min(x0, x1) - r.left) + 'px';
    mqDiv.style.top = (Math.min(y0, y1) - r.top) + 'px';
    mqDiv.style.width = Math.abs(x1 - x0) + 'px';
    mqDiv.style.height = Math.abs(y1 - y0) + 'px';
  }

  // индексы объектов, чей экранного вида бокс пересекает рамку (client-коорд.)
  function marqueePick(x0, y0, x1, y1) {
    const cam = app.rig.camera;
    const cv = canvasEl();
    const cr = cv.getBoundingClientRect();
    const w = cv.clientWidth, h = cv.clientHeight;
    const V3 = app.rig.scene.position.constructor;
    const v = new V3();
    const bx = new THREE.Box3();
    const rx0 = Math.min(x0, x1), rx1 = Math.max(x0, x1);
    const ry0 = Math.min(y0, y1), ry1 = Math.max(y0, y1);
    const hit = [];
    for (let j = 0; j < handles.length; j++) {
      if (handles[j].prop.hole && handles[j].prop.group) continue; // Н18-1: невидимую дырку группы рамка не ловит; несгруппированная видима
      bx.setFromObject(handles[j].mesh);
      if (bx.isEmpty()) continue;
      let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
      for (let ci = 0; ci < 8; ci++) {
        v.set((ci & 1) ? bx.max.x : bx.min.x, (ci & 2) ? bx.max.y : bx.min.y, (ci & 4) ? bx.max.z : bx.min.z).project(cam);
        const sx = cr.left + (v.x * 0.5 + 0.5) * w;
        const sy = cr.top + (-v.y * 0.5 + 0.5) * h;
        if (sx < mnx) mnx = sx;
        if (sx > mxx) mxx = sx;
        if (sy < mny) mny = sy;
        if (sy > mxy) mxy = sy;
      }
      if (mxx >= rx0 && mnx <= rx1 && mxy >= ry0 && mny <= ry1) hit.push(j);
    }
    return hit;
  }

  function marqueeApply(idxs, additive) {
    const next = additive ? new Set([...selSet].filter((j) => handles[j])) : new Set();
    for (const j of idxs) {
      next.add(j);
      const gid = handles[j].prop.group;
      if (gid) for (const gm of groupMembersOf(gid)) next.add(gm);
    }
    for (const j of selSet) if (handles[j]) handles[j].mesh.material.emissive.setHex(0x000000);
    selSet.clear();
    for (const j of next) {
      selSet.add(j);
      if (handles[j]) handles[j].mesh.material.emissive.setHex(0x2a3a2a);
    }
    selected = next.size ? [...next].pop() : -1;
    if (selected >= 0) {
      closePop();
      editTool = 'move';
      sizeRoot.visible = false;
      // Н16-1: у нового выделения сразу стрелки перемещения
      const mh = handles[selected];
      if (mh && !(mh.prop.hole && mh.prop.group)) { gizmo.attach(mh.mesh); gizmo.setMode('move'); } // Н18-1
      else gizmo.detach();
    } else {
      gizmo.detach();
    }
    renderEdit();
    if (next.size > 1) status2('выбрано: ' + next.size + ' — «Объединить» скрепит их в группу');
  }

  function setSelect(i, additive) {
    const prev = selected;
    // снять подсветку со всех, кто уйдёт из выделения
    for (const j of selSet) if (handles[j] && j !== i) handles[j].mesh.material.emissive.setHex(0x000000);
    if (selected >= 0 && handles[selected] && !selSet.has(selected)) handles[selected].mesh.material.emissive.setHex(0x000000);
    if (additive && i >= 0) {
      // Н9-2: Shift+клик — добавить/убрать из группы; клик по уже выбранному
      // (primary) ничего не снимает, клик по члену группы убирает его
      if (selSet.has(i) && i !== selected) selSet.delete(i);
      else { selSet.add(i); selected = i; }
    } else {
      selSet.clear();
      if (i >= 0) {
        selSet.add(i);
        // Н10-2: клик по члену постоянной группы выделяет всю группу
        const gid = handles[i].prop.group;
        if (gid) for (const j of groupMembersOf(gid)) selSet.add(j);
      }
      selected = i;
    }
    for (const j of selSet) if (handles[j]) handles[j].mesh.material.emissive.setHex(0x2a3a2a);
    if (selected >= 0) {
      closePop();
      // Н14-3: сброс режима заодно убирает кольца поворота, включённые
      // двойным кликом. Н15-1: сброс — только при СМЕНЕ выбора: реальный
      // двойной клик шлёт down-up-down-up и dblclick, и без этого условия
      // второй pointerdown сбрасывал режим на «перенос», после чего dblclick
      // всегда включал только кольца поворота — до размера дойти было нельзя.
      // Н16-1: в «переносе» у объекта сразу видны стрелки гизмо.
      if (i !== prev) {
        editTool = 'move';
        sizeRoot.visible = false;
        const mh = handles[selected];
        if (mh && !(mh.prop.hole && mh.prop.group)) { gizmo.attach(mh.mesh); gizmo.setMode('move'); } // Н18-1
        else gizmo.detach();
      }
    } else {
      gizmo.detach();
    }
    renderEdit();
  }

  function renderEdit() {
    if (selected < 0 || !handles[selected]) {
      el.aeDel.disabled = true;
      hideAnimated(editWin);
      return;
    }
    const h = handles[selected];
    const p = h.prop;
    const gid = p.group ? groupMembersOf(p.group) : [];
    // Н12-3: выбрано несколько объектов — редактируем только ОБЩИЕ черты
    // (размеры и цвет у одинаковых), позицию не трогаем: у каждого своя
    if (selSet.size > 1) {
      const members = [...selSet].filter((j) => handles[j]);
      const sameShape = members.every((j) => handles[j].prop.shape === p.shape);
      el.aeTitle.textContent = sameShape
        ? (SHAPE_NAME[p.shape] || 'Объект') + ' · ' + members.length + ' шт'
        : 'Разные объекты · ' + members.length + ' шт';
      let mhtml = '';
      if (sameShape) {
        const mm = (v) => Math.round(v * 1000);
        if (p.shape === 'box' || p.shape === 'wedge') {
          mhtml += numRow('Ширина, мм', 'sx', mm(p.sx), 5, 62, 1000);
          mhtml += numRow('Глубина, мм', 'sz', mm(p.sz), 5, 62, 1000);
          mhtml += numRow('Высота, мм', 'h', mm(p.h), 5, 62, 1000);
        } else if (p.shape === 'ball') {
          mhtml += numRow('⌀, мм', 'dia', mm(p.r * 2), 5, 62, 1000);
        } else { // cyl / cone
          mhtml += numRow('⌀, мм', 'dia', mm(p.r * 2), 5, 62, 1000);
          mhtml += numRow('Высота, мм', 'hgt', mm(p.hgt), 5, 62, 1000);
        }
        mhtml += `<div class="num-row"><span class="lb">Цвет</span><input type="color" data-f="color" value="#${(p.color || 0x888888).toString(16).padStart(6, '0')}" style="width:40px;height:26px;padding:0"></div>`;
        mhtml += `<div class="num-row"><span class="lb">Закреплено</span><input type="checkbox" data-f="pinned" ${p.pinned ? 'checked' : ''}></div>`;
        mhtml += '<div class="ap-hint">правки применятся ко всем выбранным; позиция у каждого своя</div>';
      } else {
        mhtml += '<div class="ap-hint">типы различаются — общих размеров нет</div>';
      }
      el.aeBody.innerHTML = mhtml;
      el.aeDel.disabled = false;
      closePop();
      placeUnderPanel(editWin);
      showAnimated(editWin);
      groupBtnsSync();
      el.aeBody.querySelectorAll('input, select').forEach((inp) => {
        inp.addEventListener('change', () => editField(inp.dataset.f, inp.type === 'checkbox' ? inp.checked : inp.value));
      });
      return;
    }
    el.aeTitle.textContent = (SHAPE_NAME[p.shape] || 'Объект')
      + (gid.length >= 2 ? ' · группа ' + gid.length : '');
    let html = '';
    // XYZ относительно центра арены (просьба 9) — в миллиметрах
    html += numRow('X, мм', 'x', Math.round(p.x * 1000), 5);
    html += numRow('Z, мм', 'z', Math.round(p.z * 1000), 5);
    html += numRow('Низ (Y), мм', 'elev', Math.round((p.elev || 0) * 1000), 5);
    // повороты числами (просьба 10)
    html += `<div class="num-row"><span class="lb">Поворот ° (X·Y·Z)</span>
      <input type="number" data-f="rotX" value="${+(h.mesh.rotation.x * R2D).toFixed(0)}" step="5" style="width:48px">
      <input type="number" data-f="rotY" value="${+(h.mesh.rotation.y * R2D).toFixed(0)}" step="5" style="width:48px">
      <input type="number" data-f="rotZ" value="${+(h.mesh.rotation.z * R2D).toFixed(0)}" step="5" style="width:48px"></div>`;
    // размеры
    const mm = (v) => Math.round(v * 1000);
    if (p.shape === 'box') {
      html += numRow('Ширина, мм', 'sx', mm(p.sx), 5, 62, 1000);
      html += numRow('Глубина, мм', 'sz', mm(p.sz), 5, 62, 1000);
      html += numRow('Высота, мм', 'h', mm(p.h), 5, 62, 1000);
    } else if (p.shape === 'ball') {
      html += numRow('⌀, мм', 'dia', mm(p.r * 2), 5, 62, 1000);
    } else { // cyl / cone
      html += numRow('⌀, мм', 'dia', mm(p.r * 2), 5, 62, 1000);
      html += numRow('Высота, мм', 'hgt', mm(p.hgt), 5, 62, 1000);
    }
    html += `<div class="num-row"><span class="lb">Цвет</span><input type="color" data-f="color" value="#${(p.color || 0x888888).toString(16).padStart(6, '0')}" style="width:40px;height:26px;padding:0"></div>`;
    html += `<div class="num-row"><span class="lb">Закреплено</span><input type="checkbox" data-f="pinned" ${p.pinned ? 'checked' : ''}></div>`;
    // Н9-2: «дырка» — объём-вырез: сквозь пересекаемые объекты появляется проём
    html += `<div class="num-row"><span class="lb">Дырка (вырез)</span><input type="checkbox" data-f="hole" ${p.hole ? 'checked' : ''} title="Объект становится вырезом: в пересечённых им объектах появляется сквозной проём"></div>`;
    html += `<div class="ap-row">
      <button id="ae-tex">${bi('image')} Текстура…</button>
      <button id="ae-texoff" ${p.tex ? '' : 'disabled'}>${bi('reset')} Сбросить</button>
    </div>`;
    el.aeBody.innerHTML = html;
    // Н18-1 (частичный откат Н17-1): у НЕсгруппированной дырки поля позиции
    // и поворота активны — её можно двигать. Сгруппированная — блокированы
    // (двигается только с группой); размер/цвет/сброс доступны обеим.
    if (p.hole && p.group) el.aeBody.querySelectorAll('input[data-f="x"],input[data-f="z"],input[data-f="elev"],input[data-f="rotX"],input[data-f="rotY"],input[data-f="rotZ"]').forEach((inp) => { inp.disabled = true; });
    el.aeDel.disabled = false;
    closePop(); // окно редактирования закрывает поповер — не налезают друг на друга
    placeUnderPanel(editWin);
    showAnimated(editWin);
    groupBtnsSync(); // Н10-2: показываем «Объединить»/«Разгруппировать» по ситуации
    el.aeBody.querySelectorAll('input, select').forEach((inp) => {
      inp.addEventListener('change', () => editField(inp.dataset.f, inp.type === 'checkbox' ? inp.checked : inp.value));
    });
    const texBtn = el.aeBody.querySelector('#ae-tex');
    const texOffBtn = el.aeBody.querySelector('#ae-texoff');
    if (texBtn) texBtn.addEventListener('click', () => el.texfile.click());
    if (texOffBtn) texOffBtn.addEventListener('click', () => {
      if (selected < 0 || !app.arena) return;
      app.arena.clearObjTexture(handles[selected]);
      renderEdit();
      save();
    });
  }

  // обновить числа в открытом окне (после стрелок/гизмо) — без пересоздания
  function syncEditFields() {
    if (selected < 0 || editWin.style.display === 'none') return;
    const h = handles[selected];
    if (!h) return;
    const p = h.prop;
    const setV = (f, v) => {
      const inp = el.aeBody.querySelector(`input[data-f="${f}"]`);
      if (inp && document.activeElement !== inp) inp.value = v;
    };
    setV('x', Math.round(p.x * 1000));
    setV('z', Math.round(p.z * 1000));
    setV('elev', Math.round((p.elev || 0) * 1000));
    setV('rotX', +(h.mesh.rotation.x * R2D).toFixed(0));
    setV('rotY', +(h.mesh.rotation.y * R2D).toFixed(0));
    setV('rotZ', +(h.mesh.rotation.z * R2D).toFixed(0));
  }

  // запись поля из окна редактирования
  function editField(f, v) {
    if (selected < 0 || !app.arena) return;
    const num = (def, a, b) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : def;
    };
    // Н12-3: мульти-правка — размер/цвет/закрепление применяются ко ВСЕМ
    // выбранным; позицию и поворот в мульти-режиме не меняем
    if (selSet.size > 1) {
      const members = [...selSet].filter((j) => handles[j]);
      if (f === 'color') {
        for (const j of members) app.arena.setObjColor(handles[j], parseInt(v.slice(1), 16));
      } else if (f === 'pinned') {
        for (const j of members) app.arena.setPinned(handles[j], !!v);
      } else if (f === 'sx' || f === 'sz' || f === 'h' || f === 'dia' || f === 'hgt') {
        const m = num(10, 10, 1000) / 1000; // ПН9-4: объекты до 1000 мм
        const p0 = handles[selected].prop;
        const dims = (p0.shape === 'box' || p0.shape === 'wedge')
          ? (f === 'sx' ? { sx: m } : f === 'sz' ? { sz: m } : { h: m })
          : (f === 'dia' ? { r: m / 2 } : { hgt: m });
        for (const j of members) {
          handles[j] = app.arena.resizeProp(handles[j], dims);
          settleAt(handles[j], handles[j].prop.x, handles[j].prop.z); // посадка после роста
        }
        reattachGizmo(); // Н16-1: выбранному объекту пересоздали меш — гизмо на новый
        app.arena.updateHolePhysics(); // у дырок мог измениться вырез
        renderEdit(); // обновить поля под новые значения
        save();
        updCount();
      }
      return;
    }
    const h = handles[selected];
    const p = h.prop;
    // Н18-1 (частичный откат Н17-1): позицию/поворот запрещаем только
    // СГРУППИРОВАННОЙ дырке (двигается лишь с группой). Размер, цвет,
    // «закреплено» и сама галочка «дырка» доступны всегда.
    if (p.hole && p.group && (f === 'x' || f === 'z' || f === 'elev' || f.slice(0, 3) === 'rot')) return;
    if (f === 'x') {
      const nx = num(p.x * 1000, -app.arena.sizeW * 500, app.arena.sizeW * 500) / 1000;
      settleAt(h, nx, p.z);
    } else if (f === 'z') {
      const nz = num(p.z * 1000, -app.arena.sizeD * 500, app.arena.sizeD * 500) / 1000;
      settleAt(h, p.x, nz);
    } else if (f === 'elev') {
      app.arena.moveProp(h, p.x, p.z, Math.max(0, num(0, 0, 1500)) / 1000);
      p.manualElev = true; // Н23-3: высота задана вручную — X/Z её сохраняют
    } else if (f === 'rotX' || f === 'rotY' || f === 'rotZ') {
      const ax = f.slice(3).toLowerCase(); // rotX → x
      h.mesh.rotation[ax] = num(0, -180, 180) * D2R;
      applyBodyFromMesh(h);
      settleAt(h, p.x, p.z); // пересесть на опору после поворота
    } else if (f === 'sx' || f === 'sz' || f === 'h' || f === 'dia' || f === 'hgt') {
      const m = num(10, 10, 1000) / 1000; // ПН9-4: объекты до 1000×1000×1000 мм
      let dims;
      if (p.shape === 'box' || p.shape === 'wedge') dims = f === 'sx' ? { sx: m } : f === 'sz' ? { sz: m } : { h: m };
      else dims = f === 'dia' ? { r: m / 2 } : { hgt: m };
      handles[selected] = app.arena.resizeProp(h, dims);
      settleAt(handles[selected], handles[selected].prop.x, handles[selected].prop.z);
      app.arena.updateHolePhysics(); // дырка с новым размером → пересчитать вырезы
      reattachGizmo(); // Н16-1: меш пересоздан — гизмо на новый
      syncSizeHandles(); // Н19-3: маркеры размера — на новые габариты/позицию
      renderEdit();
      save();
      updCount();
      return;
    } else if (f === 'color') {
      app.arena.setObjColor(h, parseInt(v.slice(1), 16));
    } else if (f === 'pinned') {
      app.arena.setPinned(h, !!v);
    } else if (f === 'hole') {
      // Н9-2: переключение «дырка ↔ сплошной» — пересоздаём объект (меш и тело
      // строятся по-разному), затем пересчитываем вырезы в соседних боксах
      p.hole = !!v;
      handles[selected] = app.arena.resizeProp(h, {});
      app.arena.updateHolePhysics();
      reattachGizmo(); // Н16-3: объект стал дыркой — гизмо снимается (reattachGizmo видит hole)
      syncSizeHandles(); // Н19-3: меш пересоздан — маркеры на новое место
      renderEdit();
      save();
      updCount();
      return;
    } else {
      return;
    }
    if (app.arena) app.arena.updateHolePhysics(); // Н9-2: позиция/поворот могли задеть вырезы
    save();
    syncEditFields();
    syncSizeHandles(); // Н19-3: объект сдвинулся/вырос полем — маркеры следом (иначе тянешь маркер со старой точки)
  }

  // текстура выбранного объекта (кнопка в окне редактирования)
  el.texfile.addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || selected < 0 || !app.arena) return;
    const img = new Image();
    img.onload = () => {
      if (selected < 0) return;
      app.arena.setObjImage(handles[selected], img);
      renderEdit();
      save();
    };
    img.src = URL.createObjectURL(f);
  });

  el.aeDel.addEventListener('click', deleteSelected);

  // ── Копия объекта (Н8-3): дубликат рядом с оригиналом, со всеми размерами,
  // цветом, поворотами и рисунком. Alt+тащить — та же копия «на лету».
  // Н9-2/Н9-3: работает и для группы (Shift-выделение) — раскладка копий
  // повторяет оригинал (общий сдвиг).
  function duplicateOne(i, forcedD) {
    const a = app.arena;
    const p = handles[i].prop;
    const ext = isRound(p.shape) ? p.r : Math.max(p.sx || 0, p.sz || 0) / 2;
    const rad = (q) => (isRound(q.shape) ? q.r : Math.max(q.sx || 0, q.sz || 0) / 2);
    let x = p.x, z = p.z;
    if (forcedD) {
      x += forcedD.dx; z += forcedD.dz;
    } else {
      // свободный сдвиг: перебираем направления, куда не налезаем на соседей
      const step = ext * 2 + 0.04;
      const busy = (bx, bz) => handles.some((h) =>
        Math.hypot(h.prop.x - bx, h.prop.z - bz) < rad(h.prop) + ext + 0.005);
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step]]) {
        if (!busy(p.x + dx, p.z + dz)) { x = p.x + dx; z = p.z + dz; break; }
      }
    }
    x = Math.max(-a.sizeW / 2 + ext, Math.min(a.sizeW / 2 - ext, x));
    z = Math.max(-a.sizeD / 2 + ext, Math.min(a.sizeD / 2 - ext, z));
    const nh = a.addProp({
      shape: p.shape, x, z, sx: p.sx, sz: p.sz, h: p.h, r: p.r, hgt: p.hgt,
      color: p.color, wall: p.wall, pinned: p.pinned, hole: !!p.hole,
      rotX: p.rotX || 0, rotY: p.rotY || 0, rotZ: p.rotZ || 0, elev: p.elev || 0,
    });
    handles.push(nh);
    // рисунок с оригинала: живой канвас клонируем, иначе — dataURL + штатное восстановление
    if (p._texCanvas) {
      const sc = p._texCanvas;
      const c = document.createElement('canvas');
      c.width = sc.width; c.height = sc.height;
      c.getContext('2d').drawImage(sc, 0, 0);
      remapBoxAtlasUV(nh.mesh.geometry);
      nh.prop._texCanvas = c;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      nh.prop._tex = tex;
      nh.mesh.material.color.setHex(0xffffff);
      nh.mesh.material.map = tex;
      nh.mesh.material.needsUpdate = true;
      a.syncObjTexData(nh); // dataURL в prop — рисунок переживёт перезагрузку
    } else if (p.tex) {
      nh.prop.tex = p.tex;
      a.restoreObjTexture(nh);
    }
    return nh;
  }

  function duplicateSelected() {
    if (!app.arena) return false;
    const targets = selSet.size > 1 ? [...selSet].filter((j) => handles[j]) : (selected >= 0 ? [selected] : []);
    if (!targets.length) return false;
    const first = duplicateOne(targets[0], null);
    const created = [first];
    if (targets.length > 1) {
      const d = { dx: first.prop.x - handles[targets[0]].prop.x, dz: first.prop.z - handles[targets[0]].prop.z };
      for (let k = 1; k < targets.length; k++) created.push(duplicateOne(targets[k], d));
    }
    // Н10-2: копии членов группы получают НОВЫЕ общие id — копия группы
    // движется как своя группа и не скреплена с оригиналом
    const gidMap = {};
    created.forEach((nh, k) => {
      const g = handles[targets[k]] && handles[targets[k]].prop.group;
      if (g) nh.prop.group = gidMap[g] || (gidMap[g] = newGid());
    });
    app.arena.updateHolePhysics(); // копия-дырка могла появиться внутри боксов
    for (const j of selSet) if (handles[j]) handles[j].mesh.material.emissive.setHex(0x000000);
    selSet.clear();
    for (const nh of created) {
      const idx = handles.indexOf(nh);
      selSet.add(idx);
      nh.mesh.material.emissive.setHex(0x2a3a2a);
    }
    selected = handles.length - 1;
    selSet.add(selected);
    closePop();
    renderEdit(); // Н12-1: гизмо не прикрепляем — только окно редактирования
    save();
    updCount();
    status2(created.length > 1 ? 'копии группы созданы' : 'копия создана — тащите на место');
    return true;
  }
  el.aeDup.addEventListener('click', duplicateSelected);

  // ── Загрузка/сохранение препятствий арены ──
  function clearHandles() {
    if (handlesArena) for (const h of handles) handlesArena.removeProp(h);
    handles = [];
    handlesArena = null;
    selSet.clear(); // Н9-2: индексы умерли — группа тоже
    selected = -1;
  }

  function loadFor(arena) {
    clearHandles();
    // Н20: смена арены / перезагрузка — история не переносится
    undoStack = [];
    redoStack = [];
    lastSer = null;
    if (!arena || !arena._scene) return;
    handlesArena = arena;
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(propsKey(arena.name)) || '[]'); } catch { /* пусто */ }
    if (!Array.isArray(arr)) arr = [];
    for (const p of arr.slice(0, 64)) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const desc = p.shape ? p : legacyToProp(p);
      const h = arena.addProp({
        ...desc,
        rotX: p.rotX || 0, rotY: p.rotY || 0, rotZ: p.rotZ || 0,
      });
      if (desc.tex) arena.restoreObjTexture(h);
      handles.push(h);
    }
    // Н9-2: в сохранении есть дырки — пересчитать вырезы в пересечённых боксах
    if (arr.some((p) => p && p.hole)) arena.updateHolePhysics();
    // краска: восстанавливаем поверх базовой разметки. Формат — старый
    // (голый dataURL пола) или новый ({ paint, layers: {key: dataURL} }).
    let paintRaw = null;
    try { paintRaw = localStorage.getItem(paintKey(arena.name)); } catch { /* пусто */ }
    if (paintRaw) {
      if (paintRaw.startsWith('{')) {
        try {
          const obj = JSON.parse(paintRaw);
          if (obj.paint) arena.restorePaint(obj.paint);
          arena.restoreMeshLayers(obj.layers);
        } catch { /* битая запись — пропускаем */ }
      } else {
        arena.restorePaint(paintRaw);
      }
    }
    syncPlates();
    lastSer = JSON.stringify(serializeProps()); // Н20: базовая точка undo
    lastPSer = null; // Н20-3: базу краски измеряем лениво (LS держит сохранённое состояние)
  }

  // ── Н20-3: краска в undo. Базу краски берём лениво из LS (paintKey): там
  // последнее СОХРАНЁННОЕ состояние. Жадный paintDataURL() в loadFor не годится —
  // restorePaint рисует асинхронно (Image.onload), и в момент загрузки канвас
  // содержит только базовую разметку. Старый формат записи — голый dataURL пола.
  function lsRawPaint() {
    try {
      const raw = localStorage.getItem(paintKey(app.arena.name));
      if (!raw) return JSON.stringify({ paint: null, layers: {} });
      return raw.startsWith('{') ? raw : JSON.stringify({ paint: raw, layers: {} });
    } catch { return JSON.stringify({ paint: null, layers: {} }); }
  }
  function paintSer() {
    const a = app.arena;
    if (!a) return JSON.stringify({ paint: null, layers: {} });
    const url = a.paintDataURL();
    const layers = a.meshLayerDataURLs ? a.meshLayerDataURLs() : {};
    return JSON.stringify({ paint: url || null, layers });
  }
  function pushSnapshot() {
    if (lastPSer === null) lastPSer = lsRawPaint(); // база краски — что было сохранено
    // Н20-3: внутри составной операции (кнопка «стереть краску») стек пишет
    // сам обработчик одним снапшотом — здесь только сбрасываем redo
    if (undoBatch) { redoStack.length = 0; return; }
    undoStack.push({ p: lastSer, a: lastPSer });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  // Н20: единая сериализация расстановки — и в LS, и для undo-снапшотов
  function serializeProps() {
    return handles.map((h) => {
      const p = h.prop;
      // поворот берём из меша — гизмо крутит именно его (эuler XYZ)
      const rx = +h.mesh.rotation.x.toFixed(4), ry = +h.mesh.rotation.y.toFixed(4), rz = +h.mesh.rotation.z.toFixed(4);
      return {
        shape: p.shape, x: +p.x.toFixed(4), z: +p.z.toFixed(4), sx: p.sx, sz: p.sz, h: p.h, r: p.r, hgt: p.hgt,
        color: p.color, wall: p.wall, pinned: p.pinned, hole: p.hole || undefined,
        rotX: rx, rotY: ry, rotZ: rz,
        elev: +(p.elev || 0).toFixed(3), tex: p.tex || undefined,
        manualElev: p.manualElev || undefined, // Н23-3: ручная высота переживает сохранение
        group: p.group || undefined, // Н10-2: группа переживает перезагрузку
      };
    });
  }

  function save() {
    try {
      const data = serializeProps();
      if (!app.arena) return;
      // Н20: undo — расстановка изменилась с прошлого save(): прежнее
      // состояние в стек, redo сбрасывается (история ветвится заново)
      const ser = JSON.stringify(data);
      if (lastSer !== null && ser !== lastSer) {
        pushSnapshot();
        lastSer = ser;
      }
      try {
        localStorage.setItem(propsKey(app.arena.name), JSON.stringify(data));
      } catch (e) {
        // Н4: квота localStorage переполнена (обычно — большие tex-картинки).
        // Жертвуем картинками, но сохраняем расстановку/цвета/размеры — иначе
        // при переполнении молча терялось ВСЁ, включая последние рисунки.
        const light = data.map(({ tex, ...rest }) => rest);
        try { localStorage.setItem(propsKey(app.arena.name), JSON.stringify(light)); } catch { /* совсем нет места */ }
        void e;
      }
    } catch { /* пусто */ }
  }

  function savePaint() {
    try {
      if (!app.arena) return;
      const url = app.arena.paintDataURL();
      const layers = app.arena.meshLayerDataURLs ? app.arena.meshLayerDataURLs() : {};
      const hasLayers = Object.keys(layers).length > 0;
      // Н20-3: undo — краска изменилась с прошлого savePaint()/загрузки
      const pser = JSON.stringify({ paint: url || null, layers });
      if (lastPSer === null) lastPSer = lsRawPaint();
      if (pser !== lastPSer) {
        pushSnapshot();
        lastPSer = pser;
      }
      if (!url && !hasLayers) {
        localStorage.removeItem(paintKey(app.arena.name));
        return;
      }
      localStorage.setItem(paintKey(app.arena.name), JSON.stringify({ paint: url, layers }));
    } catch { /* переполнение квоты — краска просто не сохранится */ }
  }

  function saveAll() {
    save();
    savePaint();
    persistRoute();
    status2('сохранено');
  }

  // ── Н20: откат/повтор расстановки. applyState НЕ через save()/savePaint():
  // пишем LS и пересобираем handle'ы напрямую — иначе сам откат попал бы в
  // историю. Н20-3: снапшот { p: расстановка, a: краска } — восстанавливаем
  // обе части; краска объектов (tex) едет внутри расстановки сама.
  function applyState(snap) {
    const a = app.arena;
    if (!a || !a._scene) return;
    let ser = snap, pl = null;
    try {
      if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
        ser = snap.p;           // новый формат { p, a }
        if (typeof snap.a === 'string') pl = JSON.parse(snap.a);
      }
    } catch { /* битая краска — восстанавливаем только расстановку */ }
    let arr = [];
    try { arr = JSON.parse(ser); } catch { return; }
    if (!Array.isArray(arr)) return;
    try { localStorage.setItem(propsKey(a.name), ser); } catch { /* нет места — в памяти всё равно откатим */ }
    // краска: LS и канвасы приводим к снапшоту (Н20-3)
    if (typeof snap.a === 'string') {
      try {
        if (pl && pl.paint) localStorage.setItem(paintKey(a.name), snap.a);
        else localStorage.removeItem(paintKey(a.name));
      } catch { /* нет места */ }
      a.clearPaint();
      a.clearMeshLayers();
      if (pl && pl.paint) a.restorePaint(pl.paint);
      if (pl && pl.layers) a.restoreMeshLayers(pl.layers);
    }
    clearHandles();
    handlesArena = a;
    for (const p of arr.slice(0, 64)) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const desc = p.shape ? p : legacyToProp(p);
      const h = a.addProp({ ...desc, rotX: p.rotX || 0, rotY: p.rotY || 0, rotZ: p.rotZ || 0 });
      if (desc.tex) a.restoreObjTexture(h);
      handles.push(h);
    }
    // дырки в откатываемой расстановке — пересчитать вырезы
    if (arr.some((p) => p && p.hole)) a.updateHolePhysics();
    setSelect(-1); // выделение умерло вместе со старыми handle'ами
    syncPlates();
    updCount();
    lastSer = ser;
    // Н20-3: база краски теперь равна снапшоту (legacy-снапшот без краски —
    // измеряем фактическое состояние канвасов)
    lastPSer = (snap && typeof snap.a === 'string') ? snap.a : paintSer();
  }

  function undo() {
    if (!handlesArena || !undoStack.length) { status2('нечего отменять'); return false; }
    // текущее — на повтор
    redoStack.push({ p: JSON.stringify(serializeProps()), a: paintSer() });
    applyState(undoStack.pop());
    status2('отменено');
    return true;
  }

  function redo() {
    if (!handlesArena || !redoStack.length) { status2('нечего повторять'); return false; }
    // откатенное — снова в историю
    undoStack.push({ p: JSON.stringify(serializeProps()), a: paintSer() });
    applyState(redoStack.pop());
    status2('повторено');
    return true;
  }

  // ── Маршрут и правила (трассы: старт/финиш + чекпоинты; зоны: выход/финиш) ──
  // Н5: различаем арены по возможностям судьи (track/exit), а не по имени.
  // Н19-5: у трасс появляется отдельный финиш, у арен с выходом — свой старт.
  function pickRouteMarker(p) {
    const a = app.arena;
    if (!a || !a.judge) return null;
    if (a.judge.track) {
      const t = a.judge.track;
      const cand = [{ kind: 'start', x: t.start.x, z: t.start.z, r: 0.18 }];
      if (t.finish) cand.push({ kind: 'finish', x: t.finish.x, z: t.finish.z, r: 0.18 });
      t.checkpoints.forEach((c, i) => cand.push({ kind: 'cp', i, x: c.x, z: c.z, r: 0.15 }));
      let best = null, bd = Infinity;
      for (const c of cand) {
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < c.r && d < bd) { bd = d; best = c; }
      }
      return best;
    }
    if (a.judge.exit) {
      const e = a.judge.exit;
      const sp = a.startPose;
      // выход (крупная зона) и старт — кто ближе к курсору, тот и тащим
      const cand = [
        { kind: 'exit', x: e.x, z: e.z, r: 0.45 },
        { kind: 'start', x: sp.x, z: sp.z, r: 0.18 },
      ];
      let best = null, bd = Infinity;
      for (const c of cand) {
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < c.r && d < bd) { bd = d; best = c; }
      }
      return best;
    }
    return null;
  }

  function routeMarkerMove(p) {
    const a = app.arena;
    const x = Math.max(-a.sizeW / 2 + 0.1, Math.min(a.sizeW / 2 - 0.1, p.x));
    const z = Math.max(-a.sizeD / 2 + 0.1, Math.min(a.sizeD / 2 - 0.1, p.z));
    if (routeDrag.kind === 'start') {
      a.startPose.x = x; a.startPose.z = z;
      if (a.judge.track) { a.judge.track.start.x = x; a.judge.track.start.z = z; }
    } else if (routeDrag.kind === 'finish') {
      // Н19-5: отдельный финиш трассы
      const f = a.judge.track && a.judge.track.finish;
      if (f) { f.x = x; f.z = z; }
    } else if (routeDrag.kind === 'cp') {
      a.judge.track.checkpoints[routeDrag.i].x = x;
      a.judge.track.checkpoints[routeDrag.i].z = z;
    } else if (routeDrag.kind === 'exit') {
      a.judge.exit.x = x; a.judge.exit.z = z;
    }
    a._composite(); // перерисовать базу (маркеры) поверх слоя краски
  }

  function persistRoute() {
    const a = app.arena;
    if (!a || !a.judge) return;
    // маршрут хранится по имени арены — «Восьмёрка» не перетирает «Линию»
    if (a.judge.track) {
      const t = a.judge.track;
      saveRoute(a.name, {
        start: { x: +t.start.x.toFixed(3), z: +t.start.z.toFixed(3) },
        finish: t.finish // Н19-5: null — финиш совмещён со стартом
          ? { x: +t.finish.x.toFixed(3), z: +t.finish.z.toFixed(3) }
          : null,
        cps: t.checkpoints.map((c) => ({ x: +c.x.toFixed(3), z: +c.z.toFixed(3) })),
        rules: { ...a.judge.rules },
      });
    } else if (a.judge.exit) {
      saveRoute(a.name, {
        exit: { x: +a.judge.exit.x.toFixed(3), z: +a.judge.exit.z.toFixed(3) },
        start: { x: +a.startPose.x.toFixed(3), z: +a.startPose.z.toFixed(3) }, // Н19-5
        rules: { ...a.judge.rules },
      });
    }
  }

  function syncRulesUI() {
    const a = app.arena;
    const isLine = !!a && a.judge && !!a.judge.track;
    const isMaze = !!a && a.judge && !!a.judge.exit;
    if (!isLine && !isMaze) return;
    const R = a.judge.rules || {};
    el.rtime.value = R.timeLimit || 0;
    el.rmax.value = isLine ? (R.maxOffs || 0) : (R.maxHits || 0);
    el.rmaxlbl.textContent = isLine ? 'Макс. сходов' : 'Макс. столкновений';
    el.rcpsRow.style.display = isLine ? '' : 'none';
    if (isLine) el.rcps.checked = R.requireCheckpoints !== false;
    // Н19-5: чекпоинты и отдельный финиш — только у трасс; у арен с выходом
    // старт двигается прямо на поле (маркер-ручка)
    el.rcpadd.style.display = isLine ? '' : 'none';
    el.rcpdel.style.display = isLine ? '' : 'none';
    el.rfin.style.display = isLine ? '' : 'none';
    setCpAdd(false);
    updFinBtn();
    syncRouteFields(); // Н22-6: числа старта/финиша/чекпоинтов по текущей арене
  }

  // Н19-5: режим «клик по полю ставит чекпоинт»
  let cpAddMode = false;
  function setCpAdd(on) {
    cpAddMode = !!on && !!(app.arena && app.arena.judge && app.arena.judge.track);
    el.rcpadd.classList.toggle('active', cpAddMode);
    el.rcpadd.innerHTML = bi('plus') + (cpAddMode ? ' Чекпоинт: клик по полю' : ' Чекпоинт');
  }

  function updFinBtn() {
    const a = app.arena;
    const has = !!a && !!a.judge && !!a.judge.track && !!a.judge.track.finish;
    el.rfin.innerHTML = bi('flag') + (has ? ' Отдельный финиш: есть' : ' Отдельный финиш: нет');
  }

  // Н22-6: точные координаты маршрута — заполнение полей и видимость по типу арены
  function syncRouteFields() {
    const a = app.arena;
    if (!a || !a.judge) return;
    const isLine = !!a.judge.track;
    const isMaze = !!a.judge.exit;
    const show = isLine || isMaze;
    el.rstRow.style.display = show ? '' : 'none';
    el.rstrotRow.style.display = show ? '' : 'none';
    el.rfxRow.style.display = isLine && a.judge.track.finish ? '' : 'none';
    el.rexitRow.style.display = isMaze ? '' : 'none';
    const showCp = isLine && a.judge.track.checkpoints.length > 0;
    el.rcpRow.style.display = showCp ? '' : 'none';
    el.rcpxyzRow.style.display = showCp ? '' : 'none';
    if (show) {
      el.rsx.value = +a.startPose.x.toFixed(3);
      el.rsz.value = +a.startPose.z.toFixed(3);
      el.rsrot.value = a.startPose.yawDeg || 0;
    }
    if (isLine) {
      const f = a.judge.track.finish;
      if (f) { el.rfx.value = +f.x.toFixed(3); el.rfz.value = +f.z.toFixed(3); }
      const cps = a.judge.track.checkpoints;
      // сохранить выбор чекпоинта, если он ещё валиден (иначе — последний)
      const cur = parseInt(el.rcpsel.value, 10);
      const idx = Number.isInteger(cur) && cur >= 0 && cur < cps.length ? cur : cps.length - 1;
      el.rcpsel.innerHTML = cps.map((_, i) => `<option value="${i}">${i + 1}</option>`).join('');
      el.rcpsel.value = String(idx);
      const c = cps[idx];
      if (c) { el.rcpx.value = +c.x.toFixed(3); el.rcpz.value = +c.z.toFixed(3); }
    }
    if (isMaze) {
      el.rex.value = +a.judge.exit.x.toFixed(3);
      el.rez.value = +a.judge.exit.z.toFixed(3);
    }
  }

  function routeNum(input, def) {
    const n = parseFloat(input.value);
    return Number.isFinite(n) ? n : def;
  }

  // Н22-6: применить число из поля — мутация judge/startPose → сохранение → перерисовка
  function applyRouteField(kind) {
    const a = app.arena;
    if (!a || !a.judge) return;
    const cl = (x, z) => [
      Math.max(-a.sizeW / 2 + 0.1, Math.min(a.sizeW / 2 - 0.1, x)),
      Math.max(-a.sizeD / 2 + 0.1, Math.min(a.sizeD / 2 - 0.1, z)),
    ];
    if (kind === 'start') {
      const [x, z] = cl(routeNum(el.rsx, a.startPose.x), routeNum(el.rsz, a.startPose.z));
      a.startPose.x = x; a.startPose.z = z;
      // у трасс старт судейства и поза робота — одна точка (как в routeMarkerMove)
      if (a.judge.track) { a.judge.track.start.x = x; a.judge.track.start.z = z; }
    } else if (kind === 'rot') {
      a.startPose.yawDeg = Math.max(-180, Math.min(180, routeNum(el.rsrot, a.startPose.yawDeg || 0)));
    } else if (kind === 'finish') {
      const f = a.judge.track && a.judge.track.finish;
      if (f) { const [x, z] = cl(routeNum(el.rfx, f.x), routeNum(el.rfz, f.z)); f.x = x; f.z = z; }
    } else if (kind === 'exit') {
      if (a.judge.exit) {
        const [x, z] = cl(routeNum(el.rex, a.judge.exit.x), routeNum(el.rez, a.judge.exit.z));
        a.judge.exit.x = x; a.judge.exit.z = z;
      }
    } else if (kind === 'cp') {
      const c = a.judge.track && a.judge.track.checkpoints[parseInt(el.rcpsel.value, 10)];
      if (c) { const [x, z] = cl(routeNum(el.rcpx, c.x), routeNum(el.rcpz, c.z)); c.x = x; c.z = z; }
    }
    persistRoute();
    a._composite();
    syncRouteFields();
  }

  el.rsx.addEventListener('change', () => applyRouteField('start'));
  el.rsz.addEventListener('change', () => applyRouteField('start'));
  el.rsrot.addEventListener('change', () => applyRouteField('rot'));
  el.rfx.addEventListener('change', () => applyRouteField('finish'));
  el.rfz.addEventListener('change', () => applyRouteField('finish'));
  el.rex.addEventListener('change', () => applyRouteField('exit'));
  el.rez.addEventListener('change', () => applyRouteField('exit'));
  el.rcpsel.addEventListener('change', syncRouteFields); // выбор чекпоинта — показать его X/Z
  el.rcpx.addEventListener('change', () => applyRouteField('cp'));
  el.rcpz.addEventListener('change', () => applyRouteField('cp'));

  function setRouteMode(on) {
    routeMode = on;
    el.rmode.innerHTML = bi('flag') + (routeMode ? ' Правка: ВКЛ' : ' Правка: выкл');
    el.rmode.classList.toggle('active', routeMode);
    if (!routeMode) setCpAdd(false);
  }

  // Н23-1: все кнопки маршрута сбрасывают выделение объекта
  el.rmode.addEventListener('click', () => { setSelect(-1); setRouteMode(!routeMode); });

  el.rcpadd.addEventListener('click', () => { setSelect(-1); setCpAdd(!cpAddMode); });

  el.rcpdel.addEventListener('click', () => {
    const a = app.arena;
    setSelect(-1);
    if (!a || !a.judge || !a.judge.track || !a.judge.track.checkpoints.length) return;
    a.judge.track.checkpoints.pop();
    persistRoute();
    a._composite();
    syncRouteFields();
    status2('чекпоинт убран');
  });

  el.rfin.addEventListener('click', () => {
    const a = app.arena;
    setSelect(-1); // Н23-1
    if (!a || !a.judge || !a.judge.track) return;
    const t = a.judge.track;
    if (t.finish) {
      t.finish = null;
      status2('финиш совмещён со стартом (планка старт-финиш)');
    } else {
      t.finish = { x: t.start.x, z: t.start.z, r: 0.14 };
      status2('финиш создан у старта — тащите его по полю');
    }
    updFinBtn();
    syncRouteFields();
    persistRoute();
    a._composite();
  });

  el.rrst.addEventListener('click', () => {
    const a = app.arena;
    setSelect(-1); // Н23-1
    if (!a || !a.resetRoute) return;
    a.resetRoute();
    clearRoute(a.name);
    syncRulesUI();
    status2('маршрут сброшен к стандартному');
  });

  el.rsave.addEventListener('click', () => {
    const a = app.arena;
    if (!a || !a.judge) return;
    const t = Math.max(0, parseFloat(el.rtime.value) || 0);
    const mx = Math.max(0, parseInt(el.rmax.value, 10) || 0);
    if (a.judge.track) {
      a.judge.rules.timeLimit = t;
      a.judge.rules.maxOffs = mx;
      a.judge.rules.requireCheckpoints = el.rcps.checked;
    } else {
      a.judge.rules.timeLimit = t;
      a.judge.rules.maxHits = mx;
    }
    persistRoute();
    status2('правила сохранены');
  });

  // ── Размер поля (Н29-3: любая арена) ──
  el.fapply.addEventListener('click', () => {
    const a = app.arena;
    if (!a) return;
    const cl = (v, def) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? Math.max(ARENA_SIZE_LIMITS.min, Math.min(ARENA_SIZE_LIMITS.max, n)) : def;
    };
    const w = cl(el.fw.value, a.sizeW);
    const d = cl(el.fd.value, a.sizeD);
    el.fw.value = w; el.fd.value = d;
    if (Math.abs(a.sizeW - w) < 0.01 && Math.abs(a.sizeD - d) < 0.01) {
      status2('размер не изменился');
      return;
    }
    saveArenaSize(a.name, w, d);
    app.rebuildArena(); // пересоберёт арену, робота и перезагрузит панель
    status2(`поле: ${w} × ${d} м`);
  });

  // ── Н29-4: фон платформы/стен/заднего плана (живая перекраска) ──
  function syncColorsUI() {
    const a = app.arena;
    if (!a) return;
    el.cfloor.value = hexCss(a.floorColor);
    el.cwall.value = hexCss(a.wallColor);
    el.cbg.value = hexCss(a.bgColor);
  }
  const parseHex = (s) => parseInt(String(s).replace('#', ''), 16) >>> 0;
  el.cfloor.addEventListener('input', () => { if (app.arena) app.arena.setFloorColor(parseHex(el.cfloor.value)); });
  el.cwall.addEventListener('input', () => { if (app.arena) app.arena.setWallColor(parseHex(el.cwall.value)); });
  el.cbg.addEventListener('input', () => { if (app.arena) app.arena.setBackdropColor(parseHex(el.cbg.value)); });
  el.creset.addEventListener('click', () => {
    const a = app.arena;
    if (!a) return;
    clearArenaColors(a.name);
    a.setFloorColor(ARENA_COLOR_DEFAULTS.floor);
    a.setWallColor(ARENA_COLOR_DEFAULTS.wall);
    a.setBackdropColor(ARENA_COLOR_DEFAULTS.bg);
    syncColorsUI();
    status2('цвета сброшены');
  });

  // ── Н29-2b: список источников света (цвет/яркость/радиус/XYZ/удаление) ──
  function renderLightList() {
    const a = app.arena;
    const list = el.llist;
    list.innerHTML = '';
    if (!a || !Array.isArray(a.lights)) return;
    if (!a.lights.length) {
      const empty = document.createElement('div');
      empty.className = 'ap-hint';
      empty.textContent = 'Пока нет ламп. Нажмите «＋ Источник».';
      list.appendChild(empty);
      return;
    }
    a.lights.forEach((d, i) => {
      const card = document.createElement('div');
      card.className = 'light-card';
      const hex = '#' + (d.color >>> 0).toString(16).padStart(6, '0');
      card.innerHTML = `
        <div class="lc-head">
          <span class="lc-name">Лампа ${i + 1}</span>
          <input type="color" class="lc-color" value="${hex}" title="Цвет света">
          <button class="lc-del" title="Удалить лампу"><svg class="bi" style="margin:0"><use href="#i-trash"/></svg></button>
        </div>
        <label class="ap-lbl">Яркость
          <input type="range" class="lc-int" min="${LIGHT_LIMITS.minI}" max="${LIGHT_LIMITS.maxI}" step="0.5" value="${d.intensity}">
          <span class="ap-val lc-intval">${d.intensity}</span>
        </label>
        <label class="ap-lbl">Радиус, м
          <input type="range" class="lc-dist" min="${LIGHT_LIMITS.minDist}" max="${LIGHT_LIMITS.maxDist}" step="0.5" value="${d.distance}">
          <span class="ap-val lc-distval">${d.distance}</span>
        </label>
        <div class="num-row">
          <span class="ax">X</span><input type="number" class="lc-x" step="0.05" value="${d.x}" title="X, м">
          <span class="ax">Y</span><input type="number" class="lc-y" step="0.05" value="${d.y}" title="Высота, м">
          <span class="ax">Z</span><input type="number" class="lc-z" step="0.05" value="${d.z}" title="Z, м">
        </div>
      `;
      list.appendChild(card);
      const $ = (sel) => card.querySelector(sel);
      $('.lc-color').addEventListener('input', (e) => a.updateLight(i, { color: parseInt(e.target.value.slice(1), 16) }));
      $('.lc-int').addEventListener('input', (e) => {
        const v = +e.target.value; $('.lc-intval').textContent = v; a.updateLight(i, { intensity: v });
      });
      $('.lc-dist').addEventListener('input', (e) => {
        const v = +e.target.value; $('.lc-distval').textContent = v; a.updateLight(i, { distance: v });
      });
      const numHandler = (cls, key) => {
        const inp = $(cls);
        inp.addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) a.updateLight(i, { [key]: v });
        });
        // после ввода вернуть в поле клампнутое значение (арена ограничивает диапазон)
        inp.addEventListener('change', () => { inp.value = a.lights[i] ? a.lights[i][key] : inp.value; });
      };
      numHandler('.lc-x', 'x'); numHandler('.lc-y', 'y'); numHandler('.lc-z', 'z');
      $('.lc-del').addEventListener('click', () => { a.removeLight(i); renderLightList(); });
    });
  }

  el.ladd.addEventListener('click', () => {
    const a = app.arena;
    if (!a) return;
    if (a.lights.length >= LIGHT_LIMITS.max) { status2(`максимум ${LIGHT_LIMITS.max} ламп`); return; }
    const n = a.lights.length; // лёгкое смещение, чтобы лампы не накладывались
    a.addLight({
      x: (n % 3 - 1) * 0.6, y: 1.2, z: (Math.floor(n / 3) % 3 - 1) * 0.6,
      color: 0xfff2d0, intensity: LIGHT_LIMITS.defI, distance: LIGHT_LIMITS.defDist,
    });
    renderLightList();
    status2('лампа добавлена');
  });

  // ── Сохранение/очистка из меню 💾 ──
  // ── Н9-5: полная очистка краски и объектов с двухступенчатым подтверждением ──
  // Первый клик «взводит» кнопку (текст «Точно?», 3 с), второй — выполняет.
  function withConfirm(btn, act) {
    const idle = btn.dataset.idle || (btn.dataset.idle = btn.textContent);
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.textContent = idle;
      btn.classList.remove('warn');
      clearTimeout(+btn.dataset.timer || 0);
      act();
      return;
    }
    btn.dataset.armed = '1';
    btn.classList.add('warn');
    btn.textContent = 'Точно?';
    btn.dataset.timer = String(setTimeout(() => {
      btn.dataset.armed = '';
      btn.classList.remove('warn');
      btn.textContent = idle;
    }, 3000));
  }

  el.saveall.addEventListener('click', () => { setSelect(-1); saveAll(); closePop(); });
  el.clearpaint.addEventListener('click', () => withConfirm(el.clearpaint, () => {
    if (!app.arena) return;
    setSelect(-1); // Н23-1
    // краска всюду: пол, слои на геометрии арены и канвасы объектов (Н9-5)
    // Н20-3: стирание краски+объектов — один шаг undo. Снапшот «до» берём
    // вручную (краску — из LS, пока она не затёрта), внутренние pushSnapshot
    // в savePaint/save глушим флагом undoBatch.
    const pre = { p: lastSer, a: lastPSer === null ? lsRawPaint() : lastPSer };
    undoBatch = true;
    app.arena.clearPaint();
    app.arena.clearMeshLayers();
    for (const h of handles) app.arena.clearObjTexture(h);
    stampImg = null;
    savePaint();
    save();
    undoBatch = false;
    if (lastSer !== pre.p || lastPSer !== pre.a) { // что-то реально изменилось
      undoStack.push(pre);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
      redoStack.length = 0;
    }
    status2('вся краска стёрта');
  }));
  el.clearprops.addEventListener('click', () => withConfirm(el.clearprops, () => {
    if (!app.arena) return;
    setSelect(-1);
    for (const h of handles) app.arena.removeProp(h);
    handles = [];
    app.arena.updateHolePhysics();
    save();
    updCount(); // Н14-1: покажет «объектов: 0» вместо отдельного текста
  }));

  // ── Экспорт/импорт арены файлом (поделиться трассой) ──
  // Файл — JSON: { app, kind:'arena', ver, arena, title, size?, props, paint?, route? }.
  // Экспорт собирает то же, что пишется в localStorage; импорт валидирует,
  // перезаписывает LS-ключи ТЕКУЩЕЙ арены и пересобирает её штатным путём.
  function lsJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || fallback); }
    catch { return fallback; }
  }
  el.export.addEventListener('click', () => {
    const a = app.arena;
    if (!a) return;
    saveAll(); // сначала зафиксировать текущее состояние в LS
    const data = {
      app: 'roboarena3d',
      kind: 'arena',
      ver: 1,
      arena: a.name,
      title: a.title,
      size: { w: a.sizeW, d: a.sizeD }, // Н29-3: размер любой арены
      props: lsJSON(propsKey(a.name), '[]'),
      paint: lsJSON(paintKey(a.name), 'null'),
      route: loadRoute(a.name),
      lights: loadLights(a.name),
      colors: loadArenaColors(a.name), // Н29-4: фон пола/бортов/заднего плана
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'arena-' + a.name + '.json';
    link.click();
    URL.revokeObjectURL(link.href);
    status2('экспортировано: ' + link.download);
  });

  // Санитизация объекта из файла: только известные формы и разумные числа —
  // битый/злонамеренный JSON не должен ломать арену.
  function sanitizeProp(p) {
    if (!p || typeof p !== 'object') return null;
    const SHAPES = ['box', 'cyl', 'cone', 'ball', 'wedge'];
    if (!SHAPES.includes(p.shape)) return null;
    if (!Number.isFinite(+p.x) || !Number.isFinite(+p.z)) return null; // как в loadFor
    const num = (v, lo, hi, dflt) => {
      v = +v;
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
    };
    const q = {
      shape: p.shape,
      x: num(p.x, -9, 9, 0), z: num(p.z, -9, 9, 0),
      elev: num(p.elev, 0, 1.5, 0),
      rotX: num(p.rotX, -10, 10, 0), rotY: num(p.rotY, -10, 10, 0), rotZ: num(p.rotZ, -10, 10, 0),
      color: Number.isFinite(+p.color) ? (+p.color & 0xffffff) : 0x888888,
      wall: !!p.wall,
      pinned: p.pinned !== false,
      hole: !!p.hole, // Н9-2
      tex: (typeof p.tex === 'string' && p.tex.startsWith('data:image')) ? p.tex : undefined,
      group: (typeof p.group === 'string' && p.group.length < 24) ? p.group : undefined, // Н10-2
    };
    if (q.shape === 'box' || q.shape === 'wedge') {
      q.sx = num(p.sx, 0.02, 2, 0.1); q.sz = num(p.sz, 0.02, 2, 0.1); q.h = num(p.h, 0.01, 1, 0.1);
    } else if (q.shape === 'ball') {
      q.r = num(p.r, 0.02, 0.5, 0.06);
    } else { // cyl / cone
      q.r = num(p.r, 0.02, 0.5, 0.05); q.hgt = num(p.hgt, 0.02, 1, 0.12);
    }
    return q;
  }

  el.import.addEventListener('click', () => el.json.click());
  el.json.addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !app.arena) return;
    const rd = new FileReader();
    rd.onload = () => {
      let d;
      try { d = JSON.parse(String(rd.result)); }
      catch { status2('импорт: файл не читается (это не JSON)'); return; }
      if (!d || d.app !== 'roboarena3d' || d.kind !== 'arena') {
        status2('импорт: это не файл арены РобоАрены');
        return;
      }
      const a = app.arena;
      // объекты: санитизация + лимит 64 (как при загрузке из LS)
      const props = (Array.isArray(d.props) ? d.props : []).map(sanitizeProp).filter(Boolean).slice(0, 64);
      try { localStorage.setItem(propsKey(a.name), JSON.stringify(props)); } catch { /* пусто */ }
      // Н29-2b: источники света (санитизация внутри saveLights)
      try {
        if (Array.isArray(d.lights)) saveLights(a.name, d.lights.filter((x) => x && typeof x === 'object').slice(0, LIGHT_LIMITS.max));
        else clearLights(a.name);
      } catch { /* пусто */ }
      // Н29-4: фон пола/бортов/заднего плана (санитизация внутри saveArenaColors)
      try {
        if (d.colors && typeof d.colors === 'object') saveArenaColors(a.name, d.colors);
        else clearArenaColors(a.name);
      } catch { /* пусто */ }
      // краска пола/объектов — тот же формат, что пишет savePaint()
      try {
        if (d.paint && typeof d.paint === 'object' && (d.paint.paint || d.paint.layers)) {
          localStorage.setItem(paintKey(a.name), JSON.stringify(d.paint));
        } else if (typeof d.paint === 'string' && d.paint.startsWith('data:image')) {
          localStorage.setItem(paintKey(a.name), JSON.stringify({ paint: d.paint, layers: {} }));
        } else {
          localStorage.removeItem(paintKey(a.name));
        }
      } catch { /* переполнение квоты */ }
      // маршрут/правила — только если файл экспортирован с той же арены.
      // Формат проверяем по содержимому: трасса (в т.ч. песочница, Н19-5)
      // хранит start, зона финиша — exit (Н5).
      if (a.judge && d.arena === a.name && d.route && typeof d.route === 'object'
        && ((a.judge.track && d.route.start !== undefined) || (a.judge.exit && d.route.exit !== undefined))) {
        saveRoute(a.name, d.route);
      }
      // размер поля — только если файл экспортирован с той же арены
      // (Н29-3: любая арена; кламп 2..8 внутри saveArenaSize/loadArenaSize)
      if (d.arena === a.name && d.size
        && Number.isFinite(+d.size.w) && Number.isFinite(+d.size.d)) {
        saveArenaSize(a.name, +d.size.w, +d.size.d);
      }
      app.rebuildArena(); // перечитать LS: объекты/краска/маршрут/размер
      status2('импортировано: ' + f.name);
    };
    rd.readAsText(f);
  });

  el.tool.addEventListener('change', () => {
    paintTool = el.tool.value;
    setSelect(-1);
    if (paintTool === 'image' && !stampImg) el.file.click();
  });
  el.size.addEventListener('input', () => { el.sizeVal.textContent = el.size.value + ' мм'; });
  el.img.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      stampImg = img;
      paintTool = 'image';
      el.tool.value = 'image';
      status2('кликните по полу, чтобы поставить картинку');
    };
    img.src = URL.createObjectURL(f);
  });

  function status2(t) { el.count.textContent = t; }
  function updCount() {
    if (el.count.textContent.startsWith('кликните')) return;
    if (el.count.textContent === 'сохранено' || el.count.textContent.endsWith('добавлен')) return;
    // Н14-1: пустое поле сбивает с толку — «объектов: 0» видно всегда
    el.count.textContent = `объектов: ${handles.length}`;
  }

  // ── Жесты на 3D-канвасе ──
  function onDown(e) {
    if (!openFlag || !app.arena) return;
    // Н9-4: ПКМ в штампе — завершить (клик без драга; сам драг ПКМ крутит камеру)
    if (e.button === 2) { rmbDown = { x: e.clientX, y: e.clientY }; return; }
    if (e.button !== 0) return;
    // Н13-1: копия {x,z} — hitPoint общий и перезаписывается каждым raycast'ом
    const fp = floorPoint(e);
    lastMouse = fp ? { x: fp.x, z: fp.z } : null; // Н9-3: точка курсора — для Ctrl+V и призрака
    if (routeMode) {
      const p = floorPoint(e);
      if (!p) return;
      routeDrag = pickRouteMarker(p);
      if (routeDrag) {
        try { canvasEl().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
      } else if (cpAddMode && app.arena.judge && app.arena.judge.track) {
        // Н19-5: клик по свободному месту ставит новый чекпоинт
        const t = app.arena.judge.track;
        const x = Math.max(-app.arena.sizeW / 2 + 0.1, Math.min(app.arena.sizeW / 2 - 0.1, p.x));
        const z = Math.max(-app.arena.sizeD / 2 + 0.1, Math.min(app.arena.sizeD / 2 - 0.1, p.z));
        t.checkpoints.push({ x: +x.toFixed(3), z: +z.toFixed(3), r: 0.12 });
        setCpAdd(false);
        persistRoute();
        app.arena._composite();
        syncRouteFields();
        status2(`чекпоинт ${t.checkpoints.length} поставлен`);
      }
      return;
    }
    if (paintOn) {
      try { canvasEl().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
      // картинка: сначала пробуем объект (просьба 8), затем пол
      if (paintTool === 'image') {
        const oh = objBrushHit(e);
        if (oh) {
          if (!stampImg) { status2('сначала выберите картинку'); return; }
          app.arena[oh.isProp ? 'stampOnObject' : 'stampOnMesh'](oh.target, oh.B, stampImg, (+el.size.value * 8) / 1000);
          if (oh.isProp) app.arena.syncObjTexData(oh.target);
          savePaint();
          return;
        }
        const p = floorPoint(e);
        if (!p) return;
        if (!stampImg) { status2('сначала выберите картинку'); return; }
        app.arena.stampImage(p.x, p.z, (+el.size.value * 8) / 1000, stampImg);
        savePaint();
        return;
      }
      // Н9-7: заливка — грань объекта/геометрии целиком, промах — весь пол
      if (paintTool === 'fill') {
        const oh = objBrushHit(e);
        if (oh) {
          app.arena[oh.isProp ? 'fillObjectFace' : 'fillMeshFace'](oh.target, oh.B, el.color.value);
          if (oh.isProp) { app.arena.syncObjTexData(oh.target); save(); }
          savePaint();
          return;
        }
        const p = floorPoint(e);
        if (!p) return;
        app.arena.fillFloor(el.color.value);
        savePaint();
        return;
      }
      // фигура: тоже сначала объект, затем пол
      if (paintTool === 'rect' || paintTool === 'circle' || paintTool === 'line') {
        const oh = objBrushHit(e);
        if (oh) {
          shapeObj = oh;
          shapeObj.B0 = oh.B; // старт фигуры на объекте
          shapeObjSt = objCanvasSnap(oh);
          shapeDrag = true;
          return;
        }
        const p = floorPoint(e);
        if (!p) return;
        shapeStart = { x: p.x, z: p.z };
        shapeSnap = app.arena.floorSnapshot();
        shapeDrag = true;
        return;
      }
      // кисть / ластик — единый мазок: луч сначала в объекты, затем пол
      painting = true;
      lastStroke = null;
      lastFloor = null;
      strokeAt(e, paintTool === 'eraser', paintTargets(app.arena), propHandleMap());
      return;
    }
    // Н9-4: штамп — ЛКМ по свободному полу ставит копию и ждёт следующую;
    // клик по объекту проваливается в обычный выбор/редактирование
    if (stampMode && pickProp(e) < 0) {
      if (lastMouse) addPropOfType(stampMode, { x: lastMouse.x, z: lastMouse.z }, true);
      return;
    }
    // Н12-4 + Н14-2: призрачная вставка — ЛКМ в любом месте ставит копию.
    // Раньше клик, задевший любой объект, «проваливался» в выбор: казалось,
    // что копирование срабатывает через раз. ПКМ/Esc завершают режим.
    if (pasteMode) {
      if (lastMouse) pasteAt(lastMouse.x, lastMouse.z);
      return;
    }
    // гизмо выбранного объекта — приоритет над выбором (стрелки/кольца/центр)
    if (selected >= 0 && gizmo.down(e)) {
      gzDrag = true;
      try { canvasEl().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
      return;
    }
    // Н9-2: в режиме размера сначала пробуем маркеры на гранях
    if (editTool === 'size') {
      const hm = sizeHit(e);
      if (hm) {
        startSizeDrag(e, hm);
        try { canvasEl().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
        return;
      }
    }
    const i = pickProp(e);
    if (i < 0) {
      // Н11-1: ЛКМ по пустому месту — рамка выделения области (Shift — добавить)
      mqOn = true;
      mqStart = { x: e.clientX, y: e.clientY };
      mqAdd = !!e.shiftKey;
      if (!mqAdd) setSelect(-1);
      mqShow(mqStart.x, mqStart.y, mqStart.x, mqStart.y);
      return;
    }
    if (e.shiftKey && selected >= 0) { setSelect(i, true); return; } // Н9-2: группа
    // Н15-1: в режимах поворота/размера клик по телу уже выбранного объекта —
    // пустой жест (не перевыбор, не драг): иначе он сбрасывал режим, и цикл
    // двойного клика всегда сходился к «кольцам поворота». Переключает dblclick.
    if (i === selected && editTool !== 'move') return;
    if (e.altKey) {
      // Н8-3: Alt+тащить — тащим КОПИЮ, оригинал остаётся на месте
      if (!duplicateSelected()) return;
    } else {
      setSelect(i);
    }
    // после Alt-дублирования selected указывает на КОПИЮ — тянем её
    const h = handles[selected];
    if (e.shiftKey) {
      // вертикальный перенос: плоскость через объект, нормаль — ближайшая
      // горизонтальная ось взгляда (ПН9-6: движение строго по видимым осям)
      const dir = new THREE.Vector3();
      app.rig.camera.getWorldDirection(dir);
      dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.set(Math.abs(dir.x) > Math.abs(dir.z) ? 1 : 0, 0, Math.abs(dir.x) > Math.abs(dir.z) ? 0 : 1);
      vPlane.setFromNormalAndCoplanarPoint(dir, h.mesh.position);
      vDrag = true;
    } else {
      // зацеп: плоскость под камеру (просьба «двигать в плоскостях, к которым
      // ближе камера») — смотрим сверху: пол X-Z, смотрим сбоку: вертикальная
      // плоскость через объект (мышь ведёт объект 1:1, без «торможения» пола)
      const mp = h.mesh.position;
      dragKind = app.rig.dragPlaneAt(mp, hPlane);
      // ПН10-4: третья ось заперта на всё перетаскивание. Вид сверху ('xz') —
      // это высота: она меняется только осознанно (посадка на опору, Н22-7).
      // Сбоку ('vert') — горизонтальная координата вдоль нормали плоскости:
      // фиксируем её явно, а не надеемся на точность пересечения с плоскостью.
      if (dragKind === 'xz') {
        lockAxis = null;
      } else {
        lockAxis = Math.abs(hPlane.normal.x) > Math.abs(hPlane.normal.z) ? 'x' : 'z';
        lockVal = lockAxis === 'x' ? mp.x : mp.z;
      }
      screenToNdc(e);
      raycaster.setFromCamera(ndc, app.rig.camera);
      off3.set(0, 0, 0);
      if (raycaster.ray.intersectPlane(hPlane, hitPoint)) off3.copy(mp).sub(hitPoint);
      // Н9-2: снимок группы — на время драга все члены едут за primary.
      // Н19-1: снимаем и высоты — члены едут ЖЁСТКО (forceElev), иначе луч
      // «на опору» ловил пересекающегося соседа и взгромождал объект на него.
      groupSnap = selSet.size > 1
        ? {
          base: { x: h.prop.x, z: h.prop.z, elev: h.prop.elev || 0 },
          members: [...selSet].filter((j) => j !== selected && handles[j])
            .map((j) => ({ h: handles[j], x: handles[j].prop.x, z: handles[j].prop.z, elev: handles[j].prop.elev || 0 })),
        }
        : null;
      dragging = true;
    }
    try { canvasEl().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
  }

  function paintAt(x, z) {
    const mm = +el.size.value;
    app.arena.paintCircle(x, z, mm / 1000 / 2, el.color.value);
  }

  function eraseAt(x, z) {
    const mm = +el.size.value;
    app.arena.eraseCircle(x, z, mm / 1000 / 2);
  }

  // Цели луча кисти и карта «меш → handle»: пересобираются ОДИН раз на пачку
  // pointermove-событий, а не на каждый coalesced-штрих (просьба 8).
  // Ремап UV коробок — ДО луча: hit.uv должен быть уже атласным, иначе
  // brushFromHit посчитает ячейку по неправильным координатам.
  function paintTargets(a) {
    const arr = [];
    for (const h of handles) {
      if (h.prop.hole) {
        // Н27: у дырки красим видимые стенки тоннеля (inner-меш); объём-призрак
        // — не поверхность, в луч кисти не берём
        if (h.prop._inner) { remapBoxAtlasUV(h.prop._inner.geometry); arr.push(h.prop._inner); }
        continue;
      }
      remapBoxAtlasUV(h.mesh.geometry); arr.push(h.mesh);
    }
    for (const m of a._meshes) if (m !== a._floorMesh && !m.userData.holeVolume) { remapBoxAtlasUV(m.geometry); arr.push(m); }
    return arr;
  }
  function propHandleMap() {
    const map = new Map();
    for (const h of handles) {
      map.set(h.mesh, h);
      // Н27: стенки тоннеля — «меш» дырки для луча кисти
      if (h.prop.hole && h.prop._inner) map.set(h.prop._inner, h);
    }
    return map;
  }

  // Н27: луч в проём дырки сначала попадает в «фантом» сплошной поверхности —
  // геометрия под stencil-вырезом цела, но эти пиксели спрятаны (рисуются
  // стенки тоннеля — inner-меш дырки). Если точка сплошного попадания лежит
  // внутри объёма дырки, мазок должен лечь на стенку тоннеля, а не в фантом.
  // Возврат { hit, h }: h задан для своего prop (в т.ч. дырки), null — промах.
  function paintPick(hits, pmap) {
    let solid = null;
    const holes = [];
    for (const hit of hits) {
      if (!hit.uv) continue;
      const h = pmap ? pmap.get(hit.object) : undefined;
      if (h && h.prop.hole) {
        // стенки тоннеля видимы только при stencil-вырезе; невидимый inner
        // (настоящий вырез бокса) красить нельзя — там красят настоящие грани
        if (h.prop._inner && h.prop._inner.material.visible) holes.push({ hit, h });
      } else if (!solid) solid = hit;
    }
    if (solid) {
      for (const c of holes) {
        if (app.arena.holeContainsPoint(c.h.prop, solid.point)) return c;
      }
      return { hit: solid, h: pmap ? pmap.get(solid.object) : undefined };
    }
    return holes.length ? holes[0] : null;
  }

  // Единый мазок кисти/ластика: луч из курсора — сначала объекты (свои props,
  // затем прочая геометрия арены: борт, стены трассы), и только если ничего
  // не задето — красим пол. Попадание в объект → brushFromHit даёт ячейку
  // грани и радиус кисти в пикселях (размер постоянный в мм на любой грани).
  // targets/propMap — общие для всей пачки событий, см. paintTargets().
  // Н15-5: непрерывный мазок имеет смысл только внутри ОДНОЙ грани/ячейки
  // текстуры. Если курсор перескочил на другую грань (или на другой кусок
  // атласа), интерполяция «от прошлой точки» протянет линию через всю
  // развёртку — на объекте вылезают случайные мазки. Такая пара точек
  // рисуется как два отдельных касания.
  function strokeChainOk(B0, B1) {
    if (!B0 || !B1) return false;
    if (B0.cell || B1.cell) {
      return !!B0.cell && !!B1.cell
        && B0.cell.col === B1.cell.col && B0.cell.row === B1.cell.row;
    }
    // Н18-3: у не-атласных форм (цилиндр/конус) регион граней (бок/торец)
    // обязан совпадать: UV бока и торца могут совпасть почти точно, и без
    // этой проверки мазок протягивался с боковой поверхности на торец.
    if (B0.fg >= 0 && B1.fg >= 0 && B0.fg !== B1.fg) return false;
    // без атласа (борт/стены) — просто защита от телепорта по UV
    return Math.abs(B0.u - B1.u) < 0.4 && Math.abs(B0.v - B1.v) < 0.4;
  }

  function strokeAt(e, erase, targets, propMap) {
    const a = app.arena;
    if (!a) return;
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    const hits = raycaster.intersectObjects(targets, false);
    const mm = (+el.size.value / 1000) / 2; // радиус кисти в метрах
    const color = el.color.value;
    const picked = paintPick(hits, propMap);
    if (picked) {
      const hit = picked.hit;
      const mesh = hit.object;
      const h = picked.h;
      if (h) {
        // свой prop (в т.ч. стенки тоннеля дырки) — канвас-текстура объекта
        const B = brushFromHit(mesh, hit, mm);
        if (erase) {
          // Н27: ластик у дырки возвращает исходные тёмные стенки (0x39404d)
          a.paintOnObject(h, B, h.prop.hole ? '#39404d'
            : '#' + (h.prop.color || 0x888888).toString(16).padStart(6, '0'));
          lastStroke = null;
        } else if (lastStroke && lastStroke.handle === h && strokeChainOk(lastStroke.B, B)) { // Н15-5
          a.paintStrokeOnObject(h, lastStroke.B, B, color);
          lastStroke = { handle: h, B };
        } else {
          a.paintOnObject(h, B, color);
          lastStroke = { handle: h, B };
        }
        lastPaintH = h;
        objPaintDirty = true;
      } else {
        // геометрия арены — прозрачный слой-канвас поверх меша
        const B = brushFromHit(mesh, hit, mm);
        if (erase) {
          a.eraseOnMesh(mesh, B);
          lastStroke = null;
        } else if (lastStroke && lastStroke.mesh === mesh && strokeChainOk(lastStroke.B, B)) { // Н15-5
          a.paintStrokeOnMesh(mesh, lastStroke.B, B, color);
          lastStroke = { mesh, B };
        } else {
          a.paintOnMesh(mesh, B, color);
          lastStroke = { mesh, B };
        }
        objPaintDirty = true; // слои сохраняются в savePaint()
      }
      // Н16-2: мазок перешёл с пола на объект — цепочку ПОЛА рвём. Иначе
      // следующий касание пола тянуло прямую от старой точки через весь проём.
      lastFloor = null;
      return;
    }
    const p = floorPoint(e);
    if (!p) return;
    // Н13-1: floorPoint возвращает ОБЩИЙ временный hitPoint — сохранять его
    // нельзя: следующий move (lastMouse = floorPoint(e) в начале onMove)
    // перезаписывает «прошлую» точку, мазок вырождается «из точки в неё же»
    // и быстрая кисть рисует отдельные кружки-точки. Храним копию {x,z}.
    const snap = { x: p.x, z: p.z };
    // Н16-2: пока красим пол — объектная цепочка рвётся, иначе возврат кисти
    // на ту же грань тянул линию от старого касания через всю развёртку
    lastStroke = null;
    lastPaintH = null;
    if (erase) {
      // цепочка кружков от прошлого касания — быстрый мазок без «точек»
      if (lastFloor) app.arena.eraseStrokeFloor(lastFloor.x, lastFloor.z, p.x, p.z, mm);
      else app.arena.eraseCircle(p.x, p.z, mm);
      lastFloor = snap;
    } else {
      if (lastFloor) app.arena.paintStrokeFloor(lastFloor.x, lastFloor.z, p.x, p.z, mm, el.color.value);
      else app.arena.paintCircle(p.x, p.z, mm, el.color.value);
      lastFloor = snap;
    }
  }

  function drawShapePreview(x, z) {
    app.arena.floorRestore(shapeSnap);
    app.arena.drawFloorShape(paintTool, shapeStart.x, shapeStart.z, x, z,
      +el.size.value / 1000, el.color.value, el.fill.checked);
  }

  // Луч в объекты (свои props + геометрия арены) — для фигур и картинок
  // на объектах (просьба 8). Возвращает { isProp, target, mesh, B } или null.
  function objBrushHit(e) {
    const a = app.arena;
    if (!a) return null;
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    const hits = raycaster.intersectObjects(paintTargets(a), false);
    // Н27: попадание в проём дырки → стенки тоннеля (paintPick)
    const picked = paintPick(hits, propHandleMap());
    if (!picked) return null;
    const hit = picked.hit;
    const B = brushFromHit(hit.object, hit, (+el.size.value / 1000) / 2);
    if (picked.h) return { isProp: true, target: picked.h, mesh: hit.object, B };
    return { isProp: false, target: hit.object, mesh: hit.object, B };
  }

  // Канвас объекта + снимок для отката превью фигуры
  function objCanvasSnap(hit) {
    const c = hit.isProp
      ? app.arena.ensureObjTexture(hit.target, '#' + (hit.target.prop.color || 0x888888).toString(16).padStart(6, '0'))
      : app.arena.ensureMeshLayer(hit.mesh).canvas;
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    s.getContext('2d').drawImage(c, 0, 0);
    return { canvas: c, snap: s };
  }

  function objCanvasRestore() {
    const ctx = shapeObjSt.canvas.getContext('2d');
    ctx.clearRect(0, 0, shapeObjSt.canvas.width, shapeObjSt.canvas.height);
    ctx.drawImage(shapeObjSt.snap, 0, 0);
    if (shapeObj.isProp && shapeObj.target.prop._tex) shapeObj.target.prop._tex.needsUpdate = true;
  }

  function onMove(e) {
    // Н13-1: копия {x,z} — общий hitPoint нельзя сохранять (см. onDown)
    const fp = floorPoint(e);
    lastMouse = fp ? { x: fp.x, z: fp.z } : null; // Н9-3/8: точка под курсором — для Ctrl+V и призрака
    if (mqOn && mqStart) { mqShow(mqStart.x, mqStart.y, e.clientX, e.clientY); return; } // Н11-1
    if (gzDrag) { gizmo.move(e); return; } // onChange сам синхронизирует тело и опору
    if (sizeDrag) { moveSizeDrag(e); return; } // Н9-2: тянем маркер размера
    if (routeDrag && routeMode) {
      const p = floorPoint(e);
      if (p) routeMarkerMove(p);
      return;
    }
    if (vDrag && selected >= 0 && app.arena) {
      screenToNdc(e);
      raycaster.setFromCamera(ndc, app.rig.camera);
      if (!raycaster.ray.intersectPlane(vPlane, hitPoint)) return;
      const p = handles[selected].prop;
      const elev = Math.max(0, Math.min(1.5, hitPoint.y - app.arena._halfOf(p)));
      app.arena.moveProp(handles[selected], p.x, p.z, elev);
      syncEditFields();
      return;
    }
    if (shapeDrag && shapeObj && shapeObjSt) {
      // превью фигуры на объекте: откат к снимку и перерисовка до курсора
      const oh = objBrushHit(e);
      if (oh && oh.mesh === shapeObj.mesh) {
        objCanvasRestore();
        app.arena[shapeObj.isProp ? 'drawObjectShape' : 'drawOnMeshShape'](
          shapeObj.target, shapeObj.B0, oh.B, paintTool,
          +el.size.value / 1000, el.color.value, el.fill.checked);
      }
      return;
    }
    if (shapeDrag && shapeStart) {
      const p = floorPoint(e);
      if (p) drawShapePreview(p.x, p.z);
      return;
    }
    if (painting) {
      // coalesced-события — промежуточные точки между кадрами, мазок сплошной;
      // списки целей — один раз на пачку, а не на каждый штрих (просьба 8)
      const evs = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length)
        ? e.getCoalescedEvents() : [e];
      const a = app.arena;
      const targets = paintTargets(a);
      const propMap = propHandleMap();
      for (const ev of evs) strokeAt(ev, paintTool === 'eraser', targets, propMap);
      return;
    }
    // Н9-8 + Н12-2: в штампе призрак объекта ездит под курсором (создаём,
    // если ещё нет — раньше он появлялся только после драга чипа); выходит
    // из режима он через setStamp(null) → setGhost(null), а не «зависает».
    // Н12-4: там же ездит призрак вставки из буфера.
    if (!dragging) {
      if (stampMode) {
        if (!ghostMesh || ghostMesh.userData.tk !== stampMode) setGhost(stampMode);
        moveGhost(e);
      }
      if (pasteMode && pasteGhost) movePasteGhost(e);
    }
    // Н9-2: маркеры размера следуют за объектом (после драга/гизмо)
    if (editTool === 'size') syncSizeHandles();
    if (!dragging || selected < 0 || !app.arena) return;
    const h = handles[selected];
    screenToNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    if (!raycaster.ray.intersectPlane(hPlane, hitPoint)) return;
    hitPoint.add(off3);
    if (dragKind === 'vert') {
      // боковая камера: мышь вверх/вниз — подъём/спуск, вбок — перенос по X/Z;
      // координата вдоль нормали плоскости заперта намертво (ПН10-4)
      if (lockAxis === 'x') hitPoint.x = lockVal;
      else if (lockAxis === 'z') hitPoint.z = lockVal;
      settleAt(h, hitPoint.x, hitPoint.z, hitPoint.y - app.arena._halfOf(h.prop));
    } else {
      // Н22-7: обычный драг мышкой теперь тоже «реагирует» на объекты —
      // полный поиск опоры (луч сверху, см. settleAt): объект ставится НА
      // соседа при проносе над ним, а «висящий в воздухе» не роняется
      // (зазор > 3 см сохраняется). Раньше высота была заморожена на
      // момент захвата (lockElev) — стекинг работал только у гизмо-стрелок.
      settleAt(h, hitPoint.x, hitPoint.z);
    }
    // Н9-2: группа едет за primary тем же сдвигом; Н19-1 — вертикаль тоже
    // жёсткая (перепад высоты primary передаётся членам без поиска опоры)
    if (groupSnap) {
      const dx = h.prop.x - groupSnap.base.x, dz = h.prop.z - groupSnap.base.z;
      const dE = (h.prop.elev || 0) - (groupSnap.base.elev || 0);
      for (const gm of groupSnap.members) settleAt(gm.h, gm.x + dx, gm.z + dz, gm.elev + dE);
    }
    syncEditFields();
  }

  function onUp(e) {
    // Н11-1: отпустили рамку — выбрать всё, что попало
    if (mqOn) {
      mqOn = false;
      mqDiv.style.display = 'none';
      if (mqStart && app.arena && e) {
        const moved = Math.hypot(e.clientX - mqStart.x, e.clientY - mqStart.y);
        if (moved >= 5) marqueeApply(marqueePick(mqStart.x, mqStart.y, e.clientX, e.clientY), mqAdd);
      }
      mqStart = null;
      return;
    }
    // Н9-4: ПКМ-клик без драга — выйти из штампа/вставки (драг ПКМ остаётся орбитой)
    if (e && e.button === 2 && rmbDown) {
      const moved = Math.hypot(e.clientX - rmbDown.x, e.clientY - rmbDown.y);
      rmbDown = null;
      if (moved < 5 && (stampMode || pasteMode)) { setStamp(null); setPaste(false); return; }
    }
    if (gzDrag) { gzDrag = false; gizmo.up(); return; } // save() в onEnd гизмо
    if (sizeDrag) { endSizeDrag(); return; } // Н9-2: применить новый размер
    if (routeDrag) { routeDrag = null; persistRoute(); syncRouteFields(); } // Н22-6: поля после драга
    if (vDrag) { vDrag = false; if (app.arena) app.arena.updateHolePhysics(); save(); }
    if (painting) {
      painting = false;
      lastStroke = null;
      lastFloor = null;
      if (objPaintDirty) {
        objPaintDirty = false;
        // зафиксировать канвас объекта в p.tex — иначе рисунок пропадёт
        // при перезагрузке (текстура канвасная, в сохранении только dataURL)
        if (lastPaintH) app.arena.syncObjTexData(lastPaintH);
        lastPaintH = null;
        save();
      }
      savePaint(); // пол и/или слои на геометрии арены
    }
    if (shapeDrag) {
      shapeDrag = false;
      shapeStart = null;
      shapeSnap = null;
      if (shapeObj) { // фигура была на объекте — зафиксировать dataURL
        if (shapeObj.isProp) app.arena.syncObjTexData(shapeObj.target);
        shapeObj = null;
        shapeObjSt = null;
      }
      savePaint();
    }
    if (dragging) {
      dragging = false;
      lockAxis = null;
      groupSnap = null;
      if (app.arena) app.arena.updateHolePhysics();
      save();
    }
  }

  // Двойной клик по выбранному объекту (Н14-3): цикл режимов
  // перенос → кольца поворота → маркеры размера → снова перенос.
  // Удаление — кнопкой в окне редактирования или Del.
  function onDblClick(e) {
    if (!openFlag || routeMode || paintOn || !app.arena) return;
    const i = pickProp(e);
    if (i < 0 || i !== selected) return;
    cycleEditTool();
  }

  function bindCanvas() {
    const elc = canvasEl();
    elc.addEventListener('pointerdown', onDown);
    elc.addEventListener('pointermove', onMove);
    elc.addEventListener('pointerup', onUp);
    elc.addEventListener('pointercancel', onUp);
    elc.addEventListener('dblclick', onDblClick);
  }
  bindCanvas();

  // Пока редактор открыт: ЛКМ при активном режиме, по гизмо, маркерам размера
  // или по объекту — жест наш (main.js выстраивает цепочку guard'ов редакторов).
  // Alt+клик по объекту — тоже наш: это жест «тащить копию» (Н8-3).
  function guard(e) {
    return openFlag && e.button === 0
      && (routeMode || paintOn || (selected >= 0 && gizmo.hitTest(e))
        || sizeHit(e) || pickProp(e) >= 0);
  }

  // ── Горячие клавиши (просьба 13); вызывается из main.js ──
  // Н9-3: Ctrl+C / Ctrl+V — буфер обмена; Н9-4: ПКМ/Esc выходит из штампа.
  function handleKey(e) {
    // Н20-2: буквы хоткеев — по ФИЗИЧЕСКОЙ клавише (e.code), иначе на русской
    // раскладке Ctrl+Z даёт key='я', Ctrl+S — 'ы', и все хоткеи молча умирают.
    // code отсутствует (старые браузеры/синтетика) — откат на e.key.
    const k = e.code && e.code.startsWith('Key')
      ? e.code.slice(3).toLowerCase()
      : (e.key || '').toLowerCase();
    if (e.key === 'Escape') {
      if (openPop) { closePop(); return true; }
      if (stampMode || pasteMode) { setStamp(null); setPaste(false); return true; } // Н12-4
      if (routeMode) { setRouteMode(false); return true; }
      if (paintOn) { el.paint.click(); return true; }
      if (selected >= 0) { setSelect(-1); return true; }
      return false;
    }
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      saveAll();
      return true;
    }
    // Н20: Ctrl+Z — откат, Ctrl+Shift+Z / Ctrl+Y — повтор расстановки.
    // Фокус в поле ввода — там свой штатный undo, не отбираем (return false
    // = main.js не делает preventDefault, нативная отмена срабатывает).
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return false;
      if (k === 'y' || e.shiftKey) return redo();
      return undo();
    }
    if ((e.ctrlKey || e.metaKey) && k === 'c') {
      return copySelected();
    }
    if ((e.ctrlKey || e.metaKey) && k === 'v') {
      return pasteClipboard();
    }    if (k === 'delete' || k === 'backspace') {
      if (selected >= 0 || selSet.size) { deleteSelected(); return true; }
      return false;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'd') {
      // Н8-3: дублировать выбранный объект
      return selected >= 0 ? duplicateSelected() : false;
    }
    // Н11-2: Ctrl+G — объединить выбранное, Ctrl+Shift+G — разгруппировать
    // (раньше простого G — режима гизмо, иначе Ctrl+G до нас не доходит)
    if ((e.ctrlKey || e.metaKey) && k === 'g') {
      if (e.shiftKey) {
        if (selected >= 0 && handles[selected] && handles[selected].prop.group) {
          el.aeUngroup.click();
          return true;
        }
        return false;
      }
      if (el.aeGroup.style.display !== 'none' && el.aeGroupRow.style.display !== 'none') {
        el.aeGroup.click();
        return true;
      }
      return false;
    }
    // Н15-2: стрелки — двигать/вертеть/менять размер выделенного объекта
    // (направления — относительно камеры). Фокус в поле ввода — не наш жест.
    if (e.key && e.key.startsWith('Arrow') && selected >= 0 && !stampMode && !pasteMode) {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return false;
      return arrowNudge(e);
    }
    if (k === 'g') {
      if (selected >= 0) return cycleEditTool();
      return true;
    }
    if (k === 'q' || k === 'e') {
      if (selected >= 0) { rotateSelY(k === 'q' ? -15 : 15); return true; }
      return false;
    }
    return false;
  }

  // поворот выбранного объекта вокруг Y с пересадкой на опору
  function rotateSelY(dDeg) {
    const h = handles[selected];
    if (!h || !app.arena) return;
    h.mesh.rotation.y += dDeg * D2R;
    applyBodyFromMesh(h);
    settleAt(h, h.prop.x, h.prop.z);
    app.arena.updateHolePhysics();
    save();
    syncEditFields();
  }

  // ── Н15-2/Н23-4: стрелки дублируют перенос/поворот ──
  // Направления — ОТНОСИТЕЛЬНО КАМЕРЫ, но приводятся к ОДНОЙ мировой оси
  // (±X или ±Z): клавиша выбирает ось, чьё направление ближе всего к
  // экранному. Н22-3 двигал по камерному вектору — он диагонален миру
  // («не по 1 оси», Н23-4).
  function groundAxes() {
    const c = app.rig.camera;
    const fwd = new THREE.Vector3();
    c.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) {
      // камера смотрит почти вертикально вниз — «экранная вверх»-ось и есть вперёд
      fwd.setFromMatrixColumn(c.matrixWorld, 1);
      fwd.y = 0;
    }
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x); // fwd × up(0,1,0)
    return { fwd, right };
  }

  // Н23-4: экранное направление → ближайшая мировая ось (±X/±Y/±Z).
  // Н28-1: добавлена ось Y — наклонная камера двигает объекты по высоте.
  function axOf(dir) {
    const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
    if (ay >= ax && ay >= az) return new THREE.Vector3(0, dir.y >= 0 ? 1 : -1, 0);
    return ax >= az
      ? new THREE.Vector3(dir.x >= 0 ? 1 : -1, 0, 0)
      : new THREE.Vector3(0, 0, dir.z >= 0 ? 1 : -1);
  }

  // Н28-1: экранные оси камеры в мире («право» — колонка 0, «верх» — колонка 1
  // матрицы камеры). В отличие от groundAxes() НЕ прижаты к полу: наклон
  // камеры превращает «верх экрана» в мировую высоту — это и есть «2 оси
  // по наклону камеры». Кольца поворота/стрелки гизмо работают так же.
  function screenAxes() {
    const c = app.rig.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
    if (!right.lengthSq()) right.set(1, 0, 0);
    if (!up.lengthSq()) up.set(0, 1, 0);
    return { right: right.normalize(), up: up.normalize() };
  }

  // Н28-1: направление → буква мировой оси ('x' | 'y' | 'z') по доминанте
  function axisLetter(v) {
    const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
    return (ay >= ax && ay >= az) ? 'y' : (ax >= az ? 'x' : 'z');
  }

  const _nbA = new THREE.Box3(), _nbA0 = new THREE.Box3(), _nbB = new THREE.Box3(), _nbI = new THREE.Box3();
  function boxOverlapVol(u, v) {
    _nbI.copy(u).intersect(v);
    return Math.max(0, _nbI.max.x - _nbI.min.x)
      * Math.max(0, _nbI.max.y - _nbI.min.y)
      * Math.max(0, _nbI.max.z - _nbI.min.z);
  }
  // Н23-3: создаёт ли сдвиг объекта в (nx, nz) НОВОЕ/БОЛЬШЕЕ пересечение с
  // соседями — стрелки больше не проходят сквозь объекты. Пересечение
  // сравнивается по объёму: выползание из чужого тела разрешено, врезание —
  // нет. Дырки, выделенные (едут вместе), своя группа и «игнор. коллизии»
  // не мешают.
  function nudgeBlocked(h, nx, nz, ny) {
    const m = h.mesh;
    const ox = m.position.x, oy = m.position.y, oz = m.position.z;
    m.updateMatrixWorld(true);
    _nbA0.setFromObject(m);
    m.position.x = nx; m.position.z = nz;
    if (ny !== undefined) m.position.y = ny; // Н28-1: вертикальные стрелки
    m.updateMatrixWorld(true);
    _nbA.setFromObject(m);
    m.position.x = ox; m.position.y = oy; m.position.z = oz;
    m.updateMatrixWorld(true);
    for (const oh of handles) {
      if (oh === h || oh.prop.hole) continue;
      if (selSet.has(handles.indexOf(oh))) continue;
      const gp = oh.prop.group, hp = h.prop.group;
      if (gp && hp && gp === hp) continue;
      _nbB.setFromObject(oh.mesh);
      if (boxOverlapVol(_nbA, _nbB) > boxOverlapVol(_nbA0, _nbB) + 1e-7) return true;
    }
    return false;
  }

  // Н28-1: вертикальный сдвиг стрелками — elev вручную (как драг по Y-стрелке
  // гизмо), в пол не утопить, сквозь соседей не пройти. Возвращает true,
  // если ход заблокирован соседями.
  function moveElevBy(h, dy) {
    const a = app.arena;
    const p = h.prop;
    const ne = Math.max(0, (p.elev || 0) + dy);
    const half = a._halfOf(p);
    if (nudgeBlocked(h, p.x, p.z, ne + half)) return true;
    p.manualElev = true; // Н23-3: высота задана вручную — перенос по X/Z её сохранит
    a.moveProp(h, p.x, p.z, ne);
    return false;
  }

  // Н28-1: «приземлить» — опустить на опору под текущим местом и снять ручную
  // высоту (дальше объект снова едет по опоре вверх И вниз, как в Н23-3)
  function landOnSupport(h) {
    if (h.prop.hole) return; // вырез не «сажается» (Н18-2)
    const elev = supportUnder(h.prop.x, h.prop.z, h.prop, h);
    h.prop.manualElev = false;
    app.arena.moveProp(h, h.prop.x, h.prop.z, elev);
  }

  function arrowNudge(e) {
    const key = e.key, sh = e.shiftKey;
    const h = handles[selected];
    if (!h || !app.arena) return true;
    if (h.prop.hole && h.prop.group) return true; // Н18-1: сгруппированную дырку нельзя двигать и с клавиатуры; несгруппированная — можно
    if (editTool === 'rotate') {
      const step = sh ? 1 : 5;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        rotateSelY(key === 'ArrowLeft' ? -step : step);
        return true;
      }
      if (key !== 'ArrowUp' && key !== 'ArrowDown') return true;
      // Н23-4: ↑/↓ — наклон вокруг ОДНОЙ мировой оси (±X/±Z), ближайшей к
      // экранной горизонтали (была диагональная ось «право-по-экрану»)
      const { right } = groundAxes();
      const axis = axOf(right);
      const q = new THREE.Quaternion().setFromAxisAngle(axis, (key === 'ArrowUp' ? step : -step) * D2R);
      h.mesh.quaternion.premultiply(q); // Euler в mesh.rotation синхронизируется сам
      applyBodyFromMesh(h);
      settleAt(h, h.prop.x, h.prop.z);
      app.arena.updateHolePhysics();
      save();
      syncEditFields();
      return true;
    }
    if (editTool === 'size') { nudgeSize(key, sh); return true; }
    // Н28-1: перенос по ОСЯМ ЭКРАНА (2 оси по наклону камеры, как просили).
    // Клавиша → экранный вектор камеры («право»/«верх»), ось — ближайшая
    // мировая. Камера сверху или у горизонта → ↑/↓ ездят по полу, как раньше;
    // камера наклонена к плоскости XY → ↑/↓ поднимают/опускают по высоте.
    const step = sh ? 0.01 : 0.05;
    const { right, up } = screenAxes();
    let dir;
    if (key === 'ArrowUp') dir = up;
    else if (key === 'ArrowDown') dir = up.clone().negate();
    else if (key === 'ArrowRight') dir = right;
    else if (key === 'ArrowLeft') dir = right.clone().negate();
    else return true;
    const ax = axOf(dir);
    if (ax.y !== 0) {
      // вертикаль: elev ± step, вручную; ↓, упёршись в соседа, — приземлить
      const dy = ax.y * step;
      if (moveElevBy(h, dy)) {
        if (ax.y < 0) {
          landOnSupport(h);
          // Н9-2: группа — приземляем снизу вверх, чтобы верхние встали на нижних
          const members = [...selSet].filter((j) => j !== selected && handles[j])
            .map((j) => handles[j])
            .sort((a, b) => (a.prop.elev || 0) - (b.prop.elev || 0));
          for (const mj of members) landOnSupport(mj);
        } else {
          status2('мешает сосед — объект упёрся');
        }
      } else {
        for (const j of selSet) { // Н9-2: группа едет вместе
          if (j === selected || !handles[j]) continue;
          moveElevBy(handles[j], dy);
        }
      }
      app.arena.updateHolePhysics();
      save();
      syncEditFields();
      return true;
    }
    const dx = ax.x * step, dz = ax.z * step;
    const nx = h.prop.x + dx, nz = h.prop.z + dz;
    // Н23-3: стрелки не проходят сквозь объекты
    if (nudgeBlocked(h, nx, nz)) {
      status2('мешает сосед — объект упёрся');
      return true;
    }
    settleAt(h, nx, nz);
    for (const j of selSet) { // Н9-2: группа едет вместе
      if (j === selected || !handles[j]) continue;
      settleAt(handles[j], handles[j].prop.x + dx, handles[j].prop.z + dz);
    }
    app.arena.updateHolePhysics();
    save();
    syncEditFields();
    return true;
  }

  // размер стрелками (в режиме «размер»). Н28-1: направления — по ЭКРАННЫМ
  // осям камеры, как в переносе: ←/→ меняют габарит вдоль экранного «право»,
  // ↑/↓ — вдоль экранного «верх» (наклонная камера → высота, вид сверху →
  // глубина — старое поведение сверху не изменилось). Shift+↑/↓ — высота
  // принудительно; Shift+←/→ — третья ось, когда экранное «верх» уже высота.
  // Шаг 1 см габарита. У шара/цилиндра «глубины» нет — у них как раньше.
  function nudgeSize(key, sh) {
    const h = handles[selected];
    if (!h || !app.arena) return;
    const st = sizeHalfDims(h.prop); // половины габаритов, м
    const s = 0.01;
    let dims;
    if (h.prop.shape === 'ball') {
      const d = (key === 'ArrowUp' || key === 'ArrowRight') ? s : (key === 'ArrowDown' || key === 'ArrowLeft') ? -s : 0;
      if (!d) return;
      dims = { r: snap10(st.x * 2 + d) / 2 };
    } else if (isRound(h.prop.shape)) {
      const dr = key === 'ArrowRight' ? s : key === 'ArrowLeft' ? -s : 0;
      const dh = key === 'ArrowUp' ? s : key === 'ArrowDown' ? -s : 0;
      if (!dr && !dh) return;
      dims = { r: snap10(st.x * 2 + dr) / 2, hgt: snap10(st.y * 2 + dh) };
    } else {
      const { right, up } = screenAxes();
      const lr = axisLetter(right); // у орбит-камеры «право» всегда горизонтально
      const ud = axisLetter(up);    // «верх» — высота (Y) при наклоне или глубина сверху
      const third = lr === 'x' ? 'z' : 'x';
      const dLR = key === 'ArrowRight' ? s : key === 'ArrowLeft' ? -s : 0;
      const dUD = key === 'ArrowUp' ? s : key === 'ArrowDown' ? -s : 0;
      if (!dLR && !dUD) return;
      let dsx = 0, dsz = 0, dh = 0;
      const add = (t, d) => { if (t === 'x') dsx += d; else if (t === 'y') dh += d; else dsz += d; };
      if (sh) {
        // Shift — вторая пара: высота и недостающая горизонтальная ось
        if (ud === 'y') {
          if (dUD) add(third, dUD);
          if (dLR) add('y', dLR);
        } else {
          if (dUD) add('y', dUD);
          if (dLR) add(third, dLR);
        }
      } else {
        if (dLR) add(lr, dLR);
        if (dUD) add(ud, dUD);
      }
      if (!dsx && !dsz && !dh) return;
      dims = { sx: snap10(st.x * 2 + dsx), sz: snap10(st.z * 2 + dsz), h: snap10(st.y * 2 + dh) };
    }
    handles[selected] = app.arena.resizeProp(h, dims); // точная пересборка — как в endSizeDrag
    settleAt(handles[selected], handles[selected].prop.x, handles[selected].prop.z);
    app.arena.updateHolePhysics();
    reattachGizmo(); // Н16-1: меш пересоздан — гизмо на новый
    syncSizeHandles();
    renderEdit();
    save();
    updCount();
  }

  function deleteSelected() {
    if ((selected < 0 && !selSet.size) || !app.arena) return;
    // Н9-2: удалить всю группу; с конца, чтобы индексы не съезжали
    const victims = new Set(selSet);
    if (selected >= 0) victims.add(selected);
    const sorted = [...victims].filter((j) => handles[j]).sort((a, b) => b - a);
    for (const idx of sorted) app.arena.removeProp(handles[idx]);
    for (const idx of sorted) handles.splice(idx, 1);
    selSet.clear();
    setSelect(-1);
    app.arena.updateHolePhysics(); // вырезы исчезнувшей дырки заживают
    save();
    updCount();
  }

  // ── Н9-3: Ctrl+C копирует выделенное (или группу), Ctrl+V вставляет туда,
  // куда показывает мышка (последняя точка курсора на полу) ──
  function copySelected() {
    const idxs = selSet.size > 1 ? [...selSet].filter((j) => handles[j]) : (selected >= 0 ? [selected] : []);
    if (!idxs.length || !app.arena) return false;
    const anchor = handles[selected >= 0 ? selected : idxs[0]].prop;
    clip = {
      ox: anchor.x, oz: anchor.z,
      items: idxs.map((j) => {
        const p = handles[j].prop;
        return {
          desc: {
            shape: p.shape, sx: p.sx, sz: p.sz, h: p.h, r: p.r, hgt: p.hgt,
            color: p.color, wall: p.wall, pinned: p.pinned, hole: !!p.hole,
            rotX: p.rotX || 0, rotY: p.rotY || 0, rotZ: p.rotZ || 0, elev: p.elev || 0,
            group: p.group || null, // Н10-2: группа копируется вместе с объектами
          },
          dx: p.x - anchor.x, dz: p.z - anchor.z,
          tex: p.tex || null,
        };
      }),
    };
    status2('скопировано: ' + idxs.length);
    return true;
  }

  // Н12-4: Ctrl+V больше не вставляет мгновенно — включает призрачный режим:
  // силуэт буфера ездит за курсором, клик ставит копию (сколько угодно),
  // ПКМ или Esc завершают. Так вставка видна ДО постановки, как у штампа.
  function pasteClipboard() {
    if (!clip || !app.arena) { status2('сначала скопируйте объект: Ctrl+C'); return true; }
    setPaste(true);
    return true;
  }

  // ── Открытие/закрытие ──
  function open() {
    openFlag = true;
    showAnimated(panel);
    el.title.textContent = app.arena ? app.arena.title : '—';
    loadFor(app.arena);
    updCount();
    syncPlates();
    // камеру НЕ перемещаем (просьба 6): конвертируем текущий взгляд в орбиту,
    // кадр на входе/выходе не прыгает
    app.rig.enterOrbitPreserving();
  }
  function close() {
    openFlag = false;
    paintOn = false;
    el.paint.classList.remove('sel');
    paintTool = 'brush';
    el.tool.value = 'brush';
    routeMode = false;
    if (el.rcpadd) setCpAdd(false); // Н19-5: режим «клик ставит чекпоинт» тоже погасить
    el.rmode.classList.remove('active');
    setStamp(null); // Н9-4: выйти из штампа и убрать призрак
    setPaste(false); // Н12-4: убрать призрак вставки
    rmbDown = null;
    mqOn = false; // Н11-1: рамка не должна «зависнуть» после закрытия
    mqStart = null;
    mqDiv.style.display = 'none';
    closePop();
    setSelect(-1); // + gizmo.detach()
    hideAnimated(editWin);
    hideAnimated(panel); // уход с анимацией; display:none ставит anim.js
    shapeObj = null;
    shapeObjSt = null;
  }
  // Н22-2: покадровый хук из main loop — маркеры размера пересчитывают
  // камерную видимость при каждом повороте камеры, а не только по pointermove
  function onFrame() {
    if (openFlag && editTool === 'size') syncSizeHandles();
  }

  // кнопка-переключатель вешается в main.js (open/close)

  return { open, close, reload: loadFor, guard, handleKey, undo, redo, onFrame, get isOpen() { return openFlag; } };
}
