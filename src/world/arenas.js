// Арены: Песочница (рампа, ящики), Линия (трасса с судейством), Лабиринт (5×5).
// Пол каждой арены — canvas-текстура: по ней же ИК-датчики линии «видят» яркость.
import * as CANNON from 'cannon-es';
import * as THREE from 'three';

const CANVAS_PX = 1024;    // текстура пола: минимальная ширина канваса (плотность задаёт конструктор)
const WALL_H = 0.3;        // борт песочницы
const WALL_T = 0.05;

// Ячейка текстурного атласа граней: у BoxGeometry UV каждой грани занимают
// 0..1, поэтому рисование в общий канвас «протекает» на все 6 граней сразу.
// Канвас делится на 3×2 ячеек — по одной на грань (порядок граней BoxGeometry:
// ±x, ±y, ±z → materialIndex 0..5). 512 px на грань (ПН10-2): при 256 мазок
// выглядел мыльно-пиксельным, особенно на крупных объектах.
export const FACE_CELL = 512;

// dataURL канваса для хранения в localStorage (Н4). PNG от атласа 1536×1024
// с фото-наклейкой — до 7 МБ, квота localStorage (~5 МБ) переполняется, save()
// падает и рисунки «пропадают» после перезагрузки. WebP сжимает в разы
// (замер: мазки 102→23 КБ); в браузерах без кодировщика webp молча вернётся PNG.
function canvasDataURL(c, q = 0.92) {
  try {
    const u = c.toDataURL('image/webp', q);
    if (u.startsWith('data:image/webp')) return u;
  } catch { /* старый браузер — PNG ниже */ }
  return c.toDataURL('image/png');
}

// Перемапить UV BoxGeometry в атлас 3×2: без этого каждая грань показывает
// ВЕСЬ канвас (у бокса UV каждой грани 0..1), и мазок кисти виден «на всех
// гранях сразу». После ремапа грань fi занимает свою ячейку, а brushFromHit
// переводит глобальные hit.uv обратно в локальные 0..1 грани.
export function remapBoxAtlasUV(geo) {
  if (!geo || geo.type !== 'BoxGeometry' || (geo.userData && geo.userData.atlasUV)) return;
  const uv = geo.attributes.uv;
  if (!uv || uv.count < 24) return;
  for (let f = 0; f < 6; f++) {
    const col = f % 3, row = (f / 3) | 0;
    for (let i = f * 4; i < f * 4 + 4; i++) {
      uv.setXY(i, (col + uv.getX(i)) / 3, (1 - row + uv.getY(i)) / 2);
    }
  }
  uv.needsUpdate = true;
  geo.userData.atlasUV = true;
}

// Параметры кисти для попадания луча в меш: круг в пикселях канваса с
// ПОСТОЯННЫМ размером в миллиметрах на любой грани (раньше радиус считался
// от максимального габарита — кисть «меняла размер» от грани к грани).
// Для box дополнительно возвращает ячейку атласа выбранной грани.
// mm — радиус кисти в метрах. hit — пересечение луча (нужны uv и face).
export function brushFromHit(mesh, hit, mm) {
  const g = mesh.geometry;
  const gp = (g && g.parameters) || {};
  const isBox = g && g.type === 'BoxGeometry';
  const wedge = g && g.userData && g.userData.wedge;
  // Ячейку атласа берём из ГЛОБАЛЬНЫХ UV попадания, а не из
  // hit.face.materialIndex: three (r170) проставляет materialIndex только у
  // мешей с МАССИВОМ материалов, у одиночного материала он всегда 0 — кисть
  // красила все грани в одну ячейку («работает только с 1 гранью»).
  // Н15-6: условие теперь просто по флагу atlasUV — его ставит и вырезанная
  // геометрия (_mergeBoxPieces), у которой type уже не BoxGeometry.
  const atlas = !!(g && g.userData && g.userData.atlasUV);
  let cell = null;
  let u = hit.uv.x, v = hit.uv.y;
  if (atlas) {
    const col = Math.min(2, Math.max(0, Math.floor(u * 3)));
    const row = Math.min(1, Math.max(0, Math.floor((1 - v) * 2)));
    cell = { col, row };
    u = Math.min(1, Math.max(0, u * 3 - col));
    v = Math.min(1, Math.max(0, v * 2 - (1 - row)));
  }
  // Н18-3: регион граней (three geometry.groups) — у CylinderGeometry это
  // боковая поверхность / верхний торец / нижний. У атласных геометрий регион
  // различает cell, а здесь (цилиндр, конус) UV боковой поверхности и торца
  // могут быть почти равны — без номера региона мазок протягивает линию с
  // бока на торец («линии на границах объектов»). У сфер/плоскостей групп
  // нет — остаётся защита по ΔUV.
  let fg = -1;
  if (!atlas && hit.faceIndex != null && hit.faceIndex >= 0 && g.groups && g.groups.length) {
    const i3 = hit.faceIndex * 3;
    for (let k = 0; k < g.groups.length; k++) {
      const gr = g.groups[k];
      if (i3 >= gr.start && i3 < gr.start + gr.count) { fg = k; break; }
    }
  }
  // размеры грани в метрах: u → ширина грани, v → высота
  // fi из ячейки: remapBoxAtlasUV кладёт грань fi в col=fi%3, row=fi/3|0
  const fi = cell ? cell.col + cell.row * 3 : -1;
  let fu = 0.1, fv = 0.1;
  const cutFaces = g && g.userData && g.userData.cutFaces;
  if (cutFaces && fi >= 0) {
    // Н15-6: настоящий вырез — размеры граней хранит сама геометрия
    // (габариты ИСХОДНОГО бокса: UV куска покрывают ту же ячейку, что и у целого)
    const cf = cutFaces[fi] || {};
    fu = cf.u || 0.1; fv = cf.v || 0.1;
  } else if (isBox) {
    const wx = gp.width || 0.1, wy = gp.height || 0.1, wz = gp.depth || 0.1;
    if (fi <= 1) { fu = wz; fv = wy; }        // ±x: глубина × высота
    else if (fi <= 3) { fu = wx; fv = wz; }   // ±y: ширина × глубина
    else { fu = wx; fv = wy; }                // ±z: ширина × высота
  } else if (wedge) {
    // порядок ячеек как в makeWedgeGeometry: низ, задняя стенка, скат, бока
    if (fi === 0) { fu = wedge.w; fv = wedge.d; }
    else if (fi === 1) { fu = wedge.d; fv = wedge.h; }
    else if (fi === 2) { fu = Math.hypot(wedge.w, wedge.h); fv = wedge.d; }
    else { fu = wedge.w; fv = wedge.h; }
  } else if (g && g.type === 'CylinderGeometry') {
    const r = gp.radiusTop || gp.radiusBottom || 0.05;
    fu = Math.max(0.004, 2 * Math.PI * r);    // боковая поверхность (торцы редки)
    fv = Math.max(0.004, gp.height || 0.1);
  } else if (g && g.type === 'SphereGeometry') {
    const r = gp.radius || 0.05;
    fu = 2 * Math.PI * r; fv = Math.PI * r;
  } else if (g && g.type === 'ConeGeometry') {
    const r = gp.radius || 0.05;
    fu = Math.max(0.004, Math.PI * r);        // развёртка конуса
    fv = Math.max(0.004, Math.hypot(r, gp.height || 0.1));
  } else {
    fu = fv = Math.max(gp.width || 0, gp.height || 0, gp.depth || 0,
      (gp.radius || 0) * 2, 0.05);
  }
  fu = Math.max(fu, 0.004); fv = Math.max(fv, 0.004);
  return {
    u, v, cell, fg,
    rx: Math.max(1, (mm / fu) * FACE_CELL),
    ry: Math.max(1, (mm / fv) * FACE_CELL),
    ppmU: FACE_CELL / fu, // пикселей канваса на метр по горизонтали грани
  };
}

// ── Треугольный клин (рампа), Н9-2 ──
// Геометрия с атласом UV (как у бокса 3×2): низ, задняя стенка, скат, два
// бока — у каждой грани своя ячейка, кисть красит грань отдельно.
// Вершины: A..D — низ, E..F — верхнее ребро у стенки x=+W/2.
export function makeWedgeGeometry(w, h, d) {
  const A = [-w / 2, -h / 2, -d / 2], B = [w / 2, -h / 2, -d / 2];
  const C = [w / 2, -h / 2, d / 2], D = [-w / 2, -h / 2, d / 2];
  const E = [w / 2, h / 2, -d / 2], F = [w / 2, h / 2, d / 2];
  const uvXZ = (p) => [(p[0] + w / 2) / w, (p[2] + d / 2) / d];
  const uvZY = (p) => [(p[2] + d / 2) / d, (p[1] + h / 2) / h];
  const uvXY = (p) => [(p[0] + w / 2) / w, (p[1] + h / 2) / h];
  const faces = [
    { cell: [0, 0], tri: [A, B, C, A, C, D], uv: uvXZ }, // низ (нормаль -y)
    { cell: [1, 0], tri: [B, E, F, B, F, C], uv: uvZY }, // задняя стенка (+x)
    { cell: [2, 0], tri: [A, D, F, A, F, E], uv: uvXZ }, // скат
    { cell: [0, 1], tri: [A, E, B], uv: uvXY },          // бок -z
    { cell: [1, 1], tri: [D, C, F], uv: uvXY },          // бок +z
  ];
  const pos = [], uv = [];
  for (const f of faces) {
    for (const p of f.tri) {
      pos.push(p[0], p[1], p[2]);
      uv.push((f.cell[0] + f.uv(p)[0]) / 3, (1 - f.cell[1] + f.uv(p)[1]) / 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  geo.userData.atlasUV = true; // ремап не нужен: UV уже атласные
  geo.userData.wedge = { w, h, d };
  return geo;
}

// Физика клина: выпуклый многогранник с теми же вершинами (грани CCW снаружи)
export function wedgeConvex(w, h, d) {
  const v = (x, y, z) => new CANNON.Vec3(x, y, z);
  return new CANNON.ConvexPolyhedron({
    vertices: [v(-w / 2, -h / 2, -d / 2), v(w / 2, -h / 2, -d / 2), v(w / 2, -h / 2, d / 2),
      v(-w / 2, -h / 2, d / 2), v(w / 2, h / 2, -d / 2), v(w / 2, h / 2, d / 2)],
    faces: [[0, 1, 2, 3], [1, 4, 5, 2], [0, 3, 5, 4], [0, 4, 1], [3, 2, 5]],
  });
}

// Фигура (линия/прямоугольник/круг) в координатах кисти B0→B1 на канвасе.
// Для атласной коробки фигура живёт в ячейке грани B0 (конец обрезается в неё).
function shapeOnCanvas(ctx, c, B0, B1, kind, wM, color, filled) {
  const cw = B0.cell ? FACE_CELL : c.width;
  const chh = B0.cell ? FACE_CELL : c.height;
  const ox = B0.cell ? B0.cell.col * FACE_CELL : 0;
  const oy = B0.cell ? B0.cell.row * FACE_CELL : 0;
  const cl = (t) => Math.min(1, Math.max(0, t));
  const ax = ox + B0.u * cw, ay = oy + (1 - B0.v) * chh;
  const bx = ox + cl(B1.u) * cw, by = oy + (1 - cl(B1.v)) * chh;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, wM * (B0.ppmU || FACE_CELL / 0.1));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'line') {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  } else if (kind === 'rect') {
    const rx = Math.min(ax, bx), ry = Math.min(ay, by);
    const rw = Math.abs(bx - ax), rh = Math.abs(by - ay);
    if (filled) ctx.fillRect(rx, ry, rw, rh); else ctx.strokeRect(rx, ry, rw, rh);
  } else if (kind === 'circle') {
    const r = Math.hypot(bx - ax, by - ay);
    ctx.beginPath();
    ctx.arc(ax, ay, r, 0, Math.PI * 2);
    if (filled) ctx.fill(); else ctx.stroke();
  }
}

// ── Маршрут и судейские правила (редактор арены → localStorage) ──
export function loadRoute(name) {
  try { return JSON.parse(localStorage.getItem('roboarena3d.route.' + name) || 'null'); }
  catch { return null; }
}

export function saveRoute(name, data) {
  try { localStorage.setItem('roboarena3d.route.' + name, JSON.stringify(data)); }
  catch { /* пусто */ }
}

export function clearRoute(name) {
  try { localStorage.removeItem('roboarena3d.route.' + name); } catch { /* пусто */ }
}

// ── Источники света арены (Н29-2b): { x, y, z, color, intensity, distance } ──
// Отдельная подсистема (не препятствие): лампа = светящаяся колба + PointLight.
// Датчик света (sensors._illuminanceAt) собирает их через scene.traverse.
export const LIGHT_LIMITS = { max: 16, minI: 0, maxI: 12, defI: 3, minDist: 0.5, maxDist: 20, defDist: 6 };

export function sanitizeLight(l) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  let color = typeof l.color === 'number' ? (l.color >>> 0) & 0xffffff : 0xfff2d0;
  return {
    x: clamp(num(l.x, 0), -9, 9),
    y: clamp(num(l.y, 1.2), 0.05, 4),
    z: clamp(num(l.z, 0), -9, 9),
    color,
    intensity: clamp(num(l.intensity, LIGHT_LIMITS.defI), LIGHT_LIMITS.minI, LIGHT_LIMITS.maxI),
    distance: clamp(num(l.distance, LIGHT_LIMITS.defDist), LIGHT_LIMITS.minDist, LIGHT_LIMITS.maxDist),
  };
}

export function loadLights(name) {
  try {
    const arr = JSON.parse(localStorage.getItem('roboarena3d.lights.' + name) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, LIGHT_LIMITS.max).map(sanitizeLight);
  } catch { return []; }
}

export function saveLights(name, list) {
  try { localStorage.setItem('roboarena3d.lights.' + name, JSON.stringify(list.map(sanitizeLight))); }
  catch { /* пусто */ }
}

export function clearLights(name) {
  try { localStorage.removeItem('roboarena3d.lights.' + name); } catch { /* пусто */ }
}

