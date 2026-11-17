// Готовые примеры скетчей для меню «Примеры». Чистый C-подмножество Arduino.

export const EXAMPLES = {
  line: {
    title: 'Линия (P-регулятор)',
    arena: 'line',
    code: `// Пример «Линия»: P-регулятор по трём ИК-датчикам.
// A0 — левый, A1 — центр, A2 — правый. Белое поле ~983, чёрная линия ~100.
// Если линию потеряли (все белое) — крутим в сторону, куда она ушла последней.

#define L_PWM 5
#define L_A 7
#define L_B 8
#define R_PWM 6
#define R_A 4
#define R_B 12

#define BASE 120      // базовая скорость 0..255
#define DIV 3         // делитель ошибки (больше = мягче реакция)
#define RECOVER 110   // мощность поиска потерянной линии (дуга, не разворот)
#define DIFF_MAX 150  // предел реакции: без него резкие коррекции сваливаются в разворот

int lastErr = 1;      // куда линия ушла в последний раз: >0 — вправо

void motor(int lp, int rp) {
  analogWrite(L_PWM, abs(lp));
  analogWrite(R_PWM, abs(rp));
  digitalWrite(L_A, lp >= 0);
  digitalWrite(L_B, lp < 0);
  digitalWrite(R_A, rp >= 0);
  digitalWrite(R_B, rp < 0);
}

void setup() {
  Serial.begin(9600);
  pinMode(L_PWM, OUTPUT); pinMode(L_A, OUTPUT); pinMode(L_B, OUTPUT);
  pinMode(R_PWM, OUTPUT); pinMode(R_A, OUTPUT); pinMode(R_B, OUTPUT);
  Serial.println("Линия: P-регулятор, поехали!");
}

void loop() {
  int l = analogRead(A0);
  int c = analogRead(A1);
  int r = analogRead(A2);

  int err = l - r;                 // >0 — линия правее (правый датчик темнее)
  if (err > 60 || err < -60) lastErr = err;

  int diff = err / DIV;            // реакция регулятора
  if (diff > DIFF_MAX) diff = DIFF_MAX;
  if (diff < -DIFF_MAX) diff = -DIFF_MAX;
  if (l > 800 && c > 800 && r > 800) {
    // линию потеряли (все датчики белые) — ищем дугой в последнюю сторону
    diff = (lastErr > 0) ? RECOVER : -RECOVER;
  }

  int lp = BASE + diff;            // поворот вправо: левое колесо быстрее
  int rp = BASE - diff;
  motor(lp, rp);
  delay(10);
}
`,
  },

  maze: {
    title: 'Лабиринт (правая рука)',
    arena: 'maze',
    code: `// Пример «Лабиринт»: правило правой руки с пробой поворотом.
// Сонор смотрит вперёд. На каждой клетке: если справа свободно — направо,
// иначе если впереди свободно — прямо, иначе налево, иначе разворот.
// Повороты калибруются по энкодерам (D2 — левый, D3 — правый, CHANGE).

#define TRIG 11
#define ECHO A3
#define L_PWM 5
#define L_A 7
#define L_B 8
#define R_PWM 6
#define R_A 4
#define R_B 12
#define ENC_L 2
#define ENC_R 3

#define TICKS_TURN 281  // тики колеса на поворот 90 градусов
#define TICKS_CELL 1390 // тики на клетку 80 см

long cntL = 0;
long cntR = 0;

void tickL() { cntL++; }
void tickR() { cntR++; }

long dist() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  return us / 58;
}

void motor(int lp, int rp) {
  analogWrite(L_PWM, abs(lp));
  analogWrite(R_PWM, abs(rp));
  digitalWrite(L_A, lp >= 0);
  digitalWrite(L_B, lp < 0);
  digitalWrite(R_A, rp >= 0);
  digitalWrite(R_B, rp < 0);
}

void spinLeft() {
  cntL = 0;
  motor(-170, 170);  // левое назад, правое вперёд — корпус влево
  while (cntL < TICKS_TURN) { delay(1); }
  motor(0, 0);
  delay(100);
}

void spinRight() {
  cntL = 0;
  motor(170, -170);  // левое вперёд, правое назад — корпус вправо
  while (cntL < TICKS_TURN) { delay(1); }
  motor(0, 0);
  delay(100);
}

boolean rightOpen() {
  spinRight();
  long d = dist();
  spinLeft();
  return d == 0 || d > 30;
}

boolean leftOpen() {
  spinLeft();
  long d = dist();
  spinRight();
  return d == 0 || d > 30;
}

void forwardCell() {
  cntL = 0;
  motor(160, 160);
  while (cntL < TICKS_CELL) {
    long d = dist();
    if (d > 0 && d < 15) break;  // стена близко
    delay(5);
  }
  motor(0, 0);
}

void setup() {
  Serial.begin(9600);
  pinMode(L_PWM, OUTPUT); pinMode(L_A, OUTPUT); pinMode(L_B, OUTPUT);
  pinMode(R_PWM, OUTPUT); pinMode(R_A, OUTPUT); pinMode(R_B, OUTPUT);
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  attachInterrupt(ENC_L, tickL, CHANGE);
  attachInterrupt(ENC_R, tickR, CHANGE);
  Serial.println("Лабиринт: правая рука, пошёл!");
}

void loop() {
  if (rightOpen()) {
    spinRight();
  } else {
    long d = dist();
    if (d > 30 || d == 0) {
      // прямо свободно — едем
    } else if (leftOpen()) {
      spinLeft();
    } else {
      spinLeft();
      spinLeft();  // разворот
    }
  }
  forwardCell();
}
`,
  },

  eight: {
    title: 'Восьмёрка (ПД-регулятор)',
    arena: 'eight',
    code: `// Пример «Восьмёрка»: ПД-регулятор по трём ИК-датчикам.
// Главная хитрость трассы — перекрёсток: в точке пересечения чернота
// оказывается под всеми тремя датчиками. Тогда руль выравниваем и едем
// прямо, иначе D-часть от перпендикулярной линии сваливает робота.
// D-часть нужна и для самих петель: они круче поворотов обычной линии.

#define L_PWM 5
#define L_A 7
#define L_B 8
#define R_PWM 6
#define R_A 4
#define R_B 12

#define BASE 105      // базовая скорость 0..255 (умеренная: петли тугие)
#define DIV 4         // делитель ошибки P-части
#define DDIV 6        // делитель прироста ошибки D-части
#define RECOVER 95    // мощность поиска потерянной линии (дуга)
#define DIFF_MAX 120  // предел реакции

int prevErr = 0;      // ошибка на прошлом шаге (для D-части)
int lastErr = 1;      // куда линия ушла в последний раз: >0 — вправо

void motor(int lp, int rp) {
  analogWrite(L_PWM, abs(lp));
  analogWrite(R_PWM, abs(rp));
  digitalWrite(L_A, lp >= 0);
  digitalWrite(L_B, lp < 0);
  digitalWrite(R_A, rp >= 0);
  digitalWrite(R_B, rp < 0);
}

void setup() {
  Serial.begin(9600);
  pinMode(L_PWM, OUTPUT); pinMode(L_A, OUTPUT); pinMode(L_B, OUTPUT);
  pinMode(R_PWM, OUTPUT); pinMode(R_A, OUTPUT); pinMode(R_B, OUTPUT);
  Serial.println("Восьмёрка: ПД-регулятор, поехали!");
}

void loop() {
  int l = analogRead(A0);
  int c = analogRead(A1);
  int r = analogRead(A2);

  int err = l - r;                 // >0 — линия правее
  if (l < 400 && c < 400 && r < 400) {
    err = 0;                       // перекрёсток: чёрное везде — держим курс
  } else if (err > 60 || err < -60) {
    lastErr = err;
  }

  int diff = err / DIV + (err - prevErr) / DDIV; // ПД-реакция
  prevErr = err;
  if (diff > DIFF_MAX) diff = DIFF_MAX;
  if (diff < -DIFF_MAX) diff = -DIFF_MAX;
  if (l > 800 && c > 800 && r > 800) {
    // линию потеряли (все датчики белые) — ищем дугой в последнюю сторону
    diff = (lastErr > 0) ? RECOVER : -RECOVER;
  }

  int lp = BASE + diff;
  int rp = BASE - diff;
  motor(lp, rp);
  delay(10);
}
`,
  },

  kegely: {
    title: 'Кегли (до зелёного)',
    arena: 'kegely',
    code: `// Пример «Кегли»: едем от старта к финишу, задевая кегли, встаём на
// зелёной зоне. Зелёный ищем по ОТНОШЕНИЯМ каналов датчика цвета — так
// детектор не зависит от яркости света (нужен датчик цвета на роботе).
// Сонар видит кеглю заранее — притормаживаем и продавливаем без отскока.

#define TRIG 11
#define ECHO A3
#define L_PWM 5
#define L_A 7
#define L_B 8
#define R_PWM 6
#define R_A 4
#define R_B 12

// дистанция до препятствия, см (0 = цели нет)
long dist() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  return us / 58;
}

// мощность моторов -255..255
void motor(int lp, int rp) {
  analogWrite(L_PWM, abs(lp));
  analogWrite(R_PWM, abs(rp));
  digitalWrite(L_A, lp >= 0);
  digitalWrite(L_B, lp < 0);
  digitalWrite(R_A, rp >= 0);
  digitalWrite(R_B, rp < 0);
}

void setup() {
  Serial.begin(9600);
  pinMode(L_PWM, OUTPUT); pinMode(L_A, OUTPUT); pinMode(L_B, OUTPUT);
  pinMode(R_PWM, OUTPUT); pinMode(R_A, OUTPUT); pinMode(R_B, OUTPUT);
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  Serial.println("Кегли: вперёд до зелёного финиша!");
}

void loop() {
  int r = colorReadR();
  int g = colorReadG();
  int b = colorReadB();

  // зелёный финиш: g > 1.3·r и g > 1.25·b (серый пол ~1:1:1 не пройдёт)
  if (g * 10 > r * 13 && g * 4 > b * 5) {
    motor(0, 0);
    Serial.println("Финиш — зелёная зона! Кегли позади.");
    while (true) { delay(500); } // стоим: заезд окончен
  }

  long d = dist();
  if (d > 0 && d < 12) {
    motor(95, 95);   // кегля близко: медленно продавливаем, без отскока
  } else {
    motor(150, 150);
  }
  delay(20);
}
`,
  },

  sandbox: {
    title: 'Песочница (объезд препятствий)',
    arena: 'sandbox',
    code: `// Демо «Песочница»: едем вперёд, объезжаем стены по дальномеру,
// пишем в Serial и поворачиваем сервопривод.

#include <Servo.h>

#define TRIG 11
#define ECHO A3  // echo на A3: D12 занят направлением правого мотора
#define L_PWM 5
#define L_A 7
#define L_B 8
#define R_PWM 6
#define R_A 4
#define R_B 12

Servo flag;

// дистанция до препятствия, см (0 = цели нет)
long dist() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);
  return us / 58;
}

// мощность моторов -255..255
void motor(int lp, int rp) {
  analogWrite(L_PWM, abs(lp));
  analogWrite(R_PWM, abs(rp));
  digitalWrite(L_A, lp >= 0);
  digitalWrite(L_B, lp < 0);
  digitalWrite(R_A, rp >= 0);
  digitalWrite(R_B, rp < 0);
}

void setup() {
  Serial.begin(9600);
  pinMode(L_PWM, OUTPUT); pinMode(L_A, OUTPUT); pinMode(L_B, OUTPUT);
  pinMode(R_PWM, OUTPUT); pinMode(R_A, OUTPUT); pinMode(R_B, OUTPUT);
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  flag.attach(9);
  Serial.println("Демо-скетч: объезд препятствий");
}

void loop() {
  long d = dist();
  if (d > 0 && d < 30) {
    motor(0, 0);
    Serial.print("Стена через ");
    Serial.print(d);
    Serial.println(" см — разворот");
    flag.write(160);
    motor(-120, -120);  // немного назад — выйти из клина у препятствия
    delay(300);
    motor(170, -170);   // разворот на месте
    delay(800);
    flag.write(20);
  } else {
    motor(180, 180);
  }
  delay(50);
}
`,
  },
};
