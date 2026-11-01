# EspLang Studio

A local TypeScript compiler, React/Monaco IDE, Arduino-ESP32 binary build server, and browser USB flasher. Node 22.12+ and Chrome or Edge are required. All source, compiler analysis, build logs, and firmware stay on your machine. The editor and its worker are bundled locally.

## Run on Windows

```powershell
cd C:\Users\tharu\esp32_compiler
npm.cmd ci
npm.cmd run setup:toolchain
npm.cmd run dev
```

Open **http://127.0.0.1:5173**. The setup command installs Arduino CLI 1.3.1 and Espressif Arduino core **3.3.2** into `.tools/` without changing your system Arduino installation. The SDK and both Xtensa/RISC-V toolchains require several gigabytes of disk space; the initial download can take several minutes. Running setup again reuses installed packages.

For a single production server:

```powershell
npm.cmd run build
npm.cmd start
```

Then open **http://127.0.0.1:3001**. `start` uses the pinned `tsx` runtime to execute the strictly checked TypeScript workspace. `build` also emits compiler and server JavaScript and the frontend assets.

On Linux/macOS, install [Arduino CLI](https://docs.arduino.cc/arduino-cli/installation/) and run:

```sh
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.2 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
npm ci
npm run dev
```

An existing Arduino installation can be selected with `ARDUINO_CLI` (absolute executable path) and optional `ARDUINO_CONFIG` (configuration path). `HOST` defaults to `127.0.0.1`, `PORT` to `3001`. `ALLOWED_ORIGINS` is an exact comma-separated allowlist. This is a local trusted-user application: authentication, tenant isolation, and OS-level build sandboxing must be added before offering the build server as a public service. A random session token, origin/host checks, payload/log/time limits, a single-build limit, and temporary-directory cleanup are included.

## Use the IDE

1. Edit `program.esp` or load an example. Diagnostics and C++ generation run locally after a short debounce. The **Problems** tab jumps to the source location. Source is autosaved in browser storage.
2. Select the board profile and click **Build**. The server invokes the real Arduino cross compiler; stdout and stderr stream into **Build output**. Cancel stops the child process.
3. Click **Connect USB**, choose your board, then **Flash board**. USB bridge vendor filters cover CP210x, CH340, FTDI, and Espressif. Flashing also prompts for a port if none has been selected.
4. In **Serial monitor**, choose the baud rate and click **Open monitor**. Messages are sent with a newline. Generated firmware starts serial at **115200**; 921600 is available for other firmware. Flash transfer uses 921600 independently of monitor baud.

Select **Serial output** before building: **USB UART bridge** sends `Serial` output over UART0 for CP210x/CH340/FTDI bridges; **Native USB CDC** enables the Arduino `CDCOnBoot=cdc` board option on S2/S3/C3/C6 for their native USB connector. The original ESP32 supports the UART route. Changing this setting requires a new build. This selects the firmware console route separately from the USB flashing transport.

The monitor releases its stream locks and port before flashing, and reopens after a successful flash if it was previously active. If native USB re-enumerates under a new port after reset, select that port again. Reset circuitry and USB bridges must support automatic boot mode; boards without the necessary DTR/RTS wiring may require BOOT/EN buttons. USB flashing needs a secure context (localhost or HTTPS), a compatible driver, a data-capable USB cable, and exclusive access to the port. No physical board was flashed as part of automated tests.

`packages/server/src/nodeSerialAdapter.ts` provides a real `serialport` adapter for an Electron main process. Expose its methods through a context-isolated preload/IPC bridge when adding an Electron shell; an Electron application is not included.

## Project structure

```text
packages/
  compiler/src/
    ast.ts             Strongly typed nodes, spans, diagnostics
    lexer.ts           Tokenizer, comments, strings, numeric literals
    parser.ts          Recursive descent with precedence and depth limits
    analyzer.ts        Scope/type/return checks and hardware validation
    boards.ts          Board IDs, GPIO constraints, FQBNs, offsets
    codegen.ts         Arduino-ESP32 3.x C++ runtime and AST code generation
    index.ts           Compiler API and shared firmware/WebSocket types
  server/src/
    builder.ts         Child processes, image packing, SHA-256, layout checks
    server.ts          Express, WebSockets, local access checks, static assets
    nodeSerialAdapter.ts
  web/src/
    IDE.tsx            Editor, diagnostics, build/flash/monitor lifecycle
    ArtifactDownloads.tsx  Sparse image and manifest downloads
    espFlasher.ts      esptool-js transport, detection, checksums, reset
    serialMonitor.ts   Bidirectional Web Serial with orderly shutdown
    language.ts        Monarch highlighting, completions, theme
    examples.ts
    main.tsx
    style.css
examples/blink.esp
examples/network.esp
scripts/compile.ts
scripts/setup-toolchain.ps1
tests/
e2e/ide.spec.ts
playwright.config.ts
vitest.config.ts
VERIFICATION.md
package.json
package-lock.json
```

Every direct dependency is pinned exactly in the workspace manifests; `package-lock.json` pins the complete dependency graph.

## Language

```text
int led = 2;

fn twice(int n) -> int {
  return n * 2;
}

setup {
  pinMode(led, OUTPUT);
  pinMode(4, INPUT);
  serialPrint("Ready");
}

loop {
  digitalWrite(led, HIGH);
  int sensor = digitalRead(4);
  serialPrint(twice(sensor));
  delay(500);
  digitalWrite(led, LOW);
  delay(500);
}
```

Programs require exactly one `setup` and one `loop` or `task`. `task` is an alias for the repeating loop, rather than a separate FreeRTOS task. Globals require constant initializers; hardware operations belong in setup or loop. Local variables require initialization and use block scope. Types are signed 32-bit `int`, double precision `float`, `bool`, `string` (`Arduino String`), and function return type `void`. Integer-to-float promotion is allowed; narrowing, implicit boolean conversion, and mixed string/number arithmetic are rejected. Arithmetic otherwise follows C++ rules, including integer division and left-to-right expression grouping; function-argument evaluation order is not specified. Avoid integer overflow, dynamic division by zero, and unbounded recursion.

Control flow: `if (condition) { } else { }`, `while (condition) { }`, and `for (int i = 0; i < 10; i++) { }`. Assignments support `=`, `+=`, `-=`, `*=`, `/=`, `++`, `--`. Operators support arithmetic, comparison, equality, `&&`, `||`, `!`, and unary signs. `//` and `/* */` comments are supported. Strings use double quotes and `\n`, `\r`, `\t`, `\"`, `\\` escapes. Functions use `fn name(type param) -> type { ... }`; forward references and recursion are supported. Non-void functions must return on every branch. Arrays, classes, interrupts, and user-defined structs are outside this language version.

| Primitive      | Signature / behavior                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pinMode`      | `(int pin, int mode) -> void`; `INPUT`, `OUTPUT`, `INPUT_PULLUP`, `INPUT_PULLDOWN`                                          |
| `digitalWrite` | `(int pin, int value) -> void`; `HIGH` / `LOW`                                                                              |
| `digitalRead`  | `(int pin) -> int`; digital input                                                                                           |
| `pwmWrite`     | `(int pin, int duty) -> void`; 0–255, 5 kHz, 8-bit; attaches LEDC on first use                                              |
| `delay`        | `(int milliseconds) -> void`; nonnegative                                                                                   |
| `serialPrint`  | `(int/float/bool/string value) -> void`; prints a line                                                                      |
| `wifiConnect`  | `(string ssid, string password) -> bool`; 15-second timeout                                                                 |
| `httpGet`      | `(string url) -> string`; plain `http://`, 5-second connection/read timeouts, 2xx responses with Content-Length up to 16 KB |

HTTPS is rejected instead of disabling certificate verification. A failed/unsupported HTTP request prints a serial diagnostic and returns an empty string. WiFi credentials are embedded in the binary. PWM consumes finite hardware channels; exhaustion prints a diagnostic. Generated loops yield for 1 ms per iteration to permit the ESP32 scheduler to run. Literal GPIOs are checked at compile time; computed GPIOs are guarded at runtime. Pin profiles reserve common flash pins and warn about strap, USB, UART, and module-dependent pins. Always select actual exposed GPIOs for your module; these profiles cannot infer external wiring or every PSRAM configuration.

Compile source without the binary toolchain:

```powershell
npx.cmd tsx scripts/compile.ts examples/blink.esp main.cpp esp32
```

The generated `main.cpp` uses Arduino-ESP32, which itself runs on ESP-IDF. It is not a standalone bare ESP-IDF application. The server creates an empty `.ino` next to `main.cpp`, keeping Arduino's automatic prototype generation away from generated code.

## Binary images and protocol

The server reads expanded Arduino properties, compiles with the default 4 MB partition table, then returns four sparse Base64 artifacts with addresses, lengths, and SHA-256 checksums. It verifies sector alignment/non-overlap and checks application size against the real partition table. Bootloader offset comes from the selected platform properties and must match the board profile:

| Image          | ESP32 / S2 | S3 / C3 / C6 |
| -------------- | ---------- | ------------ |
| bootloader.bin | `0x1000`   | `0x0000`     |
| partitions.bin | `0x8000`   | `0x8000`     |
| boot_app0.bin  | `0xE000`   | `0xE000`     |
| firmware.bin   | `0x10000`  | `0x10000`    |

These layouts follow Espressif's [Arduino platform recipe](https://github.com/espressif/arduino-esp32/blob/3.3.2/platform.txt) and [board definitions](https://github.com/espressif/arduino-esp32/blob/3.3.2/boards.txt). Custom partition tables and arbitrary FQBNs are intentionally not accepted. The flasher uses the [esptool-js API](https://espressif.github.io/esptool-js/docs/) with `compress: true`, `eraseAll: false`, preservation of the compiled flash mode/frequency, MD5 verification, automatic bootloader entry, and hard reset. It refuses mismatched chip families before writing. Only sectors occupied by the four images are erased; flashing includes OTA metadata at `0xE000`.

HTTP: `GET /api/health`, `GET /api/session`, `POST /api/analyze` with `{ source, board }`. WebSocket: `/api/build`; send `{ token, source, board }` once, then receive `log`, `result` (firmware payload), or `error` (message and optional source diagnostics). `#line` directives map generated user statements back to `program.esp` in native build logs. Lexer/parser/semantic diagnostics appear as Monaco markers.

## Verification

See [VERIFICATION.md](VERIFICATION.md) for actual native build results and saved firmware locations.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Tests cover examples across five targets, lexer positions and failures, operator precedence, scopes, function signatures and return paths, GPIO restrictions, runtime guards, call validation, prototype-safe identifiers, nesting limits, and firmware image bounds. Real firmware generation requires the installed Arduino core. Physical reset, USB flashing, and serial behavior require a connected board and browser permission and cannot be validated by compiler tests.

With the dev server running, `npm.cmd run test:smoke` checks HTTP endpoints and origin protection; `npm.cmd run test:firmware` performs a real WebSocket build and saves images to `.verification/esp32/`. Set `SMOKE_BOARD` to test another chip, `SMOKE_SERIAL_ROUTE=usb` for native CDC, or `SMOKE_SOURCE=examples/network.esp` for the network example. `npm.cmd run test:browser` runs headless Chrome tests for editing, markers, examples, generated C++, downloads, serial controls, and mobile layout. `CHROME_PATH` can override the default Windows Chrome executable path; `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001` tests production assets.
