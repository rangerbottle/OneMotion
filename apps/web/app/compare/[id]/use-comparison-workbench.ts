"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ComparisonController } from "./comparison-controller";

export function useComparisonWorkbench(comparisonId: string) {
  const controller = useMemo(() => new ComparisonController(comparisonId), [comparisonId]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => {
    controller.start();
    return controller.stop;
  }, [controller]);
  return { ...snapshot, controller };
}
