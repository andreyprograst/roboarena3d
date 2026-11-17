// Виртуальная плата: пины, моторы, серво, HC-SR04, энкодерные прерывания, Serial, часы.
// Мост между интерпретатором (api) и миром симуляции (robot + sensors).
//
// Раскладка пинов (спека §5):
//   Мотор левый   — PWM 5, направление 7/8   (7=HIGH,8=LOW → вперёд)
//   Мотор правый  — PWM 6, направление 4/12  (4=HIGH,12=LOW → вперёд)
//   Энкодеры      — D2 (левый), D3 (правый), attachInterrupt(…, CHANGE)
//   Сервоприводы  — D9, D10 (каналы 1 и 2; второй — доп. сервопривод из билдера)
//   HC-SR04       — trig D11, echo A3
//   Бампер        — D13 (digitalRead; при ударе HIGH)
//   Датчики линии — A0 (левый), A1 (центр), A2 (правый)
//
// Датчики маршрутизируются по карте robot.mounts.devices (см. билдер): каждый
// датчик занимает пин (или пару trig/echo), первый в списке привязан к штатной
// механике, дополнительные несут собственное крепление. refreshDevices()
// перестраивает таблицы маршрутизации после изменений в билдере.

const PIN = {
  ENC_L: 2,
  ENC_R: 3,
  MOT_R_A: 4,
  MOT_L_PWM: 5,
  MOT_R_PWM: 6,
  MOT_L_A: 7,
  MOT_L_B: 8,
  SERVO_1: 9,
  SERVO_2: 10,
  SONAR_TRIG: 11,
  MOT_R_B: 12,
  BUMPER: 13,
  LINE_L: 14, // A0
  LINE_C: 15, // A1
  LINE_R: 16, // A2
  SONAR_ECHO: 17, // A3
};

const NUM_PINS = 20;
// задежржка delayMicroseconds короче этой границы не двигает часы симуляции
// (имитация busy-wait: trig-импульс 10 мкс не должен стоить 8 мс физики)
const BUSYWAIT_US = 2000;
// сколько миллисекунд после trig считаем результат эха «свежим» для pulseIn
const TRIG_FRESH_MS = 50;

export class Board {
  constructor({ robot, sensors }) {
    this.robot = robot;
    this.sensors = sensors;
    this.simTime = 0; // секунды симуляции, двигается только advance()
    this.pins = [];
    for (let i = 0; i < NUM_PINS; i++) this.pins.push({ mode: 0, out: 0, pwm: 0 });
    this.encHandlers = { [PIN.ENC_L]: null, [PIN.ENC_R]: null };
    this.runtime = null;
    this.serialSink = (text) => console.log('[скетч]', text.replace(/\n$/, ''));
    this._delayResolve = null;
    this._delayUntilMs = -1;
    this._sonarByTrig = new Map(); // пин → устройство
    this._sonarByEcho = new Map();
    this._lineByPin = new Map();   // пин → { read: fn }
    this._gyroByPin = new Map();   // пин → устройство (ось yaw, аналоговый выход)
    this._bumperByPin = new Map(); // пин → { pressed: fn }
    this._colorDev = null;         // первый датчик цвета (colorReadR/G/B)
    this._lightByPin = new Map();  // пин → устройство датчика света (analogRead)
    this._lightDev = null;         // первый датчик света (lightRead)
    this._servoByPin = new Map();  // пин → индекс канала серво
    this._servoBind = new Map();   // id объекта Servo → индекс канала
    this.refreshDevices();
  }

  // Перестроить маршрутизацию датчиков по robot.mounts.devices.
  // Первый датчик каждого типа работает через штатные крепления
  // (mounts.line/sonar/bumper, сервопривод №1), остальные — через собственные.
  refreshDevices() {
    this._sonarByTrig.clear();
    this._sonarByEcho.clear();
    this._lineByPin.clear();
    this._gyroByPin.clear();
    this._bumperByPin.clear();
    this._colorDev = null;
    this._lightByPin.clear();
    this._lightDev = null;
    this._servoByPin.clear();
    const S = this.sensors;
    let iLine = 0, iSonar = 0, iBumper = 0, iServo = 0;
    for (const d of this.robot.mounts.devices || []) {
      if (d.type === 'line') {
        const k = iLine++;
        this._lineByPin.set(d.pin, k < 3 ? () => S.readLine(k) : () => S.readLineDevice(d));
      } else if (d.type === 'gyro') {
        if (d.pin === undefined || this._gyroByPin.has(d.pin)) continue;
        this._gyroByPin.set(d.pin, d);
      } else if (d.type === 'sonar') {
        const k = iSonar++;
        if (d.trig === d.echo) continue;
        if (this._sonarByTrig.has(d.trig) || this._sonarByEcho.has(d.echo)) continue;
        // обе карты хранят одинаковую запись {dev, cm}: _trigEdge и pulseIn
        // читают результат через .cm(), свежее значение — через .dev._cm/_at
        const entry = { dev: d, cm: () => (k === 0 ? S.readSonarCm() : S.readSonarDevice(d)) };
        this._sonarByTrig.set(d.trig, entry);
        this._sonarByEcho.set(d.echo, entry);
      } else if (d.type === 'bumper') {
        const k = iBumper++;
        this._bumperByPin.set(d.pin, k === 0 ? () => S.bumperPressed() : () => S.bumperDevice(d));
      } else if (d.type === 'color') {
        if (!this._colorDev) this._colorDev = d; // функции colorRead* берут первый
      } else if (d.type === 'light') {
        if (!this._lightDev) this._lightDev = d; // lightRead() берёт первый
        if (d.pin === undefined || this._lightByPin.has(d.pin)) continue;
        this._lightByPin.set(d.pin, d);
      } else if (d.type === 'servo') {
        if (this._servoByPin.has(d.pin)) continue;
        this._servoByPin.set(d.pin, iServo++);
      }
    }
  }

