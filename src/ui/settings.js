// Настройки: тема (тёмная/светлая), язык (RU/EN), реализм (шумы датчиков,
// проскальзывание моторов), показ панели судейства. Всё сохраняется в localStorage.
import { applyI18n, setLang, getLang, t } from './i18n.js';
import { hideAnimated, showAnimated } from './anim.js';

const LS = {
  theme: 'roboarena3d.theme',
  noise: 'roboarena3d.noise',
  slip: 'roboarena3d.slip',
  judge: 'roboarena3d.judgeHidden',
  telemetry: 'roboarena3d.telemetry',
};

function lsGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* пусто */ }
}

export function installSettings({ app }) {
  const ovl = document.getElementById('settings-overlay');
  const themeSel = document.getElementById('set-theme');
  const langSel = document.getElementById('set-lang');
  const noiseSel = document.getElementById('set-noise');
  const slipSel = document.getElementById('set-slip');

  // ── Тема ──
  function applyTheme(mode) {
    document.documentElement.dataset.theme = mode;
  }
  themeSel.value = lsGet(LS.theme, 'dark');
  applyTheme(themeSel.value);
  themeSel.addEventListener('change', () => {
    applyTheme(themeSel.value);
    lsSet(LS.theme, themeSel.value);
  });

  // ── Язык ──
  langSel.value = getLang();
  langSel.addEventListener('change', () => setLang(langSel.value));

  // ── Реализм ──
  const noise = parseInt(lsGet(LS.noise, '0'), 10) || 0;
  if (app.sensors) app.sensors.noiseLevel = noise;
  noiseSel.value = String(noise);
  noiseSel.addEventListener('change', () => {
    const v = parseInt(noiseSel.value, 10) || 0;
    if (app.sensors) app.sensors.noiseLevel = v;
    lsSet(LS.noise, String(v));
  });

  const slip = parseInt(lsGet(LS.slip, '0'), 10) || 0;
  if (app.robot) app.robot.slipLevel = slip;
  slipSel.value = String(slip);
  slipSel.addEventListener('change', () => {
    const v = parseInt(slipSel.value, 10) || 0;
    if (app.robot) app.robot.slipLevel = v;
    lsSet(LS.slip, String(v));
  });

  // ── Судейство: показать/скрыть (кнопка-глаз в тулбаре) ──
  const judge = document.getElementById('judge');
  const eyeBtn = document.getElementById('btn-judge-eye');
  const eyeUse = eyeBtn ? eyeBtn.querySelector('use') : null;
  function applyJudge(hidden) {
    judge.style.display = hidden ? 'none' : 'block';
    eyeBtn.classList.toggle('off', hidden);
    // ПН10-3: у судейства своя кнопка-глаз (не кнопка кода!) и её состояние
    // сохраняется между запусками. Раньше скрытое состояние было заметно только
    // лёгким затемнением — путали со скрытием кода. Теперь иконка честно
    // переключается на перечёркнутый глаз.
    if (eyeUse) eyeUse.setAttribute('href', hidden ? '#i-eye-off' : '#i-eye');
  }
  applyJudge(lsGet(LS.judge, '0') === '1');
  eyeBtn.addEventListener('click', () => {
    const hidden = judge.style.display !== 'none';
    if (hidden) hideAnimated(judge);
    else showAnimated(judge);
    applyJudge(hidden);
    lsSet(LS.judge, hidden ? '1' : '0');
  });

  // ── Телеметрия: показать/скрыть (кнопка-график в тулбаре) ──
  const tele = document.getElementById('telemetry');
  const teleBtn = document.getElementById('btn-telemetry-eye');
  function applyTele(hidden) {
    tele.style.display = hidden ? 'none' : 'block';
    teleBtn.classList.toggle('off', hidden);
  }
  applyTele(lsGet(LS.telemetry, '0') === '1');
  teleBtn.addEventListener('click', () => {
    const hidden = tele.style.display !== 'none';
    if (hidden) hideAnimated(tele);
    else showAnimated(tele);
    applyTele(hidden);
    lsSet(LS.telemetry, hidden ? '1' : '0');
  });

  // ── Оверлей ──
  document.getElementById('btn-settings').addEventListener('click', () => ovl.classList.add('open'));
  for (const btn of ovl.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => hideAnimated(ovl));
  }

  // применить словарь к текущей разметке (первичный запуск)
  applyI18n(getLang());
  void t;
}
