-- SIMON RP Supabase schema. Browser clients have no direct table access;
-- protected operations are performed by Edge Functions using service_role.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null unique,
  username text,
  first_name text not null default '',
  role text not null default 'player' check (role in ('player','admin','owner')),
  permissions text[] not null default '{}',
  search_access boolean not null default false,
  balance bigint not null default 0 check (balance >= 0),
  last_active timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  full_name text not null check (length(trim(full_name)) between 2 and 100),
  age smallint not null check (age between 1 and 120),
  photo text,
  roblox_username text not null check (length(trim(roblox_username)) between 1 and 40),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists characters_profile_active on public.characters(profile_id) where deleted_at is null;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id),
  type text not null check (type in ('passport','medical','car','air','weapon')),
  status text not null default 'approved' check (status in ('approved','review_required')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(character_id,type)
);
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id),
  type text not null check (type in ('passport','medical','weapon')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  payload jsonb not null default '{}',
  reason text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists applications_status_created on public.applications(status,created_at desc);
create unique index if not exists applications_one_pending_per_type on public.applications(character_id,type) where status='pending';

create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('car','air','weapon')),
  question text not null,
  options jsonb not null check (jsonb_array_length(options)=4),
  correct smallint not null check (correct between 0 and 3),
  created_at timestamptz not null default now()
);
create index if not exists quiz_questions_kind on public.quiz_questions(kind,created_at,id);
create table if not exists public.quiz_results (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id),
  kind text not null check (kind in ('car','air','weapon')),
  score smallint not null check (score between 0 and 5),
  passed boolean not null,
  created_at timestamptz not null default now()
);

create table if not exists public.plates (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references public.profiles(id),
  character_id uuid references public.characters(id),
  slot smallint check (slot between 1 and 5),
  region text not null,
  value text not null,
  kind text not null check (kind in ('free','paid')),
  status text not null default 'reserve' check (status in ('pending_payment','reserve','assigned','void')),
  created_at timestamptz not null default now()
);
create unique index if not exists plates_active_value_unique on public.plates(value) where status in ('pending_payment','reserve','assigned');
create unique index if not exists plates_one_per_slot on public.plates(character_id,slot) where character_id is not null and status in ('pending_payment','assigned');
create table if not exists public.free_offers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  character_id uuid not null references public.characters(id),
  slot smallint not null check (slot between 1 and 5),
  region text not null,
  options jsonb not null check (jsonb_array_length(options)=3),
  used boolean not null default false,
  created_at timestamptz not null default now(),
  unique(character_id,slot)
);
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references public.profiles(id),
  plate_id uuid not null references public.plates(id),
  payload text not null unique,
  amount integer not null default 25 check (amount=25),
  currency text not null default 'XTR' check (currency='XTR'),
  status text not null default 'pending' check (status in ('pending','paid','expired','canceled')),
  invoice_status text not null default 'not_sent' check (invoice_status in ('not_sent','sending','sent')),
  invoice_message_id bigint,
  telegram_charge_id text unique,
  payer_telegram_id text,
  expires_at timestamptz not null default (now()+interval '15 minutes'),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(trim(name)) between 1 and 50),
  leader_character_id uuid not null references public.characters(id),
  created_at timestamptz not null default now()
);
create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  character_id uuid not null unique references public.characters(id),
  status text not null default 'active' check(status in ('active','pending')),
  invited_by uuid references public.characters(id),
  created_at timestamptz not null default now(),
  primary key(family_id,character_id)
);
create table if not exists public.family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  character_id uuid not null references public.characters(id),
  invited_by uuid not null references public.characters(id),
  status text not null default 'pending' check(status in ('pending','accepted','rejected','canceled')),
  created_at timestamptz not null default now()
);
create unique index if not exists family_one_pending_invite on public.family_invites(family_id,character_id) where status='pending';

create table if not exists public.search_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  reason text,
  reviewed_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_profile_id uuid references public.profiles(id),
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created on public.audit_logs(created_at desc);
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  kind text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

-- Work, play-money ledger, vehicle/property inventory and progress.
create table if not exists public.professions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null,
  pay_amount bigint not null check(pay_amount between 1 and 100000),
  cooldown_hours smallint not null default 8 check(cooldown_hours between 1 and 168),
  active boolean not null default true
);
create table if not exists public.character_jobs (
  character_id uuid primary key references public.characters(id),
  profession_id uuid not null references public.professions(id),
  started_at timestamptz not null default now()
);
create table if not exists public.work_claims (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  character_id uuid not null references public.characters(id),
  profession_id uuid not null references public.professions(id),
  amount bigint not null,
  claimed_at timestamptz not null default now()
);
create index if not exists work_claims_character on public.work_claims(character_id,claimed_at desc);
create table if not exists public.money_ledger (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id),
  amount bigint not null check(amount<>0),
  balance_after bigint not null check(balance_after>=0),
  kind text not null check(kind in ('work','transfer_in','transfer_out','admin_adjustment','asset_purchase')),
  reference_id text,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists money_ledger_profile_date on public.money_ledger(profile_id,created_at desc);
