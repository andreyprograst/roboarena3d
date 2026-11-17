// Виртуальный робот: физическое тело (cannon-es) + меши (three.js).
// Дифференциальный привод кинематический: моторам соответствует скорость
// корпуса вперёд и скорость рыскания; корпус опирается на две сферы-кастора
// и честно сталкивается со стенами, ящиками и рампой.
// Локальная ось «вперёд» = +z, «влево» = +x.

import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { remapBoxAtlasUV } from '../world/arenas.js';

export const WHEEL_R = 0.033;
export const MAX_WHEEL_OMEGA = 30; // рад/с ≈ 1 м/с
export const MOTOR_TAU = 0.08;     // постоянная времени разгона, с
export const TICKS_PER_REV = 360;  // тики энкодера на оборот колеса

export const DEFAULT_MOUNTS = {
  // Н6: у каждого датчика полная 6-степенная постановка —
  // x/height/z (позиция, height = Y) и pitchDeg/yawDeg/rollDeg (повороты).
  // Старые сохранённые крепления без новых полей работают: потребители
  // подставляют значения по умолчанию через ?? / ||.
  // A0 — левый (+x), A1 — центр, A2 — правый (−x); z — вынос вперёд
  line: [
    { x: 0.025, z: 0.095, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 },
    { x: 0.0, z: 0.095, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 },
    { x: -0.025, z: 0.095, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 },
  ],
  sonar: { x: 0, z: 0.105, height: 0.045, pitchDeg: 0, yawDeg: 0, rollDeg: 0 },
  bumper: { x: 0, z: 0.125, width: 0.14, height: 0.012, pitchDeg: 0, yawDeg: 0, rollDeg: 0 },
  servo: { x: 0.05, z: -0.05, height: 0, pitchDeg: 0, yawDeg: 0, rollDeg: 0 },
  // ── Корпус и колёса (редактируются в редакторе робота) ──
  chassis: { enabled: true, w: 0.18, h: 0.075, l: 0.24, color: '#2e3440' },
  wheels: { r: 0.033, width: 0.026, track: 0.206, z: 0, speed: 1 },
  // Карта устройств: пины + доп. датчики. Первые записи связаны со штатной
  // механикой (line → mounts.line, sonar → mounts.sonar, bumper → mounts.bumper,
  // первый servo → mounts.servo/качалка); остальные несут собственное крепление.
  // Пины D2/D3 (энкодеры) и D4–D8, D12 (моторы) — железо, не переназначаются.
  devices: [
    { type: 'line', pin: 14 },   // A0
    { type: 'line', pin: 15 },   // A1
    { type: 'line', pin: 16 },   // A2
    { type: 'sonar', trig: 11, echo: 17 }, // D11 + A3
    { type: 'bumper', pin: 13 }, // D13
    { type: 'servo', pin: 9 },   // сервопривод №1
    { type: 'servo', pin: 10, x: -0.05, z: -0.05, height: 0, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }, // сервопривод №2
    { type: 'color', pin: 18, x: 0.035, z: 0.098, height: 0.004, pitchDeg: 0, yawDeg: 0, rollDeg: 0 }, // датчик цвета (A4): RGB вниз
  ],
  // Детали 3D-модели (редактор робота): визуальные боксы/цилиндры без физики.
  // servo >= 0 — деталь крепится к качалке сервопривода и вращается с ней.
  parts: [],
};

const CHASSIS = { w: 0.18, h: 0.075, l: 0.24 };
const CHASSIS_Y = 0.055;
const WHEEL_X = 0.103;         // половина колеи (дефолт)
const MAX_YAW_RATE = 10;       // рад/с, предохранитель
const UP_VEC = new CANNON.Vec3(0, 1, 0); // ось выравнивания корпуса
const TIP_MIN_SPEED = 0.3;     // м/с по нормали контакта: ниже — просто упираемся

export { CHASSIS, CHASSIS_Y };

// ── Конфигурация корпуса/колёс с зажимом в разумные пределы ──
export function chassisCfg(mounts) {
  const c = (mounts && mounts.chassis) || DEFAULT_MOUNTS.chassis;
  const enabled = c.enabled !== false;
  return {
    enabled,
    w: Math.max(0.08, Math.min(0.30, +c.w || CHASSIS.w)),
    h: Math.max(0.03, Math.min(0.14, +c.h || CHASSIS.h)),
    l: Math.max(0.10, Math.min(0.36, +c.l || CHASSIS.l)),
    color: c.color || '#2e3440',
  };
}

export function wheelsCfg(mounts) {
  const w = (mounts && mounts.wheels) || DEFAULT_MOUNTS.wheels;
  return {
    r: Math.max(0.015, Math.min(0.06, +w.r || WHEEL_R)),
    width: Math.max(0.010, Math.min(0.05, +w.width || 0.026)),
    track: Math.max(0.12, Math.min(0.30, +w.track || 0.206)),
    z: Math.max(-0.08, Math.min(0.08, +w.z || 0)),
    speed: Math.max(0.2, Math.min(2, +w.speed || 1)),
  };
}

// Высота корпуса над полом: низ корпуса висит на 2.5 мм над касторами
// (r=12 мм) — как у заводской модели.
export function chassisYOf(mounts) {
  const c = chassisCfg(mounts);
  return 0.015 + (c.enabled ? c.h : 0.02) / 2 + 0.0025;
}

// Ключ конфигурации корпуса/колёс: пересобирать меши/физику только при изменении
export function chassisKey(mounts) {
  const c = chassisCfg(mounts), w = wheelsCfg(mounts);
  return [c.enabled ? 1 : 0, c.w, c.h, c.l, c.color, w.r, w.width, w.track, w.z].join('|');
}

// ── Фабрики 3D-моделей датчиков и моторов (общие для штатной механики
// и доп. устройств: «датчикам и моторам — модели как у сонара») ──

export function makeLineSensorVisual() {
  const g = new THREE.Group();
  const pcb = new THREE.Mesh(
    new THREE.BoxGeometry(0.014, 0.0025, 0.010),
    new THREE.MeshStandardMaterial({ color: 0x1d6e46, roughness: 0.6 }),
  );
  g.add(pcb);
  const chip = new THREE.Mesh(
    new THREE.BoxGeometry(0.006, 0.0015, 0.004),
    new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.4 }),
  );
  chip.position.set(0, 0.002, 0.001);
  g.add(chip);
  const ledMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 });
  for (const ex of [-0.004, 0.004]) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.001, 0.002), ledMat);
    led.position.set(ex, 0.002, -0.002);
    g.add(led);
  }
  return g;
}

