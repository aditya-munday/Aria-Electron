#!/bin/bash
# Custom postinst. Setting `deb.afterInstall` makes electron-builder replace its
# default after-install template wholesale, so every step the template performs
# must be reproduced here. An earlier revision only stopped stale instances and
# set the sandbox mode; that left the app installed but with no `aria-desktop`
# on PATH, because the default template is what creates the /usr/bin launcher.

# 1. End any running instance. An in-place upgrade installs a new binary over
#    the old one, but a running Aria keeps the single-instance lock and stays
#    resident (0.6.1 held it open with a system tray). Launching the new binary
#    then just hands focus to the old process, so the user keeps seeing the old
#    UI and the old behaviour until they log out.
if command -v pkill >/dev/null 2>&1; then
  # Match both the process name and the installed binary path: Electron may
  # rename the main process, but its command line still starts with the path.
  pkill -x aria-desktop 2>/dev/null || true
  pkill -f '/opt/${sanitizedProductName}/${executable}' 2>/dev/null || true
  # The voice sidecar is a separate process the app spawns; an upgrade must not
  # leave the old one holding the microphone. Match its installed path only.
  pkill -f '/opt/${sanitizedProductName}/resources/sidecar/aria-voice/' 2>/dev/null || true
fi

# 1b. The sidecar ships as an extra resource; keep it executable and owned by
#     root so it cannot be replaced by an unprivileged user.
SIDECAR_BIN='/opt/${sanitizedProductName}/resources/sidecar/aria-voice/aria-voice'
if [ -f "$SIDECAR_BIN" ]; then
  chmod 0755 "$SIDECAR_BIN" || true
  chown root:root "$SIDECAR_BIN" 2>/dev/null || true
fi

# 2. Put the launcher on PATH. From electron-builder's default template.
if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# 3. Set the SUID bit on chrome-sandbox where the kernel will not hand the
#    sandbox an unprivileged user namespace. Also from the default template: a
#    custom afterInstall replaces it, so omitting this leaves the helper mode
#    0755 and Chromium aborts with "The SUID sandbox helper binary was found,
#    but is not configured correctly" on hosts whose userns probe fails.
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

# 4. Refresh the desktop caches for the shipped .desktop file and icons.
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# 5. Install the AppArmor profile (Ubuntu 24+, Kali and other AppArmor hosts).
#    From the default template. On a host that restricts unprivileged user
#    namespaces this profile is what lets Chromium's sandbox engage; without it
#    the app can abort at launch, so wake word could never run.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not
    # meaningful in a chroot'ed environment; live AppArmor operations make little
    # sense there.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
