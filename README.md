# SIMON RP — GitHub Pages + Supabase

Русскоязычный Telegram Mini App: статический интерфейс на GitHub Pages, PostgreSQL и защищённый API на Supabase Edge Functions. Проект не требует отдельного Node.js-сервера. Node.js нужен только локально для тестов; Supabase выполняет серверные операции, проверяет Telegram `initData` и хранит данные.

## Что включено

- Кабинет, до трёх персонажей, RP-профиль, фото и возраст.
- Паспортные и медицинские заявки, история решений, автомобильный/воздушный/оружейный тесты и документы.
- Пять автомобильных слотов, бесплатные варианты по одному разу на слот, оплачиваемые номера и резерв, поиск номеров с разрешением.
- Семьи с приглашениями, лидерством и лимитом участников.
- Профессии, игровые выплаты с серверным cooldown, игровой баланс и переводы, каталог игрового имущества.
- Серверная вкладка, достижения, статистика, внутриигровые уведомления и админ-панель с RBAC.
- Проверка `initData` по Telegram HMAC на Edge Function. Браузерный `user_id` не используется для входа.

Значения экономики и каталог имущества — внутриигровые примеры, заданные seed-миграцией. Синхронизации с Roblox API нет: действия и имущество отражаются в веб-приложении и отыгрываются игроками в Brookhaven. Уведомления внутри приложения работают через БД; Telegram-сообщения отправляются только когда настроен Bot Token. Telegram Stars выключены по умолчанию.

## Состав проекта

- `public/` — статический сайт, пути к ресурсам относительные для URL вида `https://USERNAME.github.io/REPOSITORY/`.
- `supabase/migrations/` — схема, ограничения, индексы, RLS и серверные RPC.
- `supabase/functions/simon-api/` — Mini App API с проверкой Telegram `initData`.
- `supabase/functions/telegram-webhook/` — `/start` и подтверждённый платёжный webhook.
- `supabase/functions/_shared/telegram-auth.mjs` — HMAC проверка Telegram WebApp initData.
- `.github/workflows/pages.yml` — публикация `public/` через GitHub Pages Actions.
- `.env.example` — имена настроек без настоящих секретов.

## 1. Создайте Supabase проект

1. Создайте проект Supabase и сохраните Project URL, anon/publishable key и database password у себя.
2. В SQL Editor выполните файл `supabase/migrations/202611220001_initial_schema.sql` целиком. Миграция создаёт таблицы, связи, ограничения, индексы, RPC-функции, RLS и демонстрационный каталог без пользовательских данных.
3. В Supabase → Edge Functions включите деплой функций `simon-api` и `telegram-webhook`. Через CLI из корня проекта это можно сделать так:

   ```sh
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   npx supabase functions deploy simon-api --no-verify-jwt
   npx supabase functions deploy telegram-webhook --no-verify-jwt
   ```

   CLI запросит привязку проекта и пароль БД. `--no-verify-jwt` необходим, потому что обе функции используют собственную проверку: Mini App проверяется по Telegram HMAC, webhook — по Telegram secret header. Все защищённые вызовы `simon-api` всё равно требуют корректный `initData`.
4. Если применили SQL вручную через Dashboard, пропустите `supabase db push`, чтобы не запускать ту же миграцию повторно.

## 2. Настройте секреты Edge Functions

Добавьте через Supabase Dashboard → Edge Functions → Secrets (или `npx supabase secrets set KEY=value`) значения:

| Переменная | Значение |
| --- | --- |
| `BOT_TOKEN` | Токен бота из BotFather. Только в secrets Supabase. |
| `OWNER_TELEGRAM_ID` | Telegram ID владельца проекта. При первом Mini App запросе он получает OWNER. Не задавайте ID из недоверенного запроса. |
| `PUBLIC_APP_URL` | Полный HTTPS URL Pages, включая завершающий `/`. |
| `TELEGRAM_WEBHOOK_SECRET` | Случайная строка для проверки заголовка Telegram webhook. Создайте самостоятельно и не публикуйте. |
| `TELEGRAM_INITDATA_MAX_AGE_SECONDS` | Срок годности initData; рекомендуемое значение `86400`. |
| `TELEGRAM_STARS_ENABLED` | Оставьте `false`, пока отдельно не решите включать оплату и не проверите настройки webhook. |
| `ROBLOX_SERVER_URL` | Необязательно: ссылка на сервер Brookhaven RP. |
| `ADMIN_CONTACT_URL` | Необязательно: ссылка контакта администрации. |

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` доступны функциям как системные настройки проекта Supabase. Никогда не добавляйте service role key в GitHub, `public/config.js`, HTML или ZIP. Не выдавайте права владельца, указав чужой ID.

## 3. Настройте GitHub Pages

1. Создайте приватный или публичный GitHub-репозиторий и загрузите содержимое ZIP в корень репозитория. Не загружайте `.env`, локальные базы или пользовательские данные.
2. В Settings → Secrets and variables → Actions → Variables добавьте:
   - `SUPABASE_URL` — Project URL, например `https://project-ref.supabase.co`;
   - `SUPABASE_ANON_KEY` — публичный anon/publishable key.
