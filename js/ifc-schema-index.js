/* ifc-schema-index.js — register tried IFC pre odkazy do dokumentácie buildingSMART.
 *
 * GENEROVANÝ SÚBOR. Zdroje (stiahnuté 1. 8. 2026):
 *   IFC2x3 TC1  — alphabeticalorder_entities.htm (názov triedy → doména dokumentácie)
 *   IFC4 ADD2 TC1 — výpis adresára HTML/link/ (ktoré stránky existujú)
 *   IFC4.3      — annex-b1.html (presný zápis názvov, napr. IfcWall)
 *
 * Formát záznamu:  Nazov|priznaky[|domena2x3]
 *   Nazov      — bez predpony Ifc. Ak obsahuje veľké písmeno, je to presný zápis
 *                zo schémy IFC4.3; inak je názov známy len malými písmenami.
 *   priznaky   — bitovo: 1 = je v IFC2x3, 2 = je v IFC4, 4 = je v IFC4.3
 *   domena2x3  — index do zoznamu DOMAINS (dokumentácia IFC2x3 je členená po doménach)
 */
(function (root) {
  "use strict";

  var DOMAINS = [
    "actorresource approvalresource architecturedomain buildingcontrolsdomain constraintresource",
    "constructionmgmtdomain controlextension costresource datetimeresource electricaldomain",
    "externalreferenceresource facilitiesmgmtdomain geometricconstraintresource",
    "geometricmodelresource geometryresource hvacdomain kernel materialpropertyresource",
    "materialresource measureresource plumbingfireprotectiondomain presentationappearanceresource",
    "presentationdefinitionresource presentationdimensioningresource presentationorganizationresource",
    "presentationresource processextension productextension profilepropertyresource profileresource",
    "propertyresource quantityresource representationresource sharedbldgelements",
    "sharedbldgserviceelements sharedcomponentelements sharedfacilitieselements sharedmgmtelements",
    "structuralanalysisdomain structuralelementsdomain structuralloadresource timeseriesresource",
    "topologyresource utilityresource"
  ].join(" ").split(" ");

  var RAW = [
    "2dcompositecurve|1|14 absorbeddosemeasure|2 accelerationmeasure|2 ActionRequest|7|11 actionrequesttypeenum|2",
    "actionsourcetypeenum|2 actiontypeenum|2 Actor|7|16 actorresource|2 ActorRole|7|0 actorselect|2 Actuator|6",
    "ActuatorType|7|3 actuatortypeenum|2 Address|7|0 addresstypeenum|2 AdvancedBrep|6 AdvancedBrepWithVoids|6",
    "AdvancedFace|6 AirTerminal|6 AirTerminalBox|6 AirTerminalBoxType|7|15 airterminalboxtypeenum|2",
    "AirTerminalType|7|15 airterminaltypeenum|2 AirToAirHeatRecovery|6 AirToAirHeatRecoveryType|7|15",
    "airtoairheatrecoverytypeenum|2 Alarm|6 AlarmType|7|3 alarmtypeenum|2 Alignment|4 AlignmentCant|4",
    "AlignmentCantSegment|4 AlignmentHorizontal|4 AlignmentHorizontalSegment|4 AlignmentParameterSegment|4",
    "AlignmentSegment|4 AlignmentVertical|4 AlignmentVerticalSegment|4 amountofsubstancemeasure|2",
    "analysismodeltypeenum|2 analysistheorytypeenum|2 angulardimension|1|23 angularvelocitymeasure|2 Annotation|7|27",
    "annotationcurveoccurrence|1|22 AnnotationFillArea|7|22 annotationfillareaoccurrence|1|22",
    "annotationoccurrence|1|22 annotationsurface|1|22 annotationsurfaceoccurrence|1|22",
    "annotationsymboloccurrence|1|22 annotationtextoccurrence|1|22 Application|7|43 AppliedValue|7|7",
    "appliedvaluerelationship|1|7 appliedvalueselect|2 Approval|7|1 approvalactorrelationship|1|1",
    "approvalpropertyrelationship|1|1 ApprovalRelationship|7|1 approvalresource|2 ArbitraryClosedProfileDef|7|29",
    "ArbitraryOpenProfileDef|7|29 ArbitraryProfileDefWithVoids|7|29 architecturedomain|2 arcindex|2",
    "areadensitymeasure|2 areameasure|2 arithmeticoperatorenum|2 assemblyplaceenum|2 Asset|7|36 associatedsurface|2",
    "AsymmetricIShapeProfileDef|7|29 AudioVisualAppliance|6 AudioVisualApplianceType|6 audiovisualappliancetypeenum|2",
    "Axis1Placement|7|14 axis2placement|2 Axis2Placement2D|7|14 Axis2Placement3D|7|14 Axis2PlacementLinear|4",
    "baseaxis|2 Beam|7|33 beamstandardcase|2 BeamType|7|33 beamtypeenum|2 Bearing|4 BearingType|4 benchmarkenum|2",
    "bendingparameterselect|2 beziercurve|1|14 binary|2 BlobTexture|7|21 Block|7|13 Boiler|6 BoilerType|7|15",
    "boilertypeenum|2 boolean|2 booleanchoose|2 BooleanClippingResult|7|13 booleanoperand|2 booleanoperator|2",
    "BooleanResult|7|13 Borehole|4 BoundaryCondition|7|40 BoundaryCurve|6 BoundaryEdgeCondition|7|40",
    "BoundaryFaceCondition|7|40 BoundaryNodeCondition|7|40 BoundaryNodeConditionWarping|7|40 BoundedCurve|7|14",
    "BoundedSurface|7|14 BoundingBox|7|13 boxalignment|2 BoxedHalfSpace|7|13 Bridge|4 BridgePart|4 BSplineCurve|7|14",
    "bsplinecurveform|2 BSplineCurveWithKnots|6 BSplineSurface|6 bsplinesurfaceform|2 BSplineSurfaceWithKnots|6",
    "build2axes|2 buildaxes|2 Building|7|27 buildingcontrolsdomain|2 buildingelement|3|27",
    "buildingelementcomponent|1|39 BuildingElementPart|7|39 BuildingElementPartType|6 buildingelementparttypeenum|2",
    "BuildingElementProxy|7|27 BuildingElementProxyType|7|27 buildingelementproxytypeenum|2 buildingelementtype|3|27",
    "BuildingStorey|7|27 BuildingSystem|6 buildingsystemtypeenum|2 BuiltElement|4 BuiltElementType|4 BuiltSystem|4",
    "Burner|6 BurnerType|6 burnertypeenum|2 CableCarrierFitting|6 CableCarrierFittingType|7|9",
    "cablecarrierfittingtypeenum|2 CableCarrierSegment|6 CableCarrierSegmentType|7|9 cablecarriersegmenttypeenum|2",
    "CableFitting|6 CableFittingType|6 cablefittingtypeenum|2 CableSegment|6 CableSegmentType|7|9",
    "cablesegmenttypeenum|2 CaissonFoundation|4 CaissonFoundationType|4 calendardate|1|8 cardinalpointreference|2",
    "CartesianPoint|7|14 CartesianPointList|6 CartesianPointList2D|6 CartesianPointList3D|6",
    "CartesianTransformationOperator|7|14 CartesianTransformationOperator2D|7|14",
    "CartesianTransformationOperator2DnonUniform|7|14 CartesianTransformationOperator3D|7|14",
    "CartesianTransformationOperator3DnonUniform|7|14 CenterLineProfileDef|7|29 chamferedgefeature|1|35",
    "changeactionenum|2 Chiller|6 ChillerType|7|15 chillertypeenum|2 Chimney|6 ChimneyType|6 chimneytypeenum|2",
    "Circle|7|14 CircleHollowProfileDef|7|29 CircleProfileDef|7|29 CivilElement|6 CivilElementType|6",
    "Classification|7|10 classificationitem|1|10 classificationitemrelationship|1|10 classificationnotation|1|10",
    "classificationnotationfacet|1|10 ClassificationReference|7|10 classificationreferenceselect|2",
    "classificationselect|2 ClosedShell|7|42 Clothoid|4 Coil|6 CoilType|7|15 coiltypeenum|2 colour|2 colourorfactor|2",
    "ColourRgb|7|25 ColourRgbList|6 ColourSpecification|7|25 Column|7|33 columnstandardcase|2 ColumnType|7|33",
    "columntypeenum|2 CommunicationsAppliance|6 CommunicationsApplianceType|6 communicationsappliancetypeenum|2",
    "complexnumber|2 ComplexProperty|7|30 ComplexPropertyTemplate|6 complexpropertytemplatetypeenum|2",
    "CompositeCurve|7|14 CompositeCurveOnSurface|6 CompositeCurveSegment|7|14 CompositeProfileDef|7|29",
    "compoundplaneanglemeasure|2 Compressor|6 CompressorType|7|15 compressortypeenum|2 Condenser|6 CondenserType|7|15",
    "condensertypeenum|2 condition|1|11 conditioncriterion|1|11 Conic|7|14 ConnectedFaceSet|7|42",
    "ConnectionCurveGeometry|7|12 ConnectionGeometry|7|12 ConnectionPointEccentricity|7|12",
    "ConnectionPointGeometry|7|12 connectionportgeometry|1|12 ConnectionSurfaceGeometry|7|12 connectiontypeenum|2",
    "ConnectionVolumeGeometry|6 consecutivesegments|2 Constraint|7|4 constraintaggregationrelationship|1|4",
    "constraintclassificationrelationship|1|4 constraintenum|2 constraintrelationship|1|4 constraintresource|2",
    "constraintsparambspline|2 ConstructionEquipmentResource|7|5 ConstructionEquipmentResourceType|6",
    "constructionequipmentresourcetypeenum|2 ConstructionMaterialResource|7|5 ConstructionMaterialResourceType|6",
    "constructionmaterialresourcetypeenum|2 constructionmgmtdomain|2 ConstructionProductResource|7|5",
    "ConstructionProductResourceType|6 constructionproductresourcetypeenum|2 ConstructionResource|7|5",
    "ConstructionResourceType|6 Context|6 contextdependentmeasure|2 ContextDependentUnit|7|19 Control|7|16",
    "controlextension|2 Controller|6 ControllerType|7|3 controllertypeenum|2 ConversionBasedUnit|7|19",
    "ConversionBasedUnitWithOffset|6 convertdirectioninto2d|2 ConveyorSegment|4 ConveyorSegmentType|4 CooledBeam|6",
    "CooledBeamType|7|15 cooledbeamtypeenum|2 CoolingTower|6 CoolingTowerType|7|15 coolingtowertypeenum|2",
    "coordinateduniversaltimeoffset|1|8 CoordinateOperation|6 CoordinateReferenceSystem|6",
    "coordinatereferencesystemselect|2 correctdimensions|2 correctfillareastyle|2 correctlocalplacement|2",
    "correctobjectassignment|2 correctunitassignment|2 CosineSpiral|4 CostItem|7|37 costitemtypeenum|2 costresource|2",
    "CostSchedule|7|37 costscheduletypeenum|2 CostValue|7|7 countmeasure|2 Course|4 CourseType|4 Covering|7|27",
    "CoveringType|7|27 coveringtypeenum|2 cranerailashapeprofiledef|1|29 cranerailfshapeprofiledef|1|29",
    "CrewResource|7|5 CrewResourceType|6 crewresourcetypeenum|2 crossproduct|2 CsgPrimitive3D|7|13 csgselect|2",
    "CsgSolid|7|13 CShapeProfileDef|7|29 CurrencyRelationship|7|7 CurtainWall|7|33 CurtainWallType|7|33",
    "curtainwalltypeenum|2 curvaturemeasure|2 Curve|7|14 CurveBoundedPlane|7|14 CurveBoundedSurface|6 curvedim|2",
    "curvefontorscaledcurvefontselect|2 curveinterpolationenum|2 curveonsurface|2 curveoredgecurve|2 CurveSegment|4",
    "CurveStyle|7|21 CurveStyleFont|7|21 CurveStyleFontAndScaling|7|21 CurveStyleFontPattern|7|21",
    "curvestylefontselect|2 curveweightspositive|2 CylindricalSurface|6 Damper|6 DamperType|7|15 dampertypeenum|2",
    "dataoriginenum|2 date|2 dateandtime|1|8 datetime|2 datetimeresource|2 dayinmonthnumber|2 dayinweeknumber|2",
    "DeepFoundation|4 DeepFoundationType|4 definedsymbol|1|22 definitionselect|2 derivedimensionalexponents|2",
    "derivedmeasurevalue|2 DerivedProfileDef|7|29 DerivedUnit|7|19 DerivedUnitElement|7|19 derivedunitenum|2",
    "descriptivemeasure|2 diameterdimension|1|23 DimensionalExponents|7|19 dimensioncalloutrelationship|1|23",
    "dimensioncount|2 dimensioncurve|1|23 dimensioncurvedirectedcallout|1|23 dimensioncurveterminator|1|23",
    "dimensionpair|1|23 dimensionsforsiunit|2 Direction|7|14 directionsenseenum|2 DirectrixCurveSweptAreaSolid|4",
    "DirectrixDerivedReferenceSweptAreaSolid|4 DiscreteAccessory|7|35 DiscreteAccessoryType|7|35",
    "discreteaccessorytypeenum|2 DistributionBoard|4 DistributionBoardType|4 DistributionChamberElement|7|34",
    "DistributionChamberElementType|7|34 distributionchamberelementtypeenum|2 DistributionCircuit|6",
    "DistributionControlElement|7|34 DistributionControlElementType|7|34 DistributionElement|7|27",
    "DistributionElementType|7|27 DistributionFlowElement|7|34 DistributionFlowElementType|7|34 DistributionPort|7|34",
    "distributionporttypeenum|2 DistributionSystem|6 distributionsystemenum|2 documentconfidentialityenum|2",
    "documentelectronicformat|1|10 DocumentInformation|7|10 DocumentInformationRelationship|7|10",
    "DocumentReference|7|10 documentselect|2 documentstatusenum|2 Door|7|33 DoorLiningProperties|7|33",
    "doorpaneloperationenum|2 doorpanelpositionenum|2 DoorPanelProperties|7|33 doorstandardcase|2 doorstyle|3|33",
    "doorstyleconstructionenum|2 doorstyleoperationenum|2 DoorType|6 doortypeenum|2 doortypeoperationenum|2",
    "doseequivalentmeasure|2 dotproduct|2 draughtingcallout|1|23 draughtingcalloutrelationship|1|23",
    "DraughtingPreDefinedColour|7|25 DraughtingPreDefinedCurveFont|7|21 draughtingpredefinedtextfont|1|25",
    "DuctFitting|6 DuctFittingType|7|15 ductfittingtypeenum|2 DuctSegment|6 DuctSegmentType|7|15",
    "ductsegmenttypeenum|2 DuctSilencer|6 DuctSilencerType|7|15 ductsilencertypeenum|2 duration|2",
    "dynamicviscositymeasure|2 EarthworksCut|4 EarthworksElement|4 EarthworksFill|4 Edge|7|42 EdgeCurve|7|42",
    "edgefeature|1|35 EdgeLoop|7|42 electricalbaseproperties|1|34 electricalcircuit|1|9 electricaldomain|2",
    "electricalelement|1|27 ElectricAppliance|6 ElectricApplianceType|7|9 electricappliancetypeenum|2",
    "electriccapacitancemeasure|2 electricchargemeasure|2 electricconductancemeasure|2 electriccurrentmeasure|2",
    "ElectricDistributionBoard|6 ElectricDistributionBoardType|6 electricdistributionboardtypeenum|2",
    "electricdistributionpoint|1|9 ElectricFlowStorageDevice|6 ElectricFlowStorageDeviceType|7|9",
    "electricflowstoragedevicetypeenum|2 ElectricFlowTreatmentDevice|4 ElectricFlowTreatmentDeviceType|4",
    "ElectricGenerator|6 ElectricGeneratorType|7|9 electricgeneratortypeenum|2 electricheatertype|1|9 ElectricMotor|6",
    "ElectricMotorType|7|9 electricmotortypeenum|2 electricresistancemeasure|2 ElectricTimeControl|6",
    "ElectricTimeControlType|7|9 electrictimecontroltypeenum|2 electricvoltagemeasure|2 Element|7|27",
    "ElementarySurface|7|14 ElementAssembly|7|27 ElementAssemblyType|6 elementassemblytypeenum|2",
    "ElementComponent|7|35 ElementComponentType|7|35 elementcompositionenum|2 ElementQuantity|7|27 ElementType|7|27",
    "Ellipse|7|14 EllipseProfileDef|7|29 EnergyConversionDevice|7|34 EnergyConversionDeviceType|7|34 energymeasure|2",
    "energyproperties|1|34 Engine|6 EngineType|6 enginetypeenum|2 environmentalimpactvalue|1|7 equipmentelement|1|27",
    "equipmentstandard|1|11 EvaporativeCooler|6 EvaporativeCoolerType|7|15 evaporativecoolertypeenum|2 Evaporator|6",
    "EvaporatorType|7|15 evaporatortypeenum|2 Event|6 EventTime|6 eventtriggertypeenum|2 EventType|6 eventtypeenum|2",
    "extendedmaterialproperties|1|17 ExtendedProperties|6 ExternalInformation|6 ExternallyDefinedHatchStyle|7|21",
    "ExternallyDefinedSurfaceStyle|7|21 externallydefinedsymbol|1|22 ExternallyDefinedTextFont|7|25",
    "ExternalReference|7|10 ExternalReferenceRelationship|6 externalreferenceresource|2 ExternalSpatialElement|6",
    "externalspatialelementtypeenum|2 ExternalSpatialStructureElement|6 ExtrudedAreaSolid|7|13",
    "ExtrudedAreaSolidTapered|6 Face|7|42 FaceBasedSurfaceModel|7|13 FaceBound|7|42 FaceOuterBound|7|42",
    "FaceSurface|7|42 FacetedBrep|7|13 FacetedBrepWithVoids|7|13 Facility|4 FacilityPart|4 FacilityPartCommon|4",
    "FailureConnectionCondition|7|40 Fan|6 FanType|7|15 fantypeenum|2 Fastener|7|35 FastenerType|7|35",
    "fastenertypeenum|2 FeatureElement|7|27 FeatureElementAddition|7|27 FeatureElementSubtraction|7|27",
    "FillAreaStyle|7|21 FillAreaStyleHatching|7|21 FillAreaStyleTiles|7|21 fillareastyletilesymbolwithstyle|1|21",
    "fillstyleselect|2 Filter|6 FilterType|7|15 filtertypeenum|2 FireSuppressionTerminal|6",
    "FireSuppressionTerminalType|7|20 firesuppressionterminaltypeenum|2 firstprojaxis|2",
    "FixedReferenceSweptAreaSolid|6 FlowController|7|34 FlowControllerType|7|34 flowdirectionenum|2 FlowFitting|7|34",
    "FlowFittingType|7|34 FlowInstrument|6 FlowInstrumentType|7|3 flowinstrumenttypeenum|2 FlowMeter|6",
    "FlowMeterType|7|15 flowmetertypeenum|2 FlowMovingDevice|7|34 FlowMovingDeviceType|7|34 FlowSegment|7|34",
    "FlowSegmentType|7|34 FlowStorageDevice|7|34 FlowStorageDeviceType|7|34 FlowTerminal|7|34 FlowTerminalType|7|34",
    "FlowTreatmentDevice|7|34 FlowTreatmentDeviceType|7|34 fluidflowproperties|1|34 fontstyle|2 fontvariant|2",
    "fontweight|2 Footing|7|39 FootingType|6 footingtypeenum|2 forcemeasure|2 frequencymeasure|2 fuelproperties|1|17",
    "FurnishingElement|7|27 FurnishingElementType|7|27 Furniture|6 furniturestandard|1|11 FurnitureType|7|36",
    "furnituretypeenum|2 gasterminaltype|1|15 generalmaterialproperties|1|17 generalprofileproperties|1|28",
    "GeographicCRS|4 GeographicElement|6 GeographicElementType|6 geographicelementtypeenum|2",
    "geometricconstraintresource|2 GeometricCurveSet|7|13 geometricmodelresource|2 geometricprojectionenum|2",
    "GeometricRepresentationContext|7|32 GeometricRepresentationItem|7|14 GeometricRepresentationSubContext|7|32",
    "GeometricSet|7|13 geometricsetselect|2 geometryresource|2 Geomodel|4 Geoslice|4 GeotechnicalAssembly|4",
    "GeotechnicalElement|4 GeotechnicalStratum|4 getbasissurface|2 globallyuniqueid|2 globalorlocalenum|2",
    "GradientCurve|4 Grid|7|27 GridAxis|7|12 GridPlacement|7|12 gridplacementdirectionselect|2 gridtypeenum|2",
    "Group|7|16 HalfSpaceSolid|7|13 hatchlinedistanceselect|2 HeatExchanger|6 HeatExchangerType|7|15",
    "heatexchangertypeenum|2 heatfluxdensitymeasure|2 heatingvaluemeasure|2 Humidifier|6 HumidifierType|7|15",
    "humidifiertypeenum|2 hvacdomain|2 hygroscopicmaterialproperties|1|17 identifier|2 illuminancemeasure|2",
    "ImageTexture|7|21 ImpactProtectionDevice|4 ImpactProtectionDeviceType|4 IndexedColourMap|6 IndexedPolyCurve|6",
    "IndexedPolygonalFace|6 IndexedPolygonalFaceWithVoids|6 IndexedPolygonalTextureMap|4 IndexedTextureMap|6",
    "IndexedTriangleTextureMap|6 inductancemeasure|2 integer|2 integercountratemeasure|2 Interceptor|6",
    "InterceptorType|6 interceptortypeenum|2 internalorexternalenum|2 IntersectionCurve|6 Inventory|7|36",
    "inventorytypeenum|2 ionconcentrationmeasure|2 IrregularTimeSeries|7|41 IrregularTimeSeriesValue|7|41",
    "IShapeProfileDef|7|29 isothermalmoisturecapacitymeasure|2 JunctionBox|6 JunctionBoxType|7|9",
    "junctionboxtypeenum|2 Kerb|4 KerbType|4 kernel|2 kinematicviscositymeasure|2 knottype|2 label|2",
    "LaborResource|7|5 LaborResourceType|6 laborresourcetypeenum|2 LagTime|6 Lamp|6 LampType|7|9 lamptypeenum|2",
    "languageid|2 layereditem|2 layersetdirectionenum|2 lengthmeasure|2 LibraryInformation|7|10 LibraryReference|7|10",
    "libraryselect|2 lightdistributioncurveenum|2 LightDistributionData|7|24 lightdistributiondatasourceselect|2",
    "lightemissionsourceenum|2 LightFixture|6 LightFixtureType|7|9 lightfixturetypeenum|2",
    "LightIntensityDistribution|7|24 LightSource|7|24 LightSourceAmbient|7|24 LightSourceDirectional|7|24",
    "LightSourceGoniometric|7|24 LightSourcePositional|7|24 LightSourceSpot|7|24 Line|7|14 lineardimension|1|23",
    "LinearElement|4 linearforcemeasure|2 linearmomentmeasure|2 LinearPlacement|4 LinearPositioningElement|4",
    "linearstiffnessmeasure|2 linearvelocitymeasure|2 lineindex|2 LiquidTerminal|4 LiquidTerminalType|4 listtoarray|2",
    "loadgrouptypeenum|2 LocalPlacement|7|12 localtime|1|8 logical|2 logicaloperatorenum|2 Loop|7|42 loopheadtotail|2",
    "LShapeProfileDef|7|29 luminousfluxmeasure|2 luminousintensitydistributionmeasure|2 luminousintensitymeasure|2",
    "magneticfluxdensitymeasure|2 magneticfluxmeasure|2 makearrayofarray|2 ManifoldSolidBrep|7|13 MapConversion|6",
    "MapConversionScaled|4 MappedItem|7|14 MarineFacility|4 MarinePart|4 massdensitymeasure|2 massflowratemeasure|2",
    "massmeasure|2 massperlengthmeasure|2 Material|7|18 MaterialClassificationRelationship|7|18 MaterialConstituent|6",
    "MaterialConstituentSet|6 MaterialDefinition|6 MaterialDefinitionRepresentation|7|32 MaterialLayer|7|18",
    "MaterialLayerSet|7|18 MaterialLayerSetUsage|7|18 MaterialLayerWithOffsets|6 MaterialList|7|18 MaterialProfile|6",
    "MaterialProfileSet|6 MaterialProfileSetUsage|6 MaterialProfileSetUsageTapering|6 MaterialProfileWithOffsets|6",
    "MaterialProperties|7|17 MaterialRelationship|6 materialresource|2 materialselect|2 MaterialUsageDefinition|6",
    "measureresource|2 measurevalue|2 MeasureWithUnit|7|19 mechanicalconcretematerialproperties|1|17",
    "MechanicalFastener|7|35 MechanicalFastenerType|7|35 mechanicalfastenertypeenum|2",
    "mechanicalmaterialproperties|1|17 mechanicalsteelmaterialproperties|1|17 MedicalDevice|6 MedicalDeviceType|6",
    "medicaldevicetypeenum|2 Member|7|33 memberstandardcase|2 MemberType|7|33 membertypeenum|2 Metric|7|4",
    "metricvalueselect|2 MirroredProfileDef|6 mlstotalthickness|2 MobileTelecommunicationsAppliance|4",
    "MobileTelecommunicationsApplianceType|4 modulusofelasticitymeasure|2 modulusoflinearsubgradereactionmeasure|2",
    "modulusofrotationalsubgradereactionmeasure|2 modulusofrotationalsubgradereactionselect|2",
    "modulusofsubgradereactionmeasure|2 modulusofsubgradereactionselect|2",
    "modulusoftranslationalsubgradereactionselect|2 moisturediffusivitymeasure|2 molecularweightmeasure|2",
    "momentofinertiameasure|2 monetarymeasure|2 MonetaryUnit|7|19 monthinyearnumber|2 MooringDevice|4",
    "MooringDeviceType|4 MotorConnection|6 MotorConnectionType|7|9 motorconnectiontypeenum|2 move|1|11 NamedUnit|7|19",
    "NavigationElement|4 NavigationElementType|4 nonnegativelengthmeasure|2 normalise|2 normalisedratiomeasure|2",
    "nullstyle|2 numericmeasure|2 Object|7|16 ObjectDefinition|7|16 Objective|7|4 objectiveenum|2",
    "ObjectPlacement|7|12 objectreferenceselect|2 objecttypeenum|2 Occupant|7|36 occupanttypeenum|2 OffsetCurve|4",
    "OffsetCurve2D|7|14 OffsetCurve3D|7|14 OffsetCurveByDistances|4 onedirectionrepeatfactor|1|21",
    "OpenCrossProfileDef|4 OpeningElement|7|27 openingelementtypeenum|2 openingstandardcase|2 OpenShell|7|42",
    "opticalmaterialproperties|1|17 orderaction|1|11 Organization|7|0 OrganizationRelationship|7|0 OrientedEdge|7|42",
    "orthogonalcomplement|2 OuterBoundaryCurve|6 Outlet|6 OutletType|7|9 outlettypeenum|2 OwnerHistory|7|43",
    "ParameterizedProfileDef|7|29 parametervalue|2 Path|7|42 pathheadtotail|2 Pavement|4 PavementType|4 Pcurve|6",
    "PerformanceHistory|7|6 performancehistorytypeenum|2 permeablecoveringoperationenum|2",
    "PermeableCoveringProperties|7|2 Permit|7|11 permittypeenum|2 Person|7|0 PersonAndOrganization|7|0 phmeasure|2",
    "PhysicalComplexQuantity|7|31 physicalorvirtualenum|2 PhysicalQuantity|7|31 PhysicalSimpleQuantity|7|31 Pile|7|39",
    "pileconstructionenum|2 PileType|6 piletypeenum|2 PipeFitting|6 PipeFittingType|7|15 pipefittingtypeenum|2",
    "PipeSegment|6 PipeSegmentType|7|15 pipesegmenttypeenum|2 PixelTexture|7|21 Placement|7|14 PlanarBox|7|25",
    "PlanarExtent|7|25 planarforcemeasure|2 Plane|7|14 planeanglemeasure|2 Plate|7|33 platestandardcase|2",
    "PlateType|7|33 platetypeenum|2 plumbingfireprotectiondomain|2 Point|7|14 PointByDistanceExpression|4",
    "pointlistdim|2 PointOnCurve|7|14 PointOnSurface|7|14 pointorvertexpoint|2 PolygonalBoundedHalfSpace|7|13",
    "PolygonalFaceSet|6 Polyline|7|14 PolyLoop|7|42 PolynomialCurve|4 Port|7|27 PositioningElement|4",
    "positiveinteger|2 positivelengthmeasure|2 positiveplaneanglemeasure|2 positiveratiomeasure|2 PostalAddress|7|0",
    "powermeasure|2 PreDefinedColour|7|25 PreDefinedCurveFont|7|21 predefineddimensionsymbol|1|23 PreDefinedItem|7|25",
    "predefinedpointmarkersymbol|1|23 PreDefinedProperties|6 PreDefinedPropertySet|6 predefinedsymbol|1|22",
    "predefinedterminatorsymbol|1|23 PreDefinedTextFont|7|25 preferredsurfacecurverepresentation|2 presentabletext|2",
    "presentationappearanceresource|2 presentationdefinitionresource|2 PresentationItem|6",
    "PresentationLayerAssignment|7|24 PresentationLayerWithStyle|7|24 presentationorganizationresource|2",
    "PresentationStyle|7|21 presentationstyleassignment|3|21 presentationstyleselect|2 pressuremeasure|2",
    "Procedure|7|26 ProcedureType|6 proceduretypeenum|2 Process|7|16 processextension|2 processselect|2 Product|7|16",
    "ProductDefinitionShape|7|32 productextension|2 ProductRepresentation|7|32 productrepresentationselect|2",
    "productselect|2 productsofcombustionproperties|1|17 ProfileDef|7|29 ProfileProperties|7|28 profileresource|2",
    "profiletypeenum|2 Project|7|16 ProjectedCRS|6 projectedortruelengthenum|2 projectioncurve|1|23",
    "ProjectionElement|7|27 projectionelementtypeenum|2 ProjectLibrary|6 ProjectOrder|7|37 projectorderrecord|1|37",
    "projectordertypeenum|2 Property|7|30 PropertyAbstraction|6 PropertyBoundedValue|7|30",
    "propertyconstraintrelationship|1|4 PropertyDefinition|7|16 PropertyDependencyRelationship|7|30",
    "PropertyEnumeratedValue|7|30 PropertyEnumeration|7|30 PropertyListValue|7|30 PropertyReferenceValue|7|30",
    "propertyresource|2 PropertySet|7|16 PropertySetDefinition|7|16 propertysetdefinitionselect|2",
    "propertysetdefinitionset|2 PropertySetTemplate|6 propertysettemplatetypeenum|2 PropertySingleValue|7|30",
    "PropertyTableValue|7|30 PropertyTemplate|6 PropertyTemplateDefinition|6 ProtectiveDevice|6",
    "ProtectiveDeviceTrippingUnit|6 ProtectiveDeviceTrippingUnitType|6 protectivedevicetrippingunittypeenum|2",
    "ProtectiveDeviceType|7|9 protectivedevicetypeenum|2 proxy|3|16 Pump|6 PumpType|7|15 pumptypeenum|2",
    "QuantityArea|7|31 QuantityCount|7|31 QuantityLength|7|31 QuantityNumber|4 quantityresource|2 QuantitySet|6",
    "QuantityTime|7|31 QuantityVolume|7|31 QuantityWeight|7|31 radioactivitymeasure|2 radiusdimension|1|23 Rail|4",
    "Railing|7|33 RailingType|7|33 railingtypeenum|2 RailType|4 Railway|4 RailwayPart|4 Ramp|7|33 RampFlight|7|33",
    "RampFlightType|7|33 rampflighttypeenum|2 RampType|6 ramptypeenum|2 ratiomeasure|2 rationalbeziercurve|1|14",
    "RationalBSplineCurveWithKnots|6 RationalBSplineSurfaceWithKnots|6 real|2 RectangleHollowProfileDef|7|29",
    "RectangleProfileDef|7|29 RectangularPyramid|7|13 RectangularTrimmedSurface|7|14 RecurrencePattern|6",
    "recurrencetypeenum|2 Reference|6 referencesvaluedocument|1|7 Referent|4 reflectancemethodenum|2",
    "RegularTimeSeries|7|41 ReinforcedSoil|4 ReinforcementBarProperties|7|28 ReinforcementDefinitionProperties|7|39",
    "ReinforcingBar|7|39 reinforcingbarroleenum|2 reinforcingbarsurfaceenum|2 ReinforcingBarType|6",
    "reinforcingbartypeenum|2 ReinforcingElement|7|39 ReinforcingElementType|6 ReinforcingMesh|7|39",
    "ReinforcingMeshType|6 reinforcingmeshtypeenum|2 RelAdheresToElement|4 RelAggregates|7|16 RelAssigns|7|16",
    "relassignstasks|1|26 RelAssignsToActor|7|16 RelAssignsToControl|7|16 RelAssignsToGroup|7|16",
    "RelAssignsToGroupByFactor|6 RelAssignsToProcess|7|16 RelAssignsToProduct|7|16 relassignstoprojectorder|1|37",
    "RelAssignsToResource|7|16 RelAssociates|7|16 relassociatesappliedvalue|1|37 RelAssociatesApproval|7|6",
    "RelAssociatesClassification|7|16 RelAssociatesConstraint|7|6 RelAssociatesDocument|7|16",
    "RelAssociatesLibrary|7|16 RelAssociatesMaterial|7|27 RelAssociatesProfileDef|4",
    "relassociatesprofileproperties|1|38 Relationship|7|16 relaxation|1|17 RelConnects|7|16 RelConnectsElements|7|27",
    "RelConnectsPathElements|7|33 RelConnectsPorts|7|27 RelConnectsPortToElement|7|27",
    "RelConnectsStructuralActivity|7|38 relconnectsstructuralelement|1|38 RelConnectsStructuralMember|7|38",
    "RelConnectsWithEccentricity|7|38 RelConnectsWithRealizingElements|7|27 RelContainedInSpatialStructure|7|27",
    "RelCoversBldgElements|7|27 RelCoversSpaces|7|27 RelDeclares|6 RelDecomposes|7|16 RelDefines|7|16",
    "RelDefinesByObject|6 RelDefinesByProperties|7|16 RelDefinesByTemplate|6 RelDefinesByType|7|16",
    "RelFillsElement|7|27 RelFlowControlElements|7|34 relinteractionrequirements|1|2 RelInterferesElements|6",
    "RelNests|7|16 reloccupiesspaces|1|36 reloverridesproperties|1|16 RelPositions|4 RelProjectsElement|7|27",
    "RelReferencedInSpatialStructure|7|27 relschedulescostitems|1|37 RelSequence|7|16 RelServicesBuildings|7|27",
    "RelSpaceBoundary|7|27 RelSpaceBoundary1stLevel|6 RelSpaceBoundary2ndLevel|6 RelVoidsElement|7|27",
    "ReparametrisedCompositeCurveSegment|6 Representation|7|32 RepresentationContext|7|32",
    "representationcontextsamewcs|2 RepresentationItem|7|14 RepresentationMap|7|14 representationresource|2",
    "Resource|7|16 ResourceApprovalRelationship|6 ResourceConstraintRelationship|6 ResourceLevelRelationship|6",
    "resourceobjectselect|2 resourceselect|2 ResourceTime|6 RevolvedAreaSolid|7|13 RevolvedAreaSolidTapered|6",
    "ribplateprofileproperties|1|28 RightCircularCone|7|13 RightCircularCylinder|7|13 RigidOperation|4 Road|4",
    "RoadPart|4 roleenum|2 Roof|7|33 RoofType|6 rooftypeenum|2 Root|7|16 rotationalfrequencymeasure|2",
    "rotationalmassmeasure|2 rotationalstiffnessmeasure|2 rotationalstiffnessselect|2 roundededgefeature|1|35",
    "RoundedRectangleProfileDef|7|29 sameaxis2placement|2 samecartesianpoint|2 samedirection|2 samevalidprecision|2",
    "samevalue|2 SanitaryTerminal|6 SanitaryTerminalType|7|20 sanitaryterminaltypeenum|2 scalartimesvector|2",
    "scheduletimecontrol|1|26 SchedulingTime|6 SeamCurve|6 SecondOrderPolynomialSpiral|4 secondprojaxis|2",
    "sectionalareaintegralmeasure|2 SectionedSolid|4 SectionedSolidHorizontal|4 SectionedSpine|7|13",
    "SectionedSurface|4 sectionmodulusmeasure|2 SectionProperties|7|28 SectionReinforcementProperties|7|28",
    "sectiontypeenum|2 Segment|4 SegmentedReferenceCurve|4 segmentindexselect|2 Sensor|6 SensorType|7|3",
    "sensortypeenum|2 sequenceenum|2 servicelife|1|36 servicelifefactor|1|36 SeventhOrderPolynomialSpiral|4",
    "ShadingDevice|6 ShadingDeviceType|6 shadingdevicetypeenum|2 ShapeAspect|7|32 ShapeModel|7|32",
    "ShapeRepresentation|7|32 shaperepresentationtypes|2 sharedbldgelements|2 sharedbldgserviceelements|2",
    "sharedcomponentelements|2 sharedfacilitieselements|2 sharedmgmtelements|2 shearmodulusmeasure|2 shell|2",
    "ShellBasedSurfaceModel|7|13 Sign|4 Signal|4 SignalType|4 SignType|4 SimpleProperty|7|30 SimplePropertyTemplate|6",
    "simplepropertytemplatetypeenum|2 simplevalue|2 SineSpiral|4 singleprojectinstance|2 siprefix|2 Site|7|27",
    "SIUnit|7|19 siunitname|2 sizeselect|2 Slab|7|33 slabelementedcase|2 slabstandardcase|2 SlabType|7|33",
    "slabtypeenum|2 SlippageConnectionCondition|7|40 SolarDevice|6 SolarDeviceType|6 solardevicetypeenum|2",
    "solidanglemeasure|2 SolidModel|7|13 solidorshell|2 soundpowerlevelmeasure|2 soundpowermeasure|2",
    "soundpressurelevelmeasure|2 soundpressuremeasure|2 soundproperties|1|34 soundvalue|1|34 Space|7|27",
    "spaceboundaryselect|2 SpaceHeater|6 SpaceHeaterType|7|15 spaceheatertypeenum|2 spaceprogram|1|2",
    "spacethermalloadproperties|1|34 SpaceType|7|27 spacetypeenum|2 SpatialElement|6 SpatialElementType|6",
    "SpatialStructureElement|7|27 SpatialStructureElementType|7|27 SpatialZone|6 SpatialZoneType|6",
    "spatialzonetypeenum|2 specificheatcapacitymeasure|2 specularexponent|2 specularhighlightselect|2",
    "specularroughness|2 Sphere|7|13 SphericalSurface|6 Spiral|4 StackTerminal|6 StackTerminalType|7|20",
    "stackterminaltypeenum|2 Stair|7|33 StairFlight|7|33 StairFlightType|7|33 stairflighttypeenum|2 StairType|6",
    "stairtypeenum|2 stateenum|2 StructuralAction|7|38 StructuralActivity|7|38 structuralactivityassignmentselect|2",
    "structuralanalysisdomain|2 StructuralAnalysisModel|7|38 StructuralConnection|7|38",
    "StructuralConnectionCondition|7|40 StructuralCurveAction|6 structuralcurveactivitytypeenum|2",
    "StructuralCurveConnection|7|38 StructuralCurveMember|7|38 structuralcurvemembertypeenum|2",
    "StructuralCurveMemberVarying|7|38 StructuralCurveReaction|6 structuralelementsdomain|2 StructuralItem|7|38",
    "StructuralLinearAction|7|38 structurallinearactionvarying|1|38 StructuralLoad|7|40 StructuralLoadCase|6",
    "StructuralLoadConfiguration|6 StructuralLoadGroup|7|38 StructuralLoadLinearForce|7|40 StructuralLoadOrResult|6",
    "StructuralLoadPlanarForce|7|40 structuralloadresource|2 StructuralLoadSingleDisplacement|7|40",
    "StructuralLoadSingleDisplacementDistortion|7|40 StructuralLoadSingleForce|7|40",
    "StructuralLoadSingleForceWarping|7|40 StructuralLoadStatic|7|40 StructuralLoadTemperature|7|40",
    "StructuralMember|7|38 StructuralPlanarAction|7|38 structuralplanaractionvarying|1|38 StructuralPointAction|7|38",
    "StructuralPointConnection|7|38 StructuralPointReaction|7|38 structuralprofileproperties|1|28",
    "StructuralReaction|7|38 StructuralResultGroup|7|38 structuralsteelprofileproperties|1|28",
    "StructuralSurfaceAction|6 structuralsurfaceactivitytypeenum|2 StructuralSurfaceConnection|7|38",
    "StructuralSurfaceMember|7|38 structuralsurfacemembertypeenum|2 StructuralSurfaceMemberVarying|7|38",
    "StructuralSurfaceReaction|6 structureddimensioncallout|1|23 styleassignmentselect|2 StyledItem|7|21",
    "StyledRepresentation|7|32 StyleModel|7|32 SubContractResource|7|5 SubContractResourceType|6",
    "subcontractresourcetypeenum|2 Subedge|7|42 Surface|7|14 SurfaceCurve|6 SurfaceCurveSweptAreaSolid|7|13",
    "SurfaceFeature|6 surfacefeaturetypeenum|2 SurfaceOfLinearExtrusion|7|14 SurfaceOfRevolution|7|14",
    "surfaceorfacesurface|2 SurfaceReinforcementArea|6 surfaceside|2 SurfaceStyle|7|21 surfacestyleelementselect|2",
    "SurfaceStyleLighting|7|21 SurfaceStyleRefraction|7|21 SurfaceStyleRendering|7|21 SurfaceStyleShading|7|21",
    "SurfaceStyleWithTextures|7|21 SurfaceTexture|7|21 surfaceweightspositive|2 SweptAreaSolid|7|13",
    "SweptDiskSolid|7|13 SweptDiskSolidPolygonal|6 SweptSurface|7|14 SwitchingDevice|6 SwitchingDeviceType|7|9",
    "switchingdevicetypeenum|2 symbolstyle|1|21 System|7|27 SystemFurnitureElement|6 SystemFurnitureElementType|7|36",
    "systemfurnitureelementtypeenum|2 Table|7|43 TableColumn|6 TableRow|7|43 Tank|6 TankType|7|15 tanktypeenum|2",
    "taperedsweptareaprofiles|2 Task|7|26 taskdurationenum|2 TaskTime|6 TaskTimeRecurring|6 TaskType|6 tasktypeenum|2",
    "TelecomAddress|7|0 temperaturegradientmeasure|2 temperaturerateofchangemeasure|2 Tendon|7|39 TendonAnchor|7|39",
    "TendonAnchorType|6 tendonanchortypeenum|2 TendonConduit|4 TendonConduitType|4 TendonType|6 tendontypeenum|2",
    "terminatorsymbol|1|23 TessellatedFaceSet|6 TessellatedItem|6 text|2 textalignment|2 textdecoration|2",
    "textfontname|2 textfontselect|2 TextLiteral|7|22 TextLiteralWithExtent|7|22 textpath|2 TextStyle|7|21",
    "TextStyleFontModel|7|25 TextStyleForDefinedFont|7|21 TextStyleTextModel|7|21",
    "textstylewithboxcharacteristics|1|21 texttransformation|2 TextureCoordinate|7|22 TextureCoordinateGenerator|7|22",
    "TextureCoordinateIndices|4 TextureCoordinateIndicesWithVoids|4 TextureMap|7|22 TextureVertex|7|22",
    "TextureVertexList|6 thermaladmittancemeasure|2 thermalconductivitymeasure|2 thermalexpansioncoefficientmeasure|2",
    "thermalmaterialproperties|1|17 thermalresistancemeasure|2 thermaltransmittancemeasure|2",
    "thermodynamictemperaturemeasure|2 ThirdOrderPolynomialSpiral|4 time|2 timemeasure|2 timeorratioselect|2",
    "TimePeriod|6 TimeSeries|7|41 timeseriesdatatypeenum|2 timeseriesreferencerelationship|1|41",
    "timeseriesschedule|1|6 TimeSeriesValue|7|41 timestamp|2 TopologicalRepresentationItem|7|42",
    "TopologyRepresentation|7|32 topologyrepresentationtypes|2 topologyresource|2 ToroidalSurface|6 torquemeasure|2",
    "TrackElement|4 TrackElementType|4 Transformer|6 TransformerType|7|9 transformertypeenum|2 transitioncode|2",
    "translationalstiffnessselect|2 TransportationDevice|4 TransportationDeviceType|4 TransportElement|7|27",
    "TransportElementType|7|27 transportelementtypeenum|2 TrapeziumProfileDef|7|29 TriangulatedFaceSet|6",
    "TriangulatedIrregularNetwork|4 TrimmedCurve|7|14 trimmingpreference|2 trimmingselect|2 TShapeProfileDef|7|29",
    "TubeBundle|6 TubeBundleType|7|15 tubebundletypeenum|2 twodirectionrepeatfactor|1|21 TypeObject|7|16",
    "TypeProcess|6 TypeProduct|7|16 TypeResource|6 uniquedefinitionnames|2 uniquepropertyname|2",
    "uniquepropertysetnames|2 uniquepropertytemplatenames|2 uniquequantitynames|2 unit|2 UnitaryControlElement|6",
    "UnitaryControlElementType|6 unitarycontrolelementtypeenum|2 UnitaryEquipment|6 UnitaryEquipmentType|7|15",
    "unitaryequipmenttypeenum|2 UnitAssignment|7|19 unitenum|2 urireference|2 UShapeProfileDef|7|29 utilityresource|2",
    "value|2 Valve|6 ValveType|7|15 valvetypeenum|2 vaporpermeabilitymeasure|2 Vector|7|14 vectordifference|2",
    "vectorordirection|2 vectorsum|2 Vehicle|4 VehicleType|4 Vertex|7|42 vertexbasedtexturemap|1|22 VertexLoop|7|42",
    "VertexPoint|7|42 VibrationDamper|4 VibrationDamperType|4 VibrationIsolator|6 VibrationIsolatorType|7|15",
    "vibrationisolatortypeenum|2 VirtualElement|7|27 VirtualGridIntersection|7|12 VoidingFeature|6",
    "voidingfeaturetypeenum|2 volumemeasure|2 volumetricflowratemeasure|2 Wall|7|33 wallelementedcase|2",
    "WallStandardCase|7|33 WallType|7|33 walltypeenum|2 warpingconstantmeasure|2 warpingmomentmeasure|2",
    "warpingstiffnessselect|2 WasteTerminal|6 WasteTerminalType|7|20 wasteterminaltypeenum|2 waterproperties|1|17",
    "WellKnownText|4 Window|7|33 WindowLiningProperties|7|33 windowpaneloperationenum|2 windowpanelpositionenum|2",
    "WindowPanelProperties|7|33 windowstandardcase|2 windowstyle|3|33 windowstyleconstructionenum|2",
    "windowstyleoperationenum|2 WindowType|6 windowtypeenum|2 windowtypepartitioningenum|2 WorkCalendar|6",
    "workcalendartypeenum|2 WorkControl|7|26 WorkPlan|7|26 workplantypeenum|2 WorkSchedule|7|26",
    "workscheduletypeenum|2 WorkTime|6 Zone|7|27 ZShapeProfileDef|7|29"
  ].join(" ");

  var MAP = null;                       // NÁZOVVEĽKÝMI → {name, f, d}
  function index() {
    if (MAP) return MAP;
    MAP = new Map();
    RAW.split(" ").forEach(function (rec) {
      var p = rec.split("|");
      MAP.set(("IFC" + p[0]).toUpperCase(), { name: p[0], f: +p[1], d: p.length > 2 ? +p[2] : -1 });
    });
    return MAP;
  }

  // Verzie dokumentácie: kľúč, na ktorý sa mapuje schéma súboru, a tvar adresy.
  var TARGETS = {
    "2x3": {
      bit: 1, label: "IFC2x3 TC1",
      url: function (e, key) {
        return "https://standards.buildingsmart.org/IFC/RELEASE/IFC2x3/TC1/HTML/ifc" +
               DOMAINS[e.d] + "/lexical/" + key.toLowerCase() + ".htm";
      }
    },
    "4": {
      bit: 2, label: "IFC4 ADD2 TC1",
      url: function (e, key) {
        return "https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/link/" +
               key.toLowerCase() + ".htm";
      }
    },
    "4x3": {
      bit: 4, label: "IFC4.3",
      url: function (e) {
        return "https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/Ifc" +
               e.name + ".htm";
      }
    }
  };

  // Ktorá dokumentácia zodpovedá schéme zo súboru (FILE_SCHEMA).
  function targetFor(schema) {
    var s = String(schema || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (/^IFC4X3/.test(s)) return "4x3";
    if (/^IFC4/.test(s)) return "4";           // IFC4, IFC4X1, IFC4X2, IFC4ADD2…
    if (/^IFC2X3/.test(s)) return "2x3";
    return null;                                // IFC2x2 a staršie / neznáma schéma
  }

  /* Odkaz na dokumentáciu triedy pre danú schému súboru.
     Vracia {url, label, exact} alebo null, ak trieda nie je v žiadnej dokumentácii.
     exact=false znamená, že trieda v schéme súboru nie je a odkaz vedie do inej
     verzie dokumentácie — preto sa vždy zobrazuje aj label. */
  function docFor(type, schema) {
    var key = String(type || "").toUpperCase();
    if (!/^IFC/.test(key)) return null;
    var e = index().get(key);
    if (!e) return null;

    var want = targetFor(schema);
    var order = want ? [want] : [];
    ["4", "4x3", "2x3"].forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });

    for (var i = 0; i < order.length; i++) {
      var t = TARGETS[order[i]];
      if (!(e.f & t.bit)) continue;
      if (t.bit === 1 && e.d < 0) continue;
      return { url: t.url(e, key), label: t.label, exact: order[i] === want };
    }
    return null;
  }

  // Názov triedy v správnom tvare (IFCWALLSTANDARDCASE → IfcWallStandardCase).
  function nameOf(type) {
    var e = index().get(String(type || "").toUpperCase());
    return e ? "Ifc" + e.name : null;
  }

  root.IFCDocs = { docFor: docFor, targetFor: targetFor, nameOf: nameOf, size: function () { return index().size; } };
})(typeof self !== "undefined" ? self : this);
