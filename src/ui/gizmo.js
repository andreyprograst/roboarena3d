// Гизмо трансформации как в 3D-редакторах: три стрелки перемещения (X/Y/Z),
// три кольца вращения и центральная сфера (свободный перенос в плоскости
// камеры). Прикрепляется к Object3D, сам двигает/вращает его и сообщает
// колбэки { onStart, onChange, onEnd } — синхронизацией с физикой занимается
// вызывающий редактор.
//
// Стрелки перемещения выровнены по ОСЯМ РОДИТЕЛЯ (для деталей арены —
// мировые X/Y/Z): перенос стрелкой меняет ровно одну координату, даже если
// сам объект повёрнут (Н21-3). Кольца вращают объект вокруг его СОБСТВЕННЫХ
// осей — они живут в дочерней группе _rotG, повторяющей поворот объекта.
// Математика жеста ведётся в пространстве родителя объекта: объект может
// быть вложен (например, деталь робота на качалке серво) — луч камеры
// переводится в локальные координаты через обратную матрицу родителя.
//
// Следование за объектом: прикреплённые гизмо регистрируются в реестре,
// syncGizmos() (вызывается из главного цикла) каждый кадр привязывает их
// к текущему мировому положению объекта — стрелки следуют за телом, даже
// если оно едет по физике или его тащат мышкой без гизмо.
import * as THREE from 'three';

const COL = { x: 0xe5484d, y: 0x51cf66, z: 0x4dabf7 };
const RENDER_ORDER = 999; // поверх сцены (материалы с depthTest:false)
const SNAP_STEP = 0.02;   // Shift: шаг перемещения, м
const SNAP_ANG = Math.PI / 12; // Shift: шаг вращения, 15°

const AXIS_VEC = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Н21-3: временные составляющие matrixWorld родителя (покадровый sync)
const _pv = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _ps = new THREE.Vector3();

// ── Реестр прикреплённых гизмо: покадровое следование за объектами ──
const ATTACHED = new Set();
export function syncGizmos() {
  for (const g of ATTACHED) g.sync();
}

export class TransformGizmo {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.object = null;   // прикреплённый Object3D
    this.cb = null;       // { onStart(gz), onChange(gz), onEnd(gz) }

    this.root = new THREE.Group();
    this.root.visible = false;
    this._rotG = new THREE.Group(); // Н21-3: кольца — в осях самого объекта
    this.root.add(this._rotG);

    this._ray = new THREE.Raycaster(); // луч в мировых координатах (пикинг гизмо)
    this._rayL = new THREE.Ray();      // тот же луч в пространстве родителя объекта
    this._invMat = new THREE.Matrix4();
    this._center = new THREE.Vector3(); // центр вращения в пространстве родителя
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane();
    this._pt = new THREE.Vector3();
    this._p0 = new THREE.Vector3();
    this._startPos = new THREE.Vector3();
    this._startQ = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._lastAng = 0;
    this._accSnap = 0;    // накопленный угол для snap-вращения
    this._appliedSnap = 0;
    this._active = null;  // { type: 'move'|'rotate', axis, center }

