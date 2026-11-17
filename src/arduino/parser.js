// Парсер подмножества C++ → AST. Бросает ParseError с line/col.
// Узлы — простые объекты {type, ...}. У каждого узла инструкции есть line.

export class ParseError extends Error {
  constructor(message, line, col) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

// Канонические типы: void, bool, int(16), uint(16), byte(8), long(32), ulong(32), float, Servo
const TYPE_MAP = {
  void: 'void',
  bool: 'bool',
  boolean: 'bool',
  int: 'int',
  short: 'int',
  int16_t: 'int',
  word: 'uint',
  unsigned: 'uint', // уточняется ниже по комбинации
  uint: 'uint',
  uint16_t: 'uint',
  byte: 'byte',
  uint8_t: 'byte',
  long: 'long',
  int32_t: 'long',
  ulong: 'ulong',
  uint32_t: 'ulong',
  size_t: 'ulong',
  float: 'float',
  double: 'float',
  char: 'int',
  signed: 'int', // уточняется ниже
  String: 'String',
  Servo: 'Servo',
};

const FLOAT_TYPES = new Set(['float']);
const OBJECT_TYPES = new Set(['Servo']);

export function parse(tokens) {
  let pos = 0;

  const EOF_TOKEN = tokens.length
    ? { type: 'eof', value: null, line: tokens[tokens.length - 1].line, col: tokens[tokens.length - 1].col }
    : { type: 'eof', value: null, line: 0, col: 0 };

  function peek(o = 0) {
    return tokens[pos + o] || EOF_TOKEN;
  }
  function at(type, value) {
    const t = peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  function next() {
    const t = tokens[pos++];
    return t || EOF_TOKEN;
  }
  function expect(type, value, what) {
    const t = peek();
    if (t.type === type && (value === undefined || t.value === value)) return next();
    throw new ParseError(
      `ожидалось ${what || (value !== undefined ? `«${value}»` : type)}, а встретилось ` +
      (t.type === 'eof' ? 'конец файла' : `«${t.value}»`),
      t.line, t.col,
    );
  }
  function fail(message, t = peek()) {
    throw new ParseError(message, t.line, t.col);
  }

  // ── Типы ─────────────────────────────────────────────────────────────

  function isTypeStart(t) {
    if (t.type !== 'kw' && t.type !== 'ident') return false;
    if (TYPE_MAP[t.value] !== undefined) return true;
    return false;
  }

  // Возвращает канонический тип или null, если это не тип.
  function tryParseType() {
    const t = peek();
    if (t.type === 'kw' && (t.value === 'const' || t.value === 'static' || t.value === 'volatile')) {
      next(); // игнорируем квалификаторы
      return tryParseType();
    }
    if (t.type !== 'kw' && t.type !== 'ident') return null;
    const base = TYPE_MAP[t.value];
    if (base === undefined) return null;
    next();
    let type = base;
    // Комбинации: unsigned X, signed X, long long, unsigned long и т.п.
    while (true) {
      const n = peek();
      if (n.type === 'kw' && (n.value === 'unsigned' || n.value === 'signed' || n.value === 'long' || n.value === 'short' || n.value === 'int')) {
        const combo = (type === 'uint' ? 'u' : '') + n.value;
        next();
        if (n.value === 'unsigned') type = type === 'long' ? 'ulong' : type === 'char' ? 'byte' : 'uint';
        else if (n.value === 'long') type = type === 'uint' ? 'ulong' : 'long';
        else if (n.value === 'short') type = type === 'uint' ? 'uint' : 'int';
        else if (n.value === 'signed') type = type === 'ulong' ? 'long' : type === 'uint' ? 'int' : type === 'byte' ? 'int' : type;
        else if (n.value === 'int') { /* unsigned int и т.п. — тип уже верный */ }
        void combo;
        continue;
      }
      break;
    }
    return type;
  }

  // ── Выражения ────────────────────────────────────────────────────────

  function parseExpr() {
    // Оператор-запятая (нужен для for (…; …; i++, j++))
    let e = parseAssign();
    while (at('op', ',')) {
      const t = next();
      const right = parseAssign();
      if (e.type === 'Seq') e.exprs.push(right);
      else e = { type: 'Seq', exprs: [e, right], line: t.line };
    }
    return e;
  }

  function parseAssign() {
    const left = parseTernary();
    const t = peek();
    if (t.type === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^='].includes(t.value)) {
      next();
      const value = parseAssign();
      if (left.type !== 'Ident' && left.type !== 'Index') {
        fail('слева от «=» должна быть переменная или элемент массива', t);
      }
      return { type: 'Assign', op: t.value, target: left, value, line: t.line };
    }
    return left;
  }

  function parseTernary() {
    const cond = parseBinary(0);
    if (at('op', '?')) {
      const q = next();
      const a = parseAssign();
      expect('op', ':', '«:» в тернарном операторе');
      const b = parseAssign();
      return { type: 'Cond', cond, a, b, line: q.line };
    }
    return cond;
  }

  // Условное выражение (для размеров массивов, меток case, параметров)
  function parseCond() {
    return parseTernary();
  }

  const BIN_LEVELS = [
    ['||'], ['&&'], ['|'], ['^'], ['&'],
    ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
  ];

  function parseBinary(level) {
    if (level >= BIN_LEVELS.length) return parseUnary();
    let left = parseBinary(level + 1);
    while (true) {
      const t = peek();
      if (t.type === 'op' && BIN_LEVELS[level].includes(t.value)) {
        next();
        const right = parseBinary(level + 1);
        left = { type: 'Binary', op: t.value, l: left, r: right, line: t.line };
      } else break;
    }
    return left;
  }

  function looksLikeCast() {
    // ( тип ) — заглядываем на 2+ токена вперёд
    if (!at('op', '(')) return false;
    let o = 1;
    const t1 = peek(o);
    if (t1.type !== 'kw' && t1.type !== 'ident') return false;
    if (t1.value === 'const' || t1.value === 'static' || t1.value === 'volatile') return true; // дальше разберёт tryParseType
    if (TYPE_MAP[t1.value] === undefined) return false;
    o++;
    // комбинации unsigned long и т.п.
    while (true) {
      const t = peek(o);
      if (t.type === 'kw' && ['unsigned', 'signed', 'long', 'short', 'int'].includes(t.value)) { o++; continue; }
      break;
    }
    return peek(o).type === 'op' && peek(o).value === ')';
  }

  function parseUnary() {
    const t = peek();
    if (t.type === 'op' && ['!', '~', '-', '+'].includes(t.value)) {
      next();
      const operand = parseUnary();
      return { type: 'Unary', op: t.value, operand, postfix: false, line: t.line };
    }
    if (t.type === 'op' && (t.value === '++' || t.value === '--')) {
      next();
      const operand = parseUnary();
      if (operand.type !== 'Ident' && operand.type !== 'Index') fail('после «' + t.value + '» нужна переменная или элемент массива', t);
      return { type: 'Unary', op: t.value, operand, postfix: false, line: t.line };
    }
    if (looksLikeCast()) {
      expect('op', '(');
      const toType = parseCastType();
      expect('op', ')', '«)» после типа в приведении');
      const operand = parseUnary();
      return { type: 'Cast', toType, operand, line: t.line };
    }
    return parsePostfix();
  }

  function parseCastType() {
    const t = tryParseType();
    if (!t) fail('ожидался тип в приведении');
    return t;
  }

  function parsePostfix() {
    let expr = parsePrimary();
    while (true) {
      const t = peek();
      if (t.type === 'op' && t.value === '(') {
        if (expr.type !== 'Ident') fail('вызывать можно только функцию по имени', t);
        next();
        const args = parseArgs();
        expr = { type: 'Call', name: expr.name, args, line: t.line };
      } else if (t.type === 'op' && t.value === '.') {
        next();
        const nameTok = expect('ident', undefined, 'имя метода после «.»');
        expect('op', '(', '«(» — вызов метода');
        const args = parseArgs();
        expr = { type: 'Method', obj: expr, name: nameTok.value, args, line: t.line };
      } else if (t.type === 'op' && t.value === '[') {
        next();
        const idx = parseExpr();
        let idx2 = null;
        if (at('op', ']')) {
          expect('op', ']');
        } else {
          expect('op', ',', '«]» или «,» в индексе');
          idx2 = parseExpr();
          expect('op', ']', '«]»');
        }
        expr = { type: 'Index', arr: expr, idx, idx2, line: t.line };
      } else if (t.type === 'op' && (t.value === '++' || t.value === '--')) {
        if (expr.type !== 'Ident' && expr.type !== 'Index') break;
        next();
        expr = { type: 'Unary', op: t.value, operand: expr, postfix: true, line: t.line };
      } else break;
    }
    return expr;
  }

  function parseArgs() {
    const args = [];
    if (at('op', ')')) { next(); return args; }
    while (true) {
      args.push(parseAssign());
      if (at('op', ',')) { next(); continue; }
      expect('op', ')', '«)» или «,» в списке аргументов');
      break;
    }
    return args;
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'num') {
      next();
      return { type: 'NumLit', value: t.value.value, isFloat: t.value.isFloat || !Number.isInteger(t.value.value), line: t.line };
    }
    if (t.type === 'str') {
      next();
      return { type: 'StrLit', value: t.value, line: t.line };
    }
    if (t.type === 'kw' && (t.value === 'true' || t.value === 'false')) {
      next();
      return { type: 'NumLit', value: t.value === 'true' ? 1 : 0, isFloat: false, line: t.line };
    }
    if (t.type === 'ident') {
      next();
      return { type: 'Ident', name: t.value, line: t.line };
    }
    if (t.type === 'op' && t.value === '(') {
      next();
      const e = parseExpr();
      expect('op', ')', '«)»');
      return e;
    }
    if (t.type === 'op' && t.value === '{') {
      fail('фигурные скобки в выражении допустимы только в инициализаторе массива', t);
    }
    if (t.type === 'eof') fail('неожиданный конец файла — похоже, не хватает «}» или «;»', t);
    fail(`неожиданный токен «${t.value}»`, t);
  }

  // ── Объявления ───────────────────────────────────────────────────────

  function parseDeclarator(varType) {
    const t = peek();
    const nameTok = expect('ident', undefined, 'имя переменной');
    let kind = 'scalar';
    let size1 = null;
    let size2 = null;
    let init = null;
    if (at('op', '*')) fail('указатели не поддерживаются — используй массивы или String', t);
    if (at('op', '&')) fail('ссылки (&) не поддерживаются', t);
    if (at('op', '[')) {
      next();
      if (!at('op', ']')) size1 = parseCond();
      expect('op', ']', '«]»');
      kind = 'array1';
      if (at('op', '[')) {
        next();
        if (!at('op', ']')) size2 = parseCond();
        expect('op', ']', '«]»');
        kind = 'array2';
      }
    }
    if (at('op', '=')) {
      next();
      if (at('op', '{')) init = parseArrayLit();
      else init = parseAssign();
    }
    return { name: nameTok.value, kind, size1, size2, init, line: nameTok.line, varType };
  }

  function parseArrayLit() {
    const t = expect('op', '{', '«{»');
    const items = [];
    if (!at('op', '}')) {
      while (true) {
        if (at('op', '{')) items.push(parseArrayLit());
        else items.push(parseAssign());
        if (at('op', ',')) { next(); if (at('op', '}')) break; continue; }
        expect('op', '}', '«}» или «,»');
        break;
      }
    } else next();
    return { type: 'ArrayLit', items, line: t.line };
  }

  // Проверяет, начинается ли здесь объявление переменной/функции.
  function isDeclStart() {
    let o = 0;
    while (peek(o).type === 'kw' && ['const', 'static', 'volatile'].includes(peek(o).value)) o++;
    const t = peek(o);
    if (t.type === 'kw' && ['unsigned', 'signed', 'long', 'short'].includes(t.value)) {
      const t2 = peek(o + 1);
      // комбинация «unsigned long …» / «long long …»
      if (isTypeStart(t2) || (t2.type === 'kw' && ['unsigned', 'signed', 'long', 'short', 'int'].includes(t2.value))) return true;
      // иначе просто одиночный тип («long x;», «long foo()») — общий путь ниже
    }
    return isTypeStart(t);
  }

  // ── Инструкции ───────────────────────────────────────────────────────

  function parseStmt() {
    const t = peek();

    if (t.type === 'kw') {
      switch (t.value) {
        case 'struct': case 'union': case 'enum':
          fail(`«${t.value}» не поддерживается — используй отдельные переменные`, t);
          break;
        case 'typedef':
          fail('typedef не поддерживается', t);
          break;
        case 'new': case 'delete': case 'sizeof': case 'class': case 'template':
        case 'namespace': case 'using': case 'public': case 'private': case 'protected':
          fail(`«${t.value}» не поддерживается`, t);
          break;
        case 'if': return parseIf();
        case 'while': return parseWhile();
        case 'do': return parseDoWhile();
        case 'for': return parseFor();
        case 'switch': return parseSwitch();
        case 'break': next(); expect('op', ';', '«;» после break'); return { type: 'Break', line: t.line };
        case 'continue': next(); expect('op', ';', '«;» после continue'); return { type: 'Continue', line: t.line };
        case 'return': {
          next();
          let value = null;
          if (!at('op', ';')) value = parseExpr();
          expect('op', ';', '«;» после return');
          return { type: 'Return', value, line: t.line };
        }
      }
    }

    if (at('op', '{')) return parseBlock();
    if (at('op', ';')) { next(); return { type: 'Empty', line: t.line }; }

    // Объявление?
    if (isDeclStart()) return parseVarDecl();

    // Выражение
    const e = parseExpr();
    expect('op', ';', '«;» в конце инструкции');
    return { type: 'ExprStmt', expr: e, line: t.line };
  }

  function parseBlock() {
    const t = expect('op', '{', '«{»');
    const stmts = [];
    while (!at('op', '}')) {
      if (peek().type === 'eof') fail('не хватает закрывающей «}»', t);
      stmts.push(parseStmt());
    }
    next();
    return { type: 'Block', stmts, line: t.line };
  }

  function parseIf() {
    const t = next(); // if
    expect('op', '(', '«(» после if');
    const cond = parseExpr();
    expect('op', ')', '«)» после условия if');
    const then = parseStmt();
    let els = null;
    if (at('kw', 'else')) {
      next();
      els = parseStmt();
    }
    return { type: 'If', cond, then, else: els, line: t.line };
  }

  function parseWhile() {
    const t = next();
    expect('op', '(', '«(» после while');
    const cond = parseExpr();
    expect('op', ')', '«)» после условия while');
    const body = parseStmt();
    return { type: 'While', cond, body, line: t.line };
  }

  function parseDoWhile() {
    const t = next();
    const body = parseStmt();
    expect('kw', 'while', 'while после тела do');
    expect('op', '(', '«(» после while');
    const cond = parseExpr();
    expect('op', ')', '«)» после условия');
    expect('op', ';', '«;» после do-while');
    return { type: 'DoWhile', body, cond, line: t.line };
  }

  function parseFor() {
    const t = next();
    expect('op', '(', '«(» после for');
    let init = null;
    if (!at('op', ';')) {
      if (isDeclStart()) init = parseVarDecl({ noSemi: false });
      else {
        init = { type: 'ExprStmt', expr: parseExpr(), line: t.line };
        expect('op', ';', '«;» в заголовке for');
      }
    } else next();
    let cond = null;
    if (!at('op', ';')) cond = parseExpr();
    expect('op', ';', '«;» в заголовке for');
    let post = null;
    if (!at('op', ')')) post = parseExpr();
    expect('op', ')', '«)» в заголовке for');
    const body = parseStmt();
    return { type: 'For', init, cond, post, body, line: t.line };
  }

  function parseSwitch() {
    const t = next();
    expect('op', '(', '«(» после switch');
    const disc = parseExpr();
    expect('op', ')', '«)» после switch');
    expect('op', '{', '«{» после switch(…)');
    const cases = [];
    while (!at('op', '}')) {
      if (peek().type === 'eof') fail('не хватает «}» в switch', t);
      if (at('kw', 'case')) {
        next();
        const test = parseCond();
        expect('op', ':', '«:» после case');
        cases.push({ test, body: [] });
      } else if (at('kw', 'default')) {
        next();
        expect('op', ':', '«:» после default');
        cases.push({ test: null, body: [] });
      } else {
        const st = parseStmt();
        if (!cases.length) fail('в switch до первого case идут инструкции', t);
        cases[cases.length - 1].body.push(st);
      }
    }
    next();
    return { type: 'Switch', disc, cases, line: t.line };
  }

  function parseVarDecl(opts = {}) {
    let wasStatic = false;
    let varType;
    if (opts.varType) {
      // Тип уже распознан вызывающим кодом (верхний уровень)
      varType = opts.varType;
    } else {
      while (at('kw', 'static') || at('kw', 'volatile') || at('kw', 'const')) {
        if (at('kw', 'static')) wasStatic = true;
        next();
      }
      varType = tryParseType();
      if (!varType) fail('ожидался тип');
    }
    if (at('op', '*')) fail('указатели не поддерживаются — используй массивы или String');
    if (at('op', '&')) fail('ссылки (&) не поддерживаются');
    if (varType === 'void') fail('переменная не может быть типа void');
    const decls = [parseDeclarator(varType)];
    while (at('op', ',')) {
      next();
      decls.push(parseDeclarator(varType));
    }
    expect('op', ';', '«;» после объявления');
    return { type: 'VarDecl', varType, decls, line: decls[0].line, static: wasStatic };
  }

  // ── Верхний уровень ──────────────────────────────────────────────────

  function parseFunction(varType) {
    const nameTok = expect('ident', undefined, 'имя функции');
    expect('op', '(', '«(» после имени функции');
    const params = [];
    if (!at('op', ')')) {
      while (true) {
        const pType = tryParseType();
        if (!pType) fail('ожидался тип параметра');
        if (pType === 'void') fail('параметр не может быть void — просто оставь скобки пустыми');
        const pName = expect('ident', undefined, 'имя параметра');
        let isArray = false;
        if (at('op', '[')) {
          next();
          // необязательный размер игнорируем
          if (!at('op', ']')) parseCond();
          expect('op', ']', '«]»');
          isArray = true;
        }
        params.push({ type: pType, name: pName.value, isArray, line: pName.line });
        if (at('op', ',')) { next(); continue; }
        expect('op', ')', '«)» или «,» в списке параметров');
        break;
      }
    } else next();
    if (at('op', ';')) {
      next();
      return null; // прототип — игнорируем
    }
    const body = parseBlock();
    return { type: 'FuncDecl', retType: varType, name: nameTok.value, params, body, line: nameTok.line };
  }

  const body = [];
  while (peek().type !== 'eof') {
    if (isDeclStart()) {
      const save = pos;
      const varType = tryParseType();
      if (varType === undefined || varType === null) { pos = save; fail('ожидался тип'); }
      if (at('op', ';')) { next(); continue; } // «int;» — мусор, пропустим
      const nameTok = peek();
      if (nameTok.type !== 'ident') {
        // тип без имени — пропускаем точку с запятой
        if (at('op', ';')) { next(); continue; }
        fail('ожидалось имя после типа', nameTok);
      }
      next(); // имя
      if (at('op', '(')) {
        pos--; // вернуть имя — parseFunction его ожидает
        const fn = parseFunction(varType);
        if (fn) body.push(fn);
      } else {
        pos--; // вернуть имя — parseDeclarator его ожидает
        body.push(parseVarDecl({ varType }));
      }
    } else {
      const t = peek();
      if (t.type === 'eof') break;
      fail(`вне функции допустимы только объявления — неожиданный токен «${t.value}»`, t);
    }
  }

  return { type: 'Program', body };
}
