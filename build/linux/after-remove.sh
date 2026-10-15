#!/bin/bash
# Custom prerm/postrm. Setting `deb.afterRemove` makes electron-builder replace
# its default after-remove template wholesale, so the launcher link and the
# AppArmor profile installed by after-install.sh must be undone here.

# Delete the link to the binary. `update-alternatives --remove <name> <path>`
# wants the registered alternative binary, not the generic symlink.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload the AppArmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot. Live AppArmor operations
  # are not meaningful inside a chroot.
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
