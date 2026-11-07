import { parse } from '../parser.js';
import { analyze, constants, constantValue } from '../analyzer.js';
import {
  CompileError,
  fail,
  type BlockNode,
  type Diagnostic,
  type Expression,
  type Node,
  type ProgramNode,
  type Statement,
} from '../ast.js';
import { assembleXtensa, AssemblyError } from './assembler.js';
import { NATIVE_LAYOUT, packageEsp32Image } from './image.js';

export interface NativeBuild {
  target: 'esp32';
  experimental: true;
  assembly: string;
  image: Uint8Array;
  machineCode: Uint8Array;
  flashOffset: number;
  entryPoint: number;
  symbols: Record<string, number>;
  instructions: { address: number; line: number; text: string }[];
  variables: { name: string; address: number; line: number }[];
  memory: typeof NATIVE_LAYOUT;
}
export interface NativeCompileResult {
  diagnostics: Diagnostic[];
  build?: NativeBuild;
}

/** First native target: original ESP32-WROOM-32, 40 MHz crystal, cold flash boot.
 * Single-core, no interrupts, no C/Arduino/ROM function calls, no heap or ABI calls.
 * Values live in fixed DRAM slots; a2/a3/a4 are expression scratch, a15 is data base.
 */
class Generator {
  private lines: string[] = [];
  private literals = new Map<number, string>();
  private scopes: Map<string, number>[] = [new Map()];
  private nextSlot = 0;
  private sequence = 0;
  private returnLabel = 'setup_end';
  readonly variables: NativeBuild['variables'] = [];
  constructor(private program: ProgramNode) {}
  private emit(text: string): void {
    this.lines.push(`  ${text}`);
  }
  private label(name: string): void {
    this.lines.push(`${name}:`);
  }
  private fresh(): string {
    return `L${this.sequence++}`;
  }
  private load(reg: string, value: number): void {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff)
      fail('Native constant is outside 32-bit range', this.program.span);
    if (value >= -2048 && value <= 2047) this.emit(`movi ${reg}, ${value}`);
    else {
      const bits = value >>> 0;
      let name = this.literals.get(bits);
      if (!name) {
        name = `constant_${this.literals.size}`;
        this.literals.set(bits, name);
      }
      this.emit(`l32r ${reg}, ${name}`);
    }
  }
  private slot(node: Node): number {
    if (this.nextSlot >= NATIVE_LAYOUT.dataSize / 4)
      fail('Native build exceeds 256 variable/temporary slots', node.span);
    return this.nextSlot++ * 4;
  }
  private lookup(name: string, node: Node): number {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const slot = this.scopes[i]!.get(name);
      if (slot !== undefined) return slot;
    }
    return fail(`Unknown native variable '${name}'`, node.span);
  }
  private writeRegister(address: number, value: number): void {
    this.load('a3', address);
    this.load('a2', value);
    this.emit('memw');
    this.emit('s32i a2, a3, 0');
    this.emit('memw');
  }
  private clearRegisterBits(address: number, mask: number): void {
    this.load('a3', address);
    this.load('a4', ~mask >>> 0);
    this.emit('memw');
    this.emit('l32i a2, a3, 0');
    this.emit('and a2, a2, a4');
    this.emit('s32i a2, a3, 0');
    this.emit('memw');
  }
  private startup(): void {
    this.label('_start');
    this.emit('rsil a2, 15'); // No user interrupt handlers in this milestone.
    this.emit('isync');
    this.load('a1', NATIVE_LAYOUT.stackTop);
    this.load('a15', NATIVE_LAYOUT.data);
    // Keep the second core stopped. No cross-core application startup.
    this.writeRegister(0x3ff00034, 1);
    // Disable RTC and timer-group boot watchdogs, preserving other fields.
    for (const [protect, config, flashBootBit] of [
      [0x3ff480a4, 0x3ff4808c, 10],
      [0x3ff5f064, 0x3ff5f048, 14],
      [0x3ff60064, 0x3ff60048, 14],
    ] as const) {
      this.writeRegister(protect, 0x50d83aa1);
      this.clearRegisterBits(config, (0x80000000 | (1 << flashBootBit)) >>> 0);
      this.writeRegister(protect, 0);
    }
    // Select the module's 40 MHz XTAL at divide-by-one. CCOUNT timing uses 40 MHz.
    this.clearRegisterBits(0x3ff66000, 0x3ff); // SYSCON_PRE_DIV_CNT.
    this.clearRegisterBits(0x3ff48070, 3 << 27); // RTC_CNTL_SOC_CLK_SEL = XTAL.
    this.emit('isync');
  }
  private hardware(name: string, args: Expression[], node: Node): void {
    if (name === 'pinMode' || name === 'digitalWrite') {
      if (constantValue(args[0]!) !== 2)
        fail('Native v0.1 currently supports only constant GPIO 2', node.span);
      const value = constantValue(args[1]!);
      if (name === 'pinMode') {
        if (value !== constants.OUTPUT)
          fail('Native v0.1 supports pinMode(2, OUTPUT) only', node.span);
        this.writeRegister(0x3ff49040, 0x2800); // IO_MUX GPIO2: function 2, drive 2.
        this.writeRegister(0x3ff44538, 0x500); // Matrix GPIO output, GPIO_ENABLE owns OEN.
        this.writeRegister(0x3ff44090, 0); // Push-pull, pin interrupts disabled.
        this.writeRegister(0x3ff44024, 4); // GPIO_ENABLE_W1TS.
      } else {
        if (value !== 0 && value !== 1)
          fail('Native digitalWrite requires constant HIGH or LOW', node.span);
        this.writeRegister(value ? 0x3ff44008 : 0x3ff4400c, 4);
      }
      return;
    }
    if (name === 'delay') {
      const milliseconds = constantValue(args[0]!);
      if (
        milliseconds === undefined ||
        !Number.isInteger(milliseconds) ||
        milliseconds < 0 ||
        milliseconds > 60000
      )
        fail('Native delay requires a constant duration from 0 to 60000 milliseconds', node.span);
      if (!milliseconds) return;
      this.load('a5', 40000);
      this.load('a6', milliseconds);
      const outer = this.fresh(),
        inner = this.fresh();
      this.label(outer);
      this.emit('rsr a7, ccount');
      this.label(inner);
      this.emit('rsr a8, ccount');
      this.emit('sub a8, a8, a7');
      this.emit(`bltu a8, a5, ${inner}`); // Unsigned subtraction also handles CCOUNT wrap.
      this.emit('addi a6, a6, -1');
      this.emit(`bnez a6, ${outer}`);
      return;
    }
    fail(`'${name}' is not implemented by the native runtime`, node.span);
  }
  private expression(e: Expression): void {
    switch (e.kind) {
      case 'Literal':
        if (e.valueType !== 'int' && e.valueType !== 'bool')
          fail(`Native v0.1 does not support ${e.valueType}`, e.span);
        this.load('a2', Number(e.value));
        return;
      case 'Identifier':
        if (Object.hasOwn(constants, e.name)) this.load('a2', constants[e.name]!);
        else this.emit(`l32i a2, a15, ${this.lookup(e.name, e)}`);
        return;
      case 'UnaryExpr':
        // Signed minimum is accepted by the existing analyzer as a unary literal.
        if (e.operator === '-' && e.operand.kind === 'Literal' && e.operand.value === 2147483648) {
          this.load('a2', -2147483648);
          return;
        }
        this.expression(e.operand);
        if (e.operator === '-') {
          this.load('a3', 0);
          this.emit('sub a2, a3, a2');
        } else if (e.operator === '!') {
          this.load('a3', 1);
          this.emit('xor a2, a2, a3');
        }
        return;
      case 'BinaryExpr': {
        if (e.operator === '/' || e.operator === '%')
          fail(`Native operator '${e.operator}' is not implemented`, e.span);
        if (e.operator === '&&' || e.operator === '||') {
          this.expression(e.left);
          const evaluateRight = this.fresh(),
            done = this.fresh();
          this.emit(`${e.operator === '&&' ? 'bnez' : 'beqz'} a2, ${evaluateRight}`);
          this.emit(`j ${done}`);
          this.label(evaluateRight);
          this.expression(e.right);
          this.label(done);
          return;
        }
        this.expression(e.left);
        const temporary = this.slot(e);
        this.emit(`s32i a2, a15, ${temporary}`);
        this.expression(e.right);
        this.emit('or a3, a2, a2');
        this.emit(`l32i a2, a15, ${temporary}`);
        const operation = ({ '+': 'add', '-': 'sub', '*': 'mull' } as Record<string, string>)[
          e.operator
        ];
        if (operation) {
          this.emit(`${operation} a2, a2, a3`);
          return;
        }
        const yes = this.fresh(),
          done = this.fresh();
        const branch = (
          {
            '==': 'beq a2, a3',
            '!=': 'bne a2, a3',
            '<': 'blt a2, a3',
            '>': 'blt a3, a2',
            '<=': 'bge a3, a2',
            '>=': 'bge a2, a3',
          } as Record<string, string>
        )[e.operator];
        if (!branch) fail(`Native operator '${e.operator}' is not implemented`, e.span);
        this.emit(`${branch}, ${yes}`);
        this.load('a2', 0);
        this.emit(`j ${done}`);
        this.label(yes);
        this.load('a2', 1);
        this.label(done);
        return;
      }
      case 'HardwareCall':
        this.hardware(e.name, e.args, e);
        return;
      case 'CallExpr':
        fail('User function calls are not implemented by the native backend', e.span);
    }
  }
  private block(block: BlockNode): void {
    this.scopes.push(new Map());
    for (const s of block.statements) this.statement(s);
    this.scopes.pop();
  }
  private conditionFalse(e: Expression, target: string): void {
    this.expression(e);
    const yes = this.fresh();
    this.emit(`bnez a2, ${yes}`);
    this.emit(`j ${target}`);
    this.label(yes);
  }
  private statement(s: Statement): void {
    this.emit(`# EspLang line ${s.span.start.line}:${s.span.start.column}`);
    switch (s.kind) {
      case 'VariableDecl': {
        if (s.valueType !== 'int' && s.valueType !== 'bool')
          fail(`Native v0.1 does not support ${s.valueType}`, s.span);
        this.expression(s.initializer);
        const offset = this.slot(s);
        this.scopes.at(-1)!.set(s.name, offset);
        this.variables.push({
          name: s.name,
          address: NATIVE_LAYOUT.data + offset,
          line: s.span.start.line,
        });
        this.emit(`s32i a2, a15, ${offset}`);
        return;
      }
      case 'Assign':
        this.expression(s.value);
        this.emit(`s32i a2, a15, ${this.lookup(s.name, s)}`);
        return;
      case 'PinConfig':
        this.hardware('pinMode', [s.pin, s.mode], s);
        return;
      case 'ExprStatement':
        this.expression(s.expression);
        return;
      case 'Block':
        this.block(s);
        return;
      case 'If': {
        const otherwise = this.fresh(),
          done = this.fresh();
        this.conditionFalse(s.condition, otherwise);
        this.block(s.then);
        this.emit(`j ${done}`);
        this.label(otherwise);
        if (s.otherwise) this.statement(s.otherwise);
        this.label(done);
        return;
      }
      case 'While': {
        const start = this.fresh(),
          done = this.fresh();
        this.label(start);
        this.conditionFalse(s.condition, done);
        this.block(s.body);
        this.emit(`j ${start}`);
        this.label(done);
        return;
      }
      case 'For': {
        this.scopes.push(new Map());
        this.statement(s.init);
        const start = this.fresh(),
          done = this.fresh();
        this.label(start);
        this.conditionFalse(s.condition, done);
        this.block(s.body);
        this.statement(s.update);
        this.emit(`j ${start}`);
        this.label(done);
        this.scopes.pop();
        return;
      }
      case 'Return':
        this.emit(`j ${this.returnLabel}`);
        return;
    }
  }
  generate(): string {
    if (this.program.functions.length)
      fail('Native v0.1 does not support user-defined functions', this.program.functions[0]!.span);
    this.startup();
    for (const global of this.program.globals) this.statement(global);
    this.block(this.program.setup);
    this.label('setup_end');
    this.label('loop_start');
    this.returnLabel = 'loop_start';
    this.block(this.program.loop.body);
    this.emit('j loop_start');
    this.emit('.balign 4');
    const pool = [...this.literals]
      .map(([value, label]) => `${label}:\n  .word 0x${value.toString(16)}`)
      .join('\n');
    return `# EspLang native v0.1 / ESP32 Xtensa LX6 / experimental\n# Load at 0x40080000; entry is _start, after the literal pool.\n${pool}\n${this.lines.join('\n')}\n`;
  }
}

