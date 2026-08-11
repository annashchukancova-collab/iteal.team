/**
 * iTeal — приём результатов теста талантов в Google Sheets.
 *
 * Структура таблицы (см. README.md, "Как получать ответы кандидатов"):
 *   - 2 вкладки: "Сотрудники iTeal" (email на @iteal.expert) и "Кандидаты"
 *     (все остальные) — определяется по домену почты автоматически.
 *   - Столбец A на обеих вкладках — фиксированный список всех 34 талантов,
 *     разбитый на 4 направления (цветные строки-заголовки).
 *   - Каждое прохождение теста добавляет НОВЫЙ СТОЛБЕЦ: ФИО / email / дата
 *     в первых трёх строках, дальше — процент по каждому таланту.
 *   - Пять ведущих талантов конкретного человека подсвечены заливкой
 *     (HIGHLIGHT_COLOR) в его столбце.
 *   - Ответы мини-кейса (kind: "case") идут отдельно, простым списком
 *     строк на вкладку "Мини-кейс" — там нет матрицы, разбирать текстовые
 *     ответы всё равно вручную.
 *
 * Установка:
 *   1. Создать пустую Google Sheet.
 *   2. Extensions → Apps Script, стереть содержимое Code.gs, вставить
 *      целиком этот файл, сохранить.
 *   3. В выпадающем списке функций выбрать initSheets и нажать Run —
 *      один раз, чтобы создать обе вкладки с готовой разметкой. Google
 *      запросит разрешения — это нормально, скрипт работает только с
 *      этой таблицей.
 *   4. Deploy → New deployment → тип "Web app". Execute as: Me.
 *      Who has access: Anyone. Скопировать выданный URL.
 *   5. Вставить этот URL в константу WEBHOOK_URL в index.html.
 *
 * Если поменяете список тем/доменов в index.html (массивы THEMES/DOMAINS) —
 * обновите те же массивы здесь, они продублированы намеренно: Apps Script
 * выполняется отдельно от страницы и не может импортировать её данные.
 */

var SHEET_INTERNAL = "Сотрудники iTeal";
var SHEET_EXTERNAL = "Кандидаты";
var SHEET_CASE = "Мини-кейс";
var SHEET_ROUTEMAP = "Адаптация";
var INTERNAL_EMAIL_SUFFIX = "@iteal.expert";

var HIGHLIGHT_COLOR = "#FFE9A8"; // заливка топ-5 талантов конкретного человека
var HEADER_ROWS = 3;             // строки 1-3 = ФИО / email / дата прохождения

var DOMAINS = [
  { id: "execution", name: "ИСПОЛНЕНИЕ", color: "#4a3aa7" },
  { id: "influence", name: "ВЛИЯНИЕ",    color: "#eb6834" },
  { id: "relations", name: "ОТНОШЕНИЯ",  color: "#2a78d6" },
  { id: "thinking",  name: "МЫШЛЕНИЕ",   color: "#1baf7a" }
];

// Порядок и группировка — как в THEMES в index.html.
var THEMES = [
  { id: "finisher",     domain: "execution", name: "Доводчик" },
  { id: "organizer",    domain: "execution", name: "Собранность" },
  { id: "discipline",   domain: "execution", name: "Дисциплина" },
  { id: "ownership",    domain: "execution", name: "Ответственность" },
  { id: "precision",    domain: "execution", name: "Точность" },
  { id: "momentum",     domain: "execution", name: "Скорость" },
  { id: "endurance",    domain: "execution", name: "Выносливость" },
  { id: "efficiency",   domain: "execution", name: "Экономность" },
  { id: "troubleshoot", domain: "execution", name: "Восстановление" },

  { id: "initiator",  domain: "influence", name: "Инициативность" },
  { id: "persuader",  domain: "influence", name: "Убедительность" },
  { id: "competitor", domain: "influence", name: "Соревновательность" },
  { id: "selfbelief", domain: "influence", name: "Уверенность в себе" },
  { id: "ambition",   domain: "influence", name: "Значимость" },
  { id: "commander",  domain: "influence", name: "Лидерство" },
  { id: "charisma",   domain: "influence", name: "Обаяние" },
  { id: "voice",      domain: "influence", name: "Голос" },

  { id: "empathy",    domain: "relations", name: "Эмпатия" },
  { id: "harmony",    domain: "relations", name: "Гармония" },
  { id: "includer",   domain: "relations", name: "Включённость" },
  { id: "relator",    domain: "relations", name: "Близость" },
  { id: "fairness",   domain: "relations", name: "Справедливость" },
  { id: "mentor",     domain: "relations", name: "Наставничество" },
  { id: "positivity", domain: "relations", name: "Позитив" },
  { id: "connector",  domain: "relations", name: "Связность" },

  { id: "analyst",     domain: "thinking", name: "Аналитика" },
  { id: "strategist",  domain: "thinking", name: "Стратегия" },
  { id: "ideator",     domain: "thinking", name: "Идеи" },
  { id: "learner",     domain: "thinking", name: "Любознательность" },
  { id: "focus",       domain: "thinking", name: "Погружение" },
  { id: "futurist",    domain: "thinking", name: "Взгляд вперёд" },
  { id: "historian",   domain: "thinking", name: "Контекст" },
  { id: "deliberator", domain: "thinking", name: "Вдумчивость" },
  { id: "principled",  domain: "thinking", name: "Убеждения" }
];

