import { tokenize } from '../src/arduino/lexer.js';
import { parse } from '../src/arduino/parser.js';
const src = `int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
void setup() { Serial.println(fact(6)); }
void loop() {}`;
const { tokens, errors } = tokenize(src);
console.log('lexer errors:', errors);
for (const t of tokens) console.log(t.type.padEnd(6), JSON.stringify(t.value), t.line + ':' + t.col);
try {
  const ast = parse(tokens);
  console.log('\nAST OK:', JSON.stringify(ast, null, 1).slice(0, 800));
} catch (e) {
  console.log('\nPARSE FAIL:', e.message, e.line + ':' + e.col);
}
