// Смоук-тесты интерпретатора (запуск: ELECTRON_RUN_AS_NODE=1 Qoder.exe test/interpreter.test.mjs)
import { tokenize } from '../src/arduino/lexer.js';
import { parse, ParseError } from '../src/arduino/parser.js';
import { SketchRuntime, StopError } from '../src/arduino/interpreter.js';

let passed = 0;
let failed = 0;

function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

class MockApi {
  constructor(opts = {}) {
    this.clock = 0; this.prints = []; this.yields = 0; this.servos = new Map();
    this.ints = []; this.pinStates = new Map();
    this.yieldBudget = opts.yieldBudget ?? 50000; // мок сам останавливает рантайм
    this.limitYields = opts.limitYields ?? 0;      // 0 = не бросать, а останавливать
    this.stopHook = null;
  }
  async yieldFrame() {
    this.yields++;
    if (this.limitYields && this.yields > this.limitYields) {
      throw new Error('ТЕСТ: превышен лимит yield — похоже на зависание');
    }
    if (!this.limitYields && this.yields > this.yieldBudget && this.stopHook) {
      this.stopHook(); // детерминированная остановка вместо бесконечного цикла
    }
  }
  async delayMs(ms) { this.clock += ms; }
  async delayMicros(us) { this.clock += us / 1000; }
  async millis() { return this.clock; }
  async micros() { return this.clock * 1000; }
  serialPrint(text) { this.prints.push(text); }
  async pinMode(p, m) { this.pinStates.set(p, m); }
  async digitalWrite(p, v) { this.pinStates.set('d' + p, v); }
  async digitalRead() { return 0; }
  async analogRead(p) { return this.pinStates.get('a' + p) ?? 512; }
  async analogWrite(p, v) { this.pinStates.set('pwm' + p, v); }
  async pulseIn() { return 580; }
  async attachInterrupt(p, fn, m) { this.ints.push({ p, fn, m }); }
  async detachInterrupt() {}
  async servoAttach(id, pin) { this.servos.set(id, { pin, angle: 0 }); }
  async servoWrite(id, a) { const s = this.servos.get(id); if (s) s.angle = a; }
  async servoDetach() {}
}

async function runSketch(src, opts = {}) {
  const lex = tokenize(src);
  if (lex.errors.length) throw new Error('лексер: ' + lex.errors[0].message);
  const ast = parse(lex.tokens);
  const api = new MockApi(opts);
  const errors = [];
  const rt = new SketchRuntime(ast, api, { onError: (m) => errors.push(m) });
  api.stopHook = () => rt.stop(); // детерминированная остановка по бюджету yield
  await rt.start();
  if (errors.length) throw new Error('ошибка скетча: ' + errors[0]);
  return { api, rt };
}

console.log('── Интерпретатор: смоук-тесты ──');

// 1. Рекурсия, функции, печать
{
  const { api } = await runSketch(`
    int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
    void setup() { Serial.println(fact(6)); }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === '720\n', 'рекурсия fact(6)=720', api.prints.join(''));
}

// 2. Переполнение int 16 бит
{
  const { api } = await runSketch(`
    int x = 32767;
    void setup() { x = x + 1; Serial.println(x); }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === '-32768\n', 'int переполняется до -32768', api.prints.join(''));
}

// 3. Целочисленное и вещественное деление
{
  const { api } = await runSketch(`
    void setup() {
      Serial.println(7 / 2);
      Serial.println(7.0 / 2);
      float f = 7; Serial.println(f / 2);
    }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === '3\n3.5\n3.5\n', 'деление int/int=3, float=3.5', JSON.stringify(api.prints));
}

// 4. Массивы, 2D, сумма
{
  const { api } = await runSketch(`
    int a[5] = {1, 2, 3, 4, 5};
    int m[2][2] = {{1, 2}, {3, 4}};
    void setup() {
      int s = 0;
      for (int i = 0; i < 5; i++) s += a[i];
      Serial.println(s);
      Serial.println(m[1][0]);
      a[2] = 10; Serial.println(a[2]);
    }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === '15\n3\n10\n', 'массивы 1D/2D и запись', api.prints.join(''));
}

// 5. static-переменная между вызовами loop
{
  const { api } = await runSketch(`
    void setup() {}
    void loop() {
      static int counter = 0;
      counter++;
      if (counter == 3) Serial.println(counter);
      delay(1);
    }
  `);
  ok(api.prints.join('') === '3\n', 'static в loop() сохраняется', api.prints.join(''));
}

// 6. String: конкатенация и методы
{
  const { api } = await runSketch(`
    void setup() {
      String s = "val: ";
      s += 42;
      Serial.println(s);
      Serial.println(s.length());
      Serial.println(s.substring(5));
      Serial.println(s.substring(5).toInt() + 8);
    }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === 'val: 42\n7\n42\n50\n', 'String: +, length, substring, toInt', JSON.stringify(api.prints));}

// 7. switch с fallthrough
{
  const { api } = await runSketch(`
    void setup() {
      for (int k = 1; k <= 3; k++) {
        switch (k) {
          case 1: Serial.println("один");
          case 2: Serial.println("два"); break;
          default: Serial.println("много");
        }
      }
    }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === 'один\nдва\nдва\nмного\n', 'switch fallthrough+break', api.prints.join(''));
}

// 8. millis после delay
{
  const { api } = await runSketch(`
    void setup() {
      delay(250);
      Serial.println(millis());
      delayMicroseconds(1500);
      Serial.println(micros());
    }
    void loop() { delay(100); }
  `);
  ok(api.prints[0] === '250\n' && api.prints[1] === '251500\n', 'delay/millis/micros', JSON.stringify(api.prints));
}

