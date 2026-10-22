#!/usr/bin/env python3
"""Zostaví vendor/ifctester.zip — knižnicu IfcTester pre kontrolu podľa IDS v prehliadači.

Spustenie:  python3 vendor/build-ifctester-bundle.py

IfcTester (súčasť IfcOpenShellu) vyhodnocuje požiadavky zapísané v IDS
(Information Delivery Specification, štandard buildingSMART). Wheel na PyPI má
~25 MB, lebo nesie aj vlastnú webovú aplikáciu s Pyodide — nástroj „validate"
z neho potrebuje len samotnú knižnicu, takže do zipu ide ~30 kB:

  ifctester/__init__.py, ids.py, facet.py, reporter.py  — kód knižnice
  ifctester/ids.xsd                                    — XML schéma IDS 1.0
  COPYING.LESSER, COPYING                              — licencia (LGPL-3.0+)

Verzia musí sedieť s wasm zostavou IfcOpenShellu v js/validate-pyodide.js
(WHEEL_URL) — knižnica volá ifcopenshell.util.* a jeho API sa medzi verziami mení.
Kód sa nemení.
"""

import io
import json
import os
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "ifctester.zip")

VERSION = "0.8.5"
PYPI = "https://pypi.org/pypi/ifctester/%s/json" % VERSION
# licenčné texty z tej istej verzie v repozitári IfcOpenShell
LICENSES = "https://raw.githubusercontent.com/IfcOpenShell/IfcOpenShell/ifcopenshell-python-%s/" % VERSION

KEEP = ("__init__.py", "ids.py", "facet.py", "reporter.py", "ids.xsd")


def fetch(url):
    print("sťahujem", url)
    try:
        with urllib.request.urlopen(url) as r:
            return r.read()
    except Exception as e:
        # macOS inštalácie Pythonu často nemajú koreňové certifikáty — skúsime curl
        print("  urllib zlyhal (%s), skúšam curl" % type(e).__name__)
        return subprocess.run(["curl", "-sSL", url], check=True, capture_output=True).stdout


def main():
    meta = json.loads(fetch(PYPI))
    wheel = next(u["url"] for u in meta["urls"] if u["filename"].endswith(".whl"))
    whl = zipfile.ZipFile(io.BytesIO(fetch(wheel)))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in KEEP:
            z.writestr("ifctester/" + name, whl.read("ifctester/" + name))
        for name in ("COPYING.LESSER", "COPYING"):
            z.writestr(name, fetch(LICENSES + name))

    print("hotovo: %s — %d kB, ifctester %s" % (
        os.path.relpath(OUT, os.path.dirname(HERE)), round(os.path.getsize(OUT) / 1024), VERSION))


if __name__ == "__main__":
    sys.exit(main())
