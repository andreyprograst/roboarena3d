// Н8-4: анимированные выпадающие списки тулбара («полигоны» и «скорость»).
// Нативный <select> остаётся в DOM источником истины (value, disabled,
// прежние обработчики change), но скрывается: вместо него кнопка с подписью
// и анимированное меню. Нативные <option> браузер рисует сам — их анимировать
// нельзя, поэтому список строим из опций select при каждом ОТКРЫТИИ: подписи,
// переведённые сменой языка (data-i18n на option), подхватываются автоматически.
import { showAnimated, hideAnimated } from './anim.js';

export function makeDropdown(selectEl) {
  const wrap = document.createElement('span');
  wrap.className = 'dd';
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);
  selectEl.classList.add('dd-src'); // сам select больше не виден

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  btn.innerHTML = '<span class="dd-label"></span><span class="dd-arrow">▾</span>';
  wrap.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  wrap.appendChild(menu);

  let open = false;

  const syncBtn = () => {
    const o = selectEl.selectedOptions[0];
    btn.querySelector('.dd-label').textContent = o ? o.textContent : '';
    btn.disabled = selectEl.disabled;
    btn.classList.toggle('open', open);
  };

  function buildMenu() {
    menu.innerHTML = '';
    for (const o of selectEl.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-opt' + (o.selected ? ' sel' : '');
      b.textContent = o.textContent;
      b.addEventListener('click', () => {
        if (selectEl.value !== o.value) {
          selectEl.value = o.value;
          // обработчик change выполняется синхронно и может ОТКАТИТЬ значение
          // (арена «не готова») — подпись обновляем уже после него
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        close();
        syncBtn();
      });
      menu.appendChild(b);
    }
  }

  function openMenu() {
    if (open || selectEl.disabled) return;
    // один открытый дропдаун за раз
    document.querySelectorAll('.dd-menu').forEach((m) => {
      if (m !== menu && m._ddClose) m._ddClose();
    });
    buildMenu();
    showAnimated(menu);
    open = true;
    syncBtn();
  }
  function close() {
    if (!open) return;
    open = false;
    hideAnimated(menu, 200);
    syncBtn();
  }
  menu._ddClose = close;

  btn.addEventListener('click', () => (open ? close() : openMenu()));
  // клик мимо списка — закрыть
  document.addEventListener('pointerdown', (e) => {
    if (open && !wrap.contains(e.target)) close();
  });
  // Esc — закрыть список первым (не задевая горячие клавиши редакторов)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) { close(); e.stopPropagation(); }
  }, true);

  // syncEditMode переключает select.disabled — отражаем на кнопке
  new MutationObserver(syncBtn).observe(selectEl, { attributes: true, attributeFilter: ['disabled'] });
  // подписи опций переводятся сменой языка — следим и за текстом
  new MutationObserver(syncBtn).observe(selectEl, { subtree: true, childList: true, characterData: true });
  selectEl.addEventListener('change', syncBtn);
  syncBtn();
}