export function makeSonarVisual() {
  const g = new THREE.Group();
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.045, 0.003, 0.025),
    new THREE.MeshStandardMaterial({ color: 0x1d5e46, roughness: 0.7 }),
  );
  g.add(board);
  const eyeGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.012, 12);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x20242c, metalness: 0.6, roughness: 0.3 });
  for (const ex of [-0.013, 0.013]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.rotation.x = Math.PI / 2;
    eye.position.set(ex, 0.006, 0.01);
    g.add(eye);
  }
  const crystal = new THREE.Mesh(
    new THREE.BoxGeometry(0.006, 0.002, 0.005),
    new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.7, roughness: 0.3 }),
  );
  crystal.position.set(0, 0.0025, -0.007);
  g.add(crystal);
  return g;
}

export function makeBumperVisual(width = 0.14) {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.02, 0.012),
    new THREE.MeshStandardMaterial({ color: 0xd9903f, roughness: 0.5 }),
  );
  g.add(bar);
  const screwMat = new THREE.MeshStandardMaterial({ color: 0x9aa2b1, metalness: 0.8, roughness: 0.3 });
  const screws = [];
  for (const ex of [-width / 2 + 0.008, width / 2 - 0.008]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.004, 10), screwMat);
    s.position.set(ex, 0.006, 0);
    g.add(s);
    screws.push(s);
  }
  // микропереключатель по центру: корпус + красный рычажок вниз
  const sw = new THREE.Mesh(
    new THREE.BoxGeometry(0.014, 0.010, 0.008),
    new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.5 }),
  );
  sw.position.set(0, 0.002, -0.008);
  g.add(sw);
  const lever = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.002, 0.010),
    new THREE.MeshStandardMaterial({ color: 0xc94040, roughness: 0.5 }),
  );
  lever.position.set(0, -0.004, -0.007);
  g.add(lever);
  // ширина планки меняется из редактора
  g.setWidth = (w) => {
    bar.geometry.dispose();
    bar.geometry = new THREE.BoxGeometry(w, 0.02, 0.012);
    screws[0].position.x = -w / 2 + 0.008;
    screws[1].position.x = w / 2 - 0.008;
  };
  return g;
}

export function makeGyroVisual() {
  const g = new THREE.Group();
  const pcb = new THREE.Mesh(
    new THREE.BoxGeometry(0.022, 0.0025, 0.022),
    new THREE.MeshStandardMaterial({ color: 0x2b5cad, roughness: 0.5 }),
  );
  g.add(pcb);
  const can = new THREE.Mesh(
    new THREE.CylinderGeometry(0.005, 0.005, 0.004, 12),
    new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.8, roughness: 0.25 }),
  );
  can.position.y = 0.003;
  g.add(can);
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xd9b536, metalness: 0.7, roughness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.003, 0.002), pinMat);
    pin.position.set(-0.006 + i * 0.004, 0.0025, -0.012);
    g.add(pin);
  }
  return g;
}

// Датчик цвета (TCS-подобный): плата + линза фотодиодов, смотрит вниз
export function makeColorSensorVisual() {
  const g = new THREE.Group();
  const pcb = new THREE.Mesh(
    new THREE.BoxGeometry(0.018, 0.0025, 0.013),
    new THREE.MeshStandardMaterial({ color: 0x1a2f52, roughness: 0.55 }),
  );
  g.add(pcb);
  const chip = new THREE.Mesh(
    new THREE.BoxGeometry(0.006, 0.0015, 0.006),
    new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.4 }),
  );
  chip.position.set(0, 0.002, 0.002);
  g.add(chip);
  // «линза» со светофильтрами RGB — как у реального модуля
  const lensCols = [0xe5484d, 0x51cf66, 0x4dabf7];
  lensCols.forEach((c, i) => {
    const lens = new THREE.Mesh(
      new THREE.BoxGeometry(0.0035, 0.0012, 0.0035),
      new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, roughness: 0.3 }),
    );
    lens.position.set(-0.005 + i * 0.005, 0.002, -0.003);
    g.add(lens);
  });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xd9b536, metalness: 0.7, roughness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.003, 0.002), pinMat);
    pin.position.set(-0.0045 + i * 0.003, 0.0025, -0.0075);
    g.add(pin);
  }
  return g;
}

// Датчик света (фоторезистор): плата + полупрозрачный купол-фотодиод сверху
export function makeLightSensorVisual() {
  const g = new THREE.Group();
  const pcb = new THREE.Mesh(
    new THREE.BoxGeometry(0.016, 0.0025, 0.012),
    new THREE.MeshStandardMaterial({ color: 0x243a2a, roughness: 0.55 }),
  );
  g.add(pcb);
  // купол-фотодиод (полусфера), смотрит вверх — мерит окружающий свет
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.005, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffcf5a, emissiveIntensity: 0.45, roughness: 0.25, transparent: true, opacity: 0.92 }),
  );
  dome.position.set(0, 0.0015, 0.001);
  g.add(dome);
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xd9b536, metalness: 0.7, roughness: 0.4 });
  for (let i = 0; i < 3; i++) {
    const pin = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.003, 0.002), pinMat);
    pin.position.set(-0.003 + i * 0.003, 0.0025, -0.0065);
    g.add(pin);
  }
  return g;
}

// Мотор-редуктор ведущего колеса: цилиндр двигателя + редуктор + вал
export function makeMotorVisual() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 0.030, 12),
    new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.6, roughness: 0.4 }),
  );
  body.rotation.z = Math.PI / 2; // ось вдоль X
  g.add(body);
  const gearbox = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.016, 0.016),
    new THREE.MeshStandardMaterial({ color: 0x3a4150, roughness: 0.6 }),
  );
  g.add(gearbox);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0025, 0.0025, 0.010, 8),
    new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.8, roughness: 0.3 }),
  );
  shaft.rotation.z = Math.PI / 2;
  shaft.position.x = 0.010;
  g.add(shaft);
  return g;
}