create table if not exists public.asset_catalog (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('vehicle','property')),
  code text not null unique,
  name text not null,
  description text not null,
  price bigint not null check(price>=0),
  active boolean not null default true
);
create table if not exists public.character_assets (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id),
  catalog_id uuid not null references public.asset_catalog(id),
  status text not null default 'owned' check(status in ('owned','stored')),
  acquired_at timestamptz not null default now(),
  unique(character_id,catalog_id)
);
create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null,
  points integer not null default 0 check(points>=0)
);
create table if not exists public.character_achievements (
  character_id uuid not null references public.characters(id),
  achievement_id uuid not null references public.achievements(id),
  awarded_at timestamptz not null default now(),
  primary key(character_id,achievement_id)
);
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_unread on public.notifications(profile_id,created_at desc) where read_at is null;

-- Enforce the three-character cap under concurrent requests.
create or replace function public.enforce_character_limit() returns trigger language plpgsql as $$
begin
  perform 1 from public.profiles where id=new.profile_id for update;
  if (select count(*) from public.characters where profile_id=new.profile_id and deleted_at is null)>=3 then
    raise exception 'Максимум 3 персонажа' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists characters_limit on public.characters;
create trigger characters_limit before insert on public.characters for each row execute function public.enforce_character_limit();

create or replace function public.reject_history_mutation() returns trigger language plpgsql as $$
begin raise exception 'Исторические записи нельзя изменять или удалять'; end $$;
drop trigger if exists audit_logs_immutable on public.audit_logs;
create trigger audit_logs_immutable before update or delete on public.audit_logs for each row execute function public.reject_history_mutation();
drop trigger if exists money_ledger_immutable on public.money_ledger;
create trigger money_ledger_immutable before update or delete on public.money_ledger for each row execute function public.reject_history_mutation();

