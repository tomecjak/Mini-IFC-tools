#!/usr/bin/env python3
"""Zostaví vendor/gherkin-rules.zip — normatívne pravidlá buildingSMART pre beh v prehliadači.

Spustenie:  python3 vendor/build-gherkin-bundle.py

Skript stiahne tri zdroje a zabalí z nich to, čo nástroj „validate" potrebuje:

  1. buildingSMART/ifc-gherkin-rules      — samotné pravidlá (.feature) a kroky (Python)
  2. buildingSMART/ifc-validation-data-model — dataclassy pre výsledky (submodul pravidiel)
  3. IfcOpenShell/step-file-parser        — modul ifcopenshell.simple_spf, ktorý
                                            wasm zostava IfcOpenShellu neobsahuje

Oproti originálu sa mení jediná vec: validation_results.py je nahradený verziou
bez Djanga (pozri SHIM nižšie). Pôvodný modul zapisuje výsledky do databázy
validačnej služby, čo v prehliadači nedáva zmysel ani sa nedá spustiť.

Vynecháva sa dokumentácia, testovacie modely a obrázky — do zipu ide ~330 kB.
"""

import io
import os
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "gherkin-rules.zip")

RULES = "https://codeload.github.com/buildingSMART/ifc-gherkin-rules/tar.gz/refs/heads/main"
MODELS = "https://codeload.github.com/buildingSMART/ifc-validation-data-model/tar.gz/refs/heads/main"
# commit, na ktorý ukazuje submodul ifcopenshell/simple_spf v IfcOpenShell v0.8.0
SFP_SHA = "9400d243d880dace57490949d74ab1932ce99a09"
SFP = "https://codeload.github.com/IfcOpenShell/step-file-parser/tar.gz/" + SFP_SHA

SHIM = '''"""Náhrada za validation_results.py bez Djanga.

Pôvodný modul si pri importe ťahá Django a SQLite kvôli zápisu výsledkov do
databázy validačnej služby. V prehliadači sa výsledky nikam neukladajú —
odovzdávajú sa rovno do rozhrania — takže stačia čisté dataclassy.
"""
from ifc_validation_models.dataclass_compat import (
    ValidationOutcome, OutcomeSeverity, ValidationOutcomeCode,
)

ValidationOutcomeDjango = None
ModelInstance = None
ValidationTask = None
'''

SKIP_EXT = (".pyc", ".png", ".svg", ".jpg", ".gif")


def fetch(url):
    print("sťahujem", url)
    try:
        with urllib.request.urlopen(url) as r:
            data = r.read()
    except Exception as e:
        # macOS inštalácie Pythonu často nemajú koreňové certifikáty — skúsime curl
        print("  urllib zlyhal (%s), skúšam curl" % type(e).__name__)
        data = subprocess.run(["curl", "-sSL", url], check=True, capture_output=True).stdout
    return tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")


def members(tar, prefix):
    """Súbory z archívu pod daným priečinkom → (cesta v archíve bez koreňa, obsah)."""
    root = tar.getnames()[0].split("/")[0]
    base = root + "/" + prefix if prefix else root
    for m in tar.getmembers():
        if not m.isfile() or not m.name.startswith(base + "/"):
            continue
        if any(m.name.endswith(e) for e in SKIP_EXT) or "__pycache__" in m.name:
            continue
        yield m.name[len(base) + 1:], tar.extractfile(m).read()


def main():
    rules, models, sfp = fetch(RULES), fetch(MODELS), fetch(SFP)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        root = rules.getnames()[0].split("/")[0]
        for name in ("behave.ini", "main.py", "outcome_embedding_json_formatter.py", "__init__.py"):
            z.writestr(name, rules.extractfile(root + "/" + name).read())
        z.writestr("validation_results.py", SHIM)

        for path, data in members(rules, "features"):
            z.writestr("features/" + path, data)

        z.writestr("ifc_validation_models/__init__.py", "")
        z.writestr("ifc_validation_models/dataclass_compat.py",
                   models.extractfile(models.getnames()[0].split("/")[0] + "/dataclass_compat.py").read())

        sfp_root = sfp.getnames()[0].split("/")[0]
        z.writestr("simple_spf/__init__.py", sfp.extractfile(sfp_root + "/__init__.py").read())
        for path, data in members(sfp, "parser"):
            z.writestr("simple_spf/parser/" + path, data)

        # licencie putujú do balíčka spolu s kódom (MIT, MIT, LGPL-2.1)
        z.writestr("LICENSE-ifc-gherkin-rules", rules.extractfile(root + "/LICENSE").read())
        z.writestr("LICENSE-ifc-validation-data-model",
                   models.extractfile(models.getnames()[0].split("/")[0] + "/LICENSE").read())
        z.writestr("simple_spf/LICENSE", sfp.extractfile(sfp_root + "/LICENSE").read())

    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
    print("hotovo: %s — %d kB, %d súborov, %d pravidiel (.feature)" % (
        os.path.relpath(OUT, os.path.dirname(HERE)), round(os.path.getsize(OUT) / 1024),
        len(names), sum(n.endswith(".feature") for n in names)))


if __name__ == "__main__":
    sys.exit(main())