// ── Визуальная модель робота (общая для сцены и 3D-редактора) ──
// Возвращает набор мешей в локальных координатах: корпус 180×75×240 мм,
// вперёд +z, влево +x. Позиции датчиков расставляет applyMounts(),
// размеры корпуса/колёс — applyChassisWheels().
export function buildRobotVisuals() {
  const group = new THREE.Group();

  const chassisMesh = new THREE.Mesh(
    new THREE.BoxGeometry(CHASSIS.w, CHASSIS.h, CHASSIS.l),
    new THREE.MeshStandardMaterial({ color: 0x2e3440, roughness: 0.6, metalness: 0.2 }),
  );
  chassisMesh.castShadow = true;
  chassisMesh.receiveShadow = true;
  chassisMesh.userData.chassis = true; // редактор: корпус выбирается как обычный блок
  group.add(chassisMesh);

  // Нос-маркер
  const noseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(CHASSIS.w * 0.6, 0.012, 0.02),
    new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0x552200, roughness: 0.4 }),
  );
  noseMesh.position.set(0, 0.01, CHASSIS.l / 2 + 0.005);
  group.add(noseMesh);

  // Колёса (ось цилиндра — вдоль X, ось вращения колеса). Геометрия у каждого
  // колеса своя — размер меняется из редактора (applyChassisWheels).
  const wheelMeshes = [];
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.9 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xff8a2a, roughness: 0.5, metalness: 0.4 });
  for (const x of [WHEEL_X, -WHEEL_X]) {
    const wm = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.026, 20), wheelMat);
    tire.rotation.z = Math.PI / 2; // цилиндр из вертикали → на ось X: колесо, а не блин
    tire.castShadow = true;
    wm.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R * 0.45, WHEEL_R * 0.45, 0.028, 12), hubMat);
    hub.rotation.z = Math.PI / 2;
    wm.add(hub);
    wm.position.set(x, -0.0195, 0);
    wm.userData.tire = tire;
    wm.userData.hub = hub;
    wm.userData.wheel = wheelMeshes.length; // редактор: колесо — выбираемый объект
    group.add(wm);
    wheelMeshes.push(wm);
  }

  // Мотор-редукторы за колёсами (модели, как у сонара)
  const motorMeshes = [];
  for (const x of [WHEEL_X, -WHEEL_X]) {
    const mm = makeMotorVisual();
    mm.position.set(x - Math.sign(x) * 0.026, -0.0195, 0);
    mm.rotation.y = x > 0 ? Math.PI : 0; // редуктор к колесу
    group.add(mm);
    motorMeshes.push(mm);
  }

  // Датчики линии (3 платы TCRT)
  const lineMeshes = [];
  for (let i = 0; i < 3; i++) {
    const m = makeLineSensorVisual();
    group.add(m);
    lineMeshes.push(m);
  }

  // УЗ-дальномер (плата с двумя «глазами»)
  const sonarMesh = makeSonarVisual();
  group.add(sonarMesh);

  // Бампер
  const bumperMesh = makeBumperVisual(0.14);
  group.add(bumperMesh);

  // Сервопривод: корпус с монтажными ушками + качалка (белый диск с рычагом),
  // к которой крепятся детали из редактора модели. Флажков больше нет —
  // это именно сервомотор. Качалка — отдельная группа: её вращает updateServo.
  const servoMesh = new THREE.Group(); // корпус (не вращается)
  const servoBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.032, 0.022, 0.018),
    new THREE.MeshStandardMaterial({ color: 0x1a3a6b, roughness: 0.6 }),
  );
  servoBody.position.y = 0.011;
  servoMesh.add(servoBody);
  const flange = new THREE.Mesh(
    new THREE.BoxGeometry(0.046, 0.002, 0.012),
    new THREE.MeshStandardMaterial({ color: 0x16305a, roughness: 0.6 }),
  );
  flange.position.y = 0.0215;
  servoMesh.add(flange);
  const servoHorn = new THREE.Group(); // качалка: вращается вокруг вертикали
  const hornHub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 0.004, 14),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.4 }),
  );
  hornHub.position.y = 0.0245;
  servoHorn.add(hornHub);
  const hornArm = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.0025, 0.005),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.4 }),
  );
  hornArm.position.set(0.006, 0.027, 0);
  servoHorn.add(hornArm);
  servoMesh.add(servoHorn);
  group.add(servoMesh);

  return { group, chassisMesh, noseMesh, wheelMeshes, motorMeshes, lineMeshes, sonarMesh, bumperMesh, servoMesh, servoHorn };
}

// Единая ориентация датчика из крепления (Н6): рыскание → наклон → крен.
// Порядок YXZ — как у штатного сонара; pitchDeg>0 = наклон ВНИЗ.
function mountRot(obj, d) {
  obj.rotation.order = 'YXZ';
  obj.rotation.set(
    -(d.pitchDeg || 0) * Math.PI / 180,
    (d.yawDeg || 0) * Math.PI / 180,
    (d.rollDeg || 0) * Math.PI / 180,
  );
}

// Расставить меши датчиков по креплениям (Robot.syncMounts и 3D-редактор).
// Высоты — относительно ПЕРЕДНЕЙ кромки корпуса: у редактируемого корпуса
// верх = h/2 (V.chassisHEff() учитывает скрытый корпус).
export function applyMounts(mounts, V) {
  const m = mounts;
  const topY = V.chassisHEff ? V.chassisHEff() / 2 : CHASSIS.h / 2;
  V.lineMeshes.forEach((mesh, i) => {
    mesh.position.set(m.line[i].x, topY + (m.line[i].height ?? 0.004), m.line[i].z);
    mountRot(mesh, m.line[i]);
  });
  V.sonarMesh.position.set(m.sonar.x, topY + m.sonar.height, m.sonar.z);
  mountRot(V.sonarMesh, m.sonar);
  if (V.bumperMesh.setWidth) V.bumperMesh.setWidth(m.bumper.width);
  V.bumperMesh.position.set(
    m.bumper.x || 0,
    m.bumper.height ?? 0.012,
    Math.min(m.bumper.z, (V.chassisLEff ? V.chassisLEff() : CHASSIS.l) / 2 + 0.012),
  );
  mountRot(V.bumperMesh, m.bumper);
  V.servoMesh.position.set(m.servo.x, topY + (m.servo.height || 0), m.servo.z);
  mountRot(V.servoMesh, m.servo);
}

