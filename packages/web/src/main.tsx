import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { IDE } from './IDE.js';
import './style.css';
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IDE />
  </React.StrictMode>,
);
