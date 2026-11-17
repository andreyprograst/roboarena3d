// Оверлей «Справка»: раскладка пинов, поддерживаемое подмножество C++,
// семантика датчиков, кнопка полного сброса. Разметка в index.html.
//
// Отступление от таблицы пинов спеки: echo HC-SR04 живёт на A3, а не на D12 —
// D12 занят направлением правого мотора (L298-пара B).
import { hideAnimated } from './anim.js';

const HELP_HTML = `
<table>
  <tr><th>Пин</th><th>Назначение</th><th>Чтение/запись</th></tr>
  <tr><td><code>D2</code>, <code>D3</code></td><td>Энкодеры левого/правого колеса (прерывания, CHANGE)</td><td>attachInterrupt</td></tr>
  <tr><td><code>D4</code>, <code>D12</code></td><td>Направление правого мотора (пара B): D4 HIGH/D12 LOW — вперёд</td><td>digitalWrite</td></tr>
  <tr><td><code>D5</code>, <code>D6</code></td><td>ШИМ левого/правого мотора (0..255)</td><td>analogWrite</td></tr>
  <tr><td><code>D7</code>, <code>D8</code></td><td>Направление левого мотора (пара A)</td><td>digitalWrite</td></tr>
  <tr><td><code>D9</code>, <code>D10</code></td><td>Серво (0..180°): D9 — канал 1, D10 — канал 2 (доп. сервопривод из редактора робота)</td><td>Servo.write</td></tr>
  <tr><td><code>D11</code></td><td>HC-SR04 trig</td><td>digitalWrite</td></tr>
  <tr><td><code>D13</code></td><td>Бампер (digitalRead: 1 — нажат)</td><td>digitalRead</td></tr>
  <tr><td><code>A0</code>, <code>A1</code>, <code>A2</code></td><td>ИК-датчики линии: левый, центр, правый (0..1023, больше = светлее)</td><td>analogRead</td></tr>
  <tr><td><code>A3</code></td><td>HC-SR04 echo (в таблице из задания был D12 — он занят мотором)</td><td>через pulseIn</td></tr>
  <tr><td><code>A4</code></td><td>Датчик цвета TCS34725 (штатный): <code>colorReadR/G/B()</code> — канал 0..1023</td><td>colorReadR/G/B</td></tr>
  <tr><td><code>A5</code></td><td>Доп. датчик из редактора робота: цвета, гироскоп или <b>света</b> (пин выбирается в сборке)</td><td>analogRead</td></tr>
</table>

<h4 style="margin:14px 0 4px">Семантика датчиков</h4>
<ul>
  <li><b>Линия</b>: 0..1023, белое поле ≈ 983, чёрная линия ≈ 100. Датчик смотрит в пол под собой.</li>
  <li><b>HC-SR04</b>: <code>pulseIn(ECHO, HIGH)</code> возвращает мкс (как настоящая плата);
      расстояние в см = мкс / 58. Диапазон 2..400 см, 0 — эха нет. Конус ±10°.</li>
  <li><b>Энкодеры</b>: 360 тиков на оборот колеса. Клетка 80 см ≈ 1390 тиков, поворот 90° на месте ≈ 281 тик.</li>
  <li><b>Бампер</b>: 1, когда планка коснулась препятствия.</li>
  <li><b>Серво</b>: <code>flag.write(угол)</code> — движение с ограниченной скоростью, как настоящая серва.</li>
  <li><b>Цвет</b>: <code>colorReadR()</code>/<code>colorReadG()</code>/<code>colorReadB()</code> — каналы 0..1023.
      Чем дальше датчик от поверхности (выше ~17 см), тем слабее сигнал; 0 — ничего не видно.</li>
  <li><b>Свет</b>: <code>lightRead()</code> (первый датчик) или <code>analogRead(пин)</code> — освещённость 0..1023.
      Реагирует на общее освещение сцены и на лампы из редактора арены («💡 Свет»); учитывает наклон датчика
      и затухание света с расстоянием. В темноте ≈ 0, под яркой лампой ≈ 1023.</li>
  <li><b>Время</b>: <code>millis()</code>/<code>delay()</code> идут по времени <i>симуляции</i> —
      при ускорении ×4 скетч живёт в 4 раза быстрее реального времени.</li>
</ul>

<h4 style="margin:14px 0 4px">Поддерживаемое подмножество C++</h4>
<ul>
  <li>Типы: <code>int, long, short, char, byte, bool, unsigned-варианты, float, double, void</code>,
      псевдонимы <code>uint8_t</code>/<code>int32_t</code> и т.п.</li>
  <li><code>#define</code> (объектные), <code>const</code>, глобальные и локальные переменные,
      массивы (включая 2D), инициализаторы <code>{...}</code>.</li>
  <li>Операторы C с полным приоритетом, <code>+=</code> и т.п., <code>++/--</code>, тернарный.</li>
  <li>Функции (в т.ч. рекурсия до 64 уровней), <code>while/do/for</code>, <code>switch</code>,
      <code>break/continue/return</code>.</li>
  <li>Математика: <code>abs, min, max, constrain, map, sqrt, sin, cos, tan, atan2, pow, floor, ceil, round</code>.</li>
  <li>Классы, указатели, ссылки, шаблоны, <code>struct</code>, <code>String</code> — <b>не поддерживаются</b>
      (компилятор объяснит, что именно).</li>
</ul>

<h4 style="margin:14px 0 4px">Советы</h4>
<ul>
  <li>Повороты удобно калибровать по энкодерам (см. пример «Лабиринт»).</li>
  <li>«Сборка» двигает датчики по корпусу — центр линии можно подстроить под трассу.</li>
  <li>Скетч сохраняется автоматически; «Открыть .ino» / «Сохранить .ino» — работа с файлом.</li>
</ul>
`;

export function installHelp() {
  const overlay = document.getElementById('help-overlay');
  const content = document.getElementById('help-content');
  content.innerHTML = HELP_HTML;

  for (const btn of overlay.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => hideAnimated(overlay));
  }

  // полный сброс: все localStorage-ключи приложения
  const resetBtn = document.createElement('button');
  resetBtn.textContent = '⟲ Сбросить всё (скетч, крепления, арену, скорость)';
  resetBtn.className = 'warn';
  resetBtn.addEventListener('click', () => {
    try {
      localStorage.removeItem('roboarena3d.sketch');
      localStorage.removeItem('roboarena3d.mounts');
      localStorage.removeItem('roboarena3d.arena');
      localStorage.removeItem('roboarena3d.speed');
    } catch { /* пусто */ }
    location.reload();
  });
  content.after(resetBtn);

  return {
    open: () => overlay.classList.add('open'),
    close: () => hideAnimated(overlay),
  };
}
