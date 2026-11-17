# РобоАрена 3D — план реализации

> **For agentic workers:** План выполняется инлайн в текущей сессии (executing-plans).
> Шаги с чекбоксами. VCS в проекте нет по выбору пользователя — вместо коммитов каждый
> этап завершается проверкой результата (в конце можно инициализировать git по просьбе).

**Goal:** Веб-симулятор: 3D-арена с физикой, робот на Arduino-скетчах (интерпретатор подмножества C++), три режима, перестановка датчиков.

**Architecture:** Без бандлера: index.html + importmap на вендоренные ES-модули (three 0.170.0, cannon-es 0.20.0) + CodeMirror 5 UMD. Асинхронный tree-walking интерпретатор с бюджетом инструкций на кадр; физика — cannon-es с фиксированным шагом 1/120; датчики читают мир через лучи/текстуру в момент вызова API.

**Tech Stack:** Three.js, cannon-es, CodeMirror 5, чистый Node-сервер без зависимостей.

**Spec:** docs/superpowers/specs/2026-10-31-roboarena3d-design.md (читать вместе с планом).

## Global Constraints

- Вендоренные библиотеки локально: three 0.170.0 (`build/three.module.js`), cannon-es 0.20.0 (`dist/cannon-es.js`), codemirror 5.65.16 (lib + mode/clike).
- Никакого npm/бандлера; ES-модули через importmap; server.js — чистый node:http, порт 8123.
- Весь UI на русском; все сообщения об ошибках скетча — с номером строки.
- Пины (фиксированы): L-мотор PWM 5, dir 7/8; R-мотор PWM 6, dir 4/12; энкодеры 2/3; серво 9/10; HC-SR04 trig 11, echo 12; бампер 13; линия A0/A1/A2.
- localStorage-ключи: `roboarena3d.sketch`, `roboarena3d.mounts`, `roboarena3d.arena`, `roboarena3d.speed`.
- Физика: шаг 1/120 с, корпус 180×75×240 мм, 0.9 кг, колёса Ø66 мм, максимум ~30 рад/с.
- Сонор: конус ±10°, 2–400 см, мкс = см*58. Линия: чёрный ≈ 100–200, белый ≈ 950–1023.

---

### Task 1: Скелет и запуск

**Files:** Create `index.html`, `server.js`, `start.bat`, `vendor/*` (скачать), пустые `src/main.js`.
**Interfaces (Produces):** Каркас страницы: панель сверху, редактор слева, вьюпорт справа, сериал снизу; `window.__APP` заглушка.
**Verify:** `node server.js` стартует; в браузере http://localhost:8123 открывается без ошибок консоли; three и cannon импортируются (версия в логе).

- [ ] Скачать вендор: three 0.170.0 three.module.js; cannon-es 0.20.0 dist/cannon-es.js; codemirror 5.65.16 lib/codemirror.min.js, lib/codemirror.min.css, mode/clike/clike.min.js (curl, проверить размер >0 и отсутствие HTML-заглушки)
- [ ] server.js: node:http, статика с MIME (.js→text/javascript, .css, .html, .ino→text/plain), 404, лог URL
- [ ] start.bat: `start "" http://localhost:8123` + `node server.js`
- [ ] index.html: layout (grid), importmap, стили тёмной темы, панели-контейнеры
- [ ] Проверка: сервер + браузер, консоль чистая

### Task 2: Интерпретатор подмножества C++

**Files:** Create `src/arduino/lexer.js`, `src/arduino/parser.js`, `src/arduino/interpreter.js`.
**Interfaces (Produces):**
- `tokenize(src) → {tokens, errors}`; token: `{type, value, line, col}`
- `parse(tokens) → {program}` бросает `ParseError{line,col,message}`; AST: Program/FuncDecl/VarDecl/If/While/For/DoWhile/Switch/Return/Break/Continue/Block/ExprStmt/Expr-узлы (Assign, Ternary, Binary, Unary, Postfix(call/member/index/incdec), Ident, Literal, ArrayLit, Cast)
- `class SketchRuntime { constructor(program, api); start(); stop(); running }` — запускает setup() затем loop() бесконечно; `api` — объект с async-функциями железа; print → `api.serialPrint(text, newline)`
**Verify (node, до браузера):** смоук-скетч в node-repl: функции, рекурсия (факториал), массивы, for/switch/String-конкатенация, delay с фейковыми часами, Servo-объект, глобальное состояние между loop-вызовами, ошибка синтаксиса с номером строки, бесконечный while не зависает (бюджет).

