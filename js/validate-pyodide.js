/* validate-pyodide.js — hĺbková kontrola súboru vo vlastnom vlákne.
 *
 * Vlákno si na požiadanie stiahne Python pre prehliadač (Pyodide) a knižnice
 * preložené do WebAssembly. Súbor sa nikam neodosiela — sťahujú sa len knižnice.
 *
 * Vie dve veci:
 *   validate — ifcopenshell.validate: typy atribútov, kardinality, výčty a
 *              pravidlá WHERE zo schémy EXPRESS (~25 MB);
 *   rules    — normatívne pravidlá buildingSMART (ifc-gherkin-rules) spustené
 *              cez behave nad tým istým modelom (~20 MB navyše).
 *
 * Obe používajú rovnaké jadro ako oficiálna validačná služba buildingSMART.
 * Stiahnuté knižnice zostávajú v pamäti karty, takže ďalší beh je hneď.
 */
"use strict";

// Verzie musia ladiť: wheel je zostavený pre platformu pyodide_2025_0 / cp313,
// čo je práve Pyodide 0.28.x. Pri zmene jednej treba prekontrolovať druhú.
var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
var WHEEL_URL = "https://ifcopenshell.github.io/wasm-wheels/" +
                "ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl";
// balíček pravidiel zostavený skriptom vendor/build-gherkin-bundle.py
var RULES_ZIP = new URL("../vendor/gherkin-rules.zip", self.location.href).href;

var MODEL_PATH = "/model.ifc";
var RULES_DIR = "/gherkin";
var RULES_OUT = "/rules-out.json";
// koľko nálezov najviac na jedno pravidlo (0 = bez obmedzenia); drží veľkosť
// výstupu aj čas behu na uzde pri modeloch, kde pravidlo padá na všetkom
var MAX_OUTCOMES_PER_RULE = 25;

var py = null;
var bootingBase = null;
var bootingRules = null;

function post(msg) { self.postMessage(msg); }

