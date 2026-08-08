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

/* ---------------------------------------------------------------------
   Оргструктура (холакратия) — org-structure.html. Отдельный лист в той же
   таблице. Одна строка = один узел (круг ИЛИ роль — деления на два типа
   нет, узел с детьми рисуется как круг, без детей — как роль). Корень
   всегда имеет ID='root'. Списки (Домены/Зоны ответственности/Исполнители)
   хранятся как обычный текст с переносом строки на каждый пункт. ------- */

var ЛИСТ_ОРГ = 'Оргструктура';
/* «Фото» добавлено 11-й колонкой (после Обновил), а не в середину — так
   у уже существующих строк ничего не съезжает при обновлении скрипта. */
var ШАПКА_ОРГ = ['ID', 'Родитель', 'Название', 'Назначение', 'Домены',
  'Зоны ответственности', 'Заметки', 'Исполнители', 'Обновлено', 'Обновил', 'Фото',
  'Политики', 'Проекты', 'Чеклисты', 'Цели', 'Метрики', 'Вложения', 'История'];
var О = { ID:1, РОДИТЕЛЬ:2, НАЗВАНИЕ:3, НАЗНАЧЕНИЕ:4, ДОМЕНЫ:5, ЗОНЫ:6,
  ЗАМЕТКИ:7, ИСПОЛНИТЕЛИ:8, ОБНОВЛЕНО:9, ОБНОВИЛ:10, ФОТО:11,
  ПОЛИТИКИ:12, ПРОЕКТЫ:13, ЧЕКЛИСТЫ:14, ЦЕЛИ:15, МЕТРИКИ:16, ВЛОЖЕНИЯ:17, ИСТОРИЯ:18 };

/* Журнал изменений узла — список строк "ISO-времяпочтачто изменили",
   хранится в столбце "История" через \n, как остальные списки. Не безлимитный:
   при каждой записи обрезаем до последних 50 — иначе ячейка листа рано или
   поздно упрётся в предел длины, а вкладка "История" превратится в простыню. */
var ИСТОРИЯ_МАКС = 50;
/* Разделитель полей внутри одной строки лога — служебный символ (unit
   separator), который никто не вводит с клавиатуры, поэтому не путается
   с текстом самой правки. */
var РАЗД_ИСТОРИИ = String.fromCharCode(31);
function добавитьВИсторию_(sh, номер, метка, mail) {
  if (!метка) return;
  var текущая = String(sh.getRange(номер, О.ИСТОРИЯ).getValue() || '');
  var строки = текущая ? текущая.split('\n') : [];
  строки.push(new Date().toISOString() + РАЗД_ИСТОРИИ + (mail || '') + РАЗД_ИСТОРИИ + метка);
  if (строки.length > ИСТОРИЯ_МАКС) строки = строки.slice(строки.length - ИСТОРИЯ_МАКС);
  sh.getRange(номер, О.ИСТОРИЯ).setValue(строки.join('\n'));
}

/* Изменение структуры компании — риск выше, чем у своей маршрутной карты
   (можно испортить общий вид для всех), поэтому в отличие от карт здесь
   есть ещё и серверная проверка почты, а не только клиентская. */
var ОРГ_АДМИНЫ = [
  'anna.shchukancova@iteal.expert',
  'pavel.stupko@iteal.expert',
  'galina.marushevskaia@iteal.expert',
  'anastasiia.edakina@iteal.expert'
];
function этоАдминОрг_(mail) {
  return ОРГ_АДМИНЫ.indexOf(String(mail || '').trim().toLowerCase()) !== -1;
}

/* ---------------------------------------------------------------------
   Итоги встреч — meeting-notes.html. Отдельный лист в той же таблице.
   Одна строка = одна запись (итог одной встречи). Тип встречи — просто
   код одной из трёх фиксированных вкладок, без отдельного листа на
   каждую. Писать может любой прошедший гейт по почте @iteal.expert (это
   рабочие заметки команды, а не структура компании), а удалять — только
   сам автор записи или один из админов оргструктуры (тот же список). ---- */