- [ ] lexer.js: идентификаторы, числа (dec/hex/суффиксы L/UL/f), char/string, операторы, комментарии, #define/#include
- [ ] parser.js: объявления с типами (массивы, 2D, инициализаторы), инструкции, выражения по приоритетам, приведения (int)/(float)/(long), запрет указателей/структур/ссылок с понятной ошибкой
- [ ] interpreter.js: скоупы, типизация при присваивании (int 16 бит, long 32, truncate), Break/Continue/Return через исключения, бюджет инструкций + await api.yieldIfNeeded(), delay через api.delayMs, String как встроенный объект, встроенные функции Arduino (abs/min/max/constrain/map/pow/sqrt/sin/cos/tan/atan2/floor/ceil/round/random/randomSeed), Servo-класс, Serial
- [ ] Смоук в node-repl: перечисленные кейсы — все зелёные

### Task 3: Мир, физика, робот

**Files:** Create `src/world/scene.js`, `src/world/arenas.js` (пока песочница), `src/robot/robot.js`, `src/robot/sensors.js`.
**Interfaces (Produces):**
- `class SimWorld { constructor(container); loadArena(type); physicsStep(dt); render(); robot; arena }`
- `class Robot { constructor(world, mounts); body, wheelBodies; setMotorTargets(lDuty, rDuty); // -255..255
  wheelAngle{L,R}; lineSensorWorldPos(i)→Vec3; sonarPose()→{pos,dir}; bumperPos()→Vec3; syncMeshes(); resetTo(pose) }`
- `class SensorSuite { constructor(robot, world); readLine(i)→0..1023; readSonarCm()→cm|0; bumperPressed()→bool; servo[i]: {attach(pin), write(deg), read()} — углы живут в API, геометрия тут }`
- Arena API: `{resetTo()→pose, ground: {canvas, ctx, sizeW, sizeH, pxPerM}, update(dt, robot)→events[], judge: {state, reset(), text()}}`
**Verify:** песочница; из консоли `__APP.debug.drive(255,255)` — робот едет вперёд ~1 м/с; `drive(255,-255)` — крутится на месте; ящик толкается; рампа — заезжает; колёса крутятся (визуально), следящее обновление мешей.

- [ ] scene.js: рендерер (тени, sRGB), свет, орбит-камера (свой мини-орбит: drag/zoom), resize, цикл рендера
- [ ] robot.js: cannon-тела (chassis box, 2 wheel cylinder hinge-motor, 2 casters), материалы/трение, инерция моторов (tau ~0.08 с), меши (корпус, колёса, датчики-коробочки, флажок на серво)
- [ ] sensors.js: line — сэмпл canvas-текстуры поля по worldPos; sonar — 5 лучей cannon Ray ±10°, ближайший в 2–400 см; bumper — 5 лучей вперёд на высоте бампера, pressed если <12 мм; энкодеры — приращение угла → тики (360/об) с потолком 600 тиков/шаг
- [ ] arenas.js (v1): общее поле 4×4 с бортами, рампа, 3 ящика; таймер судейства-заглушка
- [ ] main.js: цикл — 2 подшага физики по 1/120, интерполяция не нужна; `__APP.debug.drive(l,r)`
- [ ] Проверка: перечисленные манёвры в браузере

### Task 4: Arduino API и мост к железу