create or replace function public.transfer_money(p_sender uuid,p_recipient_telegram_id text,p_amount bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare sender public.profiles; recipient public.profiles;
begin
  if p_amount is null or p_amount<1 or p_amount>1000000 then raise exception 'Некорректная сумма'; end if;
  select * into sender from public.profiles where id=p_sender for update;
  select * into recipient from public.profiles where telegram_id=p_recipient_telegram_id for update;
  if sender.id is null or recipient.id is null then raise exception 'Игрок не найден'; end if;
  if sender.id=recipient.id then raise exception 'Нельзя переводить деньги самому себе'; end if;
  if sender.balance<p_amount then raise exception 'Недостаточно средств'; end if;
  update public.profiles set balance=balance-p_amount where id=sender.id returning * into sender;
  update public.profiles set balance=balance+p_amount where id=recipient.id returning * into recipient;
  insert into public.money_ledger(profile_id,amount,balance_after,kind,note) values
    (sender.id,-p_amount,sender.balance,'transfer_out','Перевод игроку'),
    (recipient.id,p_amount,recipient.balance,'transfer_in','Перевод от игрока');
  return jsonb_build_object('balance',sender.balance,'recipient',recipient.username);
end $$;

create or replace function public.claim_work(p_profile uuid,p_character uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job public.character_jobs; profession public.professions; owner_id uuid; last_claim timestamptz; new_balance bigint;
begin
  select profile_id into owner_id from public.characters where id=p_character and deleted_at is null for update;
  if owner_id is null or owner_id<>p_profile then raise exception 'Персонаж не найден'; end if;
  select * into job from public.character_jobs where character_id=p_character;
  if job.profession_id is null then raise exception 'Сначала выберите профессию'; end if;
  select * into profession from public.professions where id=job.profession_id and active;
  if profession.id is null then raise exception 'Профессия недоступна'; end if;
  select max(claimed_at) into last_claim from public.work_claims where character_id=p_character;
  if last_claim is not null and last_claim>now()-make_interval(hours=>profession.cooldown_hours) then raise exception 'Работа пока недоступна'; end if;
  insert into public.work_claims(profile_id,character_id,profession_id,amount) values(p_profile,p_character,profession.id,profession.pay_amount);
  update public.profiles set balance=balance+profession.pay_amount where id=p_profile returning balance into new_balance;
  insert into public.money_ledger(profile_id,amount,balance_after,kind,reference_id,note) values(p_profile,profession.pay_amount,new_balance,'work',p_character::text,profession.name);
  return jsonb_build_object('amount',profession.pay_amount,'balance',new_balance,'profession',profession.name);
end $$;

create or replace function public.purchase_asset(p_profile uuid,p_character uuid,p_catalog uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item public.asset_catalog; owner_id uuid; new_balance bigint; asset_id uuid;
begin
  select profile_id into owner_id from public.characters where id=p_character and deleted_at is null;
  if owner_id is null or owner_id<>p_profile then raise exception 'Персонаж не найден'; end if;
  select * into item from public.asset_catalog where id=p_catalog and active;
  if item.id is null then raise exception 'Объект недоступен'; end if;
  update public.profiles set balance=balance-item.price where id=p_profile and balance>=item.price returning balance into new_balance;
  if new_balance is null then raise exception 'Недостаточно средств'; end if;
  insert into public.character_assets(character_id,catalog_id) values(p_character,p_catalog) returning id into asset_id;
  insert into public.money_ledger(profile_id,amount,balance_after,kind,reference_id,note) values(p_profile,-item.price,new_balance,'asset_purchase',asset_id::text,item.name);
  return jsonb_build_object('assetId',asset_id,'balance',new_balance);
end $$;

create or replace function public.admin_adjust_balance(p_actor uuid,p_target uuid,p_amount bigint,p_note text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor_role text; target_balance bigint;
begin
  select role into actor_role from public.profiles where id=p_actor;
  if actor_role<>'owner' then raise exception 'Только владелец может менять баланс'; end if;
  if p_amount=0 or abs(p_amount)>100000000 then raise exception 'Некорректная сумма'; end if;
  update public.profiles set balance=balance+p_amount where id=p_target and balance+p_amount>=0 returning balance into target_balance;
  if target_balance is null then raise exception 'Игрок не найден или недостаточно средств'; end if;
  insert into public.money_ledger(profile_id,amount,balance_after,kind,note) values(p_target,p_amount,target_balance,'admin_adjustment',left(coalesce(p_note,''),200));
  return jsonb_build_object('balance',target_balance);
end $$;

create or replace function public.finalize_plate_payment(p_payload text,p_charge_id text,p_payer_telegram_id text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare payment public.payments; plate public.plates; owner_telegram text;
begin
  select * into payment from public.payments where payload=p_payload for update;
  if payment.id is null then raise exception 'Платёж не найден'; end if;
  if payment.status='paid' then return jsonb_build_object('duplicate',true); end if;
  if payment.status<>'pending' or payment.expires_at<=now() then raise exception 'Заказ истёк или отменён'; end if;
  if p_amount<>25 or p_currency<>'XTR' or payment.amount<>p_amount or payment.currency<>p_currency then raise exception 'Сумма или валюта платежа неверна'; end if;
  select telegram_id into owner_telegram from public.profiles where id=payment.owner_profile_id;
  if owner_telegram is distinct from p_payer_telegram_id then raise exception 'Плательщик не совпадает с владельцем заказа'; end if;
  select * into plate from public.plates where id=payment.plate_id for update;
  if plate.status<>'pending_payment' then raise exception 'Номер больше недоступен'; end if;
  if plate.character_id is not null then
    update public.plates set status='void',character_id=null,slot=null where character_id=plate.character_id and slot=plate.slot and kind='free' and status='assigned';
  end if;
  update public.plates set status='assigned' where id=plate.id;
  update public.payments set status='paid',telegram_charge_id=p_charge_id,payer_telegram_id=p_payer_telegram_id,paid_at=now() where id=payment.id;
  return jsonb_build_object('duplicate',false,'plateId',plate.id);
end $$;

-- Edge Function server-side only RPCs; browser roles cannot invoke privileged procedures.
revoke all on function public.transfer_money(uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.claim_work(uuid,uuid) from public,anon,authenticated;
revoke all on function public.purchase_asset(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.admin_adjust_balance(uuid,uuid,bigint,text) from public,anon,authenticated;
revoke all on function public.finalize_plate_payment(text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.transfer_money(uuid,text,bigint) to service_role;
grant execute on function public.claim_work(uuid,uuid) to service_role;
grant execute on function public.purchase_asset(uuid,uuid,uuid) to service_role;
grant execute on function public.admin_adjust_balance(uuid,uuid,bigint,text) to service_role;
grant execute on function public.finalize_plate_payment(text,text,text,integer,text) to service_role;

-- Seed data is fictional and contains no player data.
insert into public.settings(key,value) values('plate_regions','["77","78","99","50","150"]'::jsonb) on conflict(key) do nothing;
insert into public.professions(code,name,description,pay_amount,cooldown_hours) values
 ('courier','Курьер','Доставляйте заказы в рамках игровой RP-сцены.',120,8),
 ('medic','Медик','Помогайте участникам в согласованных игровых сценах.',160,8),
 ('mechanic','Механик','Обслуживайте транспорт в игровом RP-контексте.',140,8)
on conflict(code) do nothing;
insert into public.asset_catalog(kind,code,name,description,price) values
 ('vehicle','city-car','Городской автомобиль','Игровой актив персонажа; конкретная модель определяется в Brookhaven.',500),
 ('vehicle','utility-car','Утилитарный транспорт','Игровой актив персонажа для подходящих RP-сцен.',800),
 ('property','small-home','Небольшой дом','Запись об игровом имуществе персонажа.',700),
 ('property','family-home','Семейный дом','Запись об игровом имуществе семьи.',1200)
on conflict(code) do nothing;
insert into public.achievements(code,name,description,points) values
 ('first_character','Первая история','Создан первый RP-персонаж.',10),
 ('three_characters','Три истории','Созданы три активных персонажа.',25),
 ('first_document','Первый документ','Одобрен первый RP-документ.',15),
 ('first_job','Первая смена','Получена первая игровая выплата за работу.',10),
 ('first_family','Своя семья','Создана первая RP-семья.',15),
 ('first_asset','Первое имущество','Приобретён первый игровой актив.',10)
on conflict(code) do nothing;

insert into public.quiz_questions(kind,question,options,correct) values
 ('car','Как вести себя на дороге во время RP-сцены?','["Соблюдать знаки и договорённости сцены","Ехать по тротуару ради преимущества","Игнорировать других игроков","Покидать сцену без причины"]',0),
 ('car','Что сделать перед поворотом автомобиля?','["Резко пересечь встречную полосу","Остановиться посреди перекрёстка","Подать сигнал и убедиться, что манёвр безопасен","Не учитывать других участников"]',2),
 ('car','Как правильно отыграть остановку по требованию в RP?','["Уехать за пределы карты","Остановиться в безопасном месте и продолжить сцену","Сразу выйти из игры","Продолжать движение сквозь препятствия"]',1),
 ('car','Как вести себя при ДТП в игровой сцене?','["Скрыть столкновение и продолжить гонку","Удалить автомобиль из сцены","Требовать от другого игрока выйти","Остановиться и отыграть ситуацию по правилам сервера"]',3),
 ('car','Что важнее всего при совместной поездке?','["Уважать RP-сцену и правила сервера","Ехать быстрее всех любой ценой","Использовать транспорт вне правил","Не сообщать о своих действиях"]',0),
 ('air','Где по правилам RP нужно начинать полёт?','["В разрешённой игровой зоне, указанной правилами сервера","На занятой дороге","Внутри здания","В любой точке вопреки сцене"]',0),
 ('air','Что нужно сделать до вылета в RP?','["Начать взлёт сквозь других игроков","Убедиться, что зона свободна, и сообщить о вылете","Отключить взаимодействие","Не обращать внимания на сцену"]',1),
 ('air','Что делать, если место посадки занято?','["Садиться поверх другого транспорта","Сразу покинуть сервер","Выбрать свободную зону и согласовать посадку","Остановить сцену другим игрокам"]',2),
 ('air','Как завершить воздушную RP-сцену?','["Безопасно сесть в подходящей игровой зоне","Исчезнуть посреди сцены","Продолжать полёт вне карты","Игнорировать просьбы участников"]',0),
 ('air','Как действовать при споре о полёте?','["Остановить спор и обратиться к правилам или администрации","Продолжать спор через помехи сцене","Использовать транспорт для давления","Публиковать личные данные игрока"]',0),
 ('weapon','Когда в Brookhaven RP уместна лицензия на оружие?','["Только для согласованных игровых RP-сцен по правилам сервера","Для реального использования вне игры","Чтобы принуждать игроков к действиям","Для обхода модерации"]',0),
 ('weapon','Что сделать перед сценой с оружием в игре?','["Убедиться, что сцена разрешена правилами и участники понимают её","Начать сцену без предупреждения","Использовать предмет для травли","Игнорировать требования администрации"]',0),
 ('weapon','Как относиться к игровой броне?','["Это реальная защита вне игры","Это элемент персонажа, применяемый только в разрешённой RP-сцене","Способ отменить правила сервера","Повод не взаимодействовать с другими"]',1),
 ('weapon','Что делать, если участник не согласен продолжать сцену?','["Продолжать против его просьбы","Угрожать ему вне игры","Остановить сцену и обратиться к правилам проекта","Публиковать его контактные данные"]',2),
 ('weapon','Что означает одобренная лицензия SIMON RP?','["Внутриигровой RP-документ для Brookhaven","Реальное разрешение на оружие","Документ государственного образца","Разрешение нарушать правила Roblox"]',0);

-- Enable RLS everywhere. No browser policies are intentionally added.
do $$ declare t text; begin
  foreach t in array array['profiles','characters','documents','applications','quiz_questions','quiz_results','plates','free_offers','payments','families','family_members','family_invites','search_requests','audit_logs','activity_events','settings','professions','character_jobs','work_claims','money_ledger','asset_catalog','character_assets','achievements','character_achievements','notifications'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from anon, authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;
