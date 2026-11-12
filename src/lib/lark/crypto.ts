import { createDecipheriv, createHash } from 'crypto'

export function larkSignature(timestamp: string, nonce: string, encryptKey: string, rawBody: string): string {
  return createHash('sha256').update(timestamp + nonce + encryptKey + rawBody, 'utf8').digest('hex')
}

export function decryptLarkPayload(encrypt: string, encryptKey: string): string {
  if (typeof encrypt !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypt)) throw new Error('bad encrypt payload')
  const data = Buffer.from(encrypt, 'base64')
  if (data.length < 32 || (data.length - 16) % 16 !== 0) throw new Error('bad encrypt payload')
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const decipher = createDecipheriv('aes-256-cbc', key, data.subarray(0, 16))
  const plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()])
  return new TextDecoder('utf-8', { fatal: true }).decode(plain)
}
