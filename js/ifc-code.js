/* ifc-code.js — jadro prehliadača zdrojového kódu IFC (STEP / ISO-10303-21).
 *
 * Nič nevykresľuje. Poskytuje:
 *   1. indexFile()   — po častiach prejde text súboru, rozdelí ho na riadky a
 *                      príkazy (#ID = TRIEDA(...);) a zostaví registre pre rýchle
 *                      vyhľadávanie a filtrovanie.
 *   2. tokenizeLine()— jeden riadok premení na farebne označené HTML.
 *   3. attrNames()   — názvy atribútov entity podľa IFC schémy (tabuľka bežných
 *                      tried + odhad podľa štruktúry pre ostatné).
 *   4. drobné pomôcky na prácu s hodnotami (delenie argumentov, dekódovanie textu).
 *
 * Zámerne nezávisí od js/ifc-merge.js — sú to dva samostatné nástroje.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Kategórie tried (určujú farbu a slovný popis)
  // ---------------------------------------------------------------------------
  var SPATIAL = new Set([
    "IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE",
    "IFCSPATIALZONE", "IFCEXTERNALSPATIALELEMENT", "IFCSPATIALELEMENT"
  ]);
  var META = new Set([
    "IFCOWNERHISTORY", "IFCPERSON", "IFCORGANIZATION", "IFCPERSONANDORGANIZATION",
    "IFCAPPLICATION", "IFCSIUNIT", "IFCUNITASSIGNMENT", "IFCDERIVEDUNIT",
    "IFCDERIVEDUNITELEMENT", "IFCCONVERSIONBASEDUNIT", "IFCCONVERSIONBASEDUNITWITHOFFSET",
    "IFCMEASUREWITHUNIT", "IFCDIMENSIONALEXPONENTS", "IFCMONETARYUNIT",
    "IFCPOSTALADDRESS", "IFCTELECOMADDRESS", "IFCACTORROLE", "IFCADDRESS"
  ]);
  // Obaľovacie dátové typy hodnôt — IFCLABEL('x'), IFCLENGTHMEASURE(2.5), IFCBOOLEAN(.T.)…
  var VALUE_RE = /^IFC([A-Z]*MEASURE|LABEL|TEXT|IDENTIFIER|INTEGER|REAL|NUMBER|BOOLEAN|LOGICAL|DATE|DATETIME|TIME|DURATION|TIMESTAMP|BINARY|URIREFERENCE|POSITIVEINTEGER)$/;
  var PROP_RE  = /^IFC(PROPERTY|COMPLEXPROPERTY|SIMPLEPROPERTY|ELEMENTQUANTITY|QUANTITY|PHYSICALQUANTITY|PRESET)/;
  var STYLE_RE = /^IFC(MATERIAL|SURFACESTYLE|STYLED|PRESENTATIONSTYLE|PRESENTATIONLAYER|CURVESTYLE|FILLAREASTYLE|TEXTSTYLE|COLOUR|BLOBTEXTURE|IMAGETEXTURE|PIXELTEXTURE|TEXTURE|EXTERNALLYDEFINEDSURFACESTYLE|INDEXEDCOLOUR)/;
  var GEOM_RE  = /^IFC(CARTESIANPOINT|CARTESIANTRANSFORMATION|DIRECTION|VECTOR|AXIS[12]PLACEMENT|LOCALPLACEMENT|GRIDPLACEMENT|PLACEMENT|POLYLINE|POLYLOOP|VERTEXLOOP|EDGELOOP|LOOP|FACE|CLOSEDSHELL|OPENSHELL|CONNECTEDFACESET|SHELLBASEDSURFACEMODEL|FACEBASEDSURFACEMODEL|FACETEDBREP|ADVANCEDBREP|MANIFOLDSOLIDBREP|EXTRUDEDAREASOLID|REVOLVEDAREASOLID|SURFACECURVESWEPTAREASOLID|SWEPT|BOOLEAN|HALFSPACE|POLYGONALBOUNDEDHALFSPACE|PLANE|CYLINDRICALSURFACE|CONICALSURFACE|SPHERICALSURFACE|SURFACEOFLINEAREXTRUSION|SURFACEOFREVOLUTION|CURVEBOUNDEDPLANE|RECTANGULARTRIMMEDSURFACE|CIRCLE|ELLIPSE|LINE|TRIMMEDCURVE|COMPOSITECURVE|BSPLINE|RATIONALB|INDEXEDPOLY|TRIANGULATEDFACESET|POLYGONALFACESET|CARTESIANPOINTLIST|SHAPEREPRESENTATION|SHAPEASPECT|TOPOLOGYREPRESENTATION|STYLEDREPRESENTATION|PRODUCTDEFINITIONSHAPE|REPRESENTATIONMAP|MAPPEDITEM|GEOMETRICREPRESENTATION|GEOMETRICSET|GEOMETRICCURVESET|BOUNDINGBOX|BLOCK|RECTANGULARPYRAMID|RIGHTCIRCULAR|SPHERE|CSGSOLID|CSGPRIMITIVE|SUBEDGE|EDGE|ORIENTEDEDGE|VERTEX|PATH|.*PROFILEDEF$|ARBITRARYCLOSED|ARBITRARYOPEN|DERIVEDPROFILEDEF|COMPOSITEPROFILEDEF)/;

  var CAT_LABEL = {
    spatial: "priestorová štruktúra",
    element: "prvok / objekt",
    type:    "typový objekt",
    rel:     "väzba (relácia)",
    prop:    "vlastnosti a veličiny",
    geom:    "geometria a reprezentácia",
    style:   "materiál a vzhľad",
    meta:    "hlavička a metaúdaje",
    value:   "hodnota s dátovým typom",
    other:   "ostatné"
  };

  // Ak je k dispozícii ukážka tela entity, rozpozná sa aj to, či ide o „zakorenenú“
  // entitu (IfcRoot má ako prvý argument 22-znakový GlobalId).
  function categoryOf(type, sampleBody) {
    if (!type) return "other";
    var t = type.toUpperCase();
    if (/^(FILE_|ISO|END-ISO|HEADER|DATA|ENDSEC)/.test(t)) return "meta";
    if (SPATIAL.has(t)) return "spatial";
    if (VALUE_RE.test(t)) return "value";
    if (/^IFCREL/.test(t)) return "rel";
    if (PROP_RE.test(t)) return "prop";
    if (STYLE_RE.test(t)) return "style";
    if (META.has(t)) return "meta";
    if (GEOM_RE.test(t)) return "geom";
    if (/TYPE$|STYLE$/.test(t) && looksRooted(sampleBody)) return "type";
    if (looksRooted(sampleBody)) return "element";
    if (/^IFC(WALL|SLAB|BEAM|COLUMN|DOOR|WINDOW|ROOF|STAIR|RAMP|RAILING|COVERING|CURTAINWALL|PLATE|MEMBER|FOOTING|PILE|FURNISHING|FLOWTERMINAL|FLOWSEGMENT|FLOWFITTING|DISTRIBUTION|BUILDINGELEMENT|OPENINGELEMENT|ELEMENTASSEMBLY|PROXY|ANNOTATION|GRID|TRANSPORTELEMENT|SANITARY|LIGHTFIXTURE|REINFORC)/.test(t)) return "element";
    return "other";
  }
  function looksRooted(body) {
    if (!body) return false;
    var a = splitArgs(body);
    if (!a.length) return false;
    var g = a[0].trim();
    return g.length === 24 && g[0] === "'" && /^'[0-9A-Za-z_$]{22}'$/.test(g);
  }
  function categoryLabel(cat) { return CAT_LABEL[cat] || CAT_LABEL.other; }

  // ---------------------------------------------------------------------------
  // Práca s argumentmi (rovnaká logika ako v STEP: reťazce sa musia maskovať)
  // ---------------------------------------------------------------------------

  // Nahradí obsah reťazcových literálov medzerami, aby sa dalo bezpečne deliť
  // podľa čiariek a zátvoriek. Dĺžka reťazca zostáva rovnaká.
  function maskStrings(s) {
    var res = "", inStr = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inStr) {
        if (c === "'") {
          if (s[i + 1] === "'") { res += "  "; i++; }
          else { res += "'"; inStr = false; }
        } else res += " ";
        continue;
      }
      if (c === "'") { inStr = true; res += "'"; continue; }
      res += c;
    }
    return res;
  }

  // Argumenty najvrchnejšej zátvorkovej skupiny tela TRIEDA(a,b,(c,d),#e).
  function splitArgs(body) {
    if (!body) return [];
    var masked = maskStrings(body);
    var open = masked.indexOf("(");
    if (open < 0) return [];
    var depth = 0, end = -1;
    for (var i = open; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) end = masked.length;
    return splitTopLevel(body.slice(open + 1, end), masked.slice(open + 1, end));
  }

  function splitTopLevel(str, masked) {
    masked = masked || maskStrings(str);
    var parts = [], start = 0, d = 0;
    for (var i = 0; i < masked.length; i++) {
      var ch = masked[i];
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if (ch === "," && d === 0) { parts.push(str.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(str.slice(start).trim());
    if (parts.length === 1 && parts[0] === "") return [];
    return parts;
  }

  // Odkazy #123 v texte (mimo reťazcov).
  function refsIn(str) {
    var masked = maskStrings(str), out = [], re = /#(\d+)/g, m;
    while ((m = re.exec(masked))) out.push(+m[1]);
    return out;
  }

  // Dekóduje kódovanie textov podľa ISO 10303-21 (\X2\00E1\X0\, \X\E1, \S\c)
  // a zdvojené apostrofy, aby sa v paneli detailu zobrazila čitateľná diakritika.
  function decodeIfcText(raw) {
    if (raw == null) return "";
    var s = String(raw).trim();
    if (s[0] === "'" && s[s.length - 1] === "'") s = s.slice(1, -1);
    s = s.replace(/''/g, "'");
    s = s.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, function (_, hex) {
      var out = "";
      for (var i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
      return out;
    });
    s = s.replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, function (_, hex) {
      var out = "";
      for (var i = 0; i + 7 < hex.length + 1; i += 8) out += String.fromCodePoint(parseInt(hex.substr(i, 8), 16));
      return out;
    });
    s = s.replace(/\\X\\([0-9A-Fa-f]{2})/g, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    s = s.replace(/\\S\\(.)/g, function (_, ch) { return String.fromCharCode(ch.charCodeAt(0) + 128); });
    s = s.replace(/\\\\/g, "\\");
    return s;
  }

  // ---------------------------------------------------------------------------
  // Úprava hodnôt (pre editovateľné atribúty v prehliadači)
  // ---------------------------------------------------------------------------

  // Hranice jednotlivých argumentov najvrchnejšej zátvorkovej skupiny.
  // Vracia pole [začiatok, koniec) v pôvodnom reťazci.
  function argSpans(text) {
    var masked = maskStrings(text);
    var open = masked.indexOf("(");
    if (open < 0) return [];
    var depth = 0, end = -1;
    for (var i = open; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return [];
    var spans = [], start = open + 1, d = 0;
    for (var j = open + 1; j < end; j++) {
      var ch = masked[j];
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if (ch === "," && d === 0) { spans.push([start, j]); start = j + 1; }
    }
    spans.push([start, end]);
    if (spans.length === 1 && !text.slice(spans[0][0], spans[0][1]).trim()) return [];
    return spans;
  }

  // Nahradí i-ty argument novým zápisom; zvyšok príkazu ostáva nedotknutý.
  function replaceArg(text, i, raw) {
    var spans = argSpans(text);
    if (!spans[i]) throw new Error("Argument " + (i + 1) + " neexistuje.");
    return text.slice(0, spans[i][0]) + raw + text.slice(spans[i][1]);
  }

  // Zakóduje text do zápisu ISO 10303-21: apostrof sa zdvojí, spätná lomka
  // zdvojí a znaky mimo ASCII sa zapíšu ako \X2\…\X0\ (po 4 hex číslice).
  function encodeIfcText(s) {
    var out = "", buf = "";
    function flush() {
      if (!buf) return;
      out += "\\X2\\" + buf + "\\X0\\";
      buf = "";
    }
    for (var i = 0; i < s.length; i++) {
      var c = s[i], code = s.charCodeAt(i);
      if (code > 126 || code < 32) {
        buf += ("000" + code.toString(16).toUpperCase()).slice(-4);
        continue;
      }
      flush();
      if (c === "'") out += "''";
      else if (c === "\\") out += "\\\\";
      else out += c;
    }
    flush();
    return "'" + out + "'";
  }

  /* Rozpozná druh hodnoty argumentu.
     kind: text | number | enum | ref | derived | unset | list | other
     Hodnoty zabalené v dátovom type (IFCLABEL('x'), IFCBOOLEAN(.T.)) sa rozoberú
     a v poli wrap zostane názov obalu, aby sa dal pri zápise vrátiť späť. */
  function classifyValue(raw) {
    var t = String(raw == null ? "" : raw).trim();
    if (t === "") return { kind: "other" };
    if (t === "$") return { kind: "unset" };
    if (t === "*") return { kind: "derived" };
    if (/^#\d+$/.test(t)) return { kind: "ref" };
    if (t[0] === "'") return { kind: "text", value: decodeIfcText(t), wrap: "" };
    if (/^\.[A-Za-z_][A-Za-z0-9_]*\.$/.test(t)) return { kind: "enum", value: t.slice(1, -1), wrap: "" };
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t))
      return { kind: "number", value: t, real: /[.eE]/.test(t), wrap: "" };
    if (t[0] === "(") return { kind: "list" };
    var m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(t);
    if (m) {
      var inner = classifyValue(m[2]);
      if (inner.kind === "text" || inner.kind === "number" || inner.kind === "enum") {
        inner.wrap = m[1];
        return inner;
      }
    }
    return { kind: "other" };
  }

  // Rozoberie zápis zoznamu (a,b,c) na položky; null, ak nejde o zoznam.
  function listItems(raw) {
    var t = String(raw == null ? "" : raw).trim();
    if (t[0] !== "(" || t[t.length - 1] !== ")") return null;
    var inner = t.slice(1, -1);
    if (!inner.trim()) return [];
    return splitTopLevel(inner);
  }

  // Zostaví zápis zoznamu z jednotlivých hodnôt. Vracia {raw} alebo {error}.
  function serializeList(itemInfo, values) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var r = serializeValue(itemInfo, values[i]);
      if (r.error) return { error: (values.length > 1 ? "Riadok " + (i + 1) + ": " : "") + r.error };
      out.push(r.raw);
    }
    return { raw: "(" + out.join(",") + ")" };
  }

  /* Zostaví STEP zápis novej hodnoty. Vracia {raw} alebo {error}.
     info = výsledok classifyValue pôvodnej hodnoty (kvôli obalu a tvaru čísla). */
  function serializeValue(info, input) {
    var wrap = info.wrap || "", raw;
    if (info.kind === "text") {
      raw = encodeIfcText(String(input));
    } else if (info.kind === "number") {
      var v = String(input).trim().replace(",", ".");
      if (info.int) {
        if (!/^[-+]?\d+$/.test(v)) return { error: "Zadajte celé číslo (napr. 3)." };
      } else {
        if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return { error: "Zadajte číslo (napr. 2750 alebo 2.75E3)." };
        // reálne čísla musia mať v IFC desatinnú bodku
        if (info.real && !/[.eE]/.test(v)) v += ".";
      }
      raw = v;
    } else if (info.kind === "enum") {
      var e = String(input).trim().toUpperCase().replace(/^\.|\.$/g, "");
      if (!/^[A-Z_][A-Z0-9_]*$/.test(e)) return { error: "Výčtová hodnota môže obsahovať len písmená bez diakritiky, číslice a _." };
      raw = "." + e + ".";
    } else {
      return { error: "Túto hodnotu nie je možné upraviť." };
    }
    return { raw: wrap ? wrap + "(" + raw + ")" : raw };
  }

  // ---------------------------------------------------------------------------
  // Názvy atribútov podľa IFC schémy
  //
  // Presné názvy pre všetky triedy dodáva js/ifc-schema-attrs.js (vygenerované
  // priamo zo schém IFC2x3 / IFC4 / IFC4.3). Tabuľka nižšie je len záložná —
  // použije sa, ak by sa register nenačítal.
  // ---------------------------------------------------------------------------
  var ROOT = "GlobalId|OwnerHistory|Name|Description";
  var PRODUCT = ROOT + "|ObjectType|ObjectPlacement|Representation";
  var ELEMENT = PRODUCT + "|Tag";
  var ELEMENT_PT = ELEMENT + "|PredefinedType";
  var ELEMENT_TYPE = ROOT + "|ApplicableOccurrence|HasPropertySets|RepresentationMaps|Tag|ElementType|PredefinedType";
  var REL = ROOT;

  var ATTRS_RAW = {
    // --- priestorová štruktúra ---
    IFCPROJECT: ROOT + "|ObjectType|LongName|Phase|RepresentationContexts|UnitsInContext",
    IFCSITE: PRODUCT + "|LongName|CompositionType|RefLatitude|RefLongitude|RefElevation|LandTitleNumber|SiteAddress",
    IFCBUILDING: PRODUCT + "|LongName|CompositionType|ElevationOfRefHeight|ElevationOfTerrain|BuildingAddress",
    IFCBUILDINGSTOREY: PRODUCT + "|LongName|CompositionType|Elevation",
    IFCSPACE: PRODUCT + "|LongName|CompositionType|PredefinedType|ElevationWithFlooring",
    IFCSPATIALZONE: PRODUCT + "|LongName|PredefinedType",
    // --- bežné prvky ---
    IFCWALL: ELEMENT_PT, IFCWALLSTANDARDCASE: ELEMENT_PT, IFCWALLELEMENTEDCASE: ELEMENT_PT,
    IFCSLAB: ELEMENT_PT, IFCSLABSTANDARDCASE: ELEMENT_PT, IFCROOF: ELEMENT_PT,
    IFCBEAM: ELEMENT_PT, IFCCOLUMN: ELEMENT_PT, IFCMEMBER: ELEMENT_PT, IFCPLATE: ELEMENT_PT,
    IFCFOOTING: ELEMENT_PT, IFCPILE: ELEMENT_PT + "|ConstructionType", IFCRAILING: ELEMENT_PT,
    IFCSTAIR: ELEMENT_PT, IFCSTAIRFLIGHT: ELEMENT + "|NumberOfRisers|NumberOfTreads|RiserHeight|TreadLength|PredefinedType",
    IFCRAMP: ELEMENT_PT, IFCRAMPFLIGHT: ELEMENT_PT, IFCCOVERING: ELEMENT_PT,
    IFCCURTAINWALL: ELEMENT_PT, IFCBUILDINGELEMENTPROXY: ELEMENT_PT,
    IFCFURNISHINGELEMENT: ELEMENT, IFCFURNITURE: ELEMENT_PT,
    IFCDOOR: ELEMENT + "|OverallHeight|OverallWidth|PredefinedType|OperationType|UserDefinedOperationType",
    IFCWINDOW: ELEMENT + "|OverallHeight|OverallWidth|PredefinedType|PartitioningType|UserDefinedPartitioningType",
    IFCOPENINGELEMENT: ELEMENT_PT, IFCVOIDINGFEATURE: ELEMENT_PT,
    IFCELEMENTASSEMBLY: ELEMENT + "|AssemblyPlace|PredefinedType",
    IFCANNOTATION: PRODUCT, IFCGRID: PRODUCT + "|UAxes|VAxes|WAxes|PredefinedType",
    IFCGRIDAXIS: "AxisTag|AxisCurve|SameSense",
    IFCFLOWSEGMENT: ELEMENT, IFCFLOWFITTING: ELEMENT, IFCFLOWTERMINAL: ELEMENT,
    IFCDISTRIBUTIONELEMENT: ELEMENT, IFCTRANSPORTELEMENT: ELEMENT_PT,
    IFCPROXY: PRODUCT + "|ProxyType|Tag",
    // --- typové objekty ---
    IFCWALLTYPE: ELEMENT_TYPE, IFCSLABTYPE: ELEMENT_TYPE, IFCBEAMTYPE: ELEMENT_TYPE,
    IFCCOLUMNTYPE: ELEMENT_TYPE, IFCDOORTYPE: ELEMENT_TYPE, IFCWINDOWTYPE: ELEMENT_TYPE,
    IFCCOVERINGTYPE: ELEMENT_TYPE, IFCFURNITURETYPE: ELEMENT_TYPE,
    IFCBUILDINGELEMENTPROXYTYPE: ELEMENT_TYPE, IFCMEMBERTYPE: ELEMENT_TYPE,
    IFCPLATETYPE: ELEMENT_TYPE, IFCRAILINGTYPE: ELEMENT_TYPE, IFCSTAIRTYPE: ELEMENT_TYPE,
    // --- väzby ---
    IFCRELAGGREGATES: REL + "|RelatingObject|RelatedObjects",
    IFCRELNESTS: REL + "|RelatingObject|RelatedObjects",
    IFCRELCONTAINEDINSPATIALSTRUCTURE: REL + "|RelatedElements|RelatingStructure",
    IFCRELDEFINESBYPROPERTIES: REL + "|RelatedObjects|RelatingPropertyDefinition",
    IFCRELDEFINESBYTYPE: REL + "|RelatedObjects|RelatingType",
    IFCRELDEFINESBYTEMPLATE: REL + "|RelatedPropertySets|RelatingTemplate",
    IFCRELASSOCIATESMATERIAL: REL + "|RelatedObjects|RelatingMaterial",
    IFCRELASSOCIATESCLASSIFICATION: REL + "|RelatedObjects|RelatingClassification",
    IFCRELASSOCIATESDOCUMENT: REL + "|RelatedObjects|RelatingDocument",
    IFCRELASSOCIATESLIBRARY: REL + "|RelatedObjects|RelatingLibrary",
    IFCRELASSIGNSTOGROUP: REL + "|RelatedObjects|RelatedObjectsType|RelatingGroup",
    IFCRELASSIGNSTOPRODUCT: REL + "|RelatedObjects|RelatedObjectsType|RelatingProduct",
    IFCRELVOIDSELEMENT: REL + "|RelatingBuildingElement|RelatedOpeningElement",
    IFCRELFILLSELEMENT: REL + "|RelatingOpeningElement|RelatedBuildingElement",
    IFCRELCONNECTSPATHELEMENTS: REL + "|ConnectionGeometry|RelatingElement|RelatedElement|RelatingPriorities|RelatedPriorities|RelatedConnectionType|RelatingConnectionType",
    IFCRELCONNECTSELEMENTS: REL + "|ConnectionGeometry|RelatingElement|RelatedElement",
    IFCRELSPACEBOUNDARY: REL + "|RelatingSpace|RelatedBuildingElement|ConnectionGeometry|PhysicalOrVirtualBoundary|InternalOrExternalBoundary",
    IFCRELSPACEBOUNDARY1STLEVEL: REL + "|RelatingSpace|RelatedBuildingElement|ConnectionGeometry|PhysicalOrVirtualBoundary|InternalOrExternalBoundary|ParentBoundary",
    IFCRELDECLARES: REL + "|RelatingContext|RelatedDefinitions",
    // --- vlastnosti a veličiny ---
    IFCPROPERTYSET: ROOT + "|HasProperties",
    IFCPROPERTYSINGLEVALUE: "Name|Description|NominalValue|Unit",
    IFCPROPERTYENUMERATEDVALUE: "Name|Description|EnumerationValues|EnumerationReference",
    IFCPROPERTYLISTVALUE: "Name|Description|ListValues|Unit",
    IFCPROPERTYBOUNDEDVALUE: "Name|Description|UpperBoundValue|LowerBoundValue|Unit|SetPointValue",
    IFCPROPERTYREFERENCEVALUE: "Name|Description|UsageName|PropertyReference",
    IFCPROPERTYTABLEVALUE: "Name|Description|DefiningValues|DefinedValues|Expression|DefiningUnit|DefinedUnit|CurveInterpolation",
    IFCCOMPLEXPROPERTY: "Name|Description|UsageName|HasProperties",
    IFCELEMENTQUANTITY: ROOT + "|MethodOfMeasurement|Quantities",
    IFCQUANTITYLENGTH: "Name|Description|Unit|LengthValue|Formula",
    IFCQUANTITYAREA: "Name|Description|Unit|AreaValue|Formula",
    IFCQUANTITYVOLUME: "Name|Description|Unit|VolumeValue|Formula",
    IFCQUANTITYCOUNT: "Name|Description|Unit|CountValue|Formula",
    IFCQUANTITYWEIGHT: "Name|Description|Unit|WeightValue|Formula",
    // --- metaúdaje a jednotky ---
    IFCOWNERHISTORY: "OwningUser|OwningApplication|State|ChangeAction|LastModifiedDate|LastModifyingUser|LastModifyingApplication|CreationDate",
    IFCPERSONANDORGANIZATION: "ThePerson|TheOrganization|Roles",
    IFCPERSON: "Identification|FamilyName|GivenName|MiddleNames|PrefixTitles|SuffixTitles|Roles|Addresses",
    IFCORGANIZATION: "Identification|Name|Description|Roles|Addresses",
    IFCAPPLICATION: "ApplicationDeveloper|Version|ApplicationFullName|ApplicationIdentifier",
    IFCUNITASSIGNMENT: "Units",
    IFCSIUNIT: "Dimensions|UnitType|Prefix|Name",
    IFCCONVERSIONBASEDUNIT: "Dimensions|UnitType|Name|ConversionFactor",
    IFCDERIVEDUNIT: "Elements|UnitType|UserDefinedType",
    IFCDERIVEDUNITELEMENT: "Unit|Exponent",
    IFCMEASUREWITHUNIT: "ValueComponent|UnitComponent",
    IFCDIMENSIONALEXPONENTS: "LengthExponent|MassExponent|TimeExponent|ElectricCurrentExponent|ThermodynamicTemperatureExponent|AmountOfSubstanceExponent|LuminousIntensityExponent",
    IFCMONETARYUNIT: "Currency",
    IFCPOSTALADDRESS: "Purpose|Description|UserDefinedPurpose|InternalLocation|AddressLines|PostalBox|Town|Region|PostalCode|Country",
    // --- umiestnenie a geometria ---
    IFCCARTESIANPOINT: "Coordinates",
    IFCCARTESIANPOINTLIST2D: "CoordList|TagList",
    IFCCARTESIANPOINTLIST3D: "CoordList|TagList",
    IFCDIRECTION: "DirectionRatios",
    IFCVECTOR: "Orientation|Magnitude",
    IFCAXIS2PLACEMENT2D: "Location|RefDirection",
    IFCAXIS2PLACEMENT3D: "Location|Axis|RefDirection",
    IFCAXIS1PLACEMENT: "Location|Axis",
    IFCLOCALPLACEMENT: "PlacementRelTo|RelativePlacement",
    IFCGRIDPLACEMENT: "PlacementLocation|PlacementRefDirection",
    IFCPRODUCTDEFINITIONSHAPE: "Name|Description|Representations",
    IFCSHAPEREPRESENTATION: "ContextOfItems|RepresentationIdentifier|RepresentationType|Items",
    IFCTOPOLOGYREPRESENTATION: "ContextOfItems|RepresentationIdentifier|RepresentationType|Items",
    IFCSTYLEDREPRESENTATION: "ContextOfItems|RepresentationIdentifier|RepresentationType|Items",
    IFCSHAPEASPECT: "ShapeRepresentations|Name|Description|ProductDefinitional|PartOfProductDefinitionShape",
    IFCGEOMETRICREPRESENTATIONCONTEXT: "ContextIdentifier|ContextType|CoordinateSpaceDimension|Precision|WorldCoordinateSystem|TrueNorth",
    IFCGEOMETRICREPRESENTATIONSUBCONTEXT: "ContextIdentifier|ContextType|CoordinateSpaceDimension|Precision|WorldCoordinateSystem|TrueNorth|ParentContext|TargetScale|TargetView|UserDefinedTargetView",
    IFCREPRESENTATIONMAP: "MappingOrigin|MappedRepresentation",
    IFCMAPPEDITEM: "MappingSource|MappingTarget",
    IFCCARTESIANTRANSFORMATIONOPERATOR2D: "Axis1|Axis2|LocalOrigin|Scale",
    IFCCARTESIANTRANSFORMATIONOPERATOR3D: "Axis1|Axis2|LocalOrigin|Scale|Axis3",
    IFCEXTRUDEDAREASOLID: "SweptArea|Position|ExtrudedDirection|Depth",
    IFCREVOLVEDAREASOLID: "SweptArea|Position|Axis|Angle",
    IFCSURFACECURVESWEPTAREASOLID: "SweptArea|Position|Directrix|StartParam|EndParam|ReferenceSurface",
    IFCBOOLEANRESULT: "Operator|FirstOperand|SecondOperand",
    IFCBOOLEANCLIPPINGRESULT: "Operator|FirstOperand|SecondOperand",
    IFCHALFSPACESOLID: "BaseSurface|AgreementFlag",
    IFCPOLYGONALBOUNDEDHALFSPACE: "BaseSurface|AgreementFlag|Position|PolygonalBoundary",
    IFCPLANE: "Position",
    IFCCIRCLE: "Position|Radius",
    IFCELLIPSE: "Position|SemiAxis1|SemiAxis2",
    IFCLINE: "Pnt|Dir",
    IFCTRIMMEDCURVE: "BasisCurve|Trim1|Trim2|SenseAgreement|MasterRepresentation",
    IFCCOMPOSITECURVE: "Segments|SelfIntersect",
    IFCCOMPOSITECURVESEGMENT: "Transition|SameSense|ParentCurve",
    IFCPOLYLINE: "Points",
    IFCINDEXEDPOLYCURVE: "Points|Segments|SelfIntersect",
    IFCPOLYLOOP: "Polygon",
    IFCFACE: "Bounds",
    IFCFACEOUTERBOUND: "Bound|Orientation",
    IFCFACEBOUND: "Bound|Orientation",
    IFCCLOSEDSHELL: "CfsFaces",
    IFCOPENSHELL: "CfsFaces",
    IFCCONNECTEDFACESET: "CfsFaces",
    IFCFACETEDBREP: "Outer",
    IFCADVANCEDBREP: "Outer",
    IFCFACEBASEDSURFACEMODEL: "FbsmFaces",
    IFCSHELLBASEDSURFACEMODEL: "SbsmBoundary",
    IFCTRIANGULATEDFACESET: "Coordinates|Normals|Closed|CoordIndex|PnIndex",
    IFCPOLYGONALFACESET: "Coordinates|Closed|Faces|PnIndex",
    IFCINDEXEDPOLYGONALFACE: "CoordIndex",
    IFCINDEXEDPOLYGONALFACEWITHVOIDS: "CoordIndex|InnerCoordIndices",
    IFCBOUNDINGBOX: "Corner|XDim|YDim|ZDim",
    IFCGEOMETRICCURVESET: "Elements",
    IFCGEOMETRICSET: "Elements",
    IFCARBITRARYCLOSEDPROFILEDEF: "ProfileType|ProfileName|OuterCurve",
    IFCARBITRARYPROFILEDEFWITHVOIDS: "ProfileType|ProfileName|OuterCurve|InnerCurves",
    IFCARBITRARYOPENPROFILEDEF: "ProfileType|ProfileName|Curve",
    IFCRECTANGLEPROFILEDEF: "ProfileType|ProfileName|Position|XDim|YDim",
    IFCCIRCLEPROFILEDEF: "ProfileType|ProfileName|Position|Radius",
    IFCCIRCLEHOLLOWPROFILEDEF: "ProfileType|ProfileName|Position|Radius|WallThickness",
    IFCISHAPEPROFILEDEF: "ProfileType|ProfileName|Position|OverallWidth|OverallDepth|WebThickness|FlangeThickness|FilletRadius",
    IFCDERIVEDPROFILEDEF: "ProfileType|ProfileName|ParentProfile|Operator|Label",
    IFCCOMPOSITEPROFILEDEF: "ProfileType|ProfileName|Profiles|Label",
    // --- materiály a vzhľad ---
    IFCMATERIAL: "Name|Description|Category",
    IFCMATERIALLIST: "Materials",
    IFCMATERIALLAYER: "Material|LayerThickness|IsVentilated|Name|Description|Category|Priority",
    IFCMATERIALLAYERSET: "MaterialLayers|LayerSetName|Description",
    IFCMATERIALLAYERSETUSAGE: "ForLayerSet|LayerSetDirection|DirectionSense|OffsetFromReferenceLine|ReferenceExtent",
    IFCMATERIALPROFILE: "Name|Description|Material|Profile|Priority|Category",
    IFCMATERIALPROFILESET: "Name|Description|MaterialProfiles|CompositeProfile",
    IFCMATERIALCONSTITUENT: "Name|Description|Material|Fraction|Category",
    IFCMATERIALCONSTITUENTSET: "Name|Description|MaterialConstituents",
    IFCSTYLEDITEM: "Item|Styles|Name",
    IFCPRESENTATIONSTYLEASSIGNMENT: "Styles",
    IFCSURFACESTYLE: "Name|Side|Styles",
    IFCSURFACESTYLESHADING: "SurfaceColour|Transparency",
    IFCSURFACESTYLERENDERING: "SurfaceColour|Transparency|DiffuseColour|TransmissionColour|DiffuseTransmissionColour|ReflectionColour|SpecularColour|SpecularHighlight|ReflectanceMethod",
    IFCCOLOURRGB: "Name|Red|Green|Blue",
    IFCPRESENTATIONLAYERASSIGNMENT: "Name|Description|AssignedItems|Identifier",
    IFCPRESENTATIONLAYERWITHSTYLE: "Name|Description|AssignedItems|Identifier|LayerOn|LayerFrozen|LayerBlocked|LayerStyles",
    IFCCURVESTYLE: "Name|CurveFont|CurveWidth|CurveColour|ModelOrDraughting",
    // --- hlavička súboru ---
    FILE_DESCRIPTION: "Description|ImplementationLevel",
    FILE_NAME: "Name|TimeStamp|Author|Organization|PreprocessorVersion|OriginatingSystem|Authorization",
    FILE_SCHEMA: "Schema"
  };

  var ATTRS = {};
  Object.keys(ATTRS_RAW).forEach(function (k) { ATTRS[k] = ATTRS_RAW[k].split("|"); });

  /* Názvy atribútov entity.
     Vracia {names, exact, version}:
       exact=true  — názvy pochádzajú zo schémy súboru (alebo z presnej tabuľky nižšie)
       exact=false — odhad podľa štruktúry entity, alebo názvy z inej verzie IFC
       version     — z ktorej schémy názvy sú (ak sa použil register js/ifc-schema-attrs.js)
     Poradie zdrojov: presná schéma → zabudovaná tabuľka bežných tried → odhad. */
  function attrNames(type, args, schema) {
    var t = (type || "").toUpperCase();

    var A = root.IFCAttrs;
    if (A) {
      var r = A.attrsFor(t, schema, args ? args.length : 0);
      if (r) return { names: r.names, kinds: r.kinds, exact: r.exact, version: r.version };
    }
    if (ATTRS[t]) return { names: ATTRS[t], exact: true };
    var rooted = args && args.length >= 4 && /^'[0-9A-Za-z_$]{22}'$/.test((args[0] || "").trim());
    if (!rooted) return { names: [], exact: false };
    if (/^IFCREL/.test(t)) return { names: ATTRS.IFCRELAGGREGATES.slice(0, 4), exact: false };
    if (/TYPE$/.test(t)) return { names: ATTRS.IFCWALLTYPE, exact: false };
    var isProduct = args.length >= 7 && isRefOrNull(args[5]) && isRefOrNull(args[6]);
    if (isProduct) return { names: (args.length >= 8 ? ELEMENT : PRODUCT).split("|"), exact: false };
    return { names: ROOT.split("|"), exact: false };
  }
  function isRefOrNull(a) { a = (a || "").trim(); return a === "$" || a === "*" || /^#\d+$/.test(a); }

  // ---------------------------------------------------------------------------
  // Farebné zvýraznenie jedného riadku
  // ---------------------------------------------------------------------------
  var KEYWORDS = new Set(["ISO", "HEADER", "DATA", "ENDSEC", "END", "STEP", "TRUE", "FALSE", "UNKNOWN"]);
  var TOK_RE = /'(?:''|[^'])*'?|#\d+|[A-Za-z_][A-Za-z0-9_]*|\.[A-Za-z_][A-Za-z0-9_]*\.|[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?|\$|\*/g;

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"; });
  }
  function span(cls, txt) { return '<span class="' + cls + '">' + esc(txt) + "</span>"; }

  // Koniec reťazcového literálu, ktorý začal na predchádzajúcom riadku.
  function stringEnd(line) {
    for (var i = 0; i < line.length; i++) {
      if (line[i] === "'") {
        if (line[i + 1] === "'") { i++; continue; }
        return i + 1;
      }
    }
    return line.length;
  }

  /* opts: {inString:bool, mainCat:"kc-element", isStart:bool} */
  function tokenizeLine(line, opts) {
    opts = opts || {};
    if (!line) return "";
    if (/^\s*(END-)?ISO-10303-21\s*;?\s*$/.test(line)) return span("t-key", line);

    var out = "", last = 0;
    if (opts.inString) {
      var e = stringEnd(line);
      out += span("t-str", line.slice(0, e));
      last = e;
    }
    TOK_RE.lastIndex = last;
    var m, mainDone = false;
    while ((m = TOK_RE.exec(line))) {
      if (m.index > last) out += span("t-punc", line.slice(last, m.index));
      var t = m[0], c = t[0];
      last = TOK_RE.lastIndex;

      if (c === "'") {
        // 22-znakový reťazec je GlobalId (IfcGloballyUniqueId)
        out += span(/^'[0-9A-Za-z_$]{22}'$/.test(t) ? "t-guid" : "t-str", t);
      } else if (c === "#") {
        var isSelfId = !mainDone && opts.isStart && /^\s*$/.test(line.slice(0, m.index));
        out += isSelfId
          ? span("t-id", t)
          : '<span class="t-ref" data-ref="' + t.slice(1) + '">' + esc(t) + "</span>";
      } else if (c === "$") {
        out += span("t-nil", t);
      } else if (c === "*") {
        out += span("t-nil", t);
      } else if (c === "." && t.length > 1) {
        out += span("t-enum", t);
      } else if (/[A-Za-z_]/.test(c)) {
        var up = t.toUpperCase();
        var isCall = /^\s*\(/.test(line.slice(last));
        if (isCall && !mainDone && opts.isStart) {
          mainDone = true;
          out += span("t-cls k-main " + (opts.mainCat || "kc-other"), t);
        } else if (isCall) {
          out += span("t-cls k-sub " + ("kc-" + categoryOf(up, null)), t);
        } else if (KEYWORDS.has(up) || /^FILE_/.test(up)) {
          out += span("t-key", t);
        } else {
          out += span("t-word", t);
        }
      } else {
        out += span("t-num", t);
      }
    }
    if (last < line.length) out += span("t-punc", line.slice(last));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Indexovanie súboru (po častiach, aby rozhranie nezamrzlo)
  // ---------------------------------------------------------------------------
  function indexFile(text, onProgress) {
    return new Promise(function (resolve, reject) {
      var lines;
      try { lines = text.split("\n"); }
      catch (e) { reject(new Error("Súbor je príliš veľký na zobrazenie v prehliadači.")); return; }

      var n = lines.length;
      var startsInStr = new Uint8Array(n);
      var lineStmt = new Int32Array(n);
      lineStmt.fill(-1);

      var stmtIds = [], stmtTypes = [], stmtFrom = [], stmtTo = [];
      var byId = new Map(), typeCounts = new Map(), typeSample = new Map(), intern = new Map();
      var inStr = false, inCom = false, curStart = -1;
      var maxLen = 0, schema = "", lengthUnit = "?", dataLine = -1, entityCount = 0;
      var i = 0;

      function internType(t) {
        var v = intern.get(t);
        if (v === undefined) { intern.set(t, t); v = t; }
        return v;
      }

      function closeStmt(a, b) {
        var head = lines[a];
        var m = /^\s*#(\d+)\s*=\s*([A-Za-z0-9_]+)/.exec(head);
        if (!m && a < b) m = /^\s*#(\d+)\s*=\s*([A-Za-z0-9_]+)/.exec(head + " " + lines[a + 1]);
        var id = -1, type = "";
        if (m) { id = +m[1]; type = internType(m[2].toUpperCase()); }
        else {
          var k = /^\s*([A-Za-z0-9_\-]+)/.exec(head);
          type = k ? internType(k[1].toUpperCase()) : "";
        }
        var idx = stmtIds.length;
        stmtIds.push(id); stmtTypes.push(type); stmtFrom.push(a); stmtTo.push(b);
        for (var j = a; j <= b; j++) lineStmt[j] = idx;

        if (id >= 0) {
          byId.set(id, idx);
          entityCount++;
          typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
          if (!typeSample.has(type)) typeSample.set(type, idx);
          if (type === "IFCSIUNIT" && lengthUnit === "?") {
            var body = joinLines(a, b);
            if (/\.LENGTHUNIT\./i.test(body)) lengthUnit = unitFrom(body);
          }
        } else {
          if (type === "DATA" && dataLine < 0) dataLine = a;
          if (type === "FILE_SCHEMA" && !schema) {
            var sm = /'([^']+)'/.exec(joinLines(a, b));
            if (sm) schema = sm[1].toUpperCase();
          }
        }
      }
      function joinLines(a, b) {
        if (a === b) return lines[a];
        return lines.slice(a, b + 1).join(" ");
      }
      function unitFrom(body) {
        if (/MILLI/i.test(body)) return "mm";
        if (/CENTI/i.test(body)) return "cm";
        if (/DECI/i.test(body)) return "dm";
        if (/KILO/i.test(body)) return "km";
        return "m";
      }

      function chunk() {
        var t0 = Date.now();
        while (i < n) {
          var ln = lines[i];
          if (ln.charCodeAt(ln.length - 1) === 13) { ln = ln.slice(0, -1); lines[i] = ln; }
          startsInStr[i] = inStr ? 1 : 0;
          if (ln.length > maxLen) maxLen = ln.length;

          for (var c = 0; c < ln.length; c++) {
            var ch = ln.charCodeAt(c);
            if (inCom) {
              if (ch === 42 /* * */ && ln.charCodeAt(c + 1) === 47 /* / */) { inCom = false; c++; }
              continue;
            }
            if (inStr) {
              if (ch === 39 /* ' */) {
                if (ln.charCodeAt(c + 1) === 39) c++;
                else inStr = false;
              }
              continue;
            }
            if (ch === 39) { if (curStart < 0) curStart = i; inStr = true; continue; }
            if (ch === 47 && ln.charCodeAt(c + 1) === 42) { inCom = true; c++; continue; }
            if (ch === 59 /* ; */) {
              if (curStart < 0) curStart = i;
              closeStmt(curStart, i);
              curStart = -1;
              continue;
            }
            if (curStart < 0 && ch > 32) curStart = i;
          }
          i++;
          if ((i & 511) === 0 && Date.now() - t0 > 24) break;
        }
        if (onProgress) onProgress(i / n);
        if (i < n) setTimeout(chunk, 0);
        else finish();
      }

      function finish() {
        if (!schema) {
          var sm = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text.slice(0, 4000));
          schema = sm ? sm[1].toUpperCase() : "neznáma";
        }
        var types = Array.from(typeCounts.entries())
          .map(function (e) { return { type: e[0], count: e[1] }; })
          .sort(function (a, b) { return b.count - a.count || (a.type < b.type ? -1 : 1); });

        resolve({
          lines: lines,
          lineCount: n,
          startsInStr: startsInStr,
          lineStmt: lineStmt,
          stmtIds: stmtIds,
          stmtTypes: stmtTypes,
          stmtFrom: stmtFrom,
          stmtTo: stmtTo,
          byId: byId,
          types: types,
          typeSample: typeSample,
          maxLen: maxLen,
          schema: schema,
          lengthUnit: lengthUnit,
          entityCount: entityCount,
          dataLine: dataLine,
          byteLength: text.length,
          // telo príkazu (spojené riadky bez koncovej bodkočiarky)
          stmtText: function (idx) {
            var a = stmtFrom[idx], b = stmtTo[idx];
            var s = a === b ? lines[a] : lines.slice(a, b + 1).join(" ");
            var semi = s.lastIndexOf(";");
            if (semi >= 0) s = s.slice(0, semi);
            return s.trim();
          },
          // telo bez „#ID =“ na začiatku, teda TRIEDA(...)
          stmtBody: function (idx) {
            var s = this.stmtText(idx);
            var eq = s.indexOf("=");
            return stmtIds[idx] >= 0 && eq >= 0 ? s.slice(eq + 1).trim() : s;
          }
        });
      }

      setTimeout(chunk, 0);
    });
  }

  root.IFCCode = {
    indexFile: indexFile,
    tokenizeLine: tokenizeLine,
    attrNames: attrNames,
    categoryOf: categoryOf,
    categoryLabel: categoryLabel,
    splitArgs: splitArgs,
    splitTopLevel: splitTopLevel,
    refsIn: refsIn,
    decodeIfcText: decodeIfcText,
    encodeIfcText: encodeIfcText,
    argSpans: argSpans,
    replaceArg: replaceArg,
    classifyValue: classifyValue,
    serializeValue: serializeValue,
    listItems: listItems,
    serializeList: serializeList,
    esc: esc,
    CAT_LABEL: CAT_LABEL
  };
})(typeof self !== "undefined" ? self : this);
