// Shared W-Review Evidence provider circuit policy, no side effects.
export const W_EVIDENCE_CIRCUIT_MINUTES=15;
export const W_EVIDENCE_CIRCUIT_SCOPE="evidence_batch";
export function evidenceRouteKey(model:string):string {
  return W_EVIDENCE_CIRCUIT_SCOPE+":"+model;
}
export function suspendStructuralFailure(status:number,googleStatus:string):boolean {
  return status===400&&googleStatus==="INVALID_ARGUMENT";
}
export function routesWithoutCircuit<T extends string>(models:readonly T[],disabledRoutes:readonly string[]):T[]{
  const denied=new Set(disabledRoutes);
  return models.filter(model=>!denied.has(evidenceRouteKey(model)));
}
export function circuitExpiry(reference:Date):string{
  return new Date(reference.getTime()+W_EVIDENCE_CIRCUIT_MINUTES*60000).toISOString();
}