// ── Дополнительные устройства из mounts.devices ──
// (пере)создаёт группу мешей внутри parentGroup; возвращает массив качалок
// серв (для Robot.updateServo). Штатные меши (line 0..2, сонар, бампер,
// сервопривод №1) здесь не дублируются — только устройства со своим креплением.
export function applyDeviceVisuals(mounts, parentGroup) {
  const counts = { line: 0, sonar: 0, bumper: 0, servo: 0 };
  for (const d of mounts.devices || []) counts[d.type] = (counts[d.type] || 0) + 1;
  const nLine = counts.line, nSonar = counts.sonar, nBumper = counts.bumper, nServo = counts.servo;

  let g = parentGroup.getObjectByName('devices');
  if (g) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse?.((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose?.(); });
    }
  } else {
    g = new THREE.Group();
    g.name = 'devices';
    parentGroup.add(g);
  }

  const arms = [];
  let iLine = 0, iSonar = 0, iBumper = 0, iServo = 0;
  const mkMat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra });

  for (const d of mounts.devices || []) {
    if (d.type === 'line') {
      const k = iLine++;
      if (k < 3) continue; // штатная тройка уже отрисована
      const m = makeLineSensorVisual();
      m.position.set(d.x, CHASSIS.h / 2 + (d.height ?? 0.004), d.z);
      mountRot(m, d);
      g.add(m);
    } else if (d.type === 'sonar') {
      const k = iSonar++;
      if (k < 1) continue; // штатный сонар уже отрисован
      const sg = makeSonarVisual();
      sg.position.set(d.x, CHASSIS.h / 2 + (d.height ?? 0.045), d.z);
      mountRot(sg, d);
      g.add(sg);
    } else if (d.type === 'bumper') {
      const k = iBumper++;
      if (k < 1) continue; // штатный бампер уже отрисован
      const m = makeBumperVisual(0.12);
      m.position.set(d.x || 0, d.height ?? 0.012, d.z);
      mountRot(m, d);
      g.add(m);
    } else if (d.type === 'gyro') {
      // штатного гироскопа нет — каждая запись рисует свою плату-модуль
      const m = makeGyroVisual();
      m.position.set(d.x || 0, CHASSIS.h / 2 + (d.height ?? 0.004), d.z || 0);
      mountRot(m, d);
      g.add(m);
    } else if (d.type === 'color') {
      // датчик цвета: каждая запись — своя плата, линза смотрит вниз
      const m = makeColorSensorVisual();
      m.position.set(d.x || 0, CHASSIS.h / 2 + (d.height ?? 0.004), d.z || 0);
      mountRot(m, d);
      g.add(m);
    } else if (d.type === 'light') {
      // датчик света: своя плата с куполом-фотодиодом, смотрит вверх
      const m = makeLightSensorVisual();
      m.position.set(d.x || 0, CHASSIS.h / 2 + (d.height ?? 0.004), d.z || 0);
      mountRot(m, d);
      g.add(m);
    } else if (d.type === 'servo') {
      const k = iServo++;
      if (k < 1) continue; // штатный сервопривод уже отрисован (robot.servoHorn)
      const sg = new THREE.Group(); // корпус: бокс + монтажные ушки
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.022, 0.018), mkMat(0x1a3a6b));
      body.position.y = 0.011;
      sg.add(body);
      const flange = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.002, 0.012), mkMat(0x16305a));
      flange.position.y = 0.0215;
      sg.add(flange);
      sg.position.set(d.x, CHASSIS.h / 2 + (d.height || 0), d.z);
      mountRot(sg, d);
      g.add(sg);
      const arm = new THREE.Group(); // качалка (вращается updateServo)
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 14), mkMat(0xf2f4f8, { roughness: 0.4 }));
      hub.position.y = 0.0245;
      arm.add(hub);
      const hornArm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.0025, 0.005), mkMat(0xf2f4f8, { roughness: 0.4 }));
      hornArm.position.set(0.006, 0.027, 0);
      arm.add(hornArm);
      arm.position.set(d.x, CHASSIS.h / 2 + (d.height || 0), d.z);
      arm.userData.baseYaw = (d.yawDeg || 0) * Math.PI / 180;
      g.add(arm);
      arms.push(arm);
    }
  }
  void counts;
  return arms;
}

// ── Детали 3D-модели (mounts.parts) ──
// Визуальные детали (боксы/цилиндры) из редактора робота. Физики у них нет —
// как у качалок серв. Деталь с servo >= 0 становится ребёнком качалки
// сервопривода и вращается вместе с ней. Координаты: x/z — система корпуса
// (вперёд +z), y — высота от пола при роботе на земле.
export function applyParts(mounts, robot) {
  const group = robot.group;
  // Старые детали убираем ОБХОДОМ всей группы робота: серво-детали — дети
  // качалки (arm), а не группы parts; раньше чистились только дети parts,
  // и при каждом apply() старый меш оставался на качалке — деталь
  // «клонировалась» при первом же перетаскивании.
  const stale = [];
  group.traverse((o) => { if (o.userData && o.userData.partIdx !== undefined) stale.push(o); });
  for (const o of stale) {
    if (o.parent) o.parent.remove(o);
    o.traverse?.((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material.dispose) c.material.dispose();
    });
  }
  let g = group.getObjectByName('parts');
  if (!g) {
    g = new THREE.Group();
    g.name = 'parts';
    group.add(g);
  }
  const servos = robot.servos || [];
  // опорные точки серв: №0 — штатный (mounts.servo), дальше — доп. из devices
  const sv = (mounts.devices || []).filter((d) => d.type === 'servo');
  const servoBase = [
    { x: mounts.servo.x, z: mounts.servo.z },
    ...sv.slice(1).map((d) => ({ x: d.x, z: d.z })),
  ];
  const S = servoBase.length;
  const baseY = robot.chassisY ? robot.chassisY() : CHASSIS_Y; // высота корпуса над полом
  const hEff = robot.chassisHEff ? robot.chassisHEff() : CHASSIS.h;

  for (let i = 0; i < (mounts.parts || []).length; i++) {
    const p = mounts.parts[i];
    const mesh = partMesh(p);
    if (!mesh) continue;
    mesh.userData.partIdx = i; // редактор находит деталь по индексу
    const s = p.servo | 0;
    if (s >= 0 && s < S && servos[s] && servos[s].arm) {
      const b = servoBase[s];
      // локальные координаты внутри качалки: она повёрнута на th вокруг Y,
      // поэтому смещение (p − base) переводим в систему качалки (R(−th))
      const th = servos[s].arm.rotation.y || 0;
      const dx = p.x - b.x, dz = p.z - b.z;
      mesh.position.set(
        dx * Math.cos(th) - dz * Math.sin(th),
        p.y - baseY - hEff / 2,
        dx * Math.sin(th) + dz * Math.cos(th),
      );
      servos[s].arm.add(mesh);
    } else {
      mesh.position.set(p.x, p.y - baseY, p.z);
      g.add(mesh);
    }
  }
}