/* ---- Python: kontrola podľa schémy ------------------------------------- */
var PY_SCHEMA = [
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

/* ---- Python: normatívne pravidlá ---------------------------------------- */
var PY_RULES = [
  "import base64, collections, contextlib, io, json, os, shutil, sys, time, types, zipfile",
  "import js",
  "from pyodide.ffi import to_js",
  "",
  "RULES_DIR = " + JSON.stringify(RULES_DIR),
  "RULES_OUT = " + JSON.stringify(RULES_OUT),
  "MAX_OUTCOMES = " + MAX_OUTCOMES_PER_RULE,
  "",
  "def _post(**kw):",
  "    js.postMessage(to_js(kw, dict_converter=js.Object.fromEntries))",
  "",
  "class _MissingMeta(type):",
  "    \"\"\"Náhrada za knižnicu, ktorá sa v prehliadači nedá spustiť.",
  "",
  "    Je to trieda, nie inštancia, aby fungovali aj anotácie typu 'CRS | None'.",
  "    Výnimka padne až pri použití — pravidlo sa potom označí ako nevyhodnotené",
  "    namiesto toho, aby tichým zlyhaním prešlo ako v poriadku.",
  "    \"\"\"",
  "    def __getattr__(cls, k):",
  "        raise RuntimeError(cls.__name__ + '.' + k + ' nie je v prehliadači k dispozícii')",
  "    def __call__(cls, *a, **k):",
  "        raise RuntimeError(cls.__name__ + ' nie je v prehliadači k dispozícii')",
  "",
  "def _stub(name, attrs):",
  "    m = types.ModuleType(name)",
  "    for a in attrs:",
  "        setattr(m, a, _MissingMeta(a, (), {}))",
  "    sys.modules[name] = m",
  "    return m",
  "",
  "def prepare_rules(zip_path):",
  "    if os.path.isdir(RULES_DIR):",
  "        return _rule_count()",
  "    zipfile.ZipFile(zip_path).extractall(RULES_DIR)",
  "    sys.path.insert(0, RULES_DIR)",
  "    sys.path.insert(0, RULES_DIR + '/features/steps')",
  "    # pyproj a rtree stoja na C knižniciach (PROJ, libspatialindex), ktoré pre",
  "    # WebAssembly neexistujú; spellchecker používa len kontrola písania pravidiel",
  "    _stub('pyproj', ['CRS', 'Transformer', 'database'])",
  "    _stub('pyproj.database', ['query_crs_info'])",
  "    sys.modules['pyproj'].database = sys.modules['pyproj.database']",
  "    _stub('rtree', ['index'])",
  "    _stub('rtree.index', ['Index', 'Property'])",
  "    sys.modules['rtree'].index = sys.modules['rtree.index']",
  "    _stub('spellchecker', ['SpellChecker'])",
  "    # ifcopenshell.simple_spf je v IfcOpenShelli git submodul a wasm zostava ho",
  "    # neobsahuje — doplníme ho z balíčka pravidiel",
  "    import ifcopenshell",
  "    dst = os.path.join(os.path.dirname(ifcopenshell.__file__), 'simple_spf')",
  "    if not os.path.exists(dst):",
  "        shutil.copytree(RULES_DIR + '/simple_spf', dst)",
  "    return _rule_count()",
  "",
  "def _rule_count():",
  "    n = 0",
  "    for _root, _dirs, files in os.walk(RULES_DIR + '/features/rules'):",
  "        n += sum(f.endswith('.feature') for f in files)",
  "    return n",
  "",
  "def _text(v):",
  "    if v is None:",
  "        return ''",
  "    if isinstance(v, str):",
  "        return v",
  "    if isinstance(v, dict) and set(v) == {'value'}:",
  "        return str(v['value'])",
  "    return json.dumps(v, ensure_ascii=False)",
  "",
  "def _summarize(total_rules, elapsed):",
  "    outcomes, status, errored = [], collections.Counter(), []",
  "    counts = collections.Counter()",
  "    if os.path.exists(RULES_OUT):",
  "        with open(RULES_OUT) as f:",
  "            data = json.load(f)",
  "    else:",
  "        data = []",
  "    for feat in data:",
  "        st = feat.get('status')",
  "        status[st] += 1",
  "        if st == 'error':",
  "            errored.append(feat.get('name'))",
  "        for el in feat.get('elements', []):",
  "            for enc in el.get('validation_outcomes', []):",
  "                for v in json.loads(base64.b64decode(enc['data']).decode('utf-8')):",
  "                    sev = v.get('severity')",
  "                    counts[sev] += 1",
  "                    if sev in ('WARNING', 'ERROR'):",
  "                        code = str(v.get('outcome_code') or '')",
  "                        outcomes.append({",
  "                            'severity': sev,",
  "                            'feature': v.get('feature') or feat.get('name'),",
  "                            'code': code.rsplit('.', 1)[-1],",
  "                            'inst': v.get('inst'),",
  "                            'expected': _text(v.get('expected'))[:400],",
  "                            'observed': _text(v.get('observed'))[:400],",
  "                        })",
  "    return json.dumps({",
  "        'outcomes': outcomes,",
  "        'counts': dict(counts),",
  "        'status': dict(status),",
  "        'errored': errored,",
  "        'rules': total_rules,",
  "        'elapsed': elapsed,",
  "    })",
  "",
  "def run_rules(path, total_rules):",
  "    os.chdir(RULES_DIR)",
  "    from behave.configuration import Configuration",
  "    from behave.runner import Runner",
  "    if os.path.exists(RULES_OUT):",
  "        os.unlink(RULES_OUT)",
  "    args = ['--tags=-disabled', '--no-summary',",
  "            '--define', 'input=' + path,",
  "            '--define', 'max_outcomes_per_rule=' + str(MAX_OUTCOMES),",
  "            '-f', 'outcome_embedding_json', '-o', RULES_OUT]",
  "    config = Configuration(command_args=args)",
  "    runner = Runner(config)",
  "",
  "    # behave nemá spätné volanie na priebeh — obalíme volanie hookov, ktoré",
  "    # spúšťa pred každým pravidlom, a odtiaľ hlásime, kde sa beh nachádza",
  "    done = [0]",
  "    orig_run_hook = runner.run_hook",
  "    def run_hook(name, context, *a):",
  "        if name == 'before_feature':",
  "            done[0] += 1",
  "            nm = getattr(a[0], 'name', '') if a else ''",
  "            _post(type='progress', text='pravidlo ' + nm.split(' - ')[0],",
  "                  done=done[0], total=total_rules)",
  "        return orig_run_hook(name, context, *a)",
  "    runner.run_hook = run_hook",
  "",
  "    buf = io.StringIO()",
  "    t0 = time.time()",
  "    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):",
  "        runner.run()",
  "    return _summarize(total_rules, time.time() - t0)"
].join("\n");

/* ---- príprava prostredia ------------------------------------------------ */
function bootBase() {
  if (bootingBase) return bootingBase;
  bootingBase = Promise.resolve()
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
      return py.pyimport("micropip").install(WHEEL_URL);
    })
    .then(function () {
      py.runPython(PY_SCHEMA);
      post({ type: "progress", text: "knižnica je pripravená" });
    })
    .catch(function (err) { bootingBase = null; throw err; });
  return bootingBase;
}

