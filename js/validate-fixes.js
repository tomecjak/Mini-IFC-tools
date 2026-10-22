/* validate-fixes.js — čo s nálezmi z validácie buildingSMART.
 *
 * Ku každej kontrole a ku každému normatívnemu pravidlu krátky návod, ako chybu
 * opraviť alebo čo treba urobiť. js/validate.js ho ukáže pri kontrole, ktorá
 * neprešla. Pravidlá sú pomenované kódom z ifc-gherkin-rules (napr. ALB004);
 * pri pravidle, ktoré tu nie je, sa použije text jeho funkčnej časti (ALB, GEM…).
 *
 * Konkrétnu očakávanú a zistenú hodnotu vypisuje každý nález — tieto texty
 * hovoria, čo pravidlo chce a kde sa to v modeli alebo pri exporte mení.
 */
(function () {
  "use strict";

  // Kontroly z rýchlej (JS) a hĺbkovej (ifcopenshell) kontroly — kľúč = chk.key.
  var CHECKS = {
    struct:
      "Súbor je pravdepodobne orezaný alebo poškodený — prerušené sťahovanie, plný disk pri exporte, " +
      "ručná úprava. Exportujte ho znova z autorského nástroja. Hlavičku (FILE_DESCRIPTION, FILE_NAME, " +
      "FILE_SCHEMA) zapisuje každý exportér; ak chýba, súbor bol upravovaný mimo neho.",
    schema:
      "Exportujte v jednej z oficiálnych verzií: IFC2X3 (TC1), IFC4 (ADD2 TC1) alebo IFC4X3_ADD2 — " +
      "pre infraštruktúru (cesty, mosty, železnice) IFC4X3_ADD2. Predbežné verzie ako IFC4X1, IFC4X2 " +
      "alebo IFC4X3_RC* už nie sú platné; v exportéri vyberte novšiu, prípadne aktualizujte softvér.",
    syntax:
      "Ide o chybu exportéra alebo ručnej úpravy. Kliknutím na nález otvoríte riadok v prehliadači kódu: " +
      "skontrolujte párové zátvorky, apostrofy v textoch (apostrof vnútri textu sa zdvojuje: '') a " +
      "bodkočiarku na konci každého príkazu. Ak súbor nikto ručne neupravoval, nahláste chybu dodávateľovi " +
      "softvéru a exportujte znova.",
    ids:
      "Duplicitné #ID vznikajú najčastejšie pri ručnom spájaní súborov (skopírovaná sekcia DATA). Pri " +
      "spájaní treba entity prečíslovať — napríklad nástrojom na zlúčenie modelov v tejto aplikácii. " +
      "Každé číslo smie byť v súbore definované práve raz.",
    refs:
      "Entita, na ktorú odkaz smeruje, v súbore chýba — súbor je orezaný alebo bola entita zmazaná bez " +
      "úpravy odkazov. Doplňte chýbajúcu entitu, alebo odkaz nahraďte znakom $ (len pri voliteľnom " +
      "atribúte). Najistejšia oprava je nový export.",
    types:
      "Trieda nie je v schéme z hlavičky alebo má iný počet atribútov. Typicky súbor deklaruje inú schému, " +
      "než v akej bol naozaj zapísaný (napr. entity IFC4 v súbore označenom IFC2X3), alebo bol zlúčený " +
      "z modelov rôznych verzií. Skontrolujte FILE_SCHEMA a exportujte v jednej, správnej verzii.",
    guid:
      "GlobalId musí mať 22 znakov z abecedy 0–9 A–Z a–z _ $ a byť v súbore jedinečné. Duplicity vznikajú " +
      "pri kopírovaní objektov mimo autorského nástroja alebo pri spájaní dvoch exportov toho istého modelu. " +
      "Duplikátom vygenerujte nové GlobalId (napr. ifcopenshell.guid.new()); formát UUID s pomlčkami " +
      "sa musí najprv skomprimovať na 22 znakov.",
    orph:
      "Nie je to chyba schémy, ale zbytočné dáta, ktoré zväčšujú súbor (pozri aj pravidlá IFC105/IFC106). " +
      "V exportéri zapnite vynechanie nepoužitých dát; pri upravenom súbore entity odstráňte čistiacim " +
      "nástrojom (napr. IfcOpenShell / IfcPatch).",
    dschema:
      "Hodnota atribútu nezodpovedá schéme: povinný atribút je prázdny ($), hodnota má zlý dátový typ " +
      "(napr. 1 namiesto 1. pri REAL, text namiesto výčtu), hodnota nie je vo výčte alebo zoznam má zlý " +
      "počet prvkov. Hlásenie uvádza atribút a očakávaný typ. Chýbajúce údaje doplňte v autorskom nástroji; " +
      "ak ide o chybu exportu, nahláste ju dodávateľovi — jednotlivé hodnoty sa dajú opraviť aj priamo v kóde.",
    drule:
      "Porušená podmienka WHERE zo schémy — napríklad nulový vektor smeru, polyline s menej ako dvoma " +
      "bodmi, nekladný rozmer profilu alebo PredefinedType USERDEFINED bez vyplneného ObjectType. Názov " +
      "pravidla v hlásení (Trieda.Pravidlo) hľadajte v dokumentácii IFC. Údajové podmienky opravte " +
      "v modeli, geometrické väčšinou spôsobuje exportér."
  };

  // Funkčné časti ifc-gherkin-rules — ak pravidlo nemá vlastný text.
  var PARTS = {
    ALB: "os trasy — logika (alignment)", ALS: "os trasy — geometria", ANN: "anotácie",
    ASM: "zložené prvky", AXG: "osová geometria", BBX: "obalový kváder",
    BLT: "stavebné prvky", BRP: "geometria Brep", CLS: "klasifikácia",
    CTX: "farby a textúry", DOC: "dokumenty", GDP: "umiestnenie na rastri",
    GEM: "geometria", GRF: "georeferencovanie", GRP: "skupiny", IFC: "všeobecné pravidlá IFC",
    LAY: "vrstvy", LIP: "lineárne umiestnenie", LOP: "lokálne umiestnenie", MAT: "materiály",
    MPD: "mapované reprezentácie", OJP: "umiestnenie objektov", OJT: "typy objektov",
    PJS: "projekt", POR: "porty", PSE: "vlastnosti (property sety)", QTY: "množstvá",
    SPA: "priestory", SPS: "priestorová štruktúra", SWE: "vytláčané profily",
    SYS: "systémy", TAS: "teselovaná geometria", VER: "verzie a revízie", VRT: "virtuálne prvky"
  };

  var LAYOUT_FIX =
    "Rozvrhnutia osi musia byť vnorené podľa šablóny IFC 4.3: IfcAlignment vnára (IfcRelNests) " +
    "IfcAlignmentHorizontal, prípadne IfcAlignmentVertical a IfcAlignmentCant. Viac výškových riešení nad " +
    "jedným horizontálnym sa zapisuje cez podriadené IfcAlignment. Upravte štruktúru vnorenia podľa " +
    "očakávanej hodnoty v náleze.";
  var CONTINUITY_FIX =
    "Koniec segmentu sa nezhoduje s polohou alebo dotyčnicou začiatku nasledujúceho segmentu v rámci " +
    "presnosti modelu. Skontrolujte parametre prvkov trasy (dĺžky, polomery, parametre prechodníc) " +
    "a presnosť (Precision) geometrického kontextu — často ide o zaokrúhľovanie pri exporte.";
  var SEGTYPE_FIX =
    "Všetky segmenty jednej zloženej krivky musia byť rovnakého typu; IfcGradientCurve a " +
    "IfcSegmentedReferenceCurve sa skladajú výhradne z IfcCurveSegment (nie IfcCompositeCurveSegment). " +
    "Ide o nastavenie exportu — nahláste ho dodávateľovi, ak sa nedá zmeniť.";
  var ORPHAN_FIX =
    "Entita z vrstvy zdrojov (bod, smer, profil, štýl, jednotka…) nie je naviazaná na žiadny objekt " +
    "s GlobalId — je to nepoužitý zvyšok. Odstráňte ju, alebo ju pripojte tam, kam patrí. V exportéri " +
    "zapnite vynechanie nepoužitých dát; upravený súbor vyčistite nástrojom (napr. IfcPatch).";
  var MVD_FIX =
    "Hlavička súboru (FILE_DESCRIPTION → ViewDefinition) deklaruje túto MVD, no model obsahuje entity " +
    "mimo jej rozsahu. Buď ich pri exporte vynechajte, alebo v hlavičke uveďte MVD, ktorá ich pripúšťa.";

  // t = názov po slovensky, fix = čo urobiť.
  var RULES = {
    ALB000: { t: "Logika osi trasy",
      fix: "IfcAlignment musí vnárať aspoň IfcAlignmentHorizontal. Exportujte os aj s logikou návrhu " +
           "(horizontálne a výškové riešenie, prevýšenie), nielen ako krivku." },
    ALB002: { t: "Väzby rozvrhnutí osi",
      fix: "Rozvrhnutia sa k IfcAlignment a segmenty IfcAlignmentSegment k rozvrhnutiam pripájajú cez " +
           "IfcRelNests, nie cez IfcRelAggregates. Opravte typ vzťahu (nastavenie exportu)." },
    ALB003: { t: "Vnáranie do osi trasy",
      fix: "Cez IfcRelNests patria do IfcAlignment len rozvrhnutia (Horizontal/Vertical/Cant) a IfcReferent. " +
           "Ostatné prvky z vnorenia vyberte — prvky pozdĺž trasy sa k nej viažu cez IfcRelPositions." },
    ALB004: { t: "Os trasy v projekte",
      fix: "Každý IfcAlignment musí byť cez IfcRelAggregates priradený k IfcProject (podriadená os k nadradenej " +
           "osi, tá k projektu). Do IfcSite či objektu os len odkážte cez IfcRelReferencedInSpatialStructure, " +
           "nie cez IfcRelContainedInSpatialStructure." },
    ALB005: { t: "Polohovanie referentov",
      fix: "IfcReferent s PredefinedType POSITION alebo STATION musí byť k osi naviazaný cez IfcRelPositions " +
           "(RelatingPositioningElement = IfcAlignment)." },
    ALB010: { t: "Staničenie na osi",
      fix: "Horizontálna os má vnárať aspoň jeden IfcReferent — napr. začiatočnú stanicu so staničením. " +
           "Doplňte staničenie v návrhovom softvéri a zapnite jeho export." },
    ALB012: { t: "Polomer zakružovacieho oblúka",
      fix: "RadiusOfCurvature výškového segmentu nesedí s jeho geometriou (zmena sklonu a dĺžka). " +
           "Prepočítajte polomer alebo dĺžku segmentu, prípadne exportujte znova." },
    ALB015: { t: "Koncový nulový segment (logika)",
      fix: "Každé rozvrhnutie (horizontálne, výškové, prevýšenie) musí končiť segmentom s dĺžkou 0, ktorý " +
           "označuje koniec osi. Doplňte ho; ak to exportér nevie, nahláste chybu dodávateľovi." },
    ALB021: { t: "Zhoda logiky a geometrie osi",
      fix: "Typ krivky osi musí zodpovedať rozvrhnutiam: len horizontálne → IfcCompositeCurve, s výškovým → " +
           "IfcGradientCurve, s prevýšením → IfcSegmentedReferenceCurve." },
    ALB022: { t: "Počet segmentov logiky a geometrie",
      fix: "Počet segmentov v geometrii sa musí rovnať počtu IfcAlignmentSegment v logike (vrátane koncového " +
           "nulového). Exportujte logiku aj geometriu z toho istého stavu návrhu." },
    ALB023: { t: "Typy segmentov logiky a geometrie",
      fix: "Každý segment geometrie musí mať rovnaký typ ako zodpovedajúci segment logiky (priamka → IfcLine, " +
           "oblúk → IfcCircle, prechodnica → IfcClothoid…)." },
    ALB030: { t: "Umiestnenie osi trasy",
      fix: "ObjectPlacement každého IfcAlignment musí byť IfcLocalPlacement — nie IfcLinearPlacement ani " +
           "IfcGridPlacement." },
    ALB031: { t: "Vnorenie rozvrhnutí — základný prípad", fix: LAYOUT_FIX },
    ALB032: { t: "Vnorenie rozvrhnutí — zdieľané horizontálne", fix: LAYOUT_FIX },

    ALS000: { t: "Geometria osi trasy",
      fix: "Os trasy má mať geometrickú reprezentáciu (IfcShapeRepresentation). Zapnite export geometrie osi." },
    ALS004: { t: "Reprezentácia segmentu osi",
      fix: "IfcAlignmentSegment má nesprávny identifikátor, typ alebo položku reprezentácie. Porovnajte " +
           "očakávanú a zistenú hodnotu v náleze a upravte export segmentov." },
    ALS005: { t: "Reprezentácia osi trasy",
      fix: "IfcAlignment používa nepodporovanú reprezentáciu. Prípustné kombinácie sú v dokumentácii IFC 4.3 " +
           "(IfcAlignment, kap. 5.4.3.1); porovnajte s očakávanou hodnotou v náleze." },
    ALS006: { t: "Reprezentácia horizontálnej osi",
      fix: "IfcAlignmentHorizontal sa reprezentuje typom Curve2D s položkou IfcCompositeCurve, " +
           "IfcIndexedPolyCurve alebo IfcPolyline." },
    ALS007: { t: "Reprezentácia výškového riešenia",
      fix: "IfcAlignmentVertical sa reprezentuje typom Curve3D s položkou IfcGradientCurve." },
    ALS008: { t: "Reprezentácia prevýšenia",
      fix: "IfcAlignmentCant sa reprezentuje typom Curve3D s položkou IfcSegmentedReferenceCurve." },
    ALS010: { t: "Počet položiek v reprezentácii segmentu",
      fix: "Reprezentácia IfcAlignmentSegment má nesprávny počet položiek — každý segment má jednu krivku. " +
           "Upravte export segmentov." },
    ALS011: { t: "Jednotné typy segmentov osi", fix: SEGTYPE_FIX },
    ALS012: { t: "Typ SegmentStart a SegmentLength",
      fix: "SegmentStart a SegmentLength v IfcCurveSegment sa zapisujú ako IFCLENGTHMEASURE(…), nie ako " +
           "IFCPARAMETERVALUE ani IFCNONNEGATIVELENGTHMEASURE. Je to chyba exportéra — opravte ju v kóde " +
           "alebo nahláste dodávateľovi." },
    ALS015: { t: "Koncový nulový segment (geometria)",
      fix: "Krivka osi musí končiť segmentom s dĺžkou 0 a prechodom DISCONTINUOUS. Doplňte ho pri exporte." },
    ALS016: { t: "Spojitosť horizontálnych segmentov", fix: CONTINUITY_FIX },
    ALS017: { t: "Spojitosť výškových segmentov", fix: CONTINUITY_FIX },

    BBX001: { t: "Obalový kváder ako reprezentácia",
      fix: "Reprezentácia s IfcBoundingBox musí mať RepresentationIdentifier 'Box' a RepresentationType " +
           "'BoundingBox'." },
    BLT001: { t: "Typ otvárania dverí",
      fix: "UserDefinedOperationType vyplňte len pri OperationType = USERDEFINED. Ak majú dvere priradený " +
           "IfcDoorType, OperationType určuje typ — pri inštancii ho nechajte prázdny." },
    BLT002: { t: "Členenie okien",
      fix: "UserDefinedPartitioningType vyplňte len pri PartitioningType = USERDEFINED. Ak má okno priradený " +
           "IfcWindowType, PartitioningType určuje typ — pri inštancii ho nechajte prázdny." },
    BLT003: { t: "Rozklad schodiska",
      fix: "IfcStair smie agregovať len prípustné časti (ramená IfcStairFlight, podesty IfcSlab, zábradlia " +
           "IfcRailing, prvky IfcMember…). Ostatné prvky z agregácie schodiska vyberte a zaraďte do podlažia." },
    BRP002: { t: "Súvislosť plôch telesa",
      fix: "Plochy jedného shellu tvoria viac nespojených častí. Rozdeľte teleso na samostatné položky " +
           "reprezentácie, alebo opravte geometriu v autorskom nástroji." },
    BRP003: { t: "Rovinnosť plôch",
      fix: "Polygónová plocha bez podkladovej plochy nie je rovinná v rámci tolerancie modelu. Exportujte ju " +
           "ako trojuholníky (IfcTriangulatedFaceSet) alebo ju rozdeľte na rovinné časti." },

    GEM001: { t: "Uzavretosť telesa",
      fix: "Každá hrana uzavretého telesa musí byť použitá práve dvakrát a v opačných smeroch — teleso má " +
           "diery, prekrývajúce sa alebo opačne orientované plochy. Opravte geometriu v autorskom nástroji, " +
           "prípadne ju exportujte ako teselovanú (IfcTriangulatedFaceSet)." },
    GEM002: { t: "Reprezentácia priestoru",
      fix: "IfcSpace musí mať reprezentáciu Body typu SweptSolid, Clipping, Brep alebo Tessellation. " +
           "Zmeňte spôsob exportu miestností." },
    GEM003: { t: "Jedinečný identifikátor reprezentácie",
      fix: "Jeden prvok nesmie mať dve reprezentácie s rovnakým RepresentationIdentifier (napr. dve 'Body'). " +
           "Položky zlúčte do jednej reprezentácie." },
    GEM004: { t: "Povolené identifikátory a typy reprezentácií",
      fix: "RepresentationIdentifier a RepresentationType musia byť z povolených hodnôt (Body, Axis, Box, " +
           "FootPrint… / SweptSolid, Brep, Tessellation…) a k sebe pasovať. Opravte podľa očakávanej hodnoty." },
    GEM005: { t: "Reprezentácia budovy",
      fix: "IfcBuilding má reprezentáciu, ktorá nezodpovedá povoleným kombináciám. Porovnajte s očakávanou " +
           "hodnotou — geometria budovy sa spravidla vôbec neexportuje, nesú ju prvky." },
    GEM011: { t: "Jednotné typy segmentov krivky", fix: SEGTYPE_FIX },
    GEM051: { t: "Geometrický kontext",
      fix: "Model musí mať IfcGeometricRepresentationContext s vyplneným ContextType — 'Model' pre 3D, " +
           "'Plan' pre 2D." },
    GEM052: { t: "Geometrické podkontexty",
      fix: "Každý kontext má mať aspoň jeden IfcGeometricRepresentationSubContext s ContextIdentifier " +
           "z povolených hodnôt (Body, Axis, Box, FootPrint…). Reprezentácie priraďujte podkontextom." },
    GEM111: { t: "Duplicitné body v polyline",
      fix: "IfcPolyLoop alebo IfcPolyline má dva body bližšie, než je presnosť modelu — duplicity odstráňte. " +
           "Uzavretá polyline má na konci odkazovať na ten istý IfcCartesianPoint (rovnaké #ID), nie na kópiu." },
    GEM112: { t: "Duplicitné body v IfcIndexedPolyCurve",
      fix: "IfcIndexedPolyCurve obsahuje body bližšie, než je presnosť modelu. Odstráňte opakované body " +
           "z IfcCartesianPointList a upravte indexy segmentov." },
    GEM113: { t: "Oblúk z bodov na priamke",
      fix: "IfcArcIndex nesmie byť zadaný tromi bodmi na jednej priamke — taký segment zapíšte ako IfcLineIndex." },

    GRF001: { t: "Rovnaká transformácia súradníc",
      fix: "Všetky geometrické kontexty projektu musia odkazovať na tú istú inštanciu IfcMapConversion " +
           "(a tá na ten istý IfcProjectedCRS) — alebo ju nesmie mať žiadny. Zjednoťte georeferencovanie pri exporte." },
    GRF002: { t: "EPSG kód súradnicového systému",
      fix: "IfcProjectedCRS.Name má obsahovať platný kód EPSG, napr. 'EPSG:5514' (S-JTSK / Krovak East North)." },
    GRF003: { t: "Súradnicový systém pri stavbách",
      fix: "Model s budovou, mostom či cestou má byť georeferencovaný: IfcMapConversion + IfcProjectedCRS " +
           "(napr. EPSG:5514, výšky Bpv EPSG:8357). RefLatitude/RefLongitude na IfcSite nestačia." },
    GRF004: { t: "Platný EPSG kód",
      fix: "Ak názov CRS začína 'EPSG:', číslo musí existovať v databáze EPSG. Skontrolujte preklep a nepoužívajte " +
           "kódy ESRI (napr. 102067 — namiesto neho EPSG:5514)." },
    GRF005: { t: "Mierka pri rozdielnych jednotkách",
      fix: "Ak model používa iné jednotky ako CRS (napr. milimetre voči metrom), IfcMapConversion.Scale musí " +
           "obsahovať prevod — pre mm → m hodnotu 0.001." },
    GRF006: { t: "WKT pri chýbajúcom EPSG",
      fix: "Ak súradnicový systém nemá kód EPSG, doplňte jeho definíciu cez IfcWellKnownText." },
    GRF007: { t: "Výškový systém",
      fix: "Výškový systém (VerticalDatum) musí byť výškový alebo zložený CRS, napr. EPSG:8357 (Baltic 1957 height)." },
    GRF008: { t: "Jednotky rigidnej transformácie",
      fix: "Súradnice v IfcRigidOperation (FirstCoordinate, SecondCoordinate) musia mať typ podľa jednotiek " +
           "systému — dĺžky ako IfcLengthMeasure, uhly ako IfcPlaneAngleMeasure." },

    GRP001: { t: "Cyklické skupiny",
      fix: "Skupina nesmie (ani nepriamo) obsahovať sama seba. Odstráňte väzbu IfcRelAssignsToGroup, " +
           "ktorá uzatvára kruh." },
    IFC101: { t: "Oficiálna verzia IFC", fix: CHECKS.schema },
    IFC102: { t: "Zastarané entity",
      fix: "Model obsahuje entity, atribúty alebo hodnoty výčtov označené ako zastarané (napr. " +
           "IfcWallStandardCase v IFC4X3, IfcProxy). Použite novší exportér alebo ich nahraďte nástupcami " +
           "(IfcWall, IfcBuildingElementProxy…)." },
    IFC105: { t: "Nepripojené entity zdrojov", fix: ORPHAN_FIX },
    IFC106: { t: "Nepripojené entity zdrojov", fix: ORPHAN_FIX },
    IFC430: { t: "Rozsah MVD Reference View", fix: MVD_FIX },
    IFC431: { t: "Rozsah MVD Alignment-based View", fix: MVD_FIX },

    LIP002: { t: "Záložné súradnice lineárneho umiestnenia",
      fix: "IfcLinearPlacement má mať vyplnené CartesianPosition a jeho hodnota má zodpovedať polohe " +
           "vypočítanej z RelativePlacement. Doplňte alebo prepočítajte pri exporte." },
    MPD001: { t: "Mapované reprezentácie",
      fix: "Reprezentácia s IfcMappedItem má typ 'MappedRepresentation' a rovnaký RepresentationIdentifier ako " +
           "mapovaná reprezentácia; všetky mapované reprezentácie musia mať rovnaký RepresentationType." },
    OJP001: { t: "Umiestnenie častí zostavy",
      fix: "Prvok, ktorý je časťou iného prvku (IfcRelAggregates), musí mať IfcLocalPlacement s PlacementRelTo " +
           "na umiestnenie nadradeného prvku — nie podlažia." },
    OJT001: { t: "PredefinedType objektu",
      fix: "Pri PredefinedType = USERDEFINED vyplňte ObjectType. Ak má prvok typ (IfcTypeObject) s určeným " +
           "PredefinedType, pri inštancii ho nechajte prázdny alebo NOTDEFINED — typ ho neprepisuje." },
    PJS001: { t: "Jednotky odvodené prevodom",
      fix: "Názov IfcConversionBasedUnit (inch, foot, degree…) a jeho prevodný faktor musia sedieť s tabuľkou " +
           "odporúčaných hodnôt (napr. degree = 0.0174532925199433 rad). Opravte faktor alebo názov." },
    PJS002: { t: "Prvky viazané priamo na projekt",
      fix: "Prvky (steny, nosníky…) sa k IfcProject neviažu cez IfcRelDeclares — zaraďte ich do priestorovej " +
           "štruktúry cez IfcRelContainedInSpatialStructure. IfcRelDeclares je pre typy a knižnice." },
    PJS003: { t: "Tvar GlobalId",
      fix: "GlobalId má 22 znakov z 0–9 A–Z a–z _ $ a prvý znak 0–3. Nevyhovujúcim objektom vygenerujte " +
           "nové identifikátory (napr. ifcopenshell.guid.new())." },
    PJS101: { t: "Práve jeden IfcProject",
      fix: "Model má obsahovať práve jeden IfcProject. Pri spájaní modelov zlúčte projekty do jedného " +
           "(napr. nástrojom na zlúčenie v tejto aplikácii)." },
    PSE001: { t: "Štandardné property sety (Pset_)",
      fix: "Pset_ so štandardným názvom smie obsahovať len vlastnosti z definície IFC, so správnym druhom " +
           "(SingleValue, EnumeratedValue…) a dátovým typom, a byť priradený k triede, pre ktorú je určený. " +
           "Vlastné vlastnosti presuňte do vlastného property setu bez predpony Pset_." },
    PSE002: { t: "Názov vlastného property setu",
      fix: "Vlastné property sety nesmú začínať na „Pset“ v žiadnej veľkosti písmen — premenujte ich " +
           "(napr. predponou firmy alebo krajiny: SK_…, CZ_…)." },
    QTY001: { t: "Štandardné sady množstiev (Qto_)",
      fix: "Qto_ so štandardným názvom smie obsahovať len množstvá z definície IFC, so správnym druhom " +
           "(IfcQuantityLength, Area, Volume…) a byť priradený k triede, pre ktorú je určený. Vlastné " +
           "množstvá presuňte do sady bez predpony Qto_." },
    SPS001: { t: "Základná priestorová štruktúra",
      fix: "Model budovy má mať najviac jeden IfcSite a aspoň jednu IfcBuilding: IfcProject → IfcSite → " +
           "IfcBuilding → IfcBuildingStorey, prepojené cez IfcRelAggregates." },
    SPS002: { t: "Priestorový rozklad",
      fix: "Priestorové prvky musia byť agregované podľa tabuľky skladby — napr. podlažie pod budovou, " +
           "IfcSpace pod podlažím, IfcBridgePart pod IfcBridge. Upravte hierarchiu IfcRelAggregates." },
    SPS003: { t: "Zaradenie zostáv",
      fix: "Prvok, ktorý je časťou iného prvku (IfcRelAggregates), nesmie byť zároveň zaradený do podlažia " +
           "cez IfcRelContainedInSpatialStructure — zaradená je len nadradená zostava." },
    SPS004: { t: "Zaradenie alebo polohovanie",
      fix: "Produkt je obsiahnutý buď v jednom priestorovom prvku, alebo v jednom IfcLinearPositioningElement — " +
           "nie v oboch. Jeden zo vzťahov odstráňte alebo zmeňte na odkaz (IfcRelReferencedInSpatialStructure)." },
    SPS005: { t: "Súčasné priestorové vzťahy",
      fix: "Prvok smie byť potomkom len v jednom vzťahu (agregácia, vnorenie alebo zaradenie). Ponechajte jeden." },
    SPS007: { t: "Priestorové zaradenie",
      fix: "IfcRelContainedInSpatialStructure sa použije len podľa konceptu Spatial Containment — prvok je " +
           "zaradený do jedného prípustného priestorového prvku. Ďalšie väzby zmeňte na " +
           "IfcRelReferencedInSpatialStructure; porovnajte s očakávanou hodnotou v náleze." },
    SPS008: { t: "Geometria priestorových kontajnerov",
      fix: "Niektoré priestorové kontajnery nemajú mať vlastnú geometriu — slúžia len na zaradenie prvkov. " +
           "Geometriu presuňte na prvky, alebo ju pri kontajneri neexportujte." },
    SWE001: { t: "Samopretínajúci sa profil",
      fix: "Hranica IfcArbitraryClosedProfileDef pretína sama seba, takže vytlačené teleso je neplatné. " +
           "Opravte náčrt profilu v autorskom nástroji (zdvojené čiary, slučky)." },
    SWE002: { t: "Zrkadlenie v odvodenom profile",
      fix: "Operator v IfcDerivedProfileDef nesmie zrkadliť — na zrkadlenie sa používa IfcMirroredProfileDef." },
    SYS001: { t: "Smer signálu kábla",
      fix: "IfcCableSegment musí mať dva porty IfcDistributionPort — jeden SOURCE a jeden SINK." }
  };

  var GENERIC =
    "Porovnajte očakávanú a zistenú hodnotu v nálezoch a upravte model alebo nastavenie exportu. " +
    "Úplný popis pravidla je v repozitári ifc-gherkin-rules (odkaz nižšie).";

  function rule(code) {
    var r = RULES[code], part = PARTS[String(code).slice(0, 3)];
    return {
      title: r ? r.t : part ? "Pravidlo — " + part : "",
      fix: r ? r.fix : GENERIC,
      url: "https://github.com/buildingSMART/ifc-gherkin-rules/tree/main/features/rules/" +
           encodeURIComponent(String(code).slice(0, 3))
    };
  }

  window.ValidateFixes = { check: function (key) { return CHECKS[key] || ""; }, rule: rule };
})();