// Меш детали: box (sx/sz/h) или cyl (r/hgt); цвет и опциональная текстура.
// Текстура box — атлас 3×2 (по ячейке на грань): UV граней BoxGeometry
// совпадают, без атласа мазок кисти «протекал» на все грани сразу.
function partMesh(p) {
  const color = new THREE.Color(p.color || '#9aa2b1');
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  let geo;
  if (p.shape === 'cyl') geo = new THREE.CylinderGeometry(p.r || 0.02, p.r || 0.02, p.hgt || 0.04, 20);
  else geo = new THREE.BoxGeometry(p.sx || 0.03, p.h || 0.03, p.sz || 0.03);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  const d = Math.PI / 180;
  m.rotation.set((p.rotX || 0) * d, (p.rotY || 0) * d, (p.rotZ || 0) * d);
  if (p.tex) {
    const img = new Image();
    img.onload = () => {
      const box = geo.type === 'BoxGeometry';
      // UV в ячейки атласа + белый цвет материала: иначе map умножается на
      // цвет детали и мазок кисти на тёмных деталях становится невидимым
      if (box) remapBoxAtlasUV(geo);
      mat.color.setHex(0xffffff);
      const c = document.createElement('canvas');
      c.width = box ? 768 : 256; c.height = box ? 512 : 256;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      mat.needsUpdate = true;
    };
    img.src = p.tex;
  }
  return m;
}

export class Robot {
  constructor(world, scene, mounts) {
    this.world = world;
    this.scene = scene;
    this.mounts = mounts || JSON.parse(JSON.stringify(DEFAULT_MOUNTS));

    // ── Материалы ──
    this.matChassis = new CANNON.Material('chassis');
    this.matSlick = new CANNON.Material('slick');

    // ── Корпус (составное тело: бокс + 2 кастора) ──
    const chassisBody = new CANNON.Body({
      mass: 0.9,
      material: this.matChassis,
      allowSleep: false,
    });
    chassisBody.addShape(new CANNON.Box(new CANNON.Vec3(CHASSIS.w / 2, CHASSIS.h / 2, CHASSIS.l / 2)));
    const casterR = 0.012;
    const casterShape = new CANNON.Sphere(casterR);
    casterShape.material = this.matSlick;
    chassisBody.addShape(casterShape, new CANNON.Vec3(0, -CHASSIS.h / 2 - 0.003, 0.09));
    chassisBody.addShape(casterShape, new CANNON.Vec3(0, -CHASSIS.h / 2 - 0.003, -0.09));
    chassisBody.position.set(0, CHASSIS_Y, 0);
    chassisBody.angularDamping = 0.4;
    chassisBody.linearDamping = 0.02;
    chassisBody.collisionFilterGroup = 2; // лучи сенсоров (mask=1) не ловят робота
    world.addBody(chassisBody);
    this.body = chassisBody;

    // ── Опрокидывание (Н3) ──
    // Кузов — динамическое тело, привод лишь навязывает ему скорость. Поэтому
    // кувырок делается без смены типа тела: при жёстком ударе о высокую статику
    // привод отключается, и cannon честно опрокидывает корпус.
    this.tumble = false;               // режим кувырка: моторы отключены до «Сброса»/вставания
    this._preVel = new CANNON.Vec3();  // скорость до шага физики: солвер гасит
                                       // нормальную составляющую, событие collide
                                       // приходит уже после решения — берём свою
    chassisBody.addEventListener('collide', (e) => this._onCollide(e));

    // ── Привод ──
    this.motorSpeed = [0, 0];  // текущая угловая скорость моторов (рад/с), [левое(+x), правое(−x)]
    this.motorTarget = [0, 0];
    this.wheelAngle = [0, 0];  // накопленный угол колёс (рад) — для энкодеров

    // ── Меши (общая фабрика визуала) ──
    const V = buildRobotVisuals();
    Object.assign(this, V);
    scene.add(this.group);

    // Редакторные флаги: frozen — физика спит (студия редактора),
    // studioPose — меши стоят в позе «на полу», а не по телу физики.
    this.frozen = false;
    this.studioPose = false;
    this._chassisKey = null;
    this.applyChassisWheels(true);
    this.syncMounts();
  }

  // Эффективная толщина корпуса (0 при disabled → «виртуальная палуба» 2 см,
  // на которую крепятся датчики, когда основной блок убран)
  chassisHEff() { const c = chassisCfg(this.mounts); return c.enabled ? c.h : 0.02; }
  chassisLEff() { const c = chassisCfg(this.mounts); return c.enabled ? c.l : 0.02; }
  chassisY() { return chassisYOf(this.mounts); }