  // ── Жизненный цикл ──

  attachRuntime(rt) {
    this.runtime = rt;
    this.sensors.onEncoder = (i, ticks) => this._onEncoder(i, ticks);
  }

  detachRuntime() {
    this.runtime = null;
    this.sensors.onEncoder = null;
    this.motorsOff();
  }

  // Полный сброс платы (Стоп/Сброс/перезапуск скетча)
  reset() {
    for (const p of this.pins) { p.mode = 0; p.out = 0; p.pwm = 0; }
    this.encHandlers[PIN.ENC_L] = null;
    this.encHandlers[PIN.ENC_R] = null;
    this.simTime = 0;
    this._delayResolve = null;
    this._servoBind.clear();
    this.motorsOff();
  }

  // Вызывается из главного цикла после каждого шага физики
  advance(dt) {
    this.simTime += dt;
    if (this._delayResolve && this.simTime * 1000 >= this._delayUntilMs) {
      const r = this._delayResolve;
      this._delayResolve = null;
      r();
    }
  }

  motorsOff() {
    this.robot.setMotorTargets(0, 0);
  }

  // ── Энкодеры → прерывания ──

  _onEncoder(i, ticks) {
    const pin = i === 0 ? PIN.ENC_L : PIN.ENC_R;
    const fn = this.encHandlers[pin];
    if (!fn || !this.runtime) return;
    // как настоящий CHANGE: один вызов ISR на каждый тик (потолок очереди в runtime)
    const n = Math.min(Math.abs(ticks), 32);
    for (let k = 0; k < n; k++) this.runtime.queueInterrupt(fn);
  }

  // ── Моторы: L298-пара dir-пинов + PWM ──

  _pin(pin) {
    return this.pins[pin & 31] || this.pins[0];
  }

  _dutyOf(pwmPin, aPin, bPin) {
    const pwm = this.pins[pwmPin].pwm;
    if (!pwm) return 0;
    const a = this.pins[aPin].out;
    const b = this.pins[bPin].out;
    if (a && !b) return pwm;
    if (!a && b) return -pwm;
    return 0; // оба HIGH или оба LOW — тормоз
  }

  _updateMotors() {
    const left = this._dutyOf(PIN.MOT_L_PWM, PIN.MOT_L_A, PIN.MOT_L_B);
    const right = this._dutyOf(PIN.MOT_R_PWM, PIN.MOT_R_A, PIN.MOT_R_B);
    this.robot.setMotorTargets(left, right);
  }

  // Завершение trig-импульса (1→0): датчик с этим trig-пином измеряет дистанцию
  _trigEdge(pin, v) {
    const p = this.pins[pin & 31];
    const prev = p.out;
    p.out = v;
    if (prev === 1 && v === 0) {
      const entry = this._sonarByTrig.get(pin);
      if (!entry) return;
      entry.dev._cm = this._sonarRead(entry);
      entry.dev._at = this.simTime;
    }
  }

  _sonarRead(devOrEchoEntry) {
    return devOrEchoEntry.cm();
  }

  // ── API для интерпретатора (все методы допускают await) ──

