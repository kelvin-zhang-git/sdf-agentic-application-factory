import { queryOptions } from "@tanstack/react-query";
import { api } from "./http";
import type { AdminDashboardResponse } from "@/api/routes/admin-dashboard";

export type { AdminDashboardResponse };

export const adminDashboardQuery = (days = 14, includeSeed = true) =>
  queryOptions({
    queryKey: ["admin", "dashboard", days, includeSeed],
    queryFn: () =>
      api<AdminDashboardResponse>(
        `/admin/dashboard?days=${encodeURIComponent(String(days))}&include_seed=${includeSeed ? "1" : "0"}`,
      ),
    staleTime: 15_000,
  });