  // Применить размеры корпуса и колёс: физическое тело (полуразмеры бокса,
  // вынос касторов, высота над полом) + меши (корпус, нос, колёса, моторы).
  // Ключ chassisKey меняется — пересобираем; вызывается билдером на лету.
  applyChassisWheels(force = false) {
    const c = chassisCfg(this.mounts);
    const w = wheelsCfg(this.mounts);
    const key = chassisKey(this.mounts);
    if (!force && key === this._chassisKey) return;
    this._chassisKey = key;

    const hEff = this.chassisHEff();
    const lEff = this.chassisLEff();
    const wEff = c.enabled ? c.w : 0.14;

    // ── Физика ──
    const box = this.body.shapes[0];
    box.halfExtents.set(wEff / 2, hEff / 2, lEff / 2);
    box.updateConvexPolyhedronRepresentation();
    box.updateBoundingSphereRadius();
    // Касторы: вынос от габарита корпуса (не дальше 9 см от центра)
    const cz = Math.max(0.02, Math.min(0.09, lEff / 2 - 0.03));
    this.body.shapeOffsets[1].z = cz;
    this.body.shapeOffsets[2].z = -cz;
    this.body.updateBoundingRadius();
    this.body.position.y = chassisYOf(this.mounts);

    // ── Меши ──
    this.chassisMesh.visible = c.enabled;
    if (c.enabled) {
      this.chassisMesh.geometry.dispose();
      this.chassisMesh.geometry = new THREE.BoxGeometry(c.w, c.h, c.l);
      this.chassisMesh.material.color.set(c.color || '#2e3440');
    }
    this.noseMesh.visible = c.enabled;
    if (c.enabled) {
      this.noseMesh.scale.x = c.w / CHASSIS.w;
      this.noseMesh.position.z = c.l / 2 + 0.005;
    }

    // Колёса: радиус/ширина/колея/вынос. Центр колеса локально
    // y = r − 0.015 − hEff/2 → низ колеса всегда в 2.5 мм над полом.
    const wy = w.r - 0.015 - hEff / 2;
    const wx = w.track / 2;
    this.wheelMeshes.forEach((wm, i) => {
      const x = i === 0 ? wx : -wx;
      wm.position.set(x, wy, w.z);
      const tire = wm.userData.tire, hub = wm.userData.hub;
      tire.geometry.dispose();
      tire.geometry = new THREE.CylinderGeometry(w.r, w.r, w.width, 24);
      hub.geometry.dispose();
      hub.geometry = new THREE.CylinderGeometry(w.r * 0.45, w.r * 0.45, w.width + 0.003, 12);
    });
    // Моторы: чуть внутрь от колеса
    this.motorMeshes.forEach((mm, i) => {
      const x = (i === 0 ? wx : -wx) - Math.sign(i === 0 ? wx : -wx) * (w.width / 2 + 0.013);
      mm.position.set(x, wy, w.z);
      mm.visible = c.enabled;
    });
  }

  // Пересчитать позиции датчиков-мешей из mounts (вызывается билдером на лету)
  syncMounts() {
    applyMounts(this.mounts, this);
    // доп. устройства: пересоздать меши, собрать список качалок серв (№1 — штатный)
    const extraArms = applyDeviceVisuals(this.mounts, this.group);
    this.servos = [
      { arm: this.servoHorn, baseYaw: (this.mounts.servo.yawDeg || 0) * Math.PI / 180 },
      ...extraArms.map((arm) => ({ arm, baseYaw: arm.userData.baseYaw || 0 })),
    ];
    // детали модели — после качалок (детали цепляются к ним)
    applyParts(this.mounts, this);
  }

  // Задать целевые скорости моторов, -255..255 (левое, правое).
  // Скорость колёс из редактора масштабирует максимум (wheels.speed).
  setMotorTargets(left, right) {
    const maxOmega = MAX_WHEEL_OMEGA * (wheelsCfg(this.mounts).speed || 1);
    this.motorTarget[0] = (left / 255) * maxOmega;
    this.motorTarget[1] = (right / 255) * maxOmega;
  }

