// What people see for a store: the name of its project, else its shop domain.
export const storeNameOf = (store: { shop: string; project?: { name: string } | null }) => store.project?.name ?? store.shop
