# Verification — 2026-11-01

Verified on Windows with Node 22.16.0, Arduino CLI 1.3.1, Arduino-ESP32 3.3.2, and the installed Chrome browser.

Final checks: **33 unit/integration tests passed**, **3 browser tests passed**, TypeScript checks passed, and all three workspace packages built successfully. Browser checks also passed against the production assets served on port 3001.

The full compiler-to-WebSocket-to-binary pipeline built the following real application images. Every build returned bootloader, partition table, OTA metadata, and application images. The smoke runner verified SHA-256 checksums and sizes; the server checked image bounds, sector overlap, partition offset, and available application space.

| Target            | Console route  | Bootloader offset | Application bytes | Artifact directory             |
| ----------------- | -------------- | ----------------- | ----------------: | ------------------------------ |
| ESP32             | UART           | `0x1000`          |           282,032 | `.verification/esp32/`         |
| ESP32-S3          | Native USB CDC | `0x0000`          |           307,184 | `.verification/esp32s3/`       |
| ESP32-C3          | Native USB CDC | `0x0000`          |           291,552 | `.verification/esp32c3/`       |
| ESP32-S2          | Native USB CDC | `0x1000`          |           299,040 | `.verification/esp32s2/`       |
| ESP32-C6          | Native USB CDC | `0x0000`          |           267,472 | `.verification/esp32c6/`       |
| ESP32 WiFi + HTTP | UART           | `0x1000`          |           934,640 | `.verification/esp32-network/` |

The first five builds used `examples/blink.esp`; the network build used `examples/network.esp`. The artifact directories are local generated output and are ignored by Git. Each includes the four binary images, generated `main.cpp`, and a `firmware.json` manifest containing Base64 images and checksums.

TypeScript checks, production builds, compiler/hardware validation tests, stream ownership tests, and process cancellation tests passed. HTTP/WebSocket smoke checks covered diagnostics, invalid boards, forbidden origins, malformed JSON, invalid token byte lengths, and compiler-error delivery. Browser checks passed against both the Vite development server and the backend serving production assets; they covered source editing and persistence, markers and problem navigation, examples, generated C++, downloads, serial controls, and viewport overflow. Screenshots are in `.verification/ide-desktop.png` and `.verification/ide-mobile.png`.

Native compilation verifies SDK integration, rather than execution on a board. No physical board was flashed. Chip detection, reset circuitry, MD5 readback, real GPIO, WiFi connectivity, and bidirectional hardware serial still require physical acceptance testing; USB engine tests use a mock transport. The pinned npm dependency graph had zero known vulnerabilities when audited.
