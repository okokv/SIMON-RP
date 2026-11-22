const encoder = new TextEncoder();

function fromHex(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function equalBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 86400, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof initData !== 'string' || !initData || typeof botToken !== 'string' || !botToken) {
    throw new Error('Telegram auth is not configured');
  }
  const params = new URLSearchParams(initData);
  const hashes = params.getAll('hash');
  const authDates = params.getAll('auth_date');
  if (hashes.length !== 1 || authDates.length !== 1) throw new Error('Invalid Telegram initData');
  const hash = hashes[0];
  const authDate = Number(authDates[0]);
  if (!Number.isInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > maxAgeSeconds) {
    throw new Error('Invalid or expired Telegram initData');
  }
  const checkString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const keyForDerivation = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', keyForDerivation, encoder.encode(botToken));
  const keyForCheck = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expectedHash = new Uint8Array(await crypto.subtle.sign('HMAC', keyForCheck, encoder.encode(checkString)));
  const actualHash = fromHex(hash);
  if (!equalBytes(actualHash, expectedHash)) throw new Error('Invalid Telegram signature');
  let user;
  try { user = JSON.parse(params.get('user')); } catch { throw new Error('Invalid Telegram user'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Missing Telegram user');
  return user;
}

export { verifyTelegramInitData };
