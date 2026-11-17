// Three.js-сцена: рендерер, свет, камера (орбита/следящая/сверху), resize.
import * as THREE from 'three';

export class SceneRig {
  constructor(container) {
    this.container = container;
    // stencil: true обязательно для объектов-«дырок» (Н9-2): с r163 three.js
    // по умолчанию создаёт контекст БЕЗ stencil-буфера — проёмы бы не работали
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Н25-1: локальные clipping-плоскости — стенки тоннеля дырки (внутренняя
    // поверхность объёма) обрезаются по границам режемого объекта, иначе
    // «крышка» тоннеля рисовалась в воздухе за сквозным проёмом
    this.renderer.localClippingEnabled = true;
    container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10141b);
    this.scene.fog = new THREE.Fog(0x10141b, 14, 34); // было 8/22 — на больших полях дальний край «тонул» в тумане

    // Свет
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2b2620, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
    sun.position.set(3, 6, 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // ПН10-1: фрустум ±3.5 покрывал только центр — на поле 8×8 тени у краёв
    // пропадали/появлялись при движении. 8×8 → полудиагональ 5.7 м, берём с запасом.
    sun.shadow.camera.left = -6.5;
    sun.shadow.camera.right = 6.5;
    sun.shadow.camera.top = 6.5;
    sun.shadow.camera.bottom = -6.5;
    sun.shadow.camera.far = 26;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02; // убирает полосы-«акне» на освещённых гранях бортов/объектов
    this.scene.add(sun);
    this.sun = sun;

    // Камера
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
    this.camera.position.set(1.6, 1.4, 2.2);

    // Орбита
    this.orbit = {
      target: new THREE.Vector3(0, 0.1, 0),
      distance: 2.6,
      yaw: 0.7,
      pitch: 0.55,
      minPitch: 0.08,
      maxPitch: 1.45,
      minDist: 0.4,
      maxDist: 9,
    };
    this.mode = 'orbit'; // orbit | follow | top
    this.followRobot = null;

    this._bindInput();
    this._onResize();
    window.addEventListener('resize', () => this._onResize());
    // Н8-1/Н8-2: канвас должен следить за ПАНЕЛЬЮ, а не за окном. Раскладка
    // меняется без window.resize (edit-mode схлопывает грид, скрытие кода,
    // перетаскивание границы) — без наблюдателя канвас оставался старого
    // размера: справа торчал чёрный прямоугольник фона панели, а сцена
    // «дёргалась»/перекрывала редактор кода при возврате раскладки.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(container);
    }

    // Хук для инструментов поверх сцены (редактор арены): вернуть true из
    // inputGuard(e), чтобы запретить орбите перехватить это нажатие.
    this.inputGuard = null;
  }

