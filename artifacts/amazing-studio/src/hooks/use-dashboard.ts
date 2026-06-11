import { useQuery } from "@tanstack/react-query";
import { getDashboardStats, getGetDashboardStatsQueryKey } from "@workspace/api-client-react";

export function useDashboardStats() {
  return useQuery({
    queryKey: getGetDashboardStatsQueryKey(),
    queryFn: () => getDashboardStats(),
  });
}
