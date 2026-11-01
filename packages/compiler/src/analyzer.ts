import {
  type ProgramNode,
  type ValueType,
  type Expression,
  type Statement,
  type BlockNode,
  type Diagnostic,
  type FunctionDeclNode,
  type Node,
  fail,
} from './ast.js';
import { boards, type BoardId } from './boards.js';
export const constants: Record<string, number> = {
  HIGH: 1,
  LOW: 0,
  INPUT: 1,
  OUTPUT: 3,
  INPUT_PULLUP: 5,
  INPUT_PULLDOWN: 9,
};
interface Signature {
  params: (ValueType | 'printable')[];
  result: ValueType;
}
const builtins: Record<string, Signature> = {
  pinMode: { params: ['int', 'int'], result: 'void' },
  digitalWrite: { params: ['int', 'int'], result: 'void' },
  digitalRead: { params: ['int'], result: 'int' },
  pwmWrite: { params: ['int', 'int'], result: 'void' },
  delay: { params: ['int'], result: 'void' },
  serialPrint: { params: ['printable'], result: 'void' },
  wifiConnect: { params: ['string', 'string'], result: 'bool' },
  httpGet: { params: ['string'], result: 'string' },
};
export function constantValue(e: Expression): number | undefined {
  if (e.kind === 'Literal' && typeof e.value === 'number') return e.value;
  if (e.kind === 'Identifier' && Object.hasOwn(constants, e.name)) return constants[e.name];
  if (e.kind === 'UnaryExpr') {
    const n = constantValue(e.operand);
    if (n !== undefined && ['+', '-'].includes(e.operator)) return e.operator === '-' ? -n : n;
  }
  return undefined;
}
export function analyze(program: ProgramNode, boardId: BoardId): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const board = boards[boardId];
  const scopes: Map<string, ValueType>[] = [new Map()];
  const functions = new Map<string, FunctionDeclNode>();
  let expectedReturn: ValueType = 'void';
  const error = (message: string, node: Node): void => {
    diagnostics.push({ severity: 'error', message, span: node.span });
  };
  const warn = (message: string, node: Node): void => {
    diagnostics.push({ severity: 'warning', message, span: node.span });
  };
  const compatible = (want: ValueType, got: ValueType): boolean =>
    want === got || (want === 'float' && got === 'int');
  const requireType = (want: ValueType, got: ValueType, node: Node): void => {
    if (!compatible(want, got)) error(`Expected ${want}, received ${got}`, node);
  };
  const lookup = (name: string, node: Node): ValueType => {
    if (Object.hasOwn(constants, name)) return 'int';
    for (let i = scopes.length - 1; i >= 0; i--) {
      const t = scopes[i]!.get(name);
      if (t) return t;
    }
    error(`Unknown variable '${name}'`, node);
    return 'int';
  };
  const define = (name: string, type: ValueType, node: Node): void => {
    const scope = scopes.at(-1)!;
    if (scope.has(name) || functions.has(name) || Object.hasOwn(constants, name))
      error(`Duplicate or reserved name '${name}'`, node);
    scope.set(name, type);
  };
  const numeric = (t: ValueType): boolean => t === 'int' || t === 'float';
  function checkHardware(name: string, args: Expression[], node: Node): void {
    const first = args[0];
    if (!first) return;
    if (['pinMode', 'digitalWrite', 'digitalRead', 'pwmWrite'].includes(name)) {
      const pin = constantValue(first),
        mode = args[1] ? constantValue(args[1]) : undefined;
      if (pin === undefined)
        warn('Dynamic GPIO is validated at runtime; check board wiring', first);
      else {
        if (!Number.isInteger(pin) || !board.pins.includes(pin))
          error(`GPIO ${pin} does not exist on ${board.label}`, first);
        if (board.reserved.includes(pin))
          error(`GPIO ${pin} is reserved for flash on this board profile`, first);
        if (board.caution.includes(pin))
          warn(
            `GPIO ${pin} may be used by boot straps, USB, UART, or module memory; verify your board schematic`,
            first,
          );
        if (
          board.inputOnly.includes(pin) &&
          (name === 'digitalWrite' ||
            name === 'pwmWrite' ||
            (name === 'pinMode' && mode !== constants.INPUT))
        )
          error(`GPIO ${pin} is input-only; use INPUT without configurable pulls`, first);
      }
      if (name === 'pinMode' && mode !== undefined && ![1, 3, 5, 9].includes(mode))
        error('Invalid GPIO mode', args[1]!);
    }
    const value = args[1] ? constantValue(args[1]) : undefined;
    if (
      name === 'pwmWrite' &&
      value !== undefined &&
      (!Number.isInteger(value) || value < 0 || value > 255)
    )
      error('PWM duty must be an integer from 0 to 255', args[1]!);
    if (name === 'digitalWrite' && value !== undefined && ![0, 1].includes(value))
      error('digitalWrite expects HIGH or LOW (1 or 0)', args[1]!);
    if (name === 'delay') {
      const ms = constantValue(first);
      if (ms !== undefined && ms < 0) error('Delay cannot be negative', node);
    }
  }
  function expression(e: Expression): ValueType {
    switch (e.kind) {
      case 'Literal':
        if (
          e.valueType === 'int' &&
          typeof e.value === 'number' &&
          (!Number.isInteger(e.value) || e.value > 2147483647 || e.value < -2147483648)
        )
          error('Integer is outside signed 32-bit range', e);
        return e.valueType;
      case 'Identifier':
        return lookup(e.name, e);
      case 'UnaryExpr': {
        if (
          e.operator === '-' &&
          e.operand.kind === 'Literal' &&
          e.operand.valueType === 'int' &&
          e.operand.value === 2147483648
        )
          return 'int';
        const t = expression(e.operand);
        if (e.operator === '!') {
          requireType('bool', t, e);
          return 'bool';
        }
        if (!numeric(t)) error('Unary arithmetic requires a number', e);
        return t;
      }
      case 'BinaryExpr': {
        const a = expression(e.left),
          b = expression(e.right),
          op = e.operator;
        if (['&&', '||'].includes(op)) {
          requireType('bool', a, e.left);
          requireType('bool', b, e.right);
          return 'bool';
        }
        if (['==', '!='].includes(op)) {
          if (a === 'void' || b === 'void' || !(a === b || (numeric(a) && numeric(b))))
            error('Incompatible equality operands', e);
          return 'bool';
        }
        if (op === '+' && a === 'string' && b === 'string') return 'string';
        if (!numeric(a) || !numeric(b)) error(`Operator '${op}' requires numeric operands`, e);
        if (op === '%') {
          requireType('int', a, e.left);
          requireType('int', b, e.right);
        }
        if (['/', '%'].includes(op) && constantValue(e.right) === 0)
          error('Division by zero', e.right);
        if (['<', '>', '<=', '>='].includes(op)) return 'bool';
        return a === 'float' || b === 'float' ? 'float' : 'int';
      }
      case 'HardwareCall':
      case 'CallExpr': {
        const f = functions.get(e.name);
        const sig = Object.hasOwn(builtins, e.name)
          ? builtins[e.name]
          : f
            ? { params: f.params.map((p) => p.valueType), result: f.returnType }
            : undefined;
        if (!sig) {
          error(`Unknown function '${e.name}'`, e);
          e.args.forEach(expression);
          return 'void';
        }
        if (sig.params.length !== e.args.length)
          error(`${e.name} expects ${sig.params.length} arguments, received ${e.args.length}`, e);
        e.args.forEach((arg, i) => {
          const t = expression(arg),
            want = sig.params[i];
          if (want === 'printable') {
            if (t === 'void') error('Cannot print void', arg);
          } else if (want) requireType(want, t, arg);
        });
        if (Object.hasOwn(builtins, e.name)) checkHardware(e.name, e.args, e);
        return sig.result;
      }
    }
  }
  function block(b: BlockNode, newScope = true): void {
    if (newScope) scopes.push(new Map());
    b.statements.forEach(statement);
    if (newScope) scopes.pop();
  }
  function statement(s: Statement): void {
    switch (s.kind) {
      case 'Block':
        block(s);
        break;
      case 'VariableDecl': {
        const t = expression(s.initializer);
        requireType(s.valueType, t, s.initializer);
        define(s.name, s.valueType, s);
        break;
      }
      case 'Assign':
        if (Object.hasOwn(constants, s.name)) error('Cannot assign a hardware constant', s);
        requireType(lookup(s.name, s), expression(s.value), s.value);
        break;
      case 'PinConfig':
        expression({ kind: 'HardwareCall', name: 'pinMode', args: [s.pin, s.mode], span: s.span });
        break;
      case 'ExprStatement':
        expression(s.expression);
        break;
      case 'If':
        requireType('bool', expression(s.condition), s.condition);
        block(s.then);
        if (s.otherwise) statement(s.otherwise);
        break;
      case 'While':
        requireType('bool', expression(s.condition), s.condition);
        block(s.body);
        break;
      case 'For':
        scopes.push(new Map());
        statement(s.init);
        requireType('bool', expression(s.condition), s.condition);
        statement(s.update);
        block(s.body);
        scopes.pop();
        break;
      case 'Return':
        requireType(expectedReturn, s.value ? expression(s.value) : 'void', s);
        break;
    }
  }
  const returns = (b: BlockNode): boolean =>
    b.statements.some(
      (s) =>
        s.kind === 'Return' ||
        (s.kind === 'Block' && returns(s)) ||
        (s.kind === 'If' &&
          !!s.otherwise &&
          returns(s.then) &&
          (s.otherwise.kind === 'Block'
            ? returns(s.otherwise)
            : returns({ kind: 'Block', statements: [s.otherwise], span: s.otherwise.span }))),
    );
  for (const f of program.functions) {
    if (
      functions.has(f.name) ||
      Object.hasOwn(builtins, f.name) ||
      Object.hasOwn(constants, f.name)
    )
      error(`Duplicate or reserved function '${f.name}'`, f);
    functions.set(f.name, f);
  }
  const constantInitializer = (e: Expression): boolean =>
    e.kind === 'Literal' ||
    (e.kind === 'Identifier' && Object.hasOwn(constants, e.name)) ||
    (e.kind === 'UnaryExpr' && constantInitializer(e.operand)) ||
    (e.kind === 'BinaryExpr' && constantInitializer(e.left) && constantInitializer(e.right));
  for (const g of program.globals) {
    if (!constantInitializer(g.initializer))
      error('Global initializers must be constant expressions; perform hardware work in setup', g);
    statement(g);
  }
  for (const f of program.functions) {
    scopes.push(new Map());
    f.params.forEach((p) => define(p.name, p.valueType, p));
    expectedReturn = f.returnType;
    block(f.body, false);
    if (f.returnType !== 'void' && !returns(f.body))
      error(`Function '${f.name}' must return on every path`, f);
    scopes.pop();
  }
  expectedReturn = 'void';
  block(program.setup);
  block(program.loop.body);
  return diagnostics;
}
