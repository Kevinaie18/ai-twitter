import { describe, it, expect } from 'vitest';
import { sanitizeError, safeInt, extractJsonFromLlm } from '../src/utils.js';

describe('sanitizeError', () => {
  it('strips Bearer tokens', () => {
    const result = sanitizeError('Request failed: Bearer sk-or-v1-abc123def456ghi789jklmnopqrstuv');
    expect(result).not.toContain('sk-or-v1');
    expect(result).toContain('[REDACTED]');
  });

  it('strips API key patterns', () => {
    const result = sanitizeError('Error: api_key=sk_test_1234567890abcdef');
    expect(result).not.toContain('sk_test_1234567890abcdef');
  });

  it('strips cookie values', () => {
    const result = sanitizeError('auth_token=abc123secretcookie; ct0=longcsrftokenvalue');
    expect(result).not.toContain('abc123secretcookie');
  });

  it('truncates stack traces to 5 frames', () => {
    const err = new Error('test');
    err.stack = 'Error: test\n' + Array.from({ length: 20 }, (_, i) => `    at fn${i} (file.ts:${i})`).join('\n');
    const result = sanitizeError(err);
    const atLines = result.split('\n').filter(l => l.trimStart().startsWith('at '));
    expect(atLines.length).toBeLessThanOrEqual(5);
    expect(result).toContain('(truncated)');
  });

  it('handles non-Error values', () => {
    expect(sanitizeError('plain string')).toBe('plain string');
    expect(sanitizeError(42)).toBe('42');
    expect(sanitizeError(null)).toBe('null');
  });
});

describe('safeInt', () => {
  it('returns fallback for undefined', () => {
    expect(safeInt(undefined, 7)).toBe(7);
  });

  it('returns fallback for empty string', () => {
    expect(safeInt('', 7)).toBe(7);
  });

  it('parses valid integers', () => {
    expect(safeInt('30', 7)).toBe(30);
  });

  it('returns fallback for NaN', () => {
    expect(safeInt('abc', 7)).toBe(7);
  });

  it('returns fallback for negative', () => {
    expect(safeInt('-5', 7)).toBe(7);
  });

  it('clamps to max', () => {
    expect(safeInt('99999', 7, 365)).toBe(365);
  });

  it('allows exact max', () => {
    expect(safeInt('365', 7, 365)).toBe(365);
  });
});

describe('extractJsonFromLlm', () => {
  it('parses raw JSON', () => {
    const result = extractJsonFromLlm('{"tweets": []}');
    expect(result).toEqual({ tweets: [] });
  });

  it('extracts from ```json fences', () => {
    const input = 'Here is the result:\n```json\n{"tweets": [{"id": "1"}]}\n```\nDone.';
    const result = extractJsonFromLlm<{ tweets: Array<{ id: string }> }>(input);
    expect(result.tweets).toHaveLength(1);
    expect(result.tweets[0].id).toBe('1');
  });

  it('extracts from ``` fences without language tag', () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJsonFromLlm(input)).toEqual({ key: 'value' });
  });

  it('handles extra whitespace in fences', () => {
    const input = '```json   \n  {"a": 1}  \n```';
    expect(extractJsonFromLlm(input)).toEqual({ a: 1 });
  });

  it('throws on truncated JSON', () => {
    expect(() => extractJsonFromLlm('{"tweets": [')).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => extractJsonFromLlm('')).toThrow();
  });

  it('handles nested objects with extra fields', () => {
    const input = '```json\n{"tweets": [{"id": "1", "extra_field": true, "nested": {"deep": 42}}]}\n```';
    const result = extractJsonFromLlm<{ tweets: Array<{ id: string }> }>(input);
    expect(result.tweets[0].id).toBe('1');
  });
});
