// Интерфейс аккаунта: чип в тулбаре + оверлей «вход / регистрация / профиль».
// Вся модель данных — в src/account/accounts.js (localStorage, без сервера).
// Разметка оверлея статична в index.html (data-i18n), здесь — поведение и
// динамические части (профиль, список участников, сообщения).
import {
  register, login, logout, currentUser, renameUser, deleteAccount,
  findClass, classMembers, listAccounts, saveWorkspace, loadWorkspace,
  initials,
} from '../account/accounts.js';
import { t, getLang } from './i18n.js';
import { hideAnimated } from './anim.js';

const $ = (id) => document.getElementById(id);

export function installAccount({ app }) {
  const overlay = $('account-overlay');
  const chip = $('btn-account');
  if (!overlay || !chip) return { refresh() {} }; // разметка не подключена — тихо выходим

  const el = {
    avatar: $('ac-avatar'), name: $('ac-name'), role: $('ac-role'),
    auth: $('ac-auth'), profile: $('ac-profile'),
    tabLogin: $('ac-tab-login'), tabReg: $('ac-tab-register'),
    loginForm: $('ac-login-form'), regForm: $('ac-reg-form'),
    loginLogin: $('ac-login-login'), loginPass: $('ac-login-pass'), loginErr: $('ac-login-err'),
    rolePick: $('ac-role-pick'),
    regName: $('ac-reg-name'), regLogin: $('ac-reg-login'), regPass: $('ac-reg-pass'),
    regCodeWrap: $('ac-reg-classcode-wrap'), regCode: $('ac-reg-classcode'),
    regClassNameWrap: $('ac-reg-classname-wrap'), regClassName: $('ac-reg-classname'),
    regErr: $('ac-reg-err'), guest: $('ac-guest'),
    pAvatar: $('ac-p-avatar'), pName: $('ac-p-name'), pLogin: $('ac-p-login'), pRole: $('ac-p-role'),
    pClassBody: $('ac-p-class-body'), pStats: $('ac-p-stats'),
    saveWs: $('ac-save-ws'), loadWs: $('ac-load-ws'),
    editName: $('ac-edit-name'), logoutBtn: $('ac-logout'), deleteBtn: $('ac-delete'),
    profileMsg: $('ac-profile-msg'),
  };

  let regRole = 'solo';

  // ── Локализованные сообщения об ошибках ──
  const errText = (code) => t('acc.err.' + code) || code;
  function setErr(node, code) {
    if (!node) return;
    node.textContent = code ? errText(code) : '';
    node.classList.toggle('show', !!code);
  }
  function setMsg(node, key, ok) {
    if (!node) return;
    node.textContent = key ? t(key) : '';
    node.classList.toggle('show', !!key);
    node.classList.toggle('ok', !!ok);
  }

  // ── Чип в тулбаре ──
  function refreshChip() {
    const u = currentUser();
    if (u) {
      el.avatar.textContent = initials(u.name);
      el.name.textContent = u.name;
      el.role.textContent = t('acc.role.' + u.role);
      chip.dataset.role = u.role;
      chip.classList.add('signed');
      chip.title = t('acc.profile.title') + ' — ' + u.name;
    } else {
      el.avatar.textContent = '';
      el.avatar.innerHTML = '<svg><use href="#i-user"/></svg>';
      el.name.textContent = t('acc.guest');
      el.role.textContent = t('acc.signin');
      chip.dataset.role = 'guest';
      chip.classList.remove('signed');
      chip.title = t('tt.account');
    }
  }

  // ── Открытие/закрытие оверлея ──
  function open() {
    overlay.classList.add('open');
    overlay.style.display = '';
    if (currentUser()) showProfile();
    else showAuth('login');
  }
  function close() { hideAnimated(overlay); }

  function showAuth(tab) {
    el.profile.style.display = 'none';
    el.auth.style.display = '';
    setTab(tab || 'login');
    setErr(el.loginErr, ''); setErr(el.regErr, '');
  }
  function setTab(tab) {
    const isLogin = tab !== 'register';
    el.tabLogin.classList.toggle('sel', isLogin);
    el.tabReg.classList.toggle('sel', !isLogin);
    el.loginForm.style.display = isLogin ? '' : 'none';
    el.regForm.style.display = isLogin ? 'none' : '';
    setTimeout(() => { (isLogin ? el.loginLogin : el.regName)?.focus(); }, 40);
  }
  function setRole(role) {
    regRole = role;
    for (const b of el.rolePick.querySelectorAll('[data-role]')) {
      b.classList.toggle('sel', b.dataset.role === role);
    }
    el.regCodeWrap.style.display = role === 'student' ? '' : 'none';
    el.regClassNameWrap.style.display = role === 'teacher' ? '' : 'none';
    setErr(el.regErr, '');
  }

  // ── Профиль ──
  function showProfile() {
    const u = currentUser();
    if (!u) { showAuth('login'); return; }
    el.auth.style.display = 'none';
    el.profile.style.display = '';
    el.pAvatar.textContent = initials(u.name);
    el.pAvatar.dataset.role = u.role;
    el.pName.textContent = u.name;
    el.pLogin.textContent = '@' + u.login;
    el.pRole.textContent = t('acc.role.' + u.role);
    el.pRole.dataset.role = u.role;
    renderClass(u);
    renderStats(u);
    setMsg(el.profileMsg, '', false);
  }

  function renderClass(u) {
    const body = el.pClassBody;
    body.innerHTML = '';
    if (u.role === 'solo' || !u.classCode) {
      const p = document.createElement('p');
      p.className = 'ac-muted';
      p.textContent = t('acc.profile.solo');
      body.appendChild(p);
      return;
    }
    const cls = findClass(u.classCode);
    const name = document.createElement('div');
    name.className = 'ac-class-name';
    name.textContent = cls ? cls.name : u.classCode;
    body.appendChild(name);

    // Код класса (для руководителя — с кнопкой копирования)
    const codeRow = document.createElement('div');
    codeRow.className = 'ac-code-row';
    const codeLbl = document.createElement('span');
    codeLbl.className = 'ac-muted';
    codeLbl.textContent = t('acc.profile.code') + ':';
    const codeVal = document.createElement('b');
    codeVal.className = 'ac-code';
    codeVal.textContent = u.classCode;
    codeRow.append(codeLbl, codeVal);
    if (u.role === 'teacher') {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ac-mini';
      copy.innerHTML = '<svg><use href="#i-copy"/></svg>';
      copy.title = t('acc.profile.copy');
      copy.addEventListener('click', () => copyCode(u.classCode));
      codeRow.appendChild(copy);
    }
    body.appendChild(codeRow);

    if (u.role === 'teacher') {
      const hint = document.createElement('p');
      hint.className = 'ac-muted ac-hint';
      hint.textContent = t('acc.profile.share');
      body.appendChild(hint);
      // Список участников
      const members = classMembers(u.classCode);
      const head = document.createElement('div');
      head.className = 'ac-roster-head';
      head.textContent = t('acc.profile.members') + ' — ' + members.length;
      body.appendChild(head);
      const list = document.createElement('div');
      list.className = 'ac-roster';
      const accounts = listAccounts();
      for (const m of members) {
        const row = document.createElement('div');
        row.className = 'ac-roster-row';
        const av = document.createElement('span');
        av.className = 'ac-avatar sm';
        av.textContent = initials(m.name);
        const meta = document.createElement('span');
        meta.className = 'ac-roster-meta';
        const nm = document.createElement('b');
        nm.textContent = m.name;
        const lg = document.createElement('span');
        lg.className = 'ac-muted';
        lg.textContent = '@' + m.login;
        meta.append(nm, lg);
        row.append(av, meta);
        if (cls && cls.ownerId === m.id) {
          const crown = document.createElement('span');
          crown.className = 'ac-crown';
          crown.title = t('acc.profile.owner');
          crown.innerHTML = '<svg><use href="#i-crown"/></svg>';
          row.appendChild(crown);
        }
        list.appendChild(row);
      }
      body.appendChild(list);
      void accounts;
    } else {
      // Участник: покажем руководителя, если он есть
      const accounts = listAccounts();
      const owner = cls && cls.ownerId ? accounts.find((a) => a.id === cls.ownerId) : null;
      if (owner) {
        const p = document.createElement('p');
        p.className = 'ac-muted ac-hint';
        p.textContent = t('acc.profile.teacher') + ': ' + owner.name;
        body.appendChild(p);
      }
    }
  }

  function renderStats(u) {
    const w = loadWorkspace(u.id);
    const stats = el.pStats;
    stats.innerHTML = '';
    const mk = (label, value) => {
      const d = document.createElement('div');
      d.className = 'ac-stat';
      const l = document.createElement('span');
      l.className = 'ac-muted';
      l.textContent = label;
      const v = document.createElement('b');
      v.textContent = value;
      d.append(l, v);
      return d;
    };
    if (w && w.sketch != null) {
      const lines = String(w.sketch).split('\n').length;
      const loc = getLang() === 'en' ? 'en-US' : 'ru-RU';
      const when = w.savedAt ? new Date(w.savedAt).toLocaleString(loc, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      stats.append(
        mk(t('acc.profile.saved'), when),
        mk(t('acc.profile.arena'), w.arena || '—'),
        mk(t('acc.profile.lines'), String(lines)),
      );
    } else {
      const p = document.createElement('p');
      p.className = 'ac-muted';
      p.textContent = t('acc.profile.nosave');
      stats.appendChild(p);
    }
  }

  // ── Рабочая область: сохранить / загрузить ──
  function captureWorkspace() {
    return {
      sketch: app.editor ? app.editor.getValue() : '',
      arena: app.arena ? app.arena.name : 'sandbox',
    };
  }
  function applyWorkspace(w) {
    if (!w) return false;
    const stopBtn = $('btn-stop');
    if (stopBtn && !stopBtn.disabled) stopBtn.click();
    if (typeof w.sketch === 'string' && app.editor) {
      app.editor.setValue(w.sketch);
    }
    if (w.arena) {
      const sel = $('arena-select');
      if (sel && Array.from(sel.options).some((o) => o.value === w.arena) && sel.value !== w.arena) {
        sel.value = w.arena;
        sel.dispatchEvent(new Event('change'));
      }
    }
    return true;
  }
  function saveCurrent() {
    const u = currentUser();
    if (!u) return;
    saveWorkspace(u.id, captureWorkspace());
  }

  async function copyCode(code) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      setMsg(el.profileMsg, 'acc.profile.copied', true);
    } catch {
      setMsg(el.profileMsg, 'acc.profile.copyfail', false);
    }
  }

  // ── Обработчики ──
  chip.addEventListener('click', open);
  for (const b of overlay.querySelectorAll('[data-close="account-overlay"]')) {
    b.addEventListener('click', close);
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  el.tabLogin.addEventListener('click', () => setTab('login'));
  el.tabReg.addEventListener('click', () => setTab('register'));
  for (const b of el.rolePick.querySelectorAll('[data-role]')) {
    b.addEventListener('click', () => setRole(b.dataset.role));
  }

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setErr(el.loginErr, '');
    const res = await login(el.loginLogin.value, el.loginPass.value);
    if (!res.ok) { setErr(el.loginErr, res.error); return; }
    el.loginPass.value = '';
    applyWorkspace(loadWorkspace(res.user.id));
    refreshChip();
    showProfile();
  });

  el.regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setErr(el.regErr, '');
    const res = await register({
      name: el.regName.value,
      login: el.regLogin.value,
      password: el.regPass.value,
      role: regRole,
      classCode: el.regCode.value,
      className: el.regClassName.value,
    });
    if (!res.ok) { setErr(el.regErr, res.error); return; }
    el.regPass.value = '';
    refreshChip();
    showProfile();
    if (res.class && regRole === 'teacher') setMsg(el.profileMsg, 'acc.profile.created', true);
  });

  el.guest.addEventListener('click', close);

  el.saveWs.addEventListener('click', () => {
    saveCurrent();
    const u = currentUser();
    if (u) renderStats(u);
    setMsg(el.profileMsg, 'acc.profile.savedok', true);
  });
  el.loadWs.addEventListener('click', () => {
    const u = currentUser();
    if (!u) return;
    const w = loadWorkspace(u.id);
    if (applyWorkspace(w)) setMsg(el.profileMsg, 'acc.profile.loadedok', true);
    else setMsg(el.profileMsg, 'acc.profile.nosave', false);
  });

  el.editName.addEventListener('click', () => {
    const u = currentUser();
    if (!u) return;
    const nm = window.prompt(t('acc.profile.renameprompt'), u.name);
    if (nm == null) return;
    const res = renameUser(u.id, nm);
    if (!res.ok) { setMsg(el.profileMsg, 'acc.err.name', false); return; }
    refreshChip();
    showProfile();
  });

  el.logoutBtn.addEventListener('click', () => {
    saveCurrent();
    logout();
    refreshChip();
    showAuth('login');
  });

  el.deleteBtn.addEventListener('click', () => {
    const u = currentUser();
    if (!u) return;
    if (!window.confirm(t('acc.profile.deleteconfirm'))) return;
    deleteAccount(u.id);
    refreshChip();
    showAuth('register');
  });

  // Сохраняем работу при уходе со страницы (если вошли).
  window.addEventListener('beforeunload', saveCurrent);

  // Первичная отрисовка чипа.
  refreshChip();

  return {
    refresh() { refreshChip(); if (overlay.classList.contains('open') && currentUser()) showProfile(); },
    open, close,
    currentUser,
  };
}