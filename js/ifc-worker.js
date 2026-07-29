/* ifc-worker.js — beží vo Web Workeri.
 * Načíta výpočtové jadro (self.IFCMerge) a obsluhuje správy z hlavného vlákna,
 * aby parsovanie a zlúčenie veľkých IFC súborov neblokovalo rozhranie.
 */
importScripts("ifc-merge.js");

(function(){
  var store = {};   // načítané modely podľa slotu: A = primárny, B = sekundárny

  // Z parsovaného modelu vyberie len údaje, ktoré potrebuje rozhranie.
  function summarize(model){
    return {
      schema: model.schema,
      lengthUnit: model.lengthUnit,
      entityCount: model.entities.size,
      maxId: model.maxId,
      containers: self.IFCMerge.spatialContainers(model),
      breakdown: self.IFCMerge.typeBreakdown(model),
      objects: self.IFCMerge.importableObjects(model)
    };
  }

  self.onmessage = function(ev){
    var msg = ev.data, id = msg.id;
    try{
      if(msg.type === 'parse'){
        var model = self.IFCMerge.parseIFC(msg.text);
        store[msg.slot] = model;
        self.postMessage({id:id, ok:true, summary:summarize(model)});
      } else if(msg.type === 'merge'){
        var A = store.A, B = store.B;
        if(!A || !B) throw new Error('Modely nie sú načítané.');
        var res = self.IFCMerge.mergeParsed(A, B, msg.options);
        var validation = self.IFCMerge.validate(res.ifc);
        self.postMessage({id:id, ok:true, ifc:res.ifc, report:res.report, validation:validation});
      }
    } catch(e){
      self.postMessage({id:id, ok:false, error: (e && e.message) ? e.message : String(e)});
    }
  };
})();
