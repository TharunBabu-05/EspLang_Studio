import type { Monaco } from '@monaco-editor/react';
import { hardwareNames } from '@esplang/compiler';
export function registerEspLang(monaco: Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === 'esplang')) return;
  monaco.languages.register({ id: 'esplang', extensions: ['.esp'] });
  monaco.languages.setMonarchTokensProvider('esplang', {
    keywords: ['setup', 'loop', 'task', 'fn', 'if', 'else', 'while', 'for', 'return'],
    typeKeywords: ['int', 'float', 'bool', 'string', 'void'],
    builtins: [...hardwareNames],
    constants: [
      'HIGH',
      'LOW',
      'INPUT',
      'OUTPUT',
      'INPUT_PULLUP',
      'INPUT_PULLDOWN',
      'true',
      'false',
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [
          /[a-zA-Z_][\w]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'type',
              '@builtins': 'predefined',
              '@constants': 'constant',
              '@default': 'identifier',
            },
          },
        ],
        [/\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
        [/"/, 'string', '@string'],
        [/[{}()[\]]/, '@brackets'],
        [/[+\-*/%=!<>&|]+/, 'operator'],
        [/[;,]/, 'delimiter'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      string: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration('esplang', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
  });
  const snippets: Record<string, string> = {
    pinMode: 'pinMode(${1:2}, ${2:OUTPUT});',
    digitalWrite: 'digitalWrite(${1:2}, ${2:HIGH});',
    digitalRead: 'digitalRead(${1:4})',
    pwmWrite: 'pwmWrite(${1:2}, ${2:128});',
    delay: 'delay(${1:500});',
    serialPrint: 'serialPrint(${1:"Hello, ESP32"});',
    wifiConnect: 'wifiConnect(${1:"SSID"}, ${2:"password"})',
    httpGet: 'httpGet(${1:"http://example.com"})',
    setup: 'setup {\n\t${1}\n}',
    loop: 'loop {\n\t${1}\n}',
    fn: 'fn ${1:name}(${2:int value}) -> ${3:int} {\n\treturn ${4:value};\n}',
  };
  monaco.languages.registerCompletionItemProvider('esplang', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      return {
        suggestions: Object.entries(snippets).map(([label, insertText]) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          },
        })),
      };
    },
  });
  monaco.editor.defineTheme('esplang-night', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c9a3ff' },
      { token: 'type', foreground: '7ec9f5' },
      { token: 'predefined', foreground: '76ddbd' },
      { token: 'constant', foreground: 'edbc7a' },
      { token: 'comment', foreground: '63738d' },
      { token: 'string', foreground: 'a8d88a' },
    ],
    colors: {
      'editor.background': '#11151e',
      'editorLineNumber.foreground': '#49536a',
      'editor.lineHighlightBackground': '#191f2c',
      'editorGutter.background': '#11151e',
    },
  });
}
