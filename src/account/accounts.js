// Аккаунты РобоАрены — клиентская модель пользователей и классов.
//
// Почему без сервера: приложение работает и локально (py server.py — чистая
// статика), и на статическом хостинге. Чтобы регистрация/вход/классы работали
// одинаково в обоих режимах и не ломались офлайн, всё хранится в localStorage
// этого браузера. Пароли не лежат открытым текстом: соль + SHA-256 (Web Crypto),
// с запасным хешем, если subtle недоступен. Классы тоже локальные: руководитель
// создаёт класс и получает код, участники регистрируются по этому коду на этом
// же устройстве (учебный класс за одной машиной / общий лабораторный компьютер).
//
// Роли:
//   solo    — отдельный пользователь (без класса);
//   student — участник класса (регистрация по коду);
//   teacher — руководитель (создаёт класс, видит список участников и код).
//
// Модуль НЕ трогает DOM — только данные. Интерфейс живёт в src/ui/account.js.

const K = {
  accounts: 'roboarena3d.accounts',
  classes: 'roboarena3d.classes',
  session: 'roboarena3d.session',
  userdata: (id) => 'roboarena3d.userdata.' + id,
};

// ── Низкоуровневое хранилище (безопасный JSON) ──
function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch { return false; } // переполнение квоты — не роняем приложение
}

function uid(prefix) {
  const rnd = (crypto && crypto.getRandomValues)
    ? Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return prefix + '_' + rnd;
}

// Код класса: 6 символов из алфавита без похожих знаков (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeClassCode(classes) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    const buf = (crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(6)) : null;
    for (let i = 0; i < 6; i++) {
      const n = buf ? buf[i] : Math.floor(Math.random() * 256);
      code += CODE_ALPHABET[n % CODE_ALPHABET.length];
    }
    if (!classes.some((c) => c.code === code)) return code;
  }
  return 'C' + Date.now().toString(36).toUpperCase().slice(-5); // крайне маловероятный запасной путь
}

// ── Хеширование пароля: соль + SHA-256, запасной FNV-1a ──
function makeSalt() {
  if (crypto && crypto.getRandomValues) {
    return Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}
async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(String(salt) + ':' + String(password));
  if (crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', data);
      return 'sha256:' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch { /* перейдём к запасному */ }
  }
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 16777619); }
  return 'fnv:' + (h >>> 0).toString(16);
}

// ── Реестры ──
export function listAccounts() {
  const a = read(K.accounts, []);
  return Array.isArray(a) ? a : [];
}
export function listClasses() {
  const c = read(K.classes, []);
  return Array.isArray(c) ? c : [];
}
function saveAccounts(a) { return write(K.accounts, a); }
function saveClasses(c) { return write(K.classes, c); }

const normLogin = (s) => String(s || '').trim().toLowerCase();

export function findAccount(login) {
  const l = normLogin(login);
  return listAccounts().find((a) => a.loginKey === l) || null;
}
export function findClass(code) {
  const c = String(code || '').trim().toUpperCase();
  return listClasses().find((x) => x.code === c) || null;
}
export function classMembers(code) {
  const c = String(code || '').trim().toUpperCase();
  return listAccounts().filter((a) => a.classCode === c);
}

// Публичные данные пользователя (без соли/хеша) — для интерфейса.
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, login: u.login, role: u.role,
    classCode: u.classCode || null, createdAt: u.createdAt,
  };
}

// ── Валидация ──
const LOGIN_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
function validateBase(name, login, password) {
  const nm = String(name || '').trim();
  const lg = String(login || '').trim();
  const pw = String(password || '');
  if (nm.length < 1 || nm.length > 40) return { error: 'name' };
  if (!LOGIN_RE.test(lg)) return { error: 'login' };
  if (pw.length < 4 || pw.length > 64) return { error: 'password' };
  if (findAccount(lg)) return { error: 'taken' };
  return { name: nm, login: lg, password: pw };
}

