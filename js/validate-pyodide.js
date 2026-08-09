/* validate-pyodide.js — hĺbková kontrola súboru podľa EXPRESS schémy.
 *
 * Vlákno si na požiadanie stiahne Python (Pyodide) a knižnicu IfcOpenShell
 * preloženú do WebAssembly a spustí ifcopenshell.validate — teda to isté jadro,
 * ktoré poháňa oficiálnu validačnú službu buildingSMART. Súbor sa nikam
 * neodosiela, do prehliadača sa sťahuje len samotná knižnica.
 *
 * Sťahuje sa až pri prvom spustení (~25 MB) a v pamäti zostáva do zatvorenia
 * karty, takže ďalšie súbory sa kontrolujú hneď.
 */
"use strict";

// Verzie musia ladiť: wheel je zostavený pre platformu pyodide_2025_0 / cp313,
// čo je práve Pyodide 0.28.x. Pri zmene jednej treba prekontrolovať druhú.
var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
var WHEEL_URL = "https://ifcopenshell.github.io/wasm-wheels/" +
                "ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl";
var MODEL_PATH = "/model.ifc";

var py = null;        // beží Pyodide
var booting = null;   // rozbehnuté sťahovanie (aby sa nespustilo dvakrát)

function post(msg) { self.postMessage(msg); }

/* Python časť — jediná funkcia, ktorá vráti nálezy ako JSON.
   json_logger zbiera hlásenia do poľa slovníkov {level, message, type, instance,
   attribute}; „instance“ býva entita, ale pri chybách z parsera je to len text. */
var PY_SETUP = [
  "import json",
  "import ifcopenshell",
  "import ifcopenshell.validate",
  "",
  "def _inst(inst):",
  "    out = {'id': None, 'cls': None, 'text': None}",
  "    if inst is None:",
  "        return out",
  "    try:",
  "        out['id'] = inst.id()",
  "    except Exception:",
  "        pass",
  "    try:",
  "        out['cls'] = inst.is_a()",
  "    except Exception:",
  "        pass",
  "    try:",
  "        out['text'] = str(inst)[:400]",
  "    except Exception:",
  "        out['text'] = None",
  "    return out",
  "",
  "def validate_file(path):",
  "    logger = ifcopenshell.validate.json_logger()",
  "    ifcopenshell.validate.validate(path, logger, express_rules=True)",
  "    out = []",
  "    for s in logger.statements:",
  "        info = _inst(s.get('instance'))",
  "        attr = s.get('attribute')",
  "        out.append({",
  "            'level': s.get('level') or 'error',",
  "            'kind': s.get('type') or 'schema',",
  "            'message': (s.get('message') or '').strip(),",
  "            'attribute': None if attr is None else str(attr),",
  "            'id': info['id'],",
  "            'cls': info['cls'],",
  "            'inst': info['text'],",
  "        })",
  "    return json.dumps({'statements': out})"
].join("\n");

function boot() {
  if (booting) return booting;
  booting = (function () {
    return Promise.resolve()
      .then(function () {
        post({ type: "progress", text: "sťahujem Python pre prehliadač (Pyodide)…" });
        importScripts(PYODIDE_URL + "pyodide.js");
        return loadPyodide({ indexURL: PYODIDE_URL });
      })
      .then(function (p) {
        py = p;
        post({ type: "progress", text: "pripravujem balíčky…" });
        // pytest je potrebný pre kontrolu pravidiel WHERE (rule_executor ho používa)
        return py.loadPackage(["micropip", "pytest"]);
      })
      .then(function () {
        post({ type: "progress", text: "sťahujem IfcOpenShell (~15 MB)…" });
        var micropip = py.pyimport("micropip");
        return micropip.install(WHEEL_URL);
      })
      .then(function () {
        py.runPython(PY_SETUP);
        post({ type: "progress", text: "knižnica je pripravená" });
      })
      .catch(function (err) {
        booting = null;   // ďalší pokus môže začať odznova
        throw err;
      });
  })();
  return booting;
}

self.onmessage = function (ev) {
  var d = ev.data || {};
  if (d.type !== "validate") return;

  boot()
    .then(function () {
      post({ type: "progress", text: "zapisujem súbor do pamäte…" });
      try { py.FS.unlink(MODEL_PATH); } catch (e) { /* prvý beh */ }
      py.FS.writeFile(MODEL_PATH, new Uint8Array(d.buf));
      d.buf = null;

      post({ type: "progress", text: "kontrolujem podľa schémy…", running: true });
      var t0 = Date.now();
      var json = py.runPython('validate_file("' + MODEL_PATH + '")');
      var res = JSON.parse(json);
      try { py.FS.unlink(MODEL_PATH); } catch (e) { /* nevadí */ }
      post({ type: "result", statements: res.statements, ms: Date.now() - t0 });
    })
    .catch(function (err) {
      var msg = (err && err.message) ? err.message : String(err);
      // Python výnimka je dlhá — pre používateľa stačí posledný riadok.
      var lines = msg.trim().split("\n");
      post({ type: "error", message: lines[lines.length - 1], detail: msg });
    });
};