  get api() {
    const b = this;
    return {
      pinMode(pin, mode) {
        b._pin(pin).mode = mode | 0;
        return 0;
      },
      digitalWrite(pin, val) {
        pin = pin | 0;
        if (b._sonarByTrig.has(pin)) { b._trigEdge(pin, val ? 1 : 0); return 0; }
        b._pin(pin).out = val ? 1 : 0;
        b._updateMotors();
        return 0;
      },
      digitalRead(pin) {
        pin = pin | 0;
        const bp = b._bumperByPin.get(pin);
        if (bp) return bp() ? 1 : 0;
        const p = b._pin(pin);
        if (p.mode === 2) return 1; // INPUT_PULLUP — подтяжка
        return p.out;
      },
      analogRead(pin) {
        pin = pin | 0;
        const lr = b._lineByPin.get(pin);
        if (lr) return Math.round(lr());
        // датчик света: освещённость 0..1023 (окружающий свет + лампы сцены)
        const lt = b._lightByPin.get(pin);
        if (lt) return b.sensors.readLightDevice(lt);
        // гироскоп: аналоговый выход ~ скорость поворота вокруг вертикали.
        // 512 = покой; ±127.5 °/с → полный диапазон 0..1023. Погрешность —
        // только в режиме реализма (noiseLevel), при 0 показания точные.
        const gy = b._gyroByPin.get(pin);
        if (gy) {
          const av = b.robot.body ? b.robot.body.angularVelocity.y : 0;
          const dps = av * 180 / Math.PI;
          const L = b.sensors.noiseLevel | 0;
          const jitter = L > 0 ? b.sensors._gauss() * 10 * L : 0;
          const noisy = 512 + dps * 4 + jitter;
          return Math.round(Math.max(0, Math.min(1023, noisy)));
        }
        return 0;
      },
      analogWrite(pin, val) {
        const p = b._pin(pin);
        p.pwm = Math.max(0, Math.min(255, val | 0));
        b._updateMotors();
        return 0;
      },
      pulseIn(pin, val, timeout) {
        // честная схема: результат берётся от последнего trig-импульса ЭТОГО
        // датчика; если скетч пингует без trig — измеряем на месте.
        pin = pin | 0;
        void val; void timeout;
        const entry = b._sonarByEcho.get(pin);
        if (!entry) return 0;
        let cm;
        if (entry.dev && entry.dev._cm !== undefined && (b.simTime - entry.dev._at) * 1000 < TRIG_FRESH_MS) {
          cm = entry.dev._cm;
        } else {
          cm = entry.cm();
        }
        if (!cm) return 0; // нет цели — эха нет (не ждём таймаут: симуляция мгновенна)
        return Math.round(cm * 58); // см → мкс (звук 343 м/с, туда-обратно)
      },
      // ── Датчик цвета: RGB отражённого света 0..1023 (первый датчик цвета).
      // Реализм: чем дальше поверхность, тем слабее сигнал (см. sensors.js).
      colorReadR() {
        const d = b._colorDev;
        return d ? b.sensors.readColorDevice(d).r : 0;
      },
      colorReadG() {
        const d = b._colorDev;
        return d ? b.sensors.readColorDevice(d).g : 0;
      },
      colorReadB() {
        const d = b._colorDev;
        return d ? b.sensors.readColorDevice(d).b : 0;
      },
      // ── Датчик света: освещённость 0..1023 (первый датчик света).
      // То же значение доступно через analogRead(пин датчика света).
      lightRead() {
        const d = b._lightDev;
        return d ? b.sensors.readLightDevice(d) : 0;
      },
      attachInterrupt(pin, fnRef, mode) {
        pin = pin | 0;
        if (pin === PIN.ENC_L || pin === PIN.ENC_R) b.encHandlers[pin] = fnRef;
        return 0;
      },
      detachInterrupt(pin) {
        pin = pin | 0;
        if (pin === PIN.ENC_L || pin === PIN.ENC_R) b.encHandlers[pin] = null;
        return 0;
      },
      millis() { return b.simTime * 1000; },
      micros() { return Math.round(b.simTime * 1e6); },
      delayMs(ms) {
        return new Promise((res) => {
          b._delayResolve = res;
          b._delayUntilMs = b.simTime * 1000 + Math.max(0, ms);
        });
      },
      delayMicros(us) {
        us = Math.max(0, us | 0);
        if (us < BUSYWAIT_US) return 0; // busy-wait — часы не тикают
        return new Promise((res) => {
          b._delayResolve = res;
          b._delayUntilMs = b.simTime * 1000 + us / 1000;
        });
      },
      yieldFrame() {
        return new Promise((res) => setTimeout(res, 0));
      },
      serialPrint(text) {
        b.serialSink(String(text));
        return 0;
      },
      servoAttach(id, pin) {
        pin = pin | 0;
        const idx = b._servoByPin.get(pin);
        b._servoBind.set(String(id), idx === undefined ? 0 : idx);
        return 0;
      },
      servoWrite(id, angle) {
        const idx = b._servoBind.get(String(id)) || 0;
        b.robot.setServoTarget(idx, Math.max(0, Math.min(180, angle)) / 180);
        return 0;
      },
      servoDetach(id) {
        b._servoBind.delete(String(id));
        return 0;
      },
    };
  }
}

export { PIN };
