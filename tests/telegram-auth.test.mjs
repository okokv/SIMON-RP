import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegramInitData } from '../supabase/functions/_shared/telegram-auth.mjs';

const token = '123456:TEST_ONLY_TOKEN';
const now = 1_800_000_000;

function signedInitData(user, authDate = now) {
  const fields = new URLSearchParams({ auth_date: String(authDate), query_id: 'TEST_QUERY', user: JSON.stringify(user) });
  const checkString = [...fields.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  fields.set('hash', hash);
  return fields.toString();
}

test('accepts valid Telegram WebApp initData and returns signed user', async () => {
  const user = { id: 71000123, first_name: 'Test', username: 'simon_test' };
  assert.deepEqual(await verifyTelegramInitData(signedInitData(user), token, 86400, now), user);
});

test('rejects tampered, expired, duplicate-hash, and missing initData', async () => {
  const valid = signedInitData({ id: 71000123 }, now - 60);
  await assert.rejects(verifyTelegramInitData(valid.replace('71000123', '71000124'), token, 86400, now), /signature/i);
  await assert.rejects(verifyTelegramInitData(signedInitData({ id: 71000123 }, now - 90000), token, 86400, now), /expired/i);
  await assert.rejects(verifyTelegramInitData(`${valid}&hash=${'0'.repeat(64)}`, token, 86400, now), /invalid/i);
  await assert.rejects(verifyTelegramInitData('', token, 86400, now), /configured/i);
});