function bootRules() {
  if (bootingRules) return bootingRules;
  bootingRules = bootBase()
    .then(function () {
      post({ type: "progress", text: "sťahujem knižnice pre pravidlá…" });
      return py.loadPackage(["numpy", "shapely", "networkx", "pydantic", "pyparsing", "mpmath"]);
    })
    .then(function () {
      // behave zámerne v tej istej verzii, akú používa validačná služba
      return py.pyimport("micropip").install(["behave==1.2.6", "pydot", "lark"]);
    })
    .then(function () {
      post({ type: "progress", text: "rozbaľujem pravidlá buildingSMART…" });
      return fetch(RULES_ZIP);
    })
    .then(function (r) {
      if (!r.ok) throw new Error("balíček pravidiel sa nepodarilo stiahnuť (" + r.status + ")");
      return r.arrayBuffer();
    })
    .then(function (buf) {
      py.FS.writeFile("/gherkin-rules.zip", new Uint8Array(buf));
      py.runPython(PY_RULES);
      var n = py.runPython('prepare_rules("/gherkin-rules.zip")');
      post({ type: "progress", text: "pravidlá pripravené (" + n + ")" });
      return n;
    })
    .catch(function (err) { bootingRules = null; throw err; });
  return bootingRules;
}

function writeModel(buf) {
  post({ type: "progress", text: "zapisujem súbor do pamäte…" });
  try { py.FS.unlink(MODEL_PATH); } catch (e) { /* prvý beh */ }
  py.FS.writeFile(MODEL_PATH, new Uint8Array(buf));
}

self.onmessage = function (ev) {
  var d = ev.data || {};
  var job;

  if (d.type === "validate") {
    job = bootBase().then(function () {
      writeModel(d.buf);
      d.buf = null;
      post({ type: "progress", text: "kontrolujem podľa schémy…", running: true });
      var t0 = Date.now();
      var res = JSON.parse(py.runPython('validate_file("' + MODEL_PATH + '")'));
      try { py.FS.unlink(MODEL_PATH); } catch (e) { /* nevadí */ }
      post({ type: "result", statements: res.statements, ms: Date.now() - t0 });
    });
  } else if (d.type === "rules") {
    job = bootRules().then(function (n) {
      writeModel(d.buf);
      d.buf = null;
      post({ type: "progress", text: "spúšťam pravidlá…", running: true, done: 0, total: n });
      var res = JSON.parse(py.runPython('run_rules("' + MODEL_PATH + '", ' + n + ")"));
      try { py.FS.unlink(MODEL_PATH); } catch (e) { /* nevadí */ }
      post({ type: "rulesResult", data: res, ms: Math.round(res.elapsed * 1000) });
    });
  } else {
    return;
  }

  job.catch(function (err) {
    var msg = (err && err.message) ? err.message : String(err);
    // Python výnimka je dlhá — pre používateľa stačí posledný riadok
    var lines = msg.trim().split("\n");
    post({ type: "error", message: lines[lines.length - 1], detail: msg });
  });
};
