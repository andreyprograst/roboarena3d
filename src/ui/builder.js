// Редактор модели робота — «студия»: своя сцена поверх вьюпорта, арена
// скрыта, робот на стенде с подсветкой.
//
// Панель — только три плашки: ➕ Добавить · 🖌 Рисовать · 💾 Сохранить
// (просьба «плашки только по добавлению, рисованию и сохранению»).
// Выбор объекта в 3D — деталь, колесо, корпус-блок или маркер датчика —
// открывает ОТДЕЛЬНОЕ окно редактирования с числовыми X/Y/Z и поворотом
// (просьбы 3, 5, 9, 10). Колёса двигаются стрелками гизмо (колея/вынос
// меняются симметрично), корпус — обычный выбираемый блок. Второй клик
// (двойной) по выбранной детали переключает стрелки ↔ кольца (просьба 12).
// Горячие клавиши: G — режим, Q/E — поворот, Delete — удалить,
// Ctrl+S — сохранить (просьба 13).
import * as THREE from 'three';
import { DEFAULT_MOUNTS } from '../robot/robot.js';
import { TransformGizmo } from './gizmo.js';
import { hideAnimated, showAnimated } from './anim.js';
import { isoBox, isoCyl, devIcon } from './icons.js';
import { brushFromHit, remapBoxAtlasUV, FACE_CELL } from '../world/arenas.js';
import { startGhostDrag, ghostAteClick } from './ghost.js';

const LS_KEY = 'roboarena3d.mounts';
const YMAX = 0.30;   // высота детали от пола, м
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// Свободные пины (моторы D4–D8+D12 и энкодеры D2/D3 — железо)
const PIN_POOL = [9, 10, 11, 13, 14, 15, 16, 17, 18, 19];
const PIN_LABELS = { 9: 'D9', 10: 'D10', 11: 'D11', 13: 'D13', 14: 'A0', 15: 'A1', 16: 'A2', 17: 'A3', 18: 'A4', 19: 'A5' };

const TYPE = {
  line:   { name: 'Линия',     color: '#e5484d', hex: 0xe5484d },
  sonar:  { name: 'Сонар',     color: '#2a9d8f', hex: 0x2a9d8f },
  bumper: { name: 'Бампер',    color: '#d9903f', hex: 0xd9903f },
  servo:  { name: 'Серво',     color: '#9a6dd7', hex: 0x9a6dd7 },
  gyro:   { name: 'Гироскоп',  color: '#4dabf7', hex: 0x4dabf7 },
  color:  { name: 'Цвет',      color: '#e8c34a', hex: 0xe8c34a },
  light:  { name: 'Свет',      color: '#ffcf5a', hex: 0xffcf5a },
};
// Сколько устройств каждого типа живут на «штатной» механике
// (остальные — с собственным креплением и удаляемые)
const CORE_COUNT = { line: 3, sonar: 1, bumper: 1, servo: 1 };

function pinOptions(sel) {
  return PIN_POOL.map((p) => `<option value="${p}" ${p === sel ? 'selected' : ''}>${PIN_LABELS[p]}</option>`).join('');
}

