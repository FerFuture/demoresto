import { createContext, useContext } from "react";

/** `demoSlug` viene de la ruta `/d/:demoSlug/...`; null = modo legado (un solo tenant). */
export const DemoTenantContext = createContext({ demoSlug: null });

export function useDemoTenant() {
  return useContext(DemoTenantContext);
}
