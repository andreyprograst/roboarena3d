import { tokenize } from '../src/arduino/lexer.js';
import { parse } from '../src/arduino/parser.js';
import { SketchRuntime } from '../src/arduino/interpreter.js';

let yieldCount = 0;
const api = {
  clock: 0, prints: [],
  async yieldFrame() { yieldCount++; if (yieldCount > 50) throw new Error('ТЕСТ: превышен лимит yield'); },
  async delayMs() {}, async delayMicros() {}, async millis() { return 0; }, async micros() { return 0; },
  serialPrint() {}, async pinMode() {}, async digitalWrite() {}, async digitalRead() { return 0; },
  async analogRead() { return 512; }, async analogWrite() {}, async pulseIn() { return 0; },
  async attachInterrupt() {}, async detachInterrupt() {},
  async servoAttach() {}, async servoWrite() {}, async servoDetach() {},
};
const src = `
  int x = 0;
  void setup() { while (true) { x++; } }
  void loop() { delay(100); }`;
const ast = parse(tokenize(src).tokens);
const rt = new SketchRuntime(ast, api, { onError: (m) => console.log('onError:', m) });
await rt.start();
console.log('start() вернулся. yields:', yieldCount);
