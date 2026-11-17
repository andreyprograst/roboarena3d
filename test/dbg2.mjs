import { tokenize } from '../src/arduino/lexer.js';
import { parse } from '../src/arduino/parser.js';
const src = `void setup() { Serial.println(1); }
void loop() {}`;
const { tokens } = tokenize(src);
// трассировка: обернём parse в try и напечатаем ход
try {
  const ast = parse(tokens);
  console.log('AST OK', ast.body.length);
} catch (e) {
  console.log('FAIL:', e.message, e.line + ':' + e.col, 'stack:', e.stack.split('\n')[1]);
}
// мануально: сколько токенов, где eof
console.log('tokens:', tokens.length, 'last:', tokens[tokens.length-1]);
