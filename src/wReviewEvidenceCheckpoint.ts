// Durably save EACH accepted Evidence batch (or a deliberate full-pool reset).
// No AI call may depend on a later all-or-nothing checkpoint. Does not mutate source workspaces.
export type WorkspaceSnapshot<T>={activeSlot:number;slots:T[]};
export function writeEvidenceCheckpoint<T>(
  storageKey:string,
  store:WorkspaceSnapshot<T>,
  slotIndex:number,
  newState:T,
  storage:Pick<Storage,"setItem">
):WorkspaceSnapshot<T>{
  if(store.activeSlot!==slotIndex||slotIndex<0||slotIndex>=store.slots.length)
    throw new Error("w_review_workspace_changed_during_analysis");
  const saved:WorkspaceSnapshot<T>={
    ...store,
    slots:store.slots.map((state,index)=>index===slotIndex?newState:state)
  };
  // Synchronous durable commit. If quota/storage fails, throw BEFORE
  // starting another AI batch. Previous saved snapshot remains intact.
  storage.setItem(storageKey,JSON.stringify(saved));
  return saved;
}