// ── Н29-4: фон платформы (пол), стен (бортов) и заднего плана (сцена) ──
// Хранится как три hex-числа 0xRRGGBB в roboarena3d.colors.<name>.
export const ARENA_COLOR_DEFAULTS = { floor: 0xebebeb, wall: 0x3a4150, bg: 0x10141b };
export function sanitizeArenaColors(c) {
  const hex = (v, d) => (Number.isFinite(+v) ? ((+v >>> 0) & 0xffffff) : d);
  c = (c && typeof c === 'object') ? c : {};
  return {
    floor: hex(c.floor, ARENA_COLOR_DEFAULTS.floor),
    wall: hex(c.wall, ARENA_COLOR_DEFAULTS.wall),
    bg: hex(c.bg, ARENA_COLOR_DEFAULTS.bg),
  };
}
export function loadArenaColors(name) {
  try { return sanitizeArenaColors(JSON.parse(localStorage.getItem('roboarena3d.colors.' + name) || 'null')); }
  catch { return { ...ARENA_COLOR_DEFAULTS }; }
}
export function saveArenaColors(name, c) {
  try { localStorage.setItem('roboarena3d.colors.' + name, JSON.stringify(sanitizeArenaColors(c))); }
  catch { /* пусто */ }
}
export function clearArenaColors(name) {
  try { localStorage.removeItem('roboarena3d.colors.' + name); } catch { /* пусто */ }
}
// hex-число → CSS-строка '#rrggbb' (для заливки канваса пола)
export function hexCss(n) { return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0'); }

// ─────────────────────────────────────────────────────────────────────────────
// База: пол-канвас + борт по периметру + сэмплер яркости.
// Поле W×D метров, центр в (0,0).
// ─────────────────────────────────────────────────────────────────────────────
class BaseArena {
  constructor(name, title, sizeW, sizeD, wallHeight) {
    this.name = name;
    this.title = title;
    this.sizeW = sizeW;
    this.sizeD = sizeD;
    this.wallHeight = wallHeight;
    this.startPose = { x: 0, z: 0, yawDeg: 0 };
    this.groundMat = new CANNON.Material('ground');
    // стены — отдельный материал: трение корпус↔стена мешает роботу
    // «взбираться» по стене (при трении 0 корпус задирается носом вверх на 90°)
    this.wallPhysMat = new CANNON.Material('wall');
    this.judge = null;

    this._scene = null;
    this._world = null;
    this._static = [];   // статические тела
    this._meshes = [];   // все меши арены (пол, борта, препятствия) — для dispose
    this._dyn = [];      // динамические (откреплённые) препятствия
    this._props = [];    // дескрипторы добавленных препятствий (для сохранения)
    this._cutStatics = []; // Н25-2: борта и статичные стены (лабиринты) — их физика тоже режется дырками
    // Н25-1: depth-препасс «режущих» мешей (общий материал, одна копия на арену)
    this._prepassMat = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: true, depthTest: true, stencilWrite: false,
    });
    // ПН10-2: плотность пола 256 px/м (длинная сторона ≥1024 px, любая ≤2048 px) —
    // фиксированные 1024 px на поле 8×8 давали мыло. 4×4 (дефолт) не меняется.
    // Важно: H считается из W, т.к. colorAt() предполагает одинаковую плотность по осям.
    const ppm = Math.max(256, 1024 / Math.max(sizeW, sizeD));
    this._canvasW = Math.min(2048, Math.round(sizeW * ppm));
    this._canvasH = Math.round(this._canvasW * sizeD / sizeW);
    this._imgData = null;
    this._meshLayers = new Map(); // покраска произвольных мешей (стены и пр.)
    // Н29-2b: источники света — отдельная подсистема (колба + PointLight)
    this.lights = [];          // дескрипторы ламп (для сохранения/редактора)
    this._lightHandles = [];   // { group, bulb, light, desc } — меши сцены
    this._lightGroup = null;   // общий контейнер ламп (не мешает pickProp)
    // Н29-4: фон пола/бортов/заднего плана (hex 0xRRGGBB, сохраняется по арене)
    const col = loadArenaColors(name);
    this.floorColor = col.floor;
    this.wallColor = col.wall;
    this.bgColor = col.bg;
    this._wallMat = null;      // материал бортов — для живой перекраски
  }

  // ── Сборка пола и бортов; наполнение — в _buildProps() ──
  build(scene, world) {
    this._scene = scene;
    this._world = world;

    // Н29-4: задний план сцены (фон + туман одного цвета)
    scene.background = new THREE.Color(this.bgColor);
    if (scene.fog) scene.fog.color.setHex(this.bgColor);

    const canvas = document.createElement('canvas');
    canvas.width = this._canvasW;
    canvas.height = this._canvasH;
    this._canvas = canvas;
    const ctx = canvas.getContext('2d');
    this._paintFloor(ctx);
    this._imgData = null;
    this._userCanvas = null; // слой краски пересоздаётся при сборке арены

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this._tex = tex;

    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(this.sizeW, this.sizeD),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }),
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);
    this._floorMesh = floorMesh;
    this._meshes.push(floorMesh);

    // Пол — тонкий бокс (не Plane: у составных тел со смещёнными фигурами
    // узкая фаза plane-vs-compound в этой сборке cannon-es даёт перевёрнутые нормали)
    const floorBody = new CANNON.Body({ mass: 0, material: this.groundMat });
    floorBody.addShape(new CANNON.Box(new CANNON.Vec3(this.sizeW / 2 + 0.5, 0.05, this.sizeD / 2 + 0.5)));
    floorBody.position.set(0, -0.05, 0);
    world.addBody(floorBody);
    this._static.push(floorBody);

    // Борт по периметру (Н9-2: материал со stencil-тестом — дырки вырезают
    // проёмы и в бортах). Equal-0: рисуем где стенсил ЧИСТЫЙ (дырок нет);
    // NotEqual-0 здесь был бы ошибкой — он на чистом буфере проваливается
    // везде и прячет ВСЕ объекты (остаются только тени).
    const wallMat = new THREE.MeshStandardMaterial({
      color: this.wallColor, roughness: 0.8,
      stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 0,
      stencilWriteMask: 0, stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
    });
    this._wallMat = wallMat; // Н29-4: живая перекраска бортов
    const W = this.sizeW, D = this.sizeD, H = this.wallHeight, T = WALL_T;
    const walls = [
      { sx: W + T, sz: T, x: 0, z: -(D / 2 + T / 2) },
      { sx: W + T, sz: T, x: 0, z: D / 2 + T / 2 },
      { sx: T, sz: D + T, x: -(W / 2 + T / 2), z: 0 },
      { sx: T, sz: D + T, x: W / 2 + T / 2, z: 0 },
    ];
    for (const w of walls) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.sx, H, w.sz), wallMat);
      mesh.renderOrder = 12; // после stencil-разметки объёмов дырок
      mesh.position.set(w.x, H / 2, w.z);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      this._meshes.push(mesh);
      this._addPrepass(mesh); // Н25-1: depth-препасс для точного счёта стенсила
      const body = new CANNON.Body({ mass: 0, material: this.wallPhysMat });
      body.addShape(new CANNON.Box(new CANNON.Vec3(w.sx / 2, H / 2, w.sz / 2)));
      body.position.set(w.x, H / 2, w.z);
      world.addBody(body);
      this._static.push(body);
      // Н25-2: физика борта тоже режется дырками (раньше проём был только визуальным)
      this._cutStatics.push({ x: w.x, y: H / 2, z: w.z, sx: w.sx, h: H, sz: w.sz, rotZ: 0, mat: this.wallPhysMat, body });
    }

    this._buildProps(scene, world);
    this.updateHolePhysics(); // Н25-2: дырки из сохранённой сцены режут физику сразу, без открытия редактора

    // Н29-2b: источники света (отдельный контейнер — не попадает в pickProp)
    this._lightGroup = new THREE.Group();
    this._lightGroup.name = 'arenaLights';
    scene.add(this._lightGroup);
    this.lights = loadLights(this.name);
    this._lightHandles = [];
    for (const desc of this.lights) this._makeLightHandle(desc);
  }

  // ── Н29-2b: лампа = светящаяся колба + THREE.PointLight ──
  // Датчик света собирает PointLight через scene.traverse; колба лишь визуал.
  _makeLightHandle(desc) {
    const g = new THREE.Group();
    g.position.set(desc.x, desc.y, desc.z);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 16, 12),
      new THREE.MeshStandardMaterial({
        color: desc.color, emissive: desc.color, emissiveIntensity: 1.4,
        roughness: 0.4, metalness: 0,
      }),
    );
    bulb.userData.isLamp = true;
    g.add(bulb);
    // тонкий стержень-держатель до пола — визуальный ориентир высоты
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x555b66, roughness: 0.7, metalness: 0.3 });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, desc.y, 6), stemMat);
    stem.position.y = -desc.y / 2;
    g.add(stem);
    const light = new THREE.PointLight(desc.color, desc.intensity, desc.distance, 1.6);
    light.userData.isLamp = true;
    g.add(light);
    this._lightGroup.add(g);
    const handle = { group: g, bulb, stem, light, desc };
    this._lightHandles.push(handle);
    return handle;
  }

  addLight(desc) {
    if (this.lights.length >= LIGHT_LIMITS.max) return null;
    const d = sanitizeLight(desc || {});
    this.lights.push(d);
    const h = this._lightGroup ? this._makeLightHandle(d) : null;
    saveLights(this.name, this.lights);
    return h;
  }

  removeLight(i) {
    if (i < 0 || i >= this.lights.length) return;
    this.lights.splice(i, 1);
    const h = this._lightHandles[i];
    if (h) {
      this._lightGroup.remove(h.group);
      h.bulb.geometry.dispose(); h.bulb.material.dispose();
      h.stem.geometry.dispose(); h.stem.material.dispose();
      this._lightHandles.splice(i, 1);
    }
    saveLights(this.name, this.lights);
  }

  // Обновить параметры лампы i (частичный desc) — без пересборки сцены.
  updateLight(i, patch) {
    if (i < 0 || i >= this.lights.length) return;
    const d = sanitizeLight({ ...this.lights[i], ...patch });
    this.lights[i] = d;
    const h = this._lightHandles[i];
    if (h) {
      h.desc = d;
      h.group.position.set(d.x, d.y, d.z);
      h.bulb.material.color.setHex(d.color);
      h.bulb.material.emissive.setHex(d.color);
      h.light.color.setHex(d.color);
      h.light.intensity = d.intensity;
      h.light.distance = d.distance;
      // держатель до пола — пересобрать геометрию под новую высоту
      h.stem.geometry.dispose();
      h.stem.geometry = new THREE.CylinderGeometry(0.006, 0.006, d.y, 6);
      h.stem.position.y = -d.y / 2;
    }
    saveLights(this.name, this.lights);
  }

  _paintFloor(ctx) {
    ctx.fillStyle = hexCss(this.floorColor); // Н29-4: фон платформы
    ctx.fillRect(0, 0, this._canvasW, this._canvasH);
  }

  // ── Н29-4: живая перекраска фона (без пересборки арены/сброса робота) ──
  _saveColors() { saveArenaColors(this.name, { floor: this.floorColor, wall: this.wallColor, bg: this.bgColor }); }
  setFloorColor(hex) {
    this.floorColor = (hex >>> 0) & 0xffffff;
    if (this._canvas) this._composite(); // база + пользовательская краска поверх
    this._saveColors();
  }
  setWallColor(hex) {
    this.wallColor = (hex >>> 0) & 0xffffff;
    if (this._wallMat) this._wallMat.color.setHex(this.wallColor);
    this._saveColors();
  }
  setBackdropColor(hex) {
    this.bgColor = (hex >>> 0) & 0xffffff;
    if (this._scene) {
      this._scene.background = new THREE.Color(this.bgColor);
      if (this._scene.fog) this._scene.fog.color.setHex(this.bgColor);
    }
    this._saveColors();
  }

  // ── Н25-1: точный объёмный вырез дырками ──
  // Раньше «рентген»-маркер ставил метку 1 на весь ЭКРАННЫЙ силуэт объёма —
  // вырез прошивал объекты по лучу взгляда: дырка вылезала за границы объекта
  // (шар над боксом выедал яму шире шара, дырка в воздухе резала стену за ней).
  // Теперь режущие меши (объекты/борта/стены) рисуются дважды: depth-препасс
  // (только глубина, renderOrder 10) → маркер дырки считает пересечения луча
  // с объёмом ДО ближайшей поверхности (лицевые грани +1, тыльные −1, только
  // ZPass) → объект рисуется (renderOrder 12) только при стенсиле 0, т.е.
  // вырезается ровно там, где поверхность лежит ВНУТРИ объёма дырки.
  _addPrepass(mesh) {
    const pp = new THREE.Mesh(mesh.geometry, this._prepassMat);
    pp.renderOrder = 10;
    pp.raycast = () => {}; // препасс не участвует в лучах (выбор/рисование)
    mesh.add(pp);
    mesh.userData.prepass = pp;
    return pp;
  }

  // Синхронизация препасса после подмены геометрии (настоящий вырез бокса)
  _syncPrepass(mesh) {
    const pp = mesh.userData && mesh.userData.prepass;
    if (pp) pp.geometry = mesh.geometry;
  }

  // 6 клип-плоскостей OBB меша (чуть внутрь): стенки тоннеля дырки видны
  // только внутри режемого объекта — «крышка» за сквозным проёмом срезается.
  _clipPlanesOf(mesh) {
    mesh.updateWorldMatrix(true, false);
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    const q = new THREE.Quaternion().setFromRotationMatrix(mesh.matrixWorld);
    const c = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const half = [
      (bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2,
    ];
    const axes = [
      new THREE.Vector3(1, 0, 0).applyQuaternion(q),
      new THREE.Vector3(0, 1, 0).applyQuaternion(q),
      new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    ];
    const EPS = 0.001;
    const planes = [];
    for (let a = 0; a < 3; a++) {
      for (const s of [-1, 1]) {
        const n = axes[a].clone().multiplyScalar(-s); // нормаль внутрь бокса
        const face = c.clone().addScaledVector(axes[a], s * (half[a] - EPS));
        planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(n, face));
      }
    }
    return planes;
  }

  _buildProps() {} // переопределяется

  // ── Рисование на полу (мировые координаты) ──
  _k() { return this._canvasW / this.sizeW; }

  drawOnFloor(ctx, wx, wz, wMeters, hMeters, color) {
    const k = this._k();
    ctx.fillStyle = color;
    ctx.fillRect((wx + this.sizeW / 2) * k, (wz + this.sizeD / 2) * k, wMeters * k, hMeters * k);
  }

  _line(ctx, x1, z1, x2, z2, widthM, color) {
    const k = this._k();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, widthM * k);
    ctx.beginPath();
    ctx.moveTo((x1 + this.sizeW / 2) * k, (z1 + this.sizeD / 2) * k);
    ctx.lineTo((x2 + this.sizeW / 2) * k, (z2 + this.sizeD / 2) * k);
    ctx.stroke();
  }

  // Обновить текстуру после рисования
  flushFloor() {
    this._tex.needsUpdate = true;
    this._imgData = null;
  }

  // Яркость пола 0..255 в мировой точке
  sample(x, z) {
    const [r, g, b] = this.colorAt(x, z);
    return (r + g + b) / 3;
  }

  // RGB пола в мировой точке (датчик цвета читает канвас арены)
  colorAt(x, z) {
    if (!this._imgData) {
      this._imgData = this._canvas.getContext('2d').getImageData(0, 0, this._canvasW, this._canvasH).data;
    }
    const k = this._k();
    const px = Math.max(0, Math.min(this._canvasW - 1, Math.round((x + this.sizeW / 2) * k)));
    const py = Math.max(0, Math.min(this._canvasH - 1, Math.round((z + this.sizeD / 2) * k)));
    const i = (py * this._canvasW + px) * 4;
    const d = this._imgData;
    return [d[i], d[i + 1], d[i + 2]];
  }

  _addBoxBody(scene, sx, h, sz, x, y, z, color, quatZ = 0, physMat = null) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sx, h, sz),
      new THREE.MeshStandardMaterial({
        color, roughness: 0.8,
        // Н9-2: базовая геометрия (стены лабиринта и пр.) тоже режется дырками
        // (Equal-0: рисуем только где стенсил чистый — см. комментарий к бортам)
        stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 0,
        stencilWriteMask: 0, stencilFail: THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
      }),
    );
    mesh.renderOrder = 12;
    mesh.position.set(x, y, z);
    if (quatZ) mesh.rotation.z = quatZ;
    mesh.castShadow = mesh.receiveShadow = true;
    this._scene.add(mesh);
    this._meshes.push(mesh);
    this._addPrepass(mesh); // Н25-1: depth-препасс для точного счёта стенсила
    const body = new CANNON.Body({ mass: 0, material: physMat || this.groundMat });
    body.addShape(new CANNON.Box(new CANNON.Vec3(sx / 2, h / 2, sz / 2)));
    body.position.set(x, y, z);
    if (quatZ) body.quaternion.setFromEuler(0, 0, quatZ);
    this._world.addBody(body);
    this._static.push(body);
    // Н25-2: физика статичных стен (лабиринты и пр.) тоже режется дырками
    this._cutStatics.push({ x, y, z, sx, h, sz, rotZ: quatZ || 0, mat: physMat || this.groundMat, body });
    return { mesh, body };
  }

  reset() {
    // динамические препятствия — на исходные точки
    for (const p of this._props) {
      const handle = p._handle;
      if (!handle || handle.body.mass === 0) continue;
      handle.body.position.set(p.x, handle.mesh.position.y, p.z);
      handle.body.velocity.set(0, 0, 0);
      handle.body.angularVelocity.set(0, 0, 0);
      handle.body.quaternion.set(0, 0, 0, 1);
      handle.body.wakeUp();
    }
  }

  syncMeshes() {
    // динамические препятствия: меш следует за телом
    for (const p of this._props) {
      const handle = p._handle;
      if (!handle || handle.body.mass === 0) continue;
      handle.mesh.position.copy(handle.body.position);
      handle.mesh.quaternion.copy(handle.body.quaternion);
    }
  }

  // ── Редактор арены: статические коробки поверх базовой геометрии ──
  addStaticBox({ x, z, sx, sz, h, color = 0x9aa2b1, wall = false }) {
    const { mesh, body } = this._addBoxBody(this._scene, sx, h, sz, x, h / 2, z, color, 0, wall ? this.wallPhysMat : this.groundMat);
    return { mesh, body, prop: { x, z, sx, sz, h, color, wall } };
  }

  removeStaticBox(handle) {
    if (!handle || !this._scene) return;
    if (handle.prop && handle.prop._tex) { handle.prop._tex.dispose(); handle.prop._tex = null; }
    const mi = this._meshes.indexOf(handle.mesh);
    if (mi >= 0) this._meshes.splice(mi, 1);
    this._scene.remove(handle.mesh);
    handle.mesh.geometry.dispose();
    handle.mesh.material.dispose();
    if (this._world) this._world.removeBody(handle.body);
    const bi = this._static.indexOf(handle.body);
    if (bi >= 0) this._static.splice(bi, 1);
    // Н25-2: запись в реестре режемых статик-стен тоже убрать, иначе
    // _rebuildStaticCutBody «воскресит» тело в мире при следующем вызове
    const ci = this._cutStatics.findIndex((st) => st.body === handle.body);
    if (ci >= 0) this._cutStatics.splice(ci, 1);
  }

  moveStaticBox(handle, x, z) {
    handle.body.position.x = x;
    handle.body.position.z = z;
    handle.mesh.position.x = x;
    handle.mesh.position.z = z;
    handle.prop.x = x;
    handle.prop.z = z;
    // Н25-2: реестр режемых статик-стен держим в курсе позиции
    const st = this._cutStatics.find((s) => s.body === handle.body);
    if (st) { st.x = x; st.z = z; }
  }

  // ── Препятствия произвольной формы (редактор арены) ──
  // shape: 'box' | 'cyl' | 'cone' | 'ball' | 'wedge'; pinned=true — вмуровано
  // (mass 0), иначе динамическое (робот может толкать). rotX/rotY/rotZ —
  // поворот вокруг осей (радианы, порядок XYZ — как в THREE и cannon
  // setFromEuler): рампы, наклонные платформы, произвольно повёрнутые стены.
  // elev — подъём низа объекта над полом, м (многоуровневые арены:
  // платформы-этажи, мосты). hole=true — объект-«дырка» (Н9-2): сам не
  // сталкивается, а в пересекаемых боксах вырезает проём (см. updateHolePhysics).
  // group — id постоянной группы (Н10-2): редактор скрепляет объекты кнопкой
  // «Объединить», клик по члену выделяет всю группу; поле переживает resizeProp.
  addProp({ shape = 'box', x = 0, z = 0, sx = 0.1, sz = 0.1, h = 0.1, r = 0.05, hgt = 0.1, color = 0x9aa2b1, wall = false, pinned = true, rotX = 0, rotY = 0, rotZ = 0, elev = 0, hole = false, group = undefined, tex = null, manualElev = false }) {
    let geo, cshape, half, mass;
    if (hole) {
      // объём дырки: цилиндр/конус/шар или бокс; сам по себе он «невесомый».
      // Н21-1: шар-дырка раньше превьюился БОКСОМ (sx/h/sz) с центром на
      // elev + h/2, тогда как вырез считается сферой r с центром elev + r —
      // призрак не совпадал с реальным проёмом ни формой, ни позицией.
      if (shape === 'cyl' || shape === 'cone') {
        // Н23-2: конус-дырка — настоящий конус с сужением кверху (был цилиндр
        // r,r — вырез не повторял форму фигуры); 48 сегментов: силуэт выреза
        // и оранжевый призрак гладкие, без «граней»
        geo = shape === 'cone'
          ? new THREE.CylinderGeometry(0, r, hgt, 48)
          : new THREE.CylinderGeometry(r, r, hgt, 48);
        half = hgt / 2;
      } else if (shape === 'ball') {
        geo = new THREE.SphereGeometry(r, 48, 32);
        half = r;
      } else if (shape === 'wedge') {
        // Н22-1: клин-дырка превьюится самим клином, а не боксом — раньше
        // оранжевый призрак был квадратным, а вырез треугольным
        geo = makeWedgeGeometry(sx, h, sz);
        half = h / 2;
      } else {
        geo = new THREE.BoxGeometry(sx, h, sz);
        half = h / 2;
      }
      cshape = new CANNON.Box(new CANNON.Vec3(0.001, 0.001, 0.001)); // заглушка: Mask=0
      mass = 0;
    } else if (shape === 'ball') {
      geo = new THREE.SphereGeometry(r, 18, 12);
      cshape = new CANNON.Sphere(r);
      half = r; mass = 0.08;
    } else if (shape === 'cyl') {
      geo = new THREE.CylinderGeometry(r, r, hgt, 18);
      // cannon-es Cylinder: ось Y (вершины в плоскости XZ) — флип не нужен
      cshape = new CANNON.Cylinder(r, r, hgt, 12);
      half = hgt / 2; mass = 0.2;
    } else if (shape === 'cone') {
      geo = new THREE.CylinderGeometry(0, r, hgt, 18);
      cshape = new CANNON.Cylinder(0.002, r, hgt, 10);
      half = hgt / 2; mass = 0.12;
    } else if (shape === 'wedge') {
      geo = makeWedgeGeometry(sx, h, sz);
      cshape = wedgeConvex(sx, h, sz);
      half = h / 2; mass = 0.12;
    } else {
      geo = new THREE.BoxGeometry(sx, h, sz);
      cshape = new CANNON.Box(new CANNON.Vec3(sx / 2, h / 2, sz / 2));
      half = h / 2; mass = 0.15;
    }
    const y = elev + half;
    let mesh;
    let inner = null; // Н27: стенки тоннеля дырки — их красит кисть (ensureObjTexture)
    if (hole) {
      // Полупрозрачный оранжевый объём с рёбрами + stencil-резьба (Н9-2):
      // ОДИН проход по лицевым граням ставит метку 1 на весь силуэт объёма
      // (классический «X-ray hole»: два прохода ±1 дали бы net 0 — дырки бы
      // не было вовсе). Сплошные меши (renderOrder 12) эти пиксели не рисуют —
      // получается сквозной проём, а внутренняя поверхность (renderOrder 13,
      // только там, где метка) даёт тоннелю видимые стенки.
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0xff8a2a, transparent: true, opacity: 0.14,
        depthWrite: false, roughness: 0.9, stencilWrite: false,
      }));
      mesh.renderOrder = 1;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85 }),
      );
      edges.renderOrder = 1;
      mesh.add(edges);
      // Н25-1: два прохода объёма — лицевые грани +1, тыльные −1 (только
      // ZPass: считаются пересечения луча с объёмом ДО ближайшей поверхности
      // из depth-препасса). Нечётный счёт = фрагмент поверхности внутри
      // объёма → Equal-0 его не рисует. Вырез повторяет форму дырки и не
      // выходит за границы объекта (старый одиночный Replace-проход метил
      // весь силуэт и резал «рентгеном» всё по лучу взгляда).
      const markerF = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, depthTest: true, side: THREE.FrontSide,
        stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilRef: 1,
        stencilWriteMask: 0xff, stencilFail: THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.IncrementStencilOp,
      }));
      markerF.renderOrder = 11;
      mesh.add(markerF);
      const markerB = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, depthTest: true, side: THREE.BackSide,
        stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilRef: 1,
        stencilWriteMask: 0xff, stencilFail: THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.DecrementStencilOp,
      }));
      markerB.renderOrder = 11;
      mesh.add(markerB);
      // стенки тоннеля: рисуются только в пикселях с меткой дырки. depthTest
      // выключен (глубину там держит препасс, а не нарисованная поверхность);
      // clippingPlanes (syncCutStencil) обрезают стенки по границам режемого
      // объекта — за сквозным проёмом видно фон, а не «крышку» объёма.
      inner = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0x39404d, roughness: 0.95, side: THREE.BackSide,
        depthWrite: false, depthTest: false, clippingPlanes: [],
        stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 1,
        stencilWriteMask: 0, stencilFail: THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
      }));
      inner.renderOrder = 13;
      mesh.add(inner);
      mesh.userData.holeVolume = true;
      // Н18-1 (частичный откат Н16-3): НЕсгруппированная дырка видима —
      // полупрозрачный оранжевый объём и окантовка-рёбра, её можно двигать
      // (drag/гизмо/числовые поля). Сгруппированная — снова невидимый резак
      // (Н11-3: двигается только вместе с группой). Stencil-маркер и стенки
      // тоннеля остаются под управлением syncCutStencil (видны только там,
      // где без них не обойтись — Н17-1), видимость объёма/рёбер после
      // группировки/разгруппировки тоже обновляет syncCutStencil.
      mesh.material.visible = !group;
      edges.material.visible = !group;
    } else {
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color, roughness: 0.75,
        // Н9-2: сплошные меши не рисуют пиксели, помеченные объёмом дырки.
        // Equal-0 — рисуем где стенсил 0 (дырки нет); NotEqual-0 тут был
        // бы инверсией: на чистом буфере он проваливается везде и прячет
        // ВСЕ объекты (пользователь видит только тени).
        stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef: 0,
        stencilWriteMask: 0, stencilFail: THREE.KeepStencilOp,
        stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
      }));
      mesh.renderOrder = 12; // после stencil-разметки дырок (10/11)
      this._addPrepass(mesh); // Н25-1: depth-препасс для точного счёта стенсила
    }
    mesh.castShadow = mesh.receiveShadow = !hole;
    mesh.position.set(x, y, z);
    if (rotX || rotY || rotZ) mesh.rotation.set(rotX, rotY, rotZ);
    this._scene.add(mesh);
    this._meshes.push(mesh);

    const m = hole ? 0 : (pinned ? 0 : mass);
    const body = new CANNON.Body({
      mass: m,
      material: wall ? this.wallPhysMat : this.groundMat,
      angularDamping: 0.3,
      linearDamping: 0.05,
    });
    body.addShape(cshape);
    body.position.set(x, y, z);
    if (rotX || rotY || rotZ) body.quaternion.setFromEuler(rotX, rotY, rotZ); // тот же порядок XYZ
    this._world.addBody(body);
    if (pinned) this._static.push(body);
    else if (!hole) this._dyn.push(body);

    // Н17-2: tex (dataURL рисунка на объекте) обязан переживать addProp —
    // раньше деструктор его отбрасывал, и restoreObjTexture после перезагрузки
    // / переоткрытия редактора / импорта получал p.tex = undefined и молча
    // выходил: все рисунки на объектах «пропадали».
    // Н23-3: manualElev — высота задана вручную (вертикальный драг, поле Y,
    // стрелка Y гизмо): перенос по X/Z сохраняет её, пока опора не станет
    // выше. Посадка на опору (стекинг) снимает флаг — тогда объект снова
    // едет по опоре вверх И ВНИЗ.
    const prop = { shape, x, z, sx, sz, h, r, hgt, color, wall, pinned, rotX, rotY, rotZ, elev, hole, group, tex, manualElev: !!manualElev };
    const handle = { mesh, body, prop };
    prop._handle = handle;
    if (hole) prop._inner = inner; // Н27: кисть/фигуры рисуют по стенкам тоннеля
    this._props.push(prop);
    if (hole) body.collisionFilterMask = 0; // дырка ни с чем не сталкивается
    return handle;
  }

  // Полувысота фигуры (для пересчёта подъёма низа)
  _halfOf(p) {
    return p.shape === 'ball' ? p.r : (p.shape === 'cyl' || p.shape === 'cone') ? p.hgt / 2 : p.h / 2;
  }

  // Изменить размеры объекта: пересоздаём тело/меш, сохраняя текстуру и позицию
  resizeProp(handle, dims) {
    const old = handle.prop;
    const desc = {
      shape: old.shape, x: old.x, z: old.z,
      sx: dims.sx ?? old.sx, sz: dims.sz ?? old.sz, h: dims.h ?? old.h,
      r: dims.r ?? old.r, hgt: dims.hgt ?? old.hgt,
      color: old.color, wall: old.wall, pinned: old.pinned,
      rotX: old.rotX || 0, rotY: old.rotY || 0, rotZ: old.rotZ || 0,
      elev: dims.elev ?? old.elev ?? 0,
      hole: dims.hole ?? !!old.hole, // Н9-2: флаг дырки переживает пересоздание
      group: old.group, // Н10-2: группа тоже переживает resizeProp
      tex: old.tex ?? null, // Н17-2: dataURL рисунка не теряется даже без канваса
      manualElev: !!old.manualElev, // Н23-3: ручная высота тоже переживает пересоздание
    };
    // текстуру переносим: заранее отвязываем от старого prop (иначе dispose)
    const texCanvas = old._texCanvas, tex = old._tex, texData = old.tex;
    old._texCanvas = null; old._tex = null;
    this.removeProp(handle);
    const nh = this.addProp(desc);
    if (texCanvas) {
      // Н18-2: перенос канваса на свежую геометрию. addProp даёт BoxGeometry
      // с raw-UV, а канвас нарисован в АТЛАСНЫХ координатах (remapBoxAtlasUV):
      // без ремапа здесь рисунок до следующего мазка кисти рендерится «вразнобой»
      // — ломается и сдвигается на другие грани. Материал тоже пересоздан с
      // исходным цветом объекта — канвас он должен показывать на белом.
      remapBoxAtlasUV(nh.mesh.geometry);
      nh.prop._texCanvas = texCanvas;
      nh.prop._tex = tex;
      nh.prop.tex = texData;
      // Н27: у дырки текстура — на стенках тоннеля (inner), не на призраке
      const nmat = nh.prop.hole && nh.prop._inner
        ? nh.prop._inner.material : nh.mesh.material;
      nmat.color.set('#ffffff');
      nmat.map = tex;
      nmat.needsUpdate = true;
    }
    return nh;
  }

  removeProp(handle) {
    if (!handle || !this._scene) return;
    const pi = this._props.indexOf(handle.prop);
    if (pi >= 0) this._props.splice(pi, 1);
    const di = this._dyn.indexOf(handle.body);
    if (di >= 0) this._dyn.splice(di, 1);
    // Н15-6: у вырезанного бокса две геометрии (оригинал + вырез); текущая
    // удаляется в removeStaticBox — прибрать вторую, иначе утечка
    if (handle.prop._geo0 && handle.prop._geo0 !== handle.mesh.geometry) handle.prop._geo0.dispose();
    if (handle.prop._cutGeo && handle.prop._cutGeo !== handle.mesh.geometry) handle.prop._cutGeo.dispose();
    handle.prop._geo0 = null; handle.prop._cutGeo = null;
    this.removeStaticBox(handle); // общая зачистка меша/тела
  }

  // Н13-2: призрак дырки виден всегда (см. addProp) — отдельная синхронизация
  // видимости при группировке больше не нужна.
  moveProp(handle, x, z, elev = null) {
    if (elev !== null) {
      handle.prop.elev = elev;
      handle.body.position.y = elev + this._halfOf(handle.prop);
      if (handle.body.mass === 0) handle.mesh.position.y = handle.body.position.y;
    }
    handle.body.position.x = x;
    handle.body.position.z = z;
    if (handle.body.mass === 0) {
      handle.mesh.position.x = x;
      handle.mesh.position.z = z;
    } else {
      handle.body.velocity.set(0, 0, 0);
      handle.body.angularVelocity.set(0, 0, 0);
      handle.mesh.position.set(x, handle.body.position.y, z); // мгновенный телепорт, дальше синхронизирует физика
    }
    handle.prop.x = x;
    handle.prop.z = z;
  }

  // Закрепить/открепить: пересоздаём тело (mass 0 ↔ динамическое)
  setPinned(handle, pinned) {
    if (handle.prop.pinned === pinned) return;
    const b = handle.body;
    const px = b.position.x, py = b.position.y, pz = b.position.z;
    this._world.removeBody(b);
    let si = this._static.indexOf(b);
    if (si >= 0) this._static.splice(si, 1);
    let di = this._dyn.indexOf(b);
    if (di >= 0) this._dyn.splice(di, 1);

    const m = pinned ? 0 : (handle.prop.shape === 'ball' ? 0.08 : handle.prop.shape === 'cyl' ? 0.2 : 0.15);
    const nb = new CANNON.Body({
      mass: m,
      material: handle.prop.wall ? this.wallPhysMat : this.groundMat,
      angularDamping: 0.3,
      linearDamping: 0.05,
    });
    if (handle.prop.shape === 'ball') nb.addShape(new CANNON.Sphere(handle.prop.r));
    else if (handle.prop.shape === 'cyl') nb.addShape(new CANNON.Cylinder(handle.prop.r, handle.prop.r, handle.prop.hgt, 12));
    else if (handle.prop.shape === 'cone') nb.addShape(new CANNON.Cylinder(0.002, handle.prop.r, handle.prop.hgt, 10));
    else if (handle.prop.shape === 'wedge') nb.addShape(wedgeConvex(handle.prop.sx, handle.prop.h, handle.prop.sz));
    else nb.addShape(new CANNON.Box(new CANNON.Vec3(handle.prop.sx / 2, handle.prop.h / 2, handle.prop.sz / 2)));
    nb.position.set(px, py, pz);
    if (handle.prop.rotX || handle.prop.rotY || handle.prop.rotZ) {
      nb.quaternion.setFromEuler(handle.prop.rotX || 0, handle.prop.rotY || 0, handle.prop.rotZ || 0);
    }
    nb.velocity.set(0, 0, 0);
    nb.angularVelocity.set(0, 0, 0);
    this._world.addBody(nb);
    (pinned ? this._static : this._dyn).push(nb);
    handle.body = nb;
    handle.prop.pinned = pinned;
    if (!pinned) nb.wakeUp();
  }

  // ── Объекты-«дырки» (Н9-2): вырезание проёмов в пересекаемых фигурах ──
  // Физика — декомпозиция: тело пересобирается из остатков «фигура минус
  // AABB дырок». Н15-6: у боксов и ВИЗУАЛ настоящий — список частей
  // превращается в объединённую геометрию (проём виден как в 3D-редакторах:
  // сквозь тоннель видны его стенки, а не фон). Н23-6: физику режем у ЛЮБОЙ
  // фигуры — цилиндр/шар/конус раскладываются на y-слои с полосами,
  // вписанными в диск слоя (_cutPiecesRound), клин — на подслои вдоль ската
  // (_cutPiecesWedge). Н23-2: круглые дырки в боксе физику режут «лестницей»
  // (как раньше), но ВИЗУАЛ больше не блоки — гладкий силуэт выреза даёт
  // stencil (48-сегментные резаки); настоящий геометрический вырез остаётся
  // только у прямоугольных/клиновых дырок.
  // Вызывать после перемещения/изменения/удаления props.
  updateHolePhysics() {
    const holes = this._props.filter((p) => p.hole);
    for (const p of this._props) {
      if (p.hole) continue; // маска уже 0 (addProp), вырезать нечего
      this._rebuildCutBody(p, holes, this._cutPieces(p, holes));
      if (p.shape !== 'box') continue; // у не-боксов силуэт выреза — stencil
      const visHoles = holes.filter((hp) => hp !== p && (hp.shape === 'box' || hp.shape === 'wedge'));
      this._applyCutVisual(p, this._cutPiecesBox(p, visHoles));
    }
    // Н25-2: дырки режут и статическую геометрию (борта, стены лабиринтов,
    // _addBoxBody) — раньше проём в стене был только визуальным, и робот
    // в него не проезжал.
    for (const st of this._cutStatics) this._rebuildStaticCutBody(st, holes);
    this.syncCutStencil();
  }

  // Части фигуры p после вычитания дырок (в локальных координатах фигуры).
  // Диспетчер по форме цели: бокс/клин/круглые. Возврат:
  //   null      — дырки не задевают цель (тело не трогаем, Н23-6);
  //   []        — дырка поглотила цель целиком (заглушка 2 мм);
  //   [...]     — список AABB-частей (cx,cy,cz + полуразмеры, локал фигуры).
  _cutPieces(p, holes) {
    if (p.shape === 'box') return this._cutPiecesBox(p, holes);
    if (p.shape === 'wedge') return this._cutPiecesWedge(p, holes);
    if (p.shape === 'cyl' || p.shape === 'cone' || p.shape === 'ball') return this._cutPiecesRound(p, holes);
    return null;
  }

  // Части БОКСА p после вычитания всех дырок (в локальных координатах бокса).
  // Н19-4: круглая дырка разворачивается в список AABB-плит (лестница,
  // обхватывающая фигуру); прочие и наклонённые — как раньше, одним AABB.
  // Н21-1: вычитание идёт по y-полосам (границы — края всех плит внутри
  // бокса). Плиты разных поясов не пересекаются по y, но вычитание
  // «вразнобой» перемалывало высокие остатки: шарообразная дырка давала
  // ~1000 кусков и 235 мс пересборки. В полосе остатки не выходят за её y —
  // каскадного дробления нет (~230 кусков, ~50 мс).
  _cutPiecesBox(p, holes) {
    const holeAabbs = [];
    for (const hp of holes) {
      if (hp === p) continue;
      const a = this._holeAabbLocal(p, hp);
      // касание только если пересекаемся с исходным боксом
      if (Math.abs(a.c.x) < a.hx + p.sx / 2 && Math.abs(a.c.y) < a.hy + p.h / 2
        && Math.abs(a.c.z) < a.hz + p.sz / 2) {
        const slabs = this._holeSlabsLocal(p, hp);
        if (slabs && slabs.length) holeAabbs.push(...slabs);
        else holeAabbs.push(a);
      }
    }
    const full = { cx: 0, cy: 0, cz: 0, hx: p.sx / 2, hy: p.h / 2, hz: p.sz / 2 };
    if (!holeAabbs.length) return [full];
    const y0box = -p.h / 2, y1box = p.h / 2;
    const cuts = new Set([y0box, y1box]);
    for (const s of holeAabbs) {
      const a = s.c.y - s.hy, b = s.c.y + s.hy;
      if (a > y0box && a < y1box) cuts.add(a);
      if (b > y0box && b < y1box) cuts.add(b);
    }
    const ys = [...cuts].sort((u, v) => u - v);
    const pieces = [];
    for (let i = 0; i < ys.length - 1; i++) {
      const b0 = ys[i], b1 = ys[i + 1];
      if (b1 - b0 < 1e-5) continue;
      let band = [{ cx: 0, cy: (b0 + b1) / 2, cz: 0, hx: p.sx / 2, hy: (b1 - b0) / 2, hz: p.sz / 2 }];
      for (const s of holeAabbs) {
        const a = s.c.y - s.hy, b = s.c.y + s.hy;
        if (a >= b1 || b <= b0) continue; // плита вне полосы
        const ya = Math.max(a, b0), yb = Math.min(b, b1);
        const clip = { c: { x: s.c.x, y: (ya + yb) / 2, z: s.c.z }, hx: s.hx, hy: (yb - ya) / 2, hz: s.hz };
        const next = [];
        for (const pc of band) next.push(...this._subtractAabb(pc, clip));
        band = next;
        if (!band.length) break;
      }
      pieces.push(...band);
    }
    return pieces; // может быть пустым: дырка поглотила весь бокс (заглушка)
  }

  // AABB дырок, пересекающихся с фигурой p (в локальных координатах p).
  // ext — полудиагональ фигуры: консервативный тест «задевает ли вообще».
  _holeCutsLocal(p, holes, ext) {
    const cuts = [];
    for (const hp of holes) {
      if (hp === p) continue;
      const a = this._holeAabbLocal(p, hp);
      if (Math.abs(a.c.x) < a.hx + ext && Math.abs(a.c.y) < a.hy + ext
        && Math.abs(a.c.z) < a.hz + ext) cuts.push(a);
    }
    return cuts;
  }

  // Н23-6: части КРУГЛОЙ цели (цилиндр/конус/шар). Слои по y (у цилиндра
  // фактически один, у шара/конуса — с шагом не меньше ~3.5 см), в каждом
  // слое крест из x-полос, ВПИСАННЫХ в диск слоя: z-полуширина полосы —
  // хорда по ДАЛЬНЕМУ концу, радиус слоя — минимум по краям слоя. Физика
  // не вылезает за видимый силуэт (нет «невидимых полок»); робот проходит
  // через дырку свободно: вычитаемые AABB дырок ⊇ сами дырки.
  _cutPiecesRound(p, holes) {
    const R = p.r, HE = p.shape === 'ball' ? R : p.hgt / 2;
    const cuts = this._holeCutsLocal(p, holes, Math.sqrt(R * R + HE * HE));
    if (!cuts.length) return null;
    const y0t = -HE, y1t = HE;
    const set = new Set([y0t, y1t]);
    for (const a of cuts) {
      const lo = a.c.y - a.hy, hi = a.c.y + a.hy;
      if (lo > y0t && lo < y1t) set.add(lo);
      if (hi > y0t && hi < y1t) set.add(hi);
    }
    // ограничить число слоёв (шар/конус): куча границ от нескольких дырок
    // не должна порождать сотни кусков — прореживаем до ≤10 полос
    let ys = [...set].sort((u, v) => u - v);
    if (ys.length - 1 > 10) {
      const inner = ys.slice(1, -1), step = (y1t - y0t) / 10, keep = [];
      let last = y0t;
      for (const yv of inner) { if (yv - last >= step) { keep.push(yv); last = yv; } }
      ys = [y0t, ...keep, y1t];
    }
    const radAt = p.shape === 'ball'
      ? (y) => Math.sqrt(Math.max(0, R * R - y * y))
      : p.shape === 'cone'
        ? (y) => R * (1 - (y + p.hgt / 2) / p.hgt) // сужение кверху
        : () => R;
    const NX = 16;
    const pieces = [];
    // Н23-6 (фикс): слой вписывается в min радиуса на краях — на ВЫСОКОМ
    // слое у шара (полюс) и конуса (вершина) край радиусом 0, и дырка
    // «съедала» весь слой → от фигуры оставалась заглушка. Дробим слой
    // рекурсивно, пока радиус почти не меняется (края+середина), — каждый
    // подслой вписан в свой узкий край, физика ⊆ визуал.
    const emitBand = (ya, yb, depth) => {
      const Ra = radAt(ya), Rb = radAt(yb), Rm = radAt((ya + yb) / 2);
      if (yb - ya > 0.012 && depth < 8 &&
          (Math.max(Ra, Rb, Rm) - Math.min(Ra, Rb, Rm) > 0.02)) {
        const yh = (ya + yb) / 2;
        emitBand(ya, yh, depth + 1); emitBand(yh, yb, depth + 1);
        return;
      }
      const Rl = Math.min(Ra, Rb); // вписать слой в узкий край
      if (Rl < 1e-4) return; // слой выше вершины конуса
      const ym = (ya + yb) / 2;
      const nx = Rl > 0.1 ? NX : Rl > 0.04 ? 10 : 6; // у узкого края меньше полос
      let band = [];
      for (let i = 0; i < nx; i++) {
        const x0 = -Rl + (2 * Rl * i) / nx, x1 = -Rl + (2 * Rl * (i + 1)) / nx;
        const xf = Math.max(Math.abs(x0), Math.abs(x1));
        const wz = Math.sqrt(Math.max(0, Rl * Rl - xf * xf));
        if (wz < 1e-4) continue;
        band.push({ cx: (x0 + x1) / 2, cy: ym, cz: 0, hx: (x1 - x0) / 2, hy: (yb - ya) / 2, hz: wz });
      }
      for (const a of cuts) {
        const lo = a.c.y - a.hy, hi = a.c.y + a.hy;
        if (lo >= yb || hi <= ya) continue;
        const clip = { c: { x: a.c.x, y: (Math.max(lo, ya) + Math.min(hi, yb)) / 2, z: a.c.z },
          hx: a.hx, hy: (Math.min(hi, yb) - Math.max(lo, ya)) / 2, hz: a.hz };
        const next = [];
        for (const pc of band) next.push(...this._subtractAabb(pc, clip));
        band = next;
        if (!band.length) break;
      }
      pieces.push(...band);
    };
    for (let li = 0; li < ys.length - 1; li++) emitBand(ys[li], ys[li + 1], 0);
    return pieces; // может быть пустым: дырка поглотила фигуру (заглушка)
  }

  // Н23-6: части КЛИНА-цели. Слои по y (подслои ≤ 8 мм + границы дырок), в
  // подслое один AABB с x-диапазоном от ската до +sx/2. Скать: материал при
  // x ≥ x0(y), x0 растёт с высотой — для подслоя берём x0 ВЕРХНЕГО края,
  // кусок вписан в наклонную грань (физика не вылезает за визуал).
  _cutPiecesWedge(p, holes) {
    const ext = Math.sqrt(p.sx * p.sx + p.h * p.h + p.sz * p.sz) / 2;
    const cuts = this._holeCutsLocal(p, holes, ext);
    if (!cuts.length) return null;
    const y0t = -p.h / 2, y1t = p.h / 2;
    const set = new Set([y0t, y1t]);
    for (const a of cuts) {
      const lo = a.c.y - a.hy, hi = a.c.y + a.hy;
      if (lo > y0t && lo < y1t) set.add(lo);
      if (hi > y0t && hi < y1t) set.add(hi);
    }
    const ys = [...set].sort((u, v) => u - v);
    const x0at = (y) => (p.sx * (y + p.h / 2)) / p.h - p.sx / 2;
    const pieces = [];
    for (let li = 0; li < ys.length - 1; li++) {
      const b0 = ys[li], b1 = ys[li + 1];
      if (b1 - b0 < 1e-5) continue;
      const sub = Math.max(1, Math.ceil((b1 - b0) / 0.008)); // подслои вдоль ската
      for (let s = 0; s < sub; s++) {
        const ya = b0 + ((b1 - b0) * s) / sub, yb = ya + (b1 - b0) / sub;
        const xa = Math.max(x0at(yb), -p.sx / 2);
        if (p.sx / 2 - xa < 1e-4) continue; // у вершины клина нечего резать
        let band = [{ cx: (xa + p.sx / 2) / 2, cy: (ya + yb) / 2, cz: 0,
          hx: (p.sx / 2 - xa) / 2, hy: (yb - ya) / 2, hz: p.sz / 2 }];
        for (const a of cuts) {
          const lo = a.c.y - a.hy, hi = a.c.y + a.hy;
          if (lo >= yb || hi <= ya) continue;
          const clip = { c: { x: a.c.x, y: (Math.max(lo, ya) + Math.min(hi, yb)) / 2, z: a.c.z },
            hx: a.hx, hy: (Math.min(hi, yb) - Math.max(lo, ya)) / 2, hz: a.hz };
          const next = [];
          for (const pc of band) next.push(...this._subtractAabb(pc, clip));
          band = next;
          if (!band.length) break;
        }
        pieces.push(...band);
      }
    }
    return pieces; // может быть пустым: дырка поглотила фигуру (заглушка)
  }

  // кусок совпадает с исходным боксом (вырезов нет)
  _isFullPiece(pc, p) {
    return pc.hx === p.sx / 2 && pc.hy === p.h / 2 && pc.hz === p.sz / 2;
  }

  // Н15-6: объединённая геометрия частей. UV каждой грани куска пересчитаны
  // по формулам BoxGeometry (0..1 на грань ЦЕЛОГО бокса) и уложены в тот же
  // атлас 3×2, что и remapBoxAtlasUV — краска/заливка по ячейкам работают
  // без изменений (brushFromHit читает cell из глобальных UV).
  _mergeBoxPieces(pieces, sx, h, sz) {
    const n = pieces.length;
    const pos = new Float32Array(n * 72);
    const nor = new Float32Array(n * 72);
    const uv = new Float32Array(n * 48);
    const IdxArr = n * 24 > 65535 ? Uint32Array : Uint16Array;
    const idx = new IdxArr(n * 36);
    const FU = [sz, sz, sx, sx, sx, sx]; // ширина грани fi, м: ±x, ±y, ±z
    const FV = [h, h, sz, sz, h, h];     // высота грани fi, м
    for (let k = 0; k < n; k++) {
      const P = pieces[k];
      const g = new THREE.BoxGeometry(P.hx * 2, P.hy * 2, P.hz * 2);
      g.translate(P.cx, P.cy, P.cz);
      pos.set(g.attributes.position.array, k * 72);
      nor.set(g.attributes.normal.array, k * 72);
      const gp = g.attributes.position;
      for (let f = 0; f < 6; f++) {
        const col = f % 3, row = (f / 3) | 0;
        for (let i = f * 4; i < f * 4 + 4; i++) {
          // локальные координаты вершины (уже с translate куска), нормированные
          // на ГАБАРИТЫ исходного бокса — непрерывная развёртка по всему мешу
          const nx = gp.getX(i) / sx, ny = gp.getY(i) / h, nz = gp.getZ(i) / sz;
          let u, v;
          if (f === 0) { u = 0.5 - nz; v = 0.5 + ny; }       // +x
          else if (f === 1) { u = 0.5 + nz; v = 0.5 + ny; }  // -x
          else if (f === 2) { u = 0.5 + nx; v = 0.5 - nz; }  // +y
          else if (f === 3) { u = 0.5 + nx; v = 0.5 + nz; }  // -y
          else if (f === 4) { u = 0.5 + nx; v = 0.5 + ny; }  // +z
          else { u = 0.5 - nx; v = 0.5 + ny; }               // -z
          uv[k * 48 + i * 2] = (col + u) / 3;
          uv[k * 48 + i * 2 + 1] = (1 - row + v) / 2;
        }
      }
      const gi = g.index.array;
      for (let i = 0; i < 36; i++) idx[k * 36 + i] = gi[i] + k * 24;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.userData.atlasUV = true;  // ремап в ensureObjTexture не тронет (не BoxGeometry)
    geo.userData.cutFaces = FU.map((u, f) => ({ u, v: FV[f] })); // для brushFromHit
    return geo;
  }

  // Н15-6: подменить геометрию меша на вырезанную (или вернуть оригинал,
  // если дырка ушла). Оригинал кэшируется в prop._geo0, вырез — в prop._cutGeo.
  _applyCutVisual(p, pieces) {
    const h = p._handle;
    if (!h || !h.mesh) return;
    const mesh = h.mesh;
    if (!pieces.length) { // дырка поглотила бокс целиком — тело уже заглушка
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    const full = pieces.length === 1 && this._isFullPiece(pieces[0], p);
    if (full) {
      if (p._cutGeo) {
        if (mesh.geometry === p._cutGeo) mesh.geometry = p._geo0;
        this._syncPrepass(mesh); // Н25-1: препасс делит геометрию с мешем
        p._cutGeo.dispose();
        p._cutGeo = null;
      }
      p._geo0 = null;
      return;
    }
    if (!p._geo0) p._geo0 = mesh.geometry; // первый вырез: запомнить оригинал
    if (p._cutGeo && mesh.geometry === p._cutGeo) p._cutGeo.dispose();
    p._cutGeo = this._mergeBoxPieces(pieces, p.sx, p.h, p.sz);
    mesh.geometry = p._cutGeo;
    this._syncPrepass(mesh); // Н25-1: препасс делит геометрию с мешем
  }

  // Н13-2: мировой AABB объёма дырки (для проверки «кого реально резать»).
  // Полуразмеры — как в _holeAabbLocal, но в мировых осях.
  _holeWorldAabb(hp) {
    const eu = (rx, ry, rz) => new THREE.Euler(rx || 0, ry || 0, rz || 0, 'XYZ');
    const hq = new THREE.Quaternion().setFromEuler(eu(hp.rotX, hp.rotY, hp.rotZ));
    const half = hp.shape === 'ball'
      ? { x: hp.r, y: hp.r, z: hp.r } // Н21-1: шар-дырка — сфера r, а не бокс sx/h/sz
      : hp.shape === 'cyl' || hp.shape === 'cone'
        ? { x: hp.r, y: hp.hgt / 2, z: hp.r }
        : { x: (hp.sx || 0) / 2, y: (hp.h || hp.hgt || 0) / 2, z: (hp.sz || 0) / 2 };
    const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(hq);
    const ey = new THREE.Vector3(0, 1, 0).applyQuaternion(hq);
    const ez = new THREE.Vector3(0, 0, 1).applyQuaternion(hq);
    const wx = Math.abs(ex.x) * half.x + Math.abs(ey.x) * half.y + Math.abs(ez.x) * half.z;
    const wy = Math.abs(ex.y) * half.x + Math.abs(ey.y) * half.y + Math.abs(ez.y) * half.z;
    const wz = Math.abs(ex.z) * half.x + Math.abs(ey.z) * half.y + Math.abs(ez.z) * half.z;
    const c = new THREE.Vector3(hp.x, hp.elev + this._halfOf(hp), hp.z);
    return new THREE.Box3(
      new THREE.Vector3(c.x - wx, c.y - wy, c.z - wz),
      new THREE.Vector3(c.x + wx, c.y + wy, c.z + wz),
    );
  }

  // Н15-6: у боксов с настоящим геометрическим вырезом Equal-0 только вредил
  // (метка чужой дырки резала «рентген» сквозь готовый проём).
  // Н23-2/Н23-6: правило стало избирательным. КРУГЛЫЕ дырки (цилиндр/шар/
  // конус) дают ЛЮБОЙ фигуре — включая бокс — гладкий stencil-силуэт (у бокса
  // физика режется лестницей, блоки-геометрия больше не строится);
  // прямоугольные/клиновые дырки режут стенсилом только НЕ-боксы (у бокса
  // там настоящий вырез геометрией). У бортов один wallMat на 4 меша —
  // группируем по материалу.
  syncCutStencil() {
    const holes = this._props.filter((p) => p.hole);
    const aabbs = holes.map((hp) => this._holeWorldAabb(hp));
    const byMat = new Map();
    const needMarker = new Map(); // hp → есть ли «экранный» резак под дыркой
    // Н25-1: главная режемая фигура дырки — для clipping-плоскостей стенок
    // тоннеля (иначе стенки рисовались «крышкой» в воздухе за проёмом).
    const firstHit = new Map();   // hp → первая пересёкшаяся фигура
    const centerHit = new Map();  // hp → фигура, в чей AABB попадает центр дырки
    for (const m of this._meshes) {
      if (m.userData.holeVolume) continue;
      const mat = m.material;
      // кандидаты — только «режущие» материалы: stencilWrite + ref 0
      // (маркер/стенки дырки имеют ref 1, пол вообще без стенсила)
      if (!mat || !mat.stencilWrite || mat.stencilRef !== 0) continue;
      const ud = m.geometry && m.geometry.userData;
      // целый бокс (cutFaces — у геометрии с настоящим вырезом, wedge — клин)
      const isBoxGeo = !!(ud && !ud.wedge && !ud.cutFaces && m.geometry.type === 'BoxGeometry');
      const bb = new THREE.Box3().setFromObject(m);
      let cut = false;
      for (let k = 0; k < holes.length; k++) {
        const hs = holes[k].shape;
        if (isBoxGeo && hs !== 'cyl' && hs !== 'ball' && hs !== 'cone') continue;
        if (!bb.intersectsBox(aabbs[k])) continue;
        cut = true;
        needMarker.set(holes[k], true);
        if (!firstHit.has(holes[k])) firstHit.set(holes[k], m);
        if (!centerHit.has(holes[k])) {
          const hp = holes[k];
          const hc = new THREE.Vector3(hp.x, hp.elev + this._halfOf(hp), hp.z);
          if (bb.containsPoint(hc)) centerHit.set(holes[k], m);
        }
      }
      byMat.set(mat, byMat.get(mat) || cut);
    }
    for (const [mat, cut] of byMat) {
      mat.stencilFunc = cut ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
    }
    // Н17-1: маркер и стенки тоннеля видимы ТОЛЬКО когда дырка пересекает
    // нерезектую фигуру (цилиндр/конус/шар/клин/борт) — там без стенсила
    // никак. Над пустым полем и боксами (настоящий вырез) они «рисовали
    // границы там, где объекта уже нет», и силуэт вылезал за границы дырки.
    // Н18-1: объём и окантовка видимы, пока дырка НЕ в группе (её видно и
    // можно двигать); при группировке/разгруппировке редактор зовёт
    // syncCutStencil — видимость обновляется на месте.
    for (let k = 0; k < holes.length; k++) {
      const p = holes[k];
      const h = p._handle;
      if (!h || !h.mesh) continue;
      const need = !!needMarker.get(p);
      const showVol = !p.group; // Н18-1: сгруппированная дырка — невидимый резак
      h.mesh.material.visible = showVol;
      // Н25-1: стенки тоннеля обрезаются по границам главной режемой фигуры —
      // у сквозного проёма за объектом видно фон, а не «крышку» объёма.
      const prim = centerHit.get(p) || firstHit.get(p) || null;
      const planes = prim ? this._clipPlanesOf(prim) : [];
      for (const ch of h.mesh.children) {
        const cmat = ch.material;
        if (!cmat) continue;
        if (Array.isArray(cmat.clippingPlanes)) cmat.clippingPlanes = planes;
        if (cmat.stencilWrite && cmat.stencilRef === 1) cmat.visible = need;
        else if (ch.isLineSegments) cmat.visible = showVol; // окантовка-рёбра
      }
    }
  }

  // Н27: точка (мировые координаты) внутри объёма дырки? Кисть и фигуры
  // перенаправляются на стенки тоннеля, когда спрятанная стенсилом поверхность
  // ловит «фантомное» попадание луча внутри проёма. Латеральный отступ ~2мм:
  // грани НАСТОЯЩЕГО выреза (бокс/клин) лежат ровно на границе объёма и не
  // должны считаться спрятанными, а поверхности внутри круглого проёма —
  // должны (они проходят сквозь объём, не касаясь стенок).
  holeContainsPoint(p, wp) {
    if (!p || !p.hole || !p._inner) return false;
    const l = p._inner.worldToLocal(wp.clone());
    const e = 0.002;
    if (p.shape === 'ball') return l.length() <= p.r - e;
    if (p.shape === 'cyl' || p.shape === 'cone') {
      if (Math.abs(l.y) > p.hgt / 2) return false;
      const rr = p.shape === 'cone' ? (p.r * (p.hgt / 2 - l.y)) / p.hgt : p.r;
      return Math.hypot(l.x, l.z) <= rr - e;
    }
    if (p.shape === 'wedge') {
      // скат к +x: верхняя граница профиля y = h*(x + sx/2)/sx − h/2
      if (Math.abs(l.x) > p.sx / 2 || Math.abs(l.z) > p.sz / 2 - e) return false;
      const top = -p.h / 2 + (p.h * (l.x + p.sx / 2)) / p.sx;
      return l.y >= -p.h / 2 && l.y <= top - e;
    }
    return Math.abs(l.x) <= p.sx / 2 - e
      && Math.abs(l.z) <= p.sz / 2 - e
      && Math.abs(l.y) <= p.h / 2;
  }

  // Дырка → AABB в ЛОКАЛЬНЫХ координатах бокса (центр = центр тела).
  // Учёт любых поворотов: 8 углов объёма дырки переводим в локал бокса.
  // THREE.Quaternion.setFromEuler ждёт Euler, а не три числа — с числами он
  // молча оставляет единичный кватернион и поворот дырки/бокса терялся.
  _holeAabbLocal(p, hp) {
    const eu = (rx, ry, rz) => new THREE.Euler(rx || 0, ry || 0, rz || 0, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(eu(p.rotX, p.rotY, p.rotZ));
    const qi = q.clone().invert();
    const hc = new THREE.Vector3(hp.x, hp.elev + this._halfOf(hp), hp.z);
    // Н23-6: центр цели — _halfOf (у цилиндра/шара/конуса нет p.h)
    const pc = new THREE.Vector3(p.x, p.elev + this._halfOf(p), p.z);
    const lcenter = hc.clone().sub(pc).applyQuaternion(qi);
    const hq = new THREE.Quaternion().setFromEuler(eu(hp.rotX, hp.rotY, hp.rotZ));
    const half = hp.shape === 'ball'
      ? { x: hp.r, y: hp.r, z: hp.r } // Н21-1: шар-дырка — сфера r, а не бокс sx/h/sz
      : hp.shape === 'cyl' || hp.shape === 'cone'
        ? { x: hp.r, y: hp.hgt / 2, z: hp.r }
        : { x: (hp.sx || 0) / 2, y: (hp.h || hp.hgt || 0) / 2, z: (hp.sz || 0) / 2 };
    const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(hq);
    const ey = new THREE.Vector3(0, 1, 0).applyQuaternion(hq);
    const ez = new THREE.Vector3(0, 0, 1).applyQuaternion(hq);
    for (const v of [ex, ey, ez]) v.applyQuaternion(qi);
    const hx = Math.abs(ex.x) * half.x + Math.abs(ey.x) * half.y + Math.abs(ez.x) * half.z;
    const hy = Math.abs(ex.y) * half.x + Math.abs(ey.y) * half.y + Math.abs(ez.y) * half.z;
    const hz = Math.abs(ex.z) * half.x + Math.abs(ey.z) * half.y + Math.abs(ez.z) * half.z;
    return { c: lcenter, hx, hy, hz };
  }

  // Н19-4/Н22-1: дырки сложных форм (цилиндр/шар/конус/клин) — вырез не
  // квадратом, а «лестницей» из AABB-плит, ОБХВАТЫВАЮЩЕЙ фигуру (вырез ⊇
  // фигура: шарик и бочка проходят свободно, не цепляясь за углы).
  // Н21-1: лестница круга — диск из центральных полос и «шапок» у
  // касательных (см. disc ниже).
  // Требование — вертикальная ось фигуры в мире И в локале бокса (наклон
  // дырки/бокса по X/Z отменяет лестницу, остаётся AABB). Поворот вокруг Y
  // не мешает круглым формам: он сохраняет вертикаль и осевость AABB-плит;
  // у клина скат привязан к направлению — rotY дырки и бокса должен быть ≈0.
  _holeSlabsLocal(p, hp) {
    const TILT = 1e-3;
    if (Math.abs(p.rotX || 0) >= TILT || Math.abs(p.rotZ || 0) >= TILT) return null;
    const shape = hp.shape;
    if (shape !== 'cyl' && shape !== 'ball' && shape !== 'cone' && shape !== 'wedge') return null;
    if (shape !== 'ball' // шар поворотно-инвариантен
      && (Math.abs(hp.rotX || 0) >= TILT || Math.abs(hp.rotZ || 0) >= TILT)) return null;

    const eu = (rx, ry, rz) => new THREE.Euler(rx || 0, ry || 0, rz || 0, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(eu(p.rotX, p.rotY, p.rotZ));
    const qi = q.clone().invert();
    const hc = new THREE.Vector3(hp.x, hp.elev + this._halfOf(hp), hp.z);
    // Н23-6: центр цели — _halfOf (у цилиндра/шара/конуса нет p.h)
    const pc = new THREE.Vector3(p.x, p.elev + this._halfOf(p), p.z);
    const c = hc.clone().sub(pc).applyQuaternion(qi); // центр дырки в локале бокса

    const slabs = [];
    const add = (x0, x1, y0, y1, z0, z1) => {
      if (x1 - x0 < 1e-5 || y1 - y0 < 1e-5 || z1 - z0 < 1e-5) return;
      slabs.push({
        c: new THREE.Vector3((x0 + x1) / 2 + c.x, (y0 + y1) / 2 + c.y, (z0 + z1) / 2 + c.z),
        hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2,
      });
    };
    const chord = (r, t) => Math.sqrt(Math.max(0, r * r - t * t));
    // полосы по x в пределах |x| ≤ w (обхват: ширма по БЛИЖНЕМУ к центру
    // концу полосы: wz = √(r² − min|x-концов|²))
    const strips = (r, y0, y1, K, w) => {
      if (r < 1e-4 || w < 1e-4) return;
      w = Math.min(w, r);
      for (let i = 0; i < K; i++) {
        const x0 = -w + (2 * w * i) / K, x1 = -w + (2 * w * (i + 1)) / K;
        const xn = Math.min(Math.abs(x0), Math.abs(x1));
        const wz = chord(r, xn);
        add(x0, x1, y0, y1, -wz, wz);
      }
    };
    // Н21-1: диск r — центральные полосы по x (|x| ≤ cos30°·r) плюс 4
    // «шапки» полосами по z (|z| ≤ sin30°·r, x от cos30°·r до хорды ближнего
    // конца). Старые равномерные полосы до касательной давали «крест»:
    // крайняя полоса накрывала z ±√(2·r·Δ) — для r=7 см шип 3.5 см поперёк
    // всего выреза. Шапка ограничивает выступ лестницы шагом полосы
    // (~0.08·r): кромка выглядит круглой, обхват (вырез ⊇ фигура) сохранён.
    const disc = (r, y0, y1) => {
      if (r < 1e-4 || y1 - y0 < 1e-5) return;
      const NX = 36, NZ = 6, TH = Math.PI / 6;
      const cx = r * Math.cos(TH), cz = r * Math.sin(TH);
      strips(r, y0, y1, NX, cx);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          let pz = 0;
          for (let j = 1; j <= NZ; j++) {
            const z1 = (cz * j) / NZ;
            const wx = chord(r, pz); // хорда ближнего к экватору конца полосы
            add(sx > 0 ? cx : -wx, sx > 0 ? wx : -cx, y0, y1,
              sz > 0 ? pz : -z1, sz > 0 ? z1 : -pz);
            pz = z1;
          }
        }
      }
    };
    // Пояса по y заменены (Н21-1) на: подробный слой-диск у каждой грани
    // бокса (там видна кромка выреза) + подробный диск на остальной высоте
    // фигуры ВНУТРИ бокса (Н22-1: раньше там была грубая 16-полосная пила;
    // радиус — максимум по диапазону: у шара конец ближе к экватору, у
    // конуса нижний конец — обхват сохранён). Части фигуры вне бокса не
    // генерируются: резать там нечего.
    if (shape === 'cyl') {
      disc(hp.r, -hp.hgt / 2, hp.hgt / 2);
      return slabs;
    }
    // Н22-1: клин-дырка — настоящий призматический вырез (раньше резался
    // AABB квадрата: «треугольник не той формы»). Клин = призма с
    // треугольным сечением в плоскости (x,y) и полной глубиной по z: скат
    // идёт от верхнего ребра x=+sx/2 к точке x=-sx/2 у низа. Слои по y:
    // слой [ya,yb] вырезает x от x0(ya) до +sx/2 и весь z — обхват (вырез ⊇
    // клин) обеспечен, потому что у НИЖНЕЙ грани слоя клин самый широкий.
    // Требование — скат вдоль мировой −x: rotY дырки и бокса ≈ 0 (поворот
    // в плане ломает осевость плит → заглушка AABB).
    if (shape === 'wedge') {
      if (Math.abs(hp.rotY || 0) >= TILT || Math.abs(p.rotY || 0) >= TILT) return null;
      const K = Math.min(80, Math.max(12, Math.ceil(hp.h / 0.004))); // слой ~4 мм
      for (let i = 0; i < K; i++) {
        const ya = -hp.h / 2 + (hp.h * i) / K;
        const yb = ya + hp.h / K;
        const x0 = (hp.sx * (ya + hp.h / 2)) / hp.h - hp.sx / 2;
        add(x0, hp.sx / 2, ya, yb, -hp.sz / 2, hp.sz / 2);
      }
      return slabs;
    }
    const s0 = shape === 'ball' ? -hp.r : -hp.hgt / 2;
    const s1 = shape === 'ball' ? hp.r : hp.hgt / 2;
    const radOver = shape === 'ball'
      ? (a, b) => (a > 0 || b < 0) // диапазон вне экватора — хорда ближнего конца
        ? chord(hp.r, Math.min(Math.abs(a), Math.abs(b)))
        : hp.r // диапазон накрывает экватор — максимальный радиус
      : (a, b) => hp.r * (1 - (a + hp.hgt / 2) / hp.hgt); // у нижнего конца шире
    const boxLo = -p.h / 2 - c.y, boxHi = p.h / 2 - c.y; // бокс в локале дырки
    const LYR = 0.004; // толщина подробного слоя у грани
    const layers = [];
    for (const [fy, dir] of [[boxLo, 1], [boxHi, -1]]) {
      const a = dir > 0 ? fy : fy - LYR;
      const b = dir > 0 ? fy + LYR : fy;
      // Н21-1: слой нужен, если он хоть немного задевает фигуру: грань ровно
      // на основании конуса даёт чистый обод disc(R). Раньше слой у грани,
      // совпадающей с концом фигуры, отбрасывался как «вне фигуры» — обод у
      // основания оставался грубой 16-полосной лестницей (выступ ~7 мм).
      if (b <= s0 + 1e-9 || a >= s1 - 1e-9) continue; // слой целиком вне фигуры
      layers.push([Math.max(a, s0), Math.min(b, s1)]);
    }
    layers.sort((u, v) => u[0] - v[0]);
    const merged = []; // слить слои пересекшегося тонкого бокса
    for (const lr of layers) {
      const last = merged[merged.length - 1];
      if (last && lr[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], lr[1]);
      else merged.push(lr.slice());
    }
    // Н22-1: грубые 16-полосные «пояса» посередине заменены мелкими дисками
    // (36 полос + шапки) на ВСЕЙ высоте фигуры внутри бокса — стенки проёма
    // и силуэт выреза больше не «пила» (пользователь видел грубую лестницу
    // сквозь дыру и на боковинах). Радиус — максимум по диапазону (обхват ⊇
    // фигура). Н22-1б: диапазон между слоями у граней режется не ОДНИМ
    // диском (шар, парящий в боксе, давал гладкий цилиндр «не той формы»),
    // а 4 поясами-дисками: профиль выреза повторяет фигуру ступеньками
    // ~1/4 высоты (шар в вырезе у верхней грани ложится в «гнездо», а не
    // проваливается сквозь цилиндр), каждая кромка — тот же мелкий диск.
    // Больше поясов не даём: каждый диск = 60 плит, 8 поясов раздували
    // физтело до ~800 боксов и пересборку до ~100 мс.
    const BANDS = 4;
    const banded = (a, b) => {
      for (let i = 0; i < BANDS; i++) {
        const ya = a + ((b - a) * i) / BANDS;
        const yb = a + ((b - a) * (i + 1)) / BANDS;
        disc(radOver(ya, yb), ya, yb);
      }
    };
    let prev = Math.max(s0, boxLo);
    for (const lr of merged) {
      if (lr[0] > prev + 1e-6) banded(prev, lr[0]);
      prev = lr[1];
      disc(radOver(lr[0], lr[1]), lr[0], lr[1]);
    }
    if (Math.min(s1, boxHi) > prev + 1e-6) banded(prev, Math.min(s1, boxHi));
    return slabs;
  }

  // Разрезать бокс (в локале: cx,cy,cz + полуразмеры) вычитанием AABB дырки.
  // Возвращает список оставшихся частей: x-полосы, затем z-полосы (в пределах
  // дырки по x), затем y-полосы (в пределах дырки по x и z) — без наложений.
  _subtractAabb(box, hole) {
    const bx0 = box.cx - box.hx, bx1 = box.cx + box.hx;
    const by0 = box.cy - box.hy, by1 = box.cy + box.hy;
    const bz0 = box.cz - box.hz, bz1 = box.cz + box.hz;
    const hx0 = hole.c.x - hole.hx, hx1 = hole.c.x + hole.hx;
    const hy0 = hole.c.y - hole.hy, hy1 = hole.c.y + hole.hy;
    const hz0 = hole.c.z - hole.hz, hz1 = hole.c.z + hole.hz;
    if (hx0 >= bx1 || hx1 <= bx0 || hy0 >= by1 || hy1 <= by0 || hz0 >= bz1 || hz1 <= bz0) return [box];
    const EPS = 1e-4;
    const out = [];
    const slab = (x0, x1, y0, y1, z0, z1) => {
      if (x1 - x0 < EPS || y1 - y0 < EPS || z1 - z0 < EPS) return;
      out.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2 });
    };
    const cx0 = Math.max(bx0, hx0), cx1 = Math.min(bx1, hx1);
    const cz0 = Math.max(bz0, hz0), cz1 = Math.min(bz1, hz1);
    slab(bx0, hx0, by0, by1, bz0, bz1);           // слева от дырки
    slab(hx1, bx1, by0, by1, bz0, bz1);           // справа
    slab(cx0, cx1, by0, by1, bz0, hz0);           // перед (в пределах дырки по x)
    slab(cx0, cx1, by0, by1, hz1, bz1);           // сзади
    slab(cx0, cx1, by0, hy0, cz0, cz1);           // снизу
    slab(cx0, cx1, hy1, by1, cz0, cz1);           // сверху
    return out;
  }

  _rebuildCutBody(p, holes, pieces) {
    const h = p._handle;
    if (!h || !this._world) return;
    if (pieces === undefined) pieces = this._cutPieces(p, holes); // совместимость со старым вызовом
    if (pieces === null) { // Н23-6: дырки не задели фигуру — родное тело
      this._rebuildNativeBody(p);
      return;
    }
    if (!pieces.length) { // дырка поглотила весь объект: остаётся невидимый
      if (h.body) this._world.removeBody(h.body); // «огрызок» 2 мм — h.body
      let si = this._static.indexOf(h.body);      // никогда не null (гизмо и
      if (si >= 0) this._static.splice(si, 1);    // драг читают body без проверок)
      let di = this._dyn.indexOf(h.body);
      if (di >= 0) this._dyn.splice(di, 1);
      const stub = new CANNON.Body({
        mass: 0,
        material: p.wall ? this.wallPhysMat : this.groundMat,
      });
      stub.addShape(new CANNON.Box(new CANNON.Vec3(0.001, 0.001, 0.001)));
      stub.position.set(p.x, p.elev + 0.001, p.z);
      this._world.addBody(stub);
      (p.pinned ? this._static : this._dyn).push(stub);
      h.body = stub;
      return;
    }
    // одна часть без дырок — обычное тело. Н15-6: ранний выход ТОЛЬКО если
    // текущее тело уже простой бокс нужного размера; после выреза оно compound
    // (или стаб 2 мм при поглощении) — его надо пересобрать обратно, иначе
    // дырка «заживала» визуально, но физика оставалась дырявой
    if (pieces.length === 1 && this._isFullPiece(pieces[0], p)) {
      const b = h.body, s0 = b && b.shapes[0];
      if (b && b.shapes.length === 1 && s0.type === 'Box'
        && Math.abs(s0.halfExtents.x - p.sx / 2) < 1e-6
        && Math.abs(s0.halfExtents.y - p.h / 2) < 1e-6
        && Math.abs(s0.halfExtents.z - p.sz / 2) < 1e-6) return;
    }
    // пересобрать: составное тело из частей
    const old = h.body;
    // Н15-6: при «заживлении» (кусок один и полный) тело ставим по канону
    // prop — old может быть стабом 2 мм с позиции у пола, и бокс остался бы
    // втопленным. При частичном вырезе наоборот храним текущую позу (динамика).
    const full1 = pieces.length === 1 && this._isFullPiece(pieces[0], p);
    const keepPos = full1
      ? new CANNON.Vec3(p.x, p.elev + p.h / 2, p.z)
      : (old ? old.position.clone() : new CANNON.Vec3(p.x, p.elev + this._halfOf(p), p.z));
    const keepQ = full1
      ? new CANNON.Quaternion().setFromEuler(p.rotX || 0, p.rotY || 0, p.rotZ || 0)
      : (old ? old.quaternion.clone() : new CANNON.Quaternion());
    if (old) {
      this._world.removeBody(old);
      let si = this._static.indexOf(old);
      if (si >= 0) this._static.splice(si, 1);
      let di = this._dyn.indexOf(old);
      if (di >= 0) this._dyn.splice(di, 1);
    }
    // Н23-6: полный объём по форме фигуры (у цилиндра/шара/конуса нет p.sx)
    const fullV = p.shape === 'ball' ? (4 / 3) * Math.PI * p.r * p.r * p.r
      : (p.shape === 'cyl' || p.shape === 'cone') ? Math.PI * p.r * p.r * p.hgt
        : p.shape === 'wedge' ? (p.sx * p.h * p.sz) / 2
          : p.sx * p.h * p.sz;
    let cutV = 0;
    for (const pc of pieces) cutV += 8 * pc.hx * pc.hy * pc.hz;
    const baseMass = p.pinned ? 0 : (p.shape === 'ball' ? 0.08 : p.shape === 'cyl' ? 0.2 : 0.15);
    const body = new CANNON.Body({
      mass: baseMass ? Math.max(0.01, baseMass * (cutV / Math.max(1e-9, fullV))) : 0,
      material: p.wall ? this.wallPhysMat : this.groundMat,
      angularDamping: 0.3,
      linearDamping: 0.05,
    });
    for (const pc of pieces) {
      body.addShape(new CANNON.Box(new CANNON.Vec3(pc.hx, pc.hy, pc.hz)),
        new CANNON.Vec3(pc.cx, pc.cy, pc.cz));
    }
    body.position.copy(keepPos);
    body.quaternion.copy(keepQ);
    this._world.addBody(body);
    (p.pinned ? this._static : this._dyn).push(body);
    h.body = body;
    if (!p.pinned) body.wakeUp();
  }

  // Н25-2: пересборка статического тела с вырезом (борта и _addBoxBody).
  // st = { x, y, z, sx, h, sz, rotZ, mat, body }. Дырки режем той же
  // _cutPiecesBox через «виртуальный бокс»-проп: части собираются в compound-
  // тело mass 0, каждая часть — CANNON.Box со смещением (pc.cx…). Тело не
  // двигается, поэтому сборку можно пропустить, если части не изменились
  // (updateHolePhysics зовётся на каждое движение пропов).
  _rebuildStaticCutBody(st, holes) {
    if (!this._world) return;
    const fake = {
      shape: 'box', x: st.x, z: st.z, sx: st.sx, sz: st.sz, h: st.h,
      elev: st.y - st.h / 2, rotX: 0, rotY: 0, rotZ: st.rotZ || 0,
    };
    const pieces = this._cutPiecesBox(fake, holes);
    const native = pieces === null
      || (pieces.length === 1 && this._isFullPiece(pieces[0], fake));
    if (native || !pieces.length) {
      // заживить / поглотить: родной бокс или стаб 2 мм. Уже такой — выход.
      const b = st.body;
      const want = native ? [st.sx / 2, st.h / 2, st.sz / 2] : [0.001, 0.001, 0.001];
      if (b && b.shapes.length === 1 && b.shapes[0].type === 'Box'
        && Math.abs(b.shapes[0].halfExtents.x - want[0]) < 1e-6
        && Math.abs(b.shapes[0].halfExtents.y - want[1]) < 1e-6
        && Math.abs(b.shapes[0].halfExtents.z - want[2]) < 1e-6) return;
      if (b) {
        this._world.removeBody(b);
        const si = this._static.indexOf(b);
        if (si >= 0) this._static.splice(si, 1);
      }
      const nb = new CANNON.Body({ mass: 0, material: st.mat });
      nb.addShape(new CANNON.Box(new CANNON.Vec3(want[0], want[1], want[2])));
      nb.position.set(st.x, st.y, st.z);
      if (st.rotZ) nb.quaternion.setFromEuler(0, 0, st.rotZ);
      this._world.addBody(nb);
      this._static.push(nb);
      st.body = nb;
      return;
    }
    // части не изменились с прошлой сборки — тело пересобирать не нужно
    const cur = st.body;
    if (cur && cur.shapes.length === pieces.length) {
      let same = true;
      for (let i = 0; i < pieces.length; i++) {
        const s = cur.shapes[i], off = cur.shapeOffsets[i], pc = pieces[i];
        if (!s || s.type !== 'Box'
          || Math.abs(s.halfExtents.x - pc.hx) > 1e-6
          || Math.abs(s.halfExtents.y - pc.hy) > 1e-6
          || Math.abs(s.halfExtents.z - pc.hz) > 1e-6
          || Math.abs(off.x - pc.cx) > 1e-6
          || Math.abs(off.y - pc.cy) > 1e-6
          || Math.abs(off.z - pc.cz) > 1e-6) { same = false; break; }
      }
      if (same) return;
    }
    if (cur) {
      this._world.removeBody(cur);
      const si = this._static.indexOf(cur);
      if (si >= 0) this._static.splice(si, 1);
    }
    const body = new CANNON.Body({ mass: 0, material: st.mat });
    for (const pc of pieces) {
      body.addShape(new CANNON.Box(new CANNON.Vec3(pc.hx, pc.hy, pc.hz)),
        new CANNON.Vec3(pc.cx, pc.cy, pc.cz));
    }
    body.position.set(st.x, st.y, st.z);
    if (st.rotZ) body.quaternion.setFromEuler(0, 0, st.rotZ);
    this._world.addBody(body);
    this._static.push(body);
    st.body = body;
  }

  // Н23-6: вернуть телу родную форму (дырка ушла — тело могло остаться
  // compound-огрызком или стабом 2 мм). Уже родное — ранний выход
  // (updateHolePhysics зовётся часто, пересборка на каждый вызов недопустима).
  _rebuildNativeBody(p) {
    const h = p._handle;
    if (!h || !this._world) return;
    const b = h.body;
    const s0 = b && b.shapes[0];
    if (b && b.shapes.length === 1) {
      const okBox = p.shape === 'box' && s0.type === 'Box'
        && Math.abs(s0.halfExtents.x - p.sx / 2) < 1e-6
        && Math.abs(s0.halfExtents.y - p.h / 2) < 1e-6
        && Math.abs(s0.halfExtents.z - p.sz / 2) < 1e-6;
      const okBall = p.shape === 'ball' && s0.type === 'Sphere' && Math.abs(s0.radius - p.r) < 1e-6;
      const okCyl = (p.shape === 'cyl' || p.shape === 'cone') && s0.type === 'Cylinder'
        && Math.abs(s0.radiusTop - (p.shape === 'cone' ? 0.002 : p.r)) < 1e-6
        && Math.abs(s0.radiusBottom - p.r) < 1e-6
        && Math.abs(s0.height - p.hgt) < 1e-6;
      const okWedge = p.shape === 'wedge' && s0.type === 'ConvexPolyhedron';
      if (okBox || okBall || okCyl || okWedge) return;
    }
    const px = b ? b.position.x : p.x;
    const py = b ? b.position.y : p.elev + this._halfOf(p);
    const pz = b ? b.position.z : p.z;
    if (b) {
      this._world.removeBody(b);
      let si = this._static.indexOf(b);
      if (si >= 0) this._static.splice(si, 1);
      let di = this._dyn.indexOf(b);
      if (di >= 0) this._dyn.splice(di, 1);
    }
    const m = p.pinned ? 0 : (p.shape === 'ball' ? 0.08 : p.shape === 'cyl' ? 0.2 : 0.15);
    const nb = new CANNON.Body({
      mass: m,
      material: p.wall ? this.wallPhysMat : this.groundMat,
      angularDamping: 0.3,
      linearDamping: 0.05,
    });
    if (p.shape === 'ball') nb.addShape(new CANNON.Sphere(p.r));
    else if (p.shape === 'cyl') nb.addShape(new CANNON.Cylinder(p.r, p.r, p.hgt, 12));
    else if (p.shape === 'cone') nb.addShape(new CANNON.Cylinder(0.002, p.r, p.hgt, 10));
    else if (p.shape === 'wedge') nb.addShape(wedgeConvex(p.sx, p.h, p.sz));
    else nb.addShape(new CANNON.Box(new CANNON.Vec3(p.sx / 2, p.h / 2, p.sz / 2)));
    nb.position.set(px, py, pz);
    if (b) nb.quaternion.copy(b.quaternion);
    else if (p.rotX || p.rotY || p.rotZ) nb.quaternion.setFromEuler(p.rotX || 0, p.rotY || 0, p.rotZ || 0);
    nb.velocity.set(0, 0, 0);
    nb.angularVelocity.set(0, 0, 0);
    this._world.addBody(nb);
    (p.pinned ? this._static : this._dyn).push(nb);
    h.body = nb;
    if (!p.pinned) nb.wakeUp();
  }

  // ── Н9-5: стереть краску со слоёв геометрии арены (борт, стены…) ──
  clearMeshLayers() {
    for (const L of this._meshLayers.values()) {
      L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
      L.tex.needsUpdate = true;
    }
  }

  // ── Рисование по полу (кисть, картинки, фигуры, ластик) ──
  // Пользовательская краска живёт отдельным прозрачным слоем _userCanvas
  // поверх базовой разметки: ластик стирает только краску, а маркеры маршрута
  // можно перерисовывать (_composite), не теряя краску.
  _ensureUser() {
    if (!this._userCanvas) {
      this._userCanvas = document.createElement('canvas');
      this._userCanvas.width = this._canvasW;
      this._userCanvas.height = this._canvasH;
    }
    return this._userCanvas;
  }

  // Пересобрать основной канвас: база + пользовательский слой
  _composite() {
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, this._canvasW, this._canvasH);
    this._paintFloor(ctx);
    if (this._userCanvas) ctx.drawImage(this._userCanvas, 0, 0);
    this.flushFloor();
  }

  paintCircle(x, z, rM, color) {
    const ctx = this._ensureUser().getContext('2d');
    const k = this._k();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc((x + this.sizeW / 2) * k, (z + this.sizeD / 2) * k, rM * k, 0, Math.PI * 2);
    ctx.fill();
    this._composite();
  }

  // Мазок по полу цепочкой кругов: без него быстрое движение мыши оставляет
  // точки (pointermove приходит реже, чем движется курсор). Одна _composite.
  paintStrokeFloor(x0, z0, x1, z1, rM, color) {
    const ctx = this._ensureUser().getContext('2d');
    const k = this._k();
    const dist = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(dist / Math.max(rM * 0.4, 0.002)));
    ctx.fillStyle = color;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      ctx.beginPath();
      ctx.arc((x0 + (x1 - x0) * t + this.sizeW / 2) * k,
        (z0 + (z1 - z0) * t + this.sizeD / 2) * k, Math.max(1, rM * k), 0, Math.PI * 2);
      ctx.fill();
    }
    this._composite();
  }

  eraseStrokeFloor(x0, z0, x1, z1, rM) {
    const ctx = this._ensureUser().getContext('2d');
    const k = this._k();
    const dist = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(dist / Math.max(rM * 0.4, 0.002)));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      ctx.beginPath();
      ctx.arc((x0 + (x1 - x0) * t + this.sizeW / 2) * k,
        (z0 + (z1 - z0) * t + this.sizeD / 2) * k, Math.max(1, rM * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this._composite();
  }

  stampImage(x, z, wM, img) {
    const ctx = this._ensureUser().getContext('2d');
    const k = this._k();
    const wPx = wM * k;
    const hPx = wPx * (img.height / Math.max(1, img.width));
    ctx.drawImage(img, (x + this.sizeW / 2) * k - wPx / 2, (z + this.sizeD / 2) * k - hPx / 2, wPx, hPx);
    this._composite();
  }

  // Снимок пользовательского слоя (для превью фигур при перетаскивании)
  floorSnapshot() {
    if (!this._userCanvas) return null;
    const c = document.createElement('canvas');
    c.width = this._canvasW;
    c.height = this._canvasH;
    c.getContext('2d').drawImage(this._userCanvas, 0, 0);
    return c;
  }

  // Вернуть пользовательский слой к состоянию снимка (перед перерисовкой превью)
  floorRestore(snap) {
    const ctx = this._ensureUser().getContext('2d');
    ctx.clearRect(0, 0, this._canvasW, this._canvasH);
    if (snap) ctx.drawImage(snap, 0, 0);
    this._composite();
  }

  // Ластик: стереть краску в круге (базовая разметка не трогается)
  eraseCircle(x, z, rM) {
    const ctx = this._ensureUser().getContext('2d');
    const k = this._k();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc((x + this.sizeW / 2) * k, (z + this.sizeD / 2) * k, Math.max(1, rM * k), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this._composite();
  }

  // Фигура на пользовательском слое: kind 'line' | 'rect' | 'circle';
  // filled — заливка (для line игнорируется)
  drawFloorShape(kind, x1, z1, x2, z2, wM, color, filled) {
    const ctx = this._ensureUser().getContext('2d');
    const k = this._k();
    const ax = (x1 + this.sizeW / 2) * k, ay = (z1 + this.sizeD / 2) * k;
    const bx = (x2 + this.sizeW / 2) * k, by = (z2 + this.sizeD / 2) * k;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, wM * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    } else if (kind === 'rect') {
      const rx = Math.min(ax, bx), ry = Math.min(ay, by);
      const rw = Math.abs(bx - ax), rh = Math.abs(by - ay);
      if (filled) ctx.fillRect(rx, ry, rw, rh); else ctx.strokeRect(rx, ry, rw, rh);
    } else if (kind === 'circle') {
      const r = Math.hypot(bx - ax, by - ay);
      ctx.beginPath();
      ctx.arc(ax, ay, r, 0, Math.PI * 2);
      if (filled) ctx.fill(); else ctx.stroke();
    }
    this._composite();
  }

  // ── Текстуры/покраска объектов (редактор арены) ──
  // Канвас-текстура: box — атлас 3×2 (по ячейке на грань, иначе мазок ложится
  // на все грани сразу), остальные формы — обычный канвас 256×256.
  ensureObjTexture(handle, fillCss) {
    remapBoxAtlasUV(handle.mesh.geometry); // idempotent; после resizeProp геометрия новая
    const p = handle.prop;
    if (!p._texCanvas) {
      // атлас 3×2 у бокса и клина (userData.atlasUV), остальное — 256×256
      const box = !!(handle.mesh.geometry && handle.mesh.geometry.userData
        && handle.mesh.geometry.userData.atlasUV);
      const c = document.createElement('canvas');
      c.width = box ? FACE_CELL * 3 : FACE_CELL;
      c.height = box ? FACE_CELL * 2 : FACE_CELL;
      const ctx = c.getContext('2d');
      // Н27: у дырки базовый цвет — исходные тёмные стенки тоннеля (0x39404d),
      // а не p.color объекта-объёма
      ctx.fillStyle = p.hole ? '#39404d' : fillCss;
      ctx.fillRect(0, 0, c.width, c.height);
      p._texCanvas = c;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8; // ПН10-2: краска на объектах не мылится под углом
      p._tex = tex;
      // Н27: у дырки карта живёт на материале стенок тоннеля (inner) — призрак
      // остаётся полупрозрачным оранжевым без карты
      const mat = p.hole && p._inner ? p._inner.material : handle.mesh.material;
      // map умножается на material.color — гасим тон, иначе краска темнит
      mat.color.setHex(0xffffff);
      mat.map = tex;
      mat.needsUpdate = true;
    }
    return p._texCanvas;
  }

  // B — кисть от brushFromHit (u, v, rx, ry, cell). Рисуем эллипс: UV-плотность
  // граней разная, круг в пикселях дал бы «размазанную» кисть.
  paintOnObject(handle, B, color) {
    const c = this.ensureObjTexture(handle, '#' + (handle.prop.color || 0x888888).toString(16).padStart(6, '0'));
    const ctx = c.getContext('2d');
    const cell = B.cell ? FACE_CELL : c.width;
    const px = B.cell ? (B.cell.col + B.u) * FACE_CELL : B.u * cell;
    const py = B.cell ? (B.cell.row + (1 - B.v)) * FACE_CELL : (1 - B.v) * cell;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(px, py, Math.max(1.5, B.rx), Math.max(1.5, B.ry), 0, 0, Math.PI * 2);
    ctx.fill();
    if (handle.prop._tex) handle.prop._tex.needsUpdate = true;
  }

  // Мазок между двумя точками одной грани: цепочка кругов без разрывов при
  // быстром движении мыши. Смена грани (другая ячейка атласа) — только точка.
  paintStrokeOnObject(handle, B0, B1, color) {
    const same = (B0.cell && B1.cell)
      ? B0.cell.col === B1.cell.col && B0.cell.row === B1.cell.row
      : !B0.cell && !B1.cell;
    // шов развёртки (цилиндр/сфера: u.wrap 1→0) — интерполяция тянула
    // мазок через весь канвас; скачок > 0.5 считаем новым касанием
    if (!B0.cell && !B1.cell && Math.abs(B1.u - B0.u) > 0.5) { this.paintOnObject(handle, B1, color); return; }
    if (!same) { this.paintOnObject(handle, B1, color); return; }
    const dist = Math.hypot(B1.u - B0.u, B1.v - B0.v);
    const step = Math.max(0.002, (B0.rx / FACE_CELL) * 0.45);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this.paintOnObject(handle, {
        u: B0.u + (B1.u - B0.u) * t, v: B0.v + (B1.v - B0.v) * t,
        rx: B0.rx, ry: B0.ry, cell: B0.cell,
      }, color);
    }
  }

  // ── Заливка (Н9-7): грань целиком ──
  // B от brushFromHit: у атласных (бокс/клин) заливаем ячейку грани,
  // у остальных — весь канвас (весь объект). Пол заливается отдельно.
  fillObjectFace(handle, B, color) {
    const c = this.ensureObjTexture(handle, '#' + (handle.prop.color || 0x888888).toString(16).padStart(6, '0'));
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    if (B.cell) ctx.fillRect(B.cell.col * FACE_CELL, B.cell.row * FACE_CELL, FACE_CELL, FACE_CELL);
    else ctx.fillRect(0, 0, c.width, c.height);
    if (handle.prop._tex) handle.prop._tex.needsUpdate = true;
  }

  fillMeshFace(mesh, B, color) {
    const L = this.ensureMeshLayer(mesh);
    L.ctx.fillStyle = color;
    if (B.cell) L.ctx.fillRect(B.cell.col * FACE_CELL, B.cell.row * FACE_CELL, FACE_CELL, FACE_CELL);
    else L.ctx.fillRect(0, 0, L.canvas.width, L.canvas.height);
    L.tex.needsUpdate = true;
  }

  // Залить весь пол (слой краски — ластик потом стирает)
  fillFloor(color) {
    const ctx = this._ensureUser().getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this._canvasW, this._canvasH);
    this._composite();
  }

  // Зафиксировать рисунок на объекте: канвас → p.tex (dataURL). Без этого
  // штрихи живут только до перезагрузки страницы (текстура канвасная).
  syncObjTexData(handle) {
    const p = handle.prop;
    if (p && p._texCanvas) {
      try { p.tex = canvasDataURL(p._texCanvas); } catch { /* нет канваса */ }
    }
  }

  setObjColor(handle, hex) {
    handle.prop.color = hex;
    // Н27: у дырки видимый цвет — стенки тоннеля (inner), не оранжевый призрак
    const mat = handle.prop.hole && handle.prop._inner
      ? handle.prop._inner.material : handle.mesh.material;
    // при канвас-текстуре цвет уже «запечён» в атлас, material белый
    if (!handle.prop._tex) mat.color.setHex(hex);
  }

  setObjImage(handle, img) {
    const c = this.ensureObjTexture(handle, '#ffffff');
    const ctx = c.getContext('2d');
    const box = c.width > FACE_CELL; // атлас: картинка на каждую грань
    const cells = box ? [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] : [[0, 0]];
    const cw = box ? FACE_CELL : c.width;
    for (const [col, row] of cells) {
      const s = Math.max(cw / img.width, cw / Math.max(1, img.height));
      const w = img.width * s, h = img.height * s;
      ctx.drawImage(img, col * cw + (cw - w) / 2, row * cw + (cw - h) / 2, w, h);
    }
    if (handle.prop._tex) handle.prop._tex.needsUpdate = true;
    try { handle.prop.tex = canvasDataURL(c, 0.85); } catch { handle.prop.tex = null; }
  }

  clearObjTexture(handle) {
    const p = handle.prop;
    if (p._tex) { p._tex.dispose(); p._tex = null; }
    p._texCanvas = null;
    p.tex = null;
    // Н27: у дырки карту и цвет снимаем со стенок тоннеля (inner)
    const mat = p.hole && p._inner ? p._inner.material : handle.mesh.material;
    mat.map = null;
    mat.color.setHex(p.hole ? 0x39404d : (p.color || 0x888888));
    mat.needsUpdate = true;
  }

  // При загрузке сохранённой арены: восстановить текстуру из dataURL.
  // Растягиваем на весь канвас: старый формат (одна грань 256×256) даёт
  // полный рисунок в каждой ячейке атласа — как раньше на каждой грани.
  restoreObjTexture(handle) {
    const p = handle.prop;
    if (!p.tex) return;
    const img = new Image();
    img.onload = () => {
      const c = this.ensureObjTexture(handle, '#ffffff');
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      if (p._tex) p._tex.needsUpdate = true;
    };
    img.src = p.tex;
  }

  // ── Покраска ЛЮБЫХ мешей арены (борт, стены трассы, рампа…) ──
  // Прозрачный слой-канвас: child-меш с той же геометрией (те же UV, что у
  // оригинала → UV попадания луча 1:1), наследует его перемещение/поворот.
  // Стабильный ключ по геометрии — для сохранения краски между пересборками.
  meshLayerKey(mesh) {
    const p = mesh.position;
    const g = mesh.geometry && mesh.geometry.parameters
      ? [mesh.geometry.parameters.width, mesh.geometry.parameters.height, mesh.geometry.parameters.depth,
         mesh.geometry.parameters.radiusTop, mesh.geometry.parameters.radiusBottom, mesh.geometry.parameters.radius]
      : [];
    return ['ml', this.name, p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3), ...g.map((v) => (v || 0).toFixed(3))].join('|');
  }

  ensureMeshLayer(mesh) {
    remapBoxAtlasUV(mesh.geometry); // слой делит геометрию с мешем — ремап общий
    let L = this._meshLayers.get(mesh.uuid);
    if (!L) {
      const box = mesh.geometry && mesh.geometry.type === 'BoxGeometry';
      const c = document.createElement('canvas');
      c.width = box ? FACE_CELL * 3 : FACE_CELL;
      c.height = box ? FACE_CELL * 2 : FACE_CELL;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8; // ПН10-2
      const ov = new THREE.Mesh(
        mesh.geometry, // та же геометрия → те же UV
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        }),
      );
      ov.renderOrder = 2;
      mesh.add(ov);
      L = { canvas: c, ctx: c.getContext('2d'), tex, ov, key: this.meshLayerKey(mesh) };
      this._meshLayers.set(mesh.uuid, L);
    }
    return L;
  }

  paintOnMesh(mesh, B, color) {
    const L = this.ensureMeshLayer(mesh);
    const cell = B.cell ? FACE_CELL : L.canvas.width;
    const px = B.cell ? (B.cell.col + B.u) * FACE_CELL : B.u * cell;
    const py = B.cell ? (B.cell.row + (1 - B.v)) * FACE_CELL : (1 - B.v) * cell;
    L.ctx.fillStyle = color;
    L.ctx.beginPath();
    L.ctx.ellipse(px, py, Math.max(1.5, B.rx), Math.max(1.5, B.ry), 0, 0, Math.PI * 2);
    L.ctx.fill();
    L.tex.needsUpdate = true;
  }

  paintStrokeOnMesh(mesh, B0, B1, color) {
    const same = (B0.cell && B1.cell)
      ? B0.cell.col === B1.cell.col && B0.cell.row === B1.cell.row
      : !B0.cell && !B1.cell;
    if (!B0.cell && !B1.cell && Math.abs(B1.u - B0.u) > 0.5) { this.paintOnMesh(mesh, B1, color); return; } // шов
    if (!same) { this.paintOnMesh(mesh, B1, color); return; }
    const dist = Math.hypot(B1.u - B0.u, B1.v - B0.v);
    const step = Math.max(0.002, (B0.rx / FACE_CELL) * 0.45);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this.paintOnMesh(mesh, {
        u: B0.u + (B1.u - B0.u) * t, v: B0.v + (B1.v - B0.v) * t,
        rx: B0.rx, ry: B0.ry, cell: B0.cell,
      }, color);
    }
  }

  // Ластик по слою: стираем прозрачность (destination-out)
  eraseOnMesh(mesh, B) {
    const L = this.ensureMeshLayer(mesh);
    const cell = B.cell ? FACE_CELL : L.canvas.width;
    const px = B.cell ? (B.cell.col + B.u) * FACE_CELL : B.u * cell;
    const py = B.cell ? (B.cell.row + (1 - B.v)) * FACE_CELL : (1 - B.v) * cell;
    L.ctx.globalCompositeOperation = 'destination-out';
    L.ctx.beginPath();
    L.ctx.ellipse(px, py, Math.max(1.5, B.rx), Math.max(1.5, B.ry), 0, 0, Math.PI * 2);
    L.ctx.fill();
    L.ctx.globalCompositeOperation = 'source-over';
    L.tex.needsUpdate = true;
  }

  // ── Фигуры и картинки на объектах (просьба 8) ──
  // B0/B1 — кисти от brushFromHit (локальные UV). Для атласной коробки фигура
  // рисуется в ячейку грани B0; конец на другой грани обрезается в её пределы.
  drawObjectShape(handle, B0, B1, kind, wM, color, filled) {
    const c = this.ensureObjTexture(handle, '#' + (handle.prop.color || 0x888888).toString(16).padStart(6, '0'));
    shapeOnCanvas(c.getContext('2d'), c, B0, B1, kind, wM, color, filled);
    if (handle.prop._tex) handle.prop._tex.needsUpdate = true;
  }

  drawOnMeshShape(mesh, B0, B1, kind, wM, color, filled) {
    const L = this.ensureMeshLayer(mesh);
    shapeOnCanvas(L.ctx, L.canvas, B0, B1, kind, wM, color, filled);
    L.tex.needsUpdate = true;
  }

  stampOnObject(handle, B, img, wM) {
    const c = this.ensureObjTexture(handle, '#' + (handle.prop.color || 0x888888).toString(16).padStart(6, '0'));
    const ctx = c.getContext('2d');
    const cw = B.cell ? FACE_CELL : c.width;
    const ox = B.cell ? B.cell.col * FACE_CELL : 0;
    const oy = B.cell ? B.cell.row * FACE_CELL : 0;
    const wPx = Math.max(4, wM * (B.ppmU || FACE_CELL / 0.1));
    const hPx = wPx * (img.height / Math.max(1, img.width));
    ctx.drawImage(img, ox + B.u * cw - wPx / 2, oy + (1 - B.v) * cw - hPx / 2, wPx, hPx);
    if (handle.prop._tex) handle.prop._tex.needsUpdate = true;
  }

  stampOnMesh(mesh, B, img, wM) {
    const L = this.ensureMeshLayer(mesh);
    const cw = B.cell ? FACE_CELL : L.canvas.width;
    const ox = B.cell ? B.cell.col * FACE_CELL : 0;
    const oy = B.cell ? B.cell.row * FACE_CELL : 0;
    const wPx = Math.max(4, wM * (B.ppmU || FACE_CELL / 0.1));
    const hPx = wPx * (img.height / Math.max(1, img.width));
    L.ctx.drawImage(img, ox + B.u * cw - wPx / 2, oy + (1 - B.v) * cw - hPx / 2, wPx, hPx);
    L.tex.needsUpdate = true;
  }

  // Серийность слоёв для сохранения: { key: dataURL }
  meshLayerDataURLs() {
    const out = {};
    for (const L of this._meshLayers.values()) {
      try { out[L.key] = canvasDataURL(L.canvas); } catch { /* нет канваса */ }
    }
    return out;
  }

  restoreMeshLayers(obj) {
    if (!obj) return;
    // меши строятся детерминированно — ключ можно посчитать заранее
    for (const mesh of this._meshes) {
      const key = this.meshLayerKey(mesh);
      const url = obj[key];
      if (!url) continue;
      const L = this.ensureMeshLayer(mesh);
      const img = new Image();
      img.onload = () => {
        // Н4: растягивать на ВЕСЬ канвас слоя. Раньше тут были жёсткие 256×256 —
        // после увеличения ячеек до 512 (ПН10-2) сохранённая краска на бортах
        // восстанавливалась сжатой в четверть («рисунки пропадают»).
        // Старые записи 256px при этом растягиваются — как и было задумано.
        L.ctx.drawImage(img, 0, 0, L.canvas.width, L.canvas.height);
        L.tex.needsUpdate = true;
      };
      img.src = url;
    }
  }

  // Сохранить/восстановить пользовательскую краску (только слой краски)
  paintDataURL() {
    return this._userCanvas ? canvasDataURL(this._userCanvas) : null;
  }

  restorePaint(dataURL) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const ctx = this._ensureUser().getContext('2d');
        ctx.drawImage(img, 0, 0, this._canvasW, this._canvasH);
        this._composite();
        resolve();
      };
      img.src = dataURL;
    });
  }

  clearPaint() {
    this._userCanvas = null;
    this._composite();
  }

  // Базовая (нередактируемая) геометрия для фона редактора: [{x,z,sx,sz,h}]
  baseProps() {
    // Периметр — общая базовая геометрия всех арен (для серой подложки редактора
    // и поиска свободного места при добавлении препятствий)
    const W = this.sizeW, D = this.sizeD, H = this.wallHeight, T = WALL_T;
    return [
      { x: 0, z: -(D / 2 + T / 2), sx: W + T, sz: T, h: H },
      { x: 0, z: D / 2 + T / 2, sx: W + T, sz: T, h: H },
      { x: -(W / 2 + T / 2), z: 0, sx: T, sz: D + T, h: H },
      { x: W / 2 + T / 2, z: 0, sx: T, sz: D + T, h: H },
    ];
  }

  dispose() {
    const { _scene: scene, _world: world } = this;
    if (!scene || !world) return;
    // меши: убрать из сцены и освободить геометрии/материалы (материалы могут
    // быть общими — собираем уникальные); текстура пола тоже leaking без dispose
    const mats = new Set();
    for (const m of this._meshes) {
      scene.remove(m);
      m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mt) => mats.add(mt));
    }
    for (const mt of mats) mt.dispose();
    this._meshes = [];
    for (const p of this._props) if (p._tex) { p._tex.dispose(); p._tex = null; }
    if (this._tex) { this._tex.dispose(); this._tex = null; }
    for (const b of this._static) world.removeBody(b);
    this._static = [];
    for (const b of this._dyn) world.removeBody(b);
    this._dyn = [];
    this._props = [];
    // Н25-1/2: общий материал depth-препасса и реестр режемых статик-стен
    if (this._prepassMat) { this._prepassMat.dispose(); this._prepassMat = null; }
    this._cutStatics = [];
    // Н29-2b: лампы — освободить геометрии/материалы и убрать контейнер из сцены
    for (const h of this._lightHandles) {
      h.bulb.geometry.dispose(); h.bulb.material.dispose();
      h.stem.geometry.dispose(); h.stem.material.dispose();
    }
    this._lightHandles = [];
    if (this._lightGroup) { scene.remove(this._lightGroup); this._lightGroup = null; }
    this.lights = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Базовое судейство: таймер + лента событий.
