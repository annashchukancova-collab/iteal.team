/**
 * iTeal · Маршрутные карты — реестр созданных карт (v2, новый проект)
 * ===========================================================================
 * Полностью новая версия для нового Apps Script проекта и новой таблицы —
 * старую версию (в другом проекте) можно больше не трогать, её данные
 * переносить не нужно.
 *
 * ЧТО ДЕЛАЕТ
 *   Всё — через doGet (GET + JSONP), включая запись. Так сделано намеренно:
 *   /exec у Apps Script всегда 302-редиректит на script.googleusercontent.com,
 *   а браузер при редиректе превращает POST в GET и теряет тело запроса —
 *   doPost в такой связке вызвать снаружи надёжно нельзя. У GET тело не нужно,
 *   все данные едут в самом URL, редирект их не теряет.
 *   • ?action=list — отдаёт JSON-список всех карт (активных и в архиве)
 *     для страницы route-maps.html.
 *   • без action — быстрый пинг для диагностики связи с таблицей.
 *   • ?action=create|progress|archive|unarchive|delete&payload=<JSON> —
 *       - "create"   → создаёт новую строку (карту) в реестре;
 *       - "progress" → приходит САМА С СЕБЯ с карты (route-map.html) при
 *         каждой отметке/правке анкеты — обновляет % пройдено и остальные
 *         показатели; если пройдено 100% — карта САМА уходит в архив;
 *       - "archive" / "unarchive" — переносит карту в архив / возвращает;
 *       - "delete"   → удаляет строку насовсем (кнопка «Удалить» в списке).
 *   Все ответы поддерживают JSONP через ?callback=.
 *   doPost оставлен как резерв (вдруг что-то раньше слало настоящий POST) —
 *   но полагаться на него нельзя по причине выше.
 *
 * ===========================  РАЗВЁРТЫВАНИЕ  ==============================
 * 1. В НОВОМ проекте Apps Script вставьте этот файл как Code.gs.
 * 2. ID_ТАБЛИЦЫ ниже уже заполнен вашей таблицей.
 * 3. Развернуть → Новое развёртывание → Веб-приложение:
 *        Запускать от имени: Я
 *        У кого есть доступ: Все пользователи (Anyone) — без этого сайт
 *        (он анонимный, без входа в Google) не сможет достучаться до скрипта.
 * 4. Скопируйте выданный адрес (…/exec) и вставьте его:
 *      - в route-map.html   → const NEW_SEND_URL = "..."
 *      - в route-maps.html  → var SEND_URL = "..."
 * 5. Запустите функцию «подготовка» один раз из редактора — создаст лист
 *    «Маршрутные карты» с шапкой, если его ещё нет.
 * 6. Проверка: откройте адрес /exec прямо в браузере — должно быть
 *    {"ok":true,"stamp":0,...}. Если видите что-то другое — деплой не применился.
 * ===========================================================================
 */

/* =============================  НАСТРОЙКИ  =============================== */

var ID_ТАБЛИЦЫ = '1wzgpAc2b3oBVVqThHcdc7B2lcc0nOqTqvhxDoOwbEQs';

var ЛИСТ_КАРТ = 'Маршрутные карты';
var ШАПКА_КАРТ = ['ФИО', 'Роль', 'Наставник', 'Дата приёма', 'Дата рождения',
  'Телефон', 'Условия оплаты', 'Почта', 'Создана', 'Обновлена',
  '% пройдено', 'Шагов сделано', 'Шагов всего', 'Самообуч. сделано', 'Самообуч. всего',
  'Текущий шаг', 'Балл', 'Архив'];

/* индексы столбцов (1-based), чтобы не считать вручную при каждой правке */
var К = { ФИО:1, РОЛЬ:2, НАСТАВНИК:3, ПРИНЯТ:4, РОЖДЕНИЕ:5, ТЕЛЕФОН:6, ОПЛАТА:7, ПОЧТА:8,
  СОЗДАНА:9, ОБНОВЛЕНА:10, ПРОЦЕНТ:11, ШАГОВ_СДЕЛАНО:12, ШАГОВ_ВСЕГО:13,
  САМООБУЧ_СДЕЛАНО:14, САМООБУЧ_ВСЕГО:15, ТЕКУЩИЙ_ШАГ:16, БАЛЛ:17, АРХИВ:18 };

/* ==============================  ТАБЛИЦА  ================================= */

