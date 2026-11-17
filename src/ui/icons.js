// Мини-«3D-картинки» для выбора деталей и препятствий: изометрические
// SVG-иконки, чтобы выбор читался как в 3D-редакторе, а не списком слов.
// Все функции возвращают строку <svg>…</svg> (viewBox 40×34).

function shade(hex, f) {
  // '#rrggbb' → затемнение/осветление: f<1 темнее, f>1 светлее
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = ch(((n >> 16) & 255) * f), g = ch(((n >> 8) & 255) * f), b = ch((n & 255) * f);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

const svgWrap = (inner) => `<svg viewBox="0 0 40 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;

// Изометрический брусок: верхняя грань светлее, левая темнее
export function isoBox(color = '#9aa2b1') {
  const top = shade(color, 1.25), left = shade(color, 0.72), right = color;
  return svgWrap(`
    <path d="M20 3 L34 10 L20 17 L6 10 Z" fill="${top}"/>
    <path d="M6 10 L20 17 L20 31 L6 24 Z" fill="${left}"/>
    <path d="M34 10 L20 17 L20 31 L34 24 Z" fill="${right}"/>
    <path d="M20 3 L34 10 L20 17 L6 10 Z" fill="none" stroke="rgba(0,0,0,.25)" stroke-width=".8"/>`);
}

// Изометрический цилиндр: тело из двух половин (левая темнее), крышка сверху
export function isoCyl(color = '#9aa2b1') {
  const top = shade(color, 1.25), right = color, left = shade(color, 0.72);
  return svgWrap(`
    <path d="M6 8 L6 24 A14 5 0 0 0 20 29 L20 8 Z" fill="${left}"/>
    <path d="M20 8 L20 29 A14 5 0 0 0 34 24 L34 8 Z" fill="${right}"/>
    <ellipse cx="20" cy="8" rx="14" ry="5" fill="${top}" stroke="rgba(0,0,0,.25)" stroke-width=".8"/>`);
}

// Конус: силуэт + тёмная правая половина + нижняя кромка основания
export function isoCone(color = '#d95f2b') {
  const side = color, dark = shade(color, 0.7);
  return svgWrap(`
    <path d="M20 4 L34 26 A14 5 0 0 1 6 26 Z" fill="${side}"/>
    <path d="M20 4 L34 26 A14 5 0 0 1 20 31 Z" fill="${dark}"/>
    <path d="M20 4 L34 26 A14 5 0 0 1 6 26" fill="none" stroke="rgba(0,0,0,.25)" stroke-width=".8"/>`);
}

// Шар: радиальный градиент (блик слева сверху → тень по краю)
export function isoBall(color = '#c9564c') {
  const uid = 'b' + Math.random().toString(36).slice(2, 8);
  return svgWrap(`
    <defs><radialGradient id="${uid}" cx="0.35" cy="0.3" r="0.95">
      <stop offset="0" stop-color="${shade(color, 1.55)}"/>
      <stop offset="0.55" stop-color="${color}"/>
      <stop offset="1" stop-color="${shade(color, 0.55)}"/>
    </radialGradient></defs>
    <circle cx="20" cy="17" r="14" fill="url(#${uid})"/>`);
}

// Клин (рампа): наклонная грань сверху, тёмные боковые треугольники.
// Высокое ребро сзади, скат к переднему нижнему краю.
export function isoWedge(color = '#7d8494') {
  const slope = shade(color, 1.22), side = color, dark = shade(color, 0.66);
  return svgWrap(`
    <path d="M20 4 L34 11 L20 32 L6 25 Z" fill="${slope}"/>
    <path d="M34 11 L34 25 L20 32 Z" fill="${side}"/>
    <path d="M20 4 L6 11 L6 25 Z" fill="${dark}"/>
    <path d="M20 4 L34 11 L20 32 L6 25 Z" fill="none" stroke="rgba(0,0,0,.22)" stroke-width=".8"/>`);
}

// Плоские пиктограммы устройств (строка «добавить устройство» в редакторе робота)
export function devIcon(type, color) {
  const s = (x, y, w, h, fill, rx = 1.5) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"/>`;
  const c = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
  let inner = '';
  if (type === 'line') {
    inner = s(8, 8, 24, 10, '#1c2026') + c(13, 13, 2.2, color) + c(20, 13, 2.2, color) + c(27, 13, 2.2, color) + s(10, 20, 3, 7, '#8b96a5') + s(27, 20, 3, 7, '#8b96a5');
  } else if (type === 'sonar') {
    inner = s(6, 9, 28, 12, '#1d5e46') + c(14, 15, 3.4, '#20242c') + c(26, 15, 3.4, '#20242c') + s(10, 22, 3, 5, '#8b96a5') + s(27, 22, 3, 5, '#8b96a5');
  } else if (type === 'bumper') {
    inner = s(5, 12, 30, 7, color, 3) + s(8, 19, 4, 6, '#8b96a5') + s(28, 19, 4, 6, '#8b96a5');
  } else if (type === 'servo') {
    inner = s(10, 7, 20, 16, '#1a3a6b') + s(7, 5, 26, 4, '#16305a') + c(20, 5, 3.4, '#f2f4f8') + s(18, 2, 4, 4, '#f2f4f8');
  } else if (type === 'color') {
    // Датчик цвета: тёмная плата + три светофильтра R/G/B
    inner = s(7, 9, 26, 11, '#20242c')
      + c(13, 14.5, 2.6, '#e5484d') + c(20, 14.5, 2.6, '#51cf66') + c(27, 14.5, 2.6, '#4dabf7')
      + s(10, 22, 3, 5, '#8b96a5') + s(27, 22, 3, 5, '#8b96a5');
  } else if (type === 'light') {
    // Датчик света: плата + купол-фотодиод и лучи окружающего света
    inner = s(7, 13, 26, 8, '#243a2a')
      + c(20, 13, 4, color)
      + `<g stroke="${color}" stroke-width="1.6" stroke-linecap="round">
           <line x1="20" y1="3" x2="20" y2="6"/>
           <line x1="11" y1="6" x2="13" y2="8.5"/>
           <line x1="29" y1="6" x2="27" y2="8.5"/>
         </g>`
      + s(10, 22, 3, 5, '#8b96a5') + s(27, 22, 3, 5, '#8b96a5');
  } else { // gyro
    inner = `<rect x="8" y="8" width="24" height="18" rx="3" fill="#2b5cad"/><circle cx="20" cy="17" r="5" fill="none" stroke="#cfe0ff" stroke-width="2"/><circle cx="20" cy="17" r="1.6" fill="#cfe0ff"/>`;
  }
  return svgWrap(inner);
}