// ── Регистрация ──
// role: 'solo' | 'student' | 'teacher'. Для student нужен classCode,
// для teacher — className. Возвращает { ok, user } либо { ok:false, error }.
export async function register({ name, login, password, role, classCode, className }) {
  const base = validateBase(name, login, password);
  if (base.error) return { ok: false, error: base.error };
  const r = (role === 'student' || role === 'teacher') ? role : 'solo';

  let cls = null;
  if (r === 'student') {
    cls = findClass(classCode);
    if (!cls) return { ok: false, error: 'nocode' };
  }

  const accounts = listAccounts();
  const classes = listClasses();
  const salt = makeSalt();
  const passHash = await hashPassword(base.password, salt);
  const now = Date.now();

  if (r === 'teacher') {
    const cn = String(className || '').trim();
    if (cn.length < 1 || cn.length > 40) return { ok: false, error: 'classname' };
    cls = {
      code: makeClassCode(classes),
      name: cn,
      ownerId: null, // проставим ниже
      createdAt: now,
    };
    classes.push(cls);
  }

  const user = {
    id: uid('u'),
    name: base.name,
    login: base.login,
    loginKey: normLogin(base.login),
    role: r,
    classCode: cls ? cls.code : null,
    salt,
    passHash,
    createdAt: now,
  };
  if (r === 'teacher' && cls) cls.ownerId = user.id;

  accounts.push(user);
  const okA = saveAccounts(accounts);
  const okC = r === 'teacher' ? saveClasses(classes) : true;
  if (!okA || !okC) return { ok: false, error: 'storage' };

  setSession(user.id);
  return { ok: true, user: publicUser(user), class: cls ? { code: cls.code, name: cls.name } : null };
}

// ── Вход / выход / сессия ──
export async function login(loginName, password) {
  const u = findAccount(loginName);
  if (!u) return { ok: false, error: 'nouser' };
  const h = await hashPassword(String(password || ''), u.salt);
  if (h !== u.passHash) return { ok: false, error: 'badpass' };
  setSession(u.id);
  return { ok: true, user: publicUser(u) };
}
export function setSession(id) { write(K.session, id || null); }
export function logout() { write(K.session, null); }
export function currentUser() {
  const id = read(K.session, null);
  if (!id) return null;
  const u = listAccounts().find((a) => a.id === id);
  return u ? publicUser(u) : null;
}

// ── Профиль ──
export function renameUser(id, newName) {
  const nm = String(newName || '').trim();
  if (nm.length < 1 || nm.length > 40) return { ok: false, error: 'name' };
  const accounts = listAccounts();
  const u = accounts.find((a) => a.id === id);
  if (!u) return { ok: false, error: 'nouser' };
  u.name = nm;
  saveAccounts(accounts);
  return { ok: true, user: publicUser(u) };
}
export function deleteAccount(id) {
  const accounts = listAccounts();
  const u = accounts.find((a) => a.id === id);
  if (!u) return { ok: false };
  // Руководитель удаляется вместе со своим классом? Нет: класс остаётся,
  // участники не теряются — просто ownerId обнуляется. Сам аккаунт и его
  // рабочая область стираются.
  const classes = listClasses();
  let changedClasses = false;
  for (const c of classes) {
    if (c.ownerId === id) { c.ownerId = null; changedClasses = true; }
  }
  const next = accounts.filter((a) => a.id !== id);
  saveAccounts(next);
  if (changedClasses) saveClasses(classes);
  try { localStorage.removeItem(K.userdata(id)); } catch { /* пусто */ }
  if (read(K.session, null) === id) logout();
  return { ok: true };
}

// ── Рабочая область аккаунта (скетч + арена) ──
export function saveWorkspace(id, data) {
  if (!id) return false;
  const prev = read(K.userdata(id), {});
  const next = {
    sketch: typeof data.sketch === 'string' ? data.sketch : prev.sketch,
    arena: typeof data.arena === 'string' ? data.arena : prev.arena,
    savedAt: Date.now(),
  };
  return write(K.userdata(id), next);
}
export function loadWorkspace(id) {
  if (!id) return null;
  const w = read(K.userdata(id), null);
  return w && typeof w === 'object' ? w : null;
}

// Инициалы для аватара (1–2 буквы из имени).
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const second = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || '');
  return (first + second).toUpperCase();
}