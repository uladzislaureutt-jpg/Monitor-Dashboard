// Durably save a fully verified Evidence batch/pool before a separate,
// failure-prone editorial dossier request. Does not mutate source workspaces.
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
  // making a further expensive AI map call. Previous snapshot is intact.
  storage.setItem(storageKey,JSON.stringify(saved));
  return saved;
}
