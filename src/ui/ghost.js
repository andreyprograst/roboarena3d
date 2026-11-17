// Призрак перетаскивания карточки из окна добавления на вьюпорт (просьба 7).
//
// startGhostDrag(e, label, onDrop, onMove): нажали на карточку — тянем; за
// курсором плывёт подписанный «призрак». Отпускание вызывает onDrop(event) —
// редактор сам решает, что с точкой делать (луч в сцену → создать объект там).
// onMove(event) — необязательный хук Н9-8: на каждый ход мыши редактор
// двигает 3D-призрак объекта по полу, чтобы было видно, куда он встанет.
//
// Обычный клик (без движения > 6px) ничего не создаёт через призрак —
// работает прежний обработчик click. А click, пришедший ПОСЛЕ реального
// драга (отпустили над карточкой), подавляется через ghostAteClick(),
// иначе объект создался бы дважды: раз из onDrop, раз из click.

let ghost = null;
let eaten = false;

export function ghostAteClick() {
  return eaten;
}

function move(e) {
  if (!ghost) return;
  if (!ghost.moved) {
    if (Math.hypot(e.clientX - ghost.sx, e.clientY - ghost.sy) < 6) return;
    ghost.moved = true;
    ghost.el.style.display = 'block';
  }
  ghost.el.style.left = e.clientX + 12 + 'px';
  ghost.el.style.top = e.clientY + 12 + 'px';
  if (ghost.onMove) ghost.onMove(e);
}

function end(e) {
  if (!ghost) return;
  const g = ghost;
  ghost = null;
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', end);
  window.removeEventListener('pointercancel', end);
  window.removeEventListener('blur', end);
  g.el.remove();
  if (g.onMove) g.onMove(null); // спрятать 3D-призрак
  if (g.moved && e) {
    eaten = true;
    setTimeout(() => { eaten = false; }, 0); // click придёт раньше этого таймера
    g.onDrop(e);
  }
}

export function startGhostDrag(e, label, onDrop, onMove) {
  if (ghost) end(null); // предыдущий призрак не доехал — убрать
  if (e.button !== 0) return;
  const el = document.createElement('div');
  el.className = 'drag-ghost';
  el.style.display = 'none';
  el.textContent = label;
  document.body.appendChild(el);
  ghost = { el, sx: e.clientX, sy: e.clientY, moved: false, onDrop, onMove };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', end); // отпустили за окном — убрать призрак
}