var ЛИСТ_ИТОГИ = 'Итоги встреч';
var ШАПКА_ИТОГИ = ['ID', 'Тип', 'Дата', 'Текст', 'Вложения', 'Автор', 'Создано'];
var И = { ID:1, ТИП:2, ДАТА:3, ТЕКСТ:4, ВЛОЖЕНИЯ:5, АВТОР:6, СОЗДАНО:7 };
var ТИПЫ_ИТОГОВ = ['tactical', 'governance', 'retro'];

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
  var shОрг = листОрг_();
  Logger.log('Лист "%s" готов, строк: %s', ЛИСТ_ОРГ, shОрг.getLastRow());
  var shИтоги = листИтоги_();
  Logger.log('Лист "%s" готов, строк: %s', ЛИСТ_ИТОГИ, shИтоги.getLastRow());
}

/** Лист итогов встреч — создаёт лист с шапкой, если его ещё нет. */
function листИтоги_() {
  var ss = книга_();
  var sh = ss.getSheetByName(ЛИСТ_ИТОГИ);
  if (!sh) {
    sh = ss.insertSheet(ЛИСТ_ИТОГИ);
    sh.appendRow(ШАПКА_ИТОГИ);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Находит номер строки (1-based) по ID записи итогов, 0 если нет. */
function найтиСтрокуИтоги_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var values = sh.getRange(2, И.ID, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(id).trim()) return i + 2;
  }
  return 0;
}

/** Лист оргструктуры — создаёт лист с шапкой и сеет корень «iTeal», если пусто. */
function листОрг_() {
  var ss = книга_();
  var sh = ss.getSheetByName(ЛИСТ_ОРГ);
  if (!sh) {
    sh = ss.insertSheet(ЛИСТ_ОРГ);
    sh.appendRow(ШАПКА_ОРГ);
    sh.setFrozenRows(1);
  }
  if (sh.getLastRow() < 2) {
    sh.appendRow(['root', '', 'iTeal', '', '', '', '', '', new Date(), '', '', '', '', '', '', '', '', '']);
  }
  return sh;
}

