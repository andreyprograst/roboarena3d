// Симуляция сенсоров: линия (яркость пола), HC-SR04 (5 лучей cannon-es),
// бампер (короткие лучи), энкодеры (дельты углов колёс → тики).
// Поддерживает штатные датчики (крепления в robot.mounts) и дополнительные
// устройства из mounts.devices (readLineDevice / readSonarDevice / bumperDevice).
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { brushFromHit, FACE_CELL } from '../world/arenas.js';

const TICKS_PER_REV = 360;
const SONAR_MAX_CM = 400;
const SONAR_MIN_CM = 2;
const SONAR_CONE = [-0.1745, -0.0873, 0, 0.0873, 0.1745]; // ±10°
const BUMPER_RANGE = 0.012; // 12 мм
// Реализм ИК-датчика линии: у него световое пятно ~1 см, показание —
// усреднённая яркость по площадке вокруг точки. У края линии значение
// меняется плавно: чем дальше датчик от линии, тем меньше её влияние
// (показание ближе к фону) — и наоборот. [dx мм, dz мм, вес]
const LINE_SPOT = [
  [0, 0, 6],
  [-5, 0, 2], [5, 0, 2], [0, -5, 2], [0, 5, 2],
  [-4, -4, 1], [4, -4, 1], [-4, 4, 1], [4, 4, 1],
];
// Датчик цвета: рефлектометрия. Штатное крепление — ~11 см от пола
// (корпус на колёсах), поэтому: полный сигнал до 10 см, дальше сигнал
// плавно падает и на 17 см пропадает совсем (0 — «поверхности не видно»).
const COLOR_MIN = 0.10;  // ближе — уверенное чтение (gain = 1)
const COLOR_MAX = 0.17;  // дальше — 0
// Луч бампера стартует в 150 мм ПОЗАДИ датчика (внутри корпуса робота —
// тела робота исключены фильтром коллизий) и идёт вперёд до 12 мм впереди
// датчика. Прямой луч из позиции датчика ненадёжен: при ударе корпус
// «продавливается» в стену, и луч, начавшийся внутри бокса стены, не
// регистрируется cannon-es вовсе; хвостовой луч всегда начинается снаружи.
const BUMPER_TAIL = 0.15;
const RAY_OPTS = { skipBackfaces: true, collisionFilterMask: 1 }; // группа робота = 2
const DOWN_VEC = new THREE.Vector3(0, -1, 0); // направление датчика цвета

