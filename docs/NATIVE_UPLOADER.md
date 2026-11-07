 # EspLang ROM uploader v0.1

The next native milestone is a repository-owned USB-UART uploader. Our TypeScript code implements the ESP32 ROM protocol: SLIP framing, command/status handling, register access, flash identification, backup reads, flash writes and digest verification. It does not call esptool, esptool-js, Python or Arduino CLI, or upload a prebuilt flasher stub.

Node.js and `serialport` remain host dependencies. `serialport` supplies OS serial bytes and DTR/RTS control; our code supplies the device protocol. The USB bridge driver and ESP32's factory ROM are still required. This is an implementation of Espressif's documented protocol, not a new hardware protocol.

**Status:** experimental; our uploader's **physical identification check passed** on COM13 with manual BOOT entry while the port was open. It reported original ESP32, flash ID `1660c4`, 4,194,304 flash bytes, 40 MHz crystal, `secureBoot: false` and `flashCryptCount: 0`. Automatic download-mode entry still times out on this Windows/CP210x board. Physical read/write/restore acceptance remains pending. No firmware was erased or written in these checks.

The reference check with esptool (`--no-stub flash-id`) reported ESP32-D0WD-V3 revision 3.1, 40 MHz crystal and 4 MB flash (manufacturer `c4`, device `6016`). Our successful check subsequently used only the repository's ROM uploader, Node.js and serialport. The earlier successful blink upload used esptool and does not validate our write path.

## Commands

Run from the repository after `npm ci`. Windows PowerShell uses `npm.cmd`; other platforms use `npm`. Close the IDE USB connection and serial monitors. Select your own port explicitly.

```powershell
npm.cmd run native:usb -- ports
npm.cmd run native:usb -- flash-id --port COM13
```

`flash-id` checks the original ESP32 chip signature, security configuration, approximate crystal frequency and JEDEC flash capacity. Supported target: original ESP32, 40 MHz crystal, 4 MiB flash, secure boot and flash encryption disabled. Other variants and protected devices are rejected before flash modification.

```powershell
npm.cmd run native:usb -- read-flash --port COM13
```

`read-flash` saves all 4 MiB by default. ROM reads use 64-byte packets at 115200 baud, so this can take many minutes. Wait for completion; do not press RESET. To check a smaller region first:

```powershell
npm.cmd run native:usb -- read-flash --port COM13 --offset 0x1000 --length 0x1000
```

A sector backup covers only that region, not the entire original firmware. Each completed backup has a unique directory under `.builds/backups/`, with `flash.bin` and `recovery.json`. The manifest records the region, board fingerprint and SHA-256. Keep both files together and private. ROM MD5 and the saved file's SHA-256 are checked before the completion manifest is created. An interrupted operation has no completed manifest; a `.partial` file must never be restored.

```powershell
npm.cmd run build:native -- examples/native-blink.esp
npm.cmd run native:usb -- write-flash --port COM13 --image .builds/native/native-blink/program.bin --confirm-write
```

`write-flash` accepts our v0.1 native image layout, validates its header, segments, entry startup and checksum, and writes at **0x1000**. This replaces the usual second-stage bootloader. Before erasing, it automatically backs up and verifies every affected 4 KiB sector and prints the recovery manifest path. A failed backup prevents the write. Transfers use 1 KiB blocks padded with `0xff`; ROM MD5 must match the input image before a hardware reset is requested. Unwritten bytes in an erased sector become `0xff`; the automatic backup preserves their previous contents for recovery.

The explicit `--confirm-write` flag is required for writing or restoring. Compilation alone never opens USB. There is no bulk erase, eFuse programming, silent fallback or automatic retry of failed writes.

```powershell
npm.cmd run native:usb -- restore-flash --port COM13 --backup .builds/backups/esp32-REPLACE/recovery.json --confirm-write
```

`restore-flash` accepts only a completed manifest and matching image from this uploader, validates its SHA-256 and board fingerprint, backs up the current region, then restores and verifies the selected region. Replace the example path with the actual printed path. A full backup restores all flash; an automatic pre-write backup restores only affected sectors. A later backup cannot recover firmware already overwritten before that backup.

## BOOT / EN and failures

Commands normally attempt automatic DTR/RTS entry. Board wiring and Windows USB drivers can affect this. If SYNC times out, run with `--manual-boot` in an interactive terminal:

```powershell
npm.cmd run native:usb -- flash-id --port COM13 --manual-boot
```

Wait for **Port is open**, then hold **BOOT**, briefly press **EN/RESET**, release BOOT, and press Enter. This order matters because opening a serial port can affect reset lines and undo an earlier button sequence. The option skips our automatic entry sequence. SYNC is repeated within a bounded deadline to allow ROM baud detection; flash commands are never automatically repeated.

Successful commands request a reset into firmware. On failure, the CLI does not intentionally reset into a potentially incomplete image; actual line state on port close is driver-dependent. Re-enter ROM before retrying or restoring. Ctrl+C cancels the command and closes the connection. A disconnect or malformed/failed response invalidates the session.

RESET restarts the chip and interrupts an ongoing transfer; it does not restore old firmware. Before hardware writes, first establish reliable identification and a verified backup. Physical write and restore tests remain explicit acceptance steps, not part of `npm test`.

## Implementation and verification

| File under `packages/server/src/nativeUploader/` | Responsibility                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `protocol.ts`                                    | Bounded SLIP codec, ROM command framing, status validation, timeouts, cancellation |
| `serial.ts`                                      | OS transport, reset lines, explicit port selection and cleanup                     |
| `esp32.ts`                                       | Chip/security checks, JEDEC transaction, ROM reads/writes and MD5                  |
| `image.ts`                                       | Accept only the native v0.1 image layout before opening hardware                   |
| `recovery.ts`                                    | Backup completion manifests, disk integrity, board binding and recovery sequencing |
| `cli.ts`                                         | Command arguments, progress and lifecycle                                          |

Tests use an independent byte-level ROM transport fixture. They cover fragmented/escaped responses, extra SYNC replies, malformed frames, command errors, timeout, cancellation, disconnect, chip/security/flash rejection, block padding, verification failures, backup-before-erase ordering and restore validation. Mocks cannot establish real reset timing, SPI behavior or flash reliability.

Hardware acceptance sequence: identify; read and independently check a sector; take a full backup; explicitly write native blink; check LED and cold power-cycle; restore a verified region and check it. The Arduino browser uploader remains unchanged, and the native uploader is CLI-only.

Protocol references: [Espressif ROM serial protocol](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html), [ESP32 technical reference manual](https://www.espressif.com/sites/default/files/documentation/esp32_technical_reference_manual_en.pdf). Existing Espressif tools were used as interoperability references, not imported into this uploader.
