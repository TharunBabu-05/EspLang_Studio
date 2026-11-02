#!/bin/sh
set -eu
case "$(uname -m)" in
  x86_64) archive=arduino-cli_1.3.1_Linux_64bit.tar.gz ;;
  *) echo 'The hosted worker image currently supports Linux x86_64 only.' >&2; exit 1 ;;
esac
mkdir -p /opt/arduino/data /tmp/arduino-downloads /tmp/arduino-sketchbook
cd /tmp
curl -fsSL --retry 4 "https://downloads.arduino.cc/arduino-cli/$archive" -o "$archive"
# SHA-256 from the official arduino/arduino-cli v1.3.1 release asset.
printf '%s  %s\n' 376428d7d45be640c00812a71612e1742edc2f5f9ee3742a2d6da7870e079588 "$archive" | sha256sum -c -
tar -xzf "$archive" -C /opt arduino-cli
cat > /opt/arduino-cli.yaml <<'YAML'
board_manager:
  additional_urls:
    - https://espressif.github.io/arduino-esp32/package_esp32_index.json
directories:
  data: /opt/arduino/data
  downloads: /tmp/arduino-downloads
  user: /tmp/arduino-sketchbook
network:
  connection_timeout: 1800s
build_cache:
  path: /tmp/arduino-build-cache
updater:
  enable_notification: false
YAML
/opt/arduino-cli --config-file /opt/arduino-cli.yaml core update-index
for attempt in 1 2 3; do
  if /opt/arduino-cli --config-file /opt/arduino-cli.yaml core install esp32:esp32@3.3.2; then break; fi
  if [ "$attempt" = 3 ]; then exit 1; fi
done
/opt/arduino-cli --config-file /opt/arduino-cli.yaml core list
