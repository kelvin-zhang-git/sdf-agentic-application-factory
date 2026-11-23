import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SDF 智能应用工厂" },
      { name: "description", content: "智能体起草、人来确认的软件交付平台工作台。" },
      { property: "og:title", content: "SDF 智能应用工厂" },
      { property: "og:description", content: "智能体起草、人来确认的软件交付平台工作台。" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/apps" });
  },
});
