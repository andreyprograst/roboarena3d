// Лексер подмножества C++ для Arduino-скетчей.
// Возвращает { tokens, errors }. Токен: { type, value, line, col }.
// Поддерживает #define (объектные) с подстановкой, #include — пропускает.

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'true', 'false',
  'void', 'int', 'long', 'short', 'char', 'float', 'double', 'bool', 'byte',
  'signed', 'unsigned', 'const', 'static', 'volatile', 'word',
  // запрещённые — парсер выдаст понятную ошибку
  'struct', 'union', 'enum', 'class', 'typedef', 'new', 'delete', 'sizeof',
  'this', 'namespace', 'using', 'public', 'private', 'protected', 'template',
]);

// Статические объекты/классы Arduino — не ключевые слова, парсер знает их отдельно.
const OPERATORS = [
  '<<=', '>>=', '...', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=',
  '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~',
  '?', ':', ';', ',', '(', ')', '{', '}', '[', ']', '.',
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

export function tokenize(src) {
  const errors = [];
  const defines = new Map(); // имя -> { raw: строка значения }
  const warnedDirectives = new Set();
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const len = src.length;

  function err(message, l = line, c = col) {
    errors.push({ message, line: l, col: c });
  }

  function advance(n = 1) {
    for (let k = 0; k < n && i < len; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }

  function push(type, value, l, c) {
    tokens.push({ type, value, line: l, col: c });
  }

  // Подстановка #define с защитой от циклов.
  function emitIdent(name, l, c, depth) {
    const def = defines.get(name);
    if (!def) {
      push(KEYWORDS.has(name) ? 'kw' : 'ident', name, l, c);
      return;
    }
    if (depth > 10) { err(`циклический #define «${name}»`, l, c); return; }
    if (!def.tokens) {
      // Лениво токенизируем значение макроса.
      const sub = tokenizeSub(def.raw, l, c);
      def.tokens = sub.tokens;
      sub.errors.forEach((e) => errors.push(e));
    }
    for (const t of def.tokens) {
      if (t.type === 'ident') emitIdent(t.value, l, c, depth + 1);
      else push(t.type, t.value, l, c);
    }
  }

  // Токенизация строки-значения макроса (в контексте позиции использования).
  function tokenizeSub(text, baseLine, baseCol) {
    const sub = tokenize(text);
    sub.tokens.forEach((t) => { t.line = baseLine; t.col = baseCol; });
    return sub;
  }

  function readDirective() {
    // стоим на '#'
    const dLine = line, dCol = col;
    advance(); // #
    skipWhitespace();
    let name = '';
    while (i < len && IDENT_PART.test(src[i])) { name += src[i]; advance(); }
    if (name === 'include') {
      skipToEol();
      return;
    }
    if (name === 'define') {
      skipWhitespace();
      let dname = '';
      if (i < len && IDENT_START.test(src[i])) {
        while (i < len && IDENT_PART.test(src[i])) { dname += src[i]; advance(); }
      } else {
        err('ожидалось имя после #define', dLine, dCol);
        skipToEol();
        return;
      }
      // Функциоподобный макрос — не поддерживаем
      if (src[i] === '(') {
        err('макросы с параметрами (#define F(x) …) не поддерживаются', dLine, dCol);
        skipToEol();
        return;
      }
      // Значение — до конца строки (без комментариев-переносов)
      let raw = '';
      while (i < len && src[i] !== '\n') { raw += src[i]; advance(); }
      raw = raw.trim();
      if (raw.includes('\\')) {
        err('перенос строк в #define не поддерживается', dLine, dCol);
      }
      if (raw.length) defines.set(dname, { raw });
      return;
    }
    if (name === 'undef') { skipToEol(); return; }
    // Условная компиляция и прочее — предупреждаем один раз на директиву
    if (!warnedDirectives.has(name)) {
      warnedDirectives.add(name);
      err(`директива #${name} пропущена (не поддерживается)`, dLine, dCol);
    }
    skipToEol();
  }

  function skipWhitespace() {
    while (i < len && /\s/.test(src[i])) advance();
  }

  function skipToEol() {
    while (i < len && src[i] !== '\n') advance();
  }

  function readString(quote) {
    const l = line, c = col;
    advance(); // открывающая кавычка
    let out = '';
    while (i < len && src[i] !== quote) {
      if (src[i] === '\n') { err('незакрытая строка', l, c); break; }
      if (src[i] === '\\') {
        advance();
        const esc = src[i];
        if (esc === undefined) break;
        out += unescapeChar(esc, line, col);
        advance();
      } else {
        out += src[i];
        advance();
      }
    }
    if (src[i] === quote) advance();
    else err('не хватает закрывающей кавычки', l, c);
    return out;
  }

  function unescapeChar(e, l, c) {
    switch (e) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      case 'x': {
        let hex = '';
        while (i + 1 < len && /[0-9a-fA-F]/.test(src[i + 1]) && hex.length < 2) {
          advance(); hex += src[i];
        }
        return String.fromCharCode(parseInt(hex, 16) || 0);
      }
      default:
        err(`неизвестная escape-последовательность «\\${e}»`, l, c);
        return e;
    }
  }

  function readNumber() {
    const l = line, c = col;
    let text = '';
    let isFloat = false;
    if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      text = '0x'; advance(2);
      while (i < len && /[0-9a-fA-F]/.test(src[i])) { text += src[i]; advance(); }
    } else if (src[i] === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
      text = '0b'; advance(2);
      while (i < len && /[01]/.test(src[i])) { text += src[i]; advance(); }
    } else {
      while (i < len && DIGIT.test(src[i])) { text += src[i]; advance(); }
      if (src[i] === '.') {
        isFloat = true;
        text += '.'; advance();
        while (i < len && DIGIT.test(src[i])) { text += src[i]; advance(); }
      }
      if (src[i] === 'e' || src[i] === 'E') {
        isFloat = true;
        text += 'e'; advance();
        if (src[i] === '+' || src[i] === '-') { text += src[i]; advance(); }
        while (i < len && DIGIT.test(src[i])) { text += src[i]; advance(); }
      }
    }
    // Суффиксы
    let suffix = '';
    while (i < len && /[uUlLfF]/.test(src[i]) && suffix.length < 2) {
      if (/[lL]/.test(src[i]) && suffix.includes('f')) break;
      suffix += src[i];
      advance();
    }
    if (/[fF]/.test(suffix)) isFloat = true;

    let value;
    if (text.startsWith('0x') || text.startsWith('0X')) value = parseInt(text, 16);
    else if (text.startsWith('0b') || text.startsWith('0B')) value = parseInt(text.slice(2), 2);
    else value = parseFloat(text);

    if (Number.isNaN(value)) { err(`некорректное число «${text}${suffix}»`, l, c); value = 0; }
    push('num', { value, isFloat }, l, c);
  }

  while (i < len) {
    const ch = src[i];

    // Пробелы
    if (/\s/.test(ch)) { advance(); continue; }

    // Комментарии
    if (ch === '/' && src[i + 1] === '/') { skipToEol(); continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const l = line, c = col;
      advance(2);
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) advance();
      if (i >= len) err('незакрытый комментарий /*', l, c);
      else advance(2);
      continue;
    }

    // Препроцессор
    if (ch === '#' ) {
      // только если это начало строки (перед # были только пробелы)
      let j = i - 1;
      let atLineStart = true;
      while (j >= 0 && src[j] !== '\n') {
        if (!/[ \t\r]/.test(src[j])) { atLineStart = false; break; }
        j--;
      }
      if (atLineStart) { readDirective(); continue; }
      err('символ # вне директивы', line, col);
      advance();
      continue;
    }

    // Идентификаторы / ключевые слова
    if (IDENT_START.test(ch)) {
      const l = line, c = col;
      let name = '';
      while (i < len && IDENT_PART.test(src[i])) { name += src[i]; advance(); }
      emitIdent(name, l, c, 0);
      continue;
    }

    // Числа
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(src[i + 1] || ''))) {
      readNumber();
      continue;
    }

    // Строки и символы
    if (ch === '"' ) { push('str', readString('"'), line, col); continue; }
    if (ch === "'") {
      const l = line, c = col;
      const inner = readString("'");
      if (inner.length !== 1) err(`символьный литерал должен содержать один символ, получено «${inner}»`, l, c);
      push('num', { value: inner.length ? inner.charCodeAt(0) : 0, isFloat: false }, l, c);
      continue;
    }

    // Операторы
    let matched = null;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      if (matched === '->' || matched === '...') {
        err(matched === '->' ? 'оператор «->» не поддерживается (используй объекты через «.»)' : '«...» не поддерживается', line, col);
      }
      push('op', matched, line, col);
      advance(matched.length);
      continue;
    }

    err(`непонятный символ «${ch}»`, line, col);
    advance();
  }

  return { tokens, errors };
}