// ─────────────────────────────────────────────────────────────────────────────
class BaseJudge {
  constructor(title) {
    this.title = title;
    this.reset();
  }

  reset() {
    this.started = false;
    this.finished = false;
    this.time = 0;
    this.events = [];
    this.progressText = '';
    this.result = null;
  }

  start() {
    if (!this.finished) this.started = true;
  }

  stop() {
    this.started = false;
  }

  addEvent(text, kind = 'info') {
    this.events.push({ t: this.time, text, kind });
    if (this.events.length > 40) this.events.shift();
  }

  finish(resultText) {
    this.finished = true;
    this.started = false;
    this.result = resultText;
    this.addEvent(resultText, 'finish');
  }

  // вызывать после каждого шага физики
  update(dt, robot, sensors) {
    if (this.started && !this.finished) this.time += dt;
    this._update(dt, robot, sensors);
  }

  _update() {} // переопределяется
}

// ─────────────────────────────────────────────────────────────────────────────
// Песочница: пустое поле настраиваемого размера (редактор арены), судейство —
// только таймер.
// ─────────────────────────────────────────────────────────────────────────────
export const SANDBOX_SIZE_LIMITS = { min: 2, max: 8, defW: 4, defD: 4 };

// ── Н29-3: размер поля ЛЮБОЙ арены (не только песочницы) ──
// Ключ roboarena3d.size.<name>; песочница использует тот же ключ, что и раньше.
// Фиксированные арены масштабируют свою трассу/лабиринт/кегли относительно
// базового (зашитого) размера — см. конструкторы LineArena/MazeArena/… .
export const ARENA_SIZE_LIMITS = { min: 2, max: 8 };
const arenaSizeKey = (name) => 'roboarena3d.size.' + name;

