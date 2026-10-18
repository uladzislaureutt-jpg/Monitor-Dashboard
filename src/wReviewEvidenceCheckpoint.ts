// Durably save EACH accepted Evidence batch (or a deliberate full-pool reset).
// No AI call may depend on a later all-or-nothing checkpoint. Does not mutate source workspaces.
export type WorkspaceSnapshot<T>={activeSlot:number;slots:T[]};
export function writeEvidenceCheckpoint<T, S extends WorkspaceSnapshot<T>>(
  storageKey:string,
  store:S,
  slotIndex:number,
  newState:T,
  storage:Pick<Storage,"setItem">
):S{
  if(store.activeSlot!==slotIndex||slotIndex<0||slotIndex>=store.slots.length)
    throw new Error("w_review_workspace_changed_during_analysis");
  const saved={
    ...store,
    slots:store.slots.map((state,index)=>index===slotIndex?newState:state)
  } as S;
  // Synchronous durable commit. If quota/storage fails, throw BEFORE
  // starting another AI batch. Previous saved snapshot remains intact.
  storage.setItem(storageKey,JSON.stringify(saved));
  return saved;
}