  // Шаг физики
  prePhysics(dt) {
    // В студии редактора физика спит: тело замирает на месте.
    if (this.frozen) {
      this.body.velocity.set(0, 0, 0);
      this.body.angularVelocity.set(0, 0, 0);
      return;
    }
    // Кинематический дифференциальный привод: моторы задают скорость корпуса
    // вперёд и скорость рыскания. Вертикаль (гравитация, падения с уступов)
    // остаётся физике; тангаж/крен принудительно выравниваются — см. ниже.
    // Столкновения со стенами и ящиками обрабатывает cannon-es.
    if (this.tumble) {
      // Кувырок: привод отключён, корпус живёт честной динамикой, пока не
      // встанет на колёса и не успокоится. Встал на крышу — моторы бесполезны,
      // поможет только «Сброс» (resetTo снимает флаг).
      const q = this.body.quaternion;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z); // «Y» локальной вертикали в мире
      const w = this.body.angularVelocity;
      // Поддержка темпа (только сильные удары): трение о преграду гасит
      // вращение быстрее, чем корпус успевает перевернуться через кромку.
      // Держим темп, пока робот не перевалит через ~80°, дальше — честная
      // физика: корпус сам докатывается до спины и остаётся лежать.
      this._tumbleT = (this._tumbleT || 0) + dt;
      if (this._tumbleBoost) {
        if (upY < 0.2) this._tumbleBoost = false;
        else if (this._tumbleT < 0.35) {
          // затухающая поддержка: чем сильнее наклон, тем меньше подтягиваем —
          // иначе робот прилетает на спину на полной скорости и перекатывается
          // обратно на колёса, вместо того чтобы остаться лежать
          const target = this._tumbleW * Math.max(0.3, upY);
          const wxz = Math.hypot(w.x, w.z);
          if (wxz > 0.5 && wxz < target) {
            const k = target / wxz;
            w.x *= k; w.z *= k;
          }
        }
      }
      if (upY > 0.96 && Math.abs(w.x) + Math.abs(w.z) < 1.5 && Math.abs(this.body.velocity.y) < 0.3) {
        const fx0 = 2 * (q.x * q.z + q.y * q.w);
        const fz0 = 1 - 2 * (q.x * q.x + q.y * q.y);
        q.setFromAxisAngle(UP_VEC, Math.atan2(fx0, fz0));
        w.x = 0; w.z = 0;
        this.tumble = false;
        this._tumbleW = 0;
      }
      return;
    }
    const W = wheelsCfg(this.mounts);
    const r = W.r;
    const half = Math.max(0.02, W.track / 2); // половина колеи
    for (let i = 0; i < 2; i++) {
      // плавный разгон мотора
      const k = Math.min(1, dt / MOTOR_TAU);
      this.motorSpeed[i] += (this.motorTarget[i] - this.motorSpeed[i]) * k;
    }
    let v = (this.motorSpeed[0] + this.motorSpeed[1]) / 2 * r;                 // м/с вперёд
    let yawRate = (this.motorSpeed[1] - this.motorSpeed[0]) / 2 * r / half; // рад/с
    // Режим реализма: проскальзывание колёс. Сцепление — случайное блуждание,
    // при разворотах машину слегка сносит. Энкодеры считают фактический путь
    // корпуса, так что при пробуксовке тики «отстают» — как на настоящей трассе.
    const L = this.slipLevel | 0;
    if (L > 0) {
      this._grip = (this._grip === undefined ? 1 : this._grip) + (Math.random() - 0.5) * 0.05 * L;
      this._grip = Math.max(1 - 0.1 * L, Math.min(1, this._grip));
      v *= this._grip;
      yawRate *= 1 - 0.06 * L * Math.random();
    }
    // Корпус не кувыркается: привод кинематический, тангаж/крен гасим и
    // выравниваем кватернион до чистого рыскания. Без этого после жёсткого
    // контакта корпус может встать «на нос» (воспроизведено в лабиринте:
    // сонар смотрит в пол, скетч зацикливается). Гравитация по Y осталась —
    // с уступов робот по-прежнему падает, но плашмя, без переворотов.
    const q = this.body.quaternion;
    this.body.angularVelocity.x = 0;
    this.body.angularVelocity.z = 0;
    const fx0 = 2 * (q.x * q.z + q.y * q.w);
    const fz0 = 1 - 2 * (q.x * q.x + q.y * q.y);
    const yaw = Math.atan2(fx0, fz0);
    q.setFromAxisAngle(UP_VEC, yaw);
    this.body.velocity.x = Math.sin(yaw) * v;
    this.body.velocity.z = Math.cos(yaw) * v;
    this.body.angularVelocity.y = Math.max(-MAX_YAW_RATE, Math.min(MAX_YAW_RATE, yawRate));
    this._preVel.copy(this.body.velocity); // для детекта удара в _onCollide
  }

  // ── Опрокидывание: жёсткий удар корпусом о высокую неподвижную преграду
  // (большой блок, стена). Контакт выше центра масс + скорость по нормали
  // контакта выше порога → кувырок на спину от преграды. Медленные тычки и
  // скольжение вдоль стены не опрокидывают; рампы (наклонный контакт) тоже.
  _onCollide(e) {
    if (this.tumble || this.frozen) return;
    const c = e && e.contact;
    if (!c || !e.body || e.body.mass !== 0) return; // опрокидывает только статика
    // точка контакта в мире: должна быть не ниже центра корпуса
    const p = c.bi.position.vadd(c.ri);
    if (p.y - this.body.position.y <= 0) return;    // удар «below the belt» — переживём
    let nx = c.ni.x, ny = c.ni.y, nz = c.ni.z;
    if (c.bi === this.body) { nx = -nx; ny = -ny; nz = -nz; } // нормаль — от преграды к роботу
    if (Math.abs(ny) > 0.5) return;                 // пол/рампа — не в счёт
    const v = this._preVel;
    const impact = Math.abs(v.x * nx + v.y * ny + v.z * nz);
    if (impact < TIP_MIN_SPEED) return;
    this._startTumble(impact);
  }

  _startTumble(impact) {
    this.tumble = true;
    this.motorSpeed = [0, 0];
    this.motorTarget = [0, 0];
    const pv = this._preVel;
    const vh = Math.hypot(pv.x, pv.z);
    if (vh > 0.05) {
      // Ось кувырка = v̂ × up: реакция преграды приложена выше центра масс и
      // толкает корпус ОТ неё, поэтому верх робота уходит против хода движения
      // (на спину), а не в блок — иначе солвер гасит вращение самим блоком.
      const w = Math.min(5 + impact * 18, 24);
      const ax = -pv.z / vh, az = pv.x / vh;
      // «Пинок»: отрываем брюхо от пола и сразу наклоняем корпус — на плоской
      // подошве трение всей опоры съедает вращение за 2-3 шага, кувырок не
      // успевает начаться. Наклон оставляет опору на дальней кромке, дальше
      // корпус честно падает под гравитацией.
      const kick = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(ax, 0, az), 0.3);
      kick.mult(this.body.quaternion, this.body.quaternion);
      this.body.position.y += 0.02;
      this.body.angularVelocity.set(ax * w, this.body.angularVelocity.y * 0.3, az * w);
      this.body.velocity.y = Math.max(this.body.velocity.y, Math.min(vh * 0.35, 0.5)); // подброс
      this.body.velocity.x *= 0.45;
      this.body.velocity.z *= 0.45;
      this._tumbleW = w;              // темп кувырка для поддержки в prePhysics
      this._tumbleT = 0;
      this._tumbleBoost = impact > 0.5; // сильный удар — гарантированный кувырок,
                                        // мягкий тычок — честное покачивание
    }
    this.body.wakeUp();
    if (this.onTumble) this.onTumble();
  }

  postPhysics(dt) {
    if (this.tumble) return; // колёса не крутятся — кувырок
    // Энкодеры: по фактическому пути корпуса (остановился у стены — тики стоят,
    // буксует — тики честные). path_L/R = dist ∓ yawRate·(колея/2)·dt.
    const half = Math.max(0.02, wheelsCfg(this.mounts).track / 2);
    const r = wheelsCfg(this.mounts).r;
    const q = this.body.quaternion;
    const fx = 2 * (q.x * q.z + q.y * q.w);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const fy = 2 * (q.y * q.z - q.x * q.w);
    const vel = this.body.velocity;
    const dist = (vel.x * fx + vel.y * fy + vel.z * fz) * dt; // пройдено вперёд, м
    const dYaw = this.body.angularVelocity.y * dt;            // рад рыскания за шаг
    this.wheelAngle[0] += (dist - dYaw * half) / r;
    this.wheelAngle[1] += (dist + dYaw * half) / r;
  }

  encoderTicks(i) {
    return Math.trunc(this.wheelAngle[i] / (2 * Math.PI) * TICKS_PER_REV);
  }

  // Мировая позиция замера датчика линии i. Наклон датчика (Н6) сдвигает
  // точку на полу вперёд/вбок: луч из высоты датчика проецируется до пола.
  lineSensorWorldPos(i) {
    return this.lineSensorWorldPosLike(this.mounts.line[i]);
  }

  // Поза сонора: позиция и направление луча (с наклоном и панорамированием)
  sonarPose() {
    const m = this.mounts.sonar;
    const pos = this._localToWorld(m.x, this.chassisHEff() / 2 + m.height, m.z);
    return { pos, dir: this._beamDir(m.pitchDeg, m.yawDeg) };
  }

  // Направление луча в мировых координатах: локально Ry(yaw)·Rx(pitch)·(0,0,1),
  // затем поворот корпуса
  _beamDir(pitchDeg, yawDeg) {
    const pitch = (pitchDeg || 0) * Math.PI / 180;
    const yaw = (yawDeg || 0) * Math.PI / 180;
    const q = new THREE.Quaternion(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      -Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw),
    ).applyQuaternion(q).normalize();
    return dir;
  }

  // Позы доп. устройств из mounts.devices (для SensorSuite)
  deviceLinePos(dev) {
    return this.lineSensorWorldPosLike(dev);
  }

  deviceSonarPose(dev) {
    const pos = this._localToWorld(dev.x, this.chassisHEff() / 2 + (dev.height ?? 0.045), dev.z);
    return { pos, dir: this._beamDir(dev.pitchDeg, dev.yawDeg) };
  }

  deviceBumperPos(dev) {
    const pos = this._localToWorld(dev.x || 0, dev.height ?? 0.012, dev.z);
    return { pos, dir: this._beamDir(dev.pitchDeg || 0, dev.yawDeg || 0) };
  }

  // Поза датчика цвета: позиция + направление луча («вниз» с учётом наклона:
  // pitchDeg=0 — строго вниз, наклон уводит точку замера по полу)
  deviceColorPos(dev) {
    const pos = this._localToWorld(dev.x || 0, this.chassisHEff() / 2 + (dev.height ?? 0.004), dev.z || 0);
    return { pos, down: this._beamDir(90 - (dev.pitchDeg || 0), dev.yawDeg || 0) };
  }

  // Поза датчика света: позиция + нормаль. По умолчанию смотрит ВВЕРХ
  // (мерит окружающий свет), pitchDeg наклоняет к горизонту, yawDeg — азимут.
  deviceLightPos(dev) {
    const pos = this._localToWorld(dev.x || 0, this.chassisHEff() / 2 + (dev.height ?? 0.004), dev.z || 0);
    return { pos, dir: this._beamDir(-90 + (dev.pitchDeg || 0), dev.yawDeg || 0) };
  }

  // Поза бампера: центр планки и направление «вперёд» (для лучей сенсора)
  bumperPos() {
    const m = this.mounts.bumper;
    const pos = this._localToWorld(m.x || 0, m.height ?? 0.012, m.z);
    return { pos, dir: this._beamDir(m.pitchDeg || 0, m.yawDeg || 0) };
  }

  // Общий расчёт для датчиков линии (штатных и доп.): позиция крепления +
  // проекция наклонного луча на пол
  lineSensorWorldPosLike(m) {
    const pos = this._localToWorld(m.x || 0, m.height ?? 0.004, m.z || 0);
    const dir = this._beamDir(90 - (m.pitchDeg || 0), m.yawDeg || 0);
    if (dir.y < -0.05) {
      const t = pos.y / -dir.y;
      if (t > 0 && t < 0.5) { pos.x += dir.x * t; pos.z += dir.z * t; }
    }
    return pos;
  }

  _localToWorld(x, y, z) {
    const q = new THREE.Quaternion(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);
    const v = new THREE.Vector3(x, y, z).applyQuaternion(q);
    return new THREE.Vector3(
      this.body.position.x + v.x,
      this.body.position.y + v.y,
      this.body.position.z + v.z,
    );
  }

  // Целевой угол серво (0..180) — реальный угол догоняет с ограниченной скоростью.
  // setServoTarget(idx, frac) — канал idx; setServoTarget(frac) — канал 0 (совместимость)
  setServoTarget(a, b) {
    const idx = b === undefined ? 0 : a;
    const frac = b === undefined ? a : b;
    this._servoTargets = this._servoTargets || [];
    this._servoTargets[idx] = Math.min(1, Math.max(0, frac));
  }

  updateServo(dt) {
    this._servoTargets = this._servoTargets || [];
    this._servoFracs = this._servoFracs || [];
    const servos = this.servos || [{ arm: this.servoHorn, baseYaw: 0 }];
    servos.forEach((f, i) => {
      if (!f || !f.arm) return;
      const target = this._servoTargets[i] ?? 0;
      const cur = this._servoFracs[i] ?? target;
      const rate = dt / 0.3; // 0..1 за 0.3 с (~600°/с)
      const next = cur + Math.max(-rate, Math.min(rate, target - cur));
      this._servoFracs[i] = next;
      f.arm.rotation.y = next * Math.PI - Math.PI / 2 + (f.baseYaw || 0);
    });
  }

  syncMeshes() {
    // Студия редактора: робот стоит на «полу» студии без физики
    if (this.studioPose) {
      this.group.position.set(0, this.chassisY(), 0);
      this.group.quaternion.identity();
    } else {
      this.group.position.set(this.body.position.x, this.body.position.y, this.body.position.z);
      this.group.quaternion.set(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);
    }
    // Колёса: вращение вокруг своей оси по накопленному углу
    for (let i = 0; i < 2; i++) {
      this.wheelMeshes[i].rotation.x = this.wheelAngle[i];
    }
    void this.chassisMesh;
  }

  resetTo(x, z, yawDeg) {
    const yaw = yawDeg * Math.PI / 180;
    const q = new CANNON.Quaternion();
    q.setFromEuler(0, yaw, 0);
    this.body.position.set(x, this.chassisY(), z);
    this.body.quaternion.copy(q);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.force.set(0, 0, 0);
    this.body.torque.set(0, 0, 0);
    this.motorSpeed = [0, 0];
    this.motorTarget = [0, 0];
    this.wheelAngle = [0, 0];
    this.tumble = false; // «Сброс» ставит перевернувшегося робота на колёса
    this._tumbleW = 0;
    this._tumbleT = 0;
    this._tumbleBoost = false;
    this._preVel.set(0, 0, 0);
    this.body.wakeUp();
  }

  // Скорость вперёд (м/с) — для судейства/отладки
  forwardSpeed() {
    const q = new THREE.Quaternion(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return this.body.velocity.x * fwd.x + this.body.velocity.y * fwd.y + this.body.velocity.z * fwd.z;
  }
}