export function loadArenaSize(name, defW, defD) {
  try {
    const s = JSON.parse(localStorage.getItem(arenaSizeKey(name)) || 'null');
    if (s) {
      const cl = (v) => (v === undefined || v === null || !Number.isFinite(+v))
        ? 0
        : Math.max(ARENA_SIZE_LIMITS.min, Math.min(ARENA_SIZE_LIMITS.max, +v));
      const w = cl(s.w), d = cl(s.d);
      if (w && d) return { w, d };
    }
  } catch { /* пусто */ }
  return { w: defW, d: defD };
}

export function saveArenaSize(name, w, d) {
  // Н29-3: клампим на запись (импорт может передать сырые числа из файла)
  const cl = (v) => Math.max(ARENA_SIZE_LIMITS.min, Math.min(ARENA_SIZE_LIMITS.max, +v));
  const cw = cl(w), cd = cl(d);
  if (!Number.isFinite(cw) || !Number.isFinite(cd)) return;
  try { localStorage.setItem(arenaSizeKey(name), JSON.stringify({ w: cw, d: cd })); } catch { /* пусто */ }
}

export function clearArenaSize(name) {
  try { localStorage.removeItem(arenaSizeKey(name)); } catch { /* пусто */ }
}

export function loadSandboxSize() {
  return loadArenaSize('sandbox', SANDBOX_SIZE_LIMITS.defW, SANDBOX_SIZE_LIMITS.defD);
}

