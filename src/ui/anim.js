// Плавное появление/уход панелей и оверлеев (просьба «анимации ко всему меню»).
//
// Появление уже работает через CSS-анимации на самих элементах: при смене
// display:none → block браузер проигрывает animation заново. А вот уход
// требует класса .closing (CSS-анимация «наружу») и скрытия ПОСЛЕ её конца —
// этим и занимается hideAnimated().
//
// Гонка «закрыл и тут же открыл»: showAnimated() инкрементирует токен
// скрытия, и отложенный finishHide устаревшего вызова ничего не прячет.
//
// Использование: hideAnimated(overlayOrPanel). Для .overlay также снимает
// класс .open; для панелей ставит style.display='none'. Уважает
// prefers-reduced-motion: скрывает мгновенно.

const reduced = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function hideAnimated(el, ms = 240) {
  if (!el) return;
  if (reduced()) {
    el._hideSeq = (el._hideSeq || 0) + 1;
    finishHide(el, el._hideSeq);
    return;
  }
  // уже скрывается — текущая анимация сама доиграет до скрытия
  if (el.classList.contains('closing')) return;
  const token = (el._hideSeq = (el._hideSeq || 0) + 1);
  el.classList.add('closing');
  let done = false;
  const onEnd = () => {
    if (done) return;
    done = true;
    el.removeEventListener('animationend', onEnd);
    finishHide(el, token);
  };
  el.addEventListener('animationend', onEnd);
  setTimeout(onEnd, ms); // страховка: animationend может не прийти (вкладка в фоне)
}

function finishHide(el, token) {
  if (el._hideSeq !== token) return; // элемент заново открыли — не трогаем
  el.classList.remove('closing');
  el.classList.remove('open');
  if (el.style.display && el.style.display !== 'none') el.style.display = 'none';
}

// Принудительно показать элемент (для вызова после hideAnimated): снимает
// .closing, инкрементирует токен (гасит отложенное скрытие) и ставит display —
// появление доиграет обычная CSS-анимация входа.
export function showAnimated(el, display = 'block') {
  if (!el) return;
  el._hideSeq = (el._hideSeq || 0) + 1;
  el.classList.remove('closing');
  el.style.display = display;
}
