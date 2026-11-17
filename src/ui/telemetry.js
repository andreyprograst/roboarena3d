// Панель телеметрии (правый нижний угол вьюпорта, как судейство): два
// скроллящихся графика — движение (скорость м/с, поворот °/с) и датчики
// (линия ×3 0..1023, сонар 0..400 см, бампер 0/1). Сэмплы копятся в tick()
// с прореживанием до ~30 Гц, рисуются на канвасах с ×2 запасом чёткости.
// Каналы нормированы каждый к своей шкале: точные значения — в легенде.
// Показ панели — кнопка-глаз в тулбаре (settings.js, LS roboarena3d.telemetry);
// при скрытой панели сэмплирование и отрисовка отключаются.
import { t } from './i18n.js';

const N = 180;          // точек истории (~6 с при 30 Гц)
const SAMPLE_MS = 33;   // прореживание сэмплирования
const SONAR_MAX = 400;  // шкала сонара, см (HC-SR04)
const R2D = 180 / Math.PI;

// Цвета каналов — одни и те же в легенде и на графиках.
const C = {
  speed: '#ff8a2a', yaw: '#4da3ff',
  line: ['#ffd166', '#7bd88f', '#ff6b81'],
  sonar: '#b18cff', bump: '#ff4d4d',
};

function ring() { return new Array(N).fill(null); }