    this._pickMove = [];  // стрелки + центр — проверяются ПЕРВЫМИ
    this._pickRot = [];   // кольца (в т.ч. невидимые зоны захвата)
    this._moveParts = []; // все части «перемещения» (для переключения режима)
    this._rotParts = [];  // все части «поворота»
    this.mode = 'both';   // 'move' | 'rotate' | 'both' — что показывать и ловить
    this._axisVis = {     // Н19-2: камерная видимость осей (пересчёт в sync())
      x: { arrow: true, ring: true },
      y: { arrow: true, ring: true },
      z: { arrow: true, ring: true },
    };
    this._build();
  }

  // Режим гизмо: «перемещение и поворот отдельно» (просьба пользователя) —
  // 'move' показывает только стрелки, 'rotate' только кольца, 'both' — всё.
  // 'none' (Н9-2) прячет всё: место маркеров размера редактора арены.
  setMode(mode) {
    this.mode = mode;
    this._applyVis();
  }

  // Н19-2: применить видимость по режиму setMode и камерной видимости осей
  // (пороги — в _updateAxisVis). hitTest фильтрует по m.visible — скрытая
  // ось не кликается.
  _applyVis() {
    const mv = this.mode !== 'rotate' && this.mode !== 'none';
    const rt = this.mode !== 'move' && this.mode !== 'none';
    for (const m of this._moveParts) {
      const gz = m.userData.gz;
      m.visible = mv && (gz.center || this._axisVis[gz.axis].arrow);
    }
    for (const m of this._rotParts) {
      m.visible = rt && this._axisVis[m.userData.gz.axis].ring;
    }
  }

  // Н19-2 → Н23-5 → Н24-1: и стрелки, и кольца ВСЕГДА видимы — исчезновение
  // частей гизмо пользователь четыре раза называл багом. Кольцо «ребром»
  // остаётся рабочим: зона захвата — толстый тор, а драг при луче почти в
  // плоскости кольца уходит на запасную плоскость ⊥ взгляда (в down()).
  _updateAxisVis() {
    for (const a of ['x', 'y', 'z']) {
      this._axisVis[a].arrow = true;
      this._axisVis[a].ring = true;
    }
    this._applyVis();
  }

  _build() {
    // Компактная геометрия: стрелки короче и тоньше (с масштабом по дистанции
    // у робота они занимают ~треть корпуса, а не весь корпус, как раньше).
    const L = 0.20, R0 = 0.038, CONE = 0.05;
    const arrowGeo = new THREE.CylinderGeometry(0.005, 0.005, L, 8);
    arrowGeo.translate(0, L / 2 + R0, 0);
    const coneGeo = new THREE.ConeGeometry(0.017, CONE, 12);
    coneGeo.translate(0, L + R0 + CONE / 2, 0);
    // невидимая «толстая» зона захвата стрелки: на дистанции арены видимая
    // стрелка ~1 px толщиной, попасть в неё невозможно — луч ловим трубкой
    // вокруг всей стрелки (как у колец, где зона — толстый тор).
    const grabGeo = new THREE.CylinderGeometry(0.013, 0.013, L + CONE, 6);
    grabGeo.translate(0, (L + CONE) / 2 + R0, 0);
    // Кольца заметно крупнее стрелок (просьба «стрелочки для вращения
    // слишком маленькие»): радиус ~2.2× радиуса стрелок, толще труба и
    // щедрая невидимая зона захвата — в кольцо легко попасть курсором.
    const ringGeo = new THREE.TorusGeometry(R0 + 0.055, 0.0055, 10, 48);
    const ringHitGeo = new THREE.TorusGeometry(R0 + 0.055, 0.024, 8, 48); // зона захвата колец
    const centerGeo = new THREE.SphereGeometry(0.016, 12, 10);
    const centerGrabGeo = new THREE.SphereGeometry(0.018, 10, 8); // компактная зона центра — не перехватывает drag по полу

    const orientArrow = { x: [0, 0, -Math.PI / 2], y: [0, 0, 0], z: [Math.PI / 2, 0, 0] };
    const orientRing = { x: [0, Math.PI / 2, 0], y: [Math.PI / 2, 0, 0], z: [0, 0, 0] };
    const mk = (geo, hex, opacity, type, axis, rot, center = false) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: hex, transparent: true, opacity, depthTest: false, depthWrite: false,
      }));
      m.renderOrder = RENDER_ORDER;
      if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
      m.userData.gz = { type, axis, center };
      // Н21-3: кольца — в _rotG (оси самого объекта), стрелки/центр — в root
      (type === 'rotate' ? this._rotG : this.root).add(m);
      (type === 'rotate' ? this._pickRot : this._pickMove).push(m);
      return m;
    };
    for (const a of ['x', 'y', 'z']) {
      this._moveParts.push(
        mk(arrowGeo, COL[a], 0.9, 'move', a, orientArrow[a]),
        mk(coneGeo, COL[a], 0.9, 'move', a, orientArrow[a]),
        mk(grabGeo, COL[a], 0, 'move', a, orientArrow[a]), // невидимый луч захвата
      );
      this._rotParts.push(
        mk(ringGeo, COL[a], 0.55, 'rotate', a, orientRing[a]),
        mk(ringHitGeo, COL[a], 0, 'rotate', a, orientRing[a]), // невидимая зона захвата
      );
    }
    this._moveParts.push(
      mk(centerGeo, 0xffffff, 0.9, 'move', 'free', null, true),
      mk(centerGrabGeo, 0xffffff, 0, 'move', 'free', null, true),
    );
    this.setMode(this.mode); // применить стартовый режим к видимостям
  }

  attach(object, cb) {
    this.object = object;
    this.cb = cb || this.cb;
    this.root.visible = true;
    ATTACHED.add(this);
    this.sync();
  }

  detach() {
    this.object = null;
    this._active = null;
    this.root.visible = false;
    ATTACHED.delete(this);
  }

  // Привязка к текущему положению/повороту объекта (мировые координаты —
  // объект может быть вложен в повернутого родителя) + масштаб по дистанции,
  // чтобы гизмо занимал постоянную долю экрана (с потолком — на общей арене
  // гизмо не должен раздуваться до метровых стрелок).
  sync() {
    const o = this.object;
    if (!o) return;
    o.updateWorldMatrix(true, false);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    o.matrixWorld.decompose(wp, wq, ws);
    this.root.position.copy(wp);
    // Н21-3: root повторяет поворот РОДИТЕЛЯ (стрелки вдоль его осей: у
    // деталей арены — мировые X/Y/Z, перенос стрелкой меняет ровно одну
    // координату); _rotG хранит поворот объекта относительно родителя
    // (кольца крутят объект вокруг его собственных осей, как и раньше).
    if (o.parent) {
      o.parent.matrixWorld.decompose(_pv, _pq, _ps);
    } else {
      _pq.identity();
    }
    this.root.quaternion.copy(_pq);
    this._rotG.quaternion.copy(_pq).invert().multiply(wq);
    const d = this.camera.position.distanceTo(wp);
    // множитель 0.3: на дистанции арены (~2.5–3 м) стрелка ≈ 24 см — заметно,
    // но не больше самого объекта; вблизи (билдер, d≈1 м) ≈ 8 см.
    this.root.scale.setScalar(Math.max(0.18, Math.min(0.85, d * 0.3)));
    this._updateAxisVis(); // Н19-2: оси вдоль взгляда прячутся при каждом кадре
  }

  // Что под курсором: { type, axis, center } | null.
  // Стрелки проверяются ПЕРВЫМИ: раньше луч клика по стрелке часто проходил
  // сквозь невидимую зону захвата кольца — начиналось вращение вместо
  // переноса, и стрелки казались «нерабочими».
  hitTest(e) {
    if (!this.object || !this.root.visible) return null;
    // дети могли не пройти через рендер после attach/sync (клик в тот же кадр,
    // остановленный rAF) — без этого луч бьёт по геометрии в старом месте
    this.root.updateMatrixWorld(true);
    this._setNdc(e);
    this._ray.setFromCamera(this._ndc, this.camera);
    // Raycaster в three не учитывает visible — части выключенного режима
    // (setMode) исключаем из пикинга вручную.
    let hits = this._ray.intersectObjects(this._pickMove.filter((m) => m.visible), false);
    if (hits.length) return hits[0].object.userData.gz;
    hits = this._ray.intersectObjects(this._pickRot.filter((m) => m.visible), false);
    return hits.length ? hits[0].object.userData.gz : null;
  }

  // pointerdown: начать жест. Вернёт true, если курсор попал по гизмо.
  down(e) {
    const gz = this.hitTest(e);
    if (!gz) return false;
    this._active = gz;
    this._accSnap = 0;
    this._appliedSnap = 0;
    this._setNdc(e);
    this._ray.setFromCamera(this._ndc, this.camera);
    const o = this.object;
    this._startPos.copy(o.position);
    this._startQ.copy(o.quaternion);
    this._toParentRay();
    const rd = this._rayL.direction;
    if (gz.type === 'move') {
      if (gz.center) {
        // свободный перенос в плоскости, перпендикулярной взгляду
        this._plane.setFromNormalAndCoplanarPoint(rd, o.position);
      } else {
        // Н21-3: ось переноса — ОСЬ РОДИТЕЛЯ (мировая для деталей арены), не
        // локальная ось повёрнутого объекта: стрелка двигает ровно по одной
        // оси. Плоскость, содержащая ось переноса: нормаль — перпендикулярная
        // оси составляющая луча. (Нормаль «ось × луч» давала плоскость,
        // содержащую сам луч: intersectPlane всегда отвечал «параллельны»,
        // down() — false, и стрелки не перетаскивали объект вовсе.)
        this._axis.copy(AXIS_VEC[gz.axis]).normalize();
        const n = new THREE.Vector3().copy(rd).addScaledVector(this._axis, -rd.dot(this._axis));
        if (n.lengthSq() < 1e-8) {
          // Н22-3: луч смотрит почти вдоль оси (стрелка Y на крутом виде
          // сверху, стрелка X/Z при взгляде вдоль оси) — прежний fallback
          // «ось × ref» давал плоскость, СОДЕРЖАЩУЮ луч: пересечение
          // вырождалось, драг умирал или прыгал. Берём плоскость ⊥ взгляда
          // через объект: движение мыши в ней проецируется на ось через
          // delta·axis — стрелка остаётся рабочей с любого ракурса.
          n.copy(rd);
        }
        n.normalize();
        this._plane.setFromNormalAndCoplanarPoint(n, o.position);
      }
      if (!this._rayL.intersectPlane(this._plane, this._p0)) { this._active = null; return false; }
    } else {
      // вращение: плоскость кольца ⊥ оси. В отличие от стрелок ось —
      // СОБСТВЕННАЯ ось объекта (_startQ): кольца крутят объект вокруг его
      // локальных осей, как в 3D-редакторах
      this._axis.copy(AXIS_VEC[gz.axis]).applyQuaternion(this._startQ).normalize();
      // Н24-1: кольца больше не прячутся «ребром», но при луче почти в
      // плоскости кольца intersectPlane отвечал «параллельны» — кольцо было
      // видно и не крутилось. Запасная плоскость ⊥ взгляда через центр:
      // курсор кружит вокруг объекта на экране, _angleOf() меряет угол в
      // базисе (u, v ⊥ оси) — вращение работает с любого ракурса.
      if (Math.abs(rd.dot(this._axis)) < 0.05) {
        this._plane.setFromNormalAndCoplanarPoint(rd, o.position);
      } else {
        this._plane.setFromNormalAndCoplanarPoint(this._axis, o.position);
      }
      if (!this._rayL.intersectPlane(this._plane, this._pt)) { this._active = null; return false; }
      this._center.copy(o.position);
      this._setBasis();
      this._lastAng = this._angleOf(this._pt);
    }
    if (this.cb && this.cb.onStart) this.cb.onStart(gz);
    return true;
  }

  // pointermove: продолжить жест (если активен). true — жест наш.
  move(e) {
    if (!this._active) return false;
    this._setNdc(e);
    this._ray.setFromCamera(this._ndc, this.camera);
    this._toParentRay();
    const o = this.object;
    if (!this._rayL.intersectPlane(this._plane, this._pt)) return true;
    if (this._active.type === 'move') {
      const delta = this._pt.clone().sub(this._p0);
      if (this._active.center) {
        o.position.copy(this._startPos).add(delta);
      } else {
        this._axis.copy(AXIS_VEC[this._active.axis]).normalize(); // ось родителя (Н21-3)
        let t = delta.dot(this._axis);
        if (e.shiftKey) t = Math.round(t / SNAP_STEP) * SNAP_STEP;
        o.position.copy(this._startPos).addScaledVector(this._axis, t);
      }
    } else {
      const ang = this._angleOf(this._pt);
      let d = ang - this._lastAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this._lastAng = ang;
      if (e.shiftKey) {
        this._accSnap += d;
        const target = Math.round(this._accSnap / SNAP_ANG) * SNAP_ANG;
        d = target - this._appliedSnap;
        this._appliedSnap = target;
      }
      if (d) {
        const dq = new THREE.Quaternion().setFromAxisAngle(this._axis, d);
        o.quaternion.premultiply(dq); // поворот вокруг оси кольца (в пространстве родителя)
      }
    }
    if (this.cb && this.cb.onChange) this.cb.onChange(this._active);
    this.sync();
    return true;
  }

  // pointerup: завершить жест. true — жест был наш.
  up() {
    if (!this._active) return false;
    const gz = this._active;
    this._active = null;
    if (this.cb && this.cb.onEnd) this.cb.onEnd(gz);
    return true;
  }

  // Луч камеры в пространстве родителя объекта (жест считаем в локальных
  // координатах родителя — объект может быть вложен в повернутого родителя).
  _toParentRay() {
    const o = this.object;
    if (o.parent) {
      this._invMat.copy(o.parent.matrixWorld).invert();
    } else {
      this._invMat.identity();
    }
    this._rayL.origin.copy(this._ray.ray.origin).applyMatrix4(this._invMat);
    this._rayL.direction.copy(this._ray.ray.direction).transformDirection(this._invMat).normalize();
  }

  // Базис плоскости вращения (u, v ⊥ оси) — по первому вектору от центра
  _setBasis() {
    const ref = Math.abs(this._axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this._u.crossVectors(this._axis, ref).normalize();
    this._v.crossVectors(this._axis, this._u).normalize();
  }

  _angleOf(p) {
    const d = p.clone().sub(this._center);
    return Math.atan2(d.dot(this._v), d.dot(this._u));
  }

  _setNdc(e) {
    const r = this.dom.getBoundingClientRect();
    this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
}