**Files:** Create `src/arduino/arduinoApi.js`; Modify `src/main.js` (подключение).
**Interfaces (Consumes):** SketchRuntime, Robot, SensorSuite, SimWorld.
**Interfaces (Produces):** `class HardwareApi { constructor(sim); pinMode/digitalWrite/digitalRead/analogRead/analogWrite/delayMs/delayMicros/millis/micros/pulseIn/attachInterrupt/detachInterrupt/serialPrint; reset(); yieldIfNeeded() }` — маппинг пинов §Global Constraints, состояние пинов, эхо-часы сонора, тики энкодеров → обработчики, Serial-буфер → UI.
**Verify:** пример-скетч «мигание светодиодом бампера + езда по таймерам» выполняется; Serial печатает; millis растёт с множителем скорости; pulseIn отвечает дальности.

- [ ] arduinoApi.js: таблица устройств по пинам; dir-пины+PWM → robot.setMotorTargets; servo attach/write; pulseIn по последнему trig-импульсу (см*58); attachInterrupt для пинов 2/3/13
- [ ] main.js: связка Старт/Стоп/Сброс с runtime; множитель скорости → часы симуляции
- [ ] Проверка в браузере: скетч едет, Serial живой

### Task 5: Арены и судейство

**Files:** Modify `src/world/arenas.js` (полные три режима).
**Interfaces:** Arena API из Task 3. Судейство: `{state:{time, cpsPassed, offs, finished, result}, events[], text()}`
**Verify:** Трасса: пример LineFollower проходит, чекпоинты по порядку, сход считается, баннер результата. Лабиринт: MazeRunner доезжает до выхода, финиш по времени. Песочница — как в Task 3.

- [ ] Поле-текстура: canvas 2048×1536, белое, линия rgb(40,40,40) ширина 30 мм по кривой из опорных точек, старт-площадка, финиш, чекпоинты-маркеры; физ-пол с бортами
- [ ] Логика трассы: чекпоинты по порядку (радиус 80 мм), сход: центр дальше 60 мм от оси пути (дистанция до полилинии), дебаунс 1 с; финиш-зона после всех чекпоинтов
- [ ] Лабиринт: сетка 5×5 ячейка 800 мм, стены-боксы 150 мм по карте (массив строк), старт-угол, выход-клетка (зелёная), финиш по вхождению
- [ ] Песочница: рампа 10°, платформа, ящики
- [ ] Примеры скетчей: `src/ui/examples.js` — LineFollower.ino (P-регулятор по A0/A1/A2), MazeRunner.ino (правая рука по сонору + энкодеры + бампер), SandboxDemo.ino (таймеры + Servo флажок)
- [ ] Проверка: три режима по критериям

### Task 6: UI — редактор, сериал, судейство, сборка, справка

**Files:** Create `src/ui/editor.js`, `src/ui/panel.js`, `src/ui/builder.js`; Modify `index.html`, `src/main.js`.
**Interfaces:** `editor{getValue,setValue,onchange,status(msg,isErr)}`, `panel{serial(text), judge(text), banner(text|null), events(text)}`, `builder{open(),close(),getConfig(),onChange}`.
**Verify:** редактор с подсветкой и автосохранением; импорт/экспорт .ino; Serial с очисткой; «Сборка»: перетаскивание датчика линии меняет analogRead; слайдеры дальномера меняют показания; сброс креплений; справка с пинами и ограничениями языка.

- [ ] editor.js: CodeMirror (clike), автосохранение debounced, статус ошибок, кнопки импорт/экспорт
- [ ] panel.js: сериал-монитор (очистка, автоскролл, лимит 500 строк), панель судейства, баннер результата, меню примеров, оверлей справки (пины, язык, советы)
- [ ] builder.js: canvas вид сверху робота, drag маркеров (line×3, sonar, servo), слайдеры (высота/наклон сонора), лимиты ±90/±120 мм, localStorage, «Сбросить крепления», live-применение
- [ ] Проверка: все пункты вручную в браузере

### Task 7: Приёмка и полировка

**Files:** правки по итогам.
**Verify:** чек-лист §12 спеки целиком, ошибки в консоли отсутствуют, оффлайн-запуск (отключить сеть не требуется — всё локальное).

- [ ] Прогнать все 8 пунктов приёмки, зафиксировать результат
- [ ] Починить найденное
- [ ] Финальные скриншоты, отчёт пользователю с путями и честными оговорками
