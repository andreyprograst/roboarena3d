// Редактор скетча: CodeMirror 5 (UMD, window.CodeMirror) с подсветкой C++,
// автосохранением (debounce) и статусом ошибок.
//
// vendor/codemirror подключён в index.html обычными <script> — к моменту
// запуска ES-модулей window.CodeMirror уже определён.

export function createEditor(host, { value = '', onchange = null } = {}) {
  const CM = window.CodeMirror;
  const cm = CM(host, {
    value,
    mode: 'text/x-c++src',
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    lineWrapping: false,
    viewportMargin: 12, // прокрутка внутри панели редактора
  });
  cm.setOption('extraKeys', {
    Tab: (cm) => cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  '),
  });

  // debounce автосохранения: не пишем localStorage на каждую клавишу
  let saveTimer = 0;
  if (onchange) {
    cm.on('change', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => onchange(cm.getValue()), 300);
    });
  }

  return {
    cm,
    getValue: () => cm.getValue(),
    setValue(v) {
      cm.setValue(v);
      cm.clearHistory();
      cm.refresh();
    },
    refresh: () => cm.refresh(),
  };
}