export class SensorSuite {
  constructor(robot, world, scene) {
    this.robot = robot;
    this.world = world;
    this.scene = scene;

    this.groundSampler = null;    // fn(x, z) → яркость 0..255 (назначает арена)
    this.groundColor = null;      // fn(x, z) → [r,g,b] 0..255 пола (датчик цвета)
    this.colorMeshes = null;      // fn() → меши арены для луча датчика цвета
    this.isFloorMesh = null;      // fn(mesh) → bool: это пол арены?
    this.onEncoder = null;        // fn(wheelIndex 0|1, deltaTicks) — дельта за шаг физики
    this.debug = false;
    this.noiseLevel = 0;          // 0 — выкл, 1..3 — режим реализма (шумы показаний)

    this._colorRay = new THREE.Raycaster(); // луч датчика цвета (вниз)
    this._colorRay.far = COLOR_MAX + 0.05;
    this._colorOrigin = new THREE.Vector3();
    this._lightPos = new THREE.Vector3();  // временные векторы датчика света
    this._lightDir = new THREE.Vector3();

    this._lastWheelAngle = [0, 0];
    this._res = new CANNON.RaycastResult();
    this._from = new CANNON.Vec3();
    this._to = new CANNON.Vec3();
    this._dir = new CANNON.Vec3();

    // отладочные лучи сонара
    this._rayGroup = new THREE.Group();
    this._rayGroup.visible = false;
    this._rayLines = [];
    for (let i = 0; i < SONAR_CONE.length; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.6 }));
      this._rayGroup.add(line);
      this._rayLines.push(line);
    }
    scene.add(this._rayGroup);
  }

  setDebug(on) {
    this.debug = !!on;
    this._rayGroup.visible = this.debug;
  }

  // ── Режим реализма: гауссов шум + редкие сбои ──
  _gauss() {
    return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // −1..1, горб в центре
  }

  // ── ИК-датчики линии: 0 (чёрное) … 1023 (белое) ──
  readLine(i) {
    const p = this.robot.lineSensorWorldPos(i);
    return this._lineValueAt(p.x, p.z);
  }

  // Дополнительный датчик линии из mounts.devices
  readLineDevice(dev) {
    const p = this.robot.deviceLinePos(dev);
    return this._lineValueAt(p.x, p.z);
  }

  _lineValueAt(x, z) {
    const s = this.groundSampler;
    let b;
    if (s) {
      // усреднение по световому пятну датчика (см. LINE_SPOT)
      let sum = 0, wsum = 0;
      for (const [dx, dz, w] of LINE_SPOT) {
        sum += s(x + dx / 1000, z + dz / 1000) * w;
        wsum += w;
      }
      b = sum / wsum;
    } else {
      b = 235;
    }
    let v = Math.round((b / 255) * 1023);
    const L = this.noiseLevel | 0;
    if (L > 0) {
      v += Math.round(this._gauss() * 22 * L);
      if (Math.random() < 0.02 * L) v = Math.round(920 + Math.random() * 90); // «потерял» линию
    }
    return Math.max(0, Math.min(1023, v));
  }

  // ── HC-SR04: см 2..400, 0 — эха нет ──
  readSonarCm() {
    return this._sonarValueAt(this.robot.sonarPose());
  }

  // Дополнительный HC-SR04 из mounts.devices
  readSonarDevice(dev) {
    return this._sonarValueAt(this.robot.deviceSonarPose(dev));
  }

  _sonarValueAt(pose) {
    let cm = this._sonarScan(pose); // 0 — эха нет
    const L = this.noiseLevel | 0;
    if (L > 0 && cm > 0) {
      cm += this._gauss() * 0.8 * L;
      cm = Math.round(cm * 10) / 10;
      if (Math.random() < 0.03 * L) cm = 0; // пропущенный эхо-импульс
    }
    if (cm > 0 && cm < SONAR_MIN_CM) return SONAR_MIN_CM;
    if (cm > SONAR_MAX_CM) return 0;
    return cm;
  }

  // Ядро: трассировка конуса из произвольной позы. Возвращает 0 или расстояние в см
  _sonarScan(pose) {
    let minDist = Infinity;
    for (let i = 0; i < SONAR_CONE.length; i++) {
      // поворот направления конуса вокруг вертикали
      const a = SONAR_CONE[i];
      const ca = Math.cos(a), sa = Math.sin(a);
      this._dir.set(
        pose.dir.x * ca - pose.dir.z * sa,
        pose.dir.y,
        pose.dir.x * sa + pose.dir.z * ca,
      );
      this._from.set(pose.pos.x, pose.pos.y, pose.pos.z);
      this._to.set(
        pose.pos.x + this._dir.x * (SONAR_MAX_CM / 100),
        pose.pos.y + this._dir.y * (SONAR_MAX_CM / 100),
        pose.pos.z + this._dir.z * (SONAR_MAX_CM / 100),
      );
      this._res.reset();
      this.world.raycastClosest(this._from, this._to, RAY_OPTS, this._res);
      if (this._res.hasHit) minDist = Math.min(minDist, this._res.distance);

      if (this.debug) {
        const attr = this._rayLines[i].geometry.getAttribute('position');
        const end = this._res.hasHit
          ? [this._res.hitPointWorld.x, this._res.hitPointWorld.y, this._res.hitPointWorld.z]
          : [this._to.x, this._to.y, this._to.z];
        attr.setArray(new Float32Array([
          pose.pos.x, pose.pos.y, pose.pos.z, end[0], end[1], end[2],
        ]));
        attr.needsUpdate = true;
      }
    }
    if (!isFinite(minDist)) {
      // Конус ничего не увидел. Если робот уткнулся в препятствие вплотную,
      // лучи стартуют ВНУТРИ его бокса — cannon-es такие лучи не регистрирует
      // (как и у бампера). Резервный луч с «хвостом» назад (старт снаружи)
      // ловит только препятствие в пределах 20 мм впереди датчика:
      // в свободном пространстве он по-прежнему даёт «эха нет».
      const TAIL = 0.08, PROBE = 0.02;
      this._dir.set(pose.dir.x, pose.dir.y, pose.dir.z);
      this._from.set(pose.pos.x - this._dir.x * TAIL, pose.pos.y - this._dir.y * TAIL, pose.pos.z - this._dir.z * TAIL);
      this._to.set(pose.pos.x + this._dir.x * PROBE, pose.pos.y + this._dir.y * PROBE, pose.pos.z + this._dir.z * PROBE);
      this._res.reset();
      this.world.raycastClosest(this._from, this._to, RAY_OPTS, this._res);
      if (!this._res.hasHit) return 0;
      const surf = this._res.distance - TAIL; // расстояние от датчика до поверхности
      return Math.max(SONAR_MIN_CM, Math.round(surf * 100 * 10) / 10);
    }
    const cm = Math.round(minDist * 100 * 10) / 10;
    if (cm > SONAR_MAX_CM) return 0;
    if (cm < SONAR_MIN_CM) return SONAR_MIN_CM;
    return cm;
  }

  // ── Бампер: короткие лучи вперёд (ядро для штатного и доп. устройств) ──
  bumperPressed() {
    const bp = this.robot.bumperPos();
    return this._bumperAt(bp.pos, bp.dir, this.robot.mounts.bumper.width);
  }

  // Дополнительный бампер из mounts.devices
  bumperDevice(dev) {
    const bp = this.robot.deviceBumperPos(dev);
    return this._bumperAt(bp.pos, bp.dir, 0.12);
  }

  _bumperAt(pos, dir, width) {
    const offs = width > 0.13
      ? [-0.05, -0.025, 0, 0.025, 0.05]
      : [-0.04, -0.02, 0, 0.02, 0.04];
    let hit = false;
    for (const off of offs) {
      // сдвиг вбок в плоскости XZ (перпендикуляр к dir)
      const px = pos.x + dir.z * -off;
      const pz = pos.z + dir.x * off;
      const ox = px - dir.x * BUMPER_TAIL;
      const oz = pz - dir.z * BUMPER_TAIL;
      this._from.set(ox, pos.y, oz);
      this._to.set(px + dir.x * BUMPER_RANGE, pos.y, pz + dir.z * BUMPER_RANGE);
      this._res.reset();
      this.world.raycastClosest(this._from, this._to, RAY_OPTS, this._res);
      if (this._res.hasHit) { hit = true; break; }
    }
    // Реализм: дребезг контактов — редкий пропуск нажатия и ложное срабатывание.
    // При noiseLevel=0 бампер детерминирован (как и все датчики).
    const L = this.noiseLevel | 0;
    if (L > 0) {
      if (hit && Math.random() < 0.03 * L) return false;
      if (!hit && Math.random() < 0.008 * L) return true;
    }
    return hit;
  }

  // ── Датчик цвета (TCS-подобный): RGB отражённого света, 0..1023 ──
  // Реализм: луч вниз из позиции датчика. Пол — цвет канваса арены (краска
  // и разметка видны), объект — цвет материала или пиксель его текстуры.
  // Как у настоящей рефлектометрии: чем дальше поверхность, тем слабее
  // отражённый сигнал — gain = (1 − d/RANGE), за RANGE показания нулевые.
  readColorDevice(dev) {
    const p = this.robot.deviceColorPos(dev);
    return this._colorAt(p.pos.x, p.pos.y, p.pos.z, p.down);
  }

  _colorAt(x, y, z, down) {
    this._colorOrigin.set(x, y, z);
    this._colorRay.set(this._colorOrigin, down || DOWN_VEC); // Н6: наклон датчика уводит луч
    const meshes = this.colorMeshes ? this.colorMeshes() : [];
    let base = null;
    let dist = COLOR_MAX;
    if (meshes.length) {
      // матрицы мешей обязаны быть свежими: вкладка в фоне (rAF стоит) или
      // арена пересобрана между кадрами — иначе луч промахивается мимо пола
      for (const m of meshes) m.updateWorldMatrix(false, false);
      const hits = this._colorRay.intersectObjects(meshes, false);
      if (hits.length && hits[0].uv) {
        const h = hits[0];
        dist = h.distance;
        base = this.isFloorMesh && this.isFloorMesh(h.object)
          ? (this.groundColor ? this.groundColor(h.point.x, h.point.z) : [220, 220, 220])
          : this._surfaceColor(h.object, h);
      }
    }
    if (!base) {
      // луч мимо (за бортом, над пропастью) — читаем фон пола по координате
      base = this.groundColor ? this.groundColor(x, z) : [220, 220, 220];
    }
    const gain = Math.max(0, Math.min(1, (COLOR_MAX - dist) / (COLOR_MAX - COLOR_MIN)));
    const f = Math.pow(gain, 1.3) * 4; // 0..255 → 0..1023
    const L = this.noiseLevel | 0;
    const ch = (c) => {
      const v = c * f + (L > 0 ? this._gauss() * 7 * L : 0);
      return Math.max(0, Math.min(1023, Math.round(v)));
    };
    return { r: ch(base[0]), g: ch(base[1]), b: ch(base[2]) };
  }

  // Цвет поверхности под лучом: канвас-текстура (с учётом атласа граней
  // для box) или цвет материала
  _surfaceColor(mesh, hit) {
    const mat = mesh.material;
    if (!mat) return [128, 128, 128];
    const img = mat.map && mat.map.image;
    if (img && img.getContext) {
      const B = brushFromHit(mesh, hit, 0);
      const px = Math.min(img.width - 1, Math.round(B.cell ? (B.cell.col + B.u) * FACE_CELL : B.u * img.width));
      const py = Math.min(img.height - 1, Math.round(B.cell ? (B.cell.row + (1 - B.v)) * FACE_CELL : (1 - B.v) * img.width));
      const d = img.getContext('2d').getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2]];
    }
    const col = mat.color || { r: 0.5, g: 0.5, b: 0.5 };
    return [Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255)];
  }

  // ── Датчик света (фоторезистор/фотодиод): освещённость 0..1023 ──
  // Реагирует на ВСЁ окружающее освещение сцены: полусферический ambient,
  // направленный «солнечный» свет и точечные источники-лампы из редактора
  // арены. Учитывает ориентацию датчика (луч света вдоль нормали ярче) и
  // затухание точечного света с расстоянием. Погрешность растёт с реализмом.
  readLightDevice(dev) {
    const p = this.robot.deviceLightPos(dev);
    return this._illuminanceAt(p.pos, p.dir);
  }

  _illuminanceAt(pos, normal) {
    let lux = 0;
    const lp = this._lightPos, tp = this._lightDir;
    this.scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isHemisphereLight) {
        // небо сверху, земля снизу: нормаль вверх → ярче
        const t = 0.5 + 0.5 * (normal ? normal.y : 1);
        lux += o.intensity * (0.35 + 0.65 * t);
      } else if (o.isAmbientLight) {
        lux += o.intensity;
      } else if (o.isDirectionalLight) {
        o.getWorldPosition(lp);
        o.target.getWorldPosition(tp);
        lp.sub(tp).normalize();
        const d = normal ? Math.max(0, normal.dot(lp)) : 1;
        lux += o.intensity * (0.15 + 0.85 * d);
      } else if (o.isPointLight) {
        o.getWorldPosition(lp);
        lp.sub(pos);
        const dist = lp.length();
        lp.normalize();
        const d = normal ? Math.max(0, normal.dot(lp)) : 1;
        const range = o.distance || 6;
        const atten = 1 / (1 + (dist / range) * (dist / range) * 4);
        lux += o.intensity * (0.2 + 0.8 * d) * atten;
      }
    });
    // сырая освещённость → 0..1023 (типичная сцена ~2.8 при взгляде вверх)
    let v = Math.round(Math.max(0, Math.min(1, lux / 3.2)) * 1023);
    const L = this.noiseLevel | 0;
    if (L > 0) {
      v += Math.round(this._gauss() * 15 * L);
      if (Math.random() < 0.02 * L) v = Math.round(v * (0.6 + Math.random() * 0.3)); // мерцание сети
    }
    return Math.max(0, Math.min(1023, v));
  }

  // ── Энкодеры: вызывать после каждого шага физики ──
  postPhysics(dt) {
    const a = this.robot.wheelAngle;
    const L = this.noiseLevel | 0;
    for (let i = 0; i < 2; i++) {
      const delta = a[i] - this._lastWheelAngle[i];
      this._lastWheelAngle[i] = a[i];
      if (!this.onEncoder) continue;
      let ticks = Math.round((delta / (2 * Math.PI)) * TICKS_PER_REV);
      // Реализм: дребезг квадратурного энкодера — редкий лишний/пропущенный тик.
      // При noiseLevel=0 тики точные.
      if (L > 0 && ticks !== 0 && Math.random() < 0.05 * L) {
        ticks += Math.random() < 0.5 ? -1 : 1;
      }
      if (ticks > 600) ticks = 600;
      if (ticks < -600) ticks = -600;
      if (ticks !== 0) this.onEncoder(i, ticks);
    }
  }
}
