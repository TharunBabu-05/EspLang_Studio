import { fail, type Position, type Span } from './ast.js';
export interface Token {
  kind: 'identifier' | 'number' | 'string' | 'symbol' | 'eof';
  value: string;
  span: Span;
}
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0,
    line = 1,
    column = 1;
  const pos = (): Position => ({ offset, line, column });
  const peek = (n = 0): string => source[offset + n] ?? '';
  const take = (): string => {
    const c = source[offset++]!;
    if (c === '\n') {
      line++;
      column = 1;
    } else column++;
    return c;
  };
  const is = (pattern: RegExp, c: string): boolean => c !== '' && pattern.test(c);
  while (offset < source.length) {
    if (is(/\s/, peek())) {
      take();
      continue;
    }
    if (peek() === '/' && peek(1) === '/') {
      while (peek() && peek() !== '\n') take();
      continue;
    }
    const start = pos();
    if (peek() === '/' && peek(1) === '*') {
      take();
      take();
      while (peek() && !(peek() === '*' && peek(1) === '/')) take();
      if (!peek()) fail('Unterminated block comment', { start, end: pos() });
      take();
      take();
      continue;
    }
    let value = '';
    let kind: Token['kind'];
    if (is(/[a-zA-Z_]/, peek())) {
      kind = 'identifier';
      while (is(/[\w]/, peek())) value += take();
    } else if (is(/[0-9]/, peek())) {
      kind = 'number';
      while (is(/[0-9]/, peek())) value += take();
      if (peek() === '.') {
        value += take();
        if (!is(/[0-9]/, peek()))
          fail('Expected a digit after decimal point', { start, end: pos() });
        while (is(/[0-9]/, peek())) value += take();
      }
      if (peek() === 'e' || peek() === 'E') {
        value += take();
        if (peek() === '+' || peek() === '-') value += take();
        if (!is(/[0-9]/, peek())) fail('Invalid exponent', { start, end: pos() });
        while (is(/[0-9]/, peek())) value += take();
      }
      if (!Number.isFinite(Number(value))) fail('Number is too large', { start, end: pos() });
    } else if (peek() === '"') {
      kind = 'string';
      take();
      while (peek() && peek() !== '"') {
        const c = take();
        if (c === '\n' || c === '\r') fail('Newline in string literal', { start, end: pos() });
        if (c === '\\') {
          const escaped = take();
          const escapes: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            '"': '"',
            '\\': '\\',
          };
          if (!(escaped in escapes)) fail('Unsupported string escape', { start, end: pos() });
          value += escapes[escaped];
        } else value += c;
      }
      if (!peek()) fail('Unterminated string literal', { start, end: pos() });
      take();
    } else {
      kind = 'symbol';
      const two = peek() + peek(1);
      if (
        ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '->'].includes(two)
      )
        value = take() + take();
      else if ('{}();,+-*/%!=<>'.includes(peek())) value = take();
      else
        fail(`Unexpected character ${JSON.stringify(peek())}`, {
          start,
          end: { ...pos(), column: column + 1, offset: offset + 1 },
        });
    }
    tokens.push({ kind, value, span: { start, end: pos() } });
    if (tokens.length > 30000)
      fail('Program exceeds the 30,000 token limit', { start, end: pos() });
  }
  tokens.push({ kind: 'eof', value: '', span: { start: pos(), end: pos() } });
  return tokens;
}
