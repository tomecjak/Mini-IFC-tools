# vendor/

Cudzí kód, ktorý nástroj **validate** spúšťa v prehliadači.

## gherkin-rules.zip

Normatívne pravidlá buildingSMART zabalené tak, aby sa dali spustiť v Pyodide.
Súbor **negenerujte ručne** — zostavuje ho skript:

```
python3 vendor/build-gherkin-bundle.py
```

Obsah (~330 kB, 104 pravidiel):

| časť | zdroj | licencia |
|---|---|---|
| `features/**` — pravidlá `.feature` a kroky v Pythone | [buildingSMART/ifc-gherkin-rules](https://github.com/buildingSMART/ifc-gherkin-rules) | MIT |
| `ifc_validation_models/dataclass_compat.py` | [buildingSMART/ifc-validation-data-model](https://github.com/buildingSMART/ifc-validation-data-model) | MIT |
| `simple_spf/**` — modul `ifcopenshell.simple_spf` | [IfcOpenShell/step-file-parser](https://github.com/IfcOpenShell/step-file-parser) | LGPL-2.1 |

Licenčné texty sú v zipe priložené.

### Prečo je to zabalené a nie sťahované za behu

GitHub neposiela pri archívoch hlavičky CORS, takže prehliadač si ich sám stiahnuť
nemôže. Balíček je navyše verzionovaný spolu so stránkou — pravidlá sa nezmenia
pod rukami medzi dvoma spusteniami.

### Dve odchýlky od originálu

1. **`validation_results.py` je nahradený** verziou bez Djanga. Pôvodný modul pri
   importe spúšťa `django.setup()` a zapisuje výsledky do databázy validačnej
   služby; v prehliadači sa výsledky odovzdávajú rovno do rozhrania.
2. **`ifcopenshell.simple_spf`** je v IfcOpenShelli git submodul a wasm zostava ho
   neobsahuje, preto sa dopĺňa z tohto balíčka (`js/validate-pyodide.js` ho pri
   štarte skopíruje do nainštalovaného balíka `ifcopenshell`).

Samotné pravidlá ani kroky sa nemenia — výsledky preto zodpovedajú tomu, čo hlási
oficiálna služba.

### Čo v prehliadači nebeží

`pyproj` (georeferencovanie) a `rtree` (priestorový index) stoja na C knižniciach,
ktoré pre WebAssembly neexistujú. Sú nahradené atrapami, ktoré pri použití vyhodia
výnimku — pravidlo sa potom v rozhraní zobrazí ako **nevyhodnotené**, nie ako
prejdené. Týka sa to len pravidiel, ktoré tieto knižnice naozaj potrebujú
(georeferencovanie, prieniky telies).

### Aktualizácia

Skript ťahá vetvu `main` oboch repozitárov buildingSMART. Po aktualizácii sa oplatí
prejsť nástroj na testovacom modeli — ak pravidlá pribudnú do súborov, ktoré
importujú ďalšie knižnice, môže byť potrebné doplniť ich do zoznamu v
`js/validate-pyodide.js` (funkcia `bootRules`).