export function createTelemetry({ app }) {
  const box = document.getElementById('telemetry');
  const cvMove = document.getElementById('tele-move');
  const cvSens = document.getElementById('tele-sens');
  const ctxMove = cvMove.getContext('2d');
  const ctxSens = cvSens.getContext('2d');

  // ── Каналы ──
  const ch = {
    speed: ring(), yaw: ring(),
    line: [ring(), ring(), ring()],
    sonar: ring(), bump: ring(),
  };

  // ── Легенды (подписи через data-i18n — обновляются сменой языка) ──
  const items1 = [
    { key: 'tele.speed', color: C.speed, fmt: (v) => (v === null ? '—' : v.toFixed(2)) },
    { key: 'tele.yaw', color: C.yaw, fmt: (v) => (v === null ? '—' : v.toFixed(0)) },
  ];
  const items2 = [
    { key: 'tele.l0', color: C.line[0], fmt: (v) => (v === null ? '—' : String(Math.round(v))) },
    { key: 'tele.l1', color: C.line[1], fmt: (v) => (v === null ? '—' : String(Math.round(v))) },
    { key: 'tele.l2', color: C.line[2], fmt: (v) => (v === null ? '—' : String(Math.round(v))) },
    { key: 'tele.sonar', color: C.sonar, fmt: (v) => (v === null ? '—' : (v === 0 ? '∞' : v.toFixed(0))) },
    { key: 'tele.bump', color: C.bump, fmt: (v) => (v === null ? '—' : (v ? 'ДА' : 'нет')) },
  ];
  function legend(el, items) {
    el.innerHTML = '';
    for (const it of items) {
      const s = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = it.color;
      const lbl = document.createElement('span');
      lbl.dataset.i18n = it.key;
      lbl.textContent = t(it.key);
      const b = document.createElement('b');
      b.style.color = it.color;
      b.textContent = '—';
      it.b = b;
      s.append(i, lbl, b);
      el.appendChild(s);
    }
  }
  legend(document.getElementById('tele-lg1'), items1);
  legend(document.getElementById('tele-lg2'), items2);

  function visible() { return box.style.display !== 'none'; }

  // ── Сэмплирование: очередное значение каждого канала ──
  function sample() {
    const r = app.robot, s = app.sensors;
    if (!r || !r.body) return;
    const v = r.body.velocity;
    ch.speed.push(Math.hypot(v.x, v.z)); ch.speed.shift();
    ch.yaw.push(r.body.angularVelocity.y * R2D); ch.yaw.shift();
    for (let i = 0; i < 3; i++) {
      let line = null;
      try { line = s ? s.readLine(i) : null; } catch { /* нет датчика */ }
      ch.line[i].push(line === null || line === undefined ? null : line); ch.line[i].shift();
    }
    let sonar = null;
    try { sonar = s ? s.readSonarCm() : null; } catch { /* нет датчика */ }
    ch.sonar.push(sonar === null || sonar === undefined ? null : sonar); ch.sonar.shift();
    let bump = null;
    try { bump = s ? s.bumperPressed() : null; } catch { /* нет датчика */ }
    ch.bump.push(bump ? 1 : (bump === false ? 0 : null)); ch.bump.shift();
  }

  // Пик видимого окна канала (игнорируя пропуски) — для автомасштаба.
  function peak(arr, min) {
    let m = min;
    for (const v of arr) if (v !== null && v !== undefined && Math.abs(v) > m) m = Math.abs(v);
    return m * 1.15;
  }

  // Ломаная канала: null = пропуск (нет данных), ведётся непрерывной линией
  // по соседним точкам, пропуск просто не рисуется.
  function stroke(ctx, w, h, arr, scale, color, zeroMid) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < N; i++) {
      const v = arr[i];
      if (v === null || v === undefined) { started = false; continue; }
      const x = (i / (N - 1)) * w;
      const y = zeroMid
        ? h / 2 - (v / scale) * (h / 2 - 3)
        : h - 3 - (Math.max(0, v) / scale) * (h - 6);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function grid(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(127,127,127,.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const k of [0.25, 0.5, 0.75]) {
      ctx.moveTo(0, h * k); ctx.lineTo(w, h * k);
    }
    ctx.stroke();
  }

  function draw() {
    const w = 216, h = 56; // логический размер (бэкинг ×2, ctx.scale)
    // ── Движение: автомасштаб по видимому окну ──
    ctxMove.setTransform(2, 0, 0, 2, 0, 0);
    grid(ctxMove, w, h);
    stroke(ctxMove, w, h, ch.speed, peak(ch.speed, 0.4), C.speed, true);
    stroke(ctxMove, w, h, ch.yaw, peak(ch.yaw, 60), C.yaw, true);
    // ── Датчики: фиксированные шкалы (линия/сонар/бампер → 0..1) ──
    ctxSens.setTransform(2, 0, 0, 2, 0, 0);
    grid(ctxSens, w, h);
    for (let i = 0; i < 3; i++) stroke(ctxSens, w, h, ch.line[i], 1023, C.line[i], false);
    stroke(ctxSens, w, h, ch.sonar, SONAR_MAX, C.sonar, false);
    stroke(ctxSens, w, h, ch.bump, 1, C.bump, false);
  }

  // Легенда: по последнему НЕпустому значению канала (панель живёт и до старта)
  function lastVal(arr) {
    for (let i = N - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
    return null;
  }

  // Связка легенд с каналами: [канал, элемент значения, формат]
  const pairs1 = [[ch.speed, items1[0]], [ch.yaw, items1[1]]];
  const pairs2 = [
    [ch.line[0], items2[0]], [ch.line[1], items2[1]], [ch.line[2], items2[2]],
    [ch.sonar, items2[3]], [ch.bump, items2[4]],
  ];
  function updateLegend() {
    for (const [arr, it] of pairs1) it.b.textContent = it.fmt(lastVal(arr));
    for (const [arr, it] of pairs2) it.b.textContent = it.fmt(lastVal(arr));
  }

  // ── Такт из главного цикла: прореженное сэмплирование + отрисовка ──
  let acc = 0;
  function tick(dt) {
    if (!visible()) return;
    acc += dt * 1000;
    let sampled = false;
    while (acc >= SAMPLE_MS) { acc -= SAMPLE_MS; sample(); sampled = true; }
    if (sampled) updateLegend();
    draw();
  }

  return { tick };
}
