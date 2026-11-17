// Асинхронный интерпретатор подмножества C++ (Arduino-скетчи).
// Все обращения к «железу» — через api (см. arduinoApi.js). В Node — мок-API.

export class StopError extends Error {
  constructor() { super('остановлено'); }
}
export class RunError extends Error {
  constructor(message, line) {
    super(line ? `${message} (строка ${line})` : message);
    this.line = line || 0;
  }
}

class BreakSignal extends Error {}
class ContinueSignal extends Error {}
class ReturnSignal extends Error {
  constructor(value) { super('return'); this.value = value; }
}

class Env {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map(); // имя -> cell {type, value}
  }
  find(name) {
    let e = this;
    while (e) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    return null;
  }
  findCellEnv(name) {
    let e = this;
    while (e) {
      if (e.vars.has(name)) return e;
      e = e.parent;
    }
    return null;
  }
  declare(name, cell) {
    this.vars.set(name, cell);
  }
}

// ── Числовая семантика ───────────────────────────────────────────────

function wrapValue(type, v) {
  v = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  switch (type) {
    case 'int': {
      let n = Math.trunc(v) & 0xFFFF;
      return n >= 0x8000 ? n - 0x10000 : n;
    }
    case 'uint':
      return Math.trunc(v) & 0xFFFF;
    case 'byte':
      return Math.trunc(v) & 0xFF;
    case 'long': {
      let n = Math.trunc(v) & 0xFFFFFFFF;
      return n >= 0x80000000 ? n - 0x100000000 : n;
    }
    case 'ulong':
      return Math.trunc(v) >>> 0;
    case 'float':
      return Number(v);
    case 'bool':
      return !!v;
    case 'String':
      return typeof v === 'string' ? v : String(v);
    default:
      return v;
  }
}

function defaultValue(type) {
  switch (type) {
    case 'float': return 0;
    case 'bool': return false;
    case 'String': return '';
    case 'Servo': return { __kind: 'Servo', id: null, angle: 0 };
    default: return 0;
  }
}

const CONSTS = {
  HIGH: 1, LOW: 0,
  INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2,
  LED_BUILTIN: 13,
  A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19,
  CHANGE: 1, FALLING: 2, RISING: 3,
  PI: Math.PI,
  HALF_PI: Math.PI / 2,
  TWO_PI: Math.PI * 2,
  DEG_TO_RAD: Math.PI / 180,
  RAD_TO_DEG: 180 / Math.PI,
};

const FLOAT_FUNCS = new Set(['sqrt', 'sin', 'cos', 'tan', 'atan2', 'pow', 'floor', 'ceil']);

export class SketchRuntime {
  constructor(program, api, opts = {}) {
    this.program = program;
    this.api = api;
    this.opsPerFrame = opts.opsPerFrame ?? 20000;
    this.maxDepth = opts.maxDepth ?? 200;
    this.onError = opts.onError || ((msg) => console.error('[скетч]', msg));

    this.funcs = new Map();
    this.globalEnv = new Env(null);
    this.globalEnv.declare('Serial', { type: 'Serial', value: { __kind: 'Serial' } });
    for (const node of program.body) {
      if (node.type === 'FuncDecl') this.funcs.set(node.name, node);
    }
    this.running = false;
    this.stopRequested = false;
    this.ops = 0;
    this.depth = 0;
    this.pendingInts = [];
    this.servoIdSeq = 1;
    this.yieldsWithoutDelay = 0;
    this.hintedSlow = false;
    this.stopReject = null;
    this.stopPromise = new Promise((_, rej) => { this.stopReject = rej; });
    this.stopPromise.catch(() => {}); // не ронять процесс на необработанном reject
    this.randState = 0x2F6E2B1;
  }