/* =========================================================
   Разметка листа: список строк сверху вниз (заголовки доменов +
   темы в фиксированном порядке) и обратная карта id темы -> номер
   строки, чтобы doPost() знал, куда писать конкретный процент.
   ========================================================= */
function buildLayout() {
  var rows = [];
  DOMAINS.forEach(function (d) {
    rows.push({ type: "domain", domainId: d.id });
    THEMES.filter(function (t) { return t.domain === d.id; }).forEach(function (t) {
      rows.push({ type: "theme", id: t.id, name: t.name });
    });
  });
  var rowOfId = {};
  rows.forEach(function (r, i) {
    if (r.type === "theme") rowOfId[r.id] = HEADER_ROWS + i + 1;
  });
  return { rows: rows, rowOfId: rowOfId };
}

function getOrCreateSheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

/** Полностью пересобирает разметку столбца A на листе (стирает столбцы с людьми!). */
function setupSheet(sh) {
  sh.clear();
  var layout = buildLayout();

  sh.getRange(1, 1).setValue("ФИО →");
  sh.getRange(2, 1).setValue("Email");
  sh.getRange(3, 1).setValue("Дата прохождения");
  sh.getRange(1, 1, HEADER_ROWS, 1).setFontWeight("bold");

  layout.rows.forEach(function (r, i) {
    var row = HEADER_ROWS + i + 1;
    if (r.type === "domain") {
      var domain = DOMAINS.filter(function (d) { return d.id === r.domainId; })[0];
      var cell = sh.getRange(row, 1);
      cell.setValue(domain.name);
      cell.setBackground(domain.color);
      cell.setFontColor("#FFFFFF");
      cell.setFontWeight("bold");
    } else {
      sh.getRange(row, 1).setValue(r.name);
    }
  });

  sh.setColumnWidth(1, 200);
  sh.setFrozenRows(HEADER_ROWS);
  sh.setFrozenColumns(1);
}

/** Запустить один раз вручную (Run → initSheets) перед первым деплоем. */
function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  setupSheet(getOrCreateSheet(ss, SHEET_INTERNAL));
  setupSheet(getOrCreateSheet(ss, SHEET_EXTERNAL));
  getOrCreateSheet(ss, SHEET_CASE);
  getOrCreateSheet(ss, SHEET_ROUTEMAP);
}

var ROUTEMAP_HEADER = [
  "ФИО", "Роль", "Наставник", "Дата приёма", "Почта", "% пройдено",
  "Шагов отмечено", "Шагов всего", "Самообучение отмечено", "Самообучение всего",
  "Текущий шаг", "Балл", "Обновлено"
];

/** Одна строка на человека: находит по ФИО (колонка A) и перезаписывает
 *  на месте, а не добавляет новую — карта шлёт обновление на каждую
 *  отметку шага, и это должно быть текущее состояние, а не журнал событий. */
function upsertRoutemapRow(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet(ss, SHEET_ROUTEMAP);
  if (sh.getRange(1, 1).getValue() !== "ФИО") {
    sh.clear();
    sh.getRange(1, 1, 1, ROUTEMAP_HEADER.length).setValues([ROUTEMAP_HEADER]).setFontWeight("bold").setBackground("#E7F1EC");
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 200);
  }

  var fio = data.фио || "";
  if (!fio) return;
  var lastRow = sh.getLastRow();
  var row = 0;
  if (lastRow > 1) {
    var names = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (names[i][0] === fio) { row = i + 2; break; }
    }
  }
  if (!row) row = lastRow + 1;

  var values = [
    // data.pct — уже целое число 0-100 (не доля 0-1), поэтому пишем как
    // текст "35%", а не числом с форматом "0%" (тот умножает на 100 сам).
    fio, data.role || "", data.mentor || "", data.hired || "", data.mail || "",
    (data.pct || 0) + "%", data.stepsDone || 0, data.stepsTotal || 0,
    data.studyDone || 0, data.studyTotal || 0, data.currentStep || "", data.score || "",
    new Date()
  ];
  var range = sh.getRange(row, 1, 1, values.length);
  range.setValues([values]);
  range.getCell(1, 13).setNumberFormat("dd.mm.yyyy hh:mm");
}

