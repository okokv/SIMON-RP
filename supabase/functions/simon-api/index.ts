import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyTelegramInitData } from '../_shared/telegram-auth.mjs';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const botToken = Deno.env.get('BOT_TOKEN') || '';
const ownerTelegramId = Deno.env.get('OWNER_TELEGRAM_ID') || '';
const maxInitAge = Number(Deno.env.get('TELEGRAM_INITDATA_MAX_AGE_SECONDS') || 86400);
const starsEnabled = Deno.env.get('TELEGRAM_STARS_ENABLED') === 'true';
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-telegram-init-data',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,PUT,OPTIONS',
  'access-control-max-age': '86400',
};
const platePattern = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/u;
const defaultRegions = ['77','97','99','177','197','777','78','98','178','50','90','150','750','23','93','123'];

class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function fail(status: number, message: string): never { throw new HttpError(status, message); }
async function body(req: Request) { try { return await req.json(); } catch { return fail(400, 'Некорректный JSON'); } }
async function rows(query: PromiseLike<any>) { const { data, error } = await query; if (error) throw new HttpError(400, error.message); return data; }
function ageAllowed(character: any, kind: string) { return kind === 'medical' || (kind === 'passport' ? character.age >= 14 : kind === 'car' || kind === 'air' ? character.age >= 16 : kind === 'weapon' ? character.age >= 18 : false); }
async function audit(actorId: string | null, action: string, details: Record<string, unknown> = {}) { await rows(db.from('audit_logs').insert({ actor_profile_id: actorId, action, details })); }
async function notify(profileId: string, title: string, message: string, telegramId?: string) {
  await rows(db.from('notifications').insert({ profile_id: profileId, title, body: message }));
  if (botToken && telegramId) {
    try { await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: Number(telegramId), text: `SIMON RP · ${title}\n${message}` }) }); } catch { /* Notifications remain in-app if Telegram is unavailable. */ }
  }
}
async function getProfile(req: Request) {
  if (!botToken) fail(503, 'Telegram авторизация пока не настроена');
  const initData = req.headers.get('x-telegram-init-data') || '';
  let tg: any;
  try { tg = await verifyTelegramInitData(initData, botToken, maxInitAge); }
  catch { fail(401, 'Telegram initData отсутствует, недействителен или истёк'); }
  const telegramId = String(tg.id);
  let profile = await rows(db.from('profiles').select('*').eq('telegram_id', telegramId).maybeSingle());
  if (!profile) {
    const role = ownerTelegramId && ownerTelegramId === telegramId ? 'owner' : 'player';
    profile = await rows(db.from('profiles').insert({ telegram_id: telegramId, username: tg.username || null, first_name: tg.first_name || '', role }).select('*').single());
  } else {
    const updates: Record<string, unknown> = { username: tg.username || null, first_name: tg.first_name || '', last_active: new Date().toISOString() };
    if (ownerTelegramId && ownerTelegramId === telegramId) updates.role = 'owner';
    profile = await rows(db.from('profiles').update(updates).eq('id', profile.id).select('*').single());
  }
  return profile;
}
async function ownedCharacter(profileId: string, id: string) {
  const c = await rows(db.from('characters').select('*').eq('id', id).eq('profile_id', profileId).is('deleted_at', null).maybeSingle());
  if (!c) fail(404, 'Персонаж не найден');
  return c;
}
function need(profile: any, permission: string) {
  if (profile.role === 'owner') return true;
  if (profile.role === 'admin' && (profile.permissions || []).includes(permission)) return true;
  if (permission === 'search' && profile.search_access) return true;
  return false;
}
function requirePermission(profile: any, permission: string) { if (!need(profile, permission)) fail(403, 'Недостаточно прав'); }
async function regions() { const setting = await rows(db.from('settings').select('value').eq('key', 'plate_regions').maybeSingle()); return setting?.value || ['77','78','99','50','150']; }
function randomPlate(region: string) { const letters = 'АВЕКМНОРСТУХ'; const p = () => letters[Math.floor(Math.random() * letters.length)]; return `${p()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}${p()}${p()}${region}`; }
async function award(characterId: string, code: string) {
  const item = await rows(db.from('achievements').select('id').eq('code', code).maybeSingle());
  if (item) await db.from('character_achievements').upsert({ character_id: characterId, achievement_id: item.id }, { onConflict: 'character_id,achievement_id', ignoreDuplicates: true });
}
async function handle(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/functions\/v1\/simon-api/, '') || '/';
  const method = req.method;
  if (method === 'GET' && path === '/api/config') return response({ name: 'SIMON RP', price: 25, starsEnabled, regions: await regions(), serverUrl: Deno.env.get('ROBLOX_SERVER_URL') || '', adminContact: Deno.env.get('ADMIN_CONTACT_URL') || '', demo: false });
  const profile = await getProfile(req);

  if (method === 'GET' && path === '/api/me') return response({ id: profile.id, tgId: profile.telegram_id, username: profile.username, firstName: profile.first_name, role: profile.role, searchAccess: profile.search_access, balance: profile.balance });
  if (method === 'GET' && path === '/api/characters') return response({ items: await rows(db.from('characters').select('*').eq('profile_id', profile.id).is('deleted_at', null).order('created_at')) });
  if (method === 'POST' && path === '/api/characters') {
    const b = await body(req);
    if (!b.fullName || !b.robloxUsername || !Number.isInteger(Number(b.age)) || Number(b.age) < 1 || Number(b.age) > 120) fail(400, 'Заполните ФИО, RP-возраст и Roblox username');
    const c = await rows(db.from('characters').insert({ profile_id: profile.id, full_name: String(b.fullName).trim().slice(0,100), age: Number(b.age), photo: b.photo || null, roblox_username: String(b.robloxUsername).trim().slice(0,40) }).select('id').single());
    await audit(profile.id, 'character.create', { characterId: c.id });
    const active = await rows(db.from('characters').select('id').eq('profile_id', profile.id).is('deleted_at', null));
    if (active.length === 1) await award(c.id, 'first_character');
    if (active.length === 3) await award(c.id, 'three_characters');
    return response({ id: c.id }, 201);
  }
  let match = path.match(/^\/api\/characters\/([0-9a-f-]+)(?:\/(.+))?$/i);
  if (match) {
    const c = await ownedCharacter(profile.id, match[1]); const sub = match[2] || '';
    if (method === 'PATCH' && !sub) {
      const b = await body(req); const changes: Record<string, unknown> = {};
      if (b.age !== undefined) { if (!Number.isInteger(Number(b.age)) || Number(b.age)<1 || Number(b.age)>120) fail(400,'Некорректный RP-возраст'); changes.age=Number(b.age); }
      if (b.fullName !== undefined) { if (!String(b.fullName).trim() || String(b.fullName).length>100) fail(400,'Некорректное ФИО'); changes.full_name=String(b.fullName).trim(); }
      if (b.robloxUsername !== undefined) { if (!String(b.robloxUsername).trim() || String(b.robloxUsername).length>40) fail(400,'Некорректный Roblox username'); changes.roblox_username=String(b.robloxUsername).trim(); }
      if (Object.hasOwn(b,'photo')) { if (b.photo && (!/^https:\/\//i.test(String(b.photo)) || String(b.photo).length>2000)) fail(400,'Укажите HTTPS-ссылку на фото'); changes.photo=b.photo || null; }
      await rows(db.from('characters').update(changes).eq('id',c.id));
      if (b.age !== undefined) {
        const docs=await rows(db.from('documents').select('type').eq('character_id',c.id).eq('status','approved'));
        for(const d of docs){const min=d.type==='passport'?14:d.type==='car'||d.type==='air'?16:d.type==='weapon'?18:0;if(Number(b.age)<min)await rows(db.from('documents').update({status:'review_required'}).eq('character_id',c.id).eq('type',d.type));}
        await audit(profile.id,'character.age_change',{characterId:c.id,age:Number(b.age)});
      }
      if (Object.keys(changes).some(k=>k!=='age')) await audit(profile.id,'character.profile_update',{characterId:c.id});
      return response({ ok:true });
    }
    if (method === 'DELETE' && !sub) {
      const memberships=await rows(db.from('family_members').select('family_id,families(leader_character_id)').eq('character_id',c.id));
      for(const m of memberships){if(m.families?.leader_character_id===c.id){const next=await rows(db.from('family_members').select('character_id').eq('family_id',m.family_id).neq('character_id',c.id).order('created_at').limit(1).maybeSingle());if(next)await rows(db.from('families').update({leader_character_id:next.character_id}).eq('id',m.family_id));else await rows(db.from('families').delete().eq('id',m.family_id));}}
      await rows(db.from('plates').update({status:'void',character_id:null,slot:null}).eq('character_id',c.id).eq('kind','free').eq('status','assigned'));
      await rows(db.from('free_offers').update({used:true}).eq('character_id',c.id));
      const pending=await rows(db.from('plates').select('id').eq('character_id',c.id).eq('status','pending_payment'));
      if(pending.length){await rows(db.from('payments').update({status:'canceled'}).in('plate_id',pending.map((p:any)=>p.id)));await rows(db.from('plates').update({status:'void',character_id:null,slot:null}).eq('character_id',c.id).eq('status','pending_payment'));}
      await rows(db.from('plates').update({status:'reserve',character_id:null,slot:null}).eq('character_id',c.id).eq('kind','paid').eq('status','assigned'));
      await rows(db.from('family_members').delete().eq('character_id',c.id));
      await rows(db.from('characters').update({deleted_at:new Date().toISOString()}).eq('id',c.id));
      await audit(profile.id,'character.delete',{characterId:c.id}); return response({ok:true});
    }
    if (method==='GET' && sub==='profile') {
      const [docs,apps,plates]=await Promise.all([
        rows(db.from('documents').select('*').eq('character_id',c.id)),
        rows(db.from('applications').select('*').eq('character_id',c.id).order('created_at',{ascending:false})),
        rows(db.from('plates').select('*').or(`character_id.eq.${c.id},and(owner_profile_id.eq.${profile.id},status.eq.reserve)`)),
      ]); return response({character:c,documents:docs,applications:apps,plates});
    }
    if (method==='POST' && sub==='applications') {
      const b=await body(req); if(!['passport','medical','weapon'].includes(b.type))fail(400,'Неизвестный тип заявки');
      if(!ageAllowed(c,b.type))fail(403,'Возраст персонажа не подходит для этой процедуры');
      if(b.type==='passport'){
        if(!c.photo)fail(400,'Добавьте фото персонажа перед заявкой');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(b.rpBirthDate||''))fail(400,'Введите RP-дату рождения');
        const d=new Date(`${b.rpBirthDate}T00:00:00Z`),today=new Date();if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==b.rpBirthDate||d>today)fail(400,'Некорректная RP-дата рождения');
        let years=today.getUTCFullYear()-d.getUTCFullYear();if(today.getUTCMonth()<d.getUTCMonth()||today.getUTCMonth()===d.getUTCMonth()&&today.getUTCDate()<d.getUTCDate())years--;if(years!==c.age)fail(400,'RP-дата рождения должна соответствовать возрасту персонажа');
      }
      if(b.type==='medical'&&!['O+','O−','A+','A−','B+','B−','AB+','AB−'].includes(b.bloodType||'O+'))fail(400,'Выберите группу крови из списка');
      if(b.type==='weapon'){const passed=await rows(db.from('quiz_results').select('id').eq('character_id',c.id).eq('kind','weapon').eq('passed',true).limit(1));if(!passed.length)fail(403,'Сначала пройдите тест');}
      const existing=await rows(db.from('applications').select('id').eq('character_id',c.id).eq('type',b.type).eq('status','pending').limit(1));
      const document=await rows(db.from('documents').select('id').eq('character_id',c.id).eq('type',b.type).eq('status','approved').limit(1));
      if(existing.length||document.length)fail(409,'Есть действующая заявка или документ');
      const payload={fullName:c.full_name,robloxUsername:c.roblox_username,rpBirthDate:b.type==='passport'?b.rpBirthDate:null,photo:c.photo,medical:b.type==='medical'?{bloodType:b.bloodType||'O+',glasses:!!b.glasses}:null};
      const app=await rows(db.from('applications').insert({character_id:c.id,type:b.type,payload}).select('id').single());await audit(profile.id,'application.submit',{applicationId:app.id,type:b.type});return response({id:app.id,status:'pending'},201);
    }
    if(method==='GET'&&sub==='slot'){const plates=await rows(db.from('plates').select('*').eq('character_id',c.id).eq('status','assigned'));return response({slots:Array.from({length:5},(_,i)=>({slot:i+1,plate:plates.find((p:any)=>p.slot===i+1)||null}))});}
    if(method==='POST'&&sub.startsWith('quizzes/'))return await submitQuiz(req,profile,c,sub.split('/')[1]);
  }
  if(method==='GET'&&path==='/api/documents'){const chars=await rows(db.from('characters').select('id').eq('profile_id',profile.id).is('deleted_at',null));const ids=chars.map((x:any)=>x.id);return response({items:ids.length?await rows(db.from('documents').select('*,characters(full_name)').in('character_id',ids)):[]});}
  match=path.match(/^\/api\/quizzes\/(car|air|weapon)$/);if(match&&method==='GET'){const c=await ownedCharacter(profile.id,url.searchParams.get('characterId')||'');if(!ageAllowed(c,match[1]))fail(403,'Возраст не соответствует тесту');const q=await rows(db.from('quiz_questions').select('id,question,options').eq('kind',match[1]));return response({kind:match[1],questions:q});}
  match=path.match(/^\/api\/characters\/([0-9a-f-]+)\/quizzes\/(car|air|weapon)$/i);if(match&&method==='POST'){const c=await ownedCharacter(profile.id,match[1]);return await submitQuiz(req,profile,c,match[2]);}
  if(method==='POST'&&path==='/api/activity'){await rows(db.from('profiles').update({last_active:new Date().toISOString()}).eq('id',profile.id));await rows(db.from('activity_events').insert({profile_id:profile.id,kind:'self_attested'}));await audit(profile.id,'activity.confirm',{});return response({ok:true});}
  if(method==='GET'&&path==='/api/server'){const chars=await rows(db.from('characters').select('id,age').eq('profile_id',profile.id).is('deleted_at',null));const ids=chars.filter((x:any)=>x.age>=14).map((x:any)=>x.id);const docs=ids.length?await rows(db.from('documents').select('id').in('character_id',ids).eq('type','passport').eq('status','approved').limit(1)):[];const available=docs.length>0;return response({available,url:available?(Deno.env.get('ROBLOX_SERVER_URL')||''):''});}
  if(method==='GET'&&path==='/api/plates')return response({items:await rows(db.from('plates').select('*').eq('owner_profile_id',profile.id).in('status',['reserve','assigned']))});
  if(method==='POST'&&path==='/api/plates/free'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId)),slot=Number(b.slot),region=String(b.region);
    if(!ageAllowed(c,'car'))fail(403,'Возраст персонажа не подходит');if(!Number.isInteger(slot)||slot<1||slot>5||!(await regions()).includes(region))fail(400,'Неверный слот или регион');
    const slotTaken=await rows(db.from('plates').select('id').eq('character_id',c.id).eq('slot',slot).in('status',['assigned','pending_payment']).limit(1));if(slotTaken.length)fail(409,'Слот уже занят или ожидает оплаты');
    const old=await rows(db.from('free_offers').select('*').eq('character_id',c.id).eq('slot',slot).maybeSingle());if(old){if(old.used)fail(409,'Бесплатная генерация для этого слота уже использована');if(old.region!==region)fail(409,'Для слота уже создан набор с другим регионом');return response({options:old.options});}
    const options:string[]=[];for(let tries=0;options.length<3&&tries<30;tries++){const v=randomPlate(region);const duplicate=await rows(db.from('plates').select('id').eq('value',v).in('status',['pending_payment','reserve','assigned']).limit(1));if(!duplicate.length&&!options.includes(v))options.push(v);}if(options.length!==3)fail(503,'Не удалось подобрать свободные варианты');
    await rows(db.from('free_offers').insert({profile_id:profile.id,character_id:c.id,slot,region,options}));return response({options});
  }
  if(method==='POST'&&path==='/api/plates/claim-free'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId)),slot=Number(b.slot),region=String(b.region),value=String(b.value||'');if(!ageAllowed(c,'car'))fail(403,'Возраст персонажа не подходит');
    const offer=await rows(db.from('free_offers').select('*').eq('profile_id',profile.id).eq('character_id',c.id).eq('slot',slot).eq('used',false).maybeSingle());if(!offer||offer.region!==region||!offer.options.includes(value))fail(409,'Вариант не предлагался сервером или уже использован');
    const occupied=await rows(db.from('plates').select('id').eq('character_id',c.id).eq('slot',slot).in('status',['assigned','pending_payment']).limit(1));if(occupied.length)fail(409,'Слот уже занят');
    await rows(db.from('free_offers').update({used:true}).eq('id',offer.id).eq('used',false));await rows(db.from('plates').insert({owner_profile_id:profile.id,character_id:c.id,slot,region,value,kind:'free',status:'assigned'}));await audit(profile.id,'plate.assign_free',{characterId:c.id,slot,value});return response({ok:true},201);
  }
  if(method==='POST'&&path==='/api/plates/intent'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId)),slot=Number(b.slot),region=String(b.region),value=String(b.value||'').toUpperCase();if(!ageAllowed(c,'car'))fail(403,'Возраст персонажа не подходит');
    if(!Number.isInteger(slot)||slot<1||slot>5||!(await regions()).includes(region)||!platePattern.test(value)||!value.endsWith(region))fail(400,'Формат номера неверен');
    const current=await rows(db.from('plates').select('*').eq('character_id',c.id).eq('slot',slot).eq('status','assigned').maybeSingle());if(current&&current.kind!=='free')fail(409,'Слот занят индивидуальным номером');
    const pending=await rows(db.from('plates').select('id').eq('character_id',c.id).eq('slot',slot).eq('status','pending_payment').limit(1));if(pending.length)fail(409,'Для этого слота уже ожидается оплата');
    const duplicate=await rows(db.from('plates').select('id').eq('value',value).in('status',['pending_payment','reserve','assigned']).limit(1));if(duplicate.length)fail(409,'Этот номер уже занят');
    const p=await rows(db.from('plates').insert({owner_profile_id:profile.id,character_id:c.id,slot,region,value,kind:'paid',status:'pending_payment'}).select('id').single());const payload=`plate:${p.id}:${crypto.randomUUID()}`;
    await rows(db.from('payments').insert({owner_profile_id:profile.id,plate_id:p.id,payload,amount:25,currency:'XTR'}));await audit(profile.id,'plate.payment_intent',{plateId:p.id,characterId:c.id,slot});return response({payload,amount:25,currency:'XTR',configured:!!botToken},201);
  }
  if(method==='POST'&&path==='/api/plates/assign'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId)),slot=Number(b.slot);const p=await rows(db.from('plates').select('*').eq('id',String(b.plateId)).eq('owner_profile_id',profile.id).eq('status','reserve').maybeSingle());if(!p)fail(404,'Номер не найден в резерве');if(!Number.isInteger(slot)||slot<1||slot>5)fail(400,'Неверный слот');const taken=await rows(db.from('plates').select('id').eq('character_id',c.id).eq('slot',slot).in('status',['assigned','pending_payment']).limit(1));if(taken.length)fail(409,'Слот занят');await rows(db.from('plates').update({character_id:c.id,slot,status:'assigned'}).eq('id',p.id));await audit(profile.id,'plate.assign_reserved',{plateId:p.id,characterId:c.id,slot});return response({ok:true});
  }
  if(method==='POST'&&path==='/api/payments/invoice'){
    if(!starsEnabled)fail(503,'Оплата Telegram Stars отключена в этой сборке.');if(!botToken)fail(503,'Бот не настроен');const b=await body(req);const p=await rows(db.from('payments').select('*,plates(value,slot,status)').eq('payload',b.payload).eq('owner_profile_id',profile.id).eq('status','pending').gt('expires_at',new Date().toISOString()).maybeSingle());if(!p||p.plates.status!=='pending_payment')fail(404,'Заказ не найден или истёк');
    if(p.invoice_status==='sent')return response({sent:true,alreadySent:true,messageId:p.invoice_message_id});
    const claimed=await rows(db.from('payments').update({invoice_status:'sending'}).eq('id',p.id).eq('invoice_status','not_sent').select('id').maybeSingle());if(!claimed)fail(409,'Счёт уже отправляется или был обработан. Не повторяйте запрос.');
    try{const sent=await fetch(`https://api.telegram.org/bot${botToken}/sendInvoice`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:Number(profile.telegram_id),title:'Индивидуальный номер SIMON RP',description:`RP-номер ${p.plates.value} · машина ${p.plates.slot}`,payload:p.payload,currency:'XTR',prices:[{label:'Индивидуальный номер',amount:25}]})});const result=await sent.json();if(!sent.ok||!result.ok){await rows(db.from('payments').update({invoice_status:'not_sent'}).eq('id',p.id).eq('invoice_status','sending'));fail(502,result.description||'Telegram не смог отправить счёт');}await rows(db.from('payments').update({invoice_status:'sent',invoice_message_id:result.result.message_id}).eq('id',p.id).eq('invoice_status','sending'));return response({sent:true,alreadySent:false,messageId:result.result.message_id});}catch(error){if(error instanceof HttpError)throw error;/* Keep `sending` after an uncertain network outcome to avoid sending a duplicate invoice. */throw error;}
  }
  if(method==='POST'&&path==='/api/telegram/precheckout')fail(404,'Обработчик доступен только Telegram webhook');

  if(method==='POST'&&path==='/api/families'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId));const member=await rows(db.from('family_members').select('family_id').eq('character_id',c.id).maybeSingle());if(member)fail(409,'Персонаж уже состоит в семье');if(!String(b.name||'').trim()||String(b.name).length>50)fail(400,'Название семьи должно быть до 50 символов');const f=await rows(db.from('families').insert({name:String(b.name).trim(),leader_character_id:c.id}).select('id').single());await rows(db.from('family_members').insert({family_id:f.id,character_id:c.id}));await audit(profile.id,'family.create',{familyId:f.id});await award(c.id,'first_family');return response({id:f.id},201);
  }
  if(method==='GET'&&path==='/api/families'){
    const chars=await rows(db.from('characters').select('id').eq('profile_id',profile.id));const ids=chars.map((c:any)=>c.id);if(!ids.length)return response({items:[]});const members=await rows(db.from('family_members').select('family_id,character_id,status,families(id,name,leader_character_id),characters(full_name,roblox_username)').in('character_id',ids));return response({items:members.map((m:any)=>({id:m.families.id,name:m.families.name,leader_character_id:m.families.leader_character_id,character_id:m.character_id,status:m.status,full_name:m.characters.full_name,roblox_username:m.characters.roblox_username}))});
  }
  if(method==='GET'&&path==='/api/family-invites'){const chars=await rows(db.from('characters').select('id').eq('profile_id',profile.id));const ids=chars.map((c:any)=>c.id);return response({items:ids.length?await rows(db.from('family_invites').select('*,families(name),characters!family_invites_invited_by_fkey(full_name)').in('character_id',ids).eq('status','pending')):[]});}
  match=path.match(/^\/api\/families\/([0-9a-f-]+)\/invite$/i);if(match&&method==='POST'){
    const b=await body(req),leader=await ownedCharacter(profile.id,String(b.leaderCharacterId)),f=await rows(db.from('families').select('*').eq('id',match[1]).maybeSingle());if(!f||f.leader_character_id!==leader.id)fail(403,'Только лидер может приглашать');const target=await rows(db.from('characters').select('id,profile_id').eq('roblox_username',String(b.robloxUsername)).is('deleted_at',null).maybeSingle());if(!target)fail(404,'Персонаж не найден');const existing=await rows(db.from('family_members').select('character_id').eq('character_id',target.id).maybeSingle());if(existing)fail(409,'Персонаж уже состоит в семье');const count=await rows(db.from('family_members').select('character_id',{count:'exact',head:true}).eq('family_id',f.id));if(count.count>=8)fail(409,'В семье максимум 8 участников');const inv=await rows(db.from('family_invites').insert({family_id:f.id,character_id:target.id,invited_by:leader.id}).select('id').single());await audit(profile.id,'family.invite',{familyId:f.id,characterId:target.id});await notify(target.profile_id,'Приглашение в семью',`Вас пригласили в семью «${f.name}».`);return response({id:inv.id},201);
  }
  match=path.match(/^\/api\/family-invites\/([0-9a-f-]+)\/accept$/i);if(match&&method==='POST'){
    const inv=await rows(db.from('family_invites').select('*').eq('id',match[1]).eq('status','pending').maybeSingle());if(!inv)fail(404,'Приглашение не найдено');await ownedCharacter(profile.id,inv.character_id);const prior=await rows(db.from('family_members').select('character_id').eq('character_id',inv.character_id).maybeSingle());if(prior)fail(409,'Персонаж уже состоит в семье');const count=await rows(db.from('family_members').select('character_id',{count:'exact',head:true}).eq('family_id',inv.family_id));if(count.count>=8)fail(409,'В семье максимум 8 участников');await rows(db.from('family_members').insert({family_id:inv.family_id,character_id:inv.character_id,invited_by:inv.invited_by}));await rows(db.from('family_invites').update({status:'accepted'}).eq('id',inv.id));await audit(profile.id,'family.invite_accept',{familyId:inv.family_id,characterId:inv.character_id});return response({ok:true});
  }
  match=path.match(/^\/api\/families\/([0-9a-f-]+)\/(rename|lead|remove)$/i);if(match&&method==='POST'){
    const b=await body(req),f=await rows(db.from('families').select('*').eq('id',match[1]).maybeSingle()),actor=await ownedCharacter(profile.id,String(b.actorCharacterId));if(!f||f.leader_character_id!==actor.id)fail(403,'Только лидер может управлять семьёй');const action=match[2];
    if(action==='rename'){if(!String(b.name||'').trim()||String(b.name).length>50)fail(400,'Название до 50 символов');await rows(db.from('families').update({name:String(b.name).trim()}).eq('id',f.id));}
    if(action==='lead'){const target=String(b.targetCharacterId);const member=await rows(db.from('family_members').select('character_id').eq('family_id',f.id).eq('character_id',target).maybeSingle());if(!member)fail(400,'Новый лидер должен быть участником');await rows(db.from('families').update({leader_character_id:target}).eq('id',f.id));}
    if(action==='remove'){const target=String(b.targetCharacterId);if(target===actor.id)fail(400,'Передайте лидерство до выхода');await rows(db.from('family_members').delete().eq('family_id',f.id).eq('character_id',target));}
    await audit(profile.id,`family.${action}`,{familyId:f.id,target:b.targetCharacterId||null});return response({ok:true});
  }
  if(method==='POST'&&path==='/api/search-requests'){
    if(profile.search_access)return response({status:'approved'});const old=await rows(db.from('search_requests').select('id,status').eq('profile_id',profile.id).eq('status','pending').order('created_at',{ascending:false}).limit(1).maybeSingle());if(old)return response(old);const r=await rows(db.from('search_requests').insert({profile_id:profile.id}).select('id').single());await audit(profile.id,'search.request',{});return response({id:r.id,status:'pending'},201);
  }
  if(method==='POST'&&path==='/api/search'){
    if(!need(profile,'search'))fail(403,'Доступ к поиску не одобрен');const b=await body(req),value=String(b.value||'').toUpperCase();const found=platePattern.test(value)?await rows(db.from('plates').select('value,region,slot,characters(full_name,profile_id)').eq('value',value).eq('status','assigned').maybeSingle()):null;let publicOwner=null;if(found?.characters?.profile_id)publicOwner=await rows(db.from('profiles').select('username').eq('id',found.characters.profile_id).maybeSingle());await audit(profile.id,'plate.search',{value,result:found?'found':'not_found'});return response({result:found?{value:found.value,region:found.region,slot:found.slot,characterName:found.characters?.full_name,ownerUsername:publicOwner?.username}:null});
  }
  if(method==='GET'&&path==='/api/jobs'){
    const chars=await rows(db.from('characters').select('id').eq('profile_id',profile.id).is('deleted_at',null));const ids=chars.map((c:any)=>c.id);const jobs=ids.length?await rows(db.from('character_jobs').select('character_id,profession_id,professions(*)').in('character_id',ids)):[];const work=ids.length?await rows(db.from('work_claims').select('character_id,claimed_at').in('character_id',ids).order('claimed_at',{ascending:false})):[];return response({balance:profile.balance,professions:await rows(db.from('professions').select('*').eq('active',true).order('name')),jobs,work});
  }
  if(method==='POST'&&path==='/api/jobs/assign'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId)),job=await rows(db.from('professions').select('id').eq('id',String(b.professionId)).eq('active',true).maybeSingle());if(!job)fail(404,'Профессия не найдена');await rows(db.from('character_jobs').upsert({character_id:c.id,profession_id:job.id},{onConflict:'character_id'}));await audit(profile.id,'job.assign',{characterId:c.id,professionId:job.id});return response({ok:true});
  }
  if(method==='POST'&&path==='/api/jobs/work'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId));const result=await rows(db.rpc('claim_work',{p_profile:profile.id,p_character:c.id}));await audit(profile.id,'job.payout',{characterId:c.id,amount:result.amount});await award(c.id,'first_job');return response(result);
  }
  if(method==='GET'&&path==='/api/assets'){
    const cid=url.searchParams.get('characterId');let owned:any=null;if(cid)owned=await ownedCharacter(profile.id,cid);const [catalog,items]=await Promise.all([rows(db.from('asset_catalog').select('*').eq('active',true).order('price')),owned?rows(db.from('character_assets').select('*,asset_catalog(*)').eq('character_id',owned.id)):Promise.resolve([])]);return response({balance:profile.balance,catalog,items});
  }
  if(method==='POST'&&path==='/api/assets/buy'){
    const b=await body(req),c=await ownedCharacter(profile.id,String(b.characterId));const result=await rows(db.rpc('purchase_asset',{p_profile:profile.id,p_character:c.id,p_catalog:String(b.catalogId)}));await audit(profile.id,'asset.purchase',{characterId:c.id,assetId:result.assetId});await award(c.id,'first_asset');return response(result,201);
  }
  if(method==='POST'&&path==='/api/money/transfer'){
    const b=await body(req),result=await rows(db.rpc('transfer_money',{p_sender:profile.id,p_recipient_telegram_id:String(b.telegramId||''),p_amount:Number(b.amount)}));await audit(profile.id,'money.transfer',{amount:Number(b.amount)});return response(result);
  }
  if(method==='GET'&&path==='/api/notifications')return response({items:await rows(db.from('notifications').select('*').eq('profile_id',profile.id).order('created_at',{ascending:false}).limit(100))});
  match=path.match(/^\/api\/notifications\/([0-9a-f-]+)\/read$/i);if(match&&method==='POST'){await rows(db.from('notifications').update({read_at:new Date().toISOString()}).eq('id',match[1]).eq('profile_id',profile.id));return response({ok:true});}
  if(method==='GET'&&path==='/api/stats'){
    const cid=url.searchParams.get('characterId');const c=cid?await ownedCharacter(profile.id,cid):null;const chars=await rows(db.from('characters').select('id').eq('profile_id',profile.id).is('deleted_at',null));const ids=c?[c.id]:chars.map((x:any)=>x.id);const [docs,quizzes,claims,assets,achievements]=await Promise.all(ids.length?[rows(db.from('documents').select('id,type,status').in('character_id',ids)),rows(db.from('quiz_results').select('id,kind,passed,score').in('character_id',ids)),rows(db.from('work_claims').select('amount').in('character_id',ids)),rows(db.from('character_assets').select('id,asset_catalog(kind)').in('character_id',ids)),rows(db.from('character_achievements').select('achievements(name,description,points,code),awarded_at').in('character_id',ids))]:[Promise.resolve([]),Promise.resolve([]),Promise.resolve([]),Promise.resolve([]),Promise.resolve([])]);return response({characters:ids.length,documents:docs.length,testsPassed:quizzes.filter((q:any)=>q.passed).length,workClaims:claims.length,earned:claims.reduce((s:number,x:any)=>s+Number(x.amount),0),assets:assets.length,achievements});
  }

  if(path.startsWith('/api/admin/')){
    requirePermission(profile,'admin');
    if(method==='GET'&&path==='/api/admin/overview'){
      const [players,characters,pending,plates]=await Promise.all([rows(db.from('profiles').select('id',{count:'exact',head:true})),rows(db.from('characters').select('id',{count:'exact',head:true}).is('deleted_at',null)),rows(db.from('applications').select('id',{count:'exact',head:true}).eq('status','pending')),rows(db.from('plates').select('id',{count:'exact',head:true}).eq('status','assigned'))]);return response({players:players.count,characters:characters.count,pending:pending.count,plates:plates.count});
    }
    if(method==='GET'&&path==='/api/admin/applications'){requirePermission(profile,'applications');const list=await rows(db.from('applications').select('*,characters(full_name,roblox_username,photo)').order('created_at',{ascending:false}));return response({items:list.map((a:any)=>({...a,payload:JSON.stringify(a.payload),full_name:a.characters?.full_name,roblox_username:a.characters?.roblox_username,photo:a.characters?.photo}))});}
    match=path.match(/^\/api\/admin\/applications\/([0-9a-f-]+)$/i);if(match&&method==='POST'){
      requirePermission(profile,'applications');const b=await body(req);if(!['approved','rejected'].includes(b.status)||b.status==='rejected'&&!String(b.reason||'').trim())fail(400,'Для отказа укажите причину');const a=await rows(db.from('applications').select('*,characters(*)').eq('id',match[1]).maybeSingle());if(!a)fail(404,'Заявка не найдена');if(a.status!=='pending')fail(409,'Заявка уже рассмотрена');if(b.status==='approved'){const min=a.type==='passport'?14:a.type==='weapon'?18:0;if(a.characters.deleted_at||a.characters.age<min)fail(409,'Возраст персонажа изменился; одобрение невозможно');await rows(db.from('documents').upsert({character_id:a.character_id,type:a.type,status:'approved',payload:a.payload},{onConflict:'character_id,type'}));}
      await rows(db.from('applications').update({status:b.status,reason:b.reason||null,reviewed_by:profile.id,reviewed_at:new Date().toISOString()}).eq('id',a.id));await audit(profile.id,'application.review',{applicationId:a.id,status:b.status,reason:b.reason||null});const owner=await rows(db.from('characters').select('profile_id').eq('id',a.character_id).single());await notify(owner.profile_id,'Решение по заявке',`Заявка «${a.type}» ${b.status==='approved'?'одобрена':'отклонена'}.${b.status==='rejected'?` Причина: ${String(b.reason).slice(0,300)}`:''}`);if(b.status==='approved')await award(a.character_id,'first_document');return response({ok:true});
    }
    if(method==='GET'&&path==='/api/admin/players'){requirePermission(profile,'players');const list=await rows(db.from('profiles').select('id,telegram_id,username,first_name,role,permissions,search_access,balance,last_active').order('created_at',{ascending:false}));return response({items:list.map((x:any)=>({...x,tg_id:x.telegram_id}))});}
    if(method==='GET'&&path==='/api/admin/characters'){requirePermission(profile,'characters');const list=await rows(db.from('characters').select('id,full_name,age,roblox_username,created_at,profiles(telegram_id,username)').is('deleted_at',null).order('created_at',{ascending:false}));return response({items:list.map((x:any)=>({...x,tg_id:x.profiles?.telegram_id,telegram_username:x.profiles?.username}))});}
    if(method==='GET'&&path==='/api/admin/tests'){requirePermission(profile,'questions');const list=await rows(db.from('quiz_results').select('*,characters(full_name,roblox_username)').order('created_at',{ascending:false}).limit(500));return response({items:list.map((x:any)=>({...x,full_name:x.characters?.full_name}))});}
    if(method==='POST'&&path==='/api/admin/access'){
      if(profile.role!=='owner')fail(403,'Только владелец');const b=await body(req),target=await rows(db.from('profiles').select('*').eq('telegram_id',String(b.tgId)).maybeSingle());if(!target||target.role==='owner')fail(404,'Пользователь не найден или защищён');if(!['player','admin'].includes(b.role))fail(400,'Недопустимая роль');const allowed=['applications','players','characters','plates','questions','requests','families'];const permissions=b.role==='admin'?[...new Set((Array.isArray(b.permissions)?b.permissions:[]).filter((x:string)=>allowed.includes(x)))]:[];await rows(db.from('profiles').update({role:b.role,permissions,search_access:!!b.searchAccess}).eq('id',target.id));await audit(profile.id,'access.change',{targetId:target.id,role:b.role,permissions,searchAccess:!!b.searchAccess});return response({ok:true});
    }
    if(method==='GET'&&path==='/api/admin/regions'){if(profile.role!=='owner')fail(403,'Только владелец');return response({regions:await regions()});}
    if(method==='PUT'&&path==='/api/admin/regions'){if(profile.role!=='owner')fail(403,'Только владелец');const b=await body(req),values=[...new Set((b.regions||[]).map((x:any)=>String(x).trim()))];if(!values.length||values.length>100||values.some((x:string)=>!/^\d{2,3}$/.test(x)))fail(400,'Укажите от 1 до 100 кодов региона');await rows(db.from('settings').upsert({key:'plate_regions',value:values}));await audit(profile.id,'plate.regions_update',{regions:values});return response({regions:values});}
    if(method==='GET'&&path==='/api/admin/audit'){if(profile.role!=='owner')fail(403,'Только владелец');return response({items:await rows(db.from('audit_logs').select('*,profiles(telegram_id)').order('created_at',{ascending:false}).limit(500))});}
    if(method==='GET'&&path==='/api/admin/audit.csv'){if(profile.role!=='owner')fail(403,'Только владелец');const list=await rows(db.from('audit_logs').select('*').order('created_at').limit(5000));const csv=['id,action,details,created_at',...list.map((x:any)=>[x.id,x.action,JSON.stringify(x.details),x.created_at].map((v:any)=>`"${String(v??'').replaceAll('"','""')}"`).join(','))].join('\n');return new Response(csv,{headers:{...cors,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="simon-rp-audit.csv"'}});}
    if(method==='GET'&&path==='/api/admin/search-requests'){requirePermission(profile,'requests');const list=await rows(db.from('search_requests').select('*,profiles(telegram_id,username)').order('created_at',{ascending:false}));return response({items:list.map((x:any)=>({...x,tg_id:x.profiles?.telegram_id,username:x.profiles?.username}))});}
    match=path.match(/^\/api\/admin\/search-requests\/([0-9a-f-]+)$/i);if(match&&method==='POST'){requirePermission(profile,'requests');const b=await body(req);if(!['approved','rejected'].includes(b.status))fail(400,'Неизвестное решение');const r=await rows(db.from('search_requests').select('*').eq('id',match[1]).maybeSingle());if(!r)fail(404,'Запрос не найден');await rows(db.from('search_requests').update({status:b.status,reason:b.reason||null,reviewed_by:profile.id}).eq('id',r.id));await rows(db.from('profiles').update({search_access:b.status==='approved'}).eq('id',r.profile_id));await audit(profile.id,'search.access_review',{requestId:r.id,status:b.status});await notify(r.profile_id,'Доступ к поиску номеров',`Запрос ${b.status==='approved'?'одобрен':'отклонён'}.`);return response({ok:true});}
    if(method==='GET'&&path==='/api/admin/questions'){requirePermission(profile,'questions');return response({items:await rows(db.from('quiz_questions').select('*').order('kind').order('created_at'))});}
    match=path.match(/^\/api\/admin\/questions\/([0-9a-f-]+)$/i);if(match&&method==='PATCH'){requirePermission(profile,'questions');const b=await body(req);if(!Array.isArray(b.options)||b.options.length!==4||!Number.isInteger(Number(b.correct))||Number(b.correct)<0||Number(b.correct)>3)fail(400,'Для вопроса нужны четыре ответа и правильный вариант');await rows(db.from('quiz_questions').update({question:String(b.question).slice(0,400),options:b.options.map((x:string)=>String(x).slice(0,200)),correct:Number(b.correct)}).eq('id',match[1]));await audit(profile.id,'quiz.question_edit',{questionId:match[1]});return response({ok:true});}
    if(method==='GET'&&path==='/api/admin/plates'){requirePermission(profile,'plates');const list=await rows(db.from('plates').select('*,characters(full_name)').order('created_at',{ascending:false}));return response({items:list.map((x:any)=>({...x,full_name:x.characters?.full_name}))});}
    if(method==='GET'&&path==='/api/admin/families'){requirePermission(profile,'families');const list=await rows(db.from('families').select('*,characters!families_leader_character_id_fkey(full_name),family_members(character_id)').order('created_at',{ascending:false}));return response({items:list.map((x:any)=>({...x,leader:x.characters?.full_name,members:x.family_members?.length||0}))});}
    if(method==='POST'&&path==='/api/admin/balance'){if(profile.role!=='owner')fail(403,'Только владелец');const b=await body(req),target=await rows(db.from('profiles').select('id').eq('telegram_id',String(b.telegramId)).maybeSingle());if(!target)fail(404,'Игрок не найден');const result=await rows(db.rpc('admin_adjust_balance',{p_actor:profile.id,p_target:target.id,p_amount:Number(b.amount),p_note:String(b.reason||'')}));await audit(profile.id,'balance.admin_adjust',{targetId:target.id,amount:Number(b.amount)});await notify(target.id,'Изменение игрового баланса','Администрация обновила ваш игровой баланс.');return response(result);}
  }
  return response({error:'Маршрут не найден'},404);
}

async function submitQuiz(req: Request, profile: any, character: any, kind: string) {
  if(!['car','air','weapon'].includes(kind))fail(404,'Тест не найден');if(!ageAllowed(character,kind))fail(403,'Возраст не соответствует тесту');const b=await body(req);const questions=await rows(db.from('quiz_questions').select('id,correct').eq('kind',kind));if(!Array.isArray(b.answers)||b.answers.length!==5||questions.length!==5)fail(400,'Тест должен содержать 5 ответов');const score=questions.reduce((s:number,q:any,i:number)=>s+(Number(b.answers[i])===q.correct?1:0),0),passed=score>=4;await rows(db.from('quiz_results').insert({character_id:character.id,kind,score,passed}));if(passed&&(kind==='car'||kind==='air'))await rows(db.from('documents').upsert({character_id:character.id,type:kind,payload:{score},status:'approved'},{onConflict:'character_id,type'}));await audit(profile.id,'quiz.submit',{characterId:character.id,kind,score,passed});return response({score,total:5,passed,document:passed&&kind!=='weapon'});
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: cors });
  try { return await handle(req); }
  catch (error) { const status = error instanceof HttpError ? error.status : 400; const message = error instanceof HttpError ? error.message : 'Не удалось выполнить запрос'; return response({ error: message }, status); }
});
