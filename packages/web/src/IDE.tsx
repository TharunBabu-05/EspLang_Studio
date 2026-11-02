import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  boards,
  compile,
  type BoardId,
  type Diagnostic,
  type Firmware,
  type ServerEvent,
} from '@esplang/compiler';
import { registerEspLang } from './language.js';
import { flashFirmware, requestEspPort, serialSupported } from './espFlasher.js';
import { SerialMonitor } from './serialMonitor.js';
import { examples } from './examples.js';
import { ArtifactDownloads } from './ArtifactDownloads.js';
function savedSource(): string {
  try {
    return localStorage.getItem('esplang-source') ?? examples['Blink & read']!;
  } catch {
    return examples['Blink & read']!;
  }
}
function download(name: string, data: BlobPart): void {
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function IDE() {
  const [source, setSource] = useState(savedSource),
    [board, setBoard] = useState<BoardId>('esp32');
  const [serialRoute, setSerialRoute] = useState<'uart' | 'usb'>('uart');
  useEffect(() => {
    if (board === 'esp32') setSerialRoute('uart');
  }, [board]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]),
    [cpp, setCpp] = useState('');
  const [tab, setTab] = useState<'build' | 'serial' | 'problems'>('build');
  const [logs, setLogs] = useState(
    'EspLang Studio is ready.\nBuild your program, connect a board, and bring it to life.\n',
  );
  const [serialText, setSerialText] = useState(''),
    [serialInput, setSerialInput] = useState('');
  const [firmware, setFirmware] = useState<Firmware>(),
    [building, setBuilding] = useState(false),
    [flashing, setFlashing] = useState(false);
  const [progress, setProgress] = useState(0),
    [port, setPort] = useState<SerialPort>(),
    [monitoring, setMonitoring] = useState(false),
    [baud, setBaud] = useState(115200);
  const [serverState, setServerState] = useState('Checking build server'),
    [showCpp, setShowCpp] = useState(false),
    [notice, setNotice] = useState('');
  const [hosted, setHosted] = useState(false);
  const [buildStage, setBuildStage] = useState('Connecting to build service');
  const [buildLimit, setBuildLimit] = useState<number>();
  const buildAbortRef = useRef<AbortController | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const monitor = useRef(new SerialMonitor());
  const terminalRef = useRef<HTMLPreElement>(null);
  const appendLog = useCallback(
    (text: string) => setLogs((old) => (old + text).slice(-200000)),
    [],
  );
  const reportError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      appendLog(`Error: ${message}\n`);
    },
    [appendLog],
  );
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal })
      .then((r) => r.json())
      .then((status: { toolchain: boolean; mode?: string; limits?: { buildsPerHour: number } }) => {
        setHosted(status.mode === 'hosted');
        setBuildLimit(status.limits?.buildsPerHour);
        setServerState(
          status.toolchain
            ? 'Build server ready'
            : status.mode === 'hosted'
              ? 'Build workers unavailable'
              : 'ESP32 toolchain needs setup',
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setServerState('Build server offline');
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem('esplang-source', source);
      } catch {
        /* Private browser storage may be unavailable. */
      }
      try {
        const result = compile(source, board);
        setDiagnostics(result.diagnostics);
        setCpp(result.cpp ?? '');
      } catch (e) {
        reportError(e);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [source, board, reportError]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    const monaco = monacoRef.current;
    if (!model || !monaco || showCpp) return;
    monaco.editor.setModelMarkers(
      model,
      'esplang',
      diagnostics.map((d) => ({
        severity:
          d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: d.message,
        startLineNumber: d.span.start.line,
        startColumn: d.span.start.column,
        endLineNumber: d.span.end.line,
        endColumn: Math.max(d.span.end.column, d.span.start.column + 1),
      })),
    );
  }, [diagnostics, showCpp]);
  useEffect(() => {
    setFirmware(undefined);
  }, [source, board, serialRoute]);
  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [logs, serialText, tab]);
  useEffect(
    () => () => {
      socketRef.current?.close();
      buildAbortRef.current?.abort();
      void monitor.current.close().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!serialSupported()) return;
    const disconnected = (event: Event): void => {
      if (event.target === port) {
        setPort(undefined);
        setMonitoring(false);
        void monitor.current.close().catch(() => {});
        appendLog('USB device disconnected.\n');
      }
    };
    navigator.serial.addEventListener('disconnect', disconnected);
    return () => navigator.serial.removeEventListener('disconnect', disconnected);
  }, [port, appendLog]);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const busy = building || flashing;
  async function build(): Promise<void> {
    if (busy) return;
    setBuilding(true);
    setFirmware(undefined);
    setNotice('');
    setLogs(`Building for ${boards[board].label}…\n`);
    setTab('build');
    setBuildStage('Connecting to build service');
    const controller = new AbortController();
    buildAbortRef.current = controller;
    let terminal = false;
    try {
      const response = await fetch('/api/session', { signal: controller.signal });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? 'Too many requests. Wait a moment before building again.'
            : 'Cannot access the build server',
        );
      const session = (await response.json()) as { token: string };
      controller.signal.throwIfAborted();
      const socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/build`,
      );
      socketRef.current = socket;
      socket.onopen = () =>
        socket.send(JSON.stringify({ source, board, serialRoute, token: session.token }));
      socket.onmessage = (event) => {
        if (controller.signal.aborted) return;
        try {
          const data = JSON.parse(String(event.data)) as ServerEvent;
          if (data.type === 'log') appendLog(data.message);
          else if (data.type === 'status') {
            const stage =
              data.state === 'queued'
                ? `Queued · position ${data.position ?? 1}`
                : 'Building firmware';
            setBuildStage(stage);
            appendLog(`${stage}\n`);
          } else if (data.type === 'result') {
            terminal = true;
            setFirmware(data.firmware);
            setCpp(data.firmware.cpp);
            appendLog(`Ready to flash · ${data.firmware.artifacts.length} images\n`);
          } else {
            terminal = true;
            if (data.diagnostics) setDiagnostics(data.diagnostics);
            reportError(
              `${data.message}${data.retryAfter ? ` Retry in ${data.retryAfter} seconds.` : ''}`,
            );
          }
        } catch (e) {
          reportError(e);
          socket.close();
        }
      };
      socket.onerror = () => {
        if (controller.signal.aborted) return;
        terminal = true;
        reportError('Build connection failed. Please try again.');
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        if (!terminal && !controller.signal.aborted)
          reportError('Build connection closed before completion. Please build again.');
        setBuilding(false);
        socketRef.current = null;
        buildAbortRef.current = null;
      };
    } catch (e) {
      if (buildAbortRef.current === controller) {
        setBuilding(false);
        buildAbortRef.current = null;
      }
      if (!controller.signal.aborted) reportError(e);
    }
  }
  function cancelBuild(): void {
    buildAbortRef.current?.abort();
    socketRef.current?.close();
    socketRef.current = null;
    buildAbortRef.current = null;
    setBuilding(false);
    appendLog('Build cancelled.\n');
  }
  async function connect(): Promise<void> {
    try {
      setNotice('');
      const selected = await requestEspPort();
      setPort(selected);
      appendLog('USB port selected. Ready to flash or open the serial monitor.\n');
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) reportError(e);
    }
  }
  const serialError = (e: Error): void => {
    setMonitoring(false);
    reportError(e);
  };
  async function startMonitor(selected: SerialPort): Promise<void> {
    await monitor.current.open(
      selected,
      baud,
      (text) => setSerialText((old) => (old + text).slice(-200000)),
      serialError,
    );
    setMonitoring(true);
  }
  async function toggleMonitor(): Promise<void> {
    try {
      if (monitoring) {
        await monitor.current.close();
        setMonitoring(false);
      } else {
        const selected = port ?? (await requestEspPort());
        setPort(selected);
        await startMonitor(selected);
        setTab('serial');
      }
    } catch (e) {
      reportError(e);
    }
  }
  async function flash(): Promise<void> {
    if (!firmware || busy) return;
    const reconnect = monitoring;
    setFlashing(true);
    setProgress(0);
    setNotice('');
    setTab('build');
    try {
      const selected = port ?? (await requestEspPort());
      setPort(selected);
      await monitor.current.close();
      setMonitoring(false);
      const chip = await flashFirmware(selected, firmware, appendLog, setProgress);
      appendLog(`Verified and flashed ${chip}. Firmware is running.\n`);
      if (reconnect) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await startMonitor(selected);
        setTab('serial');
      }
    } catch (e) {
      reportError(e);
    } finally {
      setFlashing(false);
    }
  }
  function jump(d: Diagnostic): void {
    setShowCpp(false);
    setTimeout(() => {
      editorRef.current?.revealLineInCenter(d.span.start.line);
      editorRef.current?.setPosition({
        lineNumber: d.span.start.line,
        column: d.span.start.column,
      });
      editorRef.current?.focus();
    }, 0);
  }
  return (
    <div className="studio">
      <header className="topbar">
        <a className="brand" href="/" aria-label="EspLang Studio home">
          <span className="brand-mark">
            e<span>_</span>
          </span>
          <span>
            EspLang <b>Studio</b>
          </span>
          <small>{hosted ? 'CLOUD WORKSPACE' : 'LOCAL WORKSPACE'}</small>
        </a>
        <div className="top-links">
          <span className="status-dot" />
          {serverState}
          <a href="https://github.com/espressif/arduino-esp32" target="_blank" rel="noreferrer">
            Arduino core ↗
          </a>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="workspace-title">
            <span className="eyebrow">WORKSPACE</span>
            <span>⌘</span>
          </div>
          <button className="file selected" onClick={() => setShowCpp(false)}>
            <span className="file-icon">E</span>program.esp
            <span className="saved-dot" />
          </button>
          <button className={`file ${showCpp ? 'selected' : ''}`} onClick={() => setShowCpp(true)}>
            <span className="cpp-icon">C++</span>main.cpp<span className="muted">↗</span>
          </button>
          <div className="sidebar-section">
            <span className="eyebrow">EXAMPLES</span>
            {Object.keys(examples).map((title, i) => (
              <button
                key={title}
                disabled={busy}
                onClick={() => {
                  setSource(examples[title]!);
                  setShowCpp(false);
                }}
              >
                <span className="example-number">0{i + 1}</span>
                {title}
                <span className="example-arrow">↗</span>
              </button>
            ))}
          </div>
          <div className="board-card">
            <span className="eyebrow">TARGET HARDWARE</span>
            <div className="chip-art">
              <div className="chip-inner">
                ESP<span>32</span>
                <small>WIRELESS MCU</small>
              </div>
            </div>
            <label htmlFor="board">Board profile</label>
            <select
              id="board"
              value={board}
              disabled={busy}
              onChange={(e) => setBoard(e.target.value as BoardId)}
            >
              {Object.values(boards).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
            <label htmlFor="serial-route" style={{ marginTop: 12 }}>
              Serial output
            </label>
            <select
              id="serial-route"
              value={serialRoute}
              disabled={busy}
              onChange={(event) => setSerialRoute(event.target.value as 'uart' | 'usb')}
            >
              <option value="uart">USB UART bridge</option>
              <option value="usb" disabled={board === 'esp32'}>
                Native USB CDC
              </option>
            </select>
            <p>
              4 MB flash · Arduino 3.x
              <br />
              USB UART / native USB
            </p>
            <div className="connection-state">
              <span className={`status-dot ${port ? '' : 'offline'}`} />
              {port ? 'USB port selected' : 'No board connected'}
            </div>
          </div>
          <div className="sidebar-bottom">
            <span>EspLang compiler</span>
            <span>v1.0.0</span>
          </div>
        </aside>
        <main className="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">CODE. COMPILE. CONNECT.</div>
              <h1>From an idea to a blinking LED.</h1>
              <p>A small language for the things you build.</p>
            </div>
            <span className="language-tag">
              EspLang <span>TS → C++ → BIN</span>
            </span>
          </div>
          <div className="toolbar">
            <div className="editor-tabs">
              <button className={!showCpp ? 'active' : ''} onClick={() => setShowCpp(false)}>
                <span className="file-icon">E</span>program.esp
                <span className="tab-dot" />
              </button>
              <button className={showCpp ? 'active' : ''} onClick={() => setShowCpp(true)}>
                main.cpp
              </button>
            </div>
            <div className="actions">
              <select
                className="mobile-board"
                aria-label="Build target"
                value={board}
                disabled={busy}
                onChange={(event) => setBoard(event.target.value as BoardId)}
              >
                {Object.values(boards).map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.id.toUpperCase()}
                  </option>
                ))}
              </select>
              <select
                className="mobile-board"
                aria-label="Serial output route"
                value={serialRoute}
                disabled={busy}
                onChange={(event) => setSerialRoute(event.target.value as 'uart' | 'usb')}
              >
                <option value="uart">USB UART bridge</option>
                <option value="usb" disabled={board === 'esp32'}>
                  Native USB CDC
                </option>
              </select>
              <button className="secondary" disabled={busy} onClick={() => void connect()}>
                {port ? '↔ Change port' : '↔ Connect USB'}
              </button>
              <button
                className="secondary"
                disabled={busy || errors > 0}
                onClick={() => void build()}
              >
                {building ? '◌ Building…' : '▷ Build'}
              </button>
              <button className="primary" disabled={busy || !firmware} onClick={() => void flash()}>
                {flashing ? `Flashing ${Math.round(progress)}%` : '↥ Flash board'}
              </button>
            </div>
          </div>
          {hosted && (
            <div className="hosted-info">
              Firmware builds on the server. USB flashing stays in your browser.
              {buildLimit && <span> Up to {buildLimit} builds per hour per network address.</span>}
              <span> Source is sent when you build; avoid embedding private credentials.</span>
            </div>
          )}
          {building && (
            <div className="build-status" role="status" aria-live="polite">
              <span>
                <span className="status-dot" />
                {buildStage}
              </span>
              <button className="secondary" onClick={cancelBuild}>
                Cancel build
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <button aria-label="Dismiss message" onClick={() => setNotice('')}>
                ×
              </button>
            </div>
          )}
          {!serialSupported() && (
            <div className="notice">
              Use Chrome or Edge on localhost or HTTPS for direct USB access.
            </div>
          )}
          <div className="editor-container">
            <Editor
              key={showCpp ? 'cpp' : 'esp'}
              path={showCpp ? 'main.cpp' : 'program.esp'}
              language={showCpp ? 'cpp' : 'esplang'}
              value={showCpp ? cpp || '// Fix EspLang diagnostics to see generated C++.' : source}
              beforeMount={registerEspLang}
              onMount={(editor, monaco) => {
                editorRef.current = editor;
                monacoRef.current = monaco;
                if (!showCpp) {
                  monaco.editor.setModelMarkers(
                    editor.getModel()!,
                    'esplang',
                    diagnostics.map((d) => ({
                      message: d.message,
                      severity:
                        d.severity === 'error'
                          ? monaco.MarkerSeverity.Error
                          : monaco.MarkerSeverity.Warning,
                      startLineNumber: d.span.start.line,
                      startColumn: d.span.start.column,
                      endLineNumber: d.span.end.line,
                      endColumn: Math.max(d.span.end.column, d.span.start.column + 1),
                    })),
                  );
                }
              }}
              theme="esplang-night"
              onChange={(value) => {
                if (!showCpp) setSource(value ?? '');
              }}
              options={{
                readOnly: showCpp || busy,
                fontSize: 14,
                lineHeight: 25,
                fontFamily: "'Cascadia Code', 'Consolas', monospace",
                minimap: { enabled: false },
                padding: { top: 20 },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                smoothScrolling: true,
                tabSize: 2,
                wordWrap: 'on',
                renderLineHighlight: 'all',
              }}
            />
          </div>
          <div className="editor-footer">
            <span>
              <span className={`status-dot ${errors ? 'error' : ''}`} />
              {errors ? `${errors} error${errors > 1 ? 's' : ''}` : 'Syntax checked'}
              <span className="muted">
                {diagnostics.filter((d) => d.severity === 'warning').length} warnings
              </span>
            </span>
            <span>
              UTF-8 <span className="muted">EspLang</span>
              <button
                onClick={() =>
                  download(showCpp ? 'main.cpp' : 'program.esp', showCpp ? cpp : source)
                }
              >
                ↓ Save {showCpp ? 'C++' : 'source'}
              </button>
            </span>
          </div>
          {flashing && (
            <progress
              className="flash-progress"
              aria-label="Flash progress"
              max={100}
              value={progress}
            />
          )}
          <section className="console">
            <div className="console-toolbar">
              <div className="console-tabs">
                <button className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}>
                  Build output
                </button>
                <button
                  className={tab === 'serial' ? 'active' : ''}
                  onClick={() => setTab('serial')}
                >
                  Serial monitor {monitoring && <span className="status-dot" />}
                </button>
                <button
                  className={tab === 'problems' ? 'active' : ''}
                  onClick={() => setTab('problems')}
                >
                  Problems <span className="count">{diagnostics.length}</span>
                </button>
              </div>
              <div className="console-controls">
                {tab === 'serial' && (
                  <>
                    <select
                      aria-label="Serial baud rate"
                      value={baud}
                      disabled={monitoring || flashing}
                      onChange={(e) => setBaud(Number(e.target.value))}
                    >
                      <option value={115200}>115200 baud</option>
                      <option value={921600}>921600 baud</option>
                    </select>
                    <button disabled={busy} onClick={() => void toggleMonitor()}>
                      {monitoring ? 'Disconnect' : 'Open monitor'}
                    </button>
                  </>
                )}
                <button onClick={() => (tab === 'serial' ? setSerialText('') : setLogs(''))}>
                  Clear
                </button>
              </div>
            </div>
            {tab === 'problems' ? (
              <div className="problems">
                {diagnostics.length ? (
                  diagnostics.map((d, i) => (
                    <button key={i} onClick={() => jump(d)}>
                      <span className={d.severity}>{d.severity === 'error' ? '×' : '△'}</span>
                      <span>{d.message}</span>
                      <small>
                        {d.span.start.line}:{d.span.start.column}
                      </small>
                    </button>
                  ))
                ) : (
                  <p>No problems found. Your program is ready to build.</p>
                )}
              </div>
            ) : (
              <pre ref={terminalRef} className="terminal" aria-live="polite">
                {tab === 'build'
                  ? logs
                  : serialText || 'Open the serial monitor to see output from your board.\n'}
              </pre>
            )}
            {tab === 'serial' && (
              <form
                className="serial-input"
                onSubmit={(e) => {
                  e.preventDefault();
                  void monitor.current
                    .write(`${serialInput}\n`)
                    .then(() => setSerialInput(''))
                    .catch(reportError);
                }}
              >
                <span>❯</span>
                <input
                  aria-label="Serial message"
                  placeholder="Send a message to your board…"
                  value={serialInput}
                  onChange={(e) => setSerialInput(e.target.value)}
                  disabled={!monitoring || flashing}
                />
                <button disabled={!monitoring || flashing}>Send ↵</button>
              </form>
            )}
          </section>
          {firmware && <ArtifactDownloads firmware={firmware} />}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          <span className="status-dot" />
          {hosted ? 'Cloud builds · direct browser USB' : 'All processing stays on this machine'}
        </span>
        <span>
          {firmware
            ? `${(firmware.artifacts.reduce((n, a) => n + a.size, 0) / 1024).toFixed(1)} KB · 4 verified images ready`
            : 'Build → Connect → Flash'}
          <span className="footer-divider">|</span>
          {boards[board].label}
        </span>
      </footer>
    </div>
  );
}