  // ── Жизненный цикл ─────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    try {
      for (const node of this.program.body) {
        if (node.type === 'VarDecl') await this.evalStmt(node, this.globalEnv);
      }
      const setup = this.funcs.get('setup');
      if (setup) await this.callFunction(setup, []);
      const loop = this.funcs.get('loop');
      if (!loop) {
        this.onError('в скетче нет функции loop() — добавь void loop() { ... }');
        return;
      }
      this.running = true;
      while (this.running) {
        await this.callFunction(loop, []);
        await this.yieldPoint(true);
      }
    } catch (e) {
      if (!(e instanceof StopError)) {
        this.onError(e instanceof RunError ? e.message : `ошибка исполнения: ${e.message}`);
      }
    } finally {
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    this.stopRequested = true;
    this.stopReject(new StopError());
  }

  queueInterrupt(fnRef) {
    if (this.pendingInts.length < 64) this.pendingInts.push(fnRef);
  }

  // Точка yield: прерывания + возврат управления браузеру.
  async yieldPoint(fromLoop) {
    if (this.stopRequested) throw new StopError();
    await this._runPendingInts();
    if (!fromLoop) this.yieldsWithoutDelay++;
    if (this.yieldsWithoutDelay > 400 && !this.hintedSlow) {
      this.hintedSlow = true;
      this.api.serialPrint('⏱ Скетч работает без пауз — добавь delay(1), чтобы не съедать всё время симуляции\n', true);
    }
    await Promise.race([this.api.yieldFrame(), this.stopPromise]);
  }

  // Разбор очереди прерываний (энкодеры и т.п.).
  async _runPendingInts() {
    while (this.pendingInts.length) {
      const fnRef = this.pendingInts.shift();
      try {
        const fn = this.funcs.get(fnRef.__fn);
        if (fn) await this.callFunction(fn, []);
      } catch (e) {
        if (e instanceof StopError) throw e;
        throw new RunError(`ошибка в обработчике прерывания: ${e.message}`);
      }
    }
  }

  async tick() {
    if (++this.ops >= this.opsPerFrame) {
      this.ops = 0;
      await this.yieldPoint(false);
    }
  }

  async delay(ms) {
    this.yieldsWithoutDelay = 0;
    if (ms > 0) {
      await Promise.race([this.api.delayMs(ms), this.stopPromise]);
      // прерывания, накопившиеся за время паузы (энкодерные тики идут
      // каждый шаг физики — без этого while (cntL < N) delay(1) копится
      // очередь до бюджета в 20000 операций и крутится вечно)
      await this._runPendingInts();
    } else await this.tick();
  }

  // ── Вызов функций ──────────────────────────────────────────────────

  async callFunction(fnNode, args) {
    if (++this.depth > this.maxDepth) {
      this.depth--;
      throw new RunError(`слишком глубокая рекурсия (>${this.maxDepth})`, fnNode.line);
    }
    const env = new Env(this.globalEnv);
    env.funcNode = fnNode;
    fnNode.__statics = fnNode.__statics || new Map();
    try {
      for (let i = 0; i < fnNode.params.length; i++) {
        const p = fnNode.params[i];
        const arg = args[i];
        if (arg === undefined) throw new RunError(`в «${fnNode.name}()» не хватает аргумента №${i + 1}`, fnNode.line);
        env.declare(p.name, p.isArray
          ? { type: p.type, elemType: p.type, value: arg, array: true }
          : { type: p.type, value: wrapValue(p.type, arg) });
      }
      await this.evalStmt(fnNode.body, env);
      return undefined; // void
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ── Инструкции ─────────────────────────────────────────────────────

  async evalStmt(node, env) {
    await this.tick();
    switch (node.type) {
      case 'Block': {
        const inner = new Env(env);
        inner.funcNode = env.funcNode;
        for (const st of node.stmts) await this.evalStmt(st, inner);
        return;
      }
      case 'Empty':
        return;
      case 'ExprStmt':
        await this.evalExpr(node.expr, env);
        return;
      case 'VarDecl':
        await this.evalVarDecl(node, env);
        return;
      case 'If': {
        if (await this.evalExpr(node.cond, env)) await this.evalStmt(node.then, env);
        else if (node.else) await this.evalStmt(node.else, env);
        return;
      }
      case 'While': {
        while (await this.evalExpr(node.cond, env)) {
          await this.tick();
          try { await this.evalStmt(node.body, env); }
          catch (e) {
            if (e instanceof BreakSignal) return;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'DoWhile': {
        while (true) {
          await this.tick();
          try { await this.evalStmt(node.body, env); }
          catch (e) {
            if (e instanceof BreakSignal) return;
            if (!(e instanceof ContinueSignal)) throw e;
          }
          if (!(await this.evalExpr(node.cond, env))) return;
        }
      }
      case 'For': {
        const loopEnv = new Env(env);
        loopEnv.funcNode = env.funcNode;
        if (node.init) await this.evalStmt(node.init, loopEnv);
        while (node.cond ? await this.evalExpr(node.cond, loopEnv) : true) {
          await this.tick();
          try { await this.evalStmt(node.body, loopEnv); }
          catch (e) {
            if (e instanceof BreakSignal) return;
            if (!(e instanceof ContinueSignal)) throw e;
          }
          if (node.post) await this.evalExpr(node.post, loopEnv);
        }
        return;
      }
      case 'Switch': {
        const disc = await this.evalExpr(node.disc, env);
        let startIdx = -1;
        for (let i = 0; i < node.cases.length; i++) {
          const c = node.cases[i];
          if (c.test !== null && (await this.evalExpr(c.test, env)) === disc) { startIdx = i; break; }
        }
        if (startIdx < 0) startIdx = node.cases.findIndex((c) => c.test === null);
        if (startIdx < 0) return;
        const blockEnv = new Env(env);
        blockEnv.funcNode = env.funcNode;
        try {
          for (let ci = startIdx; ci < node.cases.length; ci++) {
            for (const st of node.cases[ci].body) await this.evalStmt(st, blockEnv);
          }
        } catch (e) {
          if (e instanceof BreakSignal) return;
          throw e;
        }
        return;
      }
      case 'Return':
        throw new ReturnSignal(node.value ? await this.evalExpr(node.value, env) : undefined);
      case 'Break':
        throw new BreakSignal();
      case 'Continue':
        throw new ContinueSignal();
      default:
        throw new RunError(`неизвестная инструкция «${node.type}»`, node.line);
    }
  }

  async evalVarDecl(node, env) {
    // static — в постоянное хранилище функции (или в глобальные)
    let scope = env;
    let statics = null;
    if (node.static) {
      if (env.funcNode) {
        statics = env.funcNode.__statics;
      } else {
        statics = null; // глобальный static — обычная глобальная переменная
        scope = this.globalEnv;
      }
    }
    for (const decl of node.decls) {
      const cellType = decl.varType;
      if (cellType === 'Servo') {
        const cell = { type: 'Servo', value: { __kind: 'Servo', id: 's' + this.servoIdSeq++, angle: 0 } };
        this.bindCell(scope, statics, decl.name, cell, node);
        continue;
      }
      if (decl.kind === 'scalar') {
        let value = defaultValue(cellType === 'String' ? 'String' : cellType);
        if (decl.init) {
          const raw = await this.evalExpr(decl.init, env);
          if (cellType === 'String') value = typeof raw === 'string' ? raw : this.formatValue(raw);
          else value = wrapValue(cellType, raw);
        }
        this.bindCell(scope, statics, decl.name, { type: cellType, value }, node);
      } else {
        // Массивы
        let value;
        const dims = [];
        if (decl.size1 !== null) dims.push(Math.trunc(await this.evalExpr(decl.size1, env)));
        if (decl.kind === 'array2') dims.push(Math.trunc(await this.evalExpr(decl.size2, env)));
        for (const d of dims) {
          if (!(d > 0) || d > 20000) throw new RunError(`некорректный размер массива «${decl.name}»`, node.line);
        }
        value = this.buildArray(dims, cellType);
        let flatInits = null;
        if (decl.init) {
          if (decl.init.type !== 'ArrayLit') throw new RunError(`инициализатор массива «${decl.name}» должен быть {...}`, node.line);
          flatInits = decl.kind === 'array2' ? decl.init.items : decl.init.items;
          if (!dims.length) {
            // int a[] = {...} — размер из инициализатора
            if (decl.kind === 'array2') {
              const rows = flatInits.length;
              const cols = flatInits[0] && flatInits[0].type === 'ArrayLit' ? flatInits[0].items.length : 0;
              dims.push(rows, cols);
              value = this.buildArray(dims, cellType);
            } else {
              dims.push(flatInits.length);
              value = this.buildArray(dims, cellType);
            }
          }
        }
        const cell = { type: cellType, elemType: cellType, value, array: true };
        this.bindCell(scope, statics, decl.name, cell, node);
        if (decl.init) await this.fillArray(cell.value, flatInits, dims.length, cellType, env, node);
      }
    }
  }

  bindCell(scope, statics, name, cell, node) {
    if (statics) {
      const existing = statics.get(name);
      if (existing) {
        scope.declare(name, existing); // та же ячейка — значение живёт между вызовами
        return;
      }
      statics.set(name, cell);
      scope.declare(name, cell);
      return;
    }
    if (scope === this.globalEnv && this.globalEnv.vars.has(name)) {
      throw new RunError(`переменная «${name}» объявлена дважды`, node.line);
    }
    scope.declare(name, cell);
  }

  buildArray(dims, type) {
    if (dims.length === 1) {
      const a = new Array(dims[0]);
      for (let i = 0; i < a.length; i++) a[i] = type === 'String' ? '' : defaultValue(type);
      return a;
    }
    const a = new Array(dims[0]);
    for (let i = 0; i < a.length; i++) a[i] = this.buildArray(dims.slice(1), type);
    return a;
  }

  async fillArray(arr, items, depth, elemType, env, node) {
    for (let i = 0; i < arr.length && i < items.length; i++) {
      const item = items[i];
      if (depth > 1) {
        if (item.type !== 'ArrayLit') throw new RunError('ожидался вложенный инициализатор {...}', node.line);
        await this.fillArray(arr[i], item.items, depth - 1, elemType, env, node);
      } else {
        const raw = await this.evalExpr(item, env);
        if (elemType === 'String') arr[i] = typeof raw === 'string' ? raw : this.formatValue(raw);
        else arr[i] = wrapValue(elemType, raw);
      }
    }
  }

  // ── Выражения ──────────────────────────────────────────────────────

  isFloatExpr(node, env) {
    switch (node.type) {
      case 'NumLit': return !!node.isFloat;
      case 'Ident': {
        const cell = this.lookupCell(node.name, env, node);
        return cell ? cell.type === 'float' : false;
      }
      case 'Index': {
        const cell = this.arrayCellOf(node, env);
        return cell ? cell.type === 'float' : false;
      }
      case 'Cast': return node.toType === 'float';
      case 'Unary': return node.op === '-' ? this.isFloatExpr(node.operand, env) : false;
      case 'Binary': return ['+', '-', '*', '/', '%'].includes(node.op)
        ? this.isFloatExpr(node.l, env) || this.isFloatExpr(node.r, env)
        : false;
      case 'Cond': return this.isFloatExpr(node.a, env) || this.isFloatExpr(node.b, env);
      case 'Call': {
        const fn = this.funcs.get(node.name);
        if (fn) return fn.retType === 'float';
        return FLOAT_FUNCS.has(node.name);
      }
      default: return false;
    }
  }

  lookupCell(name, env, node) {
    const cell = env.find(name);
    if (cell) return cell;
    if (this.funcs.has(name)) return null; // ссылка на функцию
    if (name in CONSTS) return null;
    throw new RunError(`неизвестное имя «${name}»`, node.line);
  }

  async evalExpr(node, env) {
    switch (node.type) {
      case 'NumLit':
        return node.value;
      case 'StrLit':
        return node.value;
      case 'Ident': {
        if (env.vars.has(node.name) || env.find(node.name)) {
          const cell = env.find(node.name);
          if (cell) return cell.value;
        }
        if (this.funcs.has(node.name)) return { __fn: node.name };
        if (node.name in CONSTS) return CONSTS[node.name];
        throw new RunError(`неизвестное имя «${node.name}»`, node.line);
      }
      case 'Index': {
        const ref = await this.arrayValueOf(node, env);
        return ref.container[ref.idx];
      }
      case 'Assign':
        return await this.evalAssign(node, env);
      case 'Cond':
        return (await this.evalExpr(node.cond, env))
          ? await this.evalExpr(node.a, env)
          : await this.evalExpr(node.b, env);
      case 'Seq': {
        let v;
        for (const e of node.exprs) v = await this.evalExpr(e, env);
        return v;
      }
      case 'Unary':
        return await this.evalUnary(node, env);
      case 'Binary':
        return await this.evalBinary(node, env);
      case 'Cast': {
        const v = await this.evalExpr(node.operand, env);
        return wrapValue(node.toType === 'float' ? 'float' : node.toType === 'bool' ? 'bool' : node.toType, v);
      }
      case 'Call':
        return await this.evalCall(node, env);
      case 'Method':
        return await this.evalMethod(node, env);
      default:
        throw new RunError(`неизвестное выражение «${node.type}»`, node.line);
    }
  }

  // Разыменование массива (включая 2D через вложенный Index и m[i, j]).
  async arrayValueOf(node, env) {
    // Возвращает {value, cell, idx, idx2} — value это сам массив/элемент.
    let base = node;
    const idxs = [];
    while (base.type === 'Index') {
      idxs.unshift(Math.trunc(await this.evalExpr(base.idx2 !== null && base.idx2 !== undefined ? base.idx2 : base.idx, env)));
      if (base.idx2 !== null && base.idx2 !== undefined) {
        idxs.unshift(Math.trunc(await this.evalExpr(base.idx, env)));
      }
      base = base.arr;
    }
    if (base.type !== 'Ident') throw new RunError('индексировать можно только массив-переменную', node.line);
    const cell = env.find(base.name);
    if (!cell) throw new RunError(`неизвестное имя «${base.name}»`, node.line);
    if (!cell.array) throw new RunError(`«${base.name}» — не массив`, node.line);
    let container = cell.value;
    for (let k = 0; k < idxs.length - 1; k++) {
      if (!Array.isArray(container)) throw new RunError('слишком много индексов у массива', node.line);
      const ix = idxs[k];
      if (ix < 0 || ix >= container.length) throw new RunError(`индекс [${ix}] вне границ массива «${base.name}» (0..${container.length - 1})`, node.line);
      container = container[ix];
    }
    const last = idxs[idxs.length - 1];
    if (!Array.isArray(container)) throw new RunError('индекс вне границ массива', node.line);
    if (last < 0 || last >= container.length) {
      throw new RunError(`индекс [${last}] вне границ массива «${base.name}» (0..${container.length - 1})`, node.line);
    }
    return { container, idx: last, cell };
  }

  // Ячейка типа массива для isFloatExpr — без вычисления индексов-побочек нельзя,
  // поэтому для индексов считаем по типу ячейки массива.
  arrayCellOf(node, env) {
    let base = node;
    while (base.type === 'Index') base = base.arr;
    if (base.type !== 'Ident') return null;
    const cell = env.find(base.name);
    return cell && cell.array ? cell : null;
  }

  async evalAssign(node, env) {
    const t = node.target;
    let newValue;
    if (t.type === 'Ident') {
      const cell = env.find(t.name);
      if (!cell) throw new RunError(`неизвестное имя «${t.name}»`, node.line);
      const raw = await this.evalExpr(node.value, env);
      newValue = this.coerceFor(cell, raw, node.op);
      if (node.op === '=') {
        // просто присваивание
      }
      cell.value = newValue;
      return newValue;
    }
    if (t.type === 'Index') {
      const ref = await this.arrayValueOf(t, env);
      const elemType = ref.cell.type === 'String' ? 'String' : ref.cell.type;
      const raw = await this.evalExpr(node.value, env);
      newValue = this.coerceFor({ type: elemType, value: ref.container[ref.idx] }, raw, node.op);
      ref.container[ref.idx] = newValue;
      return newValue;
    }
    throw new RunError('нельзя присвоить этому выражению', node.line);
  }

  coerceFor(cell, raw, op) {
    if (cell.type === 'String' || (typeof cell.value === 'string' && (op === '+=' || op === '='))) {
      const s = typeof raw === 'string' ? raw : this.formatValue(raw);
      if (op === '+=') return String(cell.value) + s;
      if (op === '=') return s;
      throw new RunError(`операция «${op}» не поддерживается для String`);
    }
    let cur = cell.value;
    switch (op) {
      case '=': return wrapValue(cell.type, raw);
      case '+=': return wrapValue(cell.type, cur + raw);
      case '-=': return wrapValue(cell.type, cur - raw);
      case '*=': return wrapValue(cell.type, cur * raw);
      case '/=': {
        if (Number(raw) === 0) throw new RunError('деление на ноль');
        return wrapValue(cell.type, cell.type === 'float' ? cur / raw : Math.trunc(cur / raw));
      }
      case '%=': {
        if (Number(raw) === 0) throw new RunError('остаток от деления на ноль');
        return wrapValue(cell.type, Math.trunc(cur % raw));
      }
      case '<<=': return wrapValue(cell.type, (cur | 0) << (raw | 0));
      case '>>=': return wrapValue(cell.type, (cur | 0) >> (raw | 0));
      case '&=': return wrapValue(cell.type, (cur | 0) & (raw | 0));
      case '|=': return wrapValue(cell.type, (cur | 0) | (raw | 0));
      case '^=': return wrapValue(cell.type, (cur | 0) ^ (raw | 0));
      default: throw new RunError(`неизвестный оператор присваивания «${op}»`);
    }
  }

  async evalUnary(node, env) {
    const apply = (v) => {
      switch (node.op) {
        case '-': return -v;
        case '+': return v;
        case '!': return !v;
        case '~': return ~(v | 0);
        case '++': return v + 1;
        case '--': return v - 1;
        default: throw new RunError(`неизвестный унарный оператор «${node.op}»`, node.line);
      }
    };
    if (!node.postfix) {
      const t = node.operand;
      // Немутирующие операции применимы к любому выражению: -170, !flag(), ~маска
      if (node.op === '-' || node.op === '+' || node.op === '!' || node.op === '~') {
        return apply(await this.evalExpr(t, env));
      }
      // ++/-- — только переменная или элемент массива
      if (t.type === 'Ident') {
        const cell = env.find(t.name);
        if (!cell) throw new RunError(`неизвестное имя «${t.name}»`, node.line);
        if (node.op === '!' || node.op === '~') return apply(await this.evalExpr(t, env));
        const nv = wrapValue(cell.type, apply(cell.value));
        cell.value = nv;
        return nv;
      }
      if (t.type === 'Index') {
        const ref = await this.arrayValueOf(t, env);
        if (node.op === '!' || node.op === '~') return apply(ref.container[ref.idx]);
        const nv = wrapValue(ref.cell.type, apply(ref.container[ref.idx]));
        ref.container[ref.idx] = nv;
        return nv;
      }
      throw new RunError('операнд должен быть переменной или элементом массива', node.line);
    }
    // постфиксные ++/--
    const t = node.operand;
    if (t.type === 'Ident') {
      const cell = env.find(t.name);
      if (!cell) throw new RunError(`неизвестное имя «${t.name}»`, node.line);
      const old = cell.value;
      cell.value = wrapValue(cell.type, apply(old));
      return old;
    }
    if (t.type === 'Index') {
      const ref = await this.arrayValueOf(t, env);
      const old = ref.container[ref.idx];
      ref.container[ref.idx] = wrapValue(ref.cell.type, apply(old));
      return old;
    }
    throw new RunError('операнд должен быть переменной или элементом массива', node.line);
  }

  async evalBinary(node, env) {
    const op = node.op;
    if (op === '&&') {
      return (await this.evalExpr(node.l, env)) && (await this.evalExpr(node.r, env));
    }
    if (op === '||') {
      return (await this.evalExpr(node.l, env)) || (await this.evalExpr(node.r, env));
    }
    const lv = await this.evalExpr(node.l, env);
    const rv = await this.evalExpr(node.r, env);
    if (op === '+') {
      if (typeof lv === 'string' || typeof rv === 'string') {
        return (typeof lv === 'string' ? lv : this.formatValue(lv)) +
               (typeof rv === 'string' ? rv : this.formatValue(rv));
      }
      return lv + rv;
    }
    switch (op) {
      case '-': return lv - rv;
      case '*': return lv * rv;
      case '/': {
        if (Number(rv) === 0) throw new RunError('деление на ноль', node.line);
        const isF = this.isFloatExpr(node.l, env) || this.isFloatExpr(node.r, env);
        return isF ? lv / rv : Math.trunc(lv / rv);
      }
      case '%': {
        if (Number(rv) === 0) throw new RunError('остаток от деления на ноль', node.line);
        return Math.trunc(lv) % Math.trunc(rv);
      }
      case '==': return lv === rv;
      case '!=': return lv !== rv;
      case '<': return lv < rv;
      case '>': return lv > rv;
      case '<=': return lv <= rv;
      case '>=': return lv >= rv;
      case '&': return (lv | 0) & (rv | 0);
      case '|': return (lv | 0) | (rv | 0);
      case '^': return (lv | 0) ^ (rv | 0);
      case '<<': return (lv | 0) << (rv | 0);
      case '>>': return (lv | 0) >> (rv | 0);
      default:
        throw new RunError(`неизвестный оператор «${op}»`, node.line);
    }
  }

  async evalCall(node, env) {
    const fn = this.funcs.get(node.name);
    if (fn) {
      const args = [];
      for (const a of node.args) args.push(await this.evalExpr(a, env));
      const ret = await this.callFunction(fn, args);
      return fn.retType === 'float' ? Number(ret) || 0 : ret;
    }

    // Функции «железа»
    const api = this.api;
    switch (node.name) {
      case 'pinMode':
        await api.pinMode(await this.argVal(node, env, 0), await this.argVal(node, env, 1));
        return 0;
      case 'digitalWrite':
        await api.digitalWrite(await this.argVal(node, env, 0), await this.argVal(node, env, 1));
        return 0;
      case 'digitalRead':
        return await api.digitalRead(await this.argVal(node, env, 0));
      case 'analogRead':
        return await api.analogRead(await this.argVal(node, env, 0));
      case 'analogWrite':
        await api.analogWrite(await this.argVal(node, env, 0), await this.argVal(node, env, 1));
        return 0;
      case 'delay':
        await this.delay(await this.argVal(node, env, 0));
        return 0;
      case 'delayMicroseconds':
        await api.delayMicros(await this.argVal(node, env, 0));
        return 0;
      case 'millis':
        return Math.trunc(await api.millis());
      case 'micros':
        return Math.trunc(await api.micros());
      case 'pulseIn':
        return Math.trunc(await api.pulseIn(await this.argVal(node, env, 0), await this.argVal(node, env, 1),
          node.args[2] !== undefined ? await this.argVal(node, env, 2) : 1000000));
      // ── Датчик цвета: RGB отражённого света 0..1023 (первый датчик) ──
      case 'colorReadR':
        return Math.trunc(await api.colorReadR());
      case 'colorReadG':
        return Math.trunc(await api.colorReadG());
      case 'colorReadB':
        return Math.trunc(await api.colorReadB());
      // ── Датчик света: освещённость 0..1023 (первый датчик света) ──
      case 'lightRead':
        return Math.trunc(await api.lightRead());
      case 'attachInterrupt': {
        const fnRef = await this.evalExpr(node.args[1], env);
        if (!fnRef || !fnRef.__fn) throw new RunError('вторым аргументом attachInterrupt нужна функция', node.line);
        await api.attachInterrupt(await this.argVal(node, env, 0), fnRef, await this.argVal(node, env, 2));
        return 0;
      }
      case 'detachInterrupt':
        await api.detachInterrupt(await this.argVal(node, env, 0));
        return 0;
      case 'noInterrupts':
      case 'interrupts':
        return 0;
      case 'randomSeed':
        this.randState = (Math.trunc(await this.argVal(node, env, 0)) || 1) >>> 0;
        return 0;
      case 'random': {
        let lo = 0, hi;
        if (node.args.length >= 2) { lo = await this.argVal(node, env, 0); hi = await this.argVal(node, env, 1); }
        else { hi = await this.argVal(node, env, 0); }
        const r = this.nextRandom();
        return Math.floor(lo + r * (hi - lo));
      }
      // ── Математика (спека §4) ──
      case 'abs': return Math.abs(await this.argVal(node, env, 0));
      case 'min': return Math.min(await this.argVal(node, env, 0), await this.argVal(node, env, 1));
      case 'max': return Math.max(await this.argVal(node, env, 0), await this.argVal(node, env, 1));
      case 'constrain': {
        const x = await this.argVal(node, env, 0);
        const a = await this.argVal(node, env, 1);
        const b = await this.argVal(node, env, 2);
        return Math.min(Math.max(x, a), b);
      }
      case 'map': {
        const x = await this.argVal(node, env, 0);
        const a = await this.argVal(node, env, 1);
        const b = await this.argVal(node, env, 2);
        const c = await this.argVal(node, env, 3);
        const d = await this.argVal(node, env, 4);
        if (b - a === 0) throw new RunError('map(): in_min == in_max', node.line);
        return Math.trunc((x - a) * (d - c) / (b - a)) + c;
      }
      case 'sqrt': return Math.sqrt(await this.argVal(node, env, 0));
      case 'sin': return Math.sin(await this.argVal(node, env, 0));
      case 'cos': return Math.cos(await this.argVal(node, env, 0));
      case 'tan': return Math.tan(await this.argVal(node, env, 0));
      case 'atan2': return Math.atan2(await this.argVal(node, env, 0), await this.argVal(node, env, 1));
      case 'pow': return Math.pow(await this.argVal(node, env, 0), await this.argVal(node, env, 1));
      case 'floor': return Math.floor(await this.argVal(node, env, 0));
      case 'ceil': return Math.ceil(await this.argVal(node, env, 0));
      case 'round': return Math.round(await this.argVal(node, env, 0));
      case 'Serial': throw new RunError('Serial — это объект, а не функция: Serial.print(…)', node.line);
      default:
        throw new RunError(`неизвестная функция «${node.name}()»`, node.line);
    }
  }

  async argVal(node, env, i) {
    if (node.args[i] === undefined) {
      throw new RunError(`в «${node.name}()» не хватает аргумента №${i + 1}`, node.line);
    }
    return await this.evalExpr(node.args[i], env);
  }

  nextRandom() {
    // xorshift32 — детерминированный, с randomSeed
    let x = this.randState;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.randState = x;
    return x / 4294967296;
  }

  async evalMethod(node, env) {
    const obj = await this.evalExpr(node.obj, env);
    const args = [];
    for (const a of node.args) args.push(await this.evalExpr(a, env));

    // String
    if (typeof obj === 'string') {
      switch (node.name) {
        case 'length': return obj.length;
        case 'charAt': return obj.charCodeAt(Math.trunc(args[0])) || 0;
        case 'substring': {
          const a = Math.trunc(args[0]);
          const b = args.length > 1 ? Math.trunc(args[1]) : obj.length;
          return obj.substring(a, b);
        }
        case 'toInt': return Math.trunc(parseFloat(obj)) || 0;
        case 'toFloat': return parseFloat(obj) || 0;
        case 'equals': return obj === String(args[0]);
        case 'startsWith': return obj.startsWith(String(args[0]));
        case 'endsWith': return obj.endsWith(String(args[0]));
        case 'indexOf': return obj.indexOf(String(args[0]));
        case 'trim': return obj.trim();
        case 'toUpperCase': return obj.toUpperCase();
        case 'toLowerCase': return obj.toLowerCase();
        case 'c_str': return obj;
        default:
          throw new RunError(`у String нет метода «${node.name}()»`, node.line);
      }
    }

    if (obj && obj.__kind === 'Serial') {
      switch (node.name) {
        case 'begin': return 0;
        case 'end':
        case 'flush':
          return 0;
        case 'available': return 0;
        case 'read': return -1;
        case 'peek': return -1;
        case 'print':
          this.api.serialPrint(this.formatValue(args[0], args[1]), false);
          return 1;
        case 'println':
          this.api.serialPrint(this.formatValue(args[0], args[1]) + '\n', true);
          return 1;
        case 'write': {
          const v = args[0];
          this.api.serialPrint(typeof v === 'string' ? v : String.fromCharCode(v & 0xFF), false);
          return 1;
        }
        default:
          throw new RunError(`у Serial нет метода «${node.name}()»`, node.line);
      }
    }

    if (obj && obj.__kind === 'Servo') {
      switch (node.name) {
        case 'attach':
          obj.pin = Math.trunc(args[0]);
          await this.api.servoAttach(obj.id, obj.pin);
          return 0;
        case 'write':
          obj.angle = Math.max(0, Math.min(180, Math.trunc(args[0])));
          await this.api.servoWrite(obj.id, obj.angle);
          return 0;
        case 'writeMicroseconds': {
          const us = Math.trunc(args[0]);
          obj.angle = Math.max(0, Math.min(180, Math.round((us - 544) / (2400 - 544) * 180)));
          await this.api.servoWrite(obj.id, obj.angle);
          return 0;
        }
        case 'read': return obj.angle;
        case 'attached': return obj.pin !== null ? 1 : 0;
        case 'detach':
          obj.pin = null;
          await this.api.servoDetach(obj.id);
          return 0;
        default:
          throw new RunError(`у Servo нет метода «${node.name}()»`, node.line);
      }
    }

    throw new RunError('оператор «.» работает только с Servo, Serial и String', node.line);
  }

  formatValue(v, digits) {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number') {
      if (digits !== undefined && digits !== null) return v.toFixed(Math.max(0, Math.min(7, Math.trunc(digits))));
      if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
      const r = Number(v.toFixed(2));
      return String(r);
    }
    return String(v);
  }
}