export function saveSandboxSize(w, d) {
  saveArenaSize('sandbox', w, d);
}

export class SandboxArena extends BaseArena {
  constructor() {
    const sz = loadSandboxSize();
    super('sandbox', 'Песочница', sz.w, sz.d, WALL_H);
    // старт — левый ближний угол с отступом 0.8 м от угла
    this.startPose = {
      x: -(sz.w / 2 - 0.8),
      z: -(sz.d / 2 - 0.8),
      yawDeg: 45,
    };
    // Н19-5: судья «Линии» с пустой трассой — кнопка маршрута есть и в
    // песочнице: старт/финиш/чекпоинты задаёт редактор. distToPath → 0:
    // трассы-линии нет, сходов не бывает.
    this.judge = new LineJudge({
      title: 'Песочница',
      points: [],
      checkpoints: [],
      start: { x: this.startPose.x, z: this.startPose.z, r: 0.14 },
      distToPath: () => 0,
    });
    this._routeDefaults = {
      start: { x: this.startPose.x, z: this.startPose.z },
      cps: [],
      rules: { ...this.judge.rules },
    };
    const ov = loadRoute('sandbox');
    if (ov) this.applyRouteOverride(ov);
  }

  // Н19-5: маршрут песочницы хранится как у «Линии» (старт/финиш/чекпоинты)
  applyRouteOverride(ov) {
    const t = this.judge.track;
    if (ov.start && Number.isFinite(ov.start.x) && Number.isFinite(ov.start.z)) {
      this.startPose.x = ov.start.x;
      this.startPose.z = ov.start.z;
      t.start.x = ov.start.x;
      t.start.z = ov.start.z;
    }
    if (ov.finish && Number.isFinite(ov.finish.x) && Number.isFinite(ov.finish.z)) {
      t.finish = { x: ov.finish.x, z: ov.finish.z, r: 0.14 };
    } else {
      t.finish = null;
    }
    if (Array.isArray(ov.cps)) {
      t.checkpoints = ov.cps.filter((c) => Number.isFinite(c?.x) && Number.isFinite(c?.z))
        .map((c) => ({ x: c.x, z: c.z, r: 0.12 }));
    }
    if (ov.rules && typeof ov.rules === 'object') {
      this.judge.rules = { ...this.judge.rules, ...ov.rules };
    }
    if (this._canvas) this._composite();
  }

