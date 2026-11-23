import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getVerifiedUser } from "@/data/auth";
import { CommandPalette } from "@/components/sdf/CommandPalette";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const user = await getVerifiedUser();
    if (!user) throw redirect({ to: "/auth" });
  },
  component: () => <><CommandPalette /><Outlet /></>,
});
