import {
  fail,
  hardwareNames,
  type ProgramNode,
  type BlockNode,
  type Statement,
  type VariableDeclNode,
  type AssignNode,
  type Expression,
  type ValueType,
  type FunctionDeclNode,
  type ParameterNode,
  type IfNode,
  type Span,
} from './ast.js';
import { tokenize, type Token } from './lexer.js';
const types = ['int', 'float', 'bool', 'string', 'void'];
const reserved = new Set([
  ...types,
  ...hardwareNames,
  'setup',
  'loop',
  'task',
  'fn',
  'if',
  'else',
  'while',
  'for',
  'return',
  'true',
  'false',
  'HIGH',
  'LOW',
  'INPUT',
  'OUTPUT',
  'INPUT_PULLUP',
  'INPUT_PULLDOWN',
]);
export class Parser {
  private index = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}
  private current(): Token {
    return this.tokens[this.index]!;
  }
  private previous(): Token {
    return this.tokens[this.index - 1]!;
  }
  private at(value: string): boolean {
    return this.current().value === value;
  }
  private take(): Token {
    const t = this.current();
    if (t.kind !== 'eof') this.index++;
    return t;
  }
  private match(value: string): boolean {
    if (!this.at(value)) return false;
    this.take();
    return true;
  }
  private expect(value: string): Token {
    if (!this.at(value))
      fail(
        `Expected '${value}', found '${this.current().value || 'end of file'}'`,
        this.current().span,
      );
    return this.take();
  }
  private name(): Token {
    const t = this.current();
    if (t.kind !== 'identifier' || reserved.has(t.value) || t.value.startsWith('__'))
      fail('Expected a non-reserved identifier', t.span);
    return this.take();
  }
  private span(start: Token): Span {
    return { start: start.span.start, end: this.previous().span.end };
  }
  private guarded<T>(run: () => T): T {
    if (++this.depth > 128) fail('Maximum syntax nesting depth exceeded', this.current().span);
    try {
      return run();
    } finally {
      this.depth--;
    }
  }
  parse(): ProgramNode {
    const start = this.current();
    const globals: VariableDeclNode[] = [],
      functions: FunctionDeclNode[] = [];
    let setup: BlockNode | undefined, loop: BlockNode | undefined;
    while (this.current().kind !== 'eof') {
      if (this.match('setup')) {
        if (setup) fail('Duplicate setup block', this.previous().span);
        setup = this.block();
      } else if (this.match('loop') || this.match('task')) {
        if (loop) fail('Use one loop or task block', this.previous().span);
        loop = this.block();
      } else if (this.match('fn')) functions.push(this.functionDecl());
      else if (types.includes(this.current().value)) {
        globals.push(this.variable());
        this.expect(';');
      } else fail('Expected setup, loop/task, fn, or a global variable', this.current().span);
    }
    if (!setup || !loop)
      fail('A program requires setup and loop (or task) blocks', this.current().span);
    return {
      kind: 'Program',
      globals,
      functions,
      setup,
      loop: { kind: 'Loop', body: loop, span: loop.span },
      span: this.span(start),
    };
  }
  private valueType(allowVoid = false): ValueType {
    const t = this.take();
    if (!types.includes(t.value) || (!allowVoid && t.value === 'void'))
      fail('Expected a value type', t.span);
    return t.value as ValueType;
  }
  private functionDecl(): FunctionDeclNode {
    const start = this.previous(),
      name = this.name().value;
    this.expect('(');
    const params: ParameterNode[] = [];
    if (!this.at(')'))
      do {
        const p = this.current(),
          valueType = this.valueType(),
          name = this.name().value;
        params.push({ name, valueType, span: this.span(p) });
      } while (this.match(','));
    this.expect(')');
    const returnType = this.match('->') ? this.valueType(true) : 'void';
    const body = this.block();
    return { kind: 'FunctionDecl', name, params, returnType, body, span: this.span(start) };
  }
  private block(): BlockNode {
    return this.guarded(() => {
      const start = this.expect('{');
      const statements: Statement[] = [];
      while (!this.at('}') && this.current().kind !== 'eof') statements.push(this.statement());
      this.expect('}');
      return { kind: 'Block', statements, span: this.span(start) };
    });
  }
  private variable(): VariableDeclNode {
    const start = this.current(),
      valueType = this.valueType(),
      name = this.name().value;
    this.expect('=');
    const initializer = this.expression();
    return { kind: 'VariableDecl', name, valueType, initializer, span: this.span(start) };
  }
  private assignment(): AssignNode {
    const start = this.name(),
      op = this.take();
    let value: Expression;
    if (op.value === '++' || op.value === '--')
      value = {
        kind: 'BinaryExpr',
        operator: op.value[0]!,
        left: { kind: 'Identifier', name: start.value, span: start.span },
        right: { kind: 'Literal', value: 1, valueType: 'int', span: op.span },
        span: this.span(start),
      };
    else if (['=', '+=', '-=', '*=', '/='].includes(op.value)) {
      value = this.expression();
      if (op.value !== '=')
        value = {
          kind: 'BinaryExpr',
          operator: op.value[0]!,
          left: { kind: 'Identifier', name: start.value, span: start.span },
          right: value,
          span: this.span(start),
        };
    } else fail('Expected assignment or increment', op.span);
    return { kind: 'Assign', name: start.value, value, span: this.span(start) };
  }
  private ifStatement(): IfNode {
    return this.guarded(() => {
      const start = this.expect('if');
      this.expect('(');
      const condition = this.expression();
      this.expect(')');
      const then = this.block();
      const otherwise = this.match('else')
        ? this.at('if')
          ? this.ifStatement()
          : this.block()
        : undefined;
      return { kind: 'If', condition, then, otherwise, span: this.span(start) };
    });
  }
  private statement(): Statement {
    const start = this.current();
    if (this.at('{')) return this.block();
    if (this.at('if')) return this.ifStatement();
    if (this.match('while')) {
      this.expect('(');
      const condition = this.expression();
      this.expect(')');
      const body = this.block();
      return { kind: 'While', condition, body, span: this.span(start) };
    }
    if (this.match('for')) {
      this.expect('(');
      const init = types.includes(this.current().value) ? this.variable() : this.assignment();
      this.expect(';');
      const condition = this.expression();
      this.expect(';');
      const update = this.assignment();
      this.expect(')');
      const body = this.block();
      return { kind: 'For', init, condition, update, body, span: this.span(start) };
    }
    if (this.match('return')) {
      const value = this.at(';') ? undefined : this.expression();
      this.expect(';');
      return { kind: 'Return', value, span: this.span(start) };
    }
    if (types.includes(this.current().value)) {
      const result = this.variable();
      this.expect(';');
      return result;
    }
    if (this.tokens[this.index + 1]?.value !== '(') {
      const result = this.assignment();
      this.expect(';');
      return result;
    }
    const expression = this.expression();
    this.expect(';');
    if (expression.kind !== 'CallExpr' && expression.kind !== 'HardwareCall')
      fail('Only calls can be expression statements', expression.span);
    if (expression.name === 'pinMode' && expression.args.length === 2)
      return {
        kind: 'PinConfig',
        pin: expression.args[0]!,
        mode: expression.args[1]!,
        span: this.span(start),
      };
    return { kind: 'ExprStatement', expression, span: this.span(start) };
  }
  private expression(min = 0): Expression {
    return this.guarded(() => {
      const precedence: Record<string, number> = {
        '||': 1,
        '&&': 2,
        '==': 3,
        '!=': 3,
        '<': 4,
        '>': 4,
        '<=': 4,
        '>=': 4,
        '+': 5,
        '-': 5,
        '*': 6,
        '/': 6,
        '%': 6,
      };
      let left = this.primary();
      let operators = 0;
      while ((precedence[this.current().value] ?? 0) > min) {
        if (++operators > 100)
          fail('Expression contains too many chained operators', this.current().span);
        const op = this.take(),
          right = this.expression(precedence[op.value]!);
        left = {
          kind: 'BinaryExpr',
          operator: op.value,
          left,
          right,
          span: { start: left.span.start, end: right.span.end },
        };
      }
      return left;
    });
  }
  private primary(): Expression {
    const t = this.take();
    if (t.kind === 'number')
      return {
        kind: 'Literal',
        value: Number(t.value),
        valueType: /[.eE]/.test(t.value) ? 'float' : 'int',
        span: t.span,
      };
    if (t.kind === 'string')
      return { kind: 'Literal', value: t.value, valueType: 'string', span: t.span };
    if (t.value === 'true' || t.value === 'false')
      return { kind: 'Literal', value: t.value === 'true', valueType: 'bool', span: t.span };
    if (['!', '-', '+'].includes(t.value)) {
      const operand = this.expression(6);
      return {
        kind: 'UnaryExpr',
        operator: t.value,
        operand,
        span: { start: t.span.start, end: operand.span.end },
      };
    }
    if (t.value === '(') {
      const e = this.expression();
      this.expect(')');
      return e;
    }
    if (t.kind === 'identifier') {
      if (this.match('(')) {
        const args: Expression[] = [];
        if (!this.at(')'))
          do {
            args.push(this.expression());
          } while (this.match(','));
        this.expect(')');
        return {
          kind: hardwareNames.includes(t.value as (typeof hardwareNames)[number])
            ? 'HardwareCall'
            : 'CallExpr',
          name: t.value,
          args,
          span: this.span(t),
        };
      }
      return { kind: 'Identifier', name: t.value, span: t.span };
    }
    return fail('Expected an expression', t.span);
  }
}
export const parse = (source: string): ProgramNode => new Parser(tokenize(source)).parse();