function isInternalEmail(email) {
  return (email || "").toLowerCase().trim().endsWith(INTERNAL_EMAIL_SUFFIX);
}

function appendTalentsColumn(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = isInternalEmail(data.email) ? SHEET_INTERNAL : SHEET_EXTERNAL;
  var sh = getOrCreateSheet(ss, sheetName);
  if (sh.getRange(1, 1).getValue() !== "ФИО →") setupSheet(sh); // на случай, если initSheets не запускали

  var layout = buildLayout();
  var col = Math.max(sh.getLastColumn() + 1, 2);

  sh.getRange(1, col).setValue(data.name || "");
  sh.getRange(2, col).setValue(data.email || "");
  var dateCell = sh.getRange(3, col);
  dateCell.setValue(new Date());
  dateCell.setNumberFormat("dd.mm.yyyy hh:mm");

  var top5Ids = {};
  (data.top5 || []).forEach(function (t) { top5Ids[t.id] = true; });

  (data.full || []).forEach(function (t) {
    var row = layout.rowOfId[t.id];
    if (!row) return; // неизвестный id темы — пропускаем, не должно случаться при синхронных списках
    var cell = sh.getRange(row, col);
    cell.setValue(t.pct / 100);
    cell.setNumberFormat("0%");
    if (top5Ids[t.id]) cell.setBackground(HIGHLIGHT_COLOR);
  });

  sh.autoResizeColumn(col);
}

/* ==============================  ТЕЛЕГРАМ  =================================
 * Настройка (один раз, вручную, в редакторе Apps Script этого же проекта):
 *   Файл → Настройки проекта → Свойства скрипта → добавить:
 *     TG_BOT_TOKEN     — токен бота от @BotFather
 *     TG_HR_CHAT_ID    — chat_id того, кто ведёт учёт отпусков
 *     TG_TEAM_CHAT_ID  — chat_id группового чата команды
 *   Если какое-то свойство не заполнено — уведомление в этот адрес просто
 *   не отправляется, остальная обработка не ломается. Перенесено из старого
 *   Маршрутные-карты.gs — тот же бот, тот же принцип. */
function отправитьВТелеграм_(chatId, text) {
  if (!chatId) return;
  var token = PropertiesService.getScriptProperties().getProperty('TG_BOT_TOKEN');
  if (!token) return;
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: text }),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('Не получилось отправить в Telegram: %s', err);
  }
}

function уведомитьОтпуск_(data) {
  var text = (data.employee || 'Кто-то') + ' уходит в отпуск: ' + (data.start || '?') + '–' + (data.end || '?') +
    (data.comment ? '\nКомментарий: ' + data.comment : '');
  var props = PropertiesService.getScriptProperties();
  отправитьВТелеграм_(props.getProperty('TG_HR_CHAT_ID'), '📋 Новый отпуск в графике.\n' + text);
  отправитьВТелеграм_(props.getProperty('TG_TEAM_CHAT_ID'), '🏖 ' + text);
}

function appendCaseRow(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet(ss, SHEET_CASE);
  if (sh.getLastRow() === 0) {
    sh.appendRow(["Дата", "ФИО", "Email", "Секунд на кейс", "Открыл контекст", "Пропустил", "Ответ"]);
    sh.getRange(1, 1, 1, 7).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  sh.appendRow([
    new Date(), data.name || "", data.email || "",
    data.seconds, data.expandedContext, data.skipped, data.answer || ""
  ]);
}

function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  if (data.kind === "case") {
    appendCaseRow(data);
  } else if (data.kind === "talents") {
    appendTalentsColumn(data);
  } else if (data.kind === "routemap") {
    upsertRoutemapRow(data);
  } else if (data.kind === "vacation") {
    уведомитьОтпуск_(data);
  }
  // другие kind (например, если появятся в будущем) — молча игнорируются

  return ContentService.createTextOutput("ok");
}

// Сайт всегда шлёт POST (doPost выше) — doGet тут только для того, чтобы
// открытие ссылки веб-приложения в браузере (это GET-запрос) не падало с
// "Не удалось найти функцию скрипта: doGet", а показывало внятный ответ.
function doGet(e) {
  return ContentService.createTextOutput(
    "Вебхук iTeal работает. Он принимает только POST-запросы от сайта теста, " +
    "просто открыть эту ссылку в браузере — нормально, но данные так не отправить."
  );
}
