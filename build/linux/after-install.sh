#!/bin/bash
# An upgrade installs a new binary over the old one, but a running Aria from the
# previous version keeps the single-instance lock and stays resident (0.6.1 held
# it open with a system tray). Launching the new binary then just hands focus to
# the old process, so the user keeps seeing the old UI and the old behaviour
# until they log out. End any running instance so the next launch starts the
# freshly installed version.
if command -v pkill >/dev/null 2>&1; then
  # Match both the process name and the installed binary path: Electron may
  # rename the main process, but its command line still starts with the path.
  pkill -x aria-desktop 2>/dev/null || true
  pkill -f '/opt/Aria/aria-desktop' 2>/dev/null || true
fi

# Set the SUID bit on chrome-sandbox where the kernel will not hand the sandbox
# an unprivileged user namespace. This replicates electron-builder's default
# after-install template: a custom `afterInstall` replaces that template
# wholesale, so omitting this leaves the helper mode 0755 and Chromium aborts
# with "The SUID sandbox helper binary was found, but is not configured
# correctly" on hosts whose userns probe fails (Debian 13, Ubuntu 24+ with the
# AppArmor userns restriction). A misconfigured helper is a launch failure, so
# wake word could never run there.
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
  chmod 4755 '/opt/Aria/chrome-sandbox' || true
else
  chmod 0755 '/opt/Aria/chrome-sandbox' || true
fi
