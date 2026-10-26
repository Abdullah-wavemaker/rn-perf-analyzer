import { describe, expect, it } from 'vitest';
import { endpointKey, redactUrl, wireBatchSchema } from '@rnpa/shared';

describe('redactUrl', () => {
  it('redacts sensitive query parameters and keeps the rest', () => {
    expect(redactUrl('https://a.io/x?page=2&access_token=abc&apiKey=k')).toBe('https://a.io/x?page=2&access_token=[redacted]&apiKey=[redacted]');
  });
  it('strips credentials and fragments', () => {
    expect(redactUrl('https://user:pass@a.io/cb#id_token=xyz')).toBe('https://a.io/cb');
  });
  it('caps length and tolerates junk', () => {
    expect(redactUrl('https://a.io/' + 'x'.repeat(5000)).length).toBeLessThanOrEqual(2049);
    expect(redactUrl(undefined)).toBe('');
    expect(redactUrl('%E0%A4%A?token=1')).toBe('%E0%A4%A?token=[redacted]');
  });
});

describe('endpointKey', () => {
  it('collapses identifiers', () => {
    expect(endpointKey('get', 'https://a.io/users/42/orders/3f2a1c5e-1111-2222-3333-444455556666?x=1')).toBe('GET https://a.io/users/:id/orders/:id');
  });
});

describe('wireBatchSchema', () => {
  const base = { v: 1, i: 'abc', c: 'chan', q: 0, n: Date.now() };
  it('accepts a valid batch', () => {
    expect(wireBatchSchema.safeParse({ ...base, e: [{ t: 'MARK', ts: Date.now(), m: { name: 'x' } }] }).success).toBe(true);
  });
  it('rejects unknown types, bad ids and oversized metadata', () => {
    expect(wireBatchSchema.safeParse({ ...base, e: [{ t: 'EVIL', ts: 1 }] }).success).toBe(false);
    expect(wireBatchSchema.safeParse({ ...base, i: '../../x', e: [] }).success).toBe(false);
    expect(wireBatchSchema.safeParse({ ...base, e: [{ t: 'MARK', ts: 1, m: { big: 'x'.repeat(20_000) } }] }).success).toBe(false);
  });
});
