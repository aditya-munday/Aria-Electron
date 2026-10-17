"""Frozen-build entrypoint.

PyInstaller executes its target as ``__main__`` at the top level, so a script
that uses package-relative imports (``aria_voice/__main__.py``) fails with
"attempted relative import with no known parent package". Importing the package
module and calling its ``main`` keeps the frozen build identical to
``python -m aria_voice``.
"""

from aria_voice.__main__ import main

if __name__ == "__main__":
    main()
