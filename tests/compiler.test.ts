import { describe, expect, it } from 'vitest';
import { compile, tokenize, type BoardId } from '../packages/compiler/src/index.js';
import { examples } from '../packages/web/src/examples.js';
const program = (body: string): string => `setup {} loop { ${body} }`;
const errors = (text: string, board: BoardId = 'esp32'): string[] =>
  compile(text, board)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);
describe('compiler', () => {
  it('accepts both signed 32-bit boundaries and rejects out-of-range integers', () => {
    expect(errors(program('int low = -2147483648; int high = 2147483647;'))).toEqual([]);
    expect(errors(program('int x = 2147483648;'))).toContain(
      'Integer is outside signed 32-bit range',
    );
    expect(errors(program('int x = -2147483649;'))).toContain(
      'Integer is outside signed 32-bit range',
    );
  });
  it('compiles each bundled example for all supported boards', () => {
    for (const source of Object.values(examples))
      for (const board of ['esp32', 'esp32s2', 'esp32s3', 'esp32c3', 'esp32c6'] as const) {
        const result = compile(source, board);
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(result.cpp).toContain('void setup()');
        expect(result.cpp).toContain('void loop()');
      }
  });
  it('tracks spans through comments, CRLF, and escaped strings', () => {
    const tokens = tokenize('// hi\r\n  serialPrint("hello\\nworld");');
    expect(tokens[0]!.span.start).toEqual({ offset: 9, line: 2, column: 3 });
    expect(tokens[2]!.value).toBe('hello\nworld');
  });
  it.each(['/* unfinished', 'setup { serialPrint("no); } loop {}', 'setup {} loop { @ }'])(
    'reports lexical errors without throwing: %s',
    (text) => {
      expect(compile(text).diagnostics[0]?.severity).toBe('error');
    },
  );
  it('implements expression precedence and explicit numeric promotion', () => {
    const result = compile(
      program('float x = 1 + 2 * 3; bool ok = x > 2.5 && true; serialPrint(ok);'),
    );
    expect(errors(program('float x = 1 + 2 * 3;'))).toEqual([]);
    expect(result.cpp).toContain('(1 + (2 * 3))');
    expect(errors(program('int x = 1.5;'))).toContain('Expected int, received float');
  });
  it('requires both entry blocks and prevents duplicate blocks', () => {
    expect(errors('setup {}')).toHaveLength(1);
    expect(errors('setup {} setup {} loop {}')).toHaveLength(1);
    expect(errors('setup {} loop {} task {}')).toHaveLength(1);
  });
  it('checks scoping, duplicate names, and assignments', () => {
    expect(errors(program('{ int x = 1; } serialPrint(x);'))).toContain("Unknown variable 'x'");
    expect(errors(program('int x = 1; int x = 2;'))).toContain("Duplicate or reserved name 'x'");
    expect(errors(program('for (int i = 0; i < 2; i++) {} serialPrint(i);'))).toContain(
      "Unknown variable 'i'",
    );
  });
  it('validates function signatures, recursion, and returns', () => {
    expect(
      errors(
        'fn fact(int n) -> int { if (n <= 1) { return 1; } else { return n * fact(n - 1); } } setup {} loop { serialPrint(fact(5)); }',
      ),
    ).toEqual([]);
    expect(errors('fn f() -> int {} setup {} loop {}')).toContain(
      "Function 'f' must return on every path",
    );
    expect(errors(program('serialPrint(delay(1));'))).toContain('Cannot print void');
    expect(errors('fn f(int x) {} setup {} loop { f(true); }')).toContain(
      'Expected int, received bool',
    );
  });
  it('rejects non-boolean conditions and invalid binary operations', () => {
    expect(errors(program('if (1) {}'))).toContain('Expected bool, received int');
    expect(errors(program('int x = 1 / 0;'))).toContain('Division by zero');
    expect(errors(program('float x = 2.5 % 2;'))).toContain('Expected int, received float');
  });
  it('checks chip-specific GPIO validity and input-only pins', () => {
    expect(errors(program('pinMode(34, OUTPUT);'))).toContain(
      'GPIO 34 is input-only; use INPUT without configurable pulls',
    );
    expect(errors(program('pinMode(34, INPUT_PULLUP);'))).toHaveLength(1);
    expect(errors(program('digitalWrite(35, HIGH);'))).toHaveLength(1);
    expect(errors(program('pinMode(20, INPUT);'))).toHaveLength(1);
    expect(errors(program('pinMode(20, INPUT);'), 'esp32s3')).toHaveLength(0);
    expect(errors(program('pwmWrite(6, 10);'))).toHaveLength(1);
  });
  it('guards dynamic GPIOs and reports runtime-validation warnings', () => {
    const result = compile(program('int pin = 34; pinMode(pin, OUTPUT);'));
    expect(result.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
    expect(result.cpp).toContain('el_validPin(pin, needsOutput)');
  });
  it('checks hardware call arity, range, and types', () => {
    expect(errors(program('pwmWrite(4, 256);'))).toContain(
      'PWM duty must be an integer from 0 to 255',
    );
    expect(errors(program('delay(-1);'))).toContain('Delay cannot be negative');
    expect(errors(program('pinMode(4);'))).toContain('pinMode expects 2 arguments, received 1');
    expect(errors(program('wifiConnect(1, 2);'))).toHaveLength(2);
  });
  it('handles prototype names as ordinary identifiers', () => {
    expect(errors(program('toString();'))).toContain("Unknown function 'toString'");
    expect(errors(program('int constructor = 1; serialPrint(constructor);'))).toEqual([]);
    expect(
      errors('fn toString() -> int { return 1; } setup {} loop { serialPrint(toString()); }'),
    ).toEqual([]);
  });
  it('limits pathological nesting and long operator chains', () => {
    expect(errors(program(`serialPrint(${'('.repeat(140)}1${')'.repeat(140)});`))[0]).toMatch(
      /nesting/,
    );
    expect(
      errors(program(`int x = ${Array.from({ length: 200 }, () => '1').join('+')};`))[0],
    ).toMatch(/chained/);
  });
  it('rejects hardware activity during global initialization', () => {
    expect(errors('int sensor = digitalRead(4); setup {} loop {}')[0]).toMatch(
      /Global initializers/,
    );
  });
  it('escapes C++ strings and prefixes user identifiers', () => {
    const result = compile(program('string Serial = "quote: \\"";'));
    expect(result.cpp).toContain('String el_Serial');
    expect(result.cpp).toContain('quote: \\"');
  });
});
