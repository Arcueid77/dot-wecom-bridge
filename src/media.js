import { createDecipheriv } from 'node:crypto';

export const MAX_MEDIA = 8 * 1024 * 1024;

export function mediaUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\\]/u.test(value)) throw new Error('WeCom media URL is invalid.');
  let url;
  try { url = new URL(value); } catch { throw new Error('WeCom media URL is invalid.'); }
  const path = url.pathname;
  const official = (url.hostname === 'wework.qpic.cn' && /^\/wwpic(?:3az)?\/[A-Za-z0-9_-]+(?:\/0)?$/u.test(path)) ||
    (url.hostname === 'qyapi.weixin.qq.com' && path === '/cgi-bin/media/get');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !official) throw new Error('WeCom media URL is invalid.');
  return url.href;
}

export function aesKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/u.test(value)) throw new Error('WeCom media key is invalid.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=$/u, '') !== value.replace(/=$/u, '')) throw new Error('WeCom media key is invalid.');
  return key;
}

export function mediaName(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 255 && !/[\u0000-\u001f\u007f/\\]/u.test(value) && value !== '.' && value !== '..';
}

export function imageMime(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  throw new Error('WeCom image must be PNG, JPEG or GIF.');
}

function validAmr(data) {
  if (data.subarray(0, 6).toString('ascii') !== '#!AMR\n') return false;
  const sizes = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1];
  let offset = 6;
  let frames = 0;
  while (offset < data.length) {
    const size = sizes[(data[offset] >> 3) & 15];
    if (!size || (data[offset] & 0x83) !== 0 || offset + size > data.length) return false;
    offset += size;
    frames++;
  }
  return frames > 0;
}

export function validateMediaReply({ media, text }) {
  if (!media || !['image', 'audio', 'file'].includes(media.type) || !Buffer.isBuffer(media.data) ||
      media.data.length < 5 || media.data.length > MAX_MEDIA || !mediaName(media.name) ||
      typeof media.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(media.mimeType) ||
      (text !== undefined && text !== '')) throw new Error('WeCom media requires one file up to 8 MiB without a caption.');
  if (media.type === 'image' && imageMime(media.data) !== media.mimeType) throw new Error('WeCom image type does not match its content.');
  if (media.type === 'audio' && (media.data.length > 2 * 1024 * 1024 || media.mimeType !== 'audio/amr' ||
      !validAmr(media.data))) throw new Error('WeCom voice requires a complete AMR file up to 2 MiB.');
}

export async function readEncryptedMedia(response, keyValue) {
  const key = aesKey(keyValue);
  let reader;
  let decoded;
  try {
    const declared = response?.headers?.get?.('content-length');
    if (!response?.ok || response.status >= 300 || response.redirected ||
        (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_MEDIA + 32))) throw new Error();
    reader = response.body?.getReader();
    if (!reader) throw new Error();
    const pieces = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MEDIA + 32) throw new Error();
      pieces.push(Buffer.from(value));
    }
    if (!size || size % 32 !== 0) throw new Error();
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    decoded = Buffer.concat([decipher.update(Buffer.concat(pieces)), decipher.final()]);
    const padding = decoded.at(-1);
    if (padding < 1 || padding > 32 || decoded.length <= padding || decoded.length - padding > MAX_MEDIA) throw new Error();
    for (let index = decoded.length - padding; index < decoded.length; index++) if (decoded[index] !== padding) throw new Error();
    return Buffer.from(decoded.subarray(0, decoded.length - padding));
  } catch {
    try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch { /* no raw URL or key diagnostics */ }
    throw new Error('WeCom media download or decryption failed.');
  } finally {
    key.fill(0);
    decoded?.fill(0);
    reader?.releaseLock();
  }
}