3. В Settings → Pages выберите публикацию через **GitHub Actions**.
4. Запустите workflow `Deploy SIMON RP to GitHub Pages` через Actions или отправьте commit в ветку `main`.
5. После публикации скопируйте Pages URL и задайте его как `PUBLIC_APP_URL` в Supabase Secrets. Откройте страницу и проверьте, что `public/config.js` содержит URL и anon key. Этот ключ публичный и защищён RLS; service role key не используется.

Сайт использует относительные пути и не требует SPA rewrite, поэтому работает в подпапке репозитория. GitHub Pages обслуживает только frontend; PostgreSQL/API доступны через Supabase HTTPS endpoint.

## 4. Подключите Telegram Mini App

1. В BotFather настройте Mini App / Web App URL на опубликованный HTTPS Pages URL.
2. Установите webhook на функцию `telegram-webhook` с secret token. URL вида `https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-webhook`.
3. Заголовок проверки Telegram должен совпадать с `TELEGRAM_WEBHOOK_SECRET`. Для `setWebhook` передавайте его параметром `secret_token`. Не вставляйте токен бота в команды, сохраняемые в истории терминала; используйте безопасный локальный способ ввода.
4. Запустите `/start` и проверьте кнопку «Открыть приложение». В Mini App разрешите загрузку страницы внутри Telegram.
5. Первое открытие Mini App создаёт профиль из проверенных Telegram данных. Для доступа к OWNER должен совпасть только серверный `OWNER_TELEGRAM_ID`.

Вне Telegram приложение не авторизует пользователя. Это ожидаемое поведение: серверу требуется подписанный Telegram `initData`.

## Платежи Telegram Stars

Stars отключены по умолчанию (`TELEGRAM_STARS_ENABLED=false`) и не отправляют счета. Тесты не выполняют реальные платежи. Не включайте настройку до проверки webhook, HTTPS URL, BotFather и требований Telegram. После включения сервер проверяет владельца, сумму, валюту XTR, срок заказа, уникальность номера и успешное событие оплаты; повторные успешные webhook updates обрабатываются идемпотентным SQL RPC. Telegram Stars нельзя использовать через локальный фиктивный результат.

## Локальная проверка

Нужен Node.js 20 или новее.

```sh
npm test
```

Локальная страница может быть открыта статическим сервером, но полноценная авторизация и API заработают только после настройки Supabase, Edge Functions и запуска внутри Telegram Mini App. Этот проект намеренно не содержит demo-обхода авторизации.

## Безопасность и эксплуатация

- RLS включён на таблицах. Клиентские роли не получают прямые права на таблицы; операции идут через Edge Function с серверным ключом.
- Роль и permissions извлекаются из профиля БД, не из frontend payload. Владелец назначается только по `OWNER_TELEGRAM_ID`; администраторы не могут повышать права.
- API проверяет возраст, владение персонажем и доступ к админ-действиям на сервере.
- Номер телефона или реальные медицинские сведения не собираются: медкарта относится к вымышленным характеристикам персонажа.
- Делайте резервные копии Supabase через Dashboard/CLI до изменения схемы. Храните экспорт в защищённом месте.
- Supabase Free имеет собственные ограничения квот, приостановки неактивных проектов и хранения; условия могут меняться. Проверьте текущие лимиты в своём Supabase Dashboard перед запуском сообщества. GitHub Pages не предоставляет серверных задач; периодические напоминания о неактивности в этом пакете не запускаются по расписанию.

## Известные границы этой сборки

- Проверка локально покрывает HMAC initData и статические настройки проекта. Реальную интеграцию можно подтвердить только после конфигурации вашего Supabase, деплоя функций и проверки из Telegram.
- GitHub Pages и Supabase — внешние сервисы: в ZIP нет созданного облачного проекта, ключей, бота, webhook или реальной Roblox ссылки.
- Для накопительных периодических напоминаний потребуется Supabase Cron/pg_cron или отдельная настройка расписания Edge Function; это не выполняется самим GitHub Pages.
- Пользовательская авторизация — собственная проверка Telegram initData внутри Edge Function, а не Supabase Auth JWT session. Все API запросы всё равно проходят серверную проверку подписи Telegram.
- Код Edge Functions использует Deno и импорт `npm:@supabase/supabase-js@2`; деплой/проверка runtime должны выполняться Supabase CLI или Supabase Edge Runtime. Локальный Node тест не эмулирует Edge Runtime.

## Файлы, которые нельзя коммитить

`.gitignore` исключает `.env`, локальные настройки, `node_modules`, `data/`, `backups/`, SQLite и ZIP-архивы. В репозиторий отправляйте только исходники и миграции. Публичный Supabase anon key — единственный ключ, который workflow помещает во frontend.