  resetRoute() {
    const d = this._routeDefaults;
    this.startPose.x = d.start.x;
    this.startPose.z = d.start.z;
    const t = this.judge.track;
    t.start.x = d.start.x;
    t.start.z = d.start.z;
    t.finish = null;
    t.checkpoints = [];
    this.judge.rules = { ...d.rules };
    if (this._canvas) this._composite();
  }

  _paintFloor(ctx) {
    super._paintFloor(ctx);
    // сетка 0.5 м
    ctx.strokeStyle = 'rgb(222,222,222)';
    ctx.lineWidth = 2;
    const n = Math.round(this.sizeW * 2); // 0.5 м = canvasW / (sizeW*2)
    for (let i = 1; i < n; i++) {
      const p = i * (this._canvasW / n);
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, this._canvasH); ctx.stroke();
    }
    const m = Math.round(this.sizeD * 2);
    for (let i = 1; i < m; i++) {
      const p = i * (this._canvasH / m);
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(this._canvasW, p); ctx.stroke();
    }
    // зона старта (шашечки) — вокруг стартовой позы (двигает редактор маршрута)
    const k = this._k();
    const toPx = (v, size) => (v + size / 2) * k;
    const cx = toPx(this.startPose.x, this.sizeW), cy = toPx(this.startPose.z, this.sizeD);
    const r = 0.18 * k;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgb(205,225,205)';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = 'rgb(255,255,255)';
    for (let yy = -2; yy <= 2; yy++) {
      for (let xx = -2; xx <= 2; xx++) {
        if ((xx + yy) % 2 === 0) ctx.fillRect(cx + xx * r / 2.5 - r / 5, cy + yy * r / 2.5 - r / 5, r / 5, r / 5);
      }
    }
    ctx.restore();
    // Н19-5: финиш (если создан) и чекпоинты — как на «Линии»
    const fn = this.judge.track.finish;
    if (fn) {
      this.drawOnFloor(ctx, fn.x - 0.10, fn.z - 0.10, 0.20, 0.20, 'rgb(110,195,120)');
      this.drawOnFloor(ctx, fn.x - 0.065, fn.z - 0.065, 0.13, 0.13, 'rgb(150,215,155)');
    }
    for (const c of this.judge.track.checkpoints) {
      this.drawOnFloor(ctx, c.x - 0.02, c.z - 0.02, 0.04, 0.04, 'rgb(230,140,40)');
    }
  }

  // Песочница пустая: рампа/платформа/ящики убраны — всё нужное добавляется
  // в редакторе арены (рампа 10°, платформы, ящики теперь там есть).
  _buildProps() {}

  baseProps() {
    return super.baseProps();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Судейство «Линии»: чекпоинты по порядку, сходы (60 мм, дебаунс 1 с), финиш.
// ─────────────────────────────────────────────────────────────────────────────
class LineJudge extends BaseJudge {
  constructor(track) {
    super(track.title || 'Линия');
    this.track = track; // { points, checkpoints: [{x,z,r}], start, finish? }
    // Пользовательские правила (редактор арены): лимит времени, предел сходов,
    // обязательность чекпоинтов. 0 = правило выключено.
    this.rules = { timeLimit: 0, maxOffs: 0, requireCheckpoints: true };
  }

  reset() {
    super.reset();
    this.nextCp = 0;
    this.offs = 0;
    this._offTime = 0;
    this._offLatched = false;
    this._leftStart = false; // робот покидал зону старта (защита от «мгновенного финиша»)
  }

  _update(dt, robot) {
    if (this.finished) return;
    const p = robot.body.position;
    const dist = this.track.distToPath(p.x, p.z);
    const R = this.rules || {};
    const cps = this.track.checkpoints;

    // лимит времени
    if (R.timeLimit > 0 && this.time >= R.timeLimit) {
      this.finish(`Время вышло (${R.timeLimit} с). Чекпоинтов: ${this.nextCp}/${cps.length}, сходов: ${this.offs}`);
      return;
    }
    // предел сходов
    if (R.maxOffs > 0 && this.offs > R.maxOffs) {
      this.finish(`Заезд окончен: сходов больше ${R.maxOffs}`);
      return;
    }

    // сход: центр дальше 60 мм от оси дольше 1 с
    if (dist > 0.06) {
      this._offTime += dt;
      if (this._offTime >= 1.0 && !this._offLatched) {
        this._offLatched = true;
        this.offs++;
        this.addEvent(`сход с трассы (${this.offs})`, 'bad');
      }
    } else {
      this._offTime = 0;
      this._offLatched = false;
    }

    // чекпоинты по порядку (если требуются правилами)
    if (R.requireCheckpoints !== false && this.nextCp < cps.length) {
      const c = cps[this.nextCp];
      if (Math.hypot(p.x - c.x, p.z - c.z) < c.r) {
        this.nextCp++;
        this.addEvent(`чекпоинт ${this.nextCp}/${cps.length}`, 'good');
      }
    }

    const s = this.track.start;
    const inStart = Math.hypot(p.x - s.x, p.z - s.z) < s.r;
    if (!inStart) this._leftStart = true;

    // Н19-5: финиш — отдельная зона (track.finish, её создаёт редактор);
    // нет своей зоны — финиш там же, где старт (старые сохранения и по умолчанию)
    const f = this.track.finish || s;
    const inFinish = Math.hypot(p.x - f.x, p.z - f.z) < f.r;

    // финиш: пересечение зоны финиша (+ все чекпоинты, если требуются)
    if (this._leftStart && inFinish && (R.requireCheckpoints === false || this.nextCp >= cps.length)) {
      this.finish(`Финиш! Время ${this.time.toFixed(1)} с, сходов: ${this.offs}`);
    }

    // Н19-5: пустая трасса без чекпоинтов/финиша (песочница до рисования
    // маршрута) — прежний «свободный заезд» вместо нулевой статистики
    this.progressText = (!this.track.points.length && !cps.length && !this.track.finish)
      ? 'свободный заезд'
      : `чекпоинты ${this.nextCp}/${cps.length} · сходов ${this.offs}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Линия: поле 4×3 м, чёрная линия 30 мм, 4 поворота, 3 чекпоинта, старт-финиш.
// Н5: конструктор принимает cfg — так «Восьмёрка» переиспользует всю логику
// линии (рисование, судейство, редактор маршрута) со своей геометрией.
// ─────────────────────────────────────────────────────────────────────────────
export class LineArena extends BaseArena {
  constructor(cfg = {}) {
    const d = {
      name: 'line', title: 'Линия (трасса)', judgeTitle: 'Линия',
      w: 4, d: 3, cornerR: 0.15,
      pts: [
        { x: -1.55, z: -1.05 }, // старт/финиш, движение на +z
        { x: -1.55, z: 0.85 },
        { x: -0.85, z: 1.20 },
        { x: 0.60, z: 1.20 },
        { x: 1.20, z: 0.65 },
        { x: 1.20, z: -0.55 },
        { x: 0.55, z: -1.15 },
        { x: -0.90, z: -1.15 },
      ],
      start: { x: -1.55, z: -1.05, yawDeg: 0 },
      cps: [
        { x: -1.55, z: 0.40, r: 0.12 },
        { x: -0.15, z: 1.20, r: 0.12 },
        { x: 1.20, z: 0.05, r: 0.12 },
      ],
      ...cfg,
    };
    // Н29-3: масштабируем трассу под выбранный размер поля (базовый — d.w×d.d)
    const sz = loadArenaSize(d.name, d.w, d.d);
    const kx = sz.w / d.w, kz = sz.d / d.d;
    if (kx !== 1 || kz !== 1) {
      d.pts = d.pts.map((p) => ({ x: p.x * kx, z: p.z * kz }));
      d.cps = d.cps.map((c) => ({ ...c, x: c.x * kx, z: c.z * kz }));
      d.start = { ...d.start, x: d.start.x * kx, z: d.start.z * kz };
      d.cornerR *= Math.min(kx, kz);
    }
    d.w = sz.w; d.d = sz.d;
    super(d.name, d.title, d.w, d.d, WALL_H);

    // Трасса — замкнутый контур со скруглёнными углами
    this._pts = d.pts;
    this._cornerR = d.cornerR;

    // Сегменты для оценки расстояния (по полилинии; скругление только внутрь,
    // так что запас в 60 мм у углов не даёт ложных сходов)
    this._segs = [];
    for (let i = 0; i < this._pts.length; i++) {
      const a = this._pts[i];
      const b = this._pts[(i + 1) % this._pts.length];
      this._segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
    }

    this.startPose = { ...d.start };

    this.judge = new LineJudge({
      title: d.judgeTitle,
      points: this._pts,
      checkpoints: d.cps.map((c) => ({ ...c })),
      start: { x: d.start.x, z: d.start.z, r: 0.14 },
      distToPath: (x, z) => this._distToPath(x, z),
    });

    // Значения по умолчанию для сброса маршрута в редакторе
    this._routeDefaults = {
      start: { x: this.judge.track.start.x, z: this.judge.track.start.z },
      cps: this.judge.track.checkpoints.map((c) => ({ x: c.x, z: c.z })),
      rules: { ...this.judge.rules },
    };
    // Перенос сохранённого маршрута/правил (редактор арены)
    const ov = loadRoute(d.name);
    if (ov) this.applyRouteOverride(ov);
  }

  applyRouteOverride(ov) {
    if (ov.start && Number.isFinite(ov.start.x) && Number.isFinite(ov.start.z)) {
      this.startPose.x = ov.start.x;
      this.startPose.z = ov.start.z;
      this.judge.track.start.x = ov.start.x;
      this.judge.track.start.z = ov.start.z;
    }
    // Н19-5: отдельный финиш (null → финиш совмещён со стартом)
    if (ov.finish && Number.isFinite(ov.finish.x) && Number.isFinite(ov.finish.z)) {
      this.judge.track.finish = { x: ov.finish.x, z: ov.finish.z, r: 0.14 };
    } else {
      this.judge.track.finish = null;
    }
    if (Array.isArray(ov.cps)) {
      const cps = ov.cps.filter((c) => Number.isFinite(c?.x) && Number.isFinite(c?.z))
        .map((c) => ({ x: c.x, z: c.z, r: 0.12 }));
      if (cps.length) this.judge.track.checkpoints = cps;
    }
    if (ov.rules && typeof ov.rules === 'object') {
      this.judge.rules = { ...this.judge.rules, ...ov.rules };
    }
    // в конструкторе канваса ещё нет (build() рисует пол уже с переопределением)
    if (this._canvas) this._composite();
  }

  resetRoute() {
    const d = this._routeDefaults;
    this.startPose.x = d.start.x;
    this.startPose.z = d.start.z;
    this.judge.track.start.x = d.start.x;
    this.judge.track.start.z = d.start.z;
    this.judge.track.finish = null; // Н19-5: снова старт-финиш одной планкой
    this.judge.track.checkpoints = d.cps.map((c) => ({ x: c.x, z: c.z, r: 0.12 }));
    this.judge.rules = { ...d.rules };
    if (this._canvas) this._composite();
  }

  _paintFloor(ctx) {
    ctx.fillStyle = hexCss(this.floorColor); // Н29-4: фон платформы
    ctx.fillRect(0, 0, this._canvasW, this._canvasH);
    const k = this._k();

    // чёрная линия со скруглёнными углами
    ctx.strokeStyle = 'rgb(25,25,25)';
    ctx.lineWidth = 0.03 * k;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.beginPath();
    const P = this._pts;
    const toPx = (p) => [(p.x + this.sizeW / 2) * k, (p.z + this.sizeD / 2) * k];
    let [sx, sy] = toPx(P[0]);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < P.length - 1; i++) {
      const [cx, cy] = toPx(P[i]);
      const [nx, ny] = toPx(P[i + 1]);
      ctx.arcTo(cx, cy, nx, ny, this._cornerR * k);
    }
    const [ex, ey] = toPx(P[P.length - 1]);
    ctx.arcTo(ex, ey, sx, sy, this._cornerR * k);
    ctx.closePath();
    ctx.stroke();

    // старт-финиш: шашечная планка поперёк линии (позиция — из judge.track.start,
    // её двигает редактор маршрута)
    const st = this.judge.track.start;
    const sq = 0.025;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const color = (row + col) % 2 === 0 ? 'rgb(20,20,20)' : 'rgb(240,240,240)';
        this.drawOnFloor(ctx, st.x - sq + col * sq, st.z - sq + row * sq, sq, sq, color);
      }
    }

    // Н19-5: отдельный финиш (если создан в редакторе) — зелёная зона
    const fn = this.judge.track.finish;
    if (fn) {
      this.drawOnFloor(ctx, fn.x - 0.10, fn.z - 0.10, 0.20, 0.20, 'rgb(110,195,120)');
      this.drawOnFloor(ctx, fn.x - 0.065, fn.z - 0.065, 0.13, 0.13, 'rgb(150,215,155)');
    }

    // маркеры чекпоинтов — сбоку от линии, чтобы не мешать датчикам
    for (const c of this.judge.track.checkpoints) {
      this.drawOnFloor(ctx, c.x + 0.10, c.z - 0.02, 0.04, 0.04, 'rgb(230,140,40)');
    }
  }

  _distToPath(x, z) {
    let best = Infinity;
    for (const s of this._segs) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz));
      if (d < best) best = d;
    }
    return best;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Судейство «Лабиринта»: выход из лабиринта + столкновения.
// ─────────────────────────────────────────────────────────────────────────────
class MazeJudge extends BaseJudge {
  constructor(exit) {
    super('Лабиринт');
    this.exit = exit; // { x, z, r }
    // Правила (редактор арены): лимит времени, предел столкновений. 0 = выкл.
    this.rules = { timeLimit: 0, maxHits: 0 };
  }

  reset() {
    super.reset();
    this.hits = 0;
    this._hitCooldown = 0;
    this._leftStart = false;
    this._sx = null; this._sz = null;
  }

  _update(dt, robot, sensors) {
    if (this.finished) return;
    const p = robot.body.position;
    const R = this.rules || {};

    if (this._sx === null) { this._sx = p.x; this._sz = p.z; }
    if (Math.hypot(p.x - this._sx, p.z - this._sz) > 0.2) this._leftStart = true;

    if (R.timeLimit > 0 && this.time >= R.timeLimit) {
      this.finish(`Время вышло (${R.timeLimit} с), столкновений: ${this.hits}`);
      return;
    }
    if (R.maxHits > 0 && this.hits > R.maxHits) {
      this.finish(`Заезд окончен: столкновений больше ${R.maxHits}`);
      return;
    }
    if (Math.hypot(p.x - this.exit.x, p.z - this.exit.z) < this.exit.r) {
      this.finish(`Выход найден! Время ${this.time.toFixed(1)} с, столкновений: ${this.hits}`);
      return;
    }
    if (this._hitCooldown > 0) this._hitCooldown -= dt;
    if (sensors.bumperPressed() && this._hitCooldown <= 0) {
      this.hits++;
      this._hitCooldown = 1.5;
      this.addEvent('столкновение со стеной', 'bad');
    }
    this.progressText = `столкновений: ${this.hits}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Лабиринт: поле 4×4 м, сетка 5×5 (ячейка 800 мм), стены 150 мм высотой.
// Идеальный лабиринт (дерево, без петель) — проходится «правилом правой руки».
// Старт (0,0) — угол, выход (4,4) — противоположный угол (зелёная площадка).
// ─────────────────────────────────────────────────────────────────────────────
export class MazeArena extends BaseArena {
  constructor() {
    const sz = loadArenaSize('maze', 4, 4); // Н29-3: размер поля настраивается
    super('maze', 'Лабиринт', sz.w, sz.d, 0.15);

    // 5×5 ячеек; при неквадратном поле ячейки растягиваются по осям
    this.cellX = sz.w / 5;
    this.cellZ = sz.d / 5;
    this.cell = this.cellX; // совместимость со старым кодом
    this._ox = -sz.w / 2;
    this._oz = -sz.d / 2;
    // Вертикальные стены V[i][j]: между (i−1,j) и (i,j), i=1..4, j=0..4
    // Горизонтальные H[i][j]: между (i,j−1) и (i,j), j=1..4, i=0..4
    // true = стена есть. Перечислены ПРОРЕЗАННЫЕ проходы (24 ребра дерева).
    const carvedV = new Set(['1,0', '2,0', '2,2', '1,2', '1,4', '2,4', '3,4', '4,4', '3,2', '4,2', '4,1', '1,3']);
    const carvedH = new Set(['2,1', '2,2', '0,3', '0,4', '1,1', '3,4', '4,1', '4,2', '3,1', '4,3', '0,2', '2,4']);
    this._carvedV = carvedV;
    this._carvedH = carvedH;

    const cellCenter = (i, j) => ({
      x: this._ox + this.cellX / 2 + i * this.cellX,
      z: this._oz + this.cellZ / 2 + j * this.cellZ,
    });
    this._cellCenter = cellCenter;
    const exit = cellCenter(4, 4);
    this.startPose = { x: cellCenter(0, 0).x, z: cellCenter(0, 0).z, yawDeg: 90 };
    this.judge = new MazeJudge({ x: exit.x, z: exit.z, r: 0.35 });
    this._routeDefaults = {
      start: { x: this.startPose.x, z: this.startPose.z },
      exit: { x: exit.x, z: exit.z },
      rules: { ...this.judge.rules },
    };
    const ov = loadRoute('maze');
    if (ov) this.applyRouteOverride(ov);
  }

  applyRouteOverride(ov) {
    // Н19-5: старт тоже перетаскивается (хранится в маршруте арены)
    if (ov.start && Number.isFinite(ov.start.x) && Number.isFinite(ov.start.z)) {
      this.startPose.x = ov.start.x;
      this.startPose.z = ov.start.z;
    }
    if (ov.exit && Number.isFinite(ov.exit.x) && Number.isFinite(ov.exit.z)) {
      this.judge.exit.x = ov.exit.x;
      this.judge.exit.z = ov.exit.z;
    }
    if (ov.rules && typeof ov.rules === 'object') {
      this.judge.rules = { ...this.judge.rules, ...ov.rules };
    }
    if (this._canvas) this._composite();
  }

  resetRoute() {
    const d = this._routeDefaults;
    this.startPose.x = d.start.x;
    this.startPose.z = d.start.z;
    this.judge.exit.x = d.exit.x;
    this.judge.exit.z = d.exit.z;
    this.judge.rules = { ...d.rules };
    if (this._canvas) this._composite();
  }

  _paintFloor(ctx) {
    ctx.fillStyle = hexCss(this.floorColor); // Н29-4: фон платформы
    ctx.fillRect(0, 0, this._canvasW, this._canvasH);
    const k = this._k();
    // сетка ячеек
    ctx.strokeStyle = 'rgb(215,215,215)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const px = i * this.cellX * k;
      const pz = i * this.cellZ * k;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, this._canvasH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, pz); ctx.lineTo(this._canvasW, pz); ctx.stroke();
    }
    // старт (синяя площадка, позиция — из startPose, её двигает редактор
    // маршрута) и выход (из judge.exit)
    const s = { x: this.startPose.x, z: this.startPose.z };
    const e = { x: this.judge.exit.x, z: this.judge.exit.z };
    this.drawOnFloor(ctx, s.x - 0.15, s.z - 0.15, 0.3, 0.3, 'rgb(180,200,235)');
    this.drawOnFloor(ctx, e.x - 0.3, e.z - 0.3, 0.6, 0.6, 'rgb(110,195,120)');
    this.drawOnFloor(ctx, e.x - 0.18, e.z - 0.18, 0.36, 0.36, 'rgb(150,215,155)');
    // (flushFloor не нужен: build() создаёт CanvasTexture уже после отрисовки)
  }

  _buildProps(scene, world) {
    const T = 0.025, H = 0.15;
    const addWall = (x, z, sx, sz) => this._addBoxBody(scene, sx, H, sz, x, H / 2, z, 0x5b6472, 0, this.wallPhysMat);

    // внутренние вертикальные: i=1..4, j=0..4 (прорезанные пропускаем)
    for (let i = 1; i <= 4; i++) {
      let j = 0;
      while (j < 5) {
        if (this._carvedV.has(`${i},${j}`)) { j++; continue; }
        let j2 = j;
        while (j2 < 5 && !this._carvedV.has(`${i},${j2}`)) j2++;
        // сегмент покрывает ячейки j..j2-1 (Н29-3: масштаб по осям)
        const zA = this._oz + j * this.cellZ;
        const zB = this._oz + j2 * this.cellZ;
        addWall(this._ox + i * this.cellX, (zA + zB) / 2, T, zB - zA);
        j = j2;
      }
    }
    // внутренние горизонтальные: j=1..4, i=0..4
    for (let j = 1; j <= 4; j++) {
      let i = 0;
      while (i < 5) {
        if (this._carvedH.has(`${i},${j}`)) { i++; continue; }
        let i2 = i;
        while (i2 < 5 && !this._carvedH.has(`${i2},${j}`)) i2++;
        const xA = this._ox + i * this.cellX;
        const xB = this._ox + i2 * this.cellX;
        addWall((xA + xB) / 2, this._oz + j * this.cellZ, xB - xA, T);
        i = i2;
      }
    }
  }

  baseProps() {
    const T = 0.025, H = 0.15;
    const out = super.baseProps(); // периметр поля
    for (let i = 1; i <= 4; i++) {
      let j = 0;
      while (j < 5) {
        if (this._carvedV.has(`${i},${j}`)) { j++; continue; }
        let j2 = j;
        while (j2 < 5 && !this._carvedV.has(`${i},${j2}`)) j2++;
        out.push({ x: this._ox + i * this.cellX, z: this._oz + (j + j2) / 2 * this.cellZ, sx: T, sz: (j2 - j) * this.cellZ, h: H });
        j = j2;
      }
    }
    for (let j = 1; j <= 4; j++) {
      let i = 0;
      while (i < 5) {
        if (this._carvedH.has(`${i},${j}`)) { i++; continue; }
        let i2 = i;
        while (i2 < 5 && !this._carvedH.has(`${i2},${j}`)) i2++;
        out.push({ x: this._ox + (i + i2) / 2 * this.cellX, z: this._oz + j * this.cellZ, sx: (i2 - i) * this.cellX, sz: T, h: H });
        i = i2;
      }
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Восьмёрка (Н5): механика линии, но трасса — лемниската Бернулли с
// перекрёстком под 90°. Старт/финиш — на перекрёстке: робот проходит правую
// петлю, возвращается, проходит левую, снова возвращается — финиш.
// ─────────────────────────────────────────────────────────────────────────────
export class EightArena extends LineArena {
  constructor() {
    // Лемниската: x = c·cos t/(1+sin²t), z = c·sin t·cos t/(1+sin²t).
    // Ветви пересекаются в (0,0) ровно под 90°. Начинаем с t=3π/2 — это
    // перекрёсток, и первый шаг уводит робота в нижнюю правую петлю.
    const c = 1.6, N = 72, T0 = 1.5 * Math.PI;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const t = T0 + (2 * Math.PI * i) / N;
      const co = Math.cos(t), s = Math.sin(t), d = 1 + s * s;
      pts.push({ x: (c * co) / d, z: (c * s * co) / d });
    }
    // Чекпоинты: север правой петли (t=9π/4 → индекс 27) и юг левой (11π/4 → 45).
    // Порядок важен: судья засчитывает их строго последовательно.
    const cps = [
      { x: pts[27].x, z: pts[27].z, r: 0.13 },
      { x: pts[45].x, z: pts[45].z, r: 0.13 },
    ];
    // Курс старта — по хорде pts[0]→pts[1] (вниз-вправо, ≈135°)
    const yaw = Math.atan2(pts[1].x - pts[0].x, pts[1].z - pts[0].z) * 180 / Math.PI;
    super({
      name: 'eight', title: 'Восьмёрка (перекрёсток)', judgeTitle: 'Восьмёрка',
      pts, cornerR: 0.012,
      start: { x: pts[0].x, z: pts[0].z, yawDeg: Math.round(yaw) },
      cps,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Судейство «Кеглей» (Н5): финиш в зелёной зоне, счёт сбитых кеглей,
// толчки бампером — штраф. Кегли — лёгкие динамические шары, судья следит
// за смещением каждого от своей стартовой точки.
// ─────────────────────────────────────────────────────────────────────────────
class KegelJudge extends BaseJudge {
  constructor(exit) {
    super('Кегли');
    this.exit = exit; // { x, z, r }
    this.pins = [];   // [{ x0, z0, y0, body }] — заполняет арена в _buildProps
    // Правила (редактор арены): лимит времени, предел толчков. 0 = выкл.
    this.rules = { timeLimit: 0, maxHits: 0 };
  }

  reset() {
    super.reset();
    this.knocked = 0;
    this.hits = 0;
    this._hitCooldown = 0;
    // вернуть кегли на места: сброс скетча = новый прогон с целыми кеглями.
    // pins появляются после super() — при первом вызове из конструктора их нет
    for (const k of this.pins || []) {
      k.down = false;
      k.body.position.set(k.x0, k.y0, k.z0);
      k.body.quaternion.set(0, 0, 0, 1);
      k.body.velocity.set(0, 0, 0);
      k.body.angularVelocity.set(0, 0, 0);
      k.body.wakeUp();
    }
  }

  _update(dt, robot, sensors) {
    if (this.finished) return;
    const p = robot.body.position;
    const R = this.rules || {};

    if (R.timeLimit > 0 && this.time >= R.timeLimit) {
      this.finish(`Время вышло (${R.timeLimit} с). Кеглей сбито: ${this.knocked}/${this.pins.length}, толчков: ${this.hits}`);
      return;
    }
    if (R.maxHits > 0 && this.hits > R.maxHits) {
      this.finish(`Заезд окончен: толчков больше ${R.maxHits}`);
      return;
    }

    // кегля сбита, если сместилась от своего места больше чем на 12 см
    for (let i = 0; i < this.pins.length; i++) {
      const k = this.pins[i];
      if (k.down) continue;
      if (Math.hypot(k.body.position.x - k.x0, k.body.position.z - k.z0) > 0.12) {
        k.down = true;
        this.knocked++;
        this.addEvent(`кегля ${i + 1} из ${this.pins.length}`, 'good');
      }
    }

    if (this._hitCooldown > 0) this._hitCooldown -= dt;
    if (sensors.bumperPressed() && this._hitCooldown <= 0) {
      this.hits++;
      this._hitCooldown = 1.5;
      this.addEvent('толчок бампером', 'bad');
    }

    if (Math.hypot(p.x - this.exit.x, p.z - this.exit.z) < this.exit.r) {
      this.finish(`Финиш! Время ${this.time.toFixed(1)} с, кеглей сбито: ${this.knocked}/${this.pins.length}`);
      return;
    }
    this.progressText = `кеглей ${this.knocked}/${this.pins.length} · толчков ${this.hits}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Кегли (Н5): дорожка 4×3 м. Четыре кегли зигзагом поперёк хода: прямолинейный
// заезд заденет их корпусом (полуширина робота 9 см + 6 см кегли = 15 см
// больше смещения кегли 14 см), для аккуратной «змейки» придётся рулить.
// Финиш — зелёная зона у правого борта: g заметно больше r и b (поотношениям,
// не по абсолюту — датчик цвета зависит от освещения).
// ─────────────────────────────────────────────────────────────────────────────
export class KegelArena extends BaseArena {
  constructor() {
    const sz = loadArenaSize('kegely', 4, 3); // Н29-3: размер поля настраивается
    const kx = sz.w / 4, kz = sz.d / 3;
    super('kegely', 'Кегли (слалом)', sz.w, sz.d, WALL_H);
    this._kx = kx; this._kz = kz;
    this.startPose = { x: -1.6 * kx, z: 0, yawDeg: 90 };
    // зона финиша шире зелёной краски: скетч тормозит по датчику цвета на краю
    // краски (луч спереди), центр корпуса не доезжает до краски ~13 см
    this.judge = new KegelJudge({ x: 1.5 * kx, z: 0, r: 0.45 });
    this._routeDefaults = {
      start: { x: this.startPose.x, z: this.startPose.z },
      exit: { x: this.judge.exit.x, z: this.judge.exit.z },
      rules: { ...this.judge.rules },
    };
    const ov = loadRoute('kegely');
    if (ov) this.applyRouteOverride(ov);
  }

  applyRouteOverride(ov) {
    // Н19-5: старт тоже перетаскивается (хранится в маршруте арены)
    if (ov.start && Number.isFinite(ov.start.x) && Number.isFinite(ov.start.z)) {
      this.startPose.x = ov.start.x;
      this.startPose.z = ov.start.z;
    }
    if (ov.exit && Number.isFinite(ov.exit.x) && Number.isFinite(ov.exit.z)) {
      this.judge.exit.x = ov.exit.x;
      this.judge.exit.z = ov.exit.z;
    }
    if (ov.rules && typeof ov.rules === 'object') {
      this.judge.rules = { ...this.judge.rules, ...ov.rules };
    }
    if (this._canvas) this._composite();
  }

  resetRoute() {
    const d = this._routeDefaults;
    this.startPose.x = d.start.x;
    this.startPose.z = d.start.z;
    this.judge.exit.x = d.exit.x;
    this.judge.exit.z = d.exit.z;
    this.judge.rules = { ...d.rules };
    if (this._canvas) this._composite();
  }

  _paintFloor(ctx) {
    ctx.fillStyle = hexCss(this.floorColor); // Н29-4: фон платформы
    ctx.fillRect(0, 0, this._canvasW, this._canvasH);
    // старт (синяя площадка) и финиш (зелёная — под датчик цвета);
    // позиция финиша — из judge.exit, её двигает редактор маршрута
    const s = this.startPose;
    const e = this.judge.exit;
    this.drawOnFloor(ctx, s.x - 0.15, s.z - 0.15, 0.3, 0.3, 'rgb(180,200,235)');
    this.drawOnFloor(ctx, e.x - 0.35, e.z - 0.35, 0.7, 0.7, 'rgb(110,195,120)');
    this.drawOnFloor(ctx, e.x - 0.21, e.z - 0.21, 0.42, 0.42, 'rgb(150,215,155)');
  }

  _buildProps(scene, world) {
    // кегли — лёгкие шары r=6 см, зигзаг ±14 см от оси заезда (Н29-3: масштаб)
    const xs = [-0.9, -0.3, 0.3, 0.9].map((v) => v * this._kx);
    const zs = [-0.14, 0.14, -0.14, 0.14].map((v) => v * this._kz);
    for (let i = 0; i < 4; i++) {
      const h = this.addProp({ shape: 'ball', x: xs[i], z: zs[i], r: 0.06, color: 0xc94040, pinned: false });
      this.judge.pins.push({ x0: xs[i], z0: zs[i], y0: h.body.position.y, body: h.body });
    }
  }
}