function книга_() {
  return SpreadsheetApp.openById(ID_ТАБЛИЦЫ);
}

function листКарт_() {
  var ss = книга_();
  var sh = ss.getSheetByName(ЛИСТ_КАРТ);
  if (!sh) {
    sh = ss.insertSheet(ЛИСТ_КАРТ);
    sh.appendRow(ШАПКА_КАРТ);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Запустить один раз вручную из редактора: создаёт лист с шапкой. */
function подготовка() {
  var sh = листКарт_();
  Logger.log('Лист "%s" готов, строк: %s', ЛИСТ_КАРТ, sh.getLastRow());
}

/** Находит номер строки (1-based) по ФИО, 0 если нет. */
function найтиСтроку_(sh, фио) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var values = sh.getRange(2, К.ФИО, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === фио.trim()) return i + 2;
  }
  return 0;
}

/* ==============================  ВЕРСИЯ  ================================== */

function версия_() {
  return Number(PropertiesService.getScriptProperties().getProperty('v') || 0);
}
function увеличитьВерсию_() {
  var v = версия_() + 1;
  PropertiesService.getScriptProperties().setProperty('v', String(v));
  return v;
}

/* ================================  doGet  ================================= */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || '');
  var результат;

  if (action === 'list') {
    результат = списокКарт_();
  } else if (action === 'create' || action === 'progress' || action === 'archive' ||
             action === 'unarchive' || action === 'delete') {
    var data;
    try { data = JSON.parse(p.payload || '{}'); } catch (err) { data = {}; }
    результат = обработать_(action, data);
  } else {
    результат = пинг_();
  }
  // клиент сверяет это поле с тем, что запрашивал — если сервер не понял action
  // (например, развёрнута старая версия кода) и тихо откатился на пинг,
  // здесь будет 'ping', а не запрошенное действие, и клиент увидит настоящую ошибку
  // вместо ложного «успеха».
  результат._action = action || 'ping';

  if (p.callback) {
    return ContentService
      .createTextOutput(p.callback + '(' + JSON.stringify(результат) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(результат))
    .setMimeType(ContentService.MimeType.JSON);
}

function обработать_(action, data) {
  switch (action) {
    case 'create': return создатьКарту_(data);
    case 'archive': return архивировать_(data.фио || data.fio, true);
    case 'unarchive': return архивировать_(data.фио || data.fio, false);
    case 'delete': return удалитьКарту_(data.фио || data.fio);
    default: return обновитьПрогресс_(data);
  }
}