  _onResize() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    this._lastW = w;
    this._lastH = h;
    // true — обновлять CSS-размер канваса: при DPR>1 layout-размер без стиля
    // равен атрибуту (пиксели × DPR) и канвас вылезает за панель
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this._override) {
      this._override.camera.aspect = w / h;
      this._override.camera.updateProjectionMatrix();
    }
  }

  // Рендер подменяется другой сценой (студия редактора робота): арена не
  // рисуется и не мешает обзору. null — вернуть обычный рендер.
  setOverride(scene, camera) {
    this._override = scene ? { scene, camera } : null;
  }

  _bindInput() {
    const el = this.renderer.domElement;
    // Н9-1: ПКМ — поворот (орбита), колесо — панорама, ЛКМ — только выбор
    // и инструменты редакторов (камеру не крутит).
    let dragBtn = -1;   // 2 — ПКМ: орбита, 1 — колесо: панорама, -1 — нет драга
    let lastX = 0;
    let lastY = 0;
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'orbit') return;
      if (e.button !== 1 && e.button !== 2) return; // ЛКМ — камере не достаётся
      if (this.inputGuard && this.inputGuard(e)) return; // инструмент забрал жест себе
      dragBtn = e.button;
      lastX = e.clientX;
      lastY = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch { /* синтетические события */ }
    });
    // Средняя кнопка (колесо) — панорама; preventDefault гасит штатный
    // автоскролл браузера от клика колесом.
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('pointermove', (e) => {
      if (this.mode !== 'orbit' || dragBtn === -1) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dragBtn === 2) {
        // ПКМ: вращение вокруг цели
        this.orbit.yaw -= dx * 0.006;
        this.orbit.pitch = Math.min(this.orbit.maxPitch, Math.max(this.orbit.minPitch, this.orbit.pitch + dy * 0.006));
      } else if (dragBtn === 1) {
        // Колесо (средняя кнопка): панорама «перетаскиванием пола» —
        // цель ездит по горизонтали, yaw/pitch не меняются
        const s = 0.0016 * this.orbit.distance;
        const right = new THREE.Vector3(Math.cos(this.orbit.yaw), 0, -Math.sin(this.orbit.yaw));
        const fwdH = new THREE.Vector3(-Math.sin(this.orbit.yaw), 0, -Math.cos(this.orbit.yaw));
        this.orbit.target.addScaledVector(right, -dx * s);
        this.orbit.target.addScaledVector(fwdH, dy * s);
        const t = this.orbit.target;
        t.x = Math.max(-6, Math.min(6, t.x));
        t.z = Math.max(-6, Math.min(6, t.z));
        t.y = Math.max(0, Math.min(2, t.y));
      }
    });
    const endDrag = (e) => {
      if (e.type === 'pointercancel' || e.button === dragBtn) dragBtn = -1;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbit.distance = Math.min(this.orbit.maxDist, Math.max(this.orbit.minDist, this.orbit.distance * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setMode(mode, robot) {
    this.mode = mode;
    this.followRobot = robot || null;
    if (mode === 'orbit' && robot) {
      // сохранить текущую цель около робота
      this.orbit.target.copy(robot.body.position);
    }
  }

  // Войти в орбиту БЕЗ прыжка камеры (просьба 1): текущая позиция камеры и
  // точка взгляда пересчитываются в параметры орбиты. Раньше при входе в
  // редактор из следящего режима камера «прыгала» на старые orbit-параметры.
  enterOrbitPreserving() {
    if (this.mode === 'orbit') return;
    const c = this.camera.position;
    const target = this.followRobot
      ? this.followRobot.body.position.clone()
      : this.orbit.target.clone();
    if (this.mode === 'follow' && this.followRobot) target.y += 0.05; // lookAt целился чуть выше центра
    const d = new THREE.Vector3().subVectors(c, target);
    this.orbit.target.copy(target);
    this.orbit.yaw = Math.atan2(d.x, d.z);
    this.orbit.pitch = Math.min(this.orbit.maxPitch,
      Math.max(this.orbit.minPitch, Math.atan2(d.y, Math.hypot(d.x, d.z))));
    this.orbit.distance = Math.max(0.05, d.length());
    this.mode = 'orbit';
    this.followRobot = null;
  }

  // Плоскость перетаскивания под ориентацию камеры (ПН9-6: «если камера
  // смотрит параллельно осям X и Y — двигать только по ним, и так со всеми
  // осями»). Смотрим заметно сверху — горизонтальная плоскость через point
  // (движение по X/Z); смотрим сбоку — вертикальная плоскость, но нормаль
  // НЕ непрерывная, а прилипает к ближайшей ГОРИЗОНТАЛЬНОЙ ОСИ: взгляд вдоль
  // Z → плоскость X-Y (двигаем по X и Y), взгляд вдоль X → плоскость Y-Z.
  // Мышь ведёт объект строго по осям, которые видны на экране.
  // out — THREE.Plane; возврат 'xz'|'vert'.
  dragPlaneAt(point, out) {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    const n = new THREE.Vector3();
    if (Math.abs(pitch) > 0.6) n.set(0, 1, 0); // взгляд почти вертикален (сверху) — пол X/Z
    else if (Math.abs(dir.x) > Math.abs(dir.z)) n.set(1, 0, 0);
    else n.set(0, 0, 1);
    out.setFromNormalAndCoplanarPoint(n, point);
    return Math.abs(pitch) > 0.6 ? 'xz' : 'vert';
  }

  update(dt) {
    // Н8-1/Н8-2: страховка к ResizeObserver — чтение дешёвое при чистой
    // раскладке, а канвас не может «отстать» от панели ни в каком режиме.
    if (this.container.clientWidth !== this._lastW ||
        this.container.clientHeight !== this._lastH) this._onResize();
    if (this.mode === 'follow' && this.followRobot) {
      const p = this.followRobot.body.position;
      const q = this.followRobot.body.quaternion;
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      const camTarget = new THREE.Vector3(p.x, p.y, p.z)
        .addScaledVector(fwd, -0.55)
        .add(new THREE.Vector3(0, 0.42, 0));
      this.camera.position.lerp(camTarget, Math.min(1, dt * 4));
      this.camera.lookAt(p.x, p.y + 0.05, p.z);
    } else if (this.mode === 'top') {
      const p = this.followRobot ? this.followRobot.body.position : this.orbit.target;
      this.camera.position.lerp(new THREE.Vector3(p.x, 3.2, p.z + 0.001), Math.min(1, dt * 5));
      this.camera.lookAt(p.x, 0, p.z);
    } else {
      const o = this.orbit;
      const cp = new THREE.Vector3(
        o.target.x + o.distance * Math.cos(o.pitch) * Math.sin(o.yaw),
        o.target.y + o.distance * Math.sin(o.pitch),
        o.target.z + o.distance * Math.cos(o.pitch) * Math.cos(o.yaw),
      );
      // Без lerp: камера жёстко привязана к цели — панорама колесом двигает
      // её строго поступательно (yaw/pitch неизменны), без «доворота».
      this.camera.position.copy(cp);
      this.camera.lookAt(o.target);
    }
    this.sun.position.set(this.camera.position.x + 3, 6, this.camera.position.z + 2);
  }

  render() {
    if (this._override) {
      this.renderer.render(this._override.scene, this._override.camera);
      return;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
