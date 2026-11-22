import { createClient } from 'npm:@supabase/supabase-js@2';
const botToken = Deno.env.get('BOT_TOKEN') || '';
const appUrl = Deno.env.get('PUBLIC_APP_URL') || '';
const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || '';
const db = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', { auth: { persistSession: false, autoRefreshToken: false } });

function constantTimeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0; for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
async function telegram(method: string, data: unknown) {
  if (!botToken) throw new Error('bot disabled');
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await res.json();
  if (!res.ok || !result.ok) throw new Error('Telegram API error');
  return result.result;
}
function ok(body: unknown = { ok: true }) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); }

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' || !botToken || !webhookSecret) return new Response('Not found', { status: 404 });
  const supplied = req.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!constantTimeEqual(supplied, webhookSecret)) return new Response('Unauthorized', { status: 401 });
  let update: any;
  try { update = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  try {
    if (update.message?.text?.split(/\s+/, 1)[0]?.startsWith('/start')) {
      if (!appUrl || !/^https:\/\//i.test(appUrl)) return ok();
      await telegram('sendMessage', { chat_id: update.message.chat.id, text: 'Добро пожаловать в SIMON RP! Здесь начинается твоя RP-история', reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: appUrl } }]] } });
      const tg = update.message.from;
      if (tg?.id) {
        await db.from('profiles').upsert({ telegram_id: String(tg.id), username: tg.username || null, first_name: tg.first_name || '' }, { onConflict: 'telegram_id', ignoreDuplicates: true });
      }
      return ok();
    }
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      const { data: payment } = await db.from('payments').select('*,profiles(telegram_id),plates(status)').eq('payload', q.invoice_payload).eq('status', 'pending').maybeSingle();
      const valid = !!payment && payment.expires_at > new Date().toISOString() && payment.amount === q.total_amount && payment.currency === q.currency && q.currency === 'XTR' && payment.profiles?.telegram_id === String(q.from.id) && payment.plates?.status === 'pending_payment';
      await telegram('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: valid, ...(!valid ? { error_message: 'Заказ недоступен или не принадлежит этому аккаунту.' } : {}) });
      return ok();
    }
    if (update.message?.successful_payment) {
      const paid = update.message.successful_payment;
      const { data: payment } = await db.from('payments').select('owner_profile_id').eq('payload', paid.invoice_payload).maybeSingle();
      const result = await db.rpc('finalize_plate_payment', { p_payload: paid.invoice_payload, p_charge_id: paid.telegram_payment_charge_id, p_payer_telegram_id: String(update.message.from.id), p_amount: paid.total_amount, p_currency: paid.currency });
      if (!result.error && payment && !result.data?.duplicate) {
        await db.from('notifications').insert({ profile_id: payment.owner_profile_id, title: 'Номер оплачен', body: 'Оплата подтверждена, индивидуальный номер назначен персонажу.' });
      }
      return ok();
    }
    return ok();
  } catch {
    // Telegram retries webhook updates on non-2xx responses. Avoid returning payment details.
    return new Response('Webhook processing failed', { status: 500 });
  }
});