export function compileNative(source: string, target: string = 'esp32'): NativeCompileResult {
  let program: ProgramNode | undefined;
  let diagnostics: Diagnostic[] = [];
  try {
    if (source.length > 64000)
      throw new CompileError({
        severity: 'error',
        message: 'Native source exceeds 64000 characters',
        span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
      });
    program = parse(source);
    if (target !== 'esp32')
      fail('Native v0.1 targets only original ESP32 / ESP32-WROOM-32', program.span);
    diagnostics = analyze(program, 'esp32');
    if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics };
    const generator = new Generator(program);
    const assembly = generator.generate();
    const linked = assembleXtensa(assembly, NATIVE_LAYOUT.code);
    const entryPoint = linked.symbols._start!;
    const image = packageEsp32Image(entryPoint, [
      { address: NATIVE_LAYOUT.code, data: linked.bytes },
      { address: NATIVE_LAYOUT.data, data: new Uint8Array(NATIVE_LAYOUT.dataSize) },
    ]);
    return {
      diagnostics,
      build: {
        target: 'esp32',
        experimental: true,
        assembly,
        image,
        machineCode: linked.bytes,
        flashOffset: NATIVE_LAYOUT.flashOffset,
        entryPoint,
        symbols: linked.symbols,
        instructions: linked.instructions,
        variables: generator.variables,
        memory: NATIVE_LAYOUT,
      },
    };
  } catch (e) {
    if (e instanceof CompileError) return { diagnostics: [...diagnostics, e.diagnostic] };
    if (
      e instanceof AssemblyError ||
      (program && e instanceof Error && e.message.includes('Segment lies outside'))
    ) {
      return {
        diagnostics: [
          ...diagnostics,
          { severity: 'error', message: e.message, span: program!.span },
        ],
      };
    }
    throw e;
  }
}
