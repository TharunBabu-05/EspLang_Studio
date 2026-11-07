export * from './ast.js';
export * from './boards.js';
export * from './lexer.js';
export * from './parser.js';
export * from './analyzer.js';
export * from './codegen.js';
export { compileNative, type NativeBuild, type NativeCompileResult } from './native/compiler.js';
import { CompileError, type Diagnostic, type ProgramNode } from './ast.js';
import { parse } from './parser.js';
import { analyze } from './analyzer.js';
import { generate } from './codegen.js';
import type { BoardId } from './boards.js';
export interface CompileResult {
  diagnostics: Diagnostic[];
  cpp?: string;
  ast?: ProgramNode;
}
export function compile(source: string, board: BoardId = 'esp32'): CompileResult {
  try {
    const ast = parse(source);
    const diagnostics = analyze(ast, board);
    return {
      ast,
      diagnostics,
      cpp: diagnostics.some((d) => d.severity === 'error') ? undefined : generate(ast, board),
    };
  } catch (e) {
    if (e instanceof CompileError) return { diagnostics: [e.diagnostic] };
    throw e;
  }
}
export interface Artifact {
  name: string;
  address: number;
  data: string;
  size: number;
  sha256: string;
}
export interface Firmware {
  board: BoardId;
  serialRoute?: 'uart' | 'usb';
  fqbn: string;
  artifacts: Artifact[];
  cpp: string;
  diagnostics: Diagnostic[];
}
export type ServerEvent =
  | { type: 'log'; message: string }
  | { type: 'status'; state: 'queued' | 'building'; position?: number }
  | { type: 'result'; firmware: Firmware }
  | { type: 'error'; message: string; diagnostics?: Diagnostic[]; retryAfter?: number };
