// Быстрая проверка харнесса и базового прогона
import { tokenize } from '../src/arduino/lexer.js';
import { parse } from '../src/arduino/parser.js';
import { SketchRuntime } from '../src/arduino/interpreter.js';

class MockApi {
  constructor() { this.clock = 0; this.prints = []; this.yields = 0; }
  async yieldFrame() { this.yields++; }
  async delayMs(ms) { this.clock += ms; }
  async delayMicros(us) { this.clock += us / 1000; }
  async millis() { return this.clock; }
  async micros() { return this.clock * 1000; }
  serialPrint(t) { this.prints.push(t); }
  async pinMode() {} async digitalWrite() {} async digitalRead() { return 0; }
  async analogRead() { return 512; } async analogWrite() {} async pulseIn() { return 580; }
  async attachInterrupt() {} async detachInterrupt() {}
  async servoAttach() {} async servoWrite() {} async servoDetach() {}
}

const src = `int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
void setup() { Serial.println(fact(6)); }
void loop() { delay(100); }`;
const ast = parse(tokenize(src).tokens);
const api = new MockApi();
const errs = [];
const rt = new SketchRuntime(ast, api, { onError: (m) => errs.push(m) });
const started = rt.start();
await new Promise((r) => setTimeout(r, 50));
rt.stop();
await started;
console.log('prints:', JSON.stringify(api.prints), 'errors:', errs, 'loops≈', api.yields);
