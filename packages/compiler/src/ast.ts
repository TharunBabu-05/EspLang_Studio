export type ValueType = 'int' | 'float' | 'bool' | 'string' | 'void';
export interface Position {
  line: number;
  column: number;
  offset: number;
}
export interface Span {
  start: Position;
  end: Position;
}
export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  span: Span;
}
export interface Node {
  span: Span;
}
export interface ProgramNode extends Node {
  kind: 'Program';
  globals: VariableDeclNode[];
  functions: FunctionDeclNode[];
  setup: BlockNode;
  loop: LoopNode;
}
export interface BlockNode extends Node {
  kind: 'Block';
  statements: Statement[];
}
export interface LoopNode extends Node {
  kind: 'Loop';
  body: BlockNode;
}
export interface FunctionDeclNode extends Node {
  kind: 'FunctionDecl';
  name: string;
  params: ParameterNode[];
  returnType: ValueType;
  body: BlockNode;
}
export interface ParameterNode extends Node {
  name: string;
  valueType: ValueType;
}
export interface VariableDeclNode extends Node {
  kind: 'VariableDecl';
  name: string;
  valueType: ValueType;
  initializer: Expression;
}
export interface AssignNode extends Node {
  kind: 'Assign';
  name: string;
  value: Expression;
}
export interface IfNode extends Node {
  kind: 'If';
  condition: Expression;
  then: BlockNode;
  otherwise?: BlockNode | IfNode;
}
export interface WhileNode extends Node {
  kind: 'While';
  condition: Expression;
  body: BlockNode;
}
export interface ForNode extends Node {
  kind: 'For';
  init: VariableDeclNode | AssignNode;
  condition: Expression;
  update: AssignNode;
  body: BlockNode;
}
export interface ReturnNode extends Node {
  kind: 'Return';
  value?: Expression;
}
export interface ExprStatementNode extends Node {
  kind: 'ExprStatement';
  expression: CallExprNode | HardwareCallNode;
}
export interface PinConfigNode extends Node {
  kind: 'PinConfig';
  pin: Expression;
  mode: Expression;
}
export type Statement =
  | BlockNode
  | VariableDeclNode
  | AssignNode
  | IfNode
  | WhileNode
  | ForNode
  | ReturnNode
  | ExprStatementNode
  | PinConfigNode;
export interface LiteralNode extends Node {
  kind: 'Literal';
  value: string | number | boolean;
  valueType: Exclude<ValueType, 'void'>;
}
export interface IdentifierNode extends Node {
  kind: 'Identifier';
  name: string;
}
export interface BinaryExprNode extends Node {
  kind: 'BinaryExpr';
  operator: string;
  left: Expression;
  right: Expression;
}
export interface UnaryExprNode extends Node {
  kind: 'UnaryExpr';
  operator: string;
  operand: Expression;
}
export interface CallExprNode extends Node {
  kind: 'CallExpr';
  name: string;
  args: Expression[];
}
export interface HardwareCallNode extends Node {
  kind: 'HardwareCall';
  name: string;
  args: Expression[];
}
export type Expression =
  LiteralNode | IdentifierNode | BinaryExprNode | UnaryExprNode | CallExprNode | HardwareCallNode;
export const hardwareNames = [
  'pinMode',
  'digitalWrite',
  'digitalRead',
  'pwmWrite',
  'wifiConnect',
  'httpGet',
  'delay',
  'serialPrint',
] as const;
export class CompileError extends Error {
  constructor(public readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = 'CompileError';
  }
}
export function fail(message: string, span: Span): never {
  throw new CompileError({ severity: 'error', message, span });
}