/** Находит номер строки (1-based) по ID узла оргструктуры, 0 если нет. */
function найтиСтрокуОрг_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var values = sh.getRange(2, О.ID, last - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(id).trim()) return i + 2;
  }
  return 0;
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
  } else if (action === 'orgList') {
    результат = списокОрг_();
  } else if (action === 'orgAddNode' || action === 'orgUpdateFields' ||
             action === 'orgReparent' || action === 'orgDelete') {
    var orgData;
    try { orgData = JSON.parse(p.payload || '{}'); } catch (err) { orgData = {}; }
    результат = обработатьОрг_(action, orgData);
  } else if (action === 'meetingList') {
    результат = списокИтогов_();
  } else if (action === 'meetingAdd' || action === 'meetingDelete') {
    var meetingData;
    try { meetingData = JSON.parse(p.payload || '{}'); } catch (err) { meetingData = {}; }
    результат = обработатьИтоги_(action, meetingData);
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

/* ============================  ОРГСТРУКТУРА  ============================== */

function обработатьОрг_(action, d) {
  if (!этоАдминОрг_(d.mail)) return { ok: false, error: 'только для админов' };
  switch (action) {
    case 'orgAddNode': return orgAddNode_(d);
    case 'orgUpdateFields': return orgUpdateFields_(d);
    case 'orgReparent': return orgReparent_(d);
    case 'orgDelete': return orgDelete_(d);
  }
  return { ok: false, error: 'неизвестное действие' };
}

function списокОрг_() {
  try {
    var sh = листОрг_();
    var last = sh.getLastRow();
    var rows = sh.getRange(2, 1, last - 1, ШАПКА_ОРГ.length).getValues();
    var nodes = rows.filter(function (r) { return String(r[О.ID - 1]).trim(); }).map(function (r) {
      return {
        id: r[О.ID - 1], parent: r[О.РОДИТЕЛЬ - 1], name: r[О.НАЗВАНИЕ - 1],
        purpose: r[О.НАЗНАЧЕНИЕ - 1] || '',
        domains: строкаВСписок_(r[О.ДОМЕНЫ - 1]),
        accountabilities: строкаВСписок_(r[О.ЗОНЫ - 1]),
        notes: r[О.ЗАМЕТКИ - 1] || '',
        assignees: строкаВСписок_(r[О.ИСПОЛНИТЕЛИ - 1]),
        updatedAt: fmt_(r[О.ОБНОВЛЕНО - 1]), updatedBy: r[О.ОБНОВИЛ - 1] || '',
        photo: r[О.ФОТО - 1] || '',
        policies: строкаВСписок_(r[О.ПОЛИТИКИ - 1]),
        projects: строкаВСписок_(r[О.ПРОЕКТЫ - 1]),
        checklist: строкаВСписок_(r[О.ЧЕКЛИСТЫ - 1]),
        goals: строкаВСписок_(r[О.ЦЕЛИ - 1]),
        metrics: строкаВСписок_(r[О.МЕТРИКИ - 1]),
        attachments: строкаВСписок_(r[О.ВЛОЖЕНИЯ - 1]),
        history: строкаВСписок_(r[О.ИСТОРИЯ - 1])
      };
    });
    return { ok: true, nodes: nodes, stamp: версия_() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function строкаВСписок_(v) {
  return String(v || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
}
function списокВСтроку_(v) {
  return Array.isArray(v) ? v.join('\n') : String(v || '');
}

function orgAddNode_(d) {
  var id = String(d.id || '').trim();
  var parent = String(d.parent || '').trim();
  var name = String(d.name || '').trim();
  if (!id || !parent || !name) return { ok: false, error: 'не хватает id/parent/name' };
  var sh = листОрг_();
  if (найтиСтрокуОрг_(sh, id)) return { ok: false, error: 'узел с таким id уже есть' };
  if (!найтиСтрокуОрг_(sh, parent)) return { ok: false, error: 'родитель не найден' };
  sh.appendRow([id, parent, name, '', '', '', '', '', new Date(), d.mail || '', '', '', '', '', '', '', '', '']);
  добавитьВИсторию_(sh, sh.getLastRow(), 'Создано', d.mail);
  return { ok: true, stamp: увеличитьВерсию_() };
}

function orgUpdateFields_(d) {
  var id = String(d.id || '').trim();
  if (!id) return { ok: false, error: 'id пустой' };
  var sh = листОрг_();
  var номер = найтиСтрокуОрг_(sh, id);
  if (!номер) return { ok: false, error: 'узел не найден' };
  sh.getRange(номер, О.НАЗВАНИЕ, 1, 6).setValues([[
    d.name || '', d.purpose || '', списокВСтроку_(d.domains), списокВСтроку_(d.accountabilities),
    d.notes || '', списокВСтроку_(d.assignees)
  ]]);
  sh.getRange(номер, О.ОБНОВЛЕНО, 1, 2).setValues([[new Date(), d.mail || '']]);
  if (d.photo !== undefined) sh.getRange(номер, О.ФОТО).setValue(d.photo || '');
  sh.getRange(номер, О.ПОЛИТИКИ, 1, 6).setValues([[
    списокВСтроку_(d.policies), списокВСтроку_(d.projects), списокВСтроку_(d.checklist),
    списокВСтроку_(d.goals), списокВСтроку_(d.metrics), списокВСтроку_(d.attachments)
  ]]);
  добавитьВИсторию_(sh, номер, d.changeLabel || 'Изменено', d.mail);
  return { ok: true, stamp: увеличитьВерсию_() };
}

function orgReparent_(d) {
  var id = String(d.id || '').trim();
  var newParent = String(d.parent || '').trim();
  if (!id || !newParent) return { ok: false, error: 'не хватает id/parent' };
  if (id === newParent) return { ok: false, error: 'нельзя переместить узел в самого себя' };
  if (id === 'root') return { ok: false, error: 'у корня не может быть родителя' };
  var sh = листОрг_();
  var номер = найтиСтрокуОрг_(sh, id);
  if (!номер) return { ok: false, error: 'узел не найден' };
  if (!найтиСтрокуОрг_(sh, newParent)) return { ok: false, error: 'новый родитель не найден' };
  if (орг_являетсяПотомком_(sh, newParent, id)) {
    return { ok: false, error: 'нельзя переместить круг внутрь собственного потомка' };
  }
  sh.getRange(номер, О.РОДИТЕЛЬ).setValue(newParent);
  sh.getRange(номер, О.ОБНОВЛЕНО, 1, 2).setValues([[new Date(), d.mail || '']]);
  добавитьВИсторию_(sh, номер, 'Перемещено', d.mail);
  return { ok: true, stamp: увеличитьВерсию_() };
}

/** true, если candidateId — это сам ancestorId или лежит в его поддереве
    (используется, чтобы нельзя было перенести круг сам в себя). */
function орг_являетсяПотомком_(sh, candidateId, ancestorId) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var rows = sh.getRange(2, 1, last - 1, ШАПКА_ОРГ.length).getValues();
  var родительПо = {};
  rows.forEach(function (r) { родительПо[String(r[О.ID - 1])] = String(r[О.РОДИТЕЛЬ - 1]); });
  var cur = String(candidateId);
  var guard = 0;
  while (cur && guard++ < 1000) {
    if (cur === String(ancestorId)) return true;
    cur = родительПо[cur];
  }
  return false;
}

function orgDelete_(d) {
  var id = String(d.id || '').trim();
  if (!id) return { ok: false, error: 'id пустой' };
  if (id === 'root') return { ok: false, error: 'нельзя удалить корень' };
  var sh = листОрг_();
  var last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'узел не найден' };
  var rows = sh.getRange(2, 1, last - 1, ШАПКА_ОРГ.length).getValues();

  var byParent = {};
  rows.forEach(function (r) {
    var rparent = String(r[О.РОДИТЕЛЬ - 1]);
    (byParent[rparent] = byParent[rparent] || []).push(String(r[О.ID - 1]));
  });

  var idsToDelete = {};
  var stack = [id];
  while (stack.length) {
    var cur = stack.pop();
    idsToDelete[cur] = true;
    (byParent[cur] || []).forEach(function (childId) { stack.push(childId); });
  }
  if (!idsToDelete[id]) return { ok: false, error: 'узел не найден' };

  var rowsToDelete = [];
  rows.forEach(function (r, i) {
    if (idsToDelete[String(r[О.ID - 1])]) rowsToDelete.push(i + 2);
  });
  // снизу вверх — иначе после первого deleteRow номера остальных строк съедут
  rowsToDelete.sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (rowNum) { sh.deleteRow(rowNum); });

  return { ok: true, stamp: увеличитьВерсию_(), deleted: rowsToDelete.length };
}

/* =============================  ИТОГИ ВСТРЕЧ  ============================== */

function обработатьИтоги_(action, d) {
  switch (action) {
    case 'meetingAdd': return meetingAdd_(d);
    case 'meetingDelete': return meetingDelete_(d);
  }
  return { ok: false, error: 'неизвестное действие' };
}

function списокИтогов_() {
  try {
    var sh = листИтоги_();
    var last = sh.getLastRow();
    if (last < 2) return { ok: true, items: [], stamp: версия_() };
    var rows = sh.getRange(2, 1, last - 1, ШАПКА_ИТОГИ.length).getValues();
    var items = rows.filter(function (r) { return String(r[И.ID - 1]).trim(); }).map(function (r) {
      return {
        id: r[И.ID - 1], type: r[И.ТИП - 1], date: fmt_(r[И.ДАТА - 1]),
        text: r[И.ТЕКСТ - 1] || '', attachments: строкаВСписок_(r[И.ВЛОЖЕНИЯ - 1]),
        author: r[И.АВТОР - 1] || '', createdAt: fmt_(r[И.СОЗДАНО - 1])
      };
    });
    return { ok: true, items: items, stamp: версия_() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function meetingAdd_(d) {
  var mail = String(d.mail || '').trim();
  if (!mail) return { ok: false, error: 'нет почты' };
  var type = String(d.type || '').trim();
  if (ТИПЫ_ИТОГОВ.indexOf(type) === -1) return { ok: false, error: 'неизвестный тип встречи' };
  var text = String(d.text || '');
  if (!text.replace(/<[^>]*>/g, '').trim()) return { ok: false, error: 'пустой текст итога' };
  var id = String(d.id || '').trim();
  if (!id) return { ok: false, error: 'id пустой' };
  var sh = листИтоги_();
  if (найтиСтрокуИтоги_(sh, id)) return { ok: false, error: 'запись с таким id уже есть' };
  sh.appendRow([id, type, d.date || '', text, списокВСтроку_(d.attachments), mail, new Date()]);
  return { ok: true, stamp: увеличитьВерсию_() };
}

function meetingDelete_(d) {
  var id = String(d.id || '').trim();
  var mail = String(d.mail || '').trim().toLowerCase();
  if (!id) return { ok: false, error: 'id пустой' };
  var sh = листИтоги_();
  var номер = найтиСтрокуИтоги_(sh, id);
  if (!номер) return { ok: false, error: 'запись не найдена' };
  var автор = String(sh.getRange(номер, И.АВТОР).getValue() || '').trim().toLowerCase();
  if (автор !== mail && !этоАдминОрг_(mail)) return { ok: false, error: 'удалить может только автор записи или админ' };
  sh.deleteRow(номер);
  return { ok: true, stamp: увеличитьВерсию_() };
}