export function createBuilder({ app, robot, sensors, onMountsChange }) {
  // ── Панель поверх вьюпорта: только плашки ──
  const pane = document.getElementById('viewport-pane');
  // Н29-2a: единый контурный значок внутри текстовой кнопки (стиль тулбара)
  const bi = (id) => `<svg class="bi"><use href="#i-${id}"/></svg>`;
  const panel = document.createElement('div');
  panel.id = 'builder-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <h4>Редактор робота</h4>
    <div class="ap-title">студия · арена скрыта · робот на стенде</div>
    <div class="plate-row">
      <button id="bp-add" class="plate" title="Добавить деталь или устройство"><span class="ic"><svg><use href="#i-plus"/></svg></span><span>Добавить</span></button>
      <button id="bp-chassis" class="plate" title="Корпус: показать/вернуть основной блок"><span class="ic"><svg><use href="#i-box"/></svg></span><span>Корпус</span></button>
      <button id="bp-paint" class="plate" title="Кисть по деталям"><span class="ic"><svg><use href="#i-brush"/></svg></span><span>Рисовать</span></button>
      <button id="bp-save" class="plate" title="Сохранить / загрузить конфигурацию"><span class="ic"><svg><use href="#i-save"/></svg></span><span>Сохранить</span></button>
    </div>
    <div class="ap-hint">клик по детали, колесу, корпусу или датчику — окно редактирования · двойной клик по детали — стрелки ↔ кольца · <b>G</b> — режим, <b>Q/E</b> — поворот, <b>Del</b> — удалить</div>
    <div class="bp-status"></div>
  `;
  pane.appendChild(panel);

  // ── Выпадающие меню плашек (появляются поверх панели) ──
  const addPop = document.createElement('div');
  addPop.id = 'bp-addpop';
  addPop.className = 'pop';
  addPop.style.display = 'none';
  addPop.innerHTML = `
    <div class="ap-sec">Детали модели</div>
    <div class="add-cards">
      <button class="add-card" data-shape="box">${isoBox('#9aa2b1')}<span>＋ Брусок</span></button>
      <button class="add-card" data-shape="cyl">${isoCyl('#9aa2b1')}<span>＋ Цилиндр</span></button>
    </div>
    <div class="ap-sec">Датчики и устройства</div>
    <div class="chip-grid" style="grid-template-columns:repeat(3,1fr)">
      ${['line', 'sonar', 'bumper', 'servo', 'gyro', 'color', 'light'].map((t) =>
        `<button class="chip dev-add" data-t="${t}" title="Добавить: ${TYPE[t].name}">${devIcon(t, TYPE[t].color)}<span>${TYPE[t].name}</span></button>`).join('')}
    </div>
    <div class="ap-hint">новое устройство появится на модели — выберите его, чтобы задать пин и место</div>
  `;
  pane.appendChild(addPop);

  const paintPop = document.createElement('div');
  paintPop.id = 'bp-paintpop';
  paintPop.className = 'pop';
  paintPop.style.display = 'none';
  paintPop.innerHTML = `
    <div class="ap-sec">Рисование</div>
    <label class="ap-lbl">Кисть
      <input type="color" id="bp-color" value="#e5484d">
      <input type="range" id="bp-brushsize" min="3" max="40" value="10" title="диаметр, мм">
      <span class="ap-val" id="bp-bsize-v">10 мм</span>
    </label>
    <div class="ap-hint">кисть рисует по выбранной грани; размер — в мм, на всех гранях одинаковый</div>
  `;
  pane.appendChild(paintPop);

  const savePop = document.createElement('div');
  savePop.id = 'bp-savepop';
  savePop.className = 'pop';
  savePop.style.display = 'none';
  savePop.innerHTML = `
    <div class="ap-sec">Конфигурация</div>
    <div class="ap-row">
      <button id="bp-save" class="primary">Сохранить в файл</button>
      <button id="bp-load">Загрузить</button>
    </div>
    <input type="file" id="bp-file" accept=".json,application/json" style="display:none">
    <div class="ap-row"><button id="bp-reset">Сбросить всё</button></div>
    <div class="ap-hint">один JSON: корпус, колёса, датчики, пины, детали</div>
  `;
  pane.appendChild(savePop);

  // ── Отдельное окно редактирования выбранного объекта ──
  const editWin = document.createElement('div');
  editWin.id = 'builder-edit';
  editWin.className = 'eedit';
  editWin.style.display = 'none';
  editWin.innerHTML = `
    <h5 id="be-title">Выбор</h5>
    <div id="be-body"></div>
    <div class="ap-row"><button id="be-del" style="display:none">${bi('trash')} Удалить</button></div>
  `;
  pane.appendChild(editWin);

  const $b = (root, id) => root.querySelector('#' + id);
  const el = {
    add: $b(panel, 'bp-add'), paint: $b(panel, 'bp-paint'), save: $b(panel, 'bp-save'),
    chassis: $b(panel, 'bp-chassis'),
    status: panel.querySelector('.bp-status'),
    color: $b(paintPop, 'bp-color'), brushsize: $b(paintPop, 'bp-brushsize'), bsizeV: $b(paintPop, 'bp-bsize-v'),
    saveF: $b(savePop, 'bp-save'), load: $b(savePop, 'bp-load'), file: $b(savePop, 'bp-file'), reset: $b(savePop, 'bp-reset'),
    beTitle: $b(editWin, 'be-title'), beBody: $b(editWin, 'be-body'), beDel: $b(editWin, 'be-del'),
  };

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
  addCloseBtn(editWin, () => setSel(null));

  // ── Студия: отдельная сцена, чтобы объекты арены не загораживали вид ──
  const studioScene = new THREE.Scene();
  studioScene.background = new THREE.Color(0x14181f);
  studioScene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2b2620, 0.95));
  const sSun = new THREE.DirectionalLight(0xfff2e0, 2.0);
  sSun.position.set(1.4, 2.4, 1.1);
  sSun.castShadow = true;
  sSun.shadow.mapSize.set(1024, 1024);
  sSun.shadow.camera.left = -1;
  sSun.shadow.camera.right = 1;
  sSun.shadow.camera.top = 1;
  sSun.shadow.camera.bottom = -1;
  sSun.shadow.camera.far = 8;
  sSun.shadow.bias = -0.0005;
  studioScene.add(sSun);
  const sFloor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.65, 0.65, 0.012, 48),
    new THREE.MeshStandardMaterial({ color: 0x232935, roughness: 0.85 }),
  );
  sFloor.position.y = -0.006; // верх диска ровно в y=0 — робот стоит на нём
  sFloor.receiveShadow = true;
  studioScene.add(sFloor);
  const sGrid = new THREE.GridHelper(1.3, 26, 0x3a4150, 0x2a303c);
  sGrid.position.y = 0.001;
  studioScene.add(sGrid);

  // Группа инструментов поверх модели (детская robot.group)
  const eg = new THREE.Group();
  eg.name = 'editGizmos';
  eg.visible = false;
  robot.group.add(eg);

  // ── Маркеры датчиков (по mounts.devices) ──
  function markerList(m) {
    const seen = {};
    const out = [];
    for (const d of m.devices || []) {
      const idx = seen[d.type] || 0;
      seen[d.type] = idx + 1;
      out.push({ kind: d.type, idx, dev: d, core: idx < (CORE_COUNT[d.type] || 0) });
    }
    return out;
  }

  // пределы крепежа — от текущего корпуса (корпус может быть убран)
  function xlim() { const c = robot.mounts.chassis || {}; return c.enabled === false ? 0.07 : (c.w || 0.18) / 2; }
  function zlim() { const c = robot.mounts.chassis || {}; return c.enabled === false ? 0.10 : (c.l || 0.24) / 2; }
  const topY = () => robot.chassisHEff() / 2;

  function markerPos(mk, m) {
    const d = mk.dev;
    // маркеры подняты над моделями датчиков (просьба 5): кружок не перекрывает
    // 3D-модель, а увеличенная невидимая сфера захвата легко ловит клик
    if (mk.kind === 'line') {
      const p = mk.core ? m.line[mk.idx] : d;
      return [p.x, topY() + 0.016, p.z];
    }
    if (mk.kind === 'sonar') {
      const p = mk.core ? m.sonar : d;
      return [p.x, topY() + p.height, p.z];
    }
    if (mk.kind === 'bumper') {
      const b = mk.core ? m.bumper : d;
      return [b.x || 0, (b.height ?? 0.012) + 0.005, b.z];
    }
    if (mk.kind === 'gyro') return [d.x || 0, topY() + 0.018, d.z || 0];
    if (mk.kind === 'color') return [d.x || 0, topY() + 0.020, d.z || 0];
    if (mk.kind === 'light') return [d.x || 0, topY() + 0.020, d.z || 0];
    const p = mk.core ? m.servo : d; // servo
    return [p.x, topY() + 0.032, p.z];
  }

  function markerAnchor(mk, m) {
    // объект, в котором лежат x/z этого маркера
    if (mk.core) {
      if (mk.kind === 'line') return m.line[mk.idx];
      if (mk.kind === 'sonar') return m.sonar;
      if (mk.kind === 'bumper') return m.bumper;
      return m.servo;
    }
    return mk.dev;
  }

  // Высота Y по умолчанию (Н6) — для старых сохранений без поля height
  const DEF_HEIGHT = { line: 0.004, color: 0.004, light: 0.004, gyro: 0.004, sonar: 0.045, bumper: 0.012, servo: 0 };

  function setMarkerXZ(mk, m, x, z) {
    const d = mk.dev;
    if (mk.kind === 'bumper') {
      if (mk.core) m.bumper.z = z; else d.z = z;
      return;
    }
    const p = markerAnchor(mk, m);
    p.x = x; p.z = z;
  }

  function rotateMarker(mk, m, dYaw, dPitch) {
    // Н6: рыскание доступно всем датчикам (в т.ч. бамперу и гироскопу)
    const p = markerAnchor(mk, m);
    p.yawDeg = Math.max(-90, Math.min(90, (p.yawDeg || 0) + dYaw));
    if (mk.kind === 'sonar') {
      p.pitchDeg = Math.max(0, Math.min(30, (p.pitchDeg || 0) + dPitch));
    }
  }

  const markerMeshes = []; // { mesh, entry, hit }
  const hitMeshes = [];
  // кружки маркеров маленькие, сферы захвата (невидимые) — крупные (просьба 5)
  const mkGeo = new THREE.SphereGeometry(0.0075, 18, 12);
  const hitGeo = new THREE.SphereGeometry(0.028, 10, 8);
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

  function rebuildMarkers() {
    for (const { mesh } of markerMeshes) eg.remove(mesh);
    for (const h of hitMeshes) eg.remove(h);
    markerMeshes.length = 0;
    hitMeshes.length = 0;
    for (const entry of markerList(robot.mounts)) {
      const mesh = new THREE.Mesh(mkGeo, new THREE.MeshStandardMaterial({
        color: TYPE[entry.kind].hex, emissive: TYPE[entry.kind].hex, emissiveIntensity: 0.35, roughness: 0.35,
      }));
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.userData.entry = entry;
      eg.add(mesh);
      eg.add(hit);
      markerMeshes.push({ mesh, entry, hit });
    }
    syncMarkers();
  }

  // луч штатного сонора (направление с yaw/pitch)
  const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 0.18)]);
  const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: 0x2a9d8f, transparent: true, opacity: 0.75 }));
  eg.add(beam);

  function syncMarkers() {
    const m = robot.mounts;
    for (const { mesh, hit, entry } of markerMeshes) {
      const [x, y, z] = markerPos(entry, m);
      mesh.position.set(x, y, z);
      hit.position.set(x, y, z);
    }
    const so = m.sonar;
    const yaw = (so.yawDeg || 0) * D2R;
    const p = (so.pitchDeg || 0) * D2R;
    const y0 = topY() + so.height + 0.006;
    const dx = Math.sin(yaw) * Math.cos(p), dy = -Math.sin(p), dz = Math.cos(yaw) * Math.cos(p);
    beamGeo.setFromPoints([
      new THREE.Vector3(so.x, y0, so.z + 0.015),
      new THREE.Vector3(so.x + dx * 0.18, y0 + dy * 0.18, so.z + 0.015 + dz * 0.18),
    ]);
  }

  // ── Гизмо (в студийной сцене) ──
  const gizmo = new TransformGizmo(app.rig.camera, app.rig.renderer.domElement);
  studioScene.add(gizmo.root);

  function findPartMesh(idx) {
    let found = null;
    robot.group.traverse((o) => {
      if (!found && o.userData && o.userData.partIdx === idx) found = o;
    });
    return found;
  }

  function selectedPartObj() {
    return sel.kind === 'part' ? (robot.mounts.parts || [])[sel.i] : null;
  }

  function selectedPartMesh() {
    return sel.kind === 'part' ? findPartMesh(sel.i) : null;
  }

  // координаты детали из меша (учёт поворота качалки серво)
  function partToSpec(part, mesh) {
    const s = part.servo | 0;
    const bases = servoBaseList();
    if (s >= 0 && s < bases.length) {
      const b = bases[s];
      const arm = robot.servos && robot.servos[s] && robot.servos[s].arm;
      const th = arm ? (arm.rotation.y || 0) : 0;
      const lx = mesh.position.x, lz = mesh.position.z;
      part.x = b.x + lx * Math.cos(th) + lz * Math.sin(th);
      part.z = b.z - lx * Math.sin(th) + lz * Math.cos(th);
      part.y = Math.max(0.004, Math.min(YMAX, robot.chassisY() + robot.chassisHEff() / 2 + mesh.position.y));
    } else {
      part.x = Math.max(-xlim() - 0.02, Math.min(xlim() + 0.02, mesh.position.x));
      part.z = Math.max(-zlim() - 0.02, Math.min(zlim() + 0.02, mesh.position.z));
      part.y = Math.max(0.004, Math.min(YMAX, robot.chassisY() + mesh.position.y));
    }
    part.rotX = +(mesh.rotation.x * R2D).toFixed(1);
    part.rotY = +(mesh.rotation.y * R2D).toFixed(1);
    part.rotZ = +(mesh.rotation.z * R2D).toFixed(1);
    syncEditFields();
  }

  // опорные точки серв: №0 — штатный, дальше — доп. из devices
  function servoBaseList() {
    const sv = (robot.mounts.devices || []).filter((d) => d.type === 'servo');
    return [
      { x: robot.mounts.servo.x, z: robot.mounts.servo.z },
      ...sv.slice(1).map((d) => ({ x: d.x, z: d.z })),
    ];
  }

  gizmo.cb = {
    onChange(gz) {
      if (sel.kind === 'part') {
        const part = selectedPartObj();
        const mesh = selectedPartMesh();
        if (part && mesh) partToSpec(part, mesh);
      } else if (sel.kind === 'wheel') {
        wheelFromMesh();
      } else if (sel.kind === 'marker') {
        markerFromMesh();
      }
      void gz;
    },
    onEnd() { apply(); },
  };

  // колесо: стрелки двигают меш → колея (X, симметрично) и вынос (Z)
  function wheelFromMesh() {
    const wm = robot.wheelMeshes[sel.i];
    if (!wm) return;
    const W = robot.mounts.wheels;
    W.track = Math.max(0.12, Math.min(0.30, 2 * Math.abs(wm.position.x)));
    W.z = Math.max(-0.08, Math.min(0.08, wm.position.z));
    robot.applyChassisWheels(); // пересимметрирует оба колеса и моторы
    syncMarkers();
    syncEditFields();
  }

  // маркер датчика: стрелки двигают → крепление в mounts
  function markerFromMesh() {
    const rec = markerMeshes[sel.i];
    if (!rec) return;
    const m = robot.mounts;
    const x = Math.max(-xlim(), Math.min(xlim(), rec.mesh.position.x));
    const z = Math.max(-zlim(), Math.min(zlim(), rec.mesh.position.z));
    setMarkerXZ(rec.entry, m, x, z);
    syncMarkers();
    syncEditFields();
  }

  // ── Кисть по деталям (атлас граней: каждая грань — своя ячейка) ──
  function ensurePartTex(mesh, part) {
    if (!mesh.userData._texCanvas) {
      const box = mesh.geometry && mesh.geometry.type === 'BoxGeometry';
      // UV каждой грани — в свою ячейку атласа, иначе кисть рисует на всех
      // гранях сразу; цвет материала — белый, чтобы map не умножался на цвет
      if (box) remapBoxAtlasUV(mesh.geometry);
      mesh.material.color.setHex(0xffffff);
      const c = document.createElement('canvas');
      c.width = box ? FACE_CELL * 3 : FACE_CELL;
      c.height = box ? FACE_CELL * 2 : FACE_CELL;
      const ctx = c.getContext('2d');
      ctx.fillStyle = part.color || '#9aa2b1';
      ctx.fillRect(0, 0, c.width, c.height);
      mesh.userData._texCanvas = c;
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      mesh.userData._tex = t;
      mesh.material.map = t;
      mesh.material.needsUpdate = true;
    }
    return mesh.userData._texCanvas;
  }

  // Мазок кисти по детали: штамп эллипсов вдоль отрезка от прошлого касания —
  // иначе при быстром движении остаются «точки»
  function paintPartAt(e) {
    const hit = rayPart(e);
    if (!hit || hit.uv === undefined) return;
    const mesh = hit.object;
    const idx = mesh.userData.partIdx;
    const part = (robot.mounts.parts || [])[idx];
    if (!part) return;
    const c = ensurePartTex(mesh, part);
    const ctx = c.getContext('2d');
    const B = brushFromHit(mesh, hit, (+el.brushsize.value / 1000) / 2);
    ctx.fillStyle = el.color.value;
    const px = B.cell ? (B.cell.col + B.u) * FACE_CELL : B.u * c.width;
    const py = B.cell ? (B.cell.row + (1 - B.v)) * FACE_CELL : (1 - B.v) * c.height;
    const cellKey = B.cell ? B.cell.row * 3 + B.cell.col : -1;
    const last = mesh.userData._lastStamp;
    // скачок через шов развёртки (цилиндр/сфера: u.wrap 1→0) — не тянуть
    // мазок через весь канвас, ставим точку заново
    const wrapJump = !B.cell && last && Math.abs(px - last.px) > c.width / 2;
    let from = last && !wrapJump && last.cellKey === cellKey && Math.hypot(px - last.px, py - last.py) < c.width
      ? last : { px, py };
    const r = Math.max(1.5, B.rx || 4);
    const step = Math.max(1, r * 0.45);
    const n = Math.min(80, Math.ceil(Math.hypot(px - from.px, py - from.py) / step));
    for (let i = 0; i <= n; i++) {
      const ix = from.px + ((px - from.px) * i) / Math.max(1, n);
      const iy = from.py + ((py - from.py) * i) / Math.max(1, n);
      ctx.beginPath();
      ctx.ellipse(ix, iy, r, Math.max(1.5, B.ry || r), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    mesh.userData._lastStamp = { px, py, cellKey };
    if (mesh.userData._tex) mesh.userData._tex.needsUpdate = true;
    lastPaintPart = { part, mesh };
  }

  function rayPart(e) {
    setNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    const meshes = [];
    robot.group.traverse((o) => {
      if (o.userData && o.userData.partIdx !== undefined) {
        remapBoxAtlasUV(o.geometry); // до луча: hit.uv должен быть атласным
        meshes.push(o);
      }
    });
    if (!meshes.length) return null;
    const hits = raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0] : null;
  }

  // ── Ввод: выбор / гизмо / кисть / свободное перетаскивание деталей ──
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const dragOff = new THREE.Vector3();
  let active = false;       // редактор открыт
  let mode = null;          // 'gizmo' | 'paint' | 'partdrag'
  let dragKind = 'xz';      // плоскость драга детали под камеру: 'xz' | 'vert'
  let paintOn = false;      // режим кисти
  let sel = { kind: null, i: -1 }; // выбранный объект: part | wheel | chassis | marker
  let lastPaintPart = null;
  let lastX = 0, lastY = 0;
  let hovT = 0, hovHit = false; // троттлинг hover-рейкаста (просьба 8)
  let savedMinDist = null;
  let openPop = null;       // открытое меню плашки

  const canvas = () => app.rig.renderer.domElement;

  function setNdc(e) {
    const r = canvas().getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  // Что под курсором: { kind, i } | null. Приоритет: маркеры → детали →
  // колёса → корпус.
  function pickObject(e) {
    setNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    const mhits = raycaster.intersectObjects([...hitMeshes, ...markerMeshes.map((r) => r.mesh)], false);
    if (mhits.length) {
      const o = mhits[0].object;
      const i = markerMeshes.findIndex((r) => r.mesh === o || r.hit === o);
      if (i >= 0) return { kind: 'marker', i };
    }
    const parts = [];
    robot.group.traverse((o) => { if (o.userData && o.userData.partIdx !== undefined) parts.push(o); });
    if (parts.length) {
      const ph = raycaster.intersectObjects(parts, false);
      if (ph.length) return { kind: 'part', i: ph[0].object.userData.partIdx };
    }
    const wh = raycaster.intersectObjects(robot.wheelMeshes, true);
    if (wh.length) {
      let o = wh[0].object;
      while (o && (o.userData || {}).wheel === undefined) o = o.parent;
      if (o) return { kind: 'wheel', i: o.userData.wheel };
    }
    if (robot.chassisMesh.visible) {
      const ch = raycaster.intersectObject(robot.chassisMesh, false);
      if (ch.length) return { kind: 'chassis', i: 0 };
    }
    return null;
  }

  function setSel(kind, i) {
    // снять прошлую подсветку
    robot.group.traverse((o) => {
      if (o.userData && o.userData.partIdx !== undefined && o.material && o.material.emissive) {
        o.material.emissive.setHex(0x000000);
      }
    });
    robot.chassisMesh.material.emissive.setHex(0x000000);
    sel = { kind: kind || null, i: kind ? i : -1 };
    if (sel.kind === 'part') {
      const mesh = selectedPartMesh();
      if (mesh && mesh.material.emissive) mesh.material.emissive.setHex(0x333311);
      if (mesh) gizmo.attach(mesh);
      if (gizmo.mode === 'rotate') gizmo.setMode('both');
    } else if (sel.kind === 'wheel') {
      gizmo.attach(robot.wheelMeshes[sel.i]);
      gizmo.setMode('move'); // колесо крутить нельзя — только двигать
    } else if (sel.kind === 'marker') {
      const rec = markerMeshes[sel.i];
      if (rec) gizmo.attach(rec.mesh);
      gizmo.setMode('move'); // поворот датчика — числом в окне
    } else if (sel.kind === 'chassis') {
      robot.chassisMesh.material.emissive.setHex(0x333311);
      gizmo.detach();
    } else {
      gizmo.detach();
    }
    renderEdit();
    syncPlateSel(); // 📦 Корпус горит, пока корпус выбран (ПН9-5)
  }

  // ── Окно редактирования ──
  const numRow = (label, f, v, step = 1, extra = '') =>
    `<div class="num-row"><span class="lb">${label}</span><input type="number" data-f="${f}" value="${v}" step="${step}" ${extra}></div>`;

  function renderEdit() {
    if (!sel.kind) {
      hideAnimated(editWin);
      return;
    }
    const m = robot.mounts;
    let html = '';
    if (sel.kind === 'part') {
      const p = (m.parts || [])[sel.i];
      if (!p) { sel = { kind: null, i: -1 }; hideAnimated(editWin); return; }
      el.beTitle.textContent = p.shape === 'cyl' ? 'Цилиндр' : 'Брусок';
      html += numRow('X, мм', 'x', Math.round((p.x || 0) * 1000));
      html += numRow('Y (от пола), мм', 'y', Math.round((p.y || 0) * 1000));
      html += numRow('Z, мм', 'z', Math.round((p.z || 0) * 1000));
      html += `<div class="num-row"><span class="lb">Поворот ° (X·Y·Z)</span>
        <input type="number" data-f="rotX" value="${p.rotX || 0}" step="5" style="width:48px">
        <input type="number" data-f="rotY" value="${p.rotY || 0}" step="5" style="width:48px">
        <input type="number" data-f="rotZ" value="${p.rotZ || 0}" step="5" style="width:48px"></div>`;
      if (p.shape === 'cyl') {
        html += numRow('⌀, мм', 'r', Math.round((p.r || 0.02) * 1000), 1);
        html += numRow('Высота, мм', 'hgt', Math.round((p.hgt || 0.04) * 1000), 1);
      } else {
        html += numRow('Ширина, мм', 'sx', Math.round((p.sx || 0.03) * 1000), 1);
        html += numRow('Глубина, мм', 'sz', Math.round((p.sz || 0.03) * 1000), 1);
        html += numRow('Высота, мм', 'h', Math.round((p.h || 0.03) * 1000), 1);
      }
      html += `<div class="num-row"><span class="lb">Цвет</span><input type="color" data-f="color" value="${p.color || '#9aa2b1'}" style="width:40px;height:26px;padding:0"></div>`;
      const bases = servoBaseList();
      html += `<div class="num-row"><span class="lb">Серво</span><select data-f="servo" style="flex:1">
        <option value="-1">— без серво —</option>
        ${bases.map((_, i) => `<option value="${i}" ${((p.servo | 0) === i) ? 'selected' : ''}>Серво ${i + 1}</option>`).join('')}
      </select></div>`;
      el.beDel.style.display = '';
      el.beDel.innerHTML = bi('trash') + ' Удалить деталь';
    } else if (sel.kind === 'wheel') {
      const w = m.wheels;
      el.beTitle.textContent = 'Колесо';
      html += numRow('⌀, мм', 'r', Math.round((w.r || 0.033) * 2000), 1);
      html += numRow('Ширина, мм', 'width', Math.round((w.width || 0.026) * 1000), 1);
      html += numRow('Колея, мм', 'track', Math.round((w.track || 0.206) * 1000), 2);
      html += numRow('Вынос Z, мм', 'z', Math.round((w.z || 0) * 1000), 2);
      html += numRow('Скорость ×', 'speed', +(w.speed || 1).toFixed(2), 0.05);
      html += `<div class="ap-hint">стрелки гизмо двигают колесо: X — колея, Z — вынос (оба колеса симметрично); Y — автоматически по ⌀</div>`;
      el.beDel.style.display = 'none';
    } else if (sel.kind === 'chassis') {
      const c = m.chassis;
      el.beTitle.textContent = 'Корпус (основа)';
      html += `<label class="ap-lbl"><input type="checkbox" data-f="enabled" ${c.enabled !== false ? 'checked' : ''}> Основной блок на модели</label>`;
      html += `<div class="num-row"><span class="lb">Цвет</span><input type="color" data-f="color" value="${c.color || '#2e3440'}" style="width:40px;height:26px;padding:0"></div>`;
      html += numRow('Ширина, мм', 'w', Math.round((c.w || 0.18) * 1000), 2);
      html += numRow('Высота, мм', 'h', Math.round((c.h || 0.075) * 1000), 1);
      html += numRow('Длина, мм', 'l', Math.round((c.l || 0.24) * 1000), 2);
      html += `<div class="ap-hint">корпус — обычный блок: размер и цвет меняются здесь; X/Z всегда 0 (центр робота)</div>`;
      el.beDel.style.display = 'none';
    } else if (sel.kind === 'marker') {
      const rec = markerMeshes[sel.i];
      if (!rec) { sel = { kind: null, i: -1 }; hideAnimated(editWin); return; }
      const p = markerAnchor(rec.entry, m);
      const d = rec.entry.dev;
      el.beTitle.textContent = TYPE[rec.entry.kind].name + (rec.entry.core ? ' · штатный' : '');
      // Н6: у всех датчиков позиция XYZ и поворот по всем трём осям
      html += numRow('X, мм', 'x', Math.round((p.x || 0) * 1000), 1);
      html += numRow('Высота Y, мм', 'height', Math.round((p.height ?? DEF_HEIGHT[rec.entry.kind]) * 1000), 1);
      html += numRow('Z, мм', 'z', Math.round((p.z || 0) * 1000), 1);
      html += `<div class="num-row"><span class="lb">Поворот ° (рыск·накл·крен)</span>
        <input type="number" data-f="yawDeg" value="${Math.round(p.yawDeg || 0)}" step="5" style="width:44px">
        <input type="number" data-f="pitchDeg" value="${Math.round(p.pitchDeg || 0)}" step="5" style="width:44px">
        <input type="number" data-f="rollDeg" value="${Math.round(p.rollDeg || 0)}" step="5" style="width:44px"></div>`;
      if (rec.entry.kind === 'bumper') {
        html += numRow('Ширина, мм', 'width', Math.round((p.width || 0.12) * 1000), 2);
      }
      if (!rec.entry.core) {
        html += `<div class="num-row"><span class="lb">Пин</span><select data-f="pin" style="flex:1">${pinOptions(d.pin)}</select></div>`;
        el.beDel.style.display = '';
        el.beDel.innerHTML = bi('trash') + ' Удалить устройство';
      } else {
        el.beDel.style.display = 'none';
      }
    }
    el.beBody.innerHTML = html;
    closePop(); // окно редактирования закрывает поповер — не налезают друг на друга
    placeUnderPanel(editWin);
    showAnimated(editWin);
    // обработчики полей
    el.beBody.querySelectorAll('input, select').forEach((inp) => {
      inp.addEventListener('change', () => editField(inp.dataset.f, inp.type === 'checkbox' ? inp.checked : inp.value));
    });
  }

  // обновить числа в открытом окне (после стрелок/гизмо) — без пересоздания
  function syncEditFields() {
    if (!sel.kind || editWin.style.display === 'none') return;
    const m = robot.mounts;
    const setV = (f, v) => {
      const inp = el.beBody.querySelector(`input[data-f="${f}"]`);
      if (inp && document.activeElement !== inp) inp.value = v;
    };
    if (sel.kind === 'part') {
      const p = (m.parts || [])[sel.i];
      if (!p) return;
      setV('x', Math.round((p.x || 0) * 1000));
      setV('y', Math.round((p.y || 0) * 1000));
      setV('z', Math.round((p.z || 0) * 1000));
      setV('rotX', p.rotX || 0); setV('rotY', p.rotY || 0); setV('rotZ', p.rotZ || 0);
    } else if (sel.kind === 'wheel') {
      const w = m.wheels;
      setV('track', Math.round((w.track || 0.206) * 1000));
      setV('z', Math.round((w.z || 0) * 1000));
    } else if (sel.kind === 'marker') {
      const rec = markerMeshes[sel.i];
      if (!rec) return;
      const p = markerAnchor(rec.entry, m);
      setV('x', Math.round((p.x || 0) * 1000));
      setV('height', Math.round((p.height ?? DEF_HEIGHT[rec.entry.kind]) * 1000));
      setV('z', Math.round((p.z || 0) * 1000));
      setV('yawDeg', Math.round(p.yawDeg || 0));
      setV('pitchDeg', Math.round(p.pitchDeg || 0));
      setV('rollDeg', Math.round(p.rollDeg || 0));
    }
  }

  // запись поля из окна редактирования
  function editField(f, v) {
    const m = robot.mounts;
    const num = (def, a, b) => {
      const n = parseFloat(v);
      return Math.max(a, Math.min(b, Number.isFinite(n) ? n : def)) / 1000;
    };
    if (sel.kind === 'part') {
      const p = (m.parts || [])[sel.i];
      if (!p) return;
      if (f === 'x' || f === 'y' || f === 'z') p[f] = num(0, -500, 500);
      else if (f === 'rotX' || f === 'rotY' || f === 'rotZ') p[f] = Math.max(-180, Math.min(180, parseFloat(v) || 0));
      else if (f === 'r' || f === 'hgt' || f === 'sx' || f === 'sz' || f === 'h') p[f] = num(20, 4, 120);
      else if (f === 'color') p.color = v;
      else if (f === 'servo') p.servo = parseInt(v, 10) | 0;
      apply();
      status2('применено');
    } else if (sel.kind === 'wheel') {
      const w = m.wheels;
      if (f === 'r') w.r = num(33, 15, 60);
      else if (f === 'width') w.width = num(26, 10, 50);
      else if (f === 'track') w.track = num(206, 120, 300);
      else if (f === 'z') w.z = num(0, -80, 80);
      else if (f === 'speed') { const n = parseFloat(v); w.speed = Math.max(0.2, Math.min(2, Number.isFinite(n) ? n : 1)); }
      applyCW();
    } else if (sel.kind === 'chassis') {
      const c = m.chassis;
      if (f === 'enabled') c.enabled = !!v;
      else if (f === 'color') c.color = v;
      else if (f === 'w') c.w = num(180, 80, 300);
      else if (f === 'h') c.h = num(75, 30, 140);
      else if (f === 'l') c.l = num(240, 100, 360);
      applyCW();
      status2(c.enabled === false ? 'корпус убран — датчики на «палубе» 2 см' : 'корпус обновлён');
    } else if (sel.kind === 'marker') {
      const rec = markerMeshes[sel.i];
      if (!rec) return;
      const p = markerAnchor(rec.entry, m);
      const kind = rec.entry.kind;
      if (f === 'x') p.x = num(0, -300, 300);
      else if (f === 'z') p.z = num(0, -300, 300);
      else if (f === 'height') p.height = num(DEF_HEIGHT[kind] * 1000, 0, 80);
      else if (f === 'yawDeg') p.yawDeg = Math.max(-180, Math.min(180, parseFloat(v) || 0));
      else if (f === 'pitchDeg') p.pitchDeg = Math.max(-30, Math.min(30, parseFloat(v) || 0));
      else if (f === 'rollDeg') p.rollDeg = Math.max(-45, Math.min(45, parseFloat(v) || 0));
      else if (f === 'width') p.width = num(120, 60, 180);
      else if (f === 'pin') {
        const d = rec.entry.dev;
        const np = parseInt(v, 10);
        const used = usedPins(m, d);
        if (used.has(np)) { status2('пин ' + PIN_LABELS[np] + ' уже занят'); renderEdit(); return; }
        d.pin = np;
      }
      apply();
    }
  }

  el.beDel.addEventListener('click', () => {
    if (sel.kind === 'part') {
      const parts = robot.mounts.parts || [];
      if (sel.i >= 0 && sel.i < parts.length) parts.splice(sel.i, 1);
      setSel(null);
      apply();
    } else if (sel.kind === 'marker') {
      const rec = markerMeshes[sel.i];
      if (rec && !rec.entry.core) {
        const d = rec.entry.dev;
        const di = (robot.mounts.devices || []).indexOf(d);
        if (di >= 0) robot.mounts.devices.splice(di, 1);
        setSel(null);
        structureChanged();
      }
    }
  });

  // ── Плашки и меню ──
  // Поповеры и окно редактирования открываются ПОД панелью (просьба 7)
  function placeUnderPanel(elPop) {
    elPop.style.left = panel.offsetLeft + 'px';
    elPop.style.top = (panel.offsetTop + panel.offsetHeight + 8) + 'px';
  }
  function togglePop(elPop) {
    if (openPop === elPop) { closePop(); return; }
    closePop();
    // режимы-плашки взаимоисключающие (ПН9-5): открыли другую плашку —
    // рисование гаснет, иначе кисть «невидимо» оставалась активной
    if (paintOn && elPop !== paintPop) paintOn = false;
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
  // пока включено рисование; 📦 — пока выбран корпус в окне редактирования.
  function syncPlateSel() {
    el.add.classList.toggle('sel', openPop === addPop);
    el.paint.classList.toggle('sel', paintOn || openPop === paintPop);
    el.save.classList.toggle('sel', openPop === savePop);
    el.chassis.classList.toggle('sel', sel.kind === 'chassis');
  }
  el.add.addEventListener('click', () => togglePop(addPop));
  el.paint.addEventListener('click', () => {
    paintOn = !paintOn;
    if (paintOn) { setSel(null); togglePop(paintPop); }
    else closePop();
    syncPlateSel();
  });
  el.save.addEventListener('click', () => togglePop(savePop));
  // Корпус: вернуть убранный блок и/или открыть его окно редактирования
  el.chassis.addEventListener('click', () => {
    const c = robot.mounts.chassis;
    if (c && c.enabled === false) {
      c.enabled = true;
      applyCW();
      status2('корпус возвращён');
    }
    setSel('chassis', 0);
  });
  el.brushsize.addEventListener('input', () => { el.bsizeV.textContent = el.brushsize.value + ' мм'; });

  // ── Добавление деталей и устройств ──
  // Точка на роботе под курсором для дропа (просьба 7): корпус/детали,
  // иначе — горизонтальная плоскость на высоте верхней грани корпуса.
  // Возвращает координаты в системе детали { x, y, z } (y — от пола) или null.
  function dropOnRobot(e) {
    setNdc(e);
    raycaster.setFromCamera(ndc, app.rig.camera);
    const targets = robot.chassisMesh.visible ? [robot.chassisMesh] : [];
    robot.group.traverse((o) => { if (o.userData && o.userData.partIdx !== undefined) targets.push(o); });
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (hit) {
      const lp = robot.group.worldToLocal(hit.point.clone());
      return { x: lp.x, y: robot.chassisY() + lp.y, z: lp.z };
    }
    const topY = robot.chassisY() + robot.chassisHEff() / 2;
    const top = new THREE.Plane(new THREE.Vector3(0, 1, 0), -topY);
    if (raycaster.ray.intersectPlane(top, hitPoint)) {
      const lp = robot.group.worldToLocal(hitPoint.clone());
      return { x: lp.x, y: topY, z: lp.z };
    }
    return null;
  }
  const clampV = (v, lim) => Math.max(-lim, Math.min(lim, v));

  const addPart = (shape, pos) => {
    const m = robot.mounts;
    if (!Array.isArray(m.parts)) m.parts = [];
    if (m.parts.length >= 24) { status2('максимум 24 детали'); return; }
    const p = shape === 'cyl'
      ? { shape, x: 0, y: 0.10, z: 0.02, r: 0.015, hgt: 0.06, rotX: 0, rotY: 0, rotZ: 0, color: '#9aa2b1', servo: -1 }
      : { shape, x: 0, y: 0.10, z: 0.02, sx: 0.03, sz: 0.03, h: 0.04, rotX: 0, rotY: 0, rotZ: 0, color: '#9aa2b1', servo: -1 };
    if (pos) {
      p.x = clampV(pos.x, xlim() + 0.02);
      p.z = clampV(pos.z, zlim() + 0.02);
      p.y = Math.max(0.004, Math.min(YMAX, pos.y));
    }
    m.parts.push(p);
    closePop();
    apply();
    setSel('part', m.parts.length - 1);
    status2(pos ? 'деталь поставлена — тащите мышью или стрелками' : 'деталь добавлена — тащите мышью или стрелками');
  };

  const addDevice = (type, pos) => {
    const m = robot.mounts;
    const used = usedPins(m, null);
    const free = PIN_POOL.filter((p) => !used.has(p));
    if (type === 'sonar' && free.length < 2) { status2('нужны 2 свободных пина (trig + echo)'); return; }
    if (type !== 'sonar' && !free.length) { status2('свободных пинов нет'); return; }
    const d = type === 'sonar'
      ? { type, trig: free[0], echo: free[1], x: -0.06, z: 0.105, height: 0.045, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }
      : type === 'line' ? { type, pin: free[0], x: 0.055, z: 0.095, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }
      : type === 'bumper' ? { type, pin: free[0], x: 0, z: 0.115, height: 0.012, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }
      : type === 'gyro' ? { type, pin: free[0], x: -0.03, z: -0.08, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }
      : type === 'color' ? { type, pin: free[0], x: 0.035, z: 0.098, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }
      : type === 'light' ? { type, pin: free[0], x: -0.03, z: 0.09, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }
      : { type, pin: free[0], x: -0.05, z: -0.09, height: 0, pitchDeg: 0, yawDeg: 0, rollDeg: 0 };
    if (pos) {
      d.x = clampV(pos.x, 0.12);
      d.z = clampV(pos.z, 0.15);
    }
    m.devices.push(d);
    closePop();
    structureChanged();
    const i = markerMeshes.findIndex((r) => r.entry.dev === d);
    if (i >= 0) setSel('marker', i);
    status2(TYPE[type].name + (pos ? ' поставлен' : ' добавлен') + ' — стрелками на место, пин в окне');
  };

  addPop.querySelectorAll('.add-card').forEach((btn) => {
    const shape = btn.dataset.shape;
    const label = shape === 'cyl' ? 'Цилиндр' : 'Брусок';
    btn.addEventListener('click', () => { if (ghostAteClick()) return; addPart(shape); });
    // перетаскивание карточки на робота (просьба 7)
    btn.addEventListener('pointerdown', (e) => startGhostDrag(e, label, (ev) => {
      const pos = dropOnRobot(ev);
      if (pos) addPart(shape, pos);
    }));
  });
  addPop.querySelectorAll('.dev-add').forEach((btn) => {
    const type = btn.dataset.t;
    btn.addEventListener('click', () => { if (ghostAteClick()) return; addDevice(type); });
    btn.addEventListener('pointerdown', (e) => startGhostDrag(e, TYPE[type].name, (ev) => {
      const pos = dropOnRobot(ev);
      if (pos) addDevice(type, pos);
    }));
  });

  // ── Сохранение/загрузка конфигурации ──
  el.saveF.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(robot.mounts, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'robot-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
    status2('конфигурация сохранена в robot-config.json');
  });
  el.load.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    const f = el.file.files[0];
    el.file.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(String(rd.result));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('bad');
        const mm = JSON.parse(JSON.stringify(DEFAULT_MOUNTS));
        for (const k of ['line', 'sonar', 'bumper', 'servo', 'chassis', 'wheels']) {
          if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) Object.assign(mm[k], data[k]);
        }
        if (Array.isArray(data.line)) mm.line = data.line.map((L) => ({
          x: +L.x || 0, z: +L.z || 0,
          height: Number.isFinite(+L.height) ? +L.height : 0.004,
          pitchDeg: +L.pitchDeg || 0, yawDeg: +L.yawDeg || 0, rollDeg: +L.rollDeg || 0,
        }));
        if (Array.isArray(data.devices)) mm.devices = data.devices.filter((d) => d && TYPE[d.type]);
        if (Array.isArray(data.parts)) mm.parts = data.parts.filter((p) => p && (p.shape === 'box' || p.shape === 'cyl')).slice(0, 24);
        robot.mounts = mm;
        setSel(null);
        applyCW();
        rebuildMarkers();
        status2('конфигурация загружена из файла');
      } catch { status2('не удалось прочитать файл конфигурации'); }
    };
    rd.readAsText(f);
  });
  el.reset.addEventListener('click', () => {
    robot.mounts = JSON.parse(JSON.stringify(DEFAULT_MOUNTS));
    setSel(null);
    applyCW();
    rebuildMarkers();
    closePop();
    status2('настройки робота сброшены');
  });

  function usedPins(m, exceptDev) {
    const used = new Map();
    for (const d of m.devices || []) {
      if (d === exceptDev) continue;
      if (d.type === 'sonar') { used.set(d.trig, 1); used.set(d.echo, 1); }
      else used.set(d.pin, 1);
    }
    return used;
  }

  function status2(t) {
    el.status.textContent = t;
    el.status.style.color = 'var(--danger)';
    clearTimeout(status2._t);
    status2._t = setTimeout(() => { el.status.textContent = ''; }, 2500);
  }

  function structureChanged() {
    setSel(null);
    rebuildMarkers();
    apply();
  }

  // ── Применение и сохранение ──
  function apply() {
    robot.syncMounts(); // пересобирает датчики + детали (в т.ч. на качалках серв)
    try { localStorage.setItem(LS_KEY, JSON.stringify(robot.mounts)); } catch { /* пусто */ }
    syncMarkers();
    // меши пересобраны — гизмо прицепить к актуальному объекту
    if (sel.kind === 'part') {
      const mesh = findPartMesh(sel.i);
      if (mesh) gizmo.attach(mesh); else setSel(null);
    } else if (sel.kind === 'wheel') {
      gizmo.attach(robot.wheelMeshes[sel.i]);
    } else if (sel.kind === 'marker') {
      const rec = markerMeshes[sel.i];
      if (rec) gizmo.attach(rec.mesh);
    }
    if (onMountsChange) onMountsChange();
    syncEditFields();
  }

  function applyCW() {
    robot.applyChassisWheels(); // физика (бокс/касторы) + корпус/колёса/моторы
    apply();                    // датчики/детали зависят от высоты корпуса
  }

  // ── Жесты на канвасе ──
  canvas().addEventListener('pointerdown', (e) => {
    if (!active) return;
    lastX = e.clientX; lastY = e.clientY;
    if (e.button !== 0) return; // ПКМ — поворот, колесо — зум/панорама: это делает риг
    if (paintOn) {
      // кисть забирает ВЕСЬ левый клик: мимо детали — просто ничего не делаем
      // (раньше промах проваливался в выбор/гизмо и камеру крутила орбита —
      // отсюда «рисование через раз»: камера съезжала прямо во время мазка)
      const hit = rayPart(e);
      if (!hit) return;
      mode = 'paint';
      hit.object.userData._lastStamp = null; // новый мазок не тянется от старого
      paintPartAt(e);
      try { canvas().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
      return;
    }
    closePop();
    if (sel.kind && sel.kind !== 'chassis' && gizmo.down(e)) {
      mode = 'gizmo';
      canvas().style.cursor = 'grabbing';
      try { canvas().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
      return;
    }
    const p = pickObject(e);
    if (!p) { setSel(null); mode = null; return; } // пустое место — камера рига
    setSel(p.kind, p.i);
    if (p.kind === 'part') {
      // тащим деталь мышью: плоскость под камеру (просьба «двигать в тех
      // плоскостях, к которым ближе камера») — сверху горизонтальная, сбоку
      // вертикальная через деталь; смещение захвата 3D, без прыжка
      mode = 'partdrag';
      const mesh = selectedPartMesh();
      if (mesh) {
        robot.group.updateWorldMatrix(true, true);
        mesh.getWorldPosition(tmpV);
        dragKind = app.rig.dragPlaneAt(tmpV, dragPlane);
        setNdc(e);
        raycaster.setFromCamera(ndc, app.rig.camera);
        if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
          dragOff.copy(tmpV).sub(hitPoint);
        } else dragOff.set(0, 0, 0);
      }
    } else {
      mode = null; // колесо/корпус/датчик — двигаются стрелками гизмо
    }
    canvas().style.cursor = 'grabbing';
    try { canvas().setPointerCapture(e.pointerId); } catch { /* синтетика */ }
  });

  canvas().addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    void dx; void dy;
    if (!mode) {
      // hover-подсветка: полный pickObject (4 луча) на каждый mousemove дорог —
      // считаем не чаще раза в 50 мс (просьба 8)
      const now = performance.now();
      if (now - hovT >= 50) { hovT = now; hovHit = !!pickObject(e); }
      canvas().style.cursor = hovHit ? 'pointer' : 'grab';
      return;
    }
    if (mode === 'paint') {
      // coalesced-события: промежуточные точки между frame'ами — мазок без разрывов
      const evs = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length)
        ? e.getCoalescedEvents() : [e];
      for (const ev of evs) paintPartAt(ev);
    } else if (mode === 'gizmo') {
      gizmo.move(e);
    } else if (mode === 'partdrag') {
      const mesh = selectedPartMesh();
      const part = selectedPartObj();
      if (!mesh || !part) { mode = null; return; }
      setNdc(e);
      raycaster.setFromCamera(ndc, app.rig.camera);
      // плоскость фиксирована с момента захвата — мышь ведёт деталь 1:1
      if (!raycaster.ray.intersectPlane(dragPlane, hitPoint)) return;
      hitPoint.add(dragOff);
      robot.group.updateWorldMatrix(true, true);
      const parent = mesh.parent || robot.group;
      const lp = parent.worldToLocal(hitPoint.clone());
      mesh.position.x = lp.x;
      mesh.position.z = lp.z;
      if (dragKind === 'vert') mesh.position.y = lp.y; // боковая камера: и по высоте
      partToSpec(part, mesh); // поля окна обновятся
    }
  });

  const endDrag = () => {
    if (mode === 'gizmo') gizmo.up();
    if (mode === 'paint' && lastPaintPart) {
      // зафиксировать канвас детали в part.tex (иначе рисунок пропадёт)
      const { part, mesh } = lastPaintPart;
      if (mesh.userData._texCanvas) {
        try { part.tex = mesh.userData._texCanvas.toDataURL('image/png'); } catch { /* пусто */ }
      }
      lastPaintPart = null;
      apply();
    }
    if (mode === 'partdrag') apply(); // зафиксировать перетаскивание
    mode = null;
    canvas().style.cursor = 'grab';
  };
  canvas().addEventListener('pointerup', endDrag);
  canvas().addEventListener('pointercancel', endDrag);
  canvas().addEventListener('contextmenu', (e) => {
    if (active) e.preventDefault();
  });

  // Двойной клик по выбранной детали: стрелки ↔ кольца (просьба 12)
  canvas().addEventListener('dblclick', (e) => {
    if (!active || paintOn) return;
    const p = pickObject(e);
    if (p && p.kind === sel.kind && p.i === sel.i && sel.kind === 'part') {
      gizmo.setMode(gizmo.mode === 'rotate' ? 'both' : 'rotate');
      status2(gizmo.mode === 'rotate' ? 'кольца поворота' : 'стрелки и кольца');
    }
  });

  // Пока редактор открыт: в режиме кисти ЛКМ всегда наш (промах не должен
  // крутить камеру — «рисование через раз»), иначе — ЛКМ по объекту/гизмо.
  function guard(e) {
    return active && e.button === 0 && !e.altKey && (
      paintOn ? true : (
        !!pickObject(e)
        || (sel.kind !== null && sel.kind !== 'chassis' && !!gizmo.hitTest(e))
      )
    );
  }

  // ── Горячие клавиши (просьба 13); вызывается из main.js ──
  function handleKey(e) {
    // Н20-2: физическая клавиша вместо символа — на русской раскладке
    // e.key даёт 'ы'/'п'/'й' и хоткеи Ctrl+S/G/Q/E не срабатывали.
    const k = e.code && e.code.startsWith('Key')
      ? e.code.slice(3).toLowerCase()
      : (e.key || '').toLowerCase();
    if (e.key === 'Escape') {
      if (openPop) closePop();
      else setSel(null);
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      try { localStorage.setItem(LS_KEY, JSON.stringify(robot.mounts)); } catch { /* пусто */ }
      status2('конфигурация сохранена');
      return true;
    }
    if (k === 'delete' || k === 'backspace') {
      el.beDel.style.display !== 'none' && el.beDel.click();
      return true;
    }
    if (k === 'g') {
      if (sel.kind === 'part') {
        gizmo.setMode(gizmo.mode === 'rotate' ? 'both' : 'rotate');
        status2(gizmo.mode === 'rotate' ? 'кольца поворота' : 'стрелки и кольца');
      }
      return true;
    }
    if (k === 'q' || k === 'e') {
      const d = (k === 'q' ? -15 : 15);
      if (sel.kind === 'part') {
        const p = selectedPartObj();
        if (p) { p.rotY = Math.max(-180, Math.min(180, (p.rotY || 0) + d)); apply(); }
      } else if (sel.kind === 'marker') {
        const rec = markerMeshes[sel.i];
        if (rec) { rotateMarker(rec.entry, robot.mounts, d, 0); apply(); }
      }
      return true;
    }
    return false;
  }

  // ── Открытие/закрытие: робот переезжает в студию и обратно ──
  function open() {
    active = true;
    showAnimated(panel);
    eg.visible = true;
    // студия вместо арены: физика спит, меши стоят на стенде
    robot.frozen = true;
    robot.studioPose = true;
    robot.body.velocity.set(0, 0, 0);
    robot.body.angularVelocity.set(0, 0, 0);
    studioScene.add(robot.group);
    app.rig.setOverride(studioScene, app.rig.camera);
    // камеру НЕ перемещаем (просьба 6) — конвертируем текущий взгляд в орбиту,
    // чтобы при входе/выходе кадр не «прыгал»
    app.rig.enterOrbitPreserving();
    savedMinDist = app.rig.orbit.minDist;
    app.rig.orbit.minDist = 0.18; // ближе, чем обычно — для мелких деталей
    rebuildMarkers();
    setSel(null);
  }

  function close() {
    active = false;
    paintOn = false;
    closePop();
    el.paint.classList.remove('sel');
    hideAnimated(panel);  // уход с анимацией; display:none ставит anim.js
    hideAnimated(editWin);
    eg.visible = false;
    mode = null;
    setSel(null);
    if (sensors) sensors.setDebug(false);
    // робот возвращается на арену
    robot.frozen = false;
    robot.studioPose = false;
    robot.body.position.y = robot.chassisY();
    app.rig.scene.add(robot.group);
    app.rig.setOverride(null);
    if (savedMinDist !== null) {
      app.rig.orbit.minDist = savedMinDist;
      savedMinDist = null;
    }
    if (onMountsChange) onMountsChange();
  }

  return {
    open, close, guard, handleKey,
    get active() { return active; },
  };
}