function пинг_() {
  try {
    var sh = листКарт_();
    return {
      ok: true, stamp: версия_(), rows: Math.max(sh.getLastRow() - 1, 0),
      spreadsheet: книга_().getName(), sheet: ЛИСТ_КАРТ
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function списокКарт_() {
  try {
    var sh = листКарт_();
    var last = sh.getLastRow();
    if (last < 2) return { ok: true, cards: [], stamp: версия_() };
    var rows = sh.getRange(2, 1, last - 1, ШАПКА_КАРТ.length).getValues();
    var cards = rows.filter(function (r) { return String(r[К.ФИО - 1]).trim(); }).map(function (r) {
      return {
        fio: r[К.ФИО - 1], role: r[К.РОЛЬ - 1], mentor: r[К.НАСТАВНИК - 1],
        hired: fmt_(r[К.ПРИНЯТ - 1]), birth: fmt_(r[К.РОЖДЕНИЕ - 1]),
        phone: r[К.ТЕЛЕФОН - 1], pay: r[К.ОПЛАТА - 1], mail: r[К.ПОЧТА - 1],
        createdAt: fmt_(r[К.СОЗДАНА - 1]), updatedAt: fmt_(r[К.ОБНОВЛЕНА - 1]),
        pct: r[К.ПРОЦЕНТ - 1] || 0, done: r[К.ШАГОВ_СДЕЛАНО - 1] || 0, total: r[К.ШАГОВ_ВСЕГО - 1] || 0,
        studyDone: r[К.САМООБУЧ_СДЕЛАНО - 1] || 0, studyTotal: r[К.САМООБУЧ_ВСЕГО - 1] || 0,
        step: r[К.ТЕКУЩИЙ_ШАГ - 1] || '', score: r[К.БАЛЛ - 1] || '',
        archived: r[К.АРХИВ - 1] === true || r[К.АРХИВ - 1] === 'TRUE'
      };
    });
    return { ok: true, cards: cards, stamp: версия_() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function fmt_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}

/* ================================  doPost  ================================= */

/* Резерв — ненадёжен из-за 302-редиректа (см. шапку файла), основной путь — doGet. */
function doPost(e) {
  var data;
  try {
    var raw = (e && e.parameter && e.parameter.payload) || (e && e.postData && e.postData.contents) || '{}';
    data = JSON.parse(raw);
  } catch (err) {
    return вывод_({ ok: false, error: 'bad json' });
  }
  return вывод_(обработать_(data.kind || 'progress', data));
}

function вывод_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function создатьКарту_(d) {
  var sh = листКарт_();
  var фио = String(d.фио || d.fio || '').trim();
  if (!фио) return { ok: false, error: 'ФИО пустое' };
  if (найтиСтроку_(sh, фио)) return { ok: false, error: 'карта с таким ФИО уже есть' };

  var row = новыйРяд_();
  row[К.ФИО - 1] = фио;
  row[К.РОЛЬ - 1] = d.роль || d.role || '';
  row[К.НАСТАВНИК - 1] = d.наставник || d.mentor || '';
  row[К.ПРИНЯТ - 1] = d.принят || d.hired || '';
  row[К.ПОЧТА - 1] = d.mail || '';
  row[К.СОЗДАНА - 1] = new Date();
  sh.appendRow(row);
  return { ok: true, stamp: увеличитьВерсию_() };
}

function обновитьПрогресс_(d) {
  var фио = String(d.фио || d.name || '').trim();
  if (!фио) return { ok: false, error: 'ФИО пустое' };

  var sh = листКарт_();
  var номер = найтиСтроку_(sh, фио);
  var п = d.профиль || d.profile || {};
  var pct = Number(d.pct || 0);
  var готово = Number(d.готово || d.done || 0);
  var всего = Number(d.всего || d.total || 0);

  if (!номер) {
    var row = новыйРяд_();
    row[К.ФИО - 1] = фио;
    row[К.СОЗДАНА - 1] = new Date();
    sh.appendRow(row);
    номер = sh.getLastRow();
  }

  sh.getRange(номер, К.РОЛЬ, 1, 6).setValues([[
    п.роль || '', п.наставник || '', п.принят || '', п.рождение || '', п.телефон || '', п.оплата || ''
  ]]);
  if (d.mail) sh.getRange(номер, К.ПОЧТА).setValue(d.mail);
  sh.getRange(номер, К.ОБНОВЛЕНА, 1, 8).setValues([[
    new Date(), pct, готово, всего,
    Number(d.учГот || d.studyDone || 0), Number(d.учВсе || d.studyTotal || 0),
    d.шаг || d.step || '', d.балл || d.score || ''
  ]]);

  // маршрут пройден полностью — карта сама уходит в архив, отдельно нажимать не нужно
  if (всего > 0 && готово >= всего) {
    sh.getRange(номер, К.АРХИВ).setValue(true);
  }

  return { ok: true, stamp: увеличитьВерсию_() };
}

function архивировать_(фио, вАрхив) {
  фио = String(фио || '').trim();
  if (!фио) return { ok: false, error: 'ФИО пустое' };
  var sh = листКарт_();
  var номер = найтиСтроку_(sh, фио);
  if (!номер) return { ok: false, error: 'карта не найдена' };
  sh.getRange(номер, К.АРХИВ).setValue(!!вАрхив);
  return { ok: true, stamp: увеличитьВерсию_() };
}

function удалитьКарту_(фио) {
  фио = String(фио || '').trim();
  if (!фио) return { ok: false, error: 'ФИО пустое' };
  var sh = листКарт_();
  var номер = найтиСтроку_(sh, фио);
  if (!номер) return { ok: false, error: 'карта не найдена' };
  sh.deleteRow(номер);
  return { ok: true, stamp: увеличитьВерсию_() };
}

function новыйРяд_() {
  var row = [];
  for (var i = 0; i < ШАПКА_КАРТ.length; i++) row.push('');
  row[К.ПРОЦЕНТ - 1] = 0; row[К.ШАГОВ_СДЕЛАНО - 1] = 0; row[К.ШАГОВ_ВСЕГО - 1] = 0;
  row[К.САМООБУЧ_СДЕЛАНО - 1] = 0; row[К.САМООБУЧ_ВСЕГО - 1] = 0; row[К.АРХИВ - 1] = false;
  return row;
}