// 9. Servo
{
  const { api } = await runSketch(`
    #include <Servo.h>
    Servo flag;
    void setup() {
      flag.attach(9);
      flag.write(135);
      Serial.println(flag.read());
    }
    void loop() { delay(100); }
  `);
  const servos = [...api.servos.values()];
  ok(servos.length === 1 && servos[0].pin === 9 && servos[0].angle === 135 && api.prints.join('') === '135\n',
    'Servo attach/write/read', JSON.stringify({ servos, prints: api.prints }));
}

// 10. #define и hex
{
  const { api } = await runSketch(`
    #define ENA 5
    #define STEPS 0x0F
    void setup() {
      pinMode(ENA, OUTPUT);
      analogWrite(ENA, STEPS * 16);
    }
    void loop() { delay(100); }
  `);
  ok(api.pinStates.get('pwm5') === 240, '#define + hex', String(api.pinStates.get('pwm5')));
}

// 11. Ошибка парсинга с номером строки
{
  try {
    await runSketch('void setup() {\n  int x = ;\n}');
    ok(false, 'ошибка парсинга должна кидать ParseError');
  } catch (e) {
    ok(e instanceof ParseError && e.line === 2, 'ParseError с номером строки', e.message);
  }
}

// 12. Указатели — понятная ошибка
{
  try {
    await runSketch('void setup() { int *p; }');
    ok(false, 'указатель должен дать ошибку');
  } catch (e) {
    ok(/указатели/.test(e.message), 'дружелюбная ошибка про указатели', e.message);
  }
}

// 13. Выход за границы массива
{
  try {
    await runSketch('void setup() { int a[3]; a[5] = 1; }');
    ok(false, 'выход за границы должен дать ошибку');
  } catch (e) {
    ok(/вне границ/.test(e.message), 'ошибка выхода за границы', e.message);
  }
}

// 14. Прерывания: регистрация и вызов обработчика
{
  const lex = tokenize(`
    volatile int ticks = 0;
    void onTick() { ticks++; }
    void setup() {
      attachInterrupt(2, onTick, CHANGE);
      Serial.println(ticks);
    }
    void loop() { delay(10); }
  `);
  const ast = parse(lex.tokens);
  const api = new MockApi({ yieldBudget: 3000 });
  const errors = [];
  const rt = new SketchRuntime(ast, api, { onError: (m) => errors.push(m) });
  api.stopHook = () => rt.stop();
  const started = rt.start();
  await started.catch(() => {});
  ok(api.ints.length === 1 && api.ints[0].p === 2 && api.ints[0].fn.__fn === 'onTick' && errors.length === 0,
    'attachInterrupt зарегистрирован', JSON.stringify({ ints: api.ints, errors }));
  // Обработчик вызывается корректно
  await rt.callFunction(rt.funcs.get('onTick'), []);
  await rt.callFunction(rt.funcs.get('onTick'), []);
  ok(errors.length === 0, 'обработчик вызывается без ошибок', errors.join('; '));
}

// 15. Бесконечный цикл не зависает (бюджет yield)
{
  try {
    await runSketch(`
      int x = 0;
      void setup() { while (true) { x++; } }
      void loop() { delay(100); }
    `, { limitYields: 50 });
    ok(false, 'бесконечный while должен упереться в лимит теста');
  } catch (e) {
    ok(/лимит yield/.test(e.message), 'бесконечный цикл упирается в бюджет, а не висит', e.message);
  }
}

// 16. do-while, break/continue, тернарник, унарные
{
  const { api } = await runSketch(`
    void setup() {
      int i = 0, s = 0;
      do { i++; if (i == 2) continue; if (i > 4) break; s += i; } while (i < 100);
      Serial.println(s);
      int t = (s > 5) ? 100 : 200;
      Serial.println(t);
      int u = 10; u--; --u; u %= 3;
      Serial.println(u);
    }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === '8\n100\n2\n', 'do-while/continue/break, тернарник, -- и %=', api.prints.join(''));
}

// 17. Печать float с 2 знаками
{
  const { api } = await runSketch(`
    void setup() {
      Serial.println(3.14159);
      Serial.print(1.5, 4); Serial.println("");
    }
    void loop() { delay(100); }
  `);
  ok(api.prints[0] === '3.14\n' && api.prints[1] === '1.5000' && api.prints[2] === '\n', 'формат float', JSON.stringify(api.prints));
}

// 18. Функция с массивом-параметром
{
  const { api } = await runSketch(`
    int sumOf(int arr[], int n) {
      int s = 0;
      for (int i = 0; i < n; i++) s += arr[i];
      return s;
    }
    void setup() {
      int b[4] = {5, 10, 15, 20};
      Serial.println(sumOf(b, 4));
    }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === '50\n', 'массив как параметр функции', api.prints.join(''));
}

// 19. Побитовые и логика
{
  const { api } = await runSketch(`
    void setup() {
      int x = 0x0C & 0x0A;
      Serial.println(x);
      x = 1 << 4;
      Serial.println(x);
      Serial.println(5 > 3 && 2 > 1);
    }
    void loop() { delay(100); }
  `);
  ok(api.prints.join('') === '8\n16\n1\n', 'побитовые и логика', api.prints.join(''));
}

// 20. Ошибка деления на ноль
{
  try {
    await runSketch('void setup() { int z = 0; int q = 5 / z; }');
    ok(false, 'деление на ноль должно дать ошибку');
  } catch (e) {
    ok(/ноль/.test(e.message), 'ошибка деления на ноль', e.message);
  }
}

console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
process.exit(failed ? 1 : 0);
